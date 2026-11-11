import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { RuntimeState } from '../server/runtime-state';

test('runtime state survives process restarts without changing stopped defaults', async () => {
  const root = resolve('.tmp'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'runtime-state-'));
  try {
    const initial = await RuntimeState.open(directory, ['first-shore', 'robots-vs-robots']);
    assert.equal(initial.isRunning('first-shore'), false);
    assert.equal(initial.isRunning('robots-vs-robots'), false);

    await initial.setRunning('first-shore', true);
    let reopened = await RuntimeState.open(directory, ['first-shore', 'robots-vs-robots']);
    assert.equal(reopened.isRunning('first-shore'), true);
    assert.equal(reopened.isRunning('robots-vs-robots'), false);

    await Promise.all([reopened.setRunning('first-shore', false), reopened.setRunning('first-shore', true), reopened.setRunning('first-shore', false)]);
    reopened = await RuntimeState.open(directory, ['first-shore', 'robots-vs-robots']);
    assert.equal(reopened.isRunning('first-shore'), false);
  } finally {
    assert.ok(resolve(directory).startsWith(root + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});
