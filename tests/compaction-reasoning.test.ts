import test from 'node:test';
import assert from 'node:assert/strict';
import { PersistentSession, balancedCuts, type Completion, type CompletionRequest, type Message, type SessionSnapshot } from '../vendor/littlewhale';
import { compactablePrefix, compactedMessages } from '../vendor/littlewhale/compaction';
import { estimateTokens } from '../vendor/littlewhale/tool-pairing';
import { InferenceClient } from '../server/inference/providers';

const reasoning = 'I considered both routes and chose the reachable landing. '.repeat(1200);
const summary = 'The agent chose to reach the nearby landing. Inspection confirmed it was reachable; a look was rejected while busy. Keep the chosen destination and wait for the current action.';
const options = { system: 'One embodied agent.', schemas: [], contextWindow: 60000, maxOutputTokens: 40960 };
const completion = (content: string): Completion => ({ content, calls: [], provider: 'fixture', model: 'fixture', latencyMs: 1 });

function fixture(): SessionSnapshot {
  const seed = new PersistentSession('reasoning');
  seed.appendUser('Choose a reachable landing.');
  const snapshot = seed.snapshot();
  const calls = [
    { id: 'inspect-canonical', name: 'inspect_jump', arguments: { distance: 1, angle: -45 } },
    { id: 'look-canonical', name: 'look', arguments: {} },
  ];
  const messages: Message[] = [
    { role: 'assistant', content: 'Check the landing.', toolCalls: calls, providerState: {
      role: 'assistant', api: 'openai-completions', provider: 'fixture', model: 'fixture', timestamp: 0,
      stopReason: 'toolUse', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      content: [
        { type: 'thinking', thinking: reasoning, thinkingSignature: 'reasoning_content' },
        { type: 'text', text: 'Check the landing.', textSignature: 'old-text-signature' },
        ...calls.map((call, index) => ({ type: 'toolCall', ...call, id: `wire-${index}` })),
      ],
    } },
    { role: 'tool', toolCallId: calls[0].id, toolName: calls[0].name, content: '{"checked":true,"landing":[-12,6,-10]}' },
    { role: 'tool', toolCallId: calls[1].id, toolName: calls[1].name, content: '{"error":"Body is busy."}', isError: true },
  ];
  snapshot.messages.push(...structuredClone(messages));
  for (const message of messages) snapshot.events.push({ seq: snapshot.events.length,
    type: message.role === 'assistant' ? 'assistant/message' : 'tool/result', data: structuredClone(message) });
  return snapshot;
}

test('compaction summarizes retained reasoning before clearing it durably, without erasing original events or new reasoning', async () => {
  const original = fixture();
  assert.equal(compactablePrefix({ ...options, tools: {}, signal: new AbortController().signal,
    complete: async () => completion(summary) }, original.messages), 1);
  // Clearing the retained reasoning makes room even when the summary exceeds the old prefix.
  assert.ok(estimateTokens(summary) > estimateTokens(original.messages[0]));
  const session = new PersistentSession(original.id, original);
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(3000)]);
  const requests: CompletionRequest[] = [];
  let saved: SessionSnapshot | undefined;
  let savedBeforeAction: SessionSnapshot | undefined;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const run = session.run({ ...options, signal,
    persist: snapshot => { saved = snapshot; },
    complete: async request => {
      requests.push(structuredClone(request));
      if (request.purpose === 'compaction') return completion(summary);
      savedBeforeAction = saved;
      return { ...completion('Wait for arrival.'), calls: [{ id: 'new-wire', name: 'wait_for_event', arguments: {} }],
        providerState: { content: [{ type: 'thinking', thinking: 'Fresh reasoning after compaction.' }] } };
    },
    tools: { wait_for_event: async (_args, _call, callSignal) => {
      entered();
      return new Promise((_resolve, reject) => callSignal.addEventListener('abort', () => reject(callSignal.reason), { once: true }));
    } },
  });
  try {
    await Promise.race([waiting, run]);
    assert.deepEqual(requests.map(request => request.purpose), ['compaction', 'agent']);
    assert.deepEqual(requests[0].messages.slice(0, -1), original.messages, 'The summary must see the recent reasoning before it is removed.');
    const cleaned = requests[1].messages;
    assert.deepEqual(cleaned.slice(1), original.messages.slice(1).map(({ providerState: _state, ...message }) => message));
    assert.equal(balancedCuts(cleaned).at(-1), true);
    assert.equal(JSON.stringify(cleaned).includes(reasoning), false);
    assert.deepEqual(savedBeforeAction?.messages, cleaned);
    assert.equal(savedBeforeAction?.compactions, 1);
    assert.deepEqual(savedBeforeAction?.events.slice(0, original.events.length), original.events);
    const restored = new PersistentSession(original.id, saved).snapshot();
    assert.deepEqual(restored.messages.slice(0, cleaned.length), cleaned, 'Restart must not restore old provider replay envelopes.');
    assert.match(JSON.stringify(restored.messages.at(-1)?.providerState), /Fresh reasoning after compaction/);
    assert.deepEqual(original, fixture(), 'Compaction must not mutate the source snapshot.');
  } finally {
    abort.abort(new Error('Test finished'));
    await assert.rejects(run, /Test finished|abort|timeout/i);
  }
});

