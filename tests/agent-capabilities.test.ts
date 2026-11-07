import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentTools, localView, type AgentToolMemory } from '../server/agents/tools';
import { AgentBridge } from '../server/simulation/agent-bridge';
import { Engine } from '../src/core/engine';
import type { Block, Entity } from '../src/core/types';
import { island } from '../src/universes/first-shore';

function fixture() {
  const blocks: Block[] = [];
  for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) blocks.push([x, 0, z, 'stone']);
  blocks.push([2, 1, 0, 'wood']);
  const entity: Entity = { id: 'maker', name: 'Maker', kind: 'troglodyte', controller: 'agent', position: [.5, 1, .5], yaw: 0,
    height: 2, color: '#fff', status: 'idle', inventory: { stacks: [{ kind: 'wood', count: 2 }], selected: 0, capacity: 640 },
    intent: { goal: 'Learn how wood changes.', successCondition: 'Discover one repeatable shape.', status: 'active' } };
  const engine = new Engine({ ...island, generate: () => ({ blocks, entities: [entity] }) });
  const bridge = new AgentBridge(engine), port = bridge.ports()[0], signal = new AbortController().signal;
  const advance = (ticks: number) => { for (let tick = 0; tick < ticks; tick++) { engine.step(); bridge.afterStep(); } };
  return { engine, bridge, port, signal, advance };
}

test('held wood exposes semantic experiments and learned recipes without revealing products early', async () => {
  const f = fixture();
  try {
    const notes = { notes: ['Wood came from the nearby tree.'] };
    const tools = agentTools(f.port, notes);
    const names = tools.schemas.map(tool => tool.name);
    assert.ok(names.includes('strike_held'));
    assert.equal(names.includes('interact'), false);
    assert.equal(names.includes('run'), false);
    const strike = tools.schemas.find(tool => tool.name === 'strike_held')!;
    assert.deepEqual((strike.parameters.properties as {point:{enum:string[]}}).point.enum,
      ['top_center', 'bottom_center', 'front_center', 'side_center', 'front_corner', 'front_edge']);
    assert.equal(/plank|bucket|spear|knife|shovel|door/.test(strike.description), false);
    const throwing = tools.schemas.find(tool => tool.name === 'throw')!;
    assert.deepEqual((throwing.parameters.properties as {force:{minimum:number;maximum:number}}).force, { type: 'number', minimum: 1, maximum: 12 });

    const pending = tools.executors.strike_held({ point: 'bottom_center' },
      { id: 'shape', name: 'strike_held', arguments: { point: 'bottom_center' } }, f.signal);
    f.bridge.commit(); f.advance(20);
    const result = await pending as { events: { type: string; message?: string; data?: { knowledge?: string } }[]; position: unknown };
    assert.ok(result.events.some(event => event.type === 'discovery' && event.data?.knowledge === 'wood-shape:plank'));
    assert.deepEqual(result.position, [.5, 1, .5]);
    assert.equal(f.engine.entity('maker').inventory?.stacks.some(stack => stack.kind === 'plank' && stack.count === 5), true);

    const woodIndex = f.engine.entity('maker').inventory!.stacks.findIndex(stack => stack.kind === 'wood');
    assert.equal(f.engine.act('maker', { action: 'hold', stack: woodIndex }).ok, true);
    assert.ok(f.port.knowledge().includes('Strike wood at bottom_center to make five planks, each 0.20 metres thick.'));
    const observation = localView(f.port.observe(), f.port.knowledge(), notes.notes);
    assert.deepEqual(observation.self.intent, f.engine.entity('maker').intent);
    assert.deepEqual(observation.notes, notes.notes);
    assert.ok(observation.learned.some(fact => fact.includes('bottom_center')));
  } finally { f.bridge.close(); }
});

test('front-edge wood experiments require an explicit orientation before entering the simulation', async () => {
  const f = fixture();
  try {
    const tools = agentTools(f.port, { notes: [] });
    const result = await tools.executors.strike_held({ point: 'front_edge' },
      { id: 'edge', name: 'strike_held', arguments: { point: 'front_edge' } }, f.signal) as any;
    assert.match(result.error, /orientation/);
    assert.equal(result.toolControl.failures, 1);
    assert.equal(f.bridge.snapshot().entities.maker.actions.length, 0);
  } finally { f.bridge.close(); }
});

