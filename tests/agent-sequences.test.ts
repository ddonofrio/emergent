import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Engine } from '../src/core/engine';
import type { Block, Entity } from '../src/core/types';
import { island } from '../src/universes/first-shore';
import { AgentBridge } from '../server/simulation/agent-bridge';
import { AgentRuntime, type RuntimeSnapshot } from '../server/agents/runtime';
import { agentTools, type AgentToolMemory } from '../server/agents/tools';
import { Store } from '../server/store';
import { TurnClock } from '../server/turn-clock';
import type { Completion, CompletionRequest } from '../vendor/littlewhale';

const until = async (check: () => boolean) => {
  for (let i = 0; i < 300 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.ok(check(), 'Expected asynchronous state.');
};
function fixture(restored?: { state: ReturnType<Engine['state']>; runtime: RuntimeSnapshot }) {
  const blocks: Block[] = [];
  for (let x = -8; x <= 8; x++) for (let z = -8; z <= 16; z++) blocks.push([x, 0, z, 'stone']);
  const actor: Entity = { id: 'a', name: 'A', kind: 'troglodyte', controller: 'agent', position: [.5, 1, .5], yaw: 0,
    height: 2, color: '#fff', status: 'idle', inventory: { stacks: [{ kind: 'wood', count: 2 }], selected: 0, capacity: 640 } };
  const other: Entity = { ...actor, id: 'b', name: 'B', controller: 'static', position: [2.5, 1, 2.5], inventory: null };
  const engine = new Engine({ ...island, encounterMessage: undefined, generate: () => ({ blocks, entities: [actor, other] }) }, restored?.state);
  const store = new Store(':memory:', engine.module.manifest), errors: unknown[] = [];
  let runtime: AgentRuntime, clock: TurnClock;
  const record = () => { store.record(engine.frame(), engine.state(), runtime.checkpoint()); runtime.acceptCheckpoint(); };
  const bridge = new AgentBridge(engine, restored?.runtime.simulation, record);
  runtime = new AgentRuntime(bridge, store, [{ id: 'mock', type: 'openai-compatible', name: 'Mock', baseUrl: 'http://unused.invalid', model: 'mock', apiKey: '' }],
    restored?.runtime, { changed() { clock?.barrierChanged(); }, fatal(error) { errors.push(error); } });
  const requests: { request: CompletionRequest; respond(name: string, args?: Record<string, unknown>): void; batch(calls: { name: string; arguments: Record<string, unknown> }[]): void }[] = [];
  runtime.inference.complete = (request, signal) => new Promise<Completion>((resolve, reject) => {
    const abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
    const batch = (calls: { name: string; arguments: Record<string, unknown> }[]) => {
      signal.removeEventListener('abort', abort);
      resolve({ content: null, calls: calls.map((call, i) => ({ id: `mock-${i}`, ...call })), provider: 'mock', model: 'mock', latencyMs: 0 });
    };
    requests.push({ request: structuredClone(request), batch, respond(name, args = {}) { batch([{ name, arguments: args }]); } });
  });
  let wall = 0;
  clock = new TurnClock(engine, runtime, { frame: record, status() {}, fatal(error) { errors.push(error); } }, () => wall);
  record();
  const pump = () => { wall += 50; clock.pump(); };
  return { engine, bridge, store, runtime, clock, requests, errors, pump,
    async start() { clock.setEnabled(true); await until(() => requests.length > 0 || runtime.ready()); },
    async advance(check: () => boolean) {
      for (let i = 0; i < 300 && !check(); i++) { pump(); await new Promise(resolve => setTimeout(resolve, 1)); }
      assert.ok(check(), 'Expected simulation progress.');
      assert.deepEqual(errors, []);
    },
    async stop() { clock.setEnabled(false); await until(() => [...runtime.agents.values()].every(agent => !agent.job)); },
    async close() { clock.close(); await new Promise(resolve => setTimeout(resolve, 1)); store.close(); },
  };
}
const output = (request: CompletionRequest) => JSON.parse(request.messages.filter(message => message.role === 'tool').at(-1)!.content!);
const context = (request: CompletionRequest) => JSON.parse(request.messages.at(-1)!.content!.split('\n\n').at(-1)!);
const steps = [
  { tool: 'store', args: {} },
  { tool: 'walk_to', args: { x: .5, z: 4.5 } },
  { tool: 'hold', args: { stack: 0 } },
];

test('a sequence refreshes each step and completes three physical actions with one model decision', async () => {
  const f = fixture();
  try {
    await f.start();
    assert.equal(f.requests[0].request.tools.some(tool => tool.name === 'hold'), false);
    f.requests[0].respond('run_sequence', { steps, eventTypes: [] });
    await f.advance(() => f.requests.length === 2);
    const result = output(f.requests[1].request);
    assert.equal(result.status, 'completed');
    assert.equal(result.completedSteps, 3);
    assert.deepEqual(result.outcomes.map((item: any) => item.tool), ['store', 'walk_to', 'hold']);
    assert.equal(f.engine.tick, 80);
    assert.equal(f.engine.entity('a').inventory!.selected, 0);
    assert.equal(f.engine.entity('a').inventory!.stacks[0].count, 2);
    const current = context(f.requests[1].request);
    assert.equal('notes' in current.observation, false);
    assert.equal('learned' in current.observation, false);
    assert.equal('intent' in current.observation.self, false);
    assert.ok(current.record.learned.length);
    assert.equal(JSON.stringify(result).includes('capabilities'), false);
    assert.equal(JSON.stringify(result).includes('"current"'), false);
    assert.ok(result.outcomes.every((item: any) => item.result.action.status === 'completed'));
  } finally { await f.close(); }
});

test('initial action event filters persist across restart and deliver deferred speech on completion', async () => {
  const f = fixture(); let resumed: ReturnType<typeof fixture> | undefined;
  try {
    await f.start();
    f.requests[0].respond('walk_to', { x: .5, z: 4.5, eventTypes: [] });
    await f.advance(() => f.engine.tick === 10);
    assert.equal(f.engine.act('b', { action: 'say', word: 'Hello' }, 'manual').ok, true);
    await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(f.requests.length, 1);
    await f.stop();
    const saved = f.store.loadAgentState<RuntimeSnapshot>()!;
    assert.deepEqual(saved.simulation.entities.a.requests[0].eventTypes, []);
    resumed = fixture({ state: f.engine.state(), runtime: saved });
    await resumed.start();
    assert.equal(resumed.requests.length, 0);
    await resumed.advance(() => resumed!.requests.length === 1);
    const result = output(resumed.requests[0].request);
    assert.equal(result.action.status, 'completed');
    assert.equal(result.events.filter((event: any) => event.type === 'speech').length, 1);
    assert.equal(result.events.find((event: any) => event.type === 'speech').data.word, 'Hello');
  } finally { await resumed?.close(); await f.close(); }
});

test('an interrupted sequence resumes the same movement and then its remaining steps', async () => {
  const f = fixture();
  try {
    await f.start();
    f.requests[0].respond('run_sequence', { eventTypes: ['speech'], steps: [{ tool: 'walk_to', args: { x: .5, z: 4.5 } }, { tool: 'store', args: {} }] });
    await f.advance(() => f.engine.tick === 10);
    assert.equal(f.engine.act('b', { action: 'say', word: 'Hello' }, 'manual').ok, true);
    await until(() => f.requests.length === 2);
    const interruption = output(f.requests[1].request);
    assert.equal(interruption.status, 'interrupted');
    assert.equal(interruption.completedSteps, 0);
    assert.ok(f.engine.entity('a').motion);
    assert.ok(interruption.outcomes[0].result.events.some((event: any) => event.type === 'speech'));
    const actionId = interruption.actionId;
    f.requests[1].respond('run_sequence', { sequenceId: interruption.sequenceId, eventTypes: [] });
    await f.advance(() => f.requests.length === 3);
    const result = output(f.requests[2].request);
    assert.equal(result.status, 'completed');
    assert.equal(result.outcomes[0].result.action.id, actionId);
    assert.equal(f.engine.recentEvents.filter(event => event.type === 'simulation-action' && (event.data as any).action.kind === 'walk').length, 1);
    assert.equal(f.engine.tick, 60);
  } finally { await f.close(); }
});

test('saved parameterized procedures and in-flight progress survive restart without repeating completed steps', async () => {
  const f = fixture(); let resumed: ReturnType<typeof fixture> | undefined;
  try {
    await f.start();
    f.requests[0].respond('save_sequence', { name: 'carry', description: 'Free hands, walk to a chosen point, then hold the wood again.', parameters: ['x', 'z'],
      steps: [steps[0], { tool: 'walk_to', args: { x: { $param: 'x' }, z: { $param: 'z' } } }, steps[2]] });
    await until(() => f.requests.length === 2);
    assert.equal(f.engine.tick, 0);
    f.requests[1].respond('run_sequence', { name: 'carry', bindings: { x: .5, z: 4.5 }, eventTypes: [] });
    await f.advance(() => f.engine.tick === 30);
    assert.equal(f.runtime.agents.get('a')!.sequence!.index, 1);
    await f.stop();
    const saved = f.store.loadAgentState<RuntimeSnapshot>()!;
    assert.equal(saved.agents.a.routines![0].name, 'carry');
    resumed = fixture({ state: f.engine.state(), runtime: saved });
    await resumed.start();
    assert.equal(resumed.requests.length, 0);
    await resumed.advance(() => resumed!.requests.length === 1);
    const result = output(resumed.requests[0].request);
    assert.equal(result.status, 'completed');
    assert.equal(resumed.engine.tick, 80);
    assert.deepEqual(result.outcomes.map((item: any) => item.tool), ['store', 'walk_to', 'hold']);
    assert.equal(new Set(result.outcomes.map((item: any) => item.result.action.id)).size, 3);
    assert.equal(context(resumed.requests[0].request).routines[0].name, 'carry');
    resumed.requests[0].respond('read_sequence', { name: 'carry' });
    await until(() => resumed!.requests.length === 2);
    assert.deepEqual(output(resumed.requests[1].request).steps[1].args.x, { $param: 'x' });
  } finally { await resumed?.close(); await f.close(); }
});

test('a committed completion receipt survives pause before the sequence consumes it', async () => {
  const f = fixture(); let resumed: ReturnType<typeof fixture> | undefined;
  try {
    await f.start(); f.requests[0].respond('run_sequence', { steps, eventTypes: [] });
    await f.advance(() => f.engine.tick === 19);
    f.pump();
    assert.equal(f.engine.tick, 20);
    assert.equal(f.runtime.agents.get('a')!.sequence!.index, 0);
    await f.stop();
    const saved = f.store.loadAgentState<RuntimeSnapshot>()!;
    assert.equal(saved.agents.a.sequence!.index, 0);
    assert.ok(Object.keys(saved.simulation.entities.a.receipts).some(id => id.includes(':step:0')));
    resumed = fixture({ state: f.engine.state(), runtime: saved });
    await resumed.start();
    await resumed.advance(() => resumed!.requests.length === 1);
    assert.equal(output(resumed.requests[0].request).status, 'completed');
    assert.equal(resumed.engine.tick, 80);
  } finally { await resumed?.close(); await f.close(); }
});

test('an unavailable dependent step stops the sequence without attempting later steps', async () => {
  const f = fixture();
  try {
    await f.start(); f.requests[0].respond('run_sequence', { eventTypes: [], steps: [steps[0], { tool: 'pickup', args: { itemId: 'unseen-item' } }, steps[1]] });
    await f.advance(() => f.requests.length === 2);
    const result = output(f.requests[1].request);
    assert.equal(result.status, 'failed');
    assert.equal(result.completedSteps, 1);
    assert.match(result.error, /not currently available/);
    assert.equal(f.engine.tick, 20);
    assert.equal(f.engine.entity('a').inventory!.selected, null);
    assert.equal(f.engine.entity('a').motion, undefined);
  } finally { await f.close(); }
});

test('a physical blockage stops the sequence and preserves the failure receipt', async () => {
  const f = fixture();
  try {
    f.engine.voxels.set([0, 1, 2], 'stone'); f.engine.voxels.set([0, 2, 2], 'stone');
    await f.start(); f.requests[0].respond('run_sequence', { eventTypes: [], steps: [steps[1], steps[0]] });
    await f.advance(() => f.requests.length === 2);
    const result = output(f.requests[1].request);
    assert.equal(result.status, 'failed');
    assert.equal(result.outcomes[0].result.action.result.ok, false);
    assert.equal(result.completedSteps, 0);
    assert.equal(f.engine.entity('a').inventory!.selected, 0);
  } finally { await f.close(); }
});

test('procedures reject nesting, unknown parameters and excessive storage, and stay private', async () => {
  const f = fixture();
  try {
    const port = f.bridge.ports()[0], memory: AgentToolMemory = { notes: [] }, signal = new AbortController().signal;
    const call = async (name: string, args: Record<string, unknown>, target = memory) =>
      await agentTools(port, target).executors[name](args, { id: name, name, arguments: args }, signal) as any;
    assert.match((await call('save_sequence', { name: 'nested', description: 'Invalid', steps: [{ tool: 'run_sequence', args: {} }] })).error, /finite physical/);
    assert.match((await call('save_sequence', { name: 'bad', description: 'Invalid', steps: [{ tool: 'walk_to', args: { x: { $param: 'missing' }, z: 0 } }] })).error, /parameter/);
    assert.match((await call('run_sequence', { steps: Array.from({ length: 9 }, () => steps[0]) })).error, /8/);
    for (let i = 0; i < 8; i++) assert.equal((await call('save_sequence', { name: `p${i}`, description: 'My procedure', steps: [steps[0]] })).saved, `p${i}`);
    assert.match((await call('save_sequence', { name: 'extra', description: 'Too many', steps: [steps[0]] })).error, /Eight/);
    assert.match((await call('run_sequence', { name: 'p0' }, { notes: [] })).error, /Unknown saved/);
    assert.equal((await call('forget_sequence', { name: 'p0' })).forgotten, 'p0');
    assert.equal(memory.routines!.length, 7);
    assert.equal(f.engine.tick, 0);
  } finally { await f.close(); }
});

test('parallel physical calls cannot slip into a running sequence in either dispatch order', async () => {
  for (const sequenceFirst of [true, false]) {
    const f = fixture();
    try {
      await f.start();
      const sequence = { name: 'run_sequence', arguments: { steps: [steps[0]], eventTypes: [] } };
      const walk = { name: 'walk_to', arguments: { x: .5, z: 4.5, eventTypes: [] } };
      f.requests[0].batch(sequenceFirst ? [sequence, walk] : [walk, sequence]);
      await f.advance(() => f.requests.length === 2);
      const results = f.requests[1].request.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content!));
      assert.equal(results.filter(item => item.error?.includes('only physical call')).length, 1);
      assert.equal(f.engine.recentEvents.filter(event => event.type === 'simulation-action').length, 1);
    } finally { await f.close(); }
  }
});

