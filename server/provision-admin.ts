import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The bootstrap contains only a verifier for a separately delivered random key.
// It cannot be used as a login credential. Never accept a default password.
const bootstrap = JSON.parse(readFileSync(fileURLToPath(new URL('./admin-bootstrap.json', import.meta.url)), 'utf8'));
if (bootstrap.version !== 1 || !/^[a-f0-9]{64}$/.test(bootstrap.sha256) || typeof bootstrap.revision !== 'string') throw new Error('Invalid administrator verifier.');
const directory = process.argv[2];
if (!directory?.startsWith('/')) throw new Error('An absolute persistent data directory is required.');
const path = resolve(directory, 'admin-access.json');
let previous: { revision?: string } | undefined;
try { previous = JSON.parse(readFileSync(path, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
if (previous?.revision !== bootstrap.revision) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(bootstrap) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}
chmodSync(path, 0o600);
console.log('Administrator verifier configured.');
