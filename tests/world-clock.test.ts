import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/core/engine';
import { island } from '../src/universes/first-shore';
import { TurnClock } from '../server/turn-clock';
import { disconnectedWorld, type WorldConnection } from '../server/simulation/connection';

const emptyWorld = () => new Engine({ ...island, generate: () => ({ blocks: [], entities: [] }) });
const hooks = { frame() {}, status() {}, fatal(error: unknown) { throw error; } };

test('the world clock runs a one-second increment with no agent system', () => {
  const engine = emptyWorld(); let wall = 0;
  const clock = new TurnClock(engine, disconnectedWorld, hooks, () => wall);
  clock.setEnabled(true); wall = 1000; clock.pump();
  assert.equal(engine.tick, 20); assert.equal(engine.time, 1);
  clock.setEnabled(false); wall = 100000; clock.pump(); assert.equal(engine.tick, 20);
  clock.close();
});

test('inference beginning and ending between timer pumps never grants world-time debt', () => {
  const engine = emptyWorld(); let wall = 0, ready = true;
  const connection: WorldConnection = { ...disconnectedWorld, ready: () => ready };
  const clock = new TurnClock(engine, connection, hooks, () => wall);
  clock.setEnabled(true); clock.pump();
  wall = 25; ready = false; clock.barrierChanged();
  wall = 1025; ready = true; clock.barrierChanged(); clock.pump();
  assert.equal(engine.tick, 0);
  wall = 1075; clock.pump(); assert.equal(engine.tick, 1);
  clock.close();
});

test('a mid-second event closes the barrier before another tick and resumes the remaining second', () => {
  const engine = emptyWorld(); let wall = 0, ready = true;
  const connection: WorldConnection = { ...disconnectedWorld, ready: () => ready,
    afterStep() { if (engine.tick === 7) ready = false; } };
  const clock = new TurnClock(engine, connection, hooks, () => wall);
  clock.setEnabled(true); wall = 1000; clock.pump(); assert.equal(engine.tick, 7);
  wall = 100000; clock.pump(); assert.equal(engine.tick, 7);
  ready = true; clock.barrierChanged(); clock.pump();
  wall += 1000; clock.pump(); assert.equal(engine.tick, 20);
  clock.close();
});
