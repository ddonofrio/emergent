import test from 'node:test';
import assert from 'node:assert/strict';
import type { TurnStatus } from '../src/core/time';
import type { Entity } from '../src/core/types';
import { entityDisplayStatus } from '../src/view/entity-status';

const entity = { id: 'moss', controller: 'agent', status: 'idle' } satisfies Pick<Entity, 'id' | 'controller' | 'status'>;
const runtime = (state: TurnStatus['agents'][string]['state'], phase: TurnStatus['phase'] = 'thinking'): TurnStatus => ({
  enabled: true, phase, turn: 1, tick: 0, agents: { moss: { state } },
});

test('thinking uses the individual live session even when the physical entity and clock phase are idle', () => {
  for (const phase of ['idle', 'thinking', 'advancing'] as const) {
    const status = entityDisplayStatus(entity, runtime('thinking', phase), true);
    assert.equal(status.text, 'thinking'); assert.equal(status.thinking, true);
  }
});

test('context compaction uses the shrinking activity indicator', () => {
  assert.deepEqual(entityDisplayStatus(entity, runtime('shrinking'), true), {
    text: 'shrinking', thinking: true, title: 'Shrinking the conversation context.',
  });
});

test('a disconnected model keeps the waiting indicator while the physical entity is idle', () => {
  const waiting = runtime('waiting', 'idle'); waiting.agents.moss.message = 'Connection refused; retrying.';
  assert.deepEqual(entityDisplayStatus(entity, waiting, true), {
    text: 'waiting', thinking: true, title: 'Connection refused; retrying.',
  });
});

test('paused and disabled entities do not retain a thinking indicator', () => {
  const paused = { ...runtime('thinking'), enabled: false, phase: 'paused' as const };
  assert.deepEqual(entityDisplayStatus(entity, paused, true), { text: 'paused', thinking: false, title: 'World paused.' });
  assert.deepEqual(entityDisplayStatus({ ...entity, enabled: false }, runtime('thinking'), true), { text: 'disabled', thinking: false });
});

test('prepared actions, recorded history, and non-agent entities retain their own states', () => {
  assert.equal(entityDisplayStatus(entity, runtime('ready'), true).text, 'ready');
  assert.deepEqual(entityDisplayStatus({ ...entity, status: 'walking' }, runtime('ready'), true), { text: 'walking', thinking: false });
  assert.deepEqual(entityDisplayStatus(entity, runtime('thinking'), false), { text: 'idle', thinking: false });
  assert.deepEqual(entityDisplayStatus({ ...entity, controller: 'static' }, runtime('thinking'), true), { text: 'idle', thinking: false });
});
