import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { key, unkey, type Frame, type UniverseManifest, type WorldEvent, type WorldState } from '../src/core/types';
import { CLOCK_VERSION } from '../src/core/time';
import { DEFAULT_DATA_DIRECTORY } from './config';

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
      CREATE TABLE IF NOT EXISTS agent_runtime (id INTEGER PRIMARY KEY CHECK(id = 1), data BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS inference_audit (id INTEGER PRIMARY KEY, tick INTEGER NOT NULL, actor TEXT NOT NULL, phase TEXT NOT NULL, version TEXT NOT NULL, request BLOB NOT NULL, response BLOB, status TEXT NOT NULL);`);
    this.db.prepare('INSERT OR IGNORE INTO meta VALUES (?, ?)').run('clock', CLOCK_VERSION);
    const previous = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('universe') as { value: string } | undefined;
    if (previous && !compatibleManifest(previous.value,manifest)) { this.db.close();throw new Error('Universe configuration changed. Use a new DATA_DIR to preserve the existing recording.'); }
    this.db.prepare('INSERT OR IGNORE INTO meta VALUES (?, ?)').run('universe', JSON.stringify(manifest));
  }
  latestTick() { return (this.db.prepare('SELECT MAX(tick) AS tick FROM frames').get() as { tick: number | null }).tick ?? 0; }
  hasWorld() { return !!this.db.prepare('SELECT tick FROM checkpoints LIMIT 1').get(); }
  maxEventId() { return (this.db.prepare('SELECT MAX(id) AS id FROM events').get() as { id: number | null }).id ?? 0; }
  record(frame: Frame, checkpoint?: WorldState, runtime?: unknown) {
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
      if (runtime !== undefined) this.saveAgentState(runtime);
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
    const rows=this.db.prepare("SELECT actor,response FROM inference_audit WHERE tick <= ? AND status = 'completed' AND response IS NOT NULL ORDER BY id").all(tick) as {actor:string;response:Uint8Array}[];
    if(!rows.length)return undefined;
    const totals:Record<string,{inputTokens:number;outputTokens:number;cachedInputTokens:number}>={};
    for(const audit of rows){
      const usage=unpack<{usage?:{inputTokens?:number;outputTokens?:number;cachedInputTokens?:number}}>(audit.response).usage;
      if(!usage)continue;
      const metrics=totals[audit.actor]??={inputTokens:0,outputTokens:0,cachedInputTokens:0};
      metrics.inputTokens+=usage.inputTokens??0;metrics.outputTokens+=usage.outputTokens??0;metrics.cachedInputTokens+=usage.cachedInputTokens??0;
    }
    return Object.keys(totals).length?totals:undefined;
  }
  secondsPerTurnAt(tick: number) {
    const row=this.db.prepare("SELECT data FROM events WHERE tick <= ? AND actor = 'world' AND type = 'turn-speed' ORDER BY id DESC LIMIT 1").get(tick) as {data:string} | undefined;
    return row?((JSON.parse(row.data) as WorldEvent).data as {secondsPerTurn:number}).secondsPerTurn:undefined;
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
    const row = this.db.prepare('SELECT data FROM agent_runtime WHERE id = 1').get() as {data: Uint8Array} | undefined;
    return row ? unpack<T>(row.data) : undefined;
  }
  saveAgentState(runtime: unknown) {
    this.db.prepare('INSERT OR REPLACE INTO agent_runtime VALUES (1, ?)').run(pack(runtime));
  }
  // Server-side diagnostics, separate from replay and browser event streams. Never pass provider config here.
  beginInference(tick:number,actor:string,phase:string,version:string,request:unknown) {
    return this.db.prepare('INSERT INTO inference_audit (tick,actor,phase,version,request,status) VALUES (?,?,?,?,?,?)').run(tick,actor,phase,version,pack(request),'pending').lastInsertRowid;
  }
  finishInference(id:number|bigint,response:unknown,status:'completed'|'failed'|'cancelled') {
    this.db.prepare('UPDATE inference_audit SET response = ?, status = ? WHERE id = ?').run(pack(response),status,id);
  }
  cancelInterruptedInferences() {
    return this.db.prepare("UPDATE inference_audit SET response = ?, status = 'cancelled' WHERE status = 'pending'").run(pack({message:'Request cancelled by server restart.'})).changes;
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
