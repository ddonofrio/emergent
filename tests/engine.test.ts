import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Engine } from '../src/core/engine';
import type { Block, Entity, Vec3, WorldEvent } from '../src/core/types';
import { island } from '../src/universes/first-shore';
import { Store } from '../server/store';

const creature = (id: string, position: Vec3 = [.5, 1, .5]): Entity => ({
  id, name: id, kind: 'troglodyte', controller: 'agent', position, yaw: 0,
  height: 2, color: '#ffffff', inventory: null, status: 'idle',
});

function flatWorld(entities = [creature('a')], additions: Block[] = []) {
  const blocks: Block[] = [];
  for (let x = -20; x <= 20; x++) for (let z = -20; z <= 20; z++) blocks.push([x, 0, z, 'stone']);
  return new Engine({ ...island, generate: () => ({ blocks: [...blocks, ...additions], entities }) });
}

test('hearing and speaking preserve an ongoing walk until explicit cancellation', () => {
  const engine = flatWorld([creature('a'), creature('b', [3.5, 1, .5])]);
  assert.equal(engine.act('a', { action: 'walk', distance: 8 }).ok, true);
  const motion = engine.entity('a').motion;
  assert.equal(engine.act('b', { action: 'say', word: 'Hello there' }).ok, true);
  const heard = engine.notices('a').heard;
  assert.equal(heard[0].word, 'Hello there');
  assert.equal(engine.recentEvents.find(event => event.id === heard[0].eventId)?.type, 'speech');
  assert.equal(engine.act('a', { action: 'say', word: 'Hello' }).ok, true);
  assert.equal(engine.entity('a').motion, motion);
  for (let tick = 0; tick < 10; tick++) engine.step();
  assert.ok(Math.abs(engine.entity('a').position[2] - 1.5) < 1e-8);
  const stoppedAt = structuredClone(engine.entity('a').position);
  const result = engine.cancelMotion('a');
  assert.equal(result.feedback?.outcome, 'cancelled');
  assert.ok(Math.abs((result.feedback?.distanceTravelled as number) - 1) < 1e-8);
  for (let tick = 0; tick < 20; tick++) engine.step();
  assert.deepEqual(engine.entity('a').position, stoppedAt);
  assert.equal(engine.entity('a').motion, undefined);
});

test('event subscribers receive every event and cannot mutate recorded events', () => {
  const engine = flatWorld(), received: number[] = [];
  const unsubscribe = engine.subscribeEvents(event => {
    received.push(event.id);
    event.message = 'Mutated subscriber copy';
  });
  for (let index = 0; index < 260; index++) engine.event('world', 'check', `Event ${index}`);
  assert.equal(received.length, 260);
  assert.equal(new Set(received).size, 260);
  assert.equal(engine.recentEvents.length, 200);
  const frame = engine.frame();
  assert.equal(frame.events.length, 260);
  assert.equal(frame.events[0].message, 'Event 0');
  unsubscribe();
  engine.event('world', 'check', 'After unsubscribe');
  assert.equal(received.length, 260);
});

test('speech budgets renew exactly at each committed world-second boundary', () => {
  const engine = flatWorld();
  assert.equal(engine.act('a', { action: 'say', word: 'One two three' }).ok, true);
  assert.equal(engine.act('a', { action: 'say', word: 'More' }).ok, false);
  for (let tick = 0; tick < 20; tick++) engine.step();
  assert.equal(engine.act('a', { action: 'say', word: 'One two three' }).ok, true);
  assert.equal(engine.act('a', { action: 'say', word: 'More' }).ok, false);
});

