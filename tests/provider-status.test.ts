import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { InferenceClient, type ProviderConfig, type ProviderRequestStatus } from '../server/inference/providers';
import type { CompletionRequest } from '../vendor/littlewhale';
import { AgentRuntime } from '../server/agents/runtime';
import { AgentBridge } from '../server/simulation/agent-bridge';
import { Store } from '../server/store';
import { Engine } from '../src/core/engine';
import { island } from '../src/universes/first-shore';
import { RequestQueue } from '../server/inference/request-queue';

const provider = (id = 'model'): ProviderConfig => ({ id, name: 'Readable model name', type: 'openai-compatible', baseUrl: `http://${id}.invalid/v1`, model: 'technical-model-id', apiKey: 'provider-secret' });
const request: CompletionRequest = { system: 'Entity.', messages: [{ role: 'user', content: 'Begin.' }], tools: [], maxTokens: 100, purpose: 'agent' };
const until = async (condition: () => boolean) => {
  for (let index = 0; index < 500 && !condition(); index++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(condition(), 'Expected provider status transition.');
};
function successfulResponse() {
  const delta = { id: 'response', object: 'chat.completion.chunk', created: 0, model: 'technical-model-id', choices: [{ index: 0, delta: { role: 'assistant', content: 'Ready.' }, finish_reason: null }] };
  const ending = { id: 'response', object: 'chat.completion.chunk', created: 0, model: 'technical-model-id', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } };
  return new Response(`data: ${JSON.stringify(delta)}\n\ndata: ${JSON.stringify(ending)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}

test('background compaction never occupies the serial decision queue and retains reasoning-only truncation usage', async t => {
  const pending: ((response: Response) => void)[] = [];
  const payloads: { max_tokens?: number; max_completion_tokens?: number }[] = [];
  t.mock.method(globalThis, 'fetch', (_input: unknown, init?: RequestInit) => {
    payloads.push(JSON.parse(String(init?.body)));
    return new Promise<Response>(resolve => pending.push(resolve));
  });
  const client = new InferenceClient([provider()], undefined, new RequestQueue(false));
  const background = client.complete({ ...request, purpose: 'memory', maxTokens: 8192 }, new AbortController().signal);
  await until(() => pending.length === 1);
  const foreground = client.complete(request, new AbortController().signal);
  await until(() => pending.length === 2);
  pending[1](successfulResponse());
  assert.equal((await foreground).content, 'Ready.');
  assert.equal(client.statuses().model.inFlight, 1);
  const end = { id: 'limited', object: 'chat.completion.chunk', created: 0, model: 'technical-model-id',
    choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Only reasoning.' }, finish_reason: 'length' }],
    usage: { prompt_tokens: 1000, completion_tokens: 8192, total_tokens: 9192 } };
  pending[0](new Response(`data: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } }));
  const result = await background;
  assert.equal(result.finishReason, 'length');
  assert.equal(result.content, null);
  assert.equal(result.usage?.outputTokens, 8192);
  assert.equal(payloads[0].max_tokens ?? payloads[0].max_completion_tokens, 8192);
});

test('provider status counts concurrent requests and observer failures cannot change their results', async t => {
  const pending: ((response: Response) => void)[] = [];
  t.mock.method(globalThis, 'fetch', () => new Promise<Response>(resolve => pending.push(resolve)));
  const snapshots: Record<string, ProviderRequestStatus>[] = [];
  let client: InferenceClient;
  client = new InferenceClient([provider()], () => { snapshots.push(client.statuses()); throw new Error('Observer disconnected.'); });
  const initial = client.statuses();
  assert.deepEqual(initial.model, { state: 'unknown', inFlight: 0 });
  initial.model.state = 'bad'; assert.equal(client.statuses().model.state, 'unknown');
  const first = client.complete(request, new AbortController().signal);
  const second = client.complete(request, new AbortController().signal);
  assert.equal(client.statuses().model.inFlight, 2);
  await until(() => pending.length === 2);
  pending[0](successfulResponse());
  await until(() => client.statuses().model.inFlight === 1);
  assert.equal(client.statuses().model.state, 'ok');
  pending[1](successfulResponse());
  assert.ok((await Promise.all([first, second])).every(answer => answer.content === 'Ready.'));
  assert.deepEqual(client.statuses().model, { state: 'ok', inFlight: 0, detail: 'Request completed.' });
  assert.ok(snapshots.some(snapshot => snapshot.model.inFlight === 2));
  assert.equal(JSON.stringify(snapshots).includes('provider-secret'), false);
});

