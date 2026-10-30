import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entityLabelText } from '../src/view/entity-label';

test('entity labels show transient speech and return to the character name', () => {
  assert.equal(entityLabelText({ name: 'Moss', speech: { word: 'Follow me', until: 12 } }), 'Moss · Follow me');
  assert.equal(entityLabelText({ name: 'Moss' }), 'Moss');
});
