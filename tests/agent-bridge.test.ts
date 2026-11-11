import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Engine } from '../src/core/engine';
import type { Block, Entity, Vec3 } from '../src/core/types';
import { island } from '../src/universes/first-shore';
import { AgentBridge } from '../server/simulation/agent-bridge';

function fixture(other?: Vec3) {
  const blocks: Block[] = [];
  for (let x = -10; x <= 10; x++) for (let z = -10; z <= 20; z++) blocks.push([x, 0, z, 'stone']);
  const entity = (id: string, position: Vec3): Entity => ({
    id, name: id, kind: 'troglodyte', controller: id === 'a' ? 'agent' : 'static',
    position, yaw: 0, height: 2, color: '#ffffff', inventory: null, status: 'idle',
  });
  const engine = new Engine({ ...island, encounterMessage: undefined,
    generate: () => ({ blocks, entities: [entity('a', [.5, 1, .5]), ...(other ? [entity('b', other)] : [])] }) });
  const bridge = new AgentBridge(engine), port = bridge.ports()[0], signal = new AbortController().signal;
  const advance = (ticks: number) => { for (let tick = 0; tick < ticks; tick++) { engine.step(); bridge.afterStep(); } };
  return { engine, bridge, port, signal, advance };
}

test('conversation compaction is published to the world journal with pressure details', () => {
  const { engine, bridge, port } = fixture();
  try {
    port.recordContextCompaction({ pressure: .9, contextWindow: 10000, inputCapacity: 10000, thresholdTokens: 9000,
      projectedInputTokensBefore: 8200, projectedInputTokensAfter: 2100, messagesBefore: 60, messagesAfter: 30 });
    const event = engine.recentEvents.at(-1)!;
    assert.equal(event.actor, 'a');
    assert.equal(event.type, 'context-compaction');
    assert.equal(event.message, 'a compacted its conversation context.');
    assert.equal((event.data as { pressure: number }).pressure, .9);
  } finally { bridge.close(); }
});

test('movement progress uses the committed terrain destination and scoped world tick', async () => {
  const { engine, bridge, port, signal, advance } = fixture();
  try {
    const pending = port.submit('walk', { action: 'walk', target: [.5, 50, 4.5] }, signal);
    bridge.commit();
    assert.deepEqual(bridge.snapshot().entities.a.actions[0].target, [.5, 1, 4.5]);
    assert.equal(bridge.snapshot().entities.a.actions[0].remainingDistance, 4);
    advance(40);
    const result = await pending;
    assert.equal(result.action?.status, 'completed');
    assert.ok(Math.abs(result.action!.distanceTravelled - 4) < 1e-8);
    assert.equal(result.action?.remainingDistance, 0);
    assert.equal(port.tick, engine.tick);
    assert.equal(bridge.tick, engine.tick);
  } finally { bridge.close(); }
});

test('failed hit and walk attempts remain physical actions for one normal body turn', async () => {
  const { engine, bridge, port, signal, advance } = fixture();
  try {
    let hitResolved = false;
    const hit = port.submit('missed-hit', { action: 'hit', target: [0, 1, 1] }, signal)
      .then(result => { hitResolved = true; return result; });
    bridge.commit();
    const startedHit = bridge.snapshot().entities.a.actions.find(action => action.callId === 'missed-hit')!;
    assert.equal(startedHit.status, 'running');
    assert.equal(startedHit.result?.ok, false);
    assert.equal(startedHit.attemptedFailure, true);
    advance(19); await Promise.resolve();
    assert.equal(hitResolved, false);
    advance(1);
    const missed = await hit;
    assert.equal(missed.action?.status, 'completed');
    assert.equal(missed.action?.result?.ok, false);
    assert.match(missed.action?.result?.message ?? '', /nothing to hit/i);

    engine.voxels.set([0, 1, 1], 'stone');
    let walkResolved = false;
    const walk = port.submit('blocked-walk', { action: 'walk', distance: 2 }, signal)
      .then(result => { walkResolved = true; return result; });
    bridge.commit();
    const startedWalk = bridge.snapshot().entities.a.actions.find(action => action.callId === 'blocked-walk')!;
    assert.equal(startedWalk.status, 'running');
    assert.equal(startedWalk.result?.ok, false);
    assert.equal(startedWalk.attemptedFailure, true);
    advance(19); await Promise.resolve();
    assert.equal(walkResolved, false);
    advance(1);
    const blocked = await walk;
    assert.equal(blocked.action?.status, 'completed');
    assert.equal(blocked.action?.result?.ok, false);
    assert.equal(engine.tick, 40);
  } finally { bridge.close(); }
});

