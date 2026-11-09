import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { inflateSync } from 'node:zlib';
import type { UniverseManifest } from '../src/core/types';
import { Store } from '../server/store';

interface Options {
  dataDirectory: string;
  universeId: string;
  worldId: string;
  scope: 'summary' | 'agent' | 'full';
  agent?: string;
  limit: number;
}

interface WorldMetadata {
  id: string;
  universeId: string;
  name: string;
  seed: number;
  createdAt: string;
  updatedAt: string;
}

function usage(): never {
  throw new Error('Usage: dump-world.ts [--data-dir PATH] [--universe ID] [--world active|UUID] [--scope summary|agent|full] [--agent ID|NAME] [--limit N]');
}

function parseOptions(argv: string[]): Options {
  const values = new Map<string, string>();
  const allowed = new Set(['--data-dir', '--universe', '--world', '--scope', '--agent', '--limit']);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1];
    if (!flag || !allowed.has(flag) || value === undefined) usage();
    values.set(flag, value);
  }
  const scope = values.get('--scope') ?? 'summary';
  if (!['summary', 'agent', 'full'].includes(scope)) usage();
  const limit = Number(values.get('--limit') ?? 100);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error('Limit must be an integer from 1 to 10000.');
  const universeId = values.get('--universe') ?? 'first-shore';
  if (!/^[a-z0-9-]+$/.test(universeId)) throw new Error('Universe ID contains invalid characters.');
  const worldId = values.get('--world') ?? 'active';
  if (worldId !== 'active' && !/^[0-9a-f-]{36}$/.test(worldId)) throw new Error('World must be active or a UUID.');
  const agent = values.get('--agent')?.trim();
  if (scope === 'agent' && !agent) throw new Error('--agent is required for an agent dump.');
  return { dataDirectory: resolve(values.get('--data-dir') ?? process.env.DATA_DIR ?? 'data'), universeId, worldId, scope: scope as Options['scope'], ...(agent ? { agent } : {}), limit };
}

function unpack(value: unknown) {
  if (!(value instanceof Uint8Array)) return value;
  try { return JSON.parse(inflateSync(value).toString()); }
  catch { return { encoding: 'base64', data: Buffer.from(value).toString('base64') }; }
}

function decodedRow(row: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, unpack(value)]));
}

function tableNames(db: DatabaseSync) {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(row => row.name);
}

function tableCounts(db: DatabaseSync) {
  return Object.fromEntries(tableNames(db).map(name => [name, Number((db.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get() as { count: number | bigint }).count)]));
}

async function resolveWorld(options: Options) {
  const worldsDirectory = resolve(options.dataDirectory, 'worlds');
  let worldId = options.worldId;
  if (worldId === 'active') {
    const active = JSON.parse(await readFile(resolve(worldsDirectory, 'active.json'), 'utf8')) as { active?: Record<string, unknown> };
    const selected = active.active?.[options.universeId];
    if (typeof selected !== 'string') throw new Error(`No active world is registered for ${options.universeId}.`);
    worldId = selected;
  }
  const directory = resolve(worldsDirectory, worldId);
  if (!directory.startsWith(worldsDirectory + (process.platform === 'win32' ? '\\' : '/'))) throw new Error('World directory escapes the worlds directory.');
  const metadata = JSON.parse(await readFile(resolve(directory, 'world.json'), 'utf8')) as WorldMetadata;
  if (metadata.id !== worldId || metadata.universeId !== options.universeId) throw new Error('World metadata does not match the requested world.');
  return { metadata, recording: resolve(directory, `${options.universeId}.sqlite`) };
}

function manifestFrom(db: DatabaseSync, fallback: WorldMetadata): UniverseManifest {
  const rows = db.prepare("SELECT key, value FROM meta WHERE key IN ('universe', 'module')").all() as { key: string; value: string }[];
  const current = rows.find(row => row.key === 'universe') ?? rows.find(row => row.key === 'module');
  if (!current) throw new Error('Recording has no universe manifest.');
  const manifest = JSON.parse(current.value) as UniverseManifest;
  return { ...manifest, seed: fallback.seed };
}

