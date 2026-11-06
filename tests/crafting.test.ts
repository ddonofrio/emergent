import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Engine } from '../src/core/engine';
import { knowledgeDescription } from '../src/core/knowledge';
import { AgentBridge } from '../server/simulation/agent-bridge';
import { agentTools, observeAgent } from '../server/agents/tools';
import { island } from '../src/universes/first-shore';
import type { Block, Entity, UniverseModule, Vec3 } from '../src/core/types';

const target: Vec3 = [0, 1, 2];
function fixture(kind = 'wood', source?: string, universe: UniverseModule = island) {
  const blocks: Block[] = [];
  for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) blocks.push([x, 0, z, 'stone']);
  if (source) blocks.push([...target, source]);
  const entity: Entity = { id: 'maker', name: 'Maker', kind: 'troglodyte', controller: 'agent', position: [.5, 1, .5], yaw: 0,
    height: 2, color: '#fff', status: 'idle', inventory: { stacks: [{ kind, count: 2 }], selected: null, capacity: 640 } };
  const engine = new Engine({ ...universe, generate: () => ({ blocks, entities: [entity] }) });
  const bridge = new AgentBridge(engine), port = bridge.ports()[0];
  const tools = () => agentTools(port, { notes: [] });
  return { engine, bridge, port, tools };
}

test('first holding permanently records all experiment inputs once, revealing only tested recipes', () => {
  const f = fixture('wood', 'wood');
  try {
    assert.equal(f.engine.discoveries.get('maker')?.has('item-uses:wood') ?? false, false);
    assert.equal(f.engine.act('maker', { action: 'hold', stack: 0 }).ok, true);
    const uses = f.port.knowledge().find(fact => fact.includes('top_center'))!;
    for (const point of ['top_center', 'bottom_center', 'front_center', 'side_center', 'front_corner', 'front_edge']) assert.ok(uses.includes(point));
    assert.match(uses, /orientation up or down/);
    assert.equal(/bucket|shovel|plank|knife|spear|door/.test(uses), false);
    assert.deepEqual(f.port.recall('bucket'), { facts: [], total: 0 }, 'Recall cannot reveal an untried recipe.');
    assert.equal(f.engine.act('maker', { action: 'store' }).ok, true);
    assert.ok(f.port.knowledge().includes(uses), 'Stored wood keeps its known experimental possibilities relevant.');
    f.engine.act('maker', { action: 'hold', stack: 0 });
    assert.equal(f.engine.recentEvents.filter(event => (event.data as { knowledge?: string })?.knowledge === 'item-uses:wood').length, 1);
    const result = f.engine.act('maker', { action: 'strike_held', impact: [.5, 1, .5] });
    assert.equal(result.ok, true);
    assert.equal(result.feedback?.source, 'held-inventory');
    assert.equal(result.feedback?.point, 'top_center');
    assert.equal(f.engine.voxels.get(target), 'wood', 'A held experiment cannot consume the nearby world block.');
    assert.ok(f.engine.discoveries.get('maker')?.has('wood-shape:bucket'));
    assert.equal([...f.engine.discoveries.get('maker')!].filter(key => key.startsWith('wood-shape:')).length, 1);
    assert.ok(f.port.knowledge().includes('Strike wood at top_center to make a bucket.'));
    const restored = new Engine(island, f.engine.state());
    assert.ok(restored.discoveries.get('maker')?.has('item-uses:wood'));
    assert.equal(knowledgeDescription('item-uses:wood', restored.module.crafting), uses);
    const resumed = new AgentBridge(restored);
    resumed.close();
    assert.equal(restored.recentEvents.filter(event => event.type === 'discovery').length, 0, 'Restart must not rediscover held uses.');
    f.engine.entity('maker').inventory = null;
    assert.equal(f.port.knowledge().includes(uses), true, 'Learned context must retain every authoritative discovery.');
    assert.ok(f.port.recall('wood').facts.includes(uses), 'Permanent methods remain retrievable without owning the item.');
    assert.ok(f.port.recall('top_center').facts.includes('Strike wood at top_center to make a bucket.'));
  } finally { f.bridge.close(); }
});

test('held and stored tools retain conditional uses without inventing reachable targets', () => {
  for (const kind of ['bucket', 'shovel']) {
    const f = fixture(kind);
    try {
      f.engine.act('maker', { action: 'hold', stack: 0 });
      const action = kind === 'bucket' ? 'fill' : 'dig';
      const observation = observeAgent(f.port, []);
      const capability = observation.capabilities.find(capability => capability.action === action)!;
      assert.equal(capability.available, false);
      assert.match(capability.description, /sand/);
      assert.equal(f.tools().schemas.some(tool => tool.name === action), false);
      assert.ok(f.engine.discoveries.get('maker')?.has(`item-uses:${kind}`));
      f.engine.act('maker', { action: 'store' });
      assert.match(observeAgent(f.port, []).capabilities.find(capability => capability.action === action)!.requires, /hold on stack 0/);
      f.engine.act('maker', { action: 'hold', stack: 0 });
      f.engine.voxels.set(target, 'sand');
      assert.ok(f.tools().schemas.some(tool => tool.name === action));
      assert.equal(f.engine.act('maker', { action, target }).ok, true);
      assert.equal(f.engine.voxels.get(target), undefined);
      assert.equal(f.engine.held(f.engine.entity('maker'))?.kind, kind);
    } finally { f.bridge.close(); }
  }
});

