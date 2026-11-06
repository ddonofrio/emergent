import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PersistentSession, balancedCuts, validateArguments, type Completion, type CompletionRequest, type SessionSnapshot, type ToolCall } from '../vendor/littlewhale';
import { InferenceClient, publicProviders, validateProviders, discoverModels, type ProviderConfig } from '../server/inference/providers';

const response = (calls: ToolCall[], content: string | null = null): Completion => ({
  calls, content, provider: 'fixture', model: 'fixture', latencyMs: 5,
  usage: { inputTokens: 7, outputTokens: 2, totalTokens: 9 },
});
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const wait = (signal: AbortSignal) => new Promise<unknown>((_resolve, reject) => {
  signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

test('one persistent conversation waits for tool completion and retains every ordered result', async () => {
  const session = new PersistentSession('entity-1');
  session.appendUser('Local initial observation.');
  const abort = new AbortController();
  const requests: CompletionRequest[] = [];
  let release!: (value: unknown) => void;
  const called = deferred();
  const run = session.run({
    system: 'One entity.', schemas: [], signal: abort.signal,
    complete: async request => {
      requests.push(structuredClone(request));
      if (requests.length === 1) return response([
        { id: 'repeated-wire-id', name: 'walk_to', arguments: { x: 10, y: 0 } },
        { id: 'second', name: 'speak', arguments: { message: 'Hello' } },
      ]);
      called.resolve();
      return response([{ id: 'repeated-wire-id', name: 'wait_for_event', arguments: {} }]);
    },
    tools: {
      walk_to: async () => new Promise(resolve => { release = resolve; }),
      speak: async () => ({ spoken: true }),
      wait_for_event: async (_args, _call, signal) => wait(signal),
    },
  });
  await turn();
  assert.equal(requests.length, 1);
  assert.equal(session.snapshot().pendingCalls[1].result?.content, '{"spoken":true}');
  await turn();
  assert.equal(requests.length, 1, 'No inference while walking without an event.');
  release({ movement: 'running', heard: ['First', 'Second'] });
  await called.promise;
  await turn();
  assert.deepEqual(requests[1].messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content!)), [
    { movement: 'running', heard: ['First', 'Second'] }, { spoken: true },
  ]);
  const snapshot = session.snapshot();
  assert.equal(snapshot.contextPressure?.inputTokens, 7);
  const oldCall = snapshot.messages.find(message => message.toolCalls)?.toolCalls?.[0].id;
  assert.notEqual(snapshot.pendingCalls[0].call.id, oldCall, 'Wire ID reuse must not reuse a physical receipt.');
  abort.abort(new Error('Pause'));
  await assert.rejects(run, /Pause/);
  assert.equal(session.metrics.llmCalls, 2);
  assert.equal(session.metrics.inputTokens, 14);
});

test('resume rebinds pending tools by their persisted call IDs without another model call', async () => {
  const session = new PersistentSession('resume');
  session.appendUser('Start.');
  const paused = new AbortController();
  let saved: SessionSnapshot | undefined;
  let firstId = '';
  const entered = deferred();
  const running = session.run({
    system: 'Entity.', schemas: [], signal: paused.signal, persist: snapshot => { saved = snapshot; },
    complete: async () => response([{ id: 'wire', name: 'walk_to', arguments: {} }]),
    tools: { walk_to: async (_args, call, signal) => { firstId = call.id; entered.resolve(); return wait(signal); } },
  });
  await entered.promise;
  paused.abort(new Error('Pause'));
  await assert.rejects(running, /Pause/);
  const resumed = new PersistentSession('resume', saved);
  const stop = new AbortController();
  let modelCalls = 0;
  const restarted = deferred();
  const resumedRun = resumed.run({
    system: 'Entity.', schemas: [], signal: stop.signal,
    complete: async () => { modelCalls++; throw new Error('Should still be walking.'); },
    tools: { walk_to: async (_args, call, signal) => { assert.equal(call.id, firstId); restarted.resolve(); return wait(signal); } },
  });
  await restarted.promise;
  assert.equal(modelCalls, 0);
  stop.abort(new Error('Done'));
  await assert.rejects(resumedRun, /Done/);
});