test('body completion remains observable after speech returned its first tool result', async () => {
  const { engine, bridge, port, signal, advance } = fixture([3.5, 1, .5]);
  try {
    const pending = port.submit('turn', { action: 'turn', angle: 90 }, signal);
    bridge.commit();
    assert.equal(engine.act('b', { action: 'say', word: 'Hello' }, 'manual').ok, true);
    bridge.flush();
    const heard = await pending;
    assert.equal(heard.reason, 'event');
    assert.equal(heard.action?.status, 'running');
    const following = port.wait('next-event', {}, signal);
    advance(20);
    const completed = await following;
    assert.ok(completed.events.some(event => event.type === 'action-completed'
      && (event.data as { actionId: string }).actionId === heard.action!.id));
  } finally { bridge.close(); }
});

test('cancellation and subsequent discoveries use distinct authoritative event IDs', async () => {
  const { engine, bridge, port, signal } = fixture();
  try {
    const pending = port.submit('walk', { action: 'walk', distance: 8 }, signal);
    bridge.commit();
    engine.event('a', 'discovery', 'First fact'); bridge.flush();
    const started = await pending;
    const cancellation = port.cancel('cancel', started.action!.id, signal);
    bridge.commit();
    const cancelled = await cancellation;
    assert.ok(cancelled.events.some(event => event.type === 'action-cancelled'));
    for (const event of cancelled.events) {
      const recorded = engine.recentEvents.find(recorded => recorded.id === event.id);
      assert.equal(recorded?.type, event.type);
    }
    const discovery = engine.event('a', 'discovery', 'Next fact');
    const next = await port.wait('next', {}, signal);
    assert.ok(next.events.some(event => event.id === discovery.id));
    assert.equal(new Set([...cancelled.events, ...next.events].map(event => event.id)).size, cancelled.events.length + next.events.length);
  } finally { bridge.close(); }
});

test('collision results report the rebound and its persistent action remains cancellable', async () => {
  const { engine, bridge, port, signal, advance } = fixture([4.5, 1, 2.5]);
  try {
    const pending = port.submit('walk', { action: 'walk', distance: 8 }, signal);
    bridge.commit();
    engine.entity('b').position = [.5, 1, 1.35];
    advance(2);
    const collision = await pending;
    assert.equal(collision.action?.status, 'blocked');
    assert.equal(collision.action?.physicalActive, true);
    assert.equal(collision.motion?.kind, 'bounce');
    const pendingCancel = port.cancel('cancel-rebound', collision.action!.id, signal);
    bridge.commit();
    const cancelled = await pendingCancel;
    assert.equal(cancelled.action?.status, 'completed');
    assert.equal(engine.entity('a').motion, undefined);
    assert.equal(cancelled.actions.some(action => action.id === collision.action!.id), false);
  } finally { bridge.close(); }
});

test('bounded receipt retention preserves an older ongoing action and all undelivered events', async () => {
  const { engine, bridge, port, signal } = fixture();
  try {
    const pending = port.submit('original-walk', { action: 'walk', distance: 8 }, signal);
    bridge.commit();
    engine.event('a', 'discovery', 'Initial fact'); bridge.flush();
    const started = await pending;
    for (let index = 0; index < 1100; index++) {
      const event = engine.event('a', 'discovery', `Fact ${index}`);
      const outcome = await port.wait(`event-${index}`, {}, signal);
      assert.ok(outcome.events.some(queued => queued.id === event.id));
    }
    const snapshot = bridge.snapshot().entities.a;
    assert.ok(Object.keys(snapshot.receipts).length <= 1025);
    assert.ok(snapshot.receipts['original-walk']);
    assert.ok(snapshot.actions.some(action => action.id === started.action!.id && action.status === 'running'));
    assert.ok(snapshot.seen.length <= 1024);
    const pendingCancel = port.cancel('cancel-old-walk', started.action!.id, signal);
    bridge.commit();
    assert.equal((await pendingCancel).action?.status, 'completed');
  } finally { bridge.close(); }
});

