import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toolOutcome } from '../server/agents/tools';
import type { SimulationAction, ToolOutcome } from '../server/simulation/agent-port';

function action(overrides: Partial<SimulationAction> = {}): SimulationAction {
  return { id: 'walker:1', callId: 'wire-1', kind: 'walk', channel: 'movement', status: 'running', createdTick: 0,
    origin: [.5, 1, .5], position: [.5, 1, 4.5], target: [.5, 1, 8.5], distanceTravelled: 4, remainingDistance: 4,
    command: { action: 'walk', target: [.5, 1, 8.5] }, ...overrides };
}

test('model outcomes preserve every speech and collision event without repeating the primary movement', () => {
  const movement = action({ status: 'blocked', result: { ok: false, message: 'Collided with another body.', navigation: { checkedDistance: 8, paths: [] } } });
  const outcome: ToolOutcome = { tick: 40, position: [.5, 1, 4.5], reason: 'event', action: movement, actions: [movement],
    motion: { kind: 'bounce', destination: [.5, 1, 4.1], speed: 1, origin: [.5, 1, 4.5] },
    events: [
      { id: 10, tick: 40, type: 'speech', message: 'Other: Hello', data: { speakerId: 'other', from: 'Other', word: 'Hello', direction: 'right', distance: 3 } },
      { id: 11, tick: 40, type: 'speech', message: 'Third: Wait here', data: { speakerId: 'third', from: 'Third', word: 'Wait here', direction: 'left', distance: 4 } },
      { id: 12, tick: 40, type: 'collision', message: 'Collided with another body.', data: { entityId: 'other', to: [.5, 1, 4.5] } },
    ] };
  const value = toolOutcome(outcome);
  assert.deepEqual(value.events.map(event => event.id), [10, 11, 12]);
  assert.deepEqual(value.events.slice(0, 2).map(event => (event.data as { word: string }).word), ['Hello', 'Wait here']);
  assert.equal(value.action?.status, 'blocked');
  assert.equal(value.motion?.kind, 'bounce');
  assert.equal(value.action?.result?.ok, false);
  assert.equal(value.actions.length, 0);
  assert.equal('command' in value.action!, false);
  assert.deepEqual(outcome.actions, [movement]);
});

test('a later completion notification retains an interrupted physical result exactly once', () => {
  const completed = action({ id: 'walker:2', kind: 'pickup', channel: 'body', status: 'completed', command: { action: 'pickup', itemId: 'wood-1' },
    result: { ok: true, message: 'Picked up wood.', feedback: { inventoryDelta: [{ kind: 'wood', change: 1 }] } } });
  const outcome: ToolOutcome = { tick: 60, position: [.5, 1, 4.5], reason: 'event', actions: [],
    events: [{ id: 13, tick: 60, type: 'action-completed', message: 'pickup: completed.', data: { actionId: completed.id, action: completed } }] };
  const value = toolOutcome(outcome);
  assert.deepEqual(value.events[0].data, { actionId: 'walker:2', status: 'completed' });
  assert.deepEqual(value.completedActions?.[0].result?.feedback, { inventoryDelta: [{ kind: 'wood', change: 1 }] });
  assert.equal(JSON.stringify(value).match(/Picked up wood/g)?.length, 1);
  assert.equal((outcome.events[0].data as { action: SimulationAction }).action.command.action, 'pickup');
});