test('fallback status identifies the actual failed and successful routes with credentials redacted', async t => {
  t.mock.method(globalThis, 'fetch', async (input: unknown) => String(input).includes('first.invalid')
    ? Response.json({ error: { message: 'HTTP failure: first-secret gateway-secret header-secret' } }, { status: 503 })
    : successfulResponse());
  const client = new InferenceClient([
    { ...provider('first'), type: 'vast-ai', apiKey: 'first-secret', vastToken: 'gateway-secret', vastContainerLabel: 'C.123', headers: { 'X-Token': 'header-secret' } },
    provider('second'),
    { ...provider('disabled'), enabled: false },
  ]);
  const answer = await client.complete(request, new AbortController().signal);
  assert.equal(answer.provider, 'second');
  const statuses = client.statuses();
  assert.equal(statuses.first.state, 'bad'); assert.equal(statuses.first.inFlight, 0);
  assert.equal(statuses.second.state, 'ok'); assert.equal(statuses.second.inFlight, 0);
  assert.deepEqual(statuses.disabled, { state: 'unknown', inFlight: 0 });
  assert.match(statuses.first.detail!, /\[redacted\]/);
  for (const secret of ['first-secret', 'gateway-secret', 'header-secret', 'provider-secret']) assert.equal(JSON.stringify(statuses).includes(secret), false);
});

test('failed inference audits retain the provider error with credentials redacted', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { message: 'Tunnel unavailable: provider-secret' } }, { status: 530 }));
  const engine = new Engine({ ...island, generate: () => ({ blocks: [], entities: [
    { id: 'a', name: 'A', kind: 'troglodyte', controller: 'agent', position: [.5, 1, .5], yaw: 0, height: 2, color: '#fff', inventory: null, status: 'idle' },
  ] }) });
  const store = new Store(':memory:', engine.module.manifest), bridge = new AgentBridge(engine);
  const runtime = new AgentRuntime(bridge, store, [provider()], undefined, { changed() {}, fatal(error) { throw error; } });
  try {
    runtime.resume();
    await until(() => runtime.agents.get('a')?.state === 'retrying');
    const row = store.db.prepare('SELECT status, response FROM inference_audit').get() as { status: string; response: Uint8Array };
    assert.equal(row.status, 'failed');
    const recorded = inflateSync(row.response).toString();
    assert.match(recorded, /530/);
    assert.match(recorded, /Tunnel unavailable/);
    assert.match(recorded, /\[redacted\]/);
    assert.equal(recorded.includes('provider-secret'), false);
    assert.equal(engine.tick, 0);
  } finally {
    runtime.close();
    await until(() => !runtime.agents.get('a')?.job);
    store.close();
  }
});

test('cancellation clears in-flight status while preserving the last completed health', async t => {
  let hold = false, entered = false;
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => {
    if (!hold) return successfulResponse();
    entered = true;
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const abort = () => reject(new DOMException('Aborted', 'AbortError'));
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    });
  });
  const client = new InferenceClient([provider()]);
  await client.complete(request, new AbortController().signal);
  hold = true;
  const controller = new AbortController();
  const completion = client.complete(request, controller.signal);
  await until(() => entered);
  assert.equal(client.statuses().model.inFlight, 1);
  controller.abort(new Error('World paused.'));
  await assert.rejects(completion, /paused|abort/i);
  assert.deepEqual(client.statuses().model, { state: 'ok', inFlight: 0, detail: 'Request completed.' });
});

test('provider notifications use the observer hook without touching the decision-barrier hook', async t => {
  t.mock.method(globalThis, 'fetch', async () => successfulResponse());
  const engine = new Engine({ ...island, generate: () => ({ blocks: [], entities: [] }) });
  const store = new Store(':memory:', engine.module.manifest), bridge = new AgentBridge(engine);
  let barriers = 0, observations = 0;
  const runtime = new AgentRuntime(bridge, store, [provider()], undefined, { changed() { barriers++; }, inferenceChanged() { observations++; }, fatal(error) { throw error; } });
  try {
    await runtime.inference.complete(request, new AbortController().signal);
    assert.equal(barriers, 0); assert.ok(observations > 0); assert.equal(engine.tick, 0);
    runtime.configure([provider()]);
    const afterConfiguration = barriers;
    await runtime.inference.complete(request, new AbortController().signal);
    assert.equal(barriers, afterConfiguration); assert.ok(observations > 3);
  } finally { runtime.close(); store.close(); }
});