function latestInferenceAudits(db: DatabaseSync, limit: number, actor?: string) {
  if (!tableNames(db).includes('inference_audit')) return [];
  const rows = (actor
    ? db.prepare('SELECT * FROM inference_audit WHERE actor = ? ORDER BY id DESC LIMIT ?').all(actor, limit)
    : db.prepare('SELECT * FROM inference_audit ORDER BY id DESC LIMIT ?').all(limit)) as Record<string, unknown>[];
  return rows.map(decodedRow);
}

function latestEvents(db: DatabaseSync, limit: number, actor?: string) {
  const rows = (actor
    ? db.prepare('SELECT data FROM events WHERE actor = ? ORDER BY id DESC LIMIT ?').all(actor, limit)
    : db.prepare('SELECT data FROM events ORDER BY id DESC LIMIT ?').all(limit)) as { data: string }[];
  return rows.map(row => JSON.parse(row.data)).reverse();
}

function simulationSummary(db: DatabaseSync) {
  if (!tableNames(db).includes('simulation_runtime')) return undefined;
  const row = db.prepare('SELECT data FROM simulation_runtime WHERE id = 1').get() as { data: Uint8Array } | undefined;
  const runtime = row ? unpack(row.data) as { entities?: Record<string, { sequence?: number; actions?: unknown[]; events?: unknown[]; requests?: unknown[]; receipts?: Record<string, unknown> }> } : undefined;
  return runtime?.entities ? Object.fromEntries(Object.entries(runtime.entities).map(([id, entity]) => [id, {
    sequence: entity.sequence, actions: entity.actions?.length ?? 0, events: entity.events?.length ?? 0,
    requests: entity.requests ?? [], receipts: Object.keys(entity.receipts ?? {}),
  }])) : undefined;
}

function write(value: unknown) { process.stdout.write(`${JSON.stringify(value)}\n`); }

async function main() {
  const options = parseOptions(process.argv.slice(2)), world = await resolveWorld(options);
  const db = new DatabaseSync(world.recording, { readOnly: true });
  try {
    const manifest = manifestFrom(db, world.metadata), store = new Store(world.recording, manifest, { readOnly: true });
    try {
      const latestTick = store.latestTick(), state = store.stateAt(latestTick);
      if (options.scope === 'summary') {
        write({ type: 'summary', generatedAt: new Date().toISOString(), world: world.metadata, recording: world.recording, latestTick,
          tables: tableCounts(db), entities: state.entities.map(entity => ({ id: entity.id, name: entity.name, enabled: entity.enabled, status: entity.status, position: entity.position, motion: entity.motion, intent: entity.intent })),
          simulation: simulationSummary(db),
          recentEvents: latestEvents(db, options.limit), recentInference: latestInferenceAudits(db, options.limit) });
        return;
      }
      if (options.scope === 'agent') {
        const query = options.agent!.toLocaleLowerCase();
        const entity = state.entities.find(candidate => candidate.id.toLocaleLowerCase() === query || candidate.name.toLocaleLowerCase() === query);
        if (!entity) throw new Error(`Agent "${options.agent}" was not found.`);
        const session = tableNames(db).includes('agent_sessions') ? db.prepare('SELECT data FROM agent_sessions WHERE id = ?').get(entity.id) as { data: Uint8Array } | undefined : undefined;
        const simulation = tableNames(db).includes('simulation_runtime') ? db.prepare('SELECT data FROM simulation_runtime WHERE id = 1').get() as { data: Uint8Array } | undefined : undefined;
        write({ type: 'agent', generatedAt: new Date().toISOString(), world: world.metadata, recording: world.recording, latestTick, entity,
          agentSession: session ? unpack(session.data) : undefined, simulationRuntime: simulation ? unpack(simulation.data) : undefined,
          recentEvents: latestEvents(db, options.limit, entity.id), recentInference: latestInferenceAudits(db, options.limit, entity.id) });
        return;
      }
      write({ type: 'dump-header', generatedAt: new Date().toISOString(), world: world.metadata, recording: world.recording, latestTick, tables: tableCounts(db) });
      for (const table of tableNames(db)) {
        for (const row of db.prepare(`SELECT * FROM "${table}"`).iterate() as Iterable<Record<string, unknown>>) write({ type: 'row', table, row: decodedRow(row) });
      }
    } finally { store.close(); }
  } finally { db.close(); }
}

await main();