test('a side look refreshes applicable target tools from that local view', async () => {
  const f = fixture();
  try {
    f.engine.entity('maker').inventory = null;
    const memory: { notes: string[]; viewAngle?: number } = { notes: [] };
    const forward = agentTools(f.port, memory);
    const forwardHit = forward.schemas.find(tool => tool.name === 'hit');
    const forwardTargets = (forwardHit?.parameters.properties as {target?:{enum:number[][]}} | undefined)?.target?.enum ?? [];
    assert.equal(forwardTargets.some(target => target.join(',') === '2,1,0'), false);
    const missed = forward.executors.hit({ target: [2, 1, 0] },
      { id: 'hidden-hit', name: 'hit', arguments: { target: [2, 1, 0] } }, f.signal) as Promise<any>;
    f.bridge.commit();
    const missResult = await missed;
    assert.equal(missResult.action.status, 'running');
    const finishing = f.port.wait('finish-hidden-hit', { actionId: missResult.action.id }, f.signal);
    f.advance(20);
    const finishedMiss = await finishing;
    assert.equal(finishedMiss.action?.status, 'completed');
    assert.equal(finishedMiss.action?.result?.ok, false);
    assert.equal(f.engine.voxels.get([2, 1, 0]), 'wood');
    assert.equal(f.engine.blockDamage.has('2,1,0'), false);
    const looking = forward.executors.look({ angle: 90 }, { id: 'look-side', name: 'look', arguments: { angle: 90 } }, f.signal);
    f.bridge.commit(); f.advance(1);
    const side = await looking as { viewAngle: number; timeAdvancedTicks: number };
    assert.equal(side.viewAngle, 90);
    assert.equal(side.timeAdvancedTicks, 1);
    assert.equal(memory.viewAngle, 90);
    const refreshed = agentTools(f.port, memory);
    const hit = refreshed.schemas.find(tool => tool.name === 'hit')!;
    const targets = (hit.parameters.properties as {target:{enum:number[][]}}).target.enum;
    assert.ok(targets.some(target => target.join(',') === '2,1,0'));
  } finally { f.bridge.close(); }
});

test('look consumes time and is limited to three uses per world turn regardless of angle', async () => {
  const f = fixture();
  try {
    const memory: AgentToolMemory = { notes: [] };
    const call = async (id: string, angle: number) => {
      const tools = agentTools(f.port, memory);
      const pending = tools.executors.look({ angle }, { id, name: 'look', arguments: { angle } }, f.signal) as Promise<Record<string, unknown>>;
      f.bridge.commit(); f.advance(1);
      return pending;
    };
    const first = await call('look-1', -90);
    assert.equal(first.timeAdvancedTicks, 1);
    assert.equal(first.looksUsedThisTurn, 1);
    const second = await call('look-2', 0);
    assert.equal(second.looksUsedThisTurn, 2);
    const third = await call('look-3', 90);
    assert.equal(third.looksUsedThisTurn, 3);
    assert.equal(third.lookUnavailable, true);
    assert.equal(agentTools(f.port, memory).schemas.some(tool => tool.name === 'look'), false);

    f.advance(17);
    assert.equal(agentTools(f.port, memory).schemas.some(tool => tool.name === 'look'), true);
  } finally { f.bridge.close(); }
});

test('learned context retains every authoritative discovery outside its immediate use context', () => {
  const f = fixture();
  try {
    f.engine.discover('maker', 'deep-water-limit', 'Learned the island boundary.');
    f.engine.discover('maker', 'thrown-blocks-settle', 'Learned how thrown blocks settle.');
    const learned = f.port.knowledge();
    assert.ok(learned.some(fact => fact.includes('island ends at deep water')));
    assert.ok(learned.some(fact => fact.includes('Thrown blocks settle')));
  } finally { f.bridge.close(); }
});

test('say is unavailable after the turn speech budget is spent and returns next turn', () => {
  const f = fixture();
  try {
    assert.equal(f.engine.act('maker', { action: 'say', word: 'one two three' }).ok, true);
    assert.equal(f.port.remainingSpeechWords(), 0);
    assert.equal(agentTools(f.port, { notes: [] }).schemas.some(tool => tool.name === 'say'), false);
    f.advance(20);
    assert.equal(f.port.remainingSpeechWords(), 3);
    assert.equal(agentTools(f.port, { notes: [] }).schemas.some(tool => tool.name === 'say'), true);
  } finally { f.bridge.close(); }
});

