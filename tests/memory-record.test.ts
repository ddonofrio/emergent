import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentMemory, memoryBytes, MEMORY_COMPACTION_BYTES, type MemoryCompactionEvent, type MemorySnapshot } from '../server/agents/memory-record';
import type { AgentMemoryRecord } from '../src/core/types';
import type { Completion, CompletionRequest } from '../vendor/littlewhale';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const large = (): AgentMemoryRecord => ({ intent: { goal: 'Explore.', successCondition: 'Find water.', status: 'active' }, notes: Array.from({ length: 10 }, (_, i) => `${i} ${'old detail '.repeat(43)}`), learned: ['Confirmed fact.'] });
const small = (): AgentMemoryRecord => ({ ...large(), notes: ['Keep the durable finding.'] });
const answer = (record: AgentMemoryRecord): Completion => ({ content: JSON.stringify(record), calls: [], provider: 'fixture', model: 'fixture', latencyMs: 1, finishReason: 'stop' });
function fixture(snapshot?: MemorySnapshot) {
  const requests: { request: CompletionRequest; signal: AbortSignal; resolve(value: Completion): void; reject(error: Error): void }[] = [];
  const events: MemoryCompactionEvent[] = [], published: AgentMemoryRecord[] = [], failures: unknown[] = [];
  const memory = new AgentMemory(large(), ['Confirmed fact.'], snapshot, {
    sessionId: 'agent', context: () => ({ system: 'Agent instructions.', tools: [{ name: 'remember' }], messages: [{ role: 'user', content: 'Current observation and recent actions.' }] }),
    complete: (request, signal) => new Promise((resolve, reject) => requests.push({ request, signal, resolve, reject })),
    save() {}, publish: record => published.push(record), event: event => events.push(event), fatal: error => failures.push(error),
  });
  return { memory, requests, events, published, failures };
}

test('writes cancel and replace background work immediately; late old responses cannot overwrite the new revision', async () => {
  const f = fixture();
  f.memory.resume();
  assert.ok(memoryBytes(large()) >= MEMORY_COMPACTION_BYTES);
  assert.equal(f.requests.length, 1);
  const context = JSON.parse(f.requests[0].request.messages[0].content!);
  assert.equal(context.context.system, 'Agent instructions.');
  assert.deepEqual(context.record, f.memory.record);
  f.memory.write({ notes: large().notes.map(note => `${note}!`) });
  assert.equal(f.requests[0].signal.aborted, true);
  assert.equal(f.requests.length, 2);
  const newRecord = f.memory.record;
  f.requests[0].resolve(answer(small())); await tick();
  assert.deepEqual(f.memory.record, newRecord);
  assert.equal(f.memory.compacting, true);
  f.requests[1].resolve(answer(small())); await tick();
  assert.deepEqual(f.memory.record, small());
  assert.equal(f.memory.compacting, false);
  assert.ok(f.events.some(event => event.outcome === 'cancelled'));
  assert.ok(f.events.some(event => event.outcome === 'accepted'));
  assert.deepEqual(f.failures, []);
  f.memory.close();
});

test('failures, truncation, malformed records and non-smaller output wait for a new insertion, including after restart', async t => {
  for (const kind of ['failed', 'length', 'malformed', 'larger', 'equal', 'changed-status'] as const) await t.test(kind, async () => {
    const f = fixture(); f.memory.resume();
    const original = f.memory.record;
    if (kind === 'failed') f.requests[0].reject(new Error('Offline'));
    else {
      const response = answer(kind === 'larger' ? { ...large(), learned: ['Confirmed fact.', 'Extra text.'] } : kind === 'equal' ? large() : small());
      if (kind === 'length') response.finishReason = 'length';
      if (kind === 'malformed') response.content = '{';
      if (kind === 'changed-status') response.content = JSON.stringify({ ...small(), intent: { ...small().intent, status: 'completed' } });
      f.requests[0].resolve(response);
    }
    await tick(); f.memory.resume(); await tick();
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.memory.record, original);
    const restored = fixture(f.memory.snapshot()); restored.memory.resume();
    assert.equal(restored.requests.length, 0);
    restored.memory.write({ notes: original.notes });
    assert.equal(restored.requests.length, 1);
    f.memory.close(); restored.memory.close();
  });
});

test('accepted compaction does not trigger itself and newly discovered facts survive restart without restoring removed text', async () => {
  const f = fixture(); f.memory.resume();
  const condensed = { ...large(), notes: large().notes.map(note => note.slice(0, 420)) };
  assert.ok(memoryBytes(condensed) >= MEMORY_COMPACTION_BYTES);
  f.requests[0].resolve(answer(condensed)); await tick(); f.memory.resume();
  assert.equal(f.requests.length, 1);
  const restored = fixture(f.memory.snapshot()); restored.memory.discover(['Confirmed fact.']); restored.memory.resume();
  assert.deepEqual(restored.memory.record, condensed);
  assert.equal(restored.requests.length, 0);
  restored.memory.discover(['Confirmed fact.', 'New discovery.']);
  assert.equal(restored.requests.length, 1);
  assert.deepEqual(restored.memory.record.learned, ['Confirmed fact.', 'New discovery.']);
  restored.memory.pause();
  assert.equal(restored.requests[0].signal.aborted, true);
  restored.requests[0].resolve(answer(small())); await tick();
  assert.deepEqual(restored.memory.record.learned, ['Confirmed fact.', 'New discovery.']);
  f.memory.close(); restored.memory.close();
});

test('a write below the threshold cancels obsolete work without launching unnecessary compaction', async () => {
  const f = fixture(); f.memory.resume();
  f.memory.write({ notes: ['A fresh short note.'] });
  assert.equal(f.requests[0].signal.aborted, true);
  assert.equal(f.requests.length, 1);
  assert.equal(f.memory.compacting, false);
  f.requests[0].resolve(answer(small())); await tick();
  assert.deepEqual(f.memory.record.notes, ['A fresh short note.']);
  f.memory.close();
});
