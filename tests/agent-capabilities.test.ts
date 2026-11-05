import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentTools, localView } from '../server/agents/tools';
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
    const result = await pending as { events: { type: string; message?: string; data?: { knowledge?: string } }[]; current: { self: { position: unknown } } };
    assert.ok(result.events.some(event => event.type === 'discovery' && event.data?.knowledge === 'wood-shape:plank'));
    assert.deepEqual(result.current.self.position, { x: .5, yHeight: 1, z: .5 });
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
    await assert.rejects(tools.executors.strike_held({ point: 'front_edge' },
      { id: 'edge', name: 'strike_held', arguments: { point: 'front_edge' } }, f.signal), /orientation/);
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
    const side = await forward.executors.look({ angle: 90 }, { id: 'look-side', name: 'look', arguments: { angle: 90 } }, f.signal) as { viewAngle: number };
    assert.equal(side.viewAngle, 90);
    assert.equal(memory.viewAngle, 90);
    const refreshed = agentTools(f.port, memory);
    const hit = refreshed.schemas.find(tool => tool.name === 'hit')!;
    const targets = (hit.parameters.properties as {target:{enum:number[][]}}).target.enum;
    assert.ok(targets.some(target => target.join(',') === '2,1,0'));
  } finally { f.bridge.close(); }
});
