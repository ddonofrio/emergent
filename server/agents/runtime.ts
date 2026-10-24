import { setTimeout as delay } from 'node:timers/promises';
import { detectTokenLoop, tokenizeLoopText } from '../../vendor/deepseek-harness/loop-detector';
import type { Engine } from '../../src/core/engine';
import { clone, distance, type Action, type Observation } from '../../src/core/types';
import { TURN_TICKS, type DecisionStatus } from '../../src/core/time';
import type { Store } from '../store';
import { worldTools, type Memory } from './tools';

interface Message { role: 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string; }
interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string }; }
interface Mind extends Memory { turns: number; modelTurns: number; cycles: Message[][]; lastResult?: unknown; }
export interface PreparedDecision {
  id: string;
  observation: Observation;
  mind: Mind;
  content: string | null;
  calls: ToolCall[];
  latencyMs: number;
  attempts: number;
  usage?: unknown;
}
export interface PreparedTurn { tick: number; decisions: PreparedDecision[]; }
type Report = (id: string, status: DecisionStatus) => void;

export class AgentRuntime {
  readonly mode: 'llm' | 'demo';
  readonly minds = new Map<string, Mind>();
  constructor(readonly engine: Engine, readonly store: Store, readonly config: {
    apiKey?: string; baseUrl: string; model: string; maxTurns: number; retryDelayMs?: number;
  }) {
    this.mode = config.apiKey ? 'llm' : 'demo';
    for (const entity of engine.entities.filter(e => e.controller === 'agent')) {
      const saved = store.loadMind<Mind>(entity.id);
      this.minds.set(entity.id, saved ? { ...saved, modelTurns: saved.modelTurns ?? 0 } : { notes: [], turns: 0, modelTurns: 0, cycles: [] });
      if (!entity.motion) entity.status = 'idle';
    }
  }
  persistence(): [string, unknown][] { return [...this.minds]; }
  canAdvance() {
    return !this.minds.size || [...this.minds].some(([id, mind]) =>
      this.engine.entity(id).motion || this.mode === 'demo' || mind.modelTurns < this.config.maxTurns);
  }
  async prepareTurn(signal: AbortSignal, report: Report): Promise<PreparedTurn> {
    signal.throwIfAborted();
    const tick = this.engine.tick;
    // Capture every observation before starting requests. Responses cannot change the world.
    const inputs = [...this.minds].sort(([a], [b]) => a.localeCompare(b)).flatMap(([id, mind]) => {
      if (this.engine.entity(id).motion) { report(id, { state: 'moving' }); return []; }
      if (this.mode === 'llm' && mind.modelTurns >= this.config.maxTurns) { report(id, { state: 'turn limit' }); return []; }
      return [{ id, mind: clone(mind), observation: this.engine.observe(id) }];
    });
    const decisions = await Promise.all(inputs.map(async ({ id, mind, observation }) => {
      const cached = this.store.loadPending<PreparedDecision>(tick, id, this.mode === 'llm' ? this.config.model : 'demo');
      if (cached) { report(id, { state: 'ready' }); return cached; }
      mind.turns++;
      const prepared = this.mode === 'demo'
        ? { id, mind, observation, content: null, calls: [{ id: 'demo-' + tick + '-' + id, type: 'function' as const, function: { name: 'act', arguments: JSON.stringify(demoAction(observation, mind.turns, id)) } }], latencyMs: 0, attempts: 0 }
        : await this.request(id, mind, observation, signal, report);
      signal.throwIfAborted();
      // Ready decisions survive outages, pause/resume and process restarts.
      this.store.savePending(tick, id, this.mode === 'llm' ? this.config.model : 'demo', prepared);
      report(id, { state: 'ready', attempts: prepared.attempts });
      return prepared;
    }));
    signal.throwIfAborted();
    return { tick, decisions };
  }
  private async request(id: string, mind: Mind, observation: Observation, signal: AbortSignal, report: Report): Promise<PreparedDecision> {
    const started = Date.now(), tools = worldTools(this.engine, id, mind);
    const system = `${this.engine.module.manifest.agentInstructions}
Your name is ${observation.self.name}. Vocabulary: ${this.engine.module.manifest.vocabulary.join(', ')}.
Private memory: ${JSON.stringify(mind.notes)}
Recent action result: ${JSON.stringify(mind.lastResult ?? null)}
All inhabitants decide from the same world instant. After all decisions arrive, exactly one world second passes. Network waiting is not world time. Long movements continue across turns at their normal speed.
Use up to three tools and at most one act. Short visible notes are allowed; no narrative substitutes for actions.`;
    const body = JSON.stringify({
      model: this.config.model,
      messages: [{ role: 'system', content: system }, ...mind.cycles.flat(), { role: 'user', content: JSON.stringify(observation) }],
      tools: tools.map(({ name, description, parameters }) => ({ type: 'function', function: { name, description, parameters } })),
      max_tokens: 900,
    });
    let attempts = 0;
    while (true) {
      signal.throwIfAborted();
      attempts++;
      report(id, { state: attempts === 1 ? 'thinking' : 'waiting', attempts, message: 'Waiting for the model; world time is held.' });
      try {
        // No deadline. A hung inference remains pending until the operator pauses or stops.
        const response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST', headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' }, signal, body,
        });
        if (!response.ok) { await response.body?.cancel(); throw new Error('Provider HTTP ' + response.status); }
        const payload = await response.json() as { choices?: { message: { content?: string; tool_calls?: ToolCall[] } }[]; usage?: unknown };
        signal.throwIfAborted();
        const answer = payload.choices?.[0]?.message;
        if (!answer) throw new Error('Waiting for a complete model response.');
        const content = typeof answer.content === 'string' ? answer.content.slice(0, 5000) : null;
        if (content && detectTokenLoop(tokenizeLoopText(content))) throw new Error('Waiting for non-repeating model output.');
        const calls = answer.tool_calls ?? [];
        if (!Array.isArray(calls) || calls.length > 16 || calls.some(c => typeof c.id !== 'string' || c.type !== 'function' || typeof c.function?.name !== 'string' || typeof c.function?.arguments !== 'string')) throw new Error('Waiting for valid model tool calls.');
        mind.modelTurns++;
        return { id, mind, observation, content, calls, latencyMs: Date.now() - started, attempts, ...(payload.usage === undefined ? {} : { usage: payload.usage }) };
      } catch (error) {
        signal.throwIfAborted();
        report(id, { state: 'waiting', attempts, message: error instanceof TypeError ? 'Provider connection unavailable; waiting to reconnect.' : error instanceof Error ? error.message : 'Provider unavailable.' });
        await delay(Math.min(10000, (this.config.retryDelayMs ?? 1000) * 2 ** Math.min(attempts - 1, 4)), undefined, { signal });
      }
    }
  }
  commit(turn: PreparedTurn) {
    if (this.engine.tick !== turn.tick + 1) throw new Error('Decisions must commit on the first step of their own turn.');
    // Rotate deterministic priority. Network response order never wins resource conflicts.
    const ids = [...this.minds.keys()].sort();
    const offset = Math.floor(turn.tick / TURN_TICKS) % Math.max(1, ids.length);
    const priority = [...ids.slice(offset), ...ids.slice(0, offset)];
    const decisions = [...turn.decisions].sort((a, b) => priority.indexOf(a.id) - priority.indexOf(b.id));
    this.engine.event('world', 'turn', 'One world-second turn started.', { turn: Math.floor(turn.tick / TURN_TICKS) + 1, observedTick: turn.tick, initiative: priority });
    for (const decision of decisions) {
      const { id, observation, content, calls } = decision;
      const mind = clone(decision.mind), tools = worldTools(this.engine, id, mind);
      if (this.mode === 'llm') {
        this.engine.event(id, 'observation', 'Observed the shared turn boundary.', { model: this.config.model, observation, memory: mind.notes, turn: mind.turns });
        this.engine.event(id, 'decision', content?.slice(0, 500) || `Requested ${calls.length} tool calls.`, {
          model: this.config.model, latencyMs: decision.latencyMs, attempts: decision.attempts, usage: decision.usage ?? null, toolCalls: calls,
        });
      }
      const cycle: Message[] = [{ role: 'user', content: JSON.stringify(observation) }, { role: 'assistant', content, ...(calls.length ? { tool_calls: calls } : {}) }];
      let acted = false;
      for (const [index, call] of calls.entries()) {
        let result: unknown;
        try {
          if (index >= 3 || (call.function.name === 'act' && acted)) result = { ok: false, message: 'Turn limit: three tool calls and one physical action.' };
          else {
            if (call.function.name === 'act') acted = true;
            const tool = tools.find(t => t.name === call.function.name);
            result = tool ? tool.invoke(JSON.parse(call.function.arguments)) : { ok: false, message: 'Unknown tool.' };
          }
        } catch { result = { ok: false, message: 'Invalid tool arguments.' }; }
        if (this.mode === 'llm') this.engine.event(id, 'tool-result', call.function.name, { callId: call.id, result });
        cycle.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        mind.lastResult = result;
      }
      if (this.mode === 'llm') {
        mind.cycles.push(cycle);
        while (mind.cycles.length > 4 || (JSON.stringify(mind.cycles).length > 24000 && mind.cycles.length > 1)) mind.cycles.shift();
      }
      this.minds.set(id, mind);
    }
  }
}