test('temporarily unavailable tools and unchanged intent force stalled loops to pass the turn', async () => {
  const f = fixture();
  try {
    const memory: AgentToolMemory = { notes: [] };
    for (let index = 0; index < 3; index++) {
      const tools = agentTools(f.port, memory);
      const pending = tools.executors.look({}, { id: `look-${index}`, name: 'look', arguments: {} }, f.signal) as Promise<unknown>;
      f.bridge.commit(); f.advance(1); await pending;
    }
    assert.equal(f.engine.act('maker', { action: 'say', word: 'one two three' }).ok, true);

    const unavailable = agentTools(f.port, memory);
    assert.equal(unavailable.schemas.some(tool => tool.name === 'look' || tool.name === 'say'), false);
    const look = await unavailable.executors.look({}, { id: 'stale-look', name: 'look', arguments: {} }, f.signal) as any;
    assert.equal(look.toolControl.failedCallsThisTurn, 1);
    assert.match(look.error, /next world turn/);

    const intent = structuredClone(f.engine.entity('maker').intent!);
    const intentArguments = intent as unknown as Record<string, unknown>;
    const unchanged = await agentTools(f.port, memory).executors.set_intent(intentArguments,
      { id: 'same-intent', name: 'set_intent', arguments: intentArguments }, f.signal) as any;
    assert.equal(unchanged.toolControl.failedCallsThisTurn, 2);
    assert.match(unchanged.error, /unchanged/);

    const passing = agentTools(f.port, memory).executors.say({ word: 'again' },
      { id: 'stale-say', name: 'say', arguments: { word: 'again' } }, f.signal) as Promise<any>;
    f.advance(17);
    const result = await passing;
    assert.equal(result.toolControl.passTurn, true);
    assert.equal(result.forcedTurn.tick, 20);
    assert.deepEqual(f.engine.entity('maker').intent, intent);
  } finally { f.bridge.close(); }
});

test('set_intent does not accept or expose a self-authored identity', async () => {
  const f = fixture();
  try {
    (f.engine.entity('maker').intent as unknown as { identity: string }).identity = 'Legacy explorer identity';
    const tools = agentTools(f.port, { notes: [] });
    const schema = tools.schemas.find(tool => tool.name === 'set_intent')!;
    const properties = schema.parameters.properties as Record<string, unknown>;
    assert.equal('identity' in properties, false);
    assert.equal('identity' in localView(f.port.observe()).self.intent!, false);
    const current = structuredClone(f.engine.entity('maker').intent!);
    const result = await tools.executors.set_intent(current as unknown as Record<string, unknown>,
      { id: 'legacy-identity', name: 'set_intent', arguments: current as unknown as Record<string, unknown> }, f.signal) as any;
    assert.match(result.error, /identity|additional/i);
  } finally { f.bridge.close(); }
});

test('repeated well-formed hit and walk failures lock after three attempts and any other tool unlocks them', async () => {
  const f = fixture();
  try {
    f.engine.entity('maker').inventory = null;
    const memory: AgentToolMemory = { notes: [] };
    const failedHit = async (id: string) => {
      const tools = agentTools(f.port, memory);
      const advertised = tools.schemas.find(tool => tool.name === 'hit')!;
      const targets = (advertised.parameters.properties as {target:{enum:number[][]}}).target.enum;
      assert.equal(targets.some(target => target.join(',') === '0,1,1'), false);
      const pending = tools.executors.hit({ target: [0, 1, 1] },
        { id, name: 'hit', arguments: { target: [0, 1, 1] } }, f.signal) as Promise<any>;
      f.bridge.commit(); f.advance(20);
      return pending;
    };

    const firstHit = await failedHit('miss-1');
    assert.equal(firstHit.toolControl.failures, 1);
    assert.equal(memory.toolFailures?.hit?.count, 1);
    const secondHit = await failedHit('miss-2');
    assert.equal(secondHit.toolControl.failures, 2);
    assert.match(secondHit.toolControl.message, /same.*nothing/i);
    const thirdHit = await failedHit('miss-3');
    assert.equal(thirdHit.toolControl.unavailable, true);
    assert.equal(thirdHit.toolControl.passTurn, true);
    assert.equal(memory.toolFailures?.hit?.unavailable, true);

    const lockedHitTools = agentTools(f.port, memory);
    assert.equal(lockedHitTools.schemas.some(tool => tool.name === 'hit'), false);
    const lockedHit = await lockedHitTools.executors.hit({ target: [0, 1, 1] },
      { id: 'miss-4', name: 'hit', arguments: { target: [0, 1, 1] } }, f.signal) as any;
    assert.equal(lockedHit.toolControl.unavailable, true);
    const malformedLockedHit = await lockedHitTools.executors.hit({ target: '[0,1,1]' },
      { id: 'bad-hit', name: 'hit', arguments: { target: '[0,1,1]' } }, f.signal) as any;
    assert.equal(malformedLockedHit.toolControl.unavailable, true);
    assert.equal(memory.toolFailures?.hit?.count, 3);

    const recall = agentTools(f.port, memory);
    await recall.executors.recall({ query: 'wood' }, { id: 'recall', name: 'recall', arguments: { query: 'wood' } }, f.signal);
    assert.equal(memory.toolFailures?.hit, undefined);
    assert.equal(agentTools(f.port, memory).schemas.some(tool => tool.name === 'hit'), true);
    f.advance(20);

    const turning = agentTools(f.port, memory).executors.turn({ angle: 90 },
      { id: 'turning', name: 'turn', arguments: { angle: 90 } }, f.signal);
    f.bridge.commit();
    const failedWalk = async (id: string) => {
      const tools = agentTools(f.port, memory);
      assert.equal(tools.schemas.some(tool => tool.name === 'walk'), false);
      const result = tools.executors.walk({ distance: 2 },
        { id, name: 'walk', arguments: { distance: 2 } }, f.signal);
      f.bridge.commit();
      return result as Promise<any>;
    };
    assert.equal((await failedWalk('walk-1')).toolControl.failures, 1);
    assert.equal((await failedWalk('walk-2')).toolControl.failures, 2);
    const thirdWalk = failedWalk('walk-3');
    f.advance(20);
    assert.equal((await thirdWalk).toolControl.unavailable, true);
    assert.equal(memory.toolFailures?.walk?.unavailable, true);
    await turning;
    assert.equal(agentTools(f.port, memory).schemas.some(tool => tool.name === 'walk'), false);

    const unlock = agentTools(f.port, memory);
    await unlock.executors.recall({ query: 'wood' }, { id: 'unlock', name: 'recall', arguments: { query: 'wood' } }, f.signal);
    assert.equal(memory.toolFailures?.walk, undefined);
    assert.equal(agentTools(f.port, memory).schemas.some(tool => tool.name === 'walk'), true);
    const malformedWalk = await agentTools(f.port, memory).executors.walk({ distance: '2' },
      { id: 'bad-walk', name: 'walk', arguments: { distance: '2' } }, f.signal) as any;
    assert.match(malformedWalk.error, /number/);
    assert.equal((memory.toolFailures as Record<string, { count: number }> | undefined)?.walk?.count, 1);
  } finally { f.bridge.close(); }
});

