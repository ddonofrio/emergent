import { createServer, type ServerResponse } from 'node:http';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { once } from 'node:events';
import { inflateSync } from 'node:zlib';
import { Engine } from '../src/core/engine';
import { loadModule } from '../src/modules';
import { Store } from './store';
import { AgentRuntime } from './agents/runtime';
import { discoverProviderModels, enabledProviders, normalizeSavedProvider, ProviderChain, providersFromEnv, resolveProviderApiKey, type ProviderConfig, type ProviderStrategy } from './agents/providers';
import { TurnClock } from './turn-clock';
import { CLOCK_VERSION, TICKS_PER_SECOND, TURN_TICKS } from '../src/core/time';

const port = Number(process.env.PORT ?? 3000);
const worldModule = loadModule(process.env.EMERGENT_MODULE ?? 'first-shore');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
const dataDirectory=resolve(process.env.DATA_DIR??'data'),llmConfigPath=resolve(dataDirectory,'llm-config.json');
const store = new Store(resolve(dataDirectory, `${worldModule.manifest.id}.sqlite`), worldModule.manifest);
const engine = new Engine(worldModule, store.hasWorld() ? store.stateAt(store.latestTick()) : undefined);
engine.nextEvent = store.maxEventId() + 1;
const optionalTurnLimit = (value: string | undefined) => {
  if (!value?.trim()) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error('AGENT_MAX_TURNS must be an optional positive integer.');
  return parsed;
};
let providers = providersFromEnv(),providerStrategy:ProviderStrategy='fallback';
try{
  const saved=JSON.parse(await readFile(llmConfigPath,'utf8')) as {providers?:ProviderConfig[];strategy?:ProviderStrategy|'single-model'};
  if(Array.isArray(saved.providers)&&saved.providers.every(provider=>provider&&typeof provider.id==='string'&&typeof provider.name==='string'&&typeof provider.apiKey==='string'&&typeof provider.baseUrl==='string'&&typeof provider.model==='string')){
    const normalized=saved.providers.map(normalizeSavedProvider),savedIds=new Set(normalized.map(provider=>provider.id));
    providers=[...normalized,...providers.filter(provider=>!savedIds.has(provider.id))];
    if(saved.strategy==='single-model')providerStrategy='first-only';else if(['first-only','round-robin','fallback','master-slaves'].includes(saved.strategy??''))providerStrategy=saved.strategy!;
  }
}catch{}
if (enabledProviders(providers).some(provider => provider.modelDiscovery)) {
  try { await new ProviderChain(enabledProviders(providers)).refreshDiscoveredModels(AbortSignal.timeout(2000)); }
  catch { /* Discovery is retried whenever the local fallback is needed. */ }
}
const agents = new AgentRuntime(engine, store, { providers:enabledProviders(providers), maxTurns: optionalTurnLimit(process.env.AGENT_MAX_TURNS) });
agents.setInferenceConfig(enabledProviders(providers),providerStrategy);
for(const event of store.eventsAt(engine.tick,'',500)){
  if(event.type!=='decision'&&event.type!=='movement-decision')continue;
  const provider=(event.data as {provider?:unknown}|undefined)?.provider;
  if(typeof provider==='string')agents.inference.seedHistoricalSuccess(provider,Math.floor(event.tick/TURN_TICKS)+1);
}
engine.event('world', 'session', `World ${store.hasWorld() ? 'resumed' : 'created'} in ${agents.mode === 'demo' ? 'scripted demo' : 'LLM'} mode.`);
store.record(engine.frame(), engine.state(), agents.persistence());
const clients = new Set<ServerResponse>();
const production = process.argv.includes('--production');
const vite = production ? undefined : await (await import('vite')).createServer({ server: { middlewareMode: true }, appType: 'spa' });
const publicLlmConfig = () => ({
  strategy: agents.inference.providers.length < 2 ? 'first-only' : agents.inference.strategy,
  currentStatus:agents.inference.currentStatus,
  providers: providers.map(({id,type,enabled,name,baseUrl,model,region,displayModel,apiKey,apiKeyRemoved,tokenless,maxOutputTokens,enableThinking})=>({id,type:type??'openai-compatible',enabled:enabled!==false,name,baseUrl,model,region,displayModel,maxOutputTokens,enableThinking,apiKeyConfigured:!!apiKey,apiKeyRemoved:apiKeyRemoved===true,tokenless:tokenless===true,health:enabled===false?{state:'unknown' as const,detail:'Disabled in settings.'}:agents.inference.healthFor(id)})),
});
const metadata = () => ({ module: worldModule.manifest, mode: agents.mode, model: agents.inference.label, providerStrategy:publicLlmConfig().strategy, llmConfig:publicLlmConfig(), parallelRequests: agents.parallelRequests, agentsEnabled: turnClock.status().enabled, latestTick: engine.tick, maxTurns: agents.config.maxTurns, clock: { version: CLOCK_VERSION, ticksPerSecond: TICKS_PER_SECOND, turnTicks: TURN_TICKS }, runtime: turnClock.status() });
function broadcast(event: string, value: unknown) {
  const message = `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
  for (const client of clients) {
    if (client.writableLength > 2_000_000) { client.end(); clients.delete(client); }
    else client.write(message);
  }
}
const json = (res: ServerResponse, value: unknown, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const supportedProviderTypes=new Set(['openai-compatible','openai','openrouter','amazon-bedrock']);

const server = createServer(async (req, res) => {
  try {
    const allowedHosts = [`localhost:${port}`, `127.0.0.1:${port}`];
    if (!allowedHosts.includes(req.headers.host ?? '')) { json(res, { error: 'Invalid host.' }, 403); return; }
    if (req.headers.origin && !allowedHosts.map(h => `http://${h}`).includes(req.headers.origin)) { json(res, { error: 'Cross-origin access is disabled.' }, 403); return; }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname.startsWith('/api/')) {
      if(url.pathname==='/api/llm-config'&&req.method==='GET'){json(res,publicLlmConfig());return;}
      if(url.pathname==='/api/llm-models'&&req.method==='POST'){
        let body='';for await(const chunk of req){body+=chunk;if(body.length>8192){json(res,{error:'Model discovery settings are too large.'},413);return;}}
        const row=JSON.parse(body) as Record<string,unknown>,id=typeof row.id==='string'?row.id:'',type=String(row.type??''),bedrock=type==='amazon-bedrock',clearApiKey=row.clearApiKey===true,tokenless=row.tokenless===true;
        if(!/^[a-zA-Z0-9_-]{1,64}$/.test(id)||!supportedProviderTypes.has(type)){json(res,{error:'Choose a supported provider before refreshing models.'},400);return;}
        if(row.clearApiKey!==undefined&&typeof row.clearApiKey!=='boolean'){json(res,{error:'Token removal must be true or false.'},400);return;}
        if(row.tokenless!==undefined&&typeof row.tokenless!=='boolean'){json(res,{error:'Tokenless server must be true or false.'},400);return;}
        if(tokenless&&type!=='openai-compatible'){json(res,{error:'Tokenless server is only supported for OpenAI-compatible providers.'},400);return;}
        const providedKey=typeof row.apiKey==='string'?row.apiKey:'',apiKey=resolveProviderApiKey(providers,type as NonNullable<ProviderConfig['type']>,id,providedKey,clearApiKey);
        if(!apiKey&&type!=='openai-compatible'){json(res,{error:'Enter an API key before refreshing models.'},400);return;}
        const defaultUrl=type==='openai'?'https://api.openai.com/v1':type==='openrouter'?'https://openrouter.ai/api/v1':'',baseUrl=bedrock?'':typeof row.baseUrl==='string'&&row.baseUrl.trim()?row.baseUrl.trim():defaultUrl;
        if(!bedrock){let parsed:URL;try{parsed=new URL(baseUrl);}catch{json(res,{error:'Enter a valid endpoint before refreshing models.'},400);return;}
          if(!['http:','https:'].includes(parsed.protocol)){json(res,{error:'The model endpoint must use HTTP or HTTPS.'},400);return;}}
        const region=typeof row.region==='string'?row.region.trim():'';
        if(bedrock&&!/^[a-zA-Z0-9-]{1,64}$/.test(region)){json(res,{error:'Enter a valid AWS region before refreshing models.'},400);return;}
        const candidate:ProviderConfig={id,type:type as ProviderConfig['type'],name:'Provider',apiKey,tokenless,baseUrl,model:'',...(region?{region}:{}),headers:type==='openrouter'?{'X-Title':'Emergent'}:undefined};
        try{json(res,{models:await discoverProviderModels(candidate,AbortSignal.timeout(20000))});}catch(error){json(res,{error:error instanceof Error?error.message:'Model discovery failed.'},502);}return;
      }
      if(url.pathname==='/api/llm-config'&&req.method==='POST'){
        let body='';for await(const chunk of req){body+=chunk;if(body.length>16384){json(res,{error:'Configuration is too large.'},413);return;}}
        const data=JSON.parse(body) as {providers?:unknown;strategy?:unknown};
        const strategies=new Set(['first-only','round-robin','fallback','master-slaves']);
        if(!Array.isArray(data.providers)||data.providers.length>12||!strategies.has(String(data.strategy))){json(res,{error:'Choose a supported strategy and up to 12 models.'},400);return;}
        const previousProviders=providers,previous=new Map(previousProviders.map(provider=>[provider.id,provider]));
        const ids=new Set<string>();const next:ProviderConfig[]=[];
        for(const value of data.providers){
          if(!value||typeof value!=='object'){json(res,{error:'Each model needs valid settings.'},400);return;}
          const row=value as Record<string,unknown>,id=typeof row.id==='string'?row.id:'',type=String(row.type??''),name=typeof row.name==='string'?row.name.trim():'',model=typeof row.model==='string'?row.model.trim():'';
          if(!/^[a-zA-Z0-9_-]{1,64}$/.test(id)||ids.has(id)){json(res,{error:`${name||'Each model'} needs a unique ID.`},400);return;}
          if(!supportedProviderTypes.has(type)){json(res,{error:`${name||'This model'} uses an unsupported provider: ${type||'none'}.`},400);return;}
          if(!name||name.length>80){json(res,{error:'Each model needs a name of 1 to 80 characters.'},400);return;}
          if(!model||model.length>200){json(res,{error:`Enter a model identifier for ${name}.`},400);return;}
          if(row.enabled!==undefined&&typeof row.enabled!=='boolean'){json(res,{error:`Activation for ${name} must be true or false.`},400);return;}
          if(row.clearApiKey!==undefined&&typeof row.clearApiKey!=='boolean'){json(res,{error:`Token removal for ${name} must be true or false.`},400);return;}
          if(row.tokenless!==undefined&&typeof row.tokenless!=='boolean'){json(res,{error:`Tokenless server for ${name} must be true or false.`},400);return;}
          const tokenless=row.tokenless===true;
          if(tokenless&&type!=='openai-compatible'){json(res,{error:`Tokenless server is only supported for OpenAI-compatible providers such as ${name}.`},400);return;}
          ids.add(id);
          const bedrock=type==='amazon-bedrock',defaultUrl=type==='openai'?'https://api.openai.com/v1':type==='openrouter'?'https://openrouter.ai/api/v1':'';
          const baseUrl=bedrock?'':typeof row.baseUrl==='string'&&row.baseUrl.trim()?row.baseUrl.trim():defaultUrl;
          if(!bedrock){let parsed:URL;try{parsed=new URL(baseUrl);}catch{json(res,{error:`Enter a valid endpoint for ${name}.`},400);return;}
            if(!['http:','https:'].includes(parsed.protocol)){json(res,{error:`The endpoint for ${name} must use HTTP or HTTPS.`},400);return;}}
          const region=typeof row.region==='string'?row.region.trim():'';
          if(bedrock&&!region){json(res,{error:`Enter an AWS region for ${name}.`},400);return;}
          if(bedrock&&!/^[a-zA-Z0-9-]{1,64}$/.test(region)){json(res,{error:`Enter a valid AWS region for ${name}.`},400);return;}
          const old=previous.get(id),providedKey=typeof row.apiKey==='string'?row.apiKey:'',clearApiKey=row.clearApiKey===true,enabled=row.enabled!==false;
          const maxOutputTokens=row.maxOutputTokens??old?.maxOutputTokens;
          const enableThinking=row.enableThinking??old?.enableThinking;
          if(maxOutputTokens!==undefined&&(!Number.isInteger(maxOutputTokens)||Number(maxOutputTokens)<32||Number(maxOutputTokens)>32768)){json(res,{error:`Output tokens for ${name} must be an integer from 32 to 32768.`},400);return;}
          if(enableThinking!==undefined&&typeof enableThinking!=='boolean'){json(res,{error:`Thinking for ${name} must be true or false.`},400);return;}
          const apiKey=resolveProviderApiKey(previousProviders,type as NonNullable<ProviderConfig['type']>,id,providedKey,clearApiKey);
          if(!apiKey&&enabled&&type!=='openai-compatible'){json(res,{error:`Enter an API key or deactivate ${name}.`},400);return;}
          const sameOldType=(old?.type??'openai-compatible')===type,apiKeyRemoved=!providedKey.trim()&&(clearApiKey||(sameOldType&&old?.apiKeyRemoved===true));
          next.push({id,type:type as ProviderConfig['type'],enabled,name,apiKey,...(apiKeyRemoved?{apiKeyRemoved:true}:{}),...(tokenless?{tokenless:true}:{}),baseUrl,model,...(region?{region}:{}),timeoutMs:old?.timeoutMs,...(maxOutputTokens===undefined?{}:{maxOutputTokens:Number(maxOutputTokens)}),...(enableThinking===undefined?{}:{enableThinking:enableThinking as boolean}),headers:type==='openrouter'?{'X-Title':'Emergent'}:undefined});
        }
        const strategy=data.strategy as ProviderStrategy,tempPath=`${llmConfigPath}.tmp`;
        await writeFile(tempPath,JSON.stringify({strategy,providers:next}),{encoding:'utf8',mode:0o600});await rename(tempPath,llmConfigPath);
        providers=next;agents.setInferenceConfig(enabledProviders(providers),strategy);
        const config=publicLlmConfig();broadcast('llm-config',config);broadcast('settings',{parallelRequests:agents.parallelRequests});json(res,{...metadata(),llmConfig:config});return;
      }
      if (url.pathname === '/api/control' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 2048) { json(res, { error: 'Request too large.' }, 413); return; } }
        const data = JSON.parse(body);
        if(typeof data.parallelRequests==='boolean'){
          agents.setParallelRequests(data.parallelRequests);
          broadcast('settings',{parallelRequests:agents.parallelRequests});json(res,metadata());return;
        }
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
        json(res, { error: 'Provide parallelRequests, agentsEnabled, or entityId with entityEnabled.' }, 400); return;
      }
      if (req.method !== 'GET') { json(res, { error: 'Method not allowed.' }, 405); return; }
      const requestedTick = Number(url.searchParams.get('tick') ?? engine.tick);
      if (!Number.isFinite(requestedTick) || requestedTick < 0) { json(res, { error: 'Invalid tick.' }, 400); return; }
      if (url.pathname === '/api/meta') { json(res, metadata()); return; }
      if (url.pathname === '/api/state') { json(res, { ...metadata(), state: store.stateAt(requestedTick), events: store.eventsAt(requestedTick) }); return; }
      if (url.pathname === '/api/memory') { const actor=url.searchParams.get('actor')?.trim();if(!actor){json(res,{error:'Actor is required.'},400);return;}json(res,store.memoryAt(requestedTick,actor));return; }
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
  status() { broadcast('status', { runtime: turnClock.status(),llmConfig:publicLlmConfig() }); },
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
const heartbeat = setInterval(() => broadcast('status', { runtime: turnClock.status(),llmConfig:publicLlmConfig() }), 10000);
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
