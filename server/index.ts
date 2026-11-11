import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { once } from 'node:events';
import { inflateSync } from 'node:zlib';
import { loadUniverse, universeCatalog } from '../src/universes';
import { CLOCK_VERSION, TICKS_PER_SECOND, TURN_TICKS } from '../src/core/time';
import type { UniverseModule } from '../src/core/types';
import { discoverModels, providersFromEnv, publicProviders, validateProviders } from './inference/providers';
import { UniverseRuntime } from './universe-runtime';
import { resolveDataDirectory } from './config';
import { RequestQueue } from './inference/request-queue';
import { AdminAccess } from './admin-access';
import { WorldManager, type WorldDefinition } from './world-manager';
import { Store } from './store';

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
const localOrigins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
const configuredOrigins = (process.env.PUBLIC_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean).map(value => {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('PUBLIC_ORIGINS must contain HTTP or HTTPS origins.');
  return parsed.origin;
});
const allowedOrigins = new Set([...localOrigins, ...configuredOrigins]);
const allowedHosts = new Set([...allowedOrigins].map(origin => new URL(origin).host));
const adminAccess = new AdminAccess();
const dataDirectory = resolveDataDirectory(process.env.DATA_DIR);
const inferenceConfigPath = resolve(dataDirectory, 'inference-config.json');
let providers = providersFromEnv();
let parallelRequests = true;
try {
  const saved = JSON.parse(await readFile(inferenceConfigPath, 'utf8')) as { version?: number; providers?: unknown; parallelRequests?: unknown };
  if (saved.version !== 1) throw new Error('Unsupported inference configuration version.');
  if (saved.parallelRequests !== undefined && typeof saved.parallelRequests !== 'boolean') throw new Error('Parallel requests must be true or false.');
  parallelRequests = saved.parallelRequests ?? true;
  providers = validateProviders(saved.providers);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
const requestQueue = new RequestQueue(parallelRequests);
const worldManager = await WorldManager.open(dataDirectory, universeCatalog.map(entry => {
  const universe = loadUniverse(entry.id); return { id: entry.id, name: entry.name, seed: universe.manifest.seed };
}));
const activeWorlds = new Map(universeCatalog.filter(universe => universe.available).map(entry => [entry.id, worldManager.activeWorld(entry.id)] as const));
const worldUniverse = (entry: (typeof universeCatalog)[number], world: WorldDefinition): UniverseModule => {
  const universe = loadUniverse(entry.id);
  return universe.manifest.seed === world.seed ? universe : { ...universe, manifest: { ...universe.manifest, seed: world.seed } };
};
const publicWorld = (world: WorldDefinition, active: boolean) => ({ id: world.id, universeId: world.universeId, name: world.name, seed: world.seed,
  createdAt: world.createdAt, updatedAt: world.updatedAt, active });
const createUniverseRuntime = (entry: (typeof universeCatalog)[number], world = worldManager.activeWorld(entry.id), fatal?: (error: unknown) => void) => new UniverseRuntime(worldUniverse(entry, world), dataDirectory, {
  providers, requestQueue, recordingPath: worldManager.recordingPath(world),
  fatal: fatal ?? (error => { console.error(`${entry.name} storage or runtime failure:`, error); void shutdown(1); }),
});
const runtimes = new Map(universeCatalog.filter(universe => universe.available).map(entry => [entry.id, createUniverseRuntime(entry, activeWorlds.get(entry.id)!)] as const));
if (process.argv.includes('--check-startup')) {
  const result = { dataDirectory, universes: [...runtimes].map(([id, runtime]) => {
    const world = activeWorlds.get(id)!; return { id, worldId: world.id, recording: worldManager.recordingPath(world), tick: runtime.engine.tick, running: runtime.clock.status().enabled };
  }) };
  for (const runtime of runtimes.values()) runtime.close();
  console.log(`Startup check passed: ${JSON.stringify(result)}`);
  process.exit(0);
}
async function restartUniverse(entry: (typeof universeCatalog)[number]) {
  const current = runtimes.get(entry.id);
  if (!current) throw new Error('This universe runtime is unavailable.');
  const wasRunning = current.clock.status().enabled;
  runtimes.delete(entry.id); current.close();
  const world = activeWorlds.get(entry.id)!;
  const recording = worldManager.recordingPath(world);
  await Promise.all([recording, `${recording}-shm`, `${recording}-wal`].map(path => rm(path, { force: true })));
  const replacement = createUniverseRuntime(entry, world); runtimes.set(entry.id, replacement); replacement.setRunning(wasRunning); return replacement;
}
async function activateUniverseWorld(entry: (typeof universeCatalog)[number], target: WorldDefinition) {
  const previous = activeWorlds.get(entry.id)!;
  const current = runtimes.get(entry.id);
  if (!current) throw new Error('This universe runtime is unavailable.');
  if (previous.id === target.id) return current;
  const wasRunning = current.clock.status().enabled;
  runtimes.delete(entry.id); current.close();
  await worldManager.activate(entry.id, target.id); activeWorlds.set(entry.id, target);
  try {
    const replacement = createUniverseRuntime(entry, target); runtimes.set(entry.id, replacement); replacement.setRunning(wasRunning); return replacement;
  } catch (error) {
    await worldManager.activate(entry.id, previous.id); activeWorlds.set(entry.id, previous);
    const restored = createUniverseRuntime(entry, previous); runtimes.set(entry.id, restored); restored.setRunning(wasRunning); throw error;
  }
}
const production = process.argv.includes('--production');
const vite = production ? undefined : await (await import('vite')).createServer({ server: { middlewareMode: true }, appType: 'spa' });
const publicInferenceConfig = (_runtime: UniverseRuntime) => ({ version: 1, parallelRequests, providers: publicProviders(providers) });
const json = (res: ServerResponse, value: unknown, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
async function requestJson(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > limit) throw new Error('Request is too large.'); }
  let value: unknown;
  try { value = JSON.parse(body); } catch { throw new Error('Request body must contain valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object.');
  return value as Record<string, unknown>;
}
function archiveMetadata(entry: (typeof universeCatalog)[number], world: WorldDefinition, store: Store) {
  const universe = worldUniverse(entry, world), latestTick = store.latestTick();
  return { universe: universe.manifest, mode: 'waiting' as const, model: 'Recorded world', inferenceConfig: { version: 1, parallelRequests, providers: [] },
    running: false, latestTick, world: publicWorld(world, false),
    runtime: { phase: 'paused' as const, enabled: false, turn: Math.floor(latestTick / TURN_TICKS) + 1, tick: latestTick, agents: {} },
    metrics: store.metricsAt(latestTick), providerStatus: {}, clock: { version: CLOCK_VERSION, ticksPerSecond: TICKS_PER_SECOND, turnTicks: TURN_TICKS },
    secondsPerTurn: store.secondsPerTurnAt(latestTick), ...(universe.observerVoice ? { observerVoice: universe.observerVoice } : {}) };
}
async function serveArchive(req: IncomingMessage, res: ServerResponse, url: URL, entry: (typeof universeCatalog)[number], world: WorldDefinition, apiPath: string) {
  let store: Store;
  try { store = new Store(worldManager.recordingPath(world), worldUniverse(entry, world).manifest, { readOnly: true }); }
  catch { json(res, { error: 'This world has no recording yet.' }, 404); return; }
  let retained = false;
  try {
    const metadata = () => archiveMetadata(entry, world, store);
    const requestedTick = Number(url.searchParams.get('tick') ?? store.latestTick());
    if (!Number.isFinite(requestedTick) || requestedTick < 0) { json(res, { error: 'Invalid tick.' }, 400); return; }
    if (apiPath === '/api/speech') {
      const beforeId = Number(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER);
      if (!Number.isSafeInteger(beforeId) || beforeId < 1) { json(res, { error: 'Invalid speech cursor.' }, 400); return; }
      json(res, store.speechAt(requestedTick, beforeId)); return;
    }
    if (apiPath === '/api/meta') { json(res, metadata()); return; }
    if (apiPath === '/api/state') { const tick = Math.max(0, Math.min(Math.floor(requestedTick), store.latestTick())); json(res, { ...metadata(), state: store.stateAt(tick), events: store.eventsAt(tick), recordedMetrics: store.metricsAt(tick), recordedSecondsPerTurn: store.secondsPerTurnAt(tick) }); return; }
    if (apiPath === '/api/memory') { const actor = url.searchParams.get('actor')?.trim(); if (!actor) { json(res, { error: 'Actor is required.' }, 400); return; } json(res, store.memoryAt(requestedTick, actor)); return; }
    if (apiPath === '/api/memory-record') { const actor = url.searchParams.get('actor')?.trim(); if (!actor) { json(res, { error: 'Actor is required.' }, 400); return; } json(res, store.memoryRecordAt(requestedTick, actor)); return; }
    if (apiPath === '/api/events') { json(res, store.eventsAt(requestedTick, url.searchParams.get('actor') ?? '', 120)); return; }
    if (apiPath === '/api/frames') { json(res, store.framesAfter(requestedTick)); return; }
    if (apiPath === '/api/stream') {
      const latest = store.latestTick(); retained = true;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`event: boot\ndata: ${JSON.stringify({ ...metadata(), state: store.stateAt(latest), events: store.eventsAt(latest) })}\n\n`);
      req.on('close', () => store.close()); return;
    }
    if (apiPath === '/api/export') {
      const endTick = store.latestTick();
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Content-Disposition': `attachment; filename="${world.id}.ndjson"` });
      res.write(JSON.stringify({ type: 'world', clock: metadata().clock, universe: metadata().universe, state: store.stateAt(0) }) + '\n');
      for (const row of store.db.prepare('SELECT data FROM frames WHERE tick <= ? ORDER BY tick').iterate(endTick) as Iterable<{ data: Uint8Array }>) {
        if (res.destroyed) break;
        if (!res.write(JSON.stringify({ type: 'frame', frame: JSON.parse(inflateSync(row.data).toString()) }) + '\n')) await once(res, 'drain');
      }
      res.end(); return;
    }
    json(res, { error: 'Unknown endpoint.' }, 404);
  } finally { if (!retained) store.close(); }
}
function withSavedCredentials(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Each provider needs valid settings.');
  const { clearApiKey, clearVastToken, hasApiKey: _hasApiKey, hasVastToken: _hasVastToken, ...row } = value as Record<string, unknown>;
  if (clearApiKey !== undefined && typeof clearApiKey !== 'boolean') throw new Error('API key removal must be true or false.');
  if (clearVastToken !== undefined && typeof clearVastToken !== 'boolean') throw new Error('Gateway token removal must be true or false.');
  const previous = providers.find(provider => provider.id === row.id && provider.type === row.type);
  return { ...row,
    ...(row.headers === undefined && previous?.headers ? { headers: previous.headers } : {}),
    ...(row.timeoutMs === undefined && previous?.timeoutMs ? { timeoutMs: previous.timeoutMs } : {}),
    apiKey: clearApiKey ? '' : typeof row.apiKey === 'string' && row.apiKey.trim() ? row.apiKey.trim() : previous?.apiKey ?? '',
    ...(row.type === 'vast-ai' ? { vastToken: clearVastToken ? '' : typeof row.vastToken === 'string' && row.vastToken.trim() ? row.vastToken.trim() : previous?.vastToken ?? '' } : {}),
  };
}