test('failed, truncated and cancelled compactions leave retained reasoning untouched', async t => {
  for (const outcome of ['failed', 'truncated', 'cancelled'] as const) await t.test(outcome, async () => {
    const original = fixture(), session = new PersistentSession(original.id, original);
    const abort = new AbortController();
    let calls = 0;
    const run = session.run({ ...options, tools: {}, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(3000)]),
      complete: async () => {
        calls++;
        if (outcome === 'failed') throw new Error('Provider unavailable');
        if (outcome === 'cancelled') abort.abort(new Error('Pause'));
        return { ...completion(summary), ...(outcome === 'truncated' ? { finishReason: 'length' as const } : {}) };
      },
      onState: state => { if (state === 'retrying') abort.abort(new Error('Pause')); },
    });
    await assert.rejects(run, /Pause|abort/i);
    assert.equal(calls, 1);
    assert.equal(session.metrics.compactionCalls, 1);
    assert.equal(session.snapshot().compactions, 0);
    assert.deepEqual(session.snapshot().messages, original.messages);
  });
});

test('pi-ai sends retained calls and results without reintroducing cleared reasoning', async t => {
  const payloads: { messages: Record<string, unknown>[] }[] = [];
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => {
    payloads.push(JSON.parse(String(init?.body)));
    const end = { id: 'offline', object: 'chat.completion.chunk', created: 0, model: 'fixture',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'Ready.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } };
    return new Response(`data: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  });
  const client = new InferenceClient([{ id: 'fixture', model: 'fixture', type: 'openai-compatible', name: 'Offline fixture', baseUrl: 'http://fixture.invalid/v1', apiKey: '', tokenless: true }]);
  const original = fixture();
  const request: CompletionRequest = { ...options, tools: [], messages: original.messages, purpose: 'agent' };
  await client.complete(request, new AbortController().signal);
  await client.complete({ ...request, messages: compactedMessages(original.messages, 1, summary) }, new AbortController().signal);
  assert.ok(payloads[0].messages.some(message => message.reasoning_content === reasoning));
  assert.ok(payloads[1].messages.every(message => !('reasoning_content' in message)));
  assert.equal(JSON.stringify(payloads[1]).includes(reasoning), false);
  const assistant = payloads[1].messages.find(message => message.role === 'assistant')!;
  assert.equal(assistant.content, 'Check the landing.');
  assert.deepEqual((assistant.tool_calls as { id: string }[]).map(call => call.id), ['inspect-canonical', 'look-canonical']);
  assert.deepEqual(payloads[1].messages.filter(message => message.role === 'tool').map(message => message.tool_call_id), ['inspect-canonical', 'look-canonical']);
});