test('container exchanges preserve each container and contents for all supported materials', () => {
  for (const source of ['water', 'dirt', 'sand']) {
    const f = fixture('bucket', source);
    try {
      f.engine.act('maker', { action: 'hold', stack: 0 });
      assert.equal(f.engine.act('maker', { action: 'fill', target }).ok, true);
      assert.equal(f.engine.held(f.engine.entity('maker'))?.contents, source);
      assert.equal(f.engine.entity('maker').inventory!.stacks.find(stack => !stack.contents)?.count, 1);
      const destination = f.port.observe().interactions.empty[0];
      assert.ok(destination);
      assert.equal(f.engine.act('maker', { action: 'empty', target: destination }).ok, true);
      assert.deepEqual(f.engine.entity('maker').inventory!.stacks, [{ kind: 'bucket', count: 2 }]);
      if (source !== 'water') assert.equal(f.engine.voxels.get(destination), source);
    } finally { f.bridge.close(); }
  }
});

test('every registered wood experiment preserves its product and quantities', () => {
  for (const recipe of island.crafting!.recipes.filter(recipe => recipe.experiment)) {
    const f = fixture();
    try {
      f.engine.act('maker', { action: 'hold', stack: 0 });
      const experiment = island.crafting!.items.wood.experiments!.find(experiment => experiment.point === recipe.experiment!.point)!;
      assert.equal(f.engine.act('maker', { action: 'strike_held', impact: experiment.impact, orientation: recipe.experiment!.orientation }).ok, true);
      assert.deepEqual(f.engine.entity('maker').inventory!.stacks, [{ kind: 'wood', count: 1 }, recipe.result]);
      assert.ok(f.engine.discoveries.get('maker')?.has(recipe.knowledge.id));
    } finally { f.bridge.close(); }
  }
});

test('a universe can add an experiment and combination without engine or agent tool edits', () => {
  const universe: UniverseModule = { ...island, crafting: {
    items: { clay: { experiments: [{ point: 'center', impact: [.5, 1, .5], matches: () => true }] } },
    recipes: [
      { id: 'shape-clay', ingredients: [{ kind: 'clay', count: 1 }], experiment: { point: 'center' }, result: { kind: 'tile', count: 2 },
        knowledge: { id: 'clay:tile', description: 'A centered strike shapes held clay into two tiles.' }, message: 'Two tiles formed.' },
      { id: 'join-tiles', ingredients: [{ kind: 'tile', count: 2 }], result: { kind: 'panel', count: 1 },
        knowledge: { id: 'tiles:panel', description: 'Join two tiles into one panel.' }, message: 'One panel formed.' },
    ],
  } };
  const f = fixture('clay', undefined, universe);
  try {
    f.engine.act('maker', { action: 'hold', stack: 0 });
    assert.ok(f.tools().schemas.some(tool => tool.name === 'strike_held'));
    assert.equal(JSON.stringify(observeAgent(f.port, [])).includes('tile'), false);
    assert.equal(f.engine.act('maker', { action: 'strike_held', impact: [.5, 1, .5] }).ok, true);
    assert.ok(f.port.knowledge().includes('A centered strike shapes held clay into two tiles.'));
    assert.ok(f.tools().schemas.some(tool => tool.name === 'join'));
    assert.equal(f.engine.act('maker', { action: 'join', recipeId: 'join-tiles' }).ok, true);
    assert.deepEqual(f.engine.entity('maker').inventory!.stacks, [{ kind: 'clay', count: 1 }, { kind: 'panel', count: 1 }]);
    assert.equal(f.engine.discoveries.get('maker')?.has('wood-shape:bucket') ?? false, false);
  } finally { f.bridge.close(); }
});

test('body occupancy hides dependent physical tools until completion while preserving speech and observation', async () => {
  const f = fixture();
  try {
    const signal = new AbortController().signal;
    const pending = f.port.submit('hold', { action: 'hold', stack: 0 }, signal);
    f.bridge.commit();
    const result = await pending;
    assert.equal(result.action?.status, 'running', 'First-hold discovery returns before the body action ends.');
    const busy = observeAgent(f.port, []).bodyActivity;
    assert.equal(busy?.id, result.action?.id);
    const names = f.tools().schemas.map(tool => tool.name);
    for (const name of ['walk', 'walk_to', 'turn', 'store', 'find_material', 'strike_held']) assert.equal(names.includes(name), false, name);
    for (const name of ['say', 'look', 'remember', 'wait_for_event']) assert.ok(names.includes(name), name);
    for (let tick = 0; tick < 20; tick++) { f.engine.step(); f.bridge.afterStep(); }
    assert.equal(f.port.bodyActivity(), undefined);
    assert.ok(f.tools().schemas.some(tool => tool.name === 'strike_held'));
  } finally { f.bridge.close(); }
});