test('the observer voice reaches active island listeners without spending time or ordinary speech budgets', () => {
  const disabled = { ...creature('disabled', [-10, 1, .5]), enabled: false };
  const engine = flatWorld([creature('a'), creature('far', [19, 1, 19]), disabled]);
  assert.equal(engine.act('a', { action: 'walk', distance: 8 }).ok, true);
  const motion = structuredClone(engine.entity('a').motion);
  assert.equal(engine.act('a', { action: 'say', word: 'Hello' }).ok, true);
  assert.equal(engine.notices('far').heard.length, 0, 'Ordinary speech still has a limited hearing range.');
  const remaining = engine.remainingSpeechWords('a');
  const result = engine.broadcastSpeech('Watch the clouds move over your island.');
  assert.equal(result.ok, true);
  assert.equal(engine.tick, 0);
  assert.equal(engine.remainingSpeechWords('a'), remaining);
  assert.deepEqual(engine.entity('a').motion, motion);
  for (const id of ['a', 'far']) {
    const heard = engine.notices(id).heard.at(-1)!;
    assert.equal(heard.from, 'GOD'); assert.equal(heard.direction, 'above');
    assert.match(heard.description!, /powerful.*echoing.*sky/);
    assert.equal(heard.word, 'Watch the clouds move over your island.');
    assert.equal(heard.distance, undefined);
    assert.equal(engine.entity(id).intent, undefined);
  }
  assert.equal(engine.notices('disabled').heard.length, 0);
});

test('invalid or unsupported observer speech leaves no event or inbox entry', () => {
  const engine = flatWorld();
  for (const input of [undefined, {}, '', '   ', 'x'.repeat(1001)]) assert.equal(engine.broadcastSpeech(input).ok, false);
  assert.equal(engine.nextEvent, 1); assert.equal(engine.inbox.size, 0);
  const unsupported = new Engine({ ...engine.module, observerVoice: undefined });
  assert.equal(unsupported.broadcastSpeech('Hello').ok, false);
  assert.equal(unsupported.nextEvent, 1);
});

test('recorded speech pages preserve the entire chat, same-tick ordering, and replay boundaries', () => {
  const engine = flatWorld(), store = new Store(':memory:', engine.module.manifest);
  try {
    store.record(engine.frame(), engine.state());
    for (let index = 0; index < 135; index++) {
      engine.broadcastSpeech(`Message ${index}`);
      engine.event('world', 'check', 'An unrelated event.');
    }
    for (let index = 0; index < 70; index++) engine.broadcastSpeech('Message 0');
    store.record(engine.frame());
    engine.step(); engine.broadcastSpeech('Future message'); store.record(engine.frame());
    let before = Number.MAX_SAFE_INTEGER;
    const all: WorldEvent[] = [];
    for (;;) {
      const page = store.speechAt(0, before);
      all.unshift(...page.events);
      if (!page.hasMore) break;
      assert.ok(page.events.length > 0); before = page.events[0].id;
    }
    assert.equal(all.length, 135);
    assert.deepEqual(all.map(event => (event.data as { word: string }).word), Array.from({ length: 135 }, (_, index) => `Message ${index}`));
    assert.equal(new Set(all.map(event => event.id)).size, 135);
    assert.equal(store.eventsAt(0, '', 1000).filter(event => event.type === 'speech').length, 205);
    assert.equal(store.speechAt(1).events.at(-1)?.message.includes('Future message'), true);
  } finally { store.close(); }
});

test('local notices and observations preserve occlusion, range, and private entity boundaries', () => {
  const speaker = creature('a');
  speaker.intent = { goal: 'Private intention', successCondition: 'Self assessed', status: 'active' };
  const engine = flatWorld([speaker, creature('near', [.5, 1, 4.5]), creature('far', [.5, 1, 19])]);
  engine.voxels.set([0, 2, 2], 'stone');
  assert.equal(engine.act('a', { action: 'say', word: 'Hello' }).ok, true);
  assert.deepEqual(engine.notices('near').heard, []);
  assert.deepEqual(engine.notices('far').heard, []);
  engine.voxels.set([0, 2, 2], null);
  assert.equal(engine.act('a', { action: 'say', word: 'Again' }).ok, true);
  const notice = engine.notices('near');
  assert.equal(notice.heard.length, 1);
  notice.heard[0].word = 'Changed outside the engine';
  assert.equal(engine.notices('near').heard[0].word, 'Again');
  engine.entity('near').yaw = 180;
  const seen = engine.observe('near').entities.find(entity => entity.id === 'a')!;
  assert.ok(seen);
  assert.equal('intent' in seen, false);
  assert.equal('inventory' in seen, false);
  engine.voxels.set([0, 2, 2], 'stone');
  assert.equal(engine.observe('near').entities.some(entity => entity.id === 'a'), false);
});

