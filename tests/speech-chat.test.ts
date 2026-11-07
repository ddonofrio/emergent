import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorldEvent } from '../src/core/types';
import { CHAT_LIFETIME_MS, SpeechChat } from '../src/view/speech-chat';

const entities = [{ id: 't1', name: 'Moss' }, { id: 't2', name: 'Flint' }, { id: 'duck', name: 'Pebble' }];
const speech = (id: number, actor: string, word: string, data = {}): WorldEvent => ({
  id, actor, type: 'speech', tick: 0, time: 0, day: 1, message: '', data: { word, ...data },
});

test('chat colors speakers separately and expires on display time even at a frozen world tick', () => {
  const chat = new SpeechChat();
  chat.add([speech(1, 't1', 'Hi'), speech(2, 't2', 'Hello'), speech(3, 'duck', 'Quack'),
    speech(4, 'god', 'Look at the sky', { speakerName: 'GOD', broadcast: true })], entities, 100);
  const lines = chat.visible(100);
  assert.deepEqual(lines.map(line => line.name), ['Moss', 'Flint', 'Pebble', 'GOD']);
  assert.equal(new Set(lines.map(line => line.color)).size, 4);
  assert.equal(chat.visible(100 + CHAT_LIFETIME_MS - 1).length, 4);
  assert.equal(chat.visible(100 + CHAT_LIFETIME_MS).length, 0);
  chat.add([speech(4, 'god', 'Look at the sky', { speakerName: 'GOD', broadcast: true })], entities, 9000);
  assert.equal(chat.visible(9000).length, 0, 'Reconnected frames cannot revive an expired line.');
  chat.reset();
  chat.add([speech(1, 't1', 'Hi')], entities, 10000);
  assert.equal(chat.visible(10000)[0].text, 'Hi', 'Seeking can show recorded speech again.');
});

test('repeated text from the same speaker appears once even between other messages or after fading', () => {
  const chat = new SpeechChat();
  chat.add([speech(1, 't1', 'Hi'), speech(2, 't1', 'Hi'), speech(3, 't2', 'Hi'),
    speech(4, 't1', 'Look here'), speech(5, 't1', 'Hi')], entities, 0);
  assert.deepEqual(chat.visible(0).map(line => [line.name, line.text]), [['Moss', 'Hi'], ['Flint', 'Hi'], ['Moss', 'Look here']]);
  chat.add([speech(6, 't1', 'Hi')], entities, CHAT_LIFETIME_MS + 1);
  assert.equal(chat.visible(CHAT_LIFETIME_MS + 1).length, 0);
});
