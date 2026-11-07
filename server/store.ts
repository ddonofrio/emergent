import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { key, unkey, type Frame, type UniverseManifest, type WorldEvent, type WorldState } from '../src/core/types';
import { CLOCK_VERSION } from '../src/core/time';
import { DEFAULT_DATA_DIRECTORY } from './config';
import { auditRequest, auditResponse, INFERENCE_AUDIT_LIMIT } from './inference/audit';
import type { CompletionRequest } from '../vendor/littlewhale';

const pack = (data: unknown) => deflateSync(JSON.stringify(data));
const unpack = <T>(data: Uint8Array): T => JSON.parse(inflateSync(data).toString());
export class Store {
  db: DatabaseSync;
  constructor(path: string, readonly manifest: UniverseManifest) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    const tables = new Set((this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {name: string}[]).map(row => row.name));
    const clock = tables.has('meta') ? this.db.prepare('SELECT value FROM meta WHERE key = ?').get('clock') as {value: string} | undefined : undefined;
    const hasRecordedWorld = tables.has('checkpoints') && !!this.db.prepare('SELECT tick FROM checkpoints LIMIT 1').get();
    // Refuse incompatible files before journal or schema initialization can modify them.
    if ((clock && clock.value !== CLOCK_VERSION) || (!clock && hasRecordedWorld)) {
      this.db.close();
      throw new Error(`Recording "${path}" uses clock contract "${clock?.value ?? 'unversioned'}"; expected "${CLOCK_VERSION}". Set DATA_DIR to "${DEFAULT_DATA_DIRECTORY}" or explicitly reset this active world.`);
    }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS frames (tick INTEGER PRIMARY KEY, data BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS checkpoints (tick INTEGER PRIMARY KEY, data BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, tick INTEGER NOT NULL, actor TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_tick ON events(tick);
      CREATE INDEX IF NOT EXISTS events_actor_type_id ON events(actor, type, id);
      CREATE TABLE IF NOT EXISTS agent_sessions (id TEXT PRIMARY KEY, data BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS simulation_runtime (id INTEGER PRIMARY KEY CHECK(id = 1), data BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS legacy_metrics (tick INTEGER PRIMARY KEY, data BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS inference_audit (id INTEGER PRIMARY KEY, tick INTEGER NOT NULL, actor TEXT NOT NULL, phase TEXT NOT NULL, version TEXT NOT NULL, request BLOB NOT NULL, response BLOB, status TEXT NOT NULL);`);
    this.db.prepare('INSERT OR IGNORE INTO meta VALUES (?, ?)').run('clock', CLOCK_VERSION);
    const previous = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('universe') as { value: string } | undefined;
    if (previous && !compatibleManifest(previous.value,manifest)) { this.db.close();throw new Error('Universe configuration changed. Use a new DATA_DIR to preserve the existing recording.'); }
    this.db.prepare('INSERT OR IGNORE INTO meta VALUES (?, ?)').run('universe', JSON.stringify(manifest));
    this.migrateRuntime(tables.has('agent_runtime'));
    this.migrateAudit();
  }
  latestTick() { return (this.db.prepare('SELECT MAX(tick) AS tick FROM frames').get() as { tick: number | null }).tick ?? 0; }
  hasWorld() { return !!this.db.prepare('SELECT tick FROM checkpoints LIMIT 1').get(); }
  maxEventId() { return (this.db.prepare('SELECT MAX(id) AS id FROM events').get() as { id: number | null }).id ?? 0; }
  record(frame: Frame, checkpoint?: WorldState, runtime?: { simulation: unknown; agents: Record<string, unknown> }) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT data FROM frames WHERE tick = ?').get(frame.tick) as { data: Uint8Array } | undefined;
      const previous = existing ? unpack<Frame>(existing.data) : undefined;
      const recorded = previous ? { ...frame, changes: [...new Map([...previous.changes,...frame.changes])], events: [...previous.events,...frame.events] } : frame;
      this.db.prepare('INSERT OR REPLACE INTO frames VALUES (?, ?)').run(frame.tick, pack(recorded));
      const eventStatement = this.db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?)');
      for (const event of frame.events) eventStatement.run(event.id, event.tick, event.actor, event.type, JSON.stringify(event));
      // Commands can commit while time is frozen at an existing checkpoint.
      // Keep that checkpoint and the task receipts in this same transaction.
      if (!checkpoint) {
        const row = this.db.prepare('SELECT data FROM checkpoints WHERE tick = ?').get(frame.tick) as {data: Uint8Array} | undefined;
        if (row) checkpoint = this.applyFrame(unpack<WorldState>(row.data), frame);
      }
      if (checkpoint) this.db.prepare('INSERT OR REPLACE INTO checkpoints VALUES (?, ?)').run(checkpoint.tick, pack(checkpoint));
      // Physics and resumable receipts share a transaction. Agent conversations
      // are saved separately when they change, never recompressed per frame.
      if (runtime) {
        this.db.prepare('INSERT OR REPLACE INTO simulation_runtime VALUES (1, ?)').run(pack(runtime.simulation));
        for (const [id, snapshot] of Object.entries(runtime.agents)) this.saveAgentSession(id, snapshot);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  stateAt(tick: number): WorldState {
    tick = Math.max(0, Math.min(Math.floor(tick), this.latestTick()));
    const checkpoint = this.db.prepare('SELECT tick, data FROM checkpoints WHERE tick <= ? ORDER BY tick DESC LIMIT 1').get(tick) as { tick: number; data: Uint8Array } | undefined;
    if (!checkpoint) throw new Error('No recording exists at that time.');
    let state = unpack<WorldState>(checkpoint.data);
    const cells = new Map(state.blocks.map(([x,y,z,kind]) => [key([x,y,z]),kind]));
    const removed = new Set(state.removedBlocks??[]);
    const rows = this.db.prepare('SELECT data FROM frames WHERE tick > ? AND tick <= ? ORDER BY tick').all(checkpoint.tick, tick) as { data: Uint8Array }[];
    for (const row of rows) {
      const frame = unpack<Frame>(row.data);
      for (const [k, kind] of frame.changes) {
        if (kind) { cells.set(k, kind);removed.delete(k); }
        else { cells.delete(k);if(this.manifest.terrain)removed.add(k); }
      }
      state = { tick: frame.tick, time: frame.time, entities: frame.entities, bodies: frame.bodies, lost: frame.lost, inbox: frame.inbox, blockDamage: frame.blockDamage ?? {}, discoveries:frame.discoveries??{},contacts:frame.contacts??{},encounterNotices:frame.encounterNotices??{},terrainNotices:frame.terrainNotices??{},impactNotices:frame.impactNotices??{}, blocks: [], ...(removed.size?{removedBlocks:[...removed]}:{}) };
    }
    state.blocks = [...cells].map(([k, kind]) => [...unkey(k),kind]); return state;
  }
  private applyFrame(state: WorldState, frame: Frame): WorldState {
    const cells = new Map(state.blocks.map(([x,y,z,kind]) => [key([x,y,z]),kind]));
    const removed = new Set(state.removedBlocks ?? []);
    for (const [cell, kind] of frame.changes) {
      if (kind) { cells.set(cell, kind); removed.delete(cell); }
      else { cells.delete(cell); if (this.manifest.terrain) removed.add(cell); }
    }
    const { changes: _changes, events: _events, ...dynamic } = frame;
    return { ...dynamic, blocks: [...cells].map(([cell,kind]) => [...unkey(cell),kind]), ...(removed.size ? {removedBlocks: [...removed]} : {}) };
  }
  framesAfter(tick: number, limit = 200): Frame[] {
    return (this.db.prepare('SELECT data FROM frames WHERE tick > ? ORDER BY tick LIMIT ?').all(tick, limit) as { data: Uint8Array }[]).map(r => unpack<Frame>(r.data));
  }
  eventsAt(tick: number, actor = '', limit = 100): WorldEvent[] {
    const rows = (actor ? this.db.prepare('SELECT data FROM events WHERE tick <= ? AND actor = ? ORDER BY id DESC LIMIT ?').all(tick, actor, limit) : this.db.prepare('SELECT data FROM events WHERE tick <= ? ORDER BY id DESC LIMIT ?').all(tick, limit)) as { data: string }[];
    return rows.map(r => JSON.parse(r.data)).reverse();
  }
  metricsAt(tick: number) {
    const row = this.db.prepare("SELECT data FROM events WHERE tick <= ? AND actor = 'world' AND type = 'llm-metrics' ORDER BY id DESC LIMIT 1").get(tick) as {data:string} | undefined;
    if(row)return (JSON.parse(row.data) as WorldEvent).data;
    const legacy = this.db.prepare('SELECT data FROM legacy_metrics WHERE tick <= ? ORDER BY tick DESC LIMIT 1').get(tick) as { data: Uint8Array } | undefined;
    return legacy ? unpack(legacy.data) : undefined;
  }
  secondsPerTurnAt(tick:number) {
    const rows=this.db.prepare("SELECT data FROM events WHERE tick <= ? AND actor = 'world' AND type = 'turn-speed' ORDER BY id").all(tick) as {data:string}[];
    let samples=0,totalSeconds=0;
    for(const row of rows){
      const seconds=((JSON.parse(row.data) as WorldEvent).data as {secondsPerTurn?:number}).secondsPerTurn;
      if(Number.isFinite(seconds)&&seconds!>=0){samples++;totalSeconds+=seconds!;}
    }
    return samples?totalSeconds/samples:undefined;
  }
  memoryAt(tick: number, actor: string) {
    const row = this.db.prepare("SELECT data FROM events WHERE tick <= ? AND actor = ? AND type = 'memory' ORDER BY id DESC LIMIT 1").get(tick, actor) as {data: string} | undefined;
    return row ? ((JSON.parse(row.data) as WorldEvent).data as {notes: string[]}).notes : [];
  }
  memoryRecordAt(tick: number, actor: string): { notes: string[]; learned?: string[] } {
    const row = this.db.prepare("SELECT data FROM events WHERE tick <= ? AND actor = ? AND type = 'memory' ORDER BY id DESC LIMIT 1").get(tick, actor) as { data: string } | undefined;
    if (!row) return { notes: [] };
    const record = (JSON.parse(row.data) as WorldEvent).data as { notes: string[]; learned?: string[] };
    return { notes: record.notes, ...(record.learned ? { learned: record.learned } : {}) };
  }
  loadAgentState<T>(): T | undefined {
    const row = this.db.prepare('SELECT data FROM simulation_runtime WHERE id = 1').get() as {data: Uint8Array} | undefined;
    if (!row) return undefined;
    const agents = this.db.prepare('SELECT id, data FROM agent_sessions').all() as { id: string; data: Uint8Array }[];
    return { version: 1, simulation: unpack(row.data), agents: Object.fromEntries(agents.map(agent => [agent.id, unpack(agent.data)])) } as T;
  }
  saveAgentSession(id: string, snapshot: unknown) {
    this.db.prepare('INSERT OR REPLACE INTO agent_sessions VALUES (?, ?)').run(id, pack(snapshot));
  }
  // Server-side diagnostics, separate from replay and browser event streams. Never pass provider config here.
  beginInference(tick:number,actor:string,phase:string,version:string,request:CompletionRequest) {
    return this.db.prepare('INSERT INTO inference_audit (tick,actor,phase,version,request,status) VALUES (?,?,?,?,?,?)').run(tick,actor,phase,version,pack(auditRequest(request)),'pending').lastInsertRowid;
  }
  finishInference(id:number|bigint,response:Parameters<typeof auditResponse>[0],status:'completed'|'failed'|'cancelled') {
    this.db.prepare('UPDATE inference_audit SET response = ?, status = ? WHERE id = ?').run(pack(auditResponse(response)),status,id);
    this.trimAudit();
  }
  cancelInterruptedInferences() {
    const changes = this.db.prepare("UPDATE inference_audit SET response = ?, status = 'cancelled' WHERE status = 'pending'").run(pack({message:'Request cancelled by server restart.'})).changes;
    this.trimAudit(); return changes;
  }
  private trimAudit() {
    this.db.prepare(`DELETE FROM inference_audit WHERE status != 'pending' AND id <= (
      SELECT id FROM inference_audit WHERE status != 'pending' ORDER BY id DESC LIMIT 1 OFFSET ?
    )`).run(INFERENCE_AUDIT_LIMIT);
  }
  private migrateRuntime(hasLegacyRuntime: boolean) {
    if (!hasLegacyRuntime) return;
    const row = this.db.prepare('SELECT data FROM agent_runtime WHERE id = 1').get() as { data: Uint8Array } | undefined;
    const runtime = row ? unpack<{ version: number; simulation: unknown; agents: Record<string, { session: { events?: unknown }; [key: string]: unknown }> }>(row.data) : undefined;
    if (runtime && runtime.version !== 1) throw new Error('Unsupported agent runtime snapshot.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (runtime) {
        this.db.prepare('INSERT OR REPLACE INTO simulation_runtime VALUES (1, ?)').run(pack(runtime.simulation));
        for (const [id, agent] of Object.entries(runtime.agents)) {
          const { events: _retiredLog, ...session } = agent.session;
          this.saveAgentSession(id, { ...agent, session });
        }
      }
      this.db.exec('DROP TABLE agent_runtime; COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private migrateAudit() {
    if (this.db.prepare('SELECT value FROM meta WHERE key = ?').get('compact-inference-audit')) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Preserve the token history of recordings made before metric events existed.
      const first = this.db.prepare("SELECT MIN(tick) AS tick FROM events WHERE actor = 'world' AND type = 'llm-metrics'").get() as { tick: number | null };
      const rows = this.db.prepare("SELECT tick, actor, response FROM inference_audit WHERE tick < ? AND status = 'completed' AND response IS NOT NULL ORDER BY tick, id")
        .iterate(first.tick ?? this.latestTick() + 1) as Iterable<{ tick: number; actor: string; response: Uint8Array }>;
      const totals: Record<string, { inputTokens: number; outputTokens: number; cachedInputTokens: number }> = {};
      let previousTick: number | undefined;
      const saveTotals = () => {
        if (previousTick !== undefined && Object.keys(totals).length) this.db.prepare('INSERT OR REPLACE INTO legacy_metrics VALUES (?, ?)').run(previousTick, pack(totals));
      };
      for (const row of rows) {
        if (previousTick !== row.tick) saveTotals();
        previousTick = row.tick;
        const usage = unpack<{ usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } }>(row.response).usage;
        if (usage) {
          const total = totals[row.actor] ??= { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
          total.inputTokens += usage.inputTokens ?? 0; total.outputTokens += usage.outputTokens ?? 0; total.cachedInputTokens += usage.cachedInputTokens ?? 0;
        }
      }
      saveTotals();
      this.trimAudit();
      const retained = this.db.prepare('SELECT id, request, response FROM inference_audit').all() as { id: number; request: Uint8Array; response: Uint8Array | null }[];
      for (const row of retained) this.db.prepare('UPDATE inference_audit SET request = ?, response = ?, version = ? WHERE id = ?')
        .run(pack(auditRequest(unpack(row.request))), row.response ? pack(auditResponse(unpack(row.response))) : null, 'compact-v1', row.id);
      this.db.prepare('INSERT INTO meta VALUES (?, ?)').run('compact-inference-audit', '1');
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    // One-time startup maintenance, never part of a simulation turn. Reclaim
    // pages occupied by retired prompts/logs while preserving world recordings.
    const free = this.db.prepare('PRAGMA freelist_count').get() as { freelist_count: number };
    if (free.freelist_count > 0) { this.db.exec('VACUUM'); this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); }
  }
  close() { this.db.close(); }
}

function compatibleManifest(recorded: string, current: UniverseManifest) {
  try {
    const previous = JSON.parse(recorded) as UniverseManifest;
    previous.agentInstructions = current.agentInstructions;
    return JSON.stringify(previous) === JSON.stringify(current);
  } catch { return false; }
}