// Deliberately deterministic and labelled in the UI. This is a mechanical demo,
// not evidence of LLM behavior. It uses exactly the same local observations/tools.
function demoAction(o: Observation, turn: number, id: string): Action {
  const phase = (turn + (id === 't2' ? 4 : 0)) % 16;
  const eye = [o.self.position[0], o.self.position[1] + 1.5, o.self.position[2]] as [number,number,number];
  const nearby = o.blocks.filter(b => distance(eye, [b[0]+.5,b[1]+.5,b[2]+.5]) < 2.9);
  if (o.self.inventory?.kind === 'bucket') return { action: 'throw', force: 3 };
  if (o.self.inventory) return phase % 2 ? { action: 'throw', force: 7 } : { action: 'place', target: [Math.floor(o.self.position[0] + Math.sin(o.self.yaw * Math.PI / 180) * 2), Math.floor(o.self.position[1]), Math.floor(o.self.position[2] + Math.cos(o.self.yaw * Math.PI / 180) * 2)] };
  const wood = nearby.find(b => b[3] === 'wood');
  if (wood) return { action: 'hit', target: wood.slice(0,3) as [number,number,number], impact: [.5,.5,.5] };
  if (phase === 0 || phase === 8) return { action: 'say', word: phase ? 'look' : 'hey' };
  if (phase === 2 && o.items.length) return { action: 'pickup', itemId: o.items[0].id };
  if (phase === 6 && nearby.length) { const block = nearby.find(b => b[3] !== 'grass') ?? nearby[0]; return { action: 'remove', target: block.slice(0,3) as [number,number,number] }; }
  if (phase % 3 === 0) return { action: 'turn', angle: id === 't1' ? 57 : -73 };
  return { action: 'move', distance: 2.5 };
}