const server = createServer(async (req, res) => {
  try {
    if (!allowedHosts.has(req.headers.host ?? '')) { json(res, { error: 'Invalid host.' }, 403); return; }
    if (req.headers.origin && !allowedOrigins.has(req.headers.origin)) { json(res, { error: 'Cross-origin access is disabled.' }, 403); return; }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if(url.pathname==='/emergent')url.pathname='/';
    else if(url.pathname.startsWith('/emergent/'))url.pathname=url.pathname.slice('/emergent'.length);
    if (url.pathname.startsWith('/api/')) {
      if(url.pathname==='/api/admin/session'&&req.method==='GET'){
        json(res,{authenticated:true},adminAccess.isAuthorized(req.headers.cookie)?200:401);return;
      }
      if(url.pathname==='/api/admin/login'&&req.method==='POST'){
        const data=await requestJson(req,2048),token=adminAccess.login(data.key);
        if(!token){json(res,{error:'Invalid access key.'},401);return;}
        const forwardedProtocol=Array.isArray(req.headers['x-forwarded-proto'])?req.headers['x-forwarded-proto'][0]:req.headers['x-forwarded-proto'];
        res.setHeader('Set-Cookie',adminAccess.sessionCookie(token,forwardedProtocol==='https'));
        json(res,{authenticated:true});return;
      }
      if(req.method!=='GET'&&!adminAccess.isAuthorized(req.headers.cookie)){
        json(res,{error:'Administrator access is required.'},401);return;
      }
      if (url.pathname === '/api/universes' && req.method === 'GET') {
        json(res, universeCatalog.map(universe => ({ ...universe, running: runtimes.get(universe.id)?.clock.status().enabled ?? false }))); return;
      }
      const universeRoute = /^\/api\/universes\/([a-z0-9-]+)(\/.*)$/.exec(url.pathname);
      if (!universeRoute) { json(res, { error: 'Use a universe-scoped API endpoint.' }, 404); return; }
      const universe = universeCatalog.find(candidate => candidate.id === universeRoute[1]);
      if (!universe) { json(res, { error: 'Unknown universe.' }, 404); return; }
      if (!universe.available) { json(res, { error: `${universe.name} is not available yet.` }, 409); return; }
      const universePath = universeRoute[2];
      if (universePath === '/worlds') {
        if (req.method === 'GET') { json(res, { worlds: await worldManager.list(universe.id), activeWorldId: activeWorlds.get(universe.id)!.id }); return; }
        if (req.method === 'POST') {
          try {
            const data = await requestJson(req, 4096), world = await worldManager.create(universe.id, data.name, data.seed);
            const initialized = createUniverseRuntime(universe, world, error => { throw error; }); initialized.close();
            json(res, { world: (await worldManager.list(universe.id)).find(candidate => candidate.id === world.id) }, 201);
          } catch (error) { json(res, { error: error instanceof Error ? error.message : 'World could not be created.' }, 400); }
          return;
        }
        json(res, { error: 'Method not allowed.' }, 405); return;
      }
      const worldRoute = /^\/worlds\/([0-9a-f-]+)(\/activate)?$/.exec(universePath);
      if (worldRoute) {
        try {
          const world = worldManager.world(universe.id, worldRoute[1]);
          if (!worldRoute[2] && req.method === 'PATCH') {
            const data = await requestJson(req, 2048); await worldManager.rename(universe.id, world.id, data.name);
            json(res, { world: (await worldManager.list(universe.id)).find(candidate => candidate.id === world.id) }); return;
          }
          if (!worldRoute[2] && req.method === 'DELETE') {
            await worldManager.delete(universe.id, world.id); json(res, { deleted: true }); return;
          }
          if (worldRoute[2] === '/activate' && req.method === 'POST') {
            const summary = (await worldManager.list(universe.id)).find(candidate => candidate.id === world.id);
            if (!summary?.hasRecording) throw new Error('This world has no recording to load.');
            const prepared = summary.resumable ? world : await worldManager.makeResumable(universe.id, world.id, worldUniverse(universe, world).manifest);
            const replacement = await activateUniverseWorld(universe, prepared), active = activeWorlds.get(universe.id)!;
            json(res, { ...replacement.metadata(publicInferenceConfig(replacement)), world: publicWorld(active, true) }); return;
          }
          json(res, { error: 'Method not allowed.' }, 405);
        } catch (error) { json(res, { error: error instanceof Error ? error.message : 'World operation failed.' }, 400); }
        return;
      }
      if (!/^\/[a-z-]+$/.test(universePath)) { json(res, { error: 'Unknown universe endpoint.' }, 404); return; }
      const runtime = runtimes.get(universe.id);
      if (!runtime) { json(res, { error: 'This universe runtime is unavailable.' }, 503); return; }
      const { engine, store, clock: turnClock } = runtime;
      const activeWorld = activeWorlds.get(universe.id)!;
      const metadata = () => ({ ...runtime.metadata(publicInferenceConfig(runtime)), world: publicWorld(activeWorld, true) });
      const apiPath = `/api${universePath}`;
      const requestedWorldId = url.searchParams.get('world');
      if (req.method === 'GET' && requestedWorldId && requestedWorldId !== activeWorld.id) {
        try { await serveArchive(req, res, url, universe, worldManager.world(universe.id, requestedWorldId), apiPath); }
        catch (error) { json(res, { error: error instanceof Error ? error.message : 'World recording is unavailable.' }, 404); }
        return;
      }
      if (apiPath === '/api/speech' && req.method === 'POST') {
        const data = await requestJson(req, 8192);
        const result = runtime.speak(data.text);
        const event = result.ok ? engine.recentEvents.find(event => event.id === result.feedback?.eventId) : undefined;
        json(res, result.ok ? { ...result, event } : { ...result, error: result.message }, result.ok ? 200 : 400); return;
      }
      if (apiPath === '/api/inference-config' && req.method === 'GET') { json(res, publicInferenceConfig(runtime)); return; }
      if (apiPath === '/api/models' && req.method === 'POST') {
        try {
          const row = withSavedCredentials(await requestJson(req, 8192));
          const [candidate] = validateProviders([{ ...row, name: row.name || 'Model discovery', model: row.model || '', enabled: false }]);
          json(res, { models: await discoverModels(candidate, AbortSignal.timeout(20000)) });
        } catch (error) { json(res, { error: error instanceof Error ? error.message : 'Model discovery failed.' }, 400); }
        return;
      }
      if (apiPath === '/api/inference-config' && req.method === 'POST') {
        try {
          const data = await requestJson(req, 32768);
          if (data.version !== 1 || !Array.isArray(data.providers)) throw new Error('Use inference configuration version 1 with a providers array.');
          if (data.parallelRequests !== undefined && typeof data.parallelRequests !== 'boolean') throw new Error('Parallel requests must be true or false.');
          const nextParallel = data.parallelRequests === undefined ? parallelRequests : data.parallelRequests;
          const next = validateProviders(data.providers.map(withSavedCredentials));
          const providersChanged = JSON.stringify(next) !== JSON.stringify(providers);
          const tempPath = `${inferenceConfigPath}.tmp`;
          await writeFile(tempPath, JSON.stringify({ version: 1, parallelRequests: nextParallel, providers: next }), { encoding: 'utf8', mode: 0o600 });
          await rename(tempPath, inferenceConfigPath); providers = next; parallelRequests = nextParallel;
          requestQueue.setParallel(parallelRequests);
          for (const candidate of runtimes.values()) { if (providersChanged) candidate.configureInference(providers); candidate.broadcast('inference-config', publicInferenceConfig(candidate)); }
          json(res, { ...metadata(), inferenceConfig: publicInferenceConfig(runtime) });
        } catch (error) { json(res, { error: error instanceof Error ? error.message : 'Configuration could not be saved.' }, 400); }
        return;
      }
      if (apiPath === '/api/control' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 2048) { json(res, { error: 'Request too large.' }, 413); return; } }
        const data = JSON.parse(body);
        if(data.reset===true){
          const replacement=await restartUniverse(universe);
          json(res,{...replacement.metadata(publicInferenceConfig(replacement)),reset:true});return;
        }
        if(typeof data.running==='boolean'){
          const running=runtime.setRunning(data.running);json(res,{id:universe.id,...metadata(),running});return;
        }
        if(typeof data.entityId==='string'&&['manual','automaton'].includes(data.controlMode)){
          const entity=engine.entities.find(candidate=>candidate.id===data.entityId);
          if(!entity){json(res,{error:'Unknown entity.'},404);return;}
          if(!['static','automaton'].includes(entity.controller)){json(res,{error:'This character does not support manual or automaton control.'},409);return;}
          if(engine.setEntityControlMode(entity.id,data.controlMode)){turnClock.entityChanged();runtime.publishFrame(true);}
          json(res,{...metadata(),entity:engine.entity(entity.id)});return;
        }
        if(typeof data.entityId==='string'&&['up','down','left','right'].includes(data.manualDirection)){
          const entity=engine.entities.find(candidate=>candidate.id===data.entityId);
          if(!entity){json(res,{error:'Unknown entity.'},404);return;}
          if(entity.controller!=='static'){json(res,{error:'Arrow-key control is only available for static characters.'},409);return;}
          if(!turnClock.status().enabled){json(res,{error:'The world is stopped.'},409);return;}
          if(entity.motion){json(res,{error:`${entity.name} is still moving.`},409);return;}
          const offsets:Record<string,[number,number]>={up:[0,-.5],down:[0,.5],left:[-.5,0],right:[.5,0]},offset=offsets[data.manualDirection];
          const result=engine.act(entity.id,{action:'walk',target:[entity.position[0]+offset[0],entity.position[1],entity.position[2]+offset[1]]},'manual');
          turnClock.entityChanged();runtime.publishFrame(true);json(res,{...metadata(),entity:engine.entity(entity.id),result});return;
        }
        if (typeof data.entityId === 'string' && typeof data.entityEnabled === 'boolean') {
          const entity = engine.entities.find(candidate => candidate.id === data.entityId);
          if (!entity) { json(res, { error: 'Unknown entity.' }, 404); return; }
          if (engine.setEntityEnabled(entity.id, data.entityEnabled)) {
            turnClock.entityChanged();runtime.publishFrame(true);
          }
          json(res, { ...metadata(), entity: engine.entity(entity.id) }); return;
        }
        json(res, { error: 'Provide reset, running, controlMode, manualDirection, or entityId with entityEnabled.' }, 400); return;
      }
      if (req.method !== 'GET') { json(res, { error: 'Method not allowed.' }, 405); return; }
      const requestedTick = Number(url.searchParams.get('tick') ?? engine.tick);
      if (!Number.isFinite(requestedTick) || requestedTick < 0) { json(res, { error: 'Invalid tick.' }, 400); return; }
      if (apiPath === '/api/speech') {
        const beforeId = Number(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER);
        if (!Number.isSafeInteger(beforeId) || beforeId < 1) { json(res, { error: 'Invalid speech cursor.' }, 400); return; }
        json(res, store.speechAt(requestedTick, beforeId)); return;
      }
      if (apiPath === '/api/meta') { json(res, metadata()); return; }
      if (apiPath === '/api/state') { const tick=Math.max(0,Math.min(Math.floor(requestedTick),store.latestTick()));json(res, { ...metadata(), state: store.stateAt(tick), events: store.eventsAt(tick), recordedMetrics: store.metricsAt(tick), recordedSecondsPerTurn: store.secondsPerTurnAt(tick) }); return; }
      if (apiPath === '/api/memory') { const actor=url.searchParams.get('actor')?.trim();if(!actor){json(res,{error:'Actor is required.'},400);return;}json(res,store.memoryAt(requestedTick,actor));return; }
      if (apiPath === '/api/memory-record') { const actor=url.searchParams.get('actor')?.trim();if(!actor){json(res,{error:'Actor is required.'},400);return;}json(res,store.memoryRecordAt(requestedTick,actor));return; }
      if (apiPath === '/api/events') { json(res, store.eventsAt(requestedTick, url.searchParams.get('actor') ?? '', 120)); return; }
      if (apiPath === '/api/frames') { json(res, store.framesAfter(requestedTick)); return; }
      if (apiPath === '/api/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(`event: boot\ndata: ${JSON.stringify({ ...metadata(), state: engine.state(), events: store.eventsAt(engine.tick) })}\n\n`);
        runtime.clients.add(res);req.on('close',()=>runtime.clients.delete(res));return;
      }
      if (apiPath === '/api/export') {
        const endTick = store.latestTick();
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Content-Disposition': `attachment; filename="emergent-day-${engine.day}.ndjson"` });
        res.write(JSON.stringify({ type: 'world', clock: metadata().clock, universe: runtime.universe.manifest, state: store.stateAt(0) }) + '\n');
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
const timer = setInterval(() => {
  try { for(const runtime of runtimes.values())runtime.pump(); }
  catch (error) { console.error('Simulation stopped:', error); void shutdown(1); }
}, 20);
const heartbeat = setInterval(()=>{
  for(const runtime of runtimes.values())runtime.broadcast('status',{...runtime.observerStatus(),inferenceConfig:publicInferenceConfig(runtime)});
},10000);
server.listen(port,'127.0.0.1',()=>console.log(`Emergent: http://127.0.0.1:${port} (${runtimes.size} universes)\nData directory: ${dataDirectory}`));
server.on('error', error => { console.error(error); void shutdown(1); });
async function shutdown(code = 0) {
  if (stopping) return; stopping = true; clearInterval(timer); clearInterval(heartbeat);
  for(const runtime of runtimes.values())try{runtime.close();}catch(error){console.error(error);code=1;}
  await vite?.close();server.close();process.exit(code);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