test('balanced cuts track every parallel tool result', () => {
  const messages = [
    { role: 'user' as const, content: 'Old observation '.repeat(200) },
    { role: 'assistant' as const, content: null, toolCalls: [{ id: 'a', name: 'walk_to', arguments: {} }, { id: 'b', name: 'speak', arguments: {} }] },
    { role: 'tool' as const, content: '{}', toolCallId: 'a' },
    { role: 'tool' as const, content: '{}', toolCallId: 'b' },
    { role: 'user' as const, content: 'Tail' },
  ];
  assert.deepEqual(balancedCuts(messages), [true, true, false, false, true, true]);
});

test('unavailable inference retries the same retained conversation without invented actions', async () => {
  const session = new PersistentSession('retry');
  session.appendUser('Local facts.');
  const abort = new AbortController();
  const requests: CompletionRequest[] = [];
  const entered = deferred();
  const run = session.run({
    system: 'Embodied agent.', schemas: [], signal: abort.signal, retryDelayMs: 1,
    complete: async request => {
      requests.push(structuredClone(request));
      if (requests.length < 3) throw new Error('Disconnected');
      return response([{ id: 'wire', name: 'wait_for_event', arguments: {} }]);
    },
    tools: { wait_for_event: async (_args, _call, signal) => { entered.resolve(); return wait(signal); } },
  });
  await entered.promise;
  assert.deepEqual(requests[0], requests[1]);
  assert.deepEqual(requests[1], requests[2]);
  assert.equal(session.metrics.retries, 2);
  assert.equal(session.metrics.llmCalls, 3);
  abort.abort(new Error('Done'));
  await assert.rejects(run, /Done/);
});

test('LittleWhale schema validation refuses malformed action arguments without coercion', () => {
  const schema = { name: 'walk_to', description: '', parameters: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'], additionalProperties: false } };
  validateArguments(schema, { x: 2 });
  assert.throws(() => validateArguments(schema, { x: '2' }), /number/);
  assert.throws(() => validateArguments(schema, { x: 2, hidden: true }), /additional/);
  assert.throws(() => validateArguments({ ...schema, parameters: { type: 'object', properties: { notes: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 3 } } }, additionalProperties: false } }, { notes: Array(11).fill('abc') }), /10/);
  assert.throws(() => validateArguments({ ...schema, parameters: { type: 'object', properties: { x: { type: 'number', exclusiveMinimum: 0 } } } }, { x: 0 }), /> 0/);
});

test('pi-ai generation preserves canonical tool result IDs, usage and server-only credentials', async () => {
  const originalFetch = globalThis.fetch;
  const payloads: Record<string, unknown>[] = [];
  globalThis.fetch = async (_input, init) => {
    payloads.push(JSON.parse(String(init?.body)));
    const chunk = { id: 'wire-response', object: 'chat.completion.chunk', created: 0, model: 'local', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'wire', type: 'function', function: { name: 'wait_for_event', arguments: '{}' } }] }, finish_reason: null }] };
    const ending = { id: 'wire-response', object: 'chat.completion.chunk', created: 0, model: 'local', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(ending)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const config: ProviderConfig = { id: 'local', type: 'openai-compatible', name: 'Local', baseUrl: 'http://local.invalid/v1', model: 'local', apiKey: 'secret-key' };
    const client = new InferenceClient([config]);
    const initial: CompletionRequest = { system: 'Entity.', messages: [{ role: 'user', content: 'Begin.' }], tools: [{ name: 'wait_for_event', description: 'Wait.', parameters: { type: 'object', properties: {}, additionalProperties: false } }], maxTokens: 100, purpose: 'agent' };
    const answer = await client.complete(initial, new AbortController().signal);
    assert.equal(answer.usage?.inputTokens, 11);
    const canonical = { ...answer.calls[0], id: 'canonical-action' };
    await client.complete({ ...initial, messages: [
      ...initial.messages, { role: 'assistant', content: answer.content, toolCalls: [canonical], providerState: answer.providerState },
      { role: 'tool', toolCallId: canonical.id, toolName: canonical.name, content: '{"arrived":true}' },
    ] }, new AbortController().signal);
    const history = payloads[1].messages as { role: string; tool_calls?: { id: string }[]; tool_call_id?: string }[];
    assert.equal(history.find(message => message.role === 'assistant')?.tool_calls?.[0].id, canonical.id);
    assert.equal(history.find(message => message.role === 'tool')?.tool_call_id, canonical.id);
    assert.equal(JSON.stringify(answer).includes('secret-key'), false);
    assert.equal(JSON.stringify(publicProviders([{ ...config, headers: { authorization: 'header-secret' } }])).includes('header-secret'), false);
  } finally { globalThis.fetch = originalFetch; }
});