test('a moving body reports a dynamic collision and ends its rebound safely', () => {
  const engine = flatWorld([creature('a'), creature('b', [4.5, 1, 2.5])]);
  const collisions: WorldEvent[] = [];
  engine.subscribeEvents(event => { if (event.type === 'collision') collisions.push(event); });
  assert.equal(engine.act('a', { action: 'walk', distance: 4 }).ok, true);
  engine.entity('b').position = [.5, 1, 2.5];
  for (let tick = 0; tick < 40; tick++) engine.step();
  assert.ok(collisions.some(event => event.actor === 'a'));
  assert.equal(engine.entity('a').lastAction?.feedback?.outcome, 'collision');
  assert.equal(engine.entity('a').motion, undefined);
  assert.ok(engine.entity('a').position[2] < 2.5);
  assert.ok(engine.recentEvents.some(event => event.actor === 'a' && event.type === 'rebound-ended'));
});

test('speaking during a rebound preserves the collision result at physical completion', () => {
  const engine = flatWorld([creature('a'), creature('b', [4.5, 1, 2.5])]);
  assert.equal(engine.act('a', { action: 'walk', distance: 4 }).ok, true);
  engine.entity('b').position = [.5, 1, 2.5];
  for (let tick = 0; tick < 40 && engine.entity('a').motion?.kind !== 'bounce'; tick++) engine.step();
  assert.equal(engine.entity('a').motion?.kind, 'bounce');
  assert.equal(engine.act('a', { action: 'say', word: 'Hello' }).ok, true);
  for (let tick = 0; tick < 20; tick++) engine.step();
  assert.equal(engine.entity('a').lastAction?.feedback?.outcome, 'collision');
  assert.equal(engine.entity('a').lastAction?.feedback?.otherId, 'b');
  assert.match(engine.entity('a').lastAction!.message, /collide/);
});

test('finite resources and physical reach remain authoritative', () => {
  const engine = flatWorld(undefined, [[0, 1, 2, 'wood'], [8, 1, 0, 'wood']]);
  assert.equal(engine.act('a', { action: 'hit', target: [8, 1, 0] }).ok, false);
  assert.equal(engine.voxels.get([8, 1, 0]), 'wood');
  for (let hit = 0; hit < 3; hit++) assert.equal(engine.act('a', { action: 'hit', target: [0, 1, 2] }).ok, true);
  assert.equal(engine.voxels.get([0, 1, 2]), undefined);
  assert.deepEqual(engine.entity('a').inventory?.stacks, [{ kind: 'wood', count: 1 }]);
  assert.ok(engine.discoveries.get('a')?.has('blocks-break-after-three-hits'));
  assert.ok(engine.discoveries.get('a')?.has('item-uses:wood'));
  assert.equal(engine.act('a', { action: 'hit', target: [0, 1, 2] }).ok, false);
  assert.deepEqual(engine.entity('a').inventory?.stacks, [{ kind: 'wood', count: 1 }]);
  assert.equal(engine.act('a', { action: 'run', distance: 4 }).ok, false);
  assert.equal(engine.act('a', { action: 'place', target: [1, 1, 0] }).ok, true);
  assert.equal(engine.voxels.get([1, 1, 0]), 'wood');
  assert.equal(engine.entity('a').inventory, null);
  assert.equal(engine.act('a', { action: 'place', target: [2, 1, 0] }).ok, false);
});

