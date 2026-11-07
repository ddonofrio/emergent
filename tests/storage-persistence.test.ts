import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { deflateSync, inflateSync } from 'node:zlib';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { Store } from '../server/store';
import { INFERENCE_AUDIT_LIMIT } from '../server/inference/audit';
import { PersistentSession, type CompletionRequest } from '../vendor/littlewhale';
import { Engine } from '../src/core/engine';
import { island } from '../src/universes/first-shore';
import type { RuntimeSnapshot } from '../server/agents/runtime';

const pack = (value: unknown) => deflateSync(JSON.stringify(value));
const unpack = (value: Uint8Array) => JSON.parse(inflateSync(value).toString());
const request: CompletionRequest = { system: 'Private instructions.', messages: [{ role: 'user', content: 'Large private observation. '.repeat(1000) }],
  tools: [{ name: 'wait_for_event', description: 'Wait.', parameters: {} }], maxTokens: 4096, purpose: 'agent', sessionId: 'a' };

test('inference diagnostics omit conversations and reasoning, stay bounded, and retain in-flight requests', () => {
  const store = new Store(':memory:', island.manifest);
  try {
    const pending = store.beginInference(0, 'a', 'agent', 'compact-v1', request);
    for (let index = 0; index < INFERENCE_AUDIT_LIMIT + 40; index++) {
      const id = store.beginInference(index, 'a', 'agent', 'compact-v1', request);
      store.finishInference(id, { content: 'Verbose answer. '.repeat(1000), providerState: { reasoning: 'Private reasoning' },
        calls: [{ id: 'wire', name: 'wait_for_event', arguments: { seconds: 1 } }], usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
        timing: { startedAt: '2026-11-07T09:04:12Z', durationMs: 4000 } }, 'completed');
    }
    const rows = store.db.prepare('SELECT status, request, response FROM inference_audit').all() as { status: string; request: Uint8Array; response: Uint8Array | null }[];
    assert.equal(rows.length, INFERENCE_AUDIT_LIMIT + 1);
    assert.equal(rows.filter(row => row.status === 'pending').length, 1);
    const recorded = JSON.stringify(rows.map(row => [unpack(row.request), row.response && unpack(row.response)]));
    for (const text of ['Private instructions', 'Large private observation', 'Verbose answer', 'Private reasoning']) assert.equal(recorded.includes(text), false);
    assert.deepEqual(unpack(rows.at(-1)!.response!).usage, { inputTokens: 12, outputTokens: 3, totalTokens: 15 });
    store.finishInference(pending, { message: 'Disconnected' }, 'failed');
    assert.equal((store.db.prepare('SELECT COUNT(*) AS count FROM inference_audit').get() as { count: number }).count, INFERENCE_AUDIT_LIMIT);
  } finally { store.close(); }
});

test('legacy storage migrates without losing pending calls, world history or historical token metrics', () => {
  const root = resolve('.tmp'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'storage-migration-')), path = join(directory, 'world.sqlite');
  const engine = new Engine({ ...island, generate: () => ({ blocks: [], entities: [] }) });
  const before = engine.state();
  let store: Store | undefined;
  try {
    store = new Store(path, island.manifest); store.record(engine.frame(), before); store.close(); store = undefined;
    const session = new PersistentSession('a').snapshot();
    session.pendingCalls = [{ call: { id: 'keep-this-call', name: 'wait_for_event', arguments: { seconds: 5 } } }];
    session.messages = [{ role: 'assistant', content: null, toolCalls: session.pendingCalls.map(pending => pending.call) }];
    const legacy = { version: 1, agents: { a: { session: { ...session, events: Array.from({ length: 1000 }, (_, seq) => ({ seq, data: 'Retired reasoning log. '.repeat(20) })) }, notes: ['Keep this note.'] } },
      simulation: { entities: { a: { requests: [{ callId: 'keep-this-call', untilTick: 100 }], receipts: {}, actions: [], events: [], seen: [], sequence: 0 } } } };
    const db = new DatabaseSync(path);
    try {
      db.exec('CREATE TABLE agent_runtime (id INTEGER PRIMARY KEY, data BLOB NOT NULL)');
      db.prepare('INSERT INTO agent_runtime VALUES (1, ?)').run(pack(legacy));
      db.prepare('DELETE FROM meta WHERE key = ?').run('compact-inference-audit');
      const insert = db.prepare('INSERT INTO inference_audit (tick,actor,phase,version,request,response,status) VALUES (?,?,?,?,?,?,?)');
      for (let index = 0; index < INFERENCE_AUDIT_LIMIT + 10; index++) insert.run(0, 'a', 'agent', 'recent-context-v1', pack(request),
        pack({ content: 'Repeated response.', providerState: { reasoning: 'Unused' }, usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } }), 'completed');
    } finally { db.close(); }
    store = new Store(path, island.manifest);
    const restored = store.loadAgentState<RuntimeSnapshot>()!;
    assert.deepEqual(restored.simulation, legacy.simulation);
    assert.deepEqual(restored.agents.a.session.pendingCalls, session.pendingCalls);
    assert.deepEqual(restored.agents.a.notes, ['Keep this note.']);
    assert.equal(Object.hasOwn(restored.agents.a.session, 'events'), false);
    assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'agent_runtime'").get(), undefined);
    assert.deepEqual(store.stateAt(0), before);
    assert.deepEqual(store.metricsAt(0), { a: { inputTokens: (INFERENCE_AUDIT_LIMIT + 10) * 12, outputTokens: (INFERENCE_AUDIT_LIMIT + 10) * 3, cachedInputTokens: 0 } });
    store.close(); store = new Store(path, island.manifest);
    assert.deepEqual(store.loadAgentState<RuntimeSnapshot>(), restored);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS count FROM inference_audit').get() as { count: number }).count, INFERENCE_AUDIT_LIMIT);
  } finally {
    store?.close();
    assert.ok(resolve(directory).startsWith(root + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('frame, receipt and changed memory writes roll back together if a session write fails', t => {
  const store = new Store(':memory:', island.manifest);
  const engine = new Engine({ ...island, generate: () => ({ blocks: [], entities: [] }) });
  const original = { simulation: { receipt: 'old' }, agents: { a: { notes: ['Original'] } } };
  try {
    store.record(engine.frame(), engine.state(), original);
    const failure = t.mock.method(store, 'saveAgentSession', () => { throw new Error('Disk write failed'); });
    engine.step();
    assert.throws(() => store.record(engine.frame(), undefined, { simulation: { receipt: 'new' }, agents: { a: { notes: ['Changed'] } } }), /Disk write failed/);
    failure.mock.restore();
    assert.equal(store.latestTick(), 0);
    assert.deepEqual(store.loadAgentState(), { version: 1, ...original });
  } finally { store.close(); }
});
