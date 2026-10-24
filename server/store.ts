import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { key, unkey, type Frame, type ModuleManifest, type WorldEvent, type WorldState } from '../src/core/types';
import { CLOCK_VERSION } from '../src/core/time';

const pack = (data: unknown) => deflateSync(JSON.stringify(data));
const unpack = <T>(data: Uint8Array): T => JSON.parse(inflateSync(data).toString());
export class Store {
  db: DatabaseSync;
  private savedMinds = new Map<string,string>();
  constructor(path: string, manifest: ModuleManifest) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS frames (tick INTEGER PRIMARY KEY, data BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS checkpoints (tick INTEGER PRIMARY KEY, data BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, tick INTEGER NOT NULL, actor TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_tick ON events(tick);
      CREATE TABLE IF NOT EXISTS minds (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pending_decisions (tick INTEGER NOT NULL, actor TEXT NOT NULL, model TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(tick, actor));`);
    const clock = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('clock') as { value: string } | undefined;
    if ((clock && clock.value !== CLOCK_VERSION) || (!clock && this.hasWorld())) {
      this.db.close(); throw new Error('This recording uses an older clock. Archive it and start a new world.');
    }
    this.db.prepare('INSERT OR IGNORE INTO meta VALUES (?, ?)').run('clock', CLOCK_VERSION);
    const previous = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('module') as { value: string } | undefined;
    if (previous && previous.value !== JSON.stringify(manifest)) throw new Error('Module configuration changed. Use a new DATA_DIR to preserve the existing recording.');
    this.db.prepare('INSERT OR IGNORE INTO meta VALUES (?, ?)').run('module', JSON.stringify(manifest));
  }
  latestTick() { return (this.db.prepare('SELECT MAX(tick) AS tick FROM frames').get() as { tick: number | null }).tick ?? 0; }
  hasWorld() { return !!this.db.prepare('SELECT tick FROM checkpoints LIMIT 1').get(); }
  maxEventId() { return (this.db.prepare('SELECT MAX(id) AS id FROM events').get() as { id: number | null }).id ?? 0; }
  record(frame: Frame, checkpoint?: WorldState, minds: [string, unknown][] = []) {
    const changedMinds = minds.map(([id,mind]) => [id,JSON.stringify(mind)] as const).filter(([id,data]) => this.savedMinds.get(id)!==data);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT data FROM frames WHERE tick = ?').get(frame.tick) as { data: Uint8Array } | undefined;
      const previous = existing ? unpack<Frame>(existing.data) : undefined;
      const recorded = previous ? { ...frame, changes: [...new Map([...previous.changes,...frame.changes])], events: [...previous.events,...frame.events] } : frame;
      this.db.prepare('INSERT OR REPLACE INTO frames VALUES (?, ?)').run(frame.tick, pack(recorded));
      const eventStatement = this.db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?)');
      for (const event of frame.events) eventStatement.run(event.id, event.tick, event.actor, event.type, JSON.stringify(event));
      if (checkpoint) this.db.prepare('INSERT OR REPLACE INTO checkpoints VALUES (?, ?)').run(checkpoint.tick, pack(checkpoint));
      for (const [id, data] of changedMinds) this.db.prepare('INSERT OR REPLACE INTO minds VALUES (?, ?)').run(id, data);
      // The first durable physics frame and its memories consume staged decisions atomically.
      this.db.prepare('DELETE FROM pending_decisions WHERE tick < ?').run(frame.tick);
      this.db.exec('COMMIT');
      for (const [id,data] of changedMinds) this.savedMinds.set(id,data);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  stateAt(tick: number): WorldState {
    tick = Math.max(0, Math.min(Math.floor(tick), this.latestTick()));
    const checkpoint = this.db.prepare('SELECT tick, data FROM checkpoints WHERE tick <= ? ORDER BY tick DESC LIMIT 1').get(tick) as { tick: number; data: Uint8Array } | undefined;
    if (!checkpoint) throw new Error('No recording exists at that time.');
    let state = unpack<WorldState>(checkpoint.data);
    const cells = new Map(state.blocks.map(([x,y,z,kind]) => [key([x,y,z]),kind]));
    const rows = this.db.prepare('SELECT data FROM frames WHERE tick > ? AND tick <= ? ORDER BY tick').all(checkpoint.tick, tick) as { data: Uint8Array }[];
    for (const row of rows) {
      const frame = unpack<Frame>(row.data);
      for (const [k, kind] of frame.changes) { if (kind) cells.set(k, kind); else cells.delete(k); }
      state = { tick: frame.tick, time: frame.time, entities: frame.entities, bodies: frame.bodies, lost: frame.lost, inbox: frame.inbox, blocks: [] };
    }
    state.blocks = [...cells].map(([k, kind]) => [...unkey(k),kind]); return state;
  }
  framesAfter(tick: number, limit = 200): Frame[] {
    return (this.db.prepare('SELECT data FROM frames WHERE tick > ? ORDER BY tick LIMIT ?').all(tick, limit) as { data: Uint8Array }[]).map(r => unpack<Frame>(r.data));
  }
  eventsAt(tick: number, actor = '', limit = 100): WorldEvent[] {
    const rows = (actor ? this.db.prepare('SELECT data FROM events WHERE tick <= ? AND actor = ? ORDER BY id DESC LIMIT ?').all(tick, actor, limit) : this.db.prepare('SELECT data FROM events WHERE tick <= ? ORDER BY id DESC LIMIT ?').all(tick, limit)) as { data: string }[];
    return rows.map(r => JSON.parse(r.data)).reverse();
  }
  loadMind<T>(id: string): T | undefined { const row = this.db.prepare('SELECT data FROM minds WHERE id = ?').get(id) as { data: string } | undefined; return row ? JSON.parse(row.data) : undefined; }
  loadPending<T>(tick: number, actor: string, model: string): T | undefined {
    const row = this.db.prepare('SELECT data FROM pending_decisions WHERE tick = ? AND actor = ? AND model = ?').get(tick, actor, model) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  savePending(tick: number, actor: string, model: string, value: unknown) {
    this.db.prepare('INSERT OR REPLACE INTO pending_decisions VALUES (?, ?, ?, ?)').run(tick, actor, model, JSON.stringify(value));
  }
  close() { this.db.close(); }
}