test('body operations are exclusive while speech remains concurrent', async () => {
  const { engine, bridge, port, signal, advance } = fixture();
  try {
    const first = port.submit('first-turn', { action: 'turn', angle: 90 }, signal);
    const second = port.submit('second-turn', { action: 'turn', angle: 90 }, signal);
    const walking = port.submit('walk-while-turning', { action: 'walk', distance: 2 }, signal);
    const speaking = port.submit('speak-while-turning', { action: 'say', word: 'Hello' }, signal);
    bridge.commit();
    assert.equal((await second).action?.status, 'rejected');
    assert.equal((await walking).action?.status, 'rejected');
    assert.equal(engine.entity('a').yaw, 90);
    assert.equal(engine.entity('a').motion, undefined);
    assert.equal(engine.entity('a').speech?.word, 'Hello');
    advance(20);
    assert.notEqual((await first).action?.status, 'rejected');
    assert.notEqual((await speaking).action?.status, 'rejected');
    const next = port.submit('turn-next-second', { action: 'turn', angle: 90 }, signal);
    bridge.commit(); advance(20);
    assert.equal((await next).action?.status, 'completed');
    assert.equal(engine.entity('a').yaw, 180);
  } finally { bridge.close(); }
});

test('look advances simulation time, remains concurrent with movement, and rejects a fourth use in one turn', async () => {
  const { engine, bridge, port, signal, advance } = fixture();
  try {
    const walking = port.submit('walk', { action: 'walk', distance: 4 }, signal);
    const looks = [-90, 0, 90, 180].map((angle, index) =>
      port.submit(`look-${index + 1}`, { action: 'look', angle }, signal));
    bridge.commit();
    const rejected = await looks[3];
    assert.equal(rejected.action?.status, 'rejected');
    assert.match(rejected.action?.result?.message ?? '', /three times this turn/);
    assert.equal(engine.tick, 0);
    advance(1);
    const completed = await Promise.all(looks.slice(0, 3));
    assert.ok(completed.every(result => result.action?.status === 'completed'));
    assert.ok(completed.every(result => result.action?.channel === 'perception'));
    assert.equal(engine.tick, 1);
    assert.ok(engine.entity('a').position[2] > .5);
    assert.equal(port.lookCount(0), 3);
    const cancel = port.cancel('cancel-walk', bridge.snapshot().entities.a.actions.find(action => action.callId === 'walk')!.id, signal);
    bridge.commit(); await cancel; await walking;
  } finally { bridge.close(); }
});

test('concurrent movement calls do not silently replace one another in the same batch', async () => {
  const { engine, bridge, port, signal, advance } = fixture();
  try {
    const first = port.submit('first-walk', { action: 'walk', distance: 4 }, signal);
    const second = port.submit('conflicting-walk', { action: 'walk', distance: 8 }, signal);
    bridge.commit();
    assert.equal((await second).action?.status, 'rejected');
    assert.deepEqual(engine.entity('a').motion?.destination, [.5, 1, 4.5]);
    advance(40);
    const result = await first;
    assert.notEqual(result.action?.status, 'cancelled');
    assert.deepEqual(engine.entity('a').position, [.5, 1, 4.5]);
  } finally { bridge.close(); }
});

test('every perceived settlement is delivered when one tick exceeds the notice snapshot limit', async () => {
  const { engine, bridge, port, signal } = fixture();
  try {
    for (let x = -5; x <= 5; x++) engine.bodies.push({ id: `falling-${x}`, kind: 'stone',
      position: [x + .5, 1.32, 4.5], velocity: [0, 0, 0], resting: true, settleAfter: 0 });
    const pending = port.wait('settlements', {}, signal);
    engine.step();
    const perceived = engine.recentEvents.filter(event => event.actor === 'a' && event.type === 'terrain-perceived');
    assert.ok(perceived.length > 8);
    assert.equal(engine.notices('a').terrainChanges.length, 8);
    bridge.afterStep();
    const result = await pending;
    const events = result.events.filter(event => event.type === 'terrain');
    assert.equal(events.length, perceived.length);
    assert.deepEqual(events.map(event => event.id), perceived.map(event => event.id));
    assert.equal(engine.notices('a').terrainChanges.length, 0);
  } finally { bridge.close(); }
});

