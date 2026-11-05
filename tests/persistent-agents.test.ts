import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/core/engine';
import { island } from '../src/universes/first-shore';
import type { Block, Entity } from '../src/core/types';
import { Store } from '../server/store';
import { AgentBridge } from '../server/simulation/agent-bridge';
import { AgentRuntime, type RuntimeSnapshot } from '../server/agents/runtime';
import { TurnClock } from '../server/turn-clock';
import type { Completion, CompletionRequest } from '../vendor/littlewhale';

const actor = (id: string, x: number, controller: Entity['controller'] = 'agent'): Entity => ({ id, name: id, kind: 'troglodyte', controller,
  position: [x, 1, .5], yaw: 0, height: 2, color: '#fff', inventory: null, status: 'idle' });
const until = async (predicate: () => boolean) => {
  for (let i = 0; i < 400 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(predicate(), 'Expected asynchronous agent state.');
};
function fixture(twoAgents = false, restored?: { state: ReturnType<Engine['state']>; runtime: RuntimeSnapshot }) {
  const blocks: Block[] = [];
  for (let x = -8; x <= 8; x++) for (let z = -8; z <= 16; z++) blocks.push([x, 0, z, 'stone']);
  const engine = new Engine({ ...island, generate: () => ({ blocks, entities: [actor('walker', .5), actor('speaker', 4.5, twoAgents ? 'agent' : 'static')] }) }, restored?.state);
  const store = new Store(':memory:', engine.module.manifest);
  let runtime: AgentRuntime;
  let clock: TurnClock;
  const bridge = new AgentBridge(engine, restored?.runtime.simulation, () => store.record(engine.frame(), undefined, runtime.persistence()));
  const errors: unknown[] = [];
  runtime = new AgentRuntime(bridge, store, [{ id: 'mock', type: 'openai-compatible', name: 'Mock', baseUrl: 'http://unused.invalid', model: 'mock', apiKey: '' }], restored?.runtime, { changed() { clock?.barrierChanged(); }, fatal(error) { errors.push(error); } });
  const requests: { request: CompletionRequest; respond(name: string, args?: Record<string, unknown>): void; fail(): void }[] = [];
  runtime.inference.complete = (request, signal) => new Promise<Completion>((resolve, reject) => {
    const abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
    requests.push({ request: structuredClone(request), respond(name, args = {}) { signal.removeEventListener('abort', abort); resolve({ content: null, calls: [{ id: 'provider-reuses-id', name, arguments: args }], provider: 'mock', model: 'mock', latencyMs: 1 }); },
      fail() { signal.removeEventListener('abort', abort); reject(new Error('Disconnected')); } });
  });
  store.record(engine.frame(), engine.state(), runtime.persistence());
  let wall = 0;
  clock = new TurnClock(engine, runtime, { frame() { store.record(engine.frame(), undefined, runtime.persistence()); }, status() {}, fatal(error) { errors.push(error); } }, () => wall);
  const pump = (ms = 50) => { wall += ms; clock.pump(); };
  return { engine, store, bridge, runtime, requests, clock, errors, pump,
    async close() { clock.close(); await new Promise(resolve => setTimeout(resolve, 1)); store.close(); } };
}
const resultOf = (request: CompletionRequest) => JSON.parse(request.messages.filter(message => message.role === 'tool').at(-1)!.content!);

test('silent walking holds one tool without inference across world seconds and resumes the same conversation', async () => {
  const f = fixture();
  try {
    f.clock.setEnabled(true); await until(() => f.requests.length === 1);
    const first = f.requests[0].request;
    f.pump(60000); assert.equal(f.engine.tick, 0);
    f.requests[0].respond('walk_to', { x: .5, z: 8.5 }); await until(() => f.runtime.ready());
    f.pump();
    for (let i = 0; i < 40; i++) f.pump();
    assert.ok(f.engine.tick > 20 && f.engine.tick < 80);
    assert.equal(f.requests.length, 1);
    for (let i = 0; i < 100 && f.engine.tick < 80; i++) f.pump();
    await until(() => f.requests.length === 2);
    assert.equal(f.engine.tick, 80);
    assert.equal(f.requests[1].request.system, first.system);
    assert.deepEqual(f.requests[1].request.messages[0], first.messages[0]);
    assert.equal(f.requests[1].request.messages.filter(message => message.role === 'user').length, 1);
    const result = resultOf(f.requests[1].request);
    assert.equal(result.action.status, 'completed'); assert.equal(result.action.distanceTravelled.toFixed(1), '8.0');
    f.pump(60000); assert.equal(f.engine.tick, 80); assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('speech returns progress, freezes inference, and the agent replies while the same movement continues', async () => {
  const f = fixture();
  try {
    f.clock.setEnabled(true); await until(() => f.requests.length === 1);
    f.requests[0].respond('walk_to', { x: .5, z: 8.5 }); await until(() => f.runtime.ready());
    for (let i = 0; i < 100 && f.engine.tick < 30; i++) f.pump();
    const tick = f.engine.tick, destination = structuredClone(f.engine.entity('walker').motion!.destination);
    const spoken = f.engine.act('speaker', { action: 'say', word: 'Hello walker' }, 'manual'); f.pump(60000);
    assert.equal(spoken.ok, true, spoken.message);
    await until(() => f.requests.length === 2);
    assert.equal(f.engine.tick, tick);
    const heard = resultOf(f.requests[1].request);
    assert.equal(heard.reason, 'event'); assert.equal(heard.action.status, 'running');
    assert.equal(heard.events.find((event: any) => event.type === 'speech').data.word, 'Hello walker');
    assert.ok(heard.action.distanceTravelled > 0 && heard.action.remainingDistance > 0);
    f.requests[1].respond('say', { word: 'I hear you' }); await until(() => f.runtime.ready());
    f.pump(); assert.deepEqual(f.engine.entity('walker').motion!.destination, destination);
    assert.equal(f.engine.entity('walker').speech!.word, 'I hear you');
    assert.ok(f.engine.tick < 80);
    for (let i = 0; i < 100 && f.requests.length < 3; i++) { f.pump(); await Promise.resolve(); }
    await until(() => f.requests.length === 3);
    f.requests[2].respond('wait_for_event', { actionId: heard.action.id }); await until(() => f.runtime.ready());
    for (let i = 0; i < 150 && f.engine.tick < 80; i++) f.pump();
    await until(() => f.requests.length === 4);
    assert.equal(resultOf(f.requests[3].request).action.id, heard.action.id);
    assert.equal(resultOf(f.requests[3].request).action.status, 'completed');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('ready actions survive an unavailable peer, pause, and restart without duplicate commits', async () => {
  const f = fixture(true);
  let resumed: ReturnType<typeof fixture> | undefined;
  try {
    f.clock.setEnabled(true); await until(() => f.requests.length === 2);
    const walker = f.requests.find(request => request.request.sessionId === 'walker')!;
    walker.respond('walk_to', { x: .5, z: 8.5 }); await until(() => f.runtime.agents.get('walker')!.state === 'tool');
    f.pump(60000); assert.equal(f.engine.tick, 0); assert.equal(f.engine.entity('walker').motion, undefined);
    f.clock.setEnabled(false); await until(() => [...f.runtime.agents.values()].every(agent => !agent.job));
    const snapshot = f.runtime.persistence();
    resumed = fixture(true, { state: f.engine.state(), runtime: snapshot });
    resumed.clock.setEnabled(true); await until(() => resumed!.requests.length === 1);
    assert.equal(resumed.requests[0].request.sessionId, 'speaker');
    resumed.requests[0].respond('wait_for_event', { seconds: 20 }); await until(() => resumed!.runtime.ready());
    for (let i = 0; i < 5; i++) resumed.pump();
    assert.ok(resumed.engine.tick > 0); assert.ok(resumed.engine.entity('walker').motion);
    assert.equal(resumed.engine.recentEvents.filter(event => event.actor === 'walker' && event.type === 'action').length, 1);
    assert.deepEqual(resumed.errors, []);
  } finally { await resumed?.close(); await f.close(); }
});

test('local ports expose no observer state or other private conversations and reject malformed actions', async () => {
  const f = fixture(true);
  try {
    f.clock.setEnabled(true); await until(() => f.requests.length === 2);
    const walker = f.requests.find(request => request.request.sessionId === 'walker')!;
    const observation = JSON.parse(walker.request.messages[0].content!).observation;
    assert.equal(observation.entities[0]?.intent, undefined);
    assert.equal(observation.entities[0]?.inventory, undefined);
    walker.respond('walk_to', { x: 'bad', z: 8.5 });
    await until(() => f.requests.length === 3);
    assert.match(resultOf(f.requests[2].request).error, /number/);
    assert.equal(f.engine.tick, 0); assert.equal(f.engine.entity('walker').motion, undefined);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('state-dependent tools refresh after taking raw wood into the hands', async () => {
  const f = fixture();
  try {
    f.engine.entity('walker').inventory = { stacks: [{ kind: 'wood', count: 2 }], selected: null, capacity: 640 };
    f.engine.entity('walker').intent = { goal: 'Experiment with wood.', successCondition: 'Discover one shape.', status: 'active' };
    f.clock.setEnabled(true); await until(() => f.requests.length === 1);
    const firstNames = f.requests[0].request.tools.map(tool => tool.name);
    assert.ok(firstNames.includes('hold'));
    assert.equal(firstNames.includes('strike_held'), false);
    assert.equal(firstNames.includes('interact'), false);
    f.requests[0].respond('hold', { stack: 0 }); await until(() => f.runtime.ready());
    for (let i = 0; i < 80 && f.requests.length < 2; i++) { f.pump(); await Promise.resolve(); }
    await until(() => f.requests.length === 2);
    const discovery = resultOf(f.requests[1].request);
    assert.equal(discovery.current.bodyActivity.id, discovery.action.id);
    assert.equal(f.requests[1].request.tools.some(tool => tool.name === 'strike_held'), false);
    assert.ok(discovery.current.learned.some((fact: string) => fact.includes('front_corner')));
    f.requests[1].respond('wait_for_event', { actionId: discovery.action.id, eventTypes: [] });
    await until(() => f.runtime.ready());
    for (let i = 0; i < 80 && f.requests.length < 3; i++) { f.pump(); await Promise.resolve(); }
    await until(() => f.requests.length === 3);
    const secondNames = f.requests[2].request.tools.map(tool => tool.name);
    assert.ok(secondNames.includes('strike_held'));
    assert.equal(secondNames.includes('run'), false);
    const strike = f.requests[2].request.tools.find(tool => tool.name === 'strike_held')!;
    assert.deepEqual((strike.parameters.properties as {point:{enum:string[]}}).point.enum,
      ['top_center', 'bottom_center', 'front_center', 'side_center', 'front_corner', 'front_edge']);
    assert.equal(strike.description.includes('plank'), false, 'Undiscovered products stay out of the affordance description.');
    const result = resultOf(f.requests[2].request);
    assert.equal(result.current.self.inventory.selected, 0);
    assert.deepEqual(result.current.self.intent, f.engine.entity('walker').intent);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('restart rebinds a committed body operation even when its tool is temporarily unavailable', async () => {
  const f = fixture();
  let resumed: ReturnType<typeof fixture> | undefined;
  try {
    f.engine.entity('walker').inventory = { stacks: [{ kind: 'wood', count: 2 }], selected: null, capacity: 640 };
    f.clock.setEnabled(true); await until(() => f.requests.length === 1);
    f.requests[0].respond('hold', { stack: 0 }); await until(() => f.runtime.ready());
    f.pump(0);
    const runtime = f.runtime.persistence(), state = f.engine.state();
    assert.equal(runtime.agents.walker.session.pendingCalls[0].result, undefined);
    assert.equal(f.bridge.ports()[0].bodyActivity()?.kind, 'hold');
    await f.close();
    resumed = fixture(false, { state, runtime });
    resumed.clock.setEnabled(true); await until(() => resumed!.requests.length === 1);
    const result = resultOf(resumed.requests[0].request);
    assert.equal(result.error, undefined);
    assert.equal(result.action.kind, 'hold');
    assert.equal(result.current.self.inventory.selected, 0);
    assert.equal(resumed.bridge.snapshot().entities.walker.actions.filter(action => action.kind === 'hold').length, 1);
    assert.deepEqual(resumed.errors, []);
  } finally { if (resumed) await resumed.close(); else await f.close(); }
});

test('a frozen commit updates its checkpoint atomically with the resumable action receipt', async () => {
  const f = fixture();
  let resumed: ReturnType<typeof fixture> | undefined;
  try {
    f.clock.setEnabled(true); await until(() => f.requests.length === 1);
    f.requests[0].respond('walk_to', { x: .5, z: 8.5 }); await until(() => f.runtime.ready());
    f.pump(0); assert.equal(f.engine.tick, 0); assert.ok(f.engine.entity('walker').motion);
    f.clock.setEnabled(false); await until(() => [...f.runtime.agents.values()].every(agent => !agent.job));
    const recorded = f.store.stateAt(f.store.latestTick());
    const saved = f.store.loadAgentState<RuntimeSnapshot>()!;
    assert.deepEqual(recorded.entities[0].motion, f.engine.entities[0].motion);
    resumed = fixture(false, { state: recorded, runtime: saved });
    resumed.clock.setEnabled(true); await until(() => resumed!.runtime.ready());
    assert.equal(resumed.requests.length, 0);
    for (let i = 0; i < 5; i++) resumed.pump();
    assert.ok(resumed.engine.entity('walker').position[2] > .5);
    assert.equal(resumed.engine.recentEvents.filter(event => event.actor === 'walker' && event.type === 'action').length, 0);
    assert.deepEqual(resumed.errors, []);
  } finally { await resumed?.close(); await f.close(); }
});