test('an interrupted sequence can resume after its physical action completes through another wait', async () => {
  const f = fixture();
  try {
    await f.start();
    f.requests[0].respond('run_sequence', { eventTypes: ['speech'], steps: [steps[1], steps[0]] });
    await f.advance(() => f.engine.tick === 10);
    assert.equal(f.engine.act('b', { action: 'say', word: 'Hello' }, 'manual').ok, true);
    await until(() => f.requests.length === 2);
    const interruption = output(f.requests[1].request);
    f.requests[1].respond('wait_for_event', { actionId: interruption.actionId, eventTypes: [] });
    await f.advance(() => f.requests.length === 3);
    assert.equal(f.engine.tick, 40);
    f.requests[2].respond('run_sequence', { sequenceId: interruption.sequenceId, eventTypes: [] });
    await f.advance(() => f.requests.length === 4);
    assert.equal(output(f.requests[3].request).status, 'completed');
    assert.equal(f.engine.tick, 60);
    assert.equal(f.engine.recentEvents.filter(event => event.type === 'simulation-action' && (event.data as any).action.kind === 'walk').length, 1);
  } finally { await f.close(); }
});

test('cancelling an interrupted sequence discards later steps but preserves its ongoing movement', async () => {
  const f = fixture();
  try {
    await f.start();
    f.requests[0].respond('run_sequence', { eventTypes: ['speech'], steps: [steps[1], steps[0]] });
    await f.advance(() => f.engine.tick === 10);
    assert.equal(f.engine.act('b', { action: 'say', word: 'Hello' }, 'manual').ok, true);
    await until(() => f.requests.length === 2);
    const interruption = output(f.requests[1].request);
    f.requests[1].respond('cancel_sequence', { sequenceId: interruption.sequenceId });
    await until(() => f.requests.length === 3);
    assert.equal(output(f.requests[2].request).status, 'cancelled');
    assert.ok(f.engine.entity('a').motion);
    f.requests[2].respond('wait_for_event', { actionId: interruption.actionId, eventTypes: [] });
    await f.advance(() => f.requests.length === 4);
    assert.equal(f.engine.entity('a').inventory!.selected, 0);
    assert.equal(f.engine.tick, 40);
  } finally { await f.close(); }
});

test('invalid event names never cross the physical action boundary, including stale hit targets', async () => {
  const f = fixture();
  try {
    const port = f.bridge.ports()[0], memory: AgentToolMemory = { notes: [] }, signal = new AbortController().signal;
    for (const [name, args] of [['walk_to', { x: .5, z: 4.5 }], ['hit', { target: [0, 1, 1] }]] as const) {
      const arguments_ = { ...args, eventTypes: ['unknown-event'] };
      const result = await agentTools(port, memory).executors[name](arguments_, { id: name, name, arguments: arguments_ }, signal) as any;
      assert.match(result.error, /allowed values/);
    }
    assert.equal(f.bridge.snapshot().entities.a.actions.length, 0);
    assert.equal(f.engine.tick, 0);
  } finally { await f.close(); }
});
