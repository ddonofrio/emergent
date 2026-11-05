import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { inflateSync } from 'node:zlib';
import { DEFAULT_DATA_DIRECTORY } from '../server/config';
import { CLOCK_VERSION } from '../src/core/time';
import { universeCatalog } from '../src/universes';

interface StartupUniverse { id: string; tick: number; running: boolean; }
export interface StartupCheckReport {
  universes: StartupUniverse[];
  serverStarted: false;
}

/** Exercise the actual entrypoint with no .env and fresh disposable recordings. */
export async function runStartupCheck(): Promise<StartupCheckReport> {
  const workspace = fileURLToPath(new URL('../', import.meta.url));
  const temporaryRoot = resolve(workspace, '.tmp');
  mkdirSync(temporaryRoot, { recursive: true });
  const directory = mkdtempSync(join(temporaryRoot, 'startup-check-'));
  const ids = universeCatalog.filter(universe => universe.available).map(universe => universe.id);
  try {
    // Prevent this check from opening any server port even if startup regresses.
    const guardPath = join(directory, 'no-listen.mjs');
    writeFileSync(guardPath, "import { Server } from 'node:net';\nServer.prototype.listen = function () { throw new Error('Startup check attempted to open a server port.'); };\n");
    const require = createRequire(import.meta.url);
    const environment: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(DATA_DIR|NODE_OPTIONS|EMERGENT_LLM_.*|OPENAI_.*|OPENROUTER_.*|LOCAL_LLM_.*|LLM_.*)$/i.test(key)));
    environment.PORT = '3000';
    environment.TSX_TSCONFIG_PATH = join(workspace, 'tsconfig.json');
    const { stdout } = await promisify(execFile)(process.execPath, [
      '--env-file-if-exists=.env', '--import', pathToFileURL(guardPath).href,
      '--import', pathToFileURL(require.resolve('tsx/esm')).href,
      join(workspace, 'server/index.ts'), '--check-startup',
    ], { cwd: directory, env: environment, timeout: 30000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
    const marker = 'Startup check passed: ';
    const line = stdout.split(/\r?\n/).find(line => line.startsWith(marker));
    assert.ok(line, 'Entrypoint did not report a successful startup check.');
    const output = JSON.parse(line.slice(marker.length)) as { dataDirectory: string; universes: StartupUniverse[] };
    assert.equal(output.dataDirectory, resolve(directory, DEFAULT_DATA_DIRECTORY));
    assert.deepEqual(output.universes.map(universe => universe.id).sort(), [...ids].sort());
    assert.ok(output.universes.every(universe => universe.tick === 0 && universe.running === false));
    for (const id of ids) {
      const db = new DatabaseSync(join(output.dataDirectory, `${id}.sqlite`), { readOnly: true });
      try {
        assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'clock'").get()?.value, CLOCK_VERSION);
        const row = db.prepare('SELECT tick, data FROM frames ORDER BY tick DESC LIMIT 1').get()!;
        assert.equal(row.tick, 0);
        const frame = JSON.parse(inflateSync(row.data as Uint8Array).toString()) as { entities: unknown[] };
        assert.ok(frame.entities.length > 0, `Missing generated entities for ${id}.`);
      } finally { db.close(); }
    }
    return { universes: output.universes, serverStarted: false };
  } finally {
    assert.ok(resolve(directory).startsWith(temporaryRoot + sep), 'Cleanup target escaped the temporary workspace.');
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(JSON.stringify(await runStartupCheck(), null, 2) + '\n');
}
