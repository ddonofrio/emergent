import test from 'node:test';
import assert from 'node:assert/strict';
import { PersistentSession, balancedCuts, conversationRequest, recentConversation, type Message } from '../vendor/littlewhale';
import { estimateTokens } from '../vendor/littlewhale/tool-pairing';

function history(): Message[] {
  return [{ role: 'user', content: '<compacted-summary>Old checkpoint.</compacted-summary>' }, ...Array.from({ length: 13 }, (_, index): Message[] => [
    { role: 'assistant', content: `Decision ${index}`, toolCalls: [{ id: `a${index}`, name: 'look', arguments: {} }, { id: `b${index}`, name: 'remember', arguments: { notes: ['A fact.'] } }],
      providerState: { content: [{ type: 'thinking', thinking: `Hidden reasoning ${index}` }] } },
    { role: 'tool', toolCallId: `a${index}`, toolName: 'look', content: `Result ${index}` },
    { role: 'tool', toolCallId: `b${index}`, toolName: 'remember', content: '{"notes":["A fact."]}' },
  ]).flat()];
}

test('the window keeps ten complete exchanges, their exact calls and results, and no old reasoning or checkpoint', () => {
  const original = history(), window = recentConversation(original);
  assert.equal(window.length, 30);
  assert.equal(window[0].content, 'Decision 3');
  assert.equal(balancedCuts(window).at(-1), true);
  assert.equal(JSON.stringify(window).includes('Hidden reasoning'), false);
  assert.equal(JSON.stringify(window).includes('compacted-summary'), false);
  assert.deepEqual(window, original.slice(10).map(({ providerState: _state, ...message }) => message));
  assert.deepEqual(original, history());
});

test('size limits drop whole groups and pending calls never appear as completed history', () => {
  const original = history();
  const tail = original.slice(-6).map(({ providerState: _state, ...message }) => message);
  assert.deepEqual(recentConversation(original, estimateTokens(tail)), tail);
  assert.deepEqual(recentConversation(original, 1), []);
  original.push({ role: 'assistant', content: null, toolCalls: [{ id: 'pending', name: 'walk', arguments: {} }] });
  assert.equal(recentConversation(original).some(message => message.toolCalls?.some(call => call.id === 'pending')), false);
});

test('every request refreshes memory and observation without replacing original audit events', async () => {
  const seed = new PersistentSession('window');
  const snapshot = seed.snapshot();
  snapshot.messages = history();
  snapshot.events = snapshot.messages.map((message, seq) => ({ seq, type: message.role === 'assistant' ? 'assistant/message' : message.role === 'tool' ? 'tool/result' : 'user/message', data: message }));
  const session = new PersistentSession('window', snapshot), abort = new AbortController();
  let calls = 0;
  const currentContext = () => JSON.stringify({ record: { notes: ['Fresh note.'] }, observation: { tick: 42 } });
  await assert.rejects(session.run({ system: 'Entity.', schemas: [], tools: {}, currentContext, signal: abort.signal,
    complete: async request => {
      calls++;
      assert.equal(request.purpose, 'agent');
      assert.match(request.messages[0].content!, /Earlier conversation history is no longer included/);
      assert.match(request.messages[0].content!, /Fresh note/);
      assert.equal(request.messages.filter(message => message.role === 'assistant').length, 10);
      assert.equal(JSON.stringify(request.messages).includes('Hidden reasoning'), false);
      abort.abort(new Error('Done')); throw abort.signal.reason;
    },
  }), /Done/);
  assert.equal(calls, 1);
  assert.equal(session.metrics.compactionCalls, 0);
  assert.deepEqual(session.snapshot().events, snapshot.events);
  const restored = new PersistentSession('window', session.snapshot());
  const next = conversationRequest({ system: 'Entity.', schemas: [], currentContext: () => 'Updated record.' }, restored.snapshot().messages);
  assert.match(next.messages[0].content!, /Updated record/);
  assert.equal(next.messages.length, 31);
});