test('three malformed calls remove that tool and pass the turn until another tool is used', async () => {
  const f = fixture();
  try {
    f.engine.entity('maker').inventory = null;
    const memory: AgentToolMemory = { notes: [] };
    const malformedHit = (id: string, target: string) => agentTools(f.port, memory).executors.hit({ target },
      { id, name: 'hit', arguments: { target } }, f.signal) as Promise<any>;
    assert.equal((await malformedHit('bad-hit-1', '[0,1,1]')).toolControl.failures, 1);
    assert.equal((await malformedHit('bad-hit-2', '[1,1,1]')).toolControl.failures, 2);
    const third = malformedHit('bad-hit-3', '[2,1,1]');
    f.advance(20);
    const result = await third;
    assert.equal(result.toolControl.unavailable, true);
    assert.equal(result.toolControl.passTurn, true);
    assert.equal(result.forcedTurn.tick, 20);
    assert.equal(agentTools(f.port, memory).schemas.some(tool => tool.name === 'hit'), false);

    const tools = agentTools(f.port, memory);
    await tools.executors.recall({ query: 'wood' }, { id: 'use-other', name: 'recall', arguments: { query: 'wood' } }, f.signal);
    assert.equal(memory.toolFailures?.hit, undefined);
    assert.equal(agentTools(f.port, memory).schemas.some(tool => tool.name === 'hit'), true);
  } finally { f.bridge.close(); }
});

test('three interleaved failed calls pass the turn without removing tools below their own limit', async () => {
  const f = fixture();
  try {
    f.engine.entity('maker').inventory = null;
    const memory: AgentToolMemory = { notes: [] };
    const hit = await agentTools(f.port, memory).executors.hit({ target: '[0,1,1]' },
      { id: 'interleaved-hit', name: 'hit', arguments: { target: '[0,1,1]' } }, f.signal) as any;
    const walk = await agentTools(f.port, memory).executors.walk({ distance: 'two' },
      { id: 'interleaved-walk', name: 'walk', arguments: { distance: 'two' } }, f.signal) as any;
    assert.equal(hit.toolControl.failures, 1);
    assert.equal(walk.toolControl.failures, 1);

    const third = agentTools(f.port, memory).executors.inspect_jump({ angle: 'left', distance: 1 },
      { id: 'interleaved-jump', name: 'inspect_jump', arguments: { angle: 'left', distance: 1 } }, f.signal) as Promise<any>;
    f.advance(20);
    const jump = await third;
    assert.equal(jump.toolControl.passTurn, true);
    assert.equal(jump.toolControl.unavailable, undefined);
    assert.equal(jump.forcedTurn.tick, 20);
    assert.equal(memory.toolFailures?.hit?.unavailable, undefined);
    assert.equal(memory.toolFailures?.walk?.unavailable, undefined);
    assert.equal(memory.toolFailures?.inspect_jump?.unavailable, undefined);
    const names = agentTools(f.port, memory).schemas.map(tool => tool.name);
    assert.ok(names.includes('hit'));
    assert.ok(names.includes('walk'));
    assert.ok(names.includes('inspect_jump'));
  } finally { f.bridge.close(); }
});
