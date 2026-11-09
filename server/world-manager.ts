import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CLOCK_VERSION } from '../src/core/time';
import type { UniverseManifest } from '../src/core/types';
import { Store } from './store';

export interface WorldDefinition {
  version: 1;
  id: string;
  universeId: string;
  name: string;
  seed: number;
  createdAt: string;
  updatedAt: string;
  directory: string;
}

export interface WorldSummary extends Omit<WorldDefinition, 'directory' | 'version'> {
  active: boolean;
  hasRecording: boolean;
  resumable: boolean;
  latestTick: number;
}

interface StoredWorld extends Omit<WorldDefinition, 'directory'> { migrationSource?: string; }
interface UniverseDefinition { id: string; name: string; seed: number; }
interface ActiveWorldsFile { version: 1; active: Record<string, string>; }

const MIN_SEED = -2_147_483_648;
const MAX_SEED = 2_147_483_647;

function validateName(value: unknown) {
  if (typeof value !== 'string') throw new Error('World name must be text.');
  const name = value.trim();
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('World name must contain 1 to 80 printable characters.');
  return name;
}

function validateSeed(value: unknown) {
  if (!Number.isInteger(value) || Number(value) < MIN_SEED || Number(value) > MAX_SEED) throw new Error(`Seed must be an integer from ${MIN_SEED} to ${MAX_SEED}.`);
  return Number(value);
}

function recordingDetails(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tick = (db.prepare('SELECT MAX(tick) AS tick FROM frames').get() as { tick?: number | null } | undefined)?.tick ?? 0;
    const row = db.prepare("SELECT value FROM meta WHERE key IN ('universe', 'module') ORDER BY key = 'universe' DESC LIMIT 1").get() as { value?: string } | undefined;
    const clock = (db.prepare("SELECT value FROM meta WHERE key = 'clock'").get() as { value?: string } | undefined)?.value;
    const seed = row?.value ? (JSON.parse(row.value) as { seed?: unknown }).seed : undefined;
    return { tick, seed: Number.isInteger(seed) ? Number(seed) : undefined, clock };
  } finally { db.close(); }
}

export class WorldManager {
  private readonly worldsDirectory: string;
  private readonly activePath: string;
  private worldsById = new Map<string, WorldDefinition>();
  private active: Record<string, string> = {};
  private mutation: Promise<void> = Promise.resolve();

  private constructor(private readonly dataDirectory: string, private readonly universes: readonly UniverseDefinition[]) {
    this.worldsDirectory = resolve(dataDirectory, 'worlds');
    this.activePath = resolve(this.worldsDirectory, 'active.json');
  }

