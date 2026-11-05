import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { DEFAULT_DATA_DIRECTORY, resolveDataDirectory } from '../server/config';
import { runStartupCheck } from '../scripts/check-startup';

test('unset or empty data configuration selects the normal data directory', () => {
  const root = resolve('.tmp', 'startup-path-fixture');
  assert.equal(resolveDataDirectory(undefined, root), resolve(root, DEFAULT_DATA_DIRECTORY));
  assert.equal(resolveDataDirectory('', root), resolve(root, DEFAULT_DATA_DIRECTORY));
  assert.equal(resolveDataDirectory('  ', root), resolve(root, DEFAULT_DATA_DIRECTORY));
  assert.equal(resolveDataDirectory(undefined, root), resolve(root, 'data'));
  assert.equal(resolveDataDirectory('custom-worlds', root), resolve(root, 'custom-worlds'));
  assert.equal(resolveDataDirectory(resolve(root, 'explicit-worlds'), root), resolve(root, 'explicit-worlds'));
});

test('the actual entrypoint boots fresh worlds for both universes without .env or opening a port', async () => {
  const report = await runStartupCheck();
  assert.deepEqual(report.universes.map(universe => universe.id).sort(), ['first-shore', 'robots-vs-robots']);
  assert.ok(report.universes.every(universe => universe.tick === 0 && !universe.running));
  assert.equal(report.serverStarted, false);
});