test('one observed speech batch releases every parallel wait and is delivered once', async () => {
  const { engine, bridge, port, signal } = fixture([3.5, 1, .5]);
  try {
    engine.act('b', { action: 'say', word: 'Hello' }, 'manual');
    const first = port.wait('first-wait', {}, signal);
    const second = port.wait('second-wait', {}, signal);
    const results = await Promise.all([first, second]);
    assert.ok(results.every(result => result.reason === 'event'));
    assert.equal(results.flatMap(result => result.events).filter(event => event.type === 'speech').length, 1);
    assert.equal(results[0].events[0].type, 'speech');
    assert.deepEqual(results[1].events, []);
    assert.ok(bridge.snapshot().entities.a.receipts['first-wait']);
    assert.ok(bridge.snapshot().entities.a.receipts['second-wait']);
    assert.equal(engine.tick, 0);
  } finally { bridge.close(); }
});

test('waiting on a terminal action uses an explicit timeout instead of returning as completed again', async () => {
  const { engine, bridge, port, signal, advance } = fixture();
  try {
    assert.equal(engine.act('a', { action: 'say', word: 'one two three' }).ok, true);
    const rejectedCall = port.submit('rejected-say', { action: 'say', word: 'again' }, signal);
    bridge.commit();
    const rejected = await rejectedCall;
    assert.equal(rejected.action?.status, 'rejected');

    let released = false;
    const waiting = port.wait('wait-after-rejection', { actionId: rejected.action!.id, seconds: .1, eventTypes: [] }, signal)
      .then(result => { released = true; return result; });
    await Promise.resolve();
    assert.equal(released, false);
    advance(1);
    assert.equal(released, false);
    advance(1);
    const result = await waiting;
    assert.equal(result.reason, 'timeout');
    assert.equal(engine.tick, 2);

    const invalid = await port.wait('terminal-without-time', { actionId: rejected.action!.id, eventTypes: [] }, signal);
    assert.equal(invalid.reason, 'rejected');
    assert.match(invalid.events[0].message, /already finished/);
  } finally { bridge.close(); }
});

test('event waits default to five world seconds and clamp larger requests', async () => {
  const { engine, bridge, port, signal, advance } = fixture();
  try {
    let defaultResolved = false;
    const defaultWait = port.wait('default-wait', { eventTypes: [] }, signal)
      .then(result => { defaultResolved = true; return result; });
    advance(99); await Promise.resolve();
    assert.equal(defaultResolved, false);
    advance(1);
    const defaultResult = await defaultWait;
    assert.equal(defaultResult.reason, 'timeout');
    assert.equal(defaultResult.tick, 100);

    const clampedWait = port.wait('clamped-wait', { seconds: 30, eventTypes: [] }, signal);
    assert.equal(bridge.snapshot().entities.a.requests.find(request => request.callId === 'clamped-wait')?.untilTick, 200);
    advance(100);
    const clampedResult = await clampedWait;
    assert.equal(clampedResult.reason, 'timeout');
    assert.equal(clampedResult.tick, 200);
    assert.equal(engine.tick, 200);
  } finally { bridge.close(); }
});

test('resuming a legacy unbounded event wait applies the five-second limit', async () => {
  const setup = fixture();
  const paused = new AbortController();
  const pending = setup.port.wait('legacy-wait', { eventTypes: ['speech'] }, paused.signal);
  const cancelled = assert.rejects(pending, /Pause/);
  const state = setup.engine.state(), snapshot = setup.bridge.snapshot();
  delete snapshot.entities.a.requests.find(request => request.callId === 'legacy-wait')!.untilTick;
  paused.abort(new Error('Pause')); await cancelled; setup.bridge.close();

  const engine = new Engine(island, state), bridge = new AgentBridge(engine, snapshot), port = bridge.ports()[0];
  try {
    let resolved = false;
    const resumed = port.resume('legacy-wait', new AbortController().signal)!
      .then(result => { resolved = true; return result; });
    for (let tick = 0; tick < 99; tick++) { engine.step(); bridge.afterStep(); }
    await Promise.resolve();
    assert.equal(resolved, false);
    engine.step(); bridge.afterStep();
    const result = await resumed;
    assert.equal(result.reason, 'timeout');
    assert.equal(result.tick, 100);
  } finally { bridge.close(); }
});