  static async open(dataDirectory: string, universes: readonly UniverseDefinition[]) {
    const manager = new WorldManager(dataDirectory, universes);
    await mkdir(manager.worldsDirectory, { recursive: true });
    await manager.loadActive();
    await manager.importLegacyDirectories();
    await manager.loadWorldDirectories();
    await manager.ensureActiveWorlds();
    await manager.saveActive();
    return manager;
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation, operation);
    this.mutation = result.then(() => undefined, () => undefined);
    return result;
  }

  private worldDirectory(id: string) {
    const directory = resolve(this.worldsDirectory, id);
    if (directory !== this.worldsDirectory && !directory.startsWith(this.worldsDirectory + sep)) throw new Error('World directory escapes the worlds directory.');
    return directory;
  }

  private metadataPath(directory: string) { return resolve(directory, 'world.json'); }

  recordingPath(world: WorldDefinition) { return resolve(world.directory, `${world.universeId}.sqlite`); }

  private async loadActive() {
    try {
      const parsed = JSON.parse(await readFile(this.activePath, 'utf8')) as ActiveWorldsFile;
      if (parsed.version !== 1 || !parsed.active || typeof parsed.active !== 'object') throw new Error('Unsupported active-world configuration.');
      this.active = parsed.active;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async writeMetadata(directory: string, world: StoredWorld) {
    const path = this.metadataPath(directory), temporary = `${path}.tmp`;
    await writeFile(temporary, JSON.stringify(world, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
  }

  private async saveActive() {
    const temporary = `${this.activePath}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, active: this.active }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.activePath);
  }

  private importedName(universeId: string, preferred: string) {
    const names = new Set([...this.worldsById.values()].filter(world => world.universeId === universeId).map(world => world.name.toLocaleLowerCase()));
    if (!names.has(preferred.toLocaleLowerCase())) return preferred;
    for (let suffix = 2; ; suffix++) if (!names.has(`${preferred} ${suffix}`.toLocaleLowerCase())) return `${preferred} ${suffix}`;
  }

  private async importLegacyDirectories() {
    const entries = await readdir(this.worldsDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const source = resolve(this.worldsDirectory, entry.name);
      try { await access(this.metadataPath(source)); continue; } catch {}
      try {
        const legacy = JSON.parse(await readFile(resolve(source, 'save.json'), 'utf8')) as { name?: unknown; seed?: unknown; module?: unknown; savedAt?: unknown };
        const universe = this.universes.find(candidate => candidate.id === legacy.module); if (!universe) continue;
        const id = randomUUID(), directory = this.worldDirectory(id); await rename(source, directory);
        const path = resolve(directory, `${universe.id}.sqlite`), details = recordingDetails(path);
        const timestamp = typeof legacy.savedAt === 'string' && Number.isFinite(Date.parse(legacy.savedAt)) ? new Date(legacy.savedAt).toISOString() : (await stat(path)).birthtime.toISOString();
        await this.writeMetadata(directory, { version: 1, id, universeId: universe.id, name: validateName(legacy.name ?? entry.name),
          seed: details.seed ?? validateSeed(legacy.seed ?? universe.seed), createdAt: timestamp, updatedAt: timestamp });
      } catch { /* Ignore unrelated or incomplete directories. */ }
    }
  }

  private async moveRecording(source: string, destination: string) {
    for (const suffix of ['-shm', '-wal', '']) {
      const from = `${source}${suffix}`, to = `${destination}${suffix}`;
      try { await access(to); continue; } catch {}
      try { await rename(from, to); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }

  private async finishMigration(directory: string, stored: StoredWorld) {
    if (!stored.migrationSource) return stored;
    const source = resolve(this.dataDirectory, stored.migrationSource), destination = resolve(directory, `${stored.universeId}.sqlite`);
    await this.moveRecording(source, destination);
    const { migrationSource: _migrationSource, ...finished } = stored;
    await this.writeMetadata(directory, finished); return finished;
  }

  private validateStoredWorld(value: unknown, directory: string): StoredWorld {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('World metadata must be an object.');
    const row = value as Partial<StoredWorld>;
    if (row.version !== 1 || typeof row.id !== 'string' || row.id !== directory.split(/[\\/]/).at(-1)) throw new Error('World metadata ID must match its directory.');
    if (!this.universes.some(universe => universe.id === row.universeId)) throw new Error('World metadata names an unknown universe.');
    if (typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt)) || typeof row.updatedAt !== 'string' || !Number.isFinite(Date.parse(row.updatedAt))) throw new Error('World metadata dates are invalid.');
    return { version: 1, id: row.id, universeId: row.universeId!, name: validateName(row.name), seed: validateSeed(row.seed),
      createdAt: new Date(row.createdAt).toISOString(), updatedAt: new Date(row.updatedAt).toISOString(),
      ...(typeof row.migrationSource === 'string' ? { migrationSource: row.migrationSource } : {}) };
  }

  private async loadWorldDirectories() {
    const entries = await readdir(this.worldsDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = this.worldDirectory(entry.name);
      try {
        const parsed = this.validateStoredWorld(JSON.parse(await readFile(this.metadataPath(directory), 'utf8')), directory);
        const stored = await this.finishMigration(directory, parsed);
        const world = { ...stored, directory }; delete (world as Partial<StoredWorld>).migrationSource;
        if (this.worldsById.has(world.id)) throw new Error(`Duplicate world ID ${world.id}.`);
        this.worldsById.set(world.id, world);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }

  private async migrateCurrentWorld(universe: UniverseDefinition) {
    const id = randomUUID(), directory = this.worldDirectory(id), sourceName = `${universe.id}.sqlite`;
    await mkdir(directory, { recursive: false });
    let seed = universe.seed, createdAt = new Date().toISOString();
    try { const details = recordingDetails(resolve(this.dataDirectory, sourceName)); seed = details.seed ?? seed; createdAt = (await stat(resolve(this.dataDirectory, sourceName))).birthtime.toISOString(); } catch {}
    const migrating: StoredWorld = { version: 1, id, universeId: universe.id, name: this.importedName(universe.id, universe.name), seed,
      createdAt, updatedAt: new Date().toISOString(), migrationSource: sourceName };
    await this.writeMetadata(directory, migrating);
    const stored = await this.finishMigration(directory, migrating), world = { ...stored, directory };
    this.worldsById.set(id, world); return world;
  }

  private async ensureActiveWorlds() {
    for (const universe of this.universes) {
      const selected = this.worldsById.get(this.active[universe.id]);
      if (selected?.universeId === universe.id) continue;
      const world = await this.migrateCurrentWorld(universe); this.active[universe.id] = world.id;
    }
  }

  private assertUniqueName(universeId: string, name: string, exceptId?: string) {
    if ([...this.worldsById.values()].some(world => world.universeId === universeId && world.id !== exceptId && world.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      throw new Error('World names must be unique within a universe.');
    }
  }

  worlds(universeId: string) { return [...this.worldsById.values()].filter(world => world.universeId === universeId).map(world => ({ ...world })); }

  world(universeId: string, id: string) {
    const world = this.worldsById.get(id); if (!world || world.universeId !== universeId) throw new Error('Unknown world.');
    return { ...world };
  }

  activeWorld(universeId: string) { return this.world(universeId, this.active[universeId]); }

  async list(universeId: string): Promise<WorldSummary[]> {
    return await Promise.all(this.worlds(universeId).map(async world => {
      try {
        const details = recordingDetails(this.recordingPath(world));
        return { id: world.id, universeId, name: world.name, seed: world.seed, createdAt: world.createdAt, updatedAt: world.updatedAt,
          active: world.id === this.active[universeId], hasRecording: true, resumable: details.clock === CLOCK_VERSION, latestTick: details.tick };
      } catch {
        return { id: world.id, universeId, name: world.name, seed: world.seed, createdAt: world.createdAt, updatedAt: world.updatedAt,
          active: world.id === this.active[universeId], hasRecording: false, resumable: false, latestTick: 0 };
      }
    }));
  }

  async create(universeId: string, rawName: unknown, rawSeed: unknown) {
    return await this.serialize(async () => {
      if (!this.universes.some(universe => universe.id === universeId)) throw new Error('Unknown universe.');
      const name = validateName(rawName), seed = validateSeed(rawSeed); this.assertUniqueName(universeId, name);
      const id = randomUUID(), directory = this.worldDirectory(id), timestamp = new Date().toISOString();
      await mkdir(directory, { recursive: false });
      const stored: StoredWorld = { version: 1, id, universeId, name, seed, createdAt: timestamp, updatedAt: timestamp };
      await this.writeMetadata(directory, stored);
      const world = { ...stored, directory }; this.worldsById.set(id, world); return { ...world };
    });
  }

  async rename(universeId: string, id: string, rawName: unknown) {
    return await this.serialize(async () => {
      const world = this.worldsById.get(id); if (!world || world.universeId !== universeId) throw new Error('Unknown world.');
      const name = validateName(rawName); this.assertUniqueName(universeId, name, id);
      world.name = name; world.updatedAt = new Date().toISOString();
      const { directory: _directory, ...stored } = world; await this.writeMetadata(world.directory, stored); return { ...world };
    });
  }

  async makeResumable(universeId: string, id: string, manifest: UniverseManifest) {
    return await this.serialize(async () => {
      const world = this.worldsById.get(id); if (!world || world.universeId !== universeId) throw new Error('Unknown world.');
      const path = this.recordingPath(world), details = recordingDetails(path);
      if (details.clock === CLOCK_VERSION) return { ...world };
      if (details.clock !== 'lockstep-v1') throw new Error(`Recording contract "${details.clock ?? 'unknown'}" cannot be loaded.`);
      const archive = new Store(path, manifest, { readOnly: true });
      try { archive.stateAt(archive.latestTick()); } finally { archive.close(); }
      const db = new DatabaseSync(path);
      try {
        const previousUniverse = db.prepare("SELECT value FROM meta WHERE key = 'universe'").get() as { value?: string } | undefined;
        db.exec('BEGIN IMMEDIATE');
        db.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)').run('legacy-clock', details.clock);
        if (previousUniverse?.value) db.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)').run('legacy-universe', previousUniverse.value);
        db.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)').run('clock', CLOCK_VERSION);
        db.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)').run('universe', JSON.stringify(manifest));
        db.exec('COMMIT');
      } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
      finally { db.close(); }
      const migrated = new Store(path, manifest); migrated.close();
      world.updatedAt = new Date().toISOString();
      const { directory: _directory, ...stored } = world; await this.writeMetadata(world.directory, stored);
      return { ...world };
    });
  }

  async activate(universeId: string, id: string) {
    return await this.serialize(async () => {
      const world = this.worldsById.get(id); if (!world || world.universeId !== universeId) throw new Error('Unknown world.');
      this.active[universeId] = id; await this.saveActive(); return { ...world };
    });
  }

  async delete(universeId: string, id: string) {
    return await this.serialize(async () => {
      const world = this.worldsById.get(id); if (!world || world.universeId !== universeId) throw new Error('Unknown world.');
      if (this.active[universeId] === id) throw new Error('The current world cannot be deleted. Load another world first.');
      const directory = this.worldDirectory(id);
      if (resolve(world.directory) !== directory) throw new Error('World directory does not match its registered UUID.');
      await rm(directory, { recursive: true, force: false });
      this.worldsById.delete(id);
    });
  }
}
