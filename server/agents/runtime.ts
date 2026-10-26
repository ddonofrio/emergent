import { setTimeout as delay } from 'node:timers/promises';
import type { Engine } from '../../src/core/engine';
import { clone, distance, type Action, type Observation } from '../../src/core/types';
import { TURN_TICKS, type DecisionStatus } from '../../src/core/time';
import type { Store } from '../store';
import { ProviderChain, type ProviderConfig, type ToolCall } from './providers';
import { worldTools, type Memory } from './tools';

interface Message { role: 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string; }
interface Mind extends Memory { turns: number; modelTurns: number; cycles: Message[][]; lastResult?: unknown; }
export interface PreparedDecision {
  id: string;
  observation: Observation;
  mind: Mind;
  content: string | null;
  calls: ToolCall[];
  latencyMs: number;
  attempts: number;
  provider: string;
  model: string;
  usage?: unknown;
}
export interface PreparedTurn { tick: number; decisions: PreparedDecision[]; }
type Report = (id: string, status: DecisionStatus) => void;

export class AgentRuntime {
  readonly mode: 'llm' | 'demo';
  readonly minds = new Map<string, Mind>();
  readonly inference: ProviderChain;
  constructor(readonly engine: Engine, readonly store: Store, readonly config: {
    providers: ProviderConfig[]; maxTurns: number | null; retryDelayMs?: number;
  }) {
    this.inference = new ProviderChain(config.providers);
    this.mode = this.inference.enabled ? 'llm' : 'demo';
    for (const entity of engine.entities.filter(e => e.controller === 'agent')) {
      const saved = store.loadMind<Mind>(entity.id);
      this.minds.set(entity.id, saved ? { ...saved, modelTurns: saved.modelTurns ?? 0 } : { notes: [], turns: 0, modelTurns: 0, cycles: [] });
      if (!engine.active(entity)) entity.status = 'disabled';
      else if (!entity.motion) entity.status = 'idle';
    }
  }
  persistence(): [string, unknown][] { return [...this.minds]; }
  async prepareTurn(signal: AbortSignal, report: Report): Promise<PreparedTurn> {
    signal.throwIfAborted();
    const tick = this.engine.tick;
    // Capture every observation before starting requests. Responses cannot change the world.
    const inputs = [...this.minds].sort(([a], [b]) => a.localeCompare(b)).flatMap(([id, mind]) => {
      const entity = this.engine.entity(id);
      if (!this.engine.active(entity)) { report(id, { state: 'disabled' }); return []; }
      if (entity.motion) { report(id, { state: 'moving' }); return []; }
      if (this.mode === 'llm' && this.config.maxTurns !== null && mind.modelTurns >= this.config.maxTurns) { report(id, { state: 'turn limit' }); return []; }
      return [{ id, mind: clone(mind), observation: this.engine.observe(id) }];
    });
    const decisions = await Promise.all(inputs.map(async ({ id, mind, observation }) => {
      const cached = this.store.loadPending<PreparedDecision>(tick, id, this.inference.cacheKey);
      if (cached) { report(id, { state: 'ready' }); return cached; }
      mind.turns++;
      const prepared = this.mode === 'demo'
        ? { id, mind, observation, content: null, calls: [{ id: 'demo-' + tick + '-' + id, type: 'function' as const, function: { name: 'act', arguments: JSON.stringify(demoAction(observation, mind.turns, id)) } }], latencyMs: 0, attempts: 0, provider: 'demo', model: 'demo' }
        : await this.request(id, mind, observation, signal, report);
      signal.throwIfAborted();
      // Ready decisions survive outages, pause/resume and process restarts.
      this.store.savePending(tick, id, this.inference.cacheKey, prepared);
      report(id, { state: 'ready', attempts: prepared.attempts });
      return prepared;
    }));
    signal.throwIfAborted();
    return { tick, decisions };
  }
  private async request(id: string, mind: Mind, observation: Observation, signal: AbortSignal, report: Report): Promise<PreparedDecision> {
    const started = Date.now(), tools = worldTools(this.engine, id, mind);
    const system = `${this.engine.module.manifest.agentInstructions}
Your name is ${observation.self.name}.
Words you can say: ${this.engine.module.manifest.vocabulary.join(', ')}.
Private memory: ${JSON.stringify(mind.notes)}
Last action result: ${JSON.stringify(mind.lastResult ?? null)}
Decide what to do now. Use at most one physical action and two supporting calls. Remember only what may matter later.`;
    const request = {
      messages: [{ role: 'system', content: system }, ...mind.cycles.flat(), { role: 'user', content: JSON.stringify(observation) }],
      tools: tools.map(({ name, description, parameters }) => ({ type: 'function', function: { name, description, parameters } })),
      max_tokens: 900,
    };
    let attempts = 0;
    while (true) {
      signal.throwIfAborted();
      attempts++;
      report(id, { state: attempts === 1 ? 'thinking' : 'waiting', attempts, message: 'Waiting for an inference provider; world time is held.' });
      try {
        const answer = await this.inference.complete(request, signal, (provider, index) => {
          report(id, { state: index ? 'waiting' : 'thinking', attempts, message: `${index ? 'Falling back to' : 'Trying'} ${provider.name}; world time is held.` });
        });
        signal.throwIfAborted();
        mind.modelTurns++;
        return { id, mind, observation, content: answer.content, calls: answer.calls, latencyMs: Date.now() - started, attempts, provider: answer.provider, model: answer.model, ...(answer.usage === undefined ? {} : { usage: answer.usage }) };
      } catch (error) {
        signal.throwIfAborted();
        report(id, { state: 'waiting', attempts, message: error instanceof Error ? error.message : 'Inference providers unavailable.' });
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
      if (!this.engine.active(this.engine.entity(id))) continue;
      const mind = clone(decision.mind), tools = worldTools(this.engine, id, mind);
      if (this.mode === 'llm') {
        this.engine.event(id, 'observation', 'Observed the shared turn boundary.', { provider: decision.provider, model: decision.model, observation, memory: mind.notes, turn: mind.turns });
        this.engine.event(id, 'decision', content?.slice(0, 500) || `Requested ${calls.length} tool calls.`, {
          provider: decision.provider, model: decision.model, latencyMs: decision.latencyMs, attempts: decision.attempts, usage: decision.usage ?? null, toolCalls: calls,
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
        if (call.function.name === 'act') mind.lastResult = result;
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