test('walk and a parallel event wait both return on speech without stopping movement', async () => {
  const { engine, bridge, port, signal, advance } = fixture([3.5, 1, .5]);
  try {
    const walking = port.submit('walk', { action: 'walk', distance: 8 }, signal);
    const waiting = port.wait('also-wait', {}, signal);
    bridge.commit(); advance(5);
    engine.act('b', { action: 'say', word: 'Hello' }, 'manual');
    const results = await Promise.all([walking, waiting]);
    assert.ok(results.every(result => result.reason === 'event'));
    assert.equal(results.flatMap(result => result.events).filter(event => event.type === 'speech').length, 1);
    assert.equal(results[0].action?.status, 'running');
    assert.deepEqual(engine.entity('a').motion?.destination, [.5, 1, 8.5]);
    assert.equal(engine.tick, 5);
  } finally { bridge.close(); }
});

test('scans require a stationary body and retain their results through concurrent speech', async () => {
  const { engine, bridge, port, signal, advance } = fixture([3.5, 1, .5]);
  try {
    const walking = port.submit('walk', { action: 'walk', distance: 8 }, signal);
    bridge.commit(); advance(5);
    const destination = structuredClone(engine.entity('a').motion!.destination);
    const invalidScan = port.submit('scan-while-walking', { action: 'find_material' }, signal);
    bridge.commit();
    assert.equal((await invalidScan).action?.status, 'rejected');
    assert.deepEqual(engine.entity('a').motion?.destination, destination);
    const walkId = bridge.snapshot().entities.a.actions.find(action => action.callId === 'walk')!.id;
    const stop = port.cancel('stop-walk', walkId, signal); bridge.commit(); await stop;
    assert.equal((await walking).action?.status, 'cancelled');
    const scanning = port.submit('scan', { action: 'find_material' }, signal);
    bridge.commit(); advance(15);
    assert.equal(engine.act('b', { action: 'say', word: 'Hello' }, 'manual').ok, true);
    bridge.flush();
    const scan = await scanning;
    assert.equal(scan.action?.channel, 'body');
    assert.equal(scan.action?.status, 'running');
    assert.equal(engine.entity('a').motion?.kind, 'scan');
    const finished = port.wait('finish-scan', { actionId: scan.action!.id }, signal);
    advance(5);
    const result = await finished;
    assert.equal(result.action?.status, 'completed');
    assert.equal(result.action?.result?.feedback?.scanType, 'find_material');
    assert.ok((result.action?.result?.feedback?.materials as unknown[]).length > 0);
    assert.ok(engine.discoveries.get('a')?.has('observed-material:stone'));
    assert.ok(port.knowledge().some(fact => fact.includes('observed stone terrain')));

    const repeated = port.submit('repeat-scan', { action: 'find_material' }, signal);
    bridge.commit(); advance(20);
    const unchanged = await repeated;
    assert.equal(unchanged.action?.result?.feedback?.unchanged, true);
    assert.match(unchanged.action?.result?.message ?? '', /Nothing has changed/);
  } finally { bridge.close(); }
});

test('filtered waits defer unwanted events without closing the clock barrier or losing receipts', async () => {
  const { engine, bridge, port, signal, advance } = fixture();
  try {
    const walking = port.submit('walk-filtered', { action: 'walk', distance: 4 }, signal);
    bridge.commit();
    engine.event('a', 'discovery', 'An initial event'); bridge.flush();
    const started = await walking;
    let released = false;
    const waiting = port.wait('finish-walk', { actionId: started.action!.id, eventTypes: ['speech'] }, signal).then(value => { released = true; return value; });
    const first = engine.event('a', 'discovery', 'Deferred first fact'); bridge.flush();
    const second = engine.event('a', 'discovery', 'Deferred second fact'); bridge.flush();
    await Promise.resolve();
    assert.equal(released, false);
    assert.equal(port.waiting(), true, 'Ignored queued events must not freeze the shared clock.');
    advance(40);
    const completed = await waiting;
    assert.equal(completed.action?.status, 'completed');
    assert.equal(completed.reason, 'completed');
    assert.deepEqual(completed.events.filter(event => [first.id, second.id].includes(event.id)).map(event => event.id), [first.id, second.id]);
    assert.deepEqual(bridge.snapshot().entities.a.events, []);
  } finally { bridge.close(); }
});

