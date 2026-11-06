import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPACTION_PRESSURE, PersistentSession, balancedCuts, conversationRequest, recentConversation, type ContextCompaction, type Message } from '../vendor/littlewhale';
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

test('conversation history grows to ninety percent of the context window regardless of the output limit', () => {
  const options = { system: 'Entity.', schemas: [], currentContext: () => 'Fresh record.', contextWindow: 10000, maxTokens: 10000 };
  const baseline = conversationRequest({ ...options, contextWindow: 100000 }, history());
  const estimatedTokens = estimateTokens({ system: options.system, tools: options.schemas, messages: baseline.messages });
  const below = conversationRequest(options, history(), { inputTokens: 8999, estimatedTokens });
  assert.equal(below.compaction, undefined);
  assert.equal(below.history.filter(message => message.role === 'assistant').length, 13);
  assert.match(below.messages[0].content!, /continuing an existing conversation/);
  assert.match(below.messages.at(-1)!.content!, /Fresh record/);
  assert.match(JSON.stringify(below.messages), /Hidden reasoning 0/);
  assert.equal(JSON.stringify(below.messages).includes('compacted-summary'), false);

  const atThreshold = conversationRequest(options, history(), { inputTokens: 9000, estimatedTokens });
  assert.equal(atThreshold.compaction?.pressure, COMPACTION_PRESSURE);
  assert.equal(atThreshold.compaction?.inputCapacity, 10000);
  assert.equal(atThreshold.compaction?.thresholdTokens, 9000);
  assert.equal(atThreshold.compaction?.projectedInputTokensBefore, 9000);
  assert.equal(atThreshold.history.filter(message => message.role === 'assistant').length, 10);
  assert.equal(JSON.stringify(atThreshold.messages).includes('Hidden reasoning'), false);
  assert.equal(JSON.stringify(atThreshold.messages).includes('compacted-summary'), false);
  assert.match(atThreshold.messages.at(-1)!.content!, /Fresh record/);
});

test('pressure compaction refreshes current context, records session events, and preserves original audit events', async () => {
  const seed = new PersistentSession('window');
  const snapshot = seed.snapshot();
  snapshot.messages = history();
  snapshot.events = snapshot.messages.map((message, seq) => ({ seq, type: message.role === 'assistant' ? 'assistant/message' : message.role === 'tool' ? 'tool/result' : 'user/message', data: message }));
  const currentContext = () => JSON.stringify({ record: { notes: ['Fresh note.'] }, observation: { tick: 42 } });
  const options = { system: 'Entity.', schemas: [], currentContext, contextWindow: 10000, maxTokens: 1000 };
  const baseline = conversationRequest({ ...options, contextWindow: 100000 }, snapshot.messages);
  snapshot.contextPressure = { inputTokens: 9000,
    estimatedTokens: estimateTokens({ system: options.system, tools: options.schemas, messages: baseline.messages }) };
  const session = new PersistentSession('window', snapshot), abort = new AbortController();
  let calls = 0, compacted: ContextCompaction | undefined;
  await assert.rejects(session.run({ ...options, tools: {}, signal: abort.signal, onCompaction: details => { compacted = details; },
    complete: async request => {
      calls++;
      assert.equal(request.purpose, 'agent');
      assert.match(request.messages[0].content!, /continuing an existing conversation/);
      assert.match(request.messages.at(-1)!.content!, /Fresh note/);
      assert.equal(request.messages.filter(message => message.role === 'assistant').length, 10);
      assert.equal(JSON.stringify(request.messages).includes('Hidden reasoning'), false);
      abort.abort(new Error('Done')); throw abort.signal.reason;
    },
  }), /Done/);
  assert.equal(calls, 1);
  assert.equal(session.metrics.compactionCalls, 0);
  assert.equal(compacted?.thresholdTokens, 9000);
  assert.equal(session.snapshot().compactions, 1);
  assert.deepEqual(session.snapshot().events.slice(0, snapshot.events.length), snapshot.events);
  assert.deepEqual(session.snapshot().events.slice(-2).map(event => event.type), ['compaction/start', 'compaction/end']);
  const restored = new PersistentSession('window', session.snapshot());
  const next = conversationRequest({ system: 'Entity.', schemas: [], currentContext: () => 'Updated record.' }, restored.snapshot().messages);
  assert.match(next.messages.at(-1)!.content!, /Updated record/);
  assert.equal(next.messages.filter(message => message.role === 'assistant').length, 10);
});
