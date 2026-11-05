import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { UniverseRuntime } from '../server/universe-runtime';
import { island } from '../src/universes/first-shore';
import type { UniverseModule } from '../src/core/types';

const module: UniverseModule = { ...island, generate: () => ({ blocks: [[0, 0, 0, 'stone']], entities: [
  { id: 'a', name: 'A', kind: 'troglodyte', controller: 'agent', position: [.5, 1, .5], yaw: 0, height: 2, color: '#fff', inventory: null, status: 'idle' },
] }) };
const until = async (predicate: () => boolean) => {
  for (let index = 0; index < 400 && !predicate(); index++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(predicate());
};

test('an authoritative write failure inside a tool stops the loop without fabricating a tool result', async t => {
  const temporaryRoot = resolve('.tmp'); mkdirSync(temporaryRoot, { recursive: true });
  const directory = mkdtempSync(join(temporaryRoot, 'agent-storage-test-'));
  const failures: unknown[] = [];
  const runtime = new UniverseRuntime(module, directory, { providers: [{ id: 'mock', type: 'openai-compatible', name: 'Mock', baseUrl: 'http://unused.invalid', model: 'mock', apiKey: '' }], fatal(error) { failures.push(error); } });
  let calls = 0;
  runtime.agents.inference.complete = async () => {
    calls++;
    return { content: null, calls: [{ id: 'remember', name: 'remember', arguments: { notes: ['The floor is stone.'] } }], provider: 'mock', model: 'mock', latencyMs: 0 };
  };
  const failedWrite = t.mock.method(runtime.store, 'record', () => { throw new Error('Simulated recording failure.'); });
  try {
    runtime.setRunning(true);
    await until(() => failures.length === 1 && [...runtime.agents.agents.values()].every(agent => !agent.job));
    assert.equal(calls, 1); assert.equal(runtime.engine.tick, 0);
    const session = runtime.agents.persistence().agents.a.session;
    assert.equal(session.messages.some(message => message.role === 'tool'), false);
    assert.equal(session.pendingCalls.length, 1);
    runtime.pump(); assert.equal(runtime.engine.tick, 0); assert.equal(calls, 1);
    failedWrite.mock.restore();
    runtime.close();
  } finally {
    failedWrite.mock.restore();
    // This disposable recording is confined to the test's workspace directory.
    assert.ok(resolve(directory).startsWith(temporaryRoot + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});