test('deep water prevents a persistent walk from crossing an unsafe shore', () => {
  const engine = flatWorld();
  for (let x = -2; x <= 2; x++) for (let z = 1; z <= 10; z++) {
    engine.voxels.set([x, 0, z], null);
    engine.voxels.set([x, -3, z], 'sand');
  }
  assert.equal(engine.act('a', { action: 'walk', distance: 6 }).ok, true);
  for (let tick = 0; tick < 80; tick++) engine.step();
  assert.equal(engine.entity('a').motion, undefined);
  assert.equal((engine.entity('a').lastAction?.feedback?.issue as { kind: string }).kind, 'water');
  assert.ok(engine.entity('a').position[1] >= 0);
  assert.ok(engine.entity('a').position[2] < 1.3);
  assert.ok(engine.discoveries.get('a')?.has('deep-water-limit'));
});

test('a thrown raw block settling into terrain becomes durable learned knowledge', () => {
  const engine = flatWorld(), entity = engine.entity('a');
  entity.inventory = { stacks: [{ kind: 'stone', count: 1 }], selected: 0, capacity: 640 };
  assert.equal(engine.act('a', { action: 'throw', force: 4 }).ok, true);
  for (let tick = 0; tick < 240 && !engine.discoveries.get('a')?.has('thrown-blocks-settle'); tick++) engine.step();
  assert.ok(engine.discoveries.get('a')?.has('thrown-blocks-settle'));
  assert.ok(engine.recentEvents.some(event => event.actor === 'a' && event.type === 'discovery'
    && (event.data as { knowledge?: string }).knowledge === 'thrown-blocks-settle'));
});

test('a full inventory rejects pickup atomically and permits topping up an existing stack', () => {
  const engine = flatWorld(), entity = engine.entity('a');
  const kinds = ['grass', 'dirt', 'sand', 'stone', 'wood', 'leaves', 'stick', 'bucket', 'plank', 'spear'];
  entity.inventory = { stacks: kinds.map(kind => ({ kind, count: 64 })), selected: null, capacity: 640 };
  engine.bodies.push({ id: 'loose', kind: 'knife', position: [1.5, 1.3, .5], velocity: [0, 0, 0], resting: true });
  const full = structuredClone(entity.inventory);
  assert.equal(engine.act('a', { action: 'pickup', itemId: 'loose' }).ok, false);
  assert.deepEqual(entity.inventory, full);
  assert.equal(engine.bodies.length, 1);
  entity.inventory.stacks[3].count = 63;
  engine.bodies[0].kind = 'stone';
  assert.equal(engine.act('a', { action: 'pickup', itemId: 'loose' }).ok, true);
  assert.equal(entity.inventory.stacks[3].count, 64);
  assert.equal(entity.inventory.stacks.length, 10);
  assert.equal(engine.bodies.length, 0);
});

test('recorded world state and events replay without executing physics or model decisions', () => {
  const engine = flatWorld([creature('a'), creature('b', [3.5, 1, .5])]);
  const store = new Store(':memory:', engine.module.manifest);
  try {
    store.record(engine.frame(), engine.state());
    assert.equal(engine.act('a', { action: 'walk', distance: 4 }).ok, true);
    assert.equal(engine.act('b', { action: 'say', word: 'Hello' }).ok, true);
    for (let tick = 0; tick < 6; tick++) engine.step();
    const atSix = engine.state();
    store.record(engine.frame());
    for (let tick = 0; tick < 5; tick++) engine.step();
    store.record(engine.frame());
    assert.deepEqual(store.stateAt(6), atSix);
    assert.deepEqual(store.stateAt(11), engine.state());
    assert.ok(store.eventsAt(11).some(event => event.type === 'speech'));
    const restored = new Engine(engine.module, store.stateAt(6));
    assert.deepEqual(restored.state(), atSix);
    assert.equal(restored.tick, 6);
  } finally {
    store.close();
  }
});
