import { createServer, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { once } from 'node:events';
import { inflateSync } from 'node:zlib';
import { Engine } from '../src/core/engine';
import { loadModule } from '../src/modules';
import { Store } from './store';
import { AgentRuntime } from './agents/runtime';
import { providersFromEnv } from './agents/providers';
import { TurnClock } from './turn-clock';
import { CLOCK_VERSION, TICKS_PER_SECOND, TURN_TICKS } from '../src/core/time';

const port = Number(process.env.PORT ?? 3000);
const worldModule = loadModule(process.env.EMERGENT_MODULE ?? 'first-shore');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
const store = new Store(resolve(process.env.DATA_DIR ?? 'data', `${worldModule.manifest.id}.sqlite`), worldModule.manifest);
const engine = new Engine(worldModule, store.hasWorld() ? store.stateAt(store.latestTick()) : undefined);
engine.nextEvent = store.maxEventId() + 1;
const optionalTurnLimit = (value: string | undefined) => {
  if (!value?.trim()) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error('AGENT_MAX_TURNS must be an optional positive integer.');
  return parsed;
};
const agents = new AgentRuntime(engine, store, { providers: providersFromEnv(), maxTurns: optionalTurnLimit(process.env.AGENT_MAX_TURNS) });
engine.event('world', 'session', `World ${store.hasWorld() ? 'resumed' : 'created'} in ${agents.mode === 'demo' ? 'scripted demo' : 'LLM'} mode.`);
store.record(engine.frame(), engine.state(), agents.persistence());
const clients = new Set<ServerResponse>();
const production = process.argv.includes('--production');
const vite = production ? undefined : await (await import('vite')).createServer({ server: { middlewareMode: true }, appType: 'spa' });
const metadata = () => ({ module: worldModule.manifest, mode: agents.mode, model: agents.inference.label, agentsEnabled: turnClock.status().enabled, latestTick: engine.tick, maxTurns: agents.config.maxTurns, clock: { version: CLOCK_VERSION, ticksPerSecond: TICKS_PER_SECOND, turnTicks: TURN_TICKS }, runtime: turnClock.status() });
function broadcast(event: string, value: unknown) {
  const message = `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
  for (const client of clients) {
    if (client.writableLength > 2_000_000) { client.end(); clients.delete(client); }
    else client.write(message);
  }
}
const json = (res: ServerResponse, value: unknown, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

const server = createServer(async (req, res) => {
  try {
    const allowedHosts = [`localhost:${port}`, `127.0.0.1:${port}`];
    if (!allowedHosts.includes(req.headers.host ?? '')) { json(res, { error: 'Invalid host.' }, 403); return; }
    if (req.headers.origin && !allowedHosts.map(h => `http://${h}`).includes(req.headers.origin)) { json(res, { error: 'Cross-origin access is disabled.' }, 403); return; }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/control' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 2048) { json(res, { error: 'Request too large.' }, 413); return; } }
        const data = JSON.parse(body);
        if (typeof data.agentsEnabled === 'boolean') {
          turnClock.setEnabled(data.agentsEnabled); json(res, metadata()); return;
        }
        if (typeof data.entityId === 'string' && typeof data.entityEnabled === 'boolean') {
          const entity = engine.entities.find(candidate => candidate.id === data.entityId);
          if (!entity) { json(res, { error: 'Unknown entity.' }, 404); return; }
          if (engine.setEntityEnabled(entity.id, data.entityEnabled)) {
            turnClock.entityChanged(); publishFrame(true);
          }
          json(res, { ...metadata(), entity: engine.entity(entity.id) }); return;
        }
        json(res, { error: 'Provide agentsEnabled or entityId with entityEnabled.' }, 400); return;
      }
      if (req.method !== 'GET') { json(res, { error: 'Method not allowed.' }, 405); return; }
      const requestedTick = Number(url.searchParams.get('tick') ?? engine.tick);
      if (!Number.isFinite(requestedTick) || requestedTick < 0) { json(res, { error: 'Invalid tick.' }, 400); return; }
      if (url.pathname === '/api/meta') { json(res, metadata()); return; }
      if (url.pathname === '/api/state') { json(res, { ...metadata(), state: store.stateAt(requestedTick), events: store.eventsAt(requestedTick) }); return; }
      if (url.pathname === '/api/events') { json(res, store.eventsAt(requestedTick, url.searchParams.get('actor') ?? '', 120)); return; }
      if (url.pathname === '/api/frames') { json(res, store.framesAfter(requestedTick)); return; }
      if (url.pathname === '/api/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(`event: boot\ndata: ${JSON.stringify({ ...metadata(), state: engine.state(), events: store.eventsAt(engine.tick) })}\n\n`);
        clients.add(res); req.on('close', () => clients.delete(res)); return;
      }
      if (url.pathname === '/api/export') {
        const endTick = store.latestTick();
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Content-Disposition': `attachment; filename="emergent-day-${engine.day}.ndjson"` });
        res.write(JSON.stringify({ type: 'world', clock: metadata().clock, module: worldModule.manifest, state: store.stateAt(0) }) + '\n');
        for (const row of store.db.prepare('SELECT data FROM frames WHERE tick <= ? ORDER BY tick').iterate(endTick) as Iterable<{ data: Uint8Array }>) {
          if (res.destroyed) break;
          if (!res.write(JSON.stringify({ type: 'frame', frame: JSON.parse(inflateSync(row.data).toString()) }) + '\n')) await once(res, 'drain');
        }
        res.end(); return;
      }
      json(res, { error: 'Unknown endpoint.' }, 404); return;
    }
    if (vite) { vite.middlewares(req, res); return; }
    const root = resolve('dist');
    let path = resolve(root, '.' + decodeURIComponent(url.pathname));
    if (path !== root && !path.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
    if (url.pathname === '/' || !(await stat(path).catch(() => null))?.isFile()) path = resolve(root, 'index.html');
    res.writeHead(200, { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream' }); res.end(await readFile(path));
  } catch (error) { if (!res.headersSent) json(res, { error: error instanceof Error ? error.message : 'Request failed.' }, 500); else res.end(); }
});

let stopping = false;
const turnClock = new TurnClock(engine, agents, {
  frame() {
    publishFrame(engine.tick % 600 === 0);
  },
  status() { broadcast('status', { runtime: turnClock.status() }); },
  fatal(error) { console.error('World storage or runtime failure:', error); void shutdown(1); },
});
function publishFrame(checkpoint = false) {
  const frame = engine.frame();
  store.record(frame, checkpoint ? engine.state() : undefined, agents.persistence());
  broadcast('frame', { frame, agentsEnabled: turnClock.status().enabled, runtime: turnClock.status() });
}
if (process.env.WORLD_START_PAUSED === 'true') turnClock.setEnabled(false);
const timer = setInterval(() => {
  try { turnClock.pump(); }
  catch (error) { console.error('Simulation stopped:', error); void shutdown(1); }
}, 20);
const heartbeat = setInterval(() => broadcast('status', { runtime: turnClock.status() }), 10000);
server.listen(port, '127.0.0.1', () => console.log(`Emergent: http://127.0.0.1:${port} (${agents.mode} mode)`));
server.on('error', error => { console.error(error); void shutdown(1); });
async function shutdown(code = 0) {
  if (stopping) return; stopping = true; clearInterval(timer); clearInterval(heartbeat); turnClock.close();
  try { store.record(engine.frame(), engine.state(), agents.persistence()); } catch (error) { console.error(error); code = 1; }
  for (const client of clients) client.end();
  await vite?.close(); server.close(); store.close(); process.exit(code);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
