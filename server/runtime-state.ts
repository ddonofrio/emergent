import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

interface StoredRuntimeState {
  version: 1;
  running: Record<string, boolean>;
}

export class RuntimeState {
  private readonly path: string;
  private running: Record<string, boolean> = {};
  private mutation: Promise<void> = Promise.resolve();

  private constructor(dataDirectory: string, private readonly universeIds: ReadonlySet<string>) {
    this.path = resolve(dataDirectory, 'runtime-state.json');
  }

  static async open(dataDirectory: string, universeIds: readonly string[]) {
    const state = new RuntimeState(dataDirectory, new Set(universeIds));
    try {
      const parsed = JSON.parse(await readFile(state.path, 'utf8')) as Partial<StoredRuntimeState>;
      if (parsed.version !== 1 || !parsed.running || typeof parsed.running !== 'object' || Array.isArray(parsed.running)) {
        throw new Error('Unsupported runtime state version.');
      }
      for (const [id, running] of Object.entries(parsed.running)) {
        if (typeof running !== 'boolean') throw new Error(`Runtime state for "${id}" must be true or false.`);
        if (state.universeIds.has(id)) state.running[id] = running;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return state;
  }

  isRunning(universeId: string) {
    if (!this.universeIds.has(universeId)) throw new Error('Unknown universe runtime.');
    return this.running[universeId] ?? false;
  }

  async setRunning(universeId: string, running: boolean) {
    if (!this.universeIds.has(universeId)) throw new Error('Unknown universe runtime.');
    const operation = this.mutation.then(async () => {
      if (this.running[universeId] === running) return;
      const next = { ...this.running, [universeId]: running };
      const temporary = `${this.path}.tmp`;
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(temporary, JSON.stringify({ version: 1, running: next }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.path);
      this.running = next;
    });
    this.mutation = operation.then(() => undefined, () => undefined);
    await operation;
    return running;
  }
}