test('model discovery uses the configured endpoint and retains advertised capacities', async () => {
  const originalFetch = globalThis.fetch;
  let endpoint = '';
  globalThis.fetch = async (input, init) => { endpoint = String(input); assert.equal(new Headers(init?.headers).has('authorization'), false); return Response.json({ data: [{ id: 'local', context_length: 8192, max_output_tokens: 1024 }] }); };
  try {
    const [config] = validateProviders([{ id: 'p', type: 'openai-compatible', name: 'Local', baseUrl: 'http://local.invalid/deployment/v1/', model: 'local', apiKey: '', tokenless: true, maxOutputTokens: 40960 }]);
    assert.deepEqual(await discoverModels(config), [{ id: 'local', label: 'local', contextWindow: 8192 }]);
    assert.equal(Object.hasOwn(config, 'maxOutputTokens'), false, 'Legacy output caps must not survive provider validation.');
    assert.equal(new InferenceClient([config]).maxTokens, 4096, 'The adapter owns its output default.');
    assert.equal(endpoint, 'http://local.invalid/deployment/v1/models');
  } finally { globalThis.fetch = originalFetch; }
});

test('Bedrock pi-ai dispatch receives the configured region and bearer token', async () => {
  const piRequire = createRequire(import.meta.resolve('@earendil-works/pi-ai'));
  const sdk = piRequire('@aws-sdk/client-bedrock-runtime') as typeof import('@aws-sdk/client-bedrock-runtime');
  const prototype = sdk.BedrockRuntimeClient.prototype as unknown as { send: (command: unknown) => Promise<unknown> };
  const originalSend = prototype.send;
  let region = '';
  let token = '';
  let model = '';
  prototype.send = async function(this: { config: { region: () => Promise<string>; token: () => Promise<{ token: string }> } }, command) {
    region = await this.config.region();
    token = (await this.config.token()).token;
    model = (command as { input: { modelId: string } }).input.modelId;
    return {
      $metadata: { httpStatusCode: 200 },
      stream: (async function* () {
        yield { messageStart: { role: 'assistant' } };
        yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Ready.' } } };
        yield { contentBlockStop: { contentBlockIndex: 0 } };
        yield { messageStop: { stopReason: 'end_turn' } };
        yield { metadata: { usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } } };
      })(),
    };
  } as typeof prototype.send;
  try {
    const client = new InferenceClient([{ id: 'bedrock-test', type: 'amazon-bedrock', name: 'Bedrock', baseUrl: '', model: 'amazon.nova-test-v1:0', region: 'eu-west-1', apiKey: 'bedrock-test-token' }]);
    const completion = await client.complete({ system: 'Entity.', messages: [{ role: 'user', content: 'Begin.' }], tools: [], maxTokens: 100, purpose: 'agent' }, new AbortController().signal);
    assert.equal(completion.content, 'Ready.');
    assert.equal(region, 'eu-west-1');
    assert.equal(token, 'bedrock-test-token');
    assert.equal(model, 'amazon.nova-test-v1:0');
    assert.equal(JSON.stringify(completion).includes('bedrock-test-token'), false);
  } finally { prototype.send = originalSend; }
});
