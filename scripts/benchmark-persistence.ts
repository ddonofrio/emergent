import { DatabaseSync } from 'node:sqlite';
import { deflateSync, inflateSync } from 'node:zlib';
import { PersistentSession } from '../vendor/littlewhale';
import type { AgentSnapshot, RuntimeSnapshot } from '../server/agents/runtime';
import { AgentBridge } from '../server/simulation/agent-bridge';
import { Engine } from '../src/core/engine';
import { loadUniverse } from '../src/universes';
import type { Frame, UniverseManifest } from '../src/core/types';

// Read-only CPU benchmark. No server, provider, world changes or database copies.
const path = process.argv[2];
if (!path) throw new Error('Usage: node --import tsx scripts/benchmark-persistence.ts <recording.sqlite>');
const db = new DatabaseSync(path, { readOnly: true });
const unpack = <T>(data: Uint8Array): T => JSON.parse(inflateSync(data).toString());
let runtime: RuntimeSnapshot;
let bridge: AgentBridge;
try {
  const legacy = db.prepare("SELECT name FROM sqlite_master WHERE name = 'agent_runtime'").get();
  if (legacy) {
    const row = db.prepare('SELECT data FROM agent_runtime WHERE id = 1').get() as { data: Uint8Array };
    runtime = unpack(row.data);
  } else {
    const row = db.prepare('SELECT data FROM simulation_runtime WHERE id = 1').get() as { data: Uint8Array };
    const agents = db.prepare('SELECT id, data FROM agent_sessions').all() as { id: string; data: Uint8Array }[];
    runtime = { version: 1, simulation: unpack(row.data), agents: Object.fromEntries(agents.map(agent => [agent.id, unpack<AgentSnapshot>(agent.data)])) };
  }
  const manifest = JSON.parse((db.prepare("SELECT value FROM meta WHERE key = 'universe'").get() as { value: string }).value) as UniverseManifest;
  const frame = unpack<Frame>((db.prepare('SELECT data FROM frames ORDER BY tick DESC LIMIT 1').get() as { data: Uint8Array }).data);
  // Only entity IDs and task receipts are needed for pruning, not terrain replay.
  const engine = new Engine(loadUniverse(manifest.id), { ...frame, blocks: [] });
  bridge = new AgentBridge(engine, runtime.simulation);
} finally { db.close(); }

const sessions = Object.fromEntries(Object.entries(runtime.agents).map(([id, agent]) => {
  const { notes, ...current } = agent;
  return [id, { ...current, ...(!agent.memory ? { notes } : {}), session: new PersistentSession(id, agent.session).snapshot() }];
}));
for (const port of bridge.ports()) port.retainCalls(sessions[port.id].session.pendingCalls.filter(pending => !pending.result).map(pending => pending.call.id));
const simulation = bridge.snapshot(); bridge.close();
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const measure = (value: unknown, writes: number) => {
  const started = performance.now(); let compressedBytes = 0;
  for (let index = 0; index < writes; index++) compressedBytes += deflateSync(JSON.stringify(structuredClone(value))).byteLength;
  return { writes, cpuMs: Math.round(performance.now() - started), compressedBytes };
};
console.log(JSON.stringify({
  measurement: 'Snapshot cloning, JSON serialization and compression only; excludes SQLite I/O, physics and inference. One uninterrupted world second: old per-tick plus periodic writes versus current periodic simulation writes.',
  runtimeBytesBefore: bytes(runtime), runtimeBytesAfter: bytes({ version: 1, agents: sessions, simulation }),
  sessionBytes: bytes(sessions), simulationBytes: bytes(simulation),
  previousPhysicsPersistence: measure(runtime, 30), currentPhysicsPersistence: measure(simulation, 10),
  currentSessionSave: Object.fromEntries(Object.entries(sessions).map(([id, agent]) => [id, measure(agent, 1)])),
}, null, 2));