test('filtered event choice and deferred events survive restart until timeout', async () => {
  const setup = fixture();
  const paused = new AbortController();
  const pending = setup.port.wait('filtered-timeout', { seconds: .1, eventTypes: [] }, paused.signal);
  const cancelled = assert.rejects(pending, /Pause/);
  const event = setup.engine.event('a', 'discovery', 'Keep this fact across restart'); setup.bridge.flush();
  const state = setup.engine.state(), snapshot = setup.bridge.snapshot();
  paused.abort(new Error('Pause')); await cancelled; setup.bridge.close();
  const engine = new Engine(island, state), bridge = new AgentBridge(engine, snapshot), port = bridge.ports()[0];
  try {
    const resumed = port.wait('filtered-timeout', {}, new AbortController().signal);
    bridge.flush();
    assert.equal(port.waiting(), true);
    for (let tick = 0; tick < 2; tick++) { engine.step(); bridge.afterStep(); }
    const result = await resumed;
    assert.equal(result.reason, 'timeout');
    assert.ok(result.events.some(queued => queued.id === event.id));
  } finally { bridge.close(); }
});

test('a forced failure turn survives restart and resumes from the original tool call ID', async () => {
  const setup = fixture();
  const paused = new AbortController();
  const pending = setup.port.yieldTurn('failed-tool-call', paused.signal);
  const cancelled = assert.rejects(pending, /Pause/);
  const state = setup.engine.state(), snapshot = setup.bridge.snapshot();
  paused.abort(new Error('Pause')); await cancelled; setup.bridge.close();

  const engine = new Engine(island, state), bridge = new AgentBridge(engine, snapshot), port = bridge.ports()[0];
  try {
    const resumed = port.resume('failed-tool-call', new AbortController().signal)!;
    assert.ok(resumed);
    for (let tick = 0; tick < 20; tick++) { engine.step(); bridge.afterStep(); }
    const result = await resumed;
    assert.equal(result.reason, 'timeout');
    assert.equal(result.tick, 20);
    assert.ok(Object.keys(bridge.snapshot().entities.a.receipts).some(id => id.startsWith('failed-tool-call:')));
  } finally { bridge.close(); }
});

test('closing a bridge revokes pending waits and prevents deferred checkpoints', async () => {
  const setup = fixture(); setup.bridge.close();
  let checkpoints = 0;
  const bridge = new AgentBridge(setup.engine, undefined, () => { checkpoints++; });
  const port = bridge.ports()[0];
  const waiting = port.wait('pending-close', {}, setup.signal);
  bridge.close();
  await assert.rejects(waiting, /connection closed/);
  await Promise.resolve();
  assert.equal(checkpoints, 0);
  await assert.rejects(port.wait('after-close', {}, setup.signal), /connection is closed/);
});

test('a failed receipt checkpoint rejects released waits and revokes the bridge', async () => {
  const setup = fixture(); setup.bridge.close();
  let checkpoints = 0;
  const bridge = new AgentBridge(setup.engine, undefined, () => { checkpoints++; throw new Error('Cannot record receipt.'); });
  const port = bridge.ports()[0];
  const waiting = port.wait('pending-checkpoint', {}, setup.signal);
  const rejection = assert.rejects(waiting, /Cannot record receipt/);
  setup.engine.event('a', 'discovery', 'Observed before checkpoint');
  assert.throws(() => bridge.flush(), /Cannot record receipt/);
  await rejection;
  await Promise.resolve();
  assert.equal(checkpoints, 1);
  assert.equal(setup.engine.tick, 0);
  await assert.rejects(port.submit('after-failure', { action: 'walk', distance: 2 }, setup.signal), /connection is closed/);
  bridge.close();
});

test('acknowledged receipts are discarded while unresolved results remain resumable', async () => {
  const setup = fixture();
  try {
    const first = setup.port.submit('first', { action: 'look' }, setup.signal);
    setup.bridge.commit(); setup.advance(1); await first;
    const second = setup.port.wait('second', { seconds: .05, eventTypes: [] }, setup.signal);
    setup.advance(1); const outcome = await second;
    setup.port.retainCalls(['second']);
    const state = setup.bridge.snapshot().entities.a;
    assert.equal(state.receipts.first, undefined);
    assert.equal(state.actions.some(action => action.callId === 'first'), false);
    assert.deepEqual(state.receipts.second, outcome);
    assert.deepEqual(await setup.port.resume('second', setup.signal), outcome);
    setup.port.retainCalls([]);
    assert.deepEqual(setup.bridge.snapshot().entities.a.receipts, {});
  } finally { setup.bridge.close(); }
});
