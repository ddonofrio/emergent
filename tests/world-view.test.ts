import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entityLabelText } from '../src/view/entity-label';

test('entity labels keep the character name while speech appears in chat', () => {
  const speaking = { name: 'Moss', speech: { word: 'Follow me', until: 12 } };
  assert.equal(entityLabelText(speaking), 'Moss');
  assert.equal(entityLabelText({ name: 'Moss' }), 'Moss');
});
