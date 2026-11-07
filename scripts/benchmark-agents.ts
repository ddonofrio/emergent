import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine } from '../src/core/engine';
import type { Block, Entity } from '../src/core/types';
import { island } from '../src/universes/first-shore';
import { AgentRuntime } from '../server/agents/runtime';
import { AgentBridge } from '../server/simulation/agent-bridge';
import { Store } from '../server/store';
import type { CompletionRequest, ToolCall } from '../vendor/littlewhale';

// Transport-independent comparison. This deliberately runs no application server
// and uses no configured provider or credential. Physics runs without wall pacing.
const MOCK_LATENCY_MS = 5;
const creature = (id: string, x: number, z: number, controller: Entity['controller'] = 'agent'): Entity => ({
  id, name: id, kind: 'troglodyte', controller, position: [x, 1, z], height: 2, yaw: 0,
  inventory: null, color: '#fff', status: 'idle',
});
interface RequestMeasurement { phase: string; worldTick: number; inputBytes: number; estimatedInputTokens: number; latencyMs: number; }
async function until(predicate: () => boolean, message: string) {
  const deadline = performance.now() + 10000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(message);
    await delay(1);
  }
}
async function scenario(interrupted: boolean) {
  const floor: Block[] = [];
  for (let x = -8; x <= 8; x++) for (let z = -8; z <= 16; z++) floor.push([x, 0, z, 'stone']);
  const universe = { ...island, generate: () => ({ blocks: floor, entities: [creature('walker', .5, .5), creature('speaker', 3.5, 4.5, 'static')] }) };
  // The speaker is in the initial observation, not a newly encountered creature.
  // This isolates the same silent-walk/speech workload measured before refactoring.
  const initial = new Engine(universe).state();
  initial.contacts.walker = ['speaker'];
  const engine = new Engine(universe, initial);
  const store = new Store(':memory:', engine.module.manifest);
  let runtime: AgentRuntime;
  const persist = () => {
    store.record(engine.frame(), engine.tick === 0 ? engine.state() : undefined, runtime?.checkpoint());
    runtime?.acceptCheckpoint();
  };
  const bridge = new AgentBridge(engine, undefined, persist);
  const errors: unknown[] = [];
  runtime = new AgentRuntime(bridge, store, [{ id: 'mock', type: 'openai-compatible', name: 'Mock', baseUrl: 'http://unused.invalid', apiKey: 'test', model: 'mock' }], undefined, { changed() {}, fatal(error) { errors.push(error); } });
  const requests: RequestMeasurement[] = [];
  let movementActionId: string | undefined;
  let replyCommittedTick: number | undefined;
  let nextDecisionAfterArrival = false;
  let speechInjected = false;
  runtime.inference.complete = async (request: CompletionRequest, signal: AbortSignal) => {
    const started = performance.now(), json = JSON.stringify(request);
    let name: string, args: Record<string, unknown>;
    if (requests.length === 0) { name = 'walk_to'; args = { x: .5, z: 8.5 }; }
    else {
      const results = request.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content!));
      const movement = results.flatMap(result => [result.action, ...(result.actions ?? [])]).find(action => action?.kind === 'walk');
      movementActionId ??= movement?.id;
      const heard = results.some(result => result.events?.some((event: { type: string }) => event.type === 'speech'));
      if (engine.tick >= 80) { nextDecisionAfterArrival = true; name = 'say'; args = { word: 'I hear you' }; }
      else if (interrupted && heard && requests.length === 1) { name = 'say'; args = { word: 'I hear you' }; }
      else { name = 'wait_for_event'; args = movementActionId ? { actionId: movementActionId } : {}; }
    }
    const measurement: RequestMeasurement = { phase: name, worldTick: engine.tick, inputBytes: Buffer.byteLength(json), estimatedInputTokens: Math.ceil(json.length / 4), latencyMs: 0 };
    requests.push(measurement);
    await delay(MOCK_LATENCY_MS, undefined, { signal });
    measurement.latencyMs = Number((performance.now() - started).toFixed(3));
    const call: ToolCall = { id: `mock-${requests.length}`, name, arguments: args };
    return { provider: 'mock', model: 'mock', content: null, calls: [call], latencyMs: measurement.latencyMs, finishReason: 'toolUse' as const };
  };
  persist();
  const started = performance.now();
  runtime.resume();
  try {
    await until(() => runtime.ready() || errors.length > 0, 'Initial tool did not reach the world barrier.');
    if (errors.length) throw errors[0];
    runtime.commit();
    while (engine.tick < 80) {
      if (interrupted && !speechInjected && engine.tick === 40) {
        speechInjected = true;
        const result = engine.act('speaker', { action: 'say', word: 'Hello walker' }, 'manual');
        if (!result.ok) throw new Error(result.message);
        runtime.afterStep();
      }
      await until(() => runtime.ready() || errors.length > 0, 'Agent did not return to a simulation tool.');
      if (errors.length) throw errors[0];
      runtime.commit();
      if (!runtime.ready()) continue;
      if (engine.entity('walker').speech && replyCommittedTick === undefined) replyCommittedTick = engine.tick;
      engine.step(); runtime.afterStep();
      if (engine.tick % 2 === 0) persist();
    }
    await until(() => nextDecisionAfterArrival && runtime.ready() || errors.length > 0, 'Arrival did not return to the persistent conversation.');
    if (errors.length) throw errors[0];
    const result = {
      scenario: interrupted ? 'walk-hear-reply-while-walking' : 'uninterrupted-walk-next-decision',
      worldTicks: engine.tick, ...(interrupted ? { interruptionAt: 40, replyCommittedTick } : {}),
      inferenceCalls: requests.length,
      inputBytes: requests.reduce((sum, request) => sum + request.inputBytes, 0),
      estimatedInputTokens: requests.reduce((sum, request) => sum + request.estimatedInputTokens, 0),
      providerLatencyMs: Number(requests.reduce((sum, request) => sum + request.latencyMs, 0).toFixed(3)),
      executionLatencyMs: Number((performance.now() - started).toFixed(3)),
      measuredInputTokens: null, requests,
    };
    return result;
  } finally {
    runtime.close();
    await until(() => [...runtime.agents.values()].every(agent => !agent.job), 'Agent cancellation did not settle.');
    store.close();
  }
}

const baseline = JSON.parse(readFileSync(new URL('../tests/agent-refactor-baseline.json', import.meta.url), 'utf8'));
const results = {
  architecture: 'persistent-tool-conversations',
  measurement: `Deterministic stub provider with ${MOCK_LATENCY_MS}ms artificial delay. No real LLM inference or tokenizer. Input tokens are ceil(JSON chars/4), including tool schemas; UTF-8 canonical request bytes are exact. Execution is unpaced headless physics. Each scenario includes the first next request after arrival. Initial visible speaker is marked already encountered to isolate speech.`,
  baseline,
  scenarios: [await scenario(false), await scenario(true)],
};
writeFileSync(new URL('../tests/agent-refactor-results.json', import.meta.url), JSON.stringify(results, null, 2) + '\n');
process.stdout.write(JSON.stringify(results, null, 2) + '\n');
