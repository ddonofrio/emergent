import { createServer, type ServerResponse } from 'node:http';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { once } from 'node:events';
import { inflateSync } from 'node:zlib';
import { loadUniverse, universeCatalog } from '../src/universes';
import { discoverProviderModels, enabledProviders, isReasoningSettings, normalizeReasoningSettings, normalizeSavedProvider, ProviderChain, providersFromEnv, resolveProviderApiKey, resolveProviderVastToken, type ProviderConfig, type ProviderStrategy, type ReasoningSettings } from './agents/providers';
import { isSamplingTemplateId, type SamplingTemplateId } from '../src/core/sampling-templates';
import { UniverseRuntime } from './universe-runtime';

const port = Number(process.env.PORT ?? 3000);
const scriptedDemo=process.env.SCRIPTED_DEMO==='true';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
const dataDirectory=resolve(process.env.DATA_DIR??'data'),llmConfigPath=resolve(dataDirectory,'llm-config.json');
const optionalTurnLimit = (value: string | undefined) => {
  if (!value?.trim()) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error('AGENT_MAX_TURNS must be an optional positive integer.');
  return parsed;
};
let providers = providersFromEnv(),providerStrategy:ProviderStrategy='fallback',reasoningSettings=normalizeReasoningSettings(undefined);
try{
  const saved=JSON.parse(await readFile(llmConfigPath,'utf8')) as {providers?:ProviderConfig[];strategy?:ProviderStrategy|'single-model';reasoning?:unknown};
  reasoningSettings=normalizeReasoningSettings(saved.reasoning);
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
const runtimes=new Map(universeCatalog.filter(universe=>universe.available).map(entry=>{
  const runtime=new UniverseRuntime(loadUniverse(entry.id),dataDirectory,{
    providers:enabledProviders(providers),providerStrategy,reasoning:reasoningSettings,
    maxTurns:optionalTurnLimit(process.env.AGENT_MAX_TURNS),scriptedDemo,
    fatal(error){console.error(`${entry.name} storage or runtime failure:`,error);void shutdown(1);},
  });
  return [entry.id,runtime] as const;
}));
const production = process.argv.includes('--production');
const vite = production ? undefined : await (await import('vite')).createServer({ server: { middlewareMode: true }, appType: 'spa' });
const publicLlmConfig = (runtime:UniverseRuntime) => ({
  strategy: runtime.agents.inference.providers.length < 2 ? 'first-only' : runtime.agents.inference.strategy,
  reasoning:runtime.agents.reasoningSettings,
  currentStatus:runtime.agents.inference.currentStatus,
  providers: providers.map(({id,type,enabled,name,baseUrl,model,region,displayModel,apiKey,apiKeyRemoved,vastToken,vastTokenRemoved,vastContainerLabel,tokenless,maxOutputTokens,enableThinking,samplingTemplate})=>({id,type:type??'openai-compatible',enabled:enabled!==false,name,baseUrl,model,region,displayModel,maxOutputTokens,enableThinking,samplingTemplate,apiKeyConfigured:!!apiKey,apiKeyRemoved:apiKeyRemoved===true,vastTokenConfigured:!!vastToken,vastTokenRemoved:vastTokenRemoved===true,vastContainerLabel,tokenless:tokenless===true,health:enabled===false?{state:'unknown' as const,detail:'Disabled in settings.'}:runtime.agents.inference.healthFor(id)})),
});
const json = (res: ServerResponse, value: unknown, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const supportedProviderTypes=new Set(['openai-compatible','openai','openrouter','vast-ai','amazon-bedrock']);

const server = createServer(async (req, res) => {
  try {
    const allowedHosts = [`localhost:${port}`, `127.0.0.1:${port}`];
    if (!allowedHosts.includes(req.headers.host ?? '')) { json(res, { error: 'Invalid host.' }, 403); return; }
    if (req.headers.origin && !allowedHosts.map(h => `http://${h}`).includes(req.headers.origin)) { json(res, { error: 'Cross-origin access is disabled.' }, 403); return; }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname.startsWith('/api/')) {
      if(url.pathname==='/api/universes'&&req.method==='GET'){
        json(res,universeCatalog.map(universe=>({...universe,running:runtimes.get(universe.id)?.clock.status().enabled??false})));return;
      }
      const universeRoute=/^\/api\/universes\/([a-z0-9-]+)\/([a-z-]+)$/.exec(url.pathname);
      if(!universeRoute){json(res,{error:'Use a universe-scoped API endpoint.'},404);return;}
      const universe=universeCatalog.find(candidate=>candidate.id===universeRoute[1]);
      if(!universe){json(res,{error:'Unknown universe.'},404);return;}
      if(!universe.available){json(res,{error:`${universe.name} is not available yet.`},409);return;}
      const runtime=runtimes.get(universe.id);
      if(!runtime){json(res,{error:'This universe runtime is unavailable.'},503);return;}
      const {agents,engine,store,clock:turnClock}=runtime;
      const metadata=()=>runtime.metadata(publicLlmConfig(runtime));
      const broadcast=(event:string,value:unknown)=>runtime.broadcast(event,value);
      const apiPath=`/api/${universeRoute[2]}`;
      if(apiPath==='/api/llm-config'&&req.method==='GET'){json(res,publicLlmConfig(runtime));return;}
      if(apiPath==='/api/llm-models'&&req.method==='POST'){
        let body='';for await(const chunk of req){body+=chunk;if(body.length>8192){json(res,{error:'Model discovery settings are too large.'},413);return;}}
        const row=JSON.parse(body) as Record<string,unknown>,id=typeof row.id==='string'?row.id:'',type=String(row.type??''),bedrock=type==='amazon-bedrock',vast=type==='vast-ai',clearApiKey=row.clearApiKey===true,clearVastToken=row.clearVastToken===true,tokenless=row.tokenless===true,copyFromId=typeof row.copyFromId==='string'?row.copyFromId:'';
        if(!/^[a-zA-Z0-9_-]{1,64}$/.test(id)||!supportedProviderTypes.has(type)){json(res,{error:'Choose a supported provider before refreshing models.'},400);return;}
        if(row.clearApiKey!==undefined&&typeof row.clearApiKey!=='boolean'){json(res,{error:'Token removal must be true or false.'},400);return;}
        if(row.clearVastToken!==undefined&&typeof row.clearVastToken!=='boolean'){json(res,{error:'Vast.ai token removal must be true or false.'},400);return;}
        if(row.tokenless!==undefined&&typeof row.tokenless!=='boolean'){json(res,{error:'Tokenless server must be true or false.'},400);return;}
        if(tokenless&&type!=='openai-compatible'){json(res,{error:'Tokenless server is only supported for OpenAI-compatible providers.'},400);return;}
        if(copyFromId&&!vast){json(res,{error:'Only Vast.ai models can copy Vast.ai settings.'},400);return;}
        const providedKey=typeof row.apiKey==='string'?row.apiKey:'',apiKey=resolveProviderApiKey(providers,type as NonNullable<ProviderConfig['type']>,id,providedKey,clearApiKey,copyFromId);
        const vastToken=vast?resolveProviderVastToken(providers,id,typeof row.vastToken==='string'?row.vastToken:'',clearVastToken,copyFromId):'';
        const vastContainerLabel=vast&&typeof row.vastContainerLabel==='string'?row.vastContainerLabel.trim():'';
        if(!apiKey&&!vastToken&&type!=='openai-compatible'){json(res,{error:'Enter an API key before refreshing models.'},400);return;}
        if(vastContainerLabel&&!/^C\.\d+$/.test(vastContainerLabel)){json(res,{error:'The Vast.ai container label must look like C.12345.'},400);return;}
        if(vast&&apiKey&&vastToken&&!vastContainerLabel){json(res,{error:'Enter the Vast.ai container label when both the gateway token and an upstream API key are configured.'},400);return;}
        const defaultUrl=type==='openai'?'https://api.openai.com/v1':type==='openrouter'?'https://openrouter.ai/api/v1':'',baseUrl=bedrock?'':typeof row.baseUrl==='string'&&row.baseUrl.trim()?row.baseUrl.trim():defaultUrl;
        if(!bedrock){let parsed:URL;try{parsed=new URL(baseUrl);}catch{json(res,{error:'Enter a valid endpoint before refreshing models.'},400);return;}
          if(!['http:','https:'].includes(parsed.protocol)){json(res,{error:'The model endpoint must use HTTP or HTTPS.'},400);return;}}
        const region=typeof row.region==='string'?row.region.trim():'';
        if(bedrock&&!/^[a-zA-Z0-9-]{1,64}$/.test(region)){json(res,{error:'Enter a valid AWS region before refreshing models.'},400);return;}
        const candidate:ProviderConfig={id,type:type as ProviderConfig['type'],name:'Provider',apiKey,...(vastToken?{vastToken}:{}),...(vastContainerLabel?{vastContainerLabel}:{}),tokenless,baseUrl,model:'',...(region?{region}:{}),headers:type==='openrouter'?{'X-Title':'Emergent'}:undefined};
        try{json(res,{models:await discoverProviderModels(candidate,AbortSignal.timeout(20000))});}catch(error){json(res,{error:error instanceof Error?error.message:'Model discovery failed.'},502);}return;
      }
      if(apiPath==='/api/llm-config'&&req.method==='POST'){
        let body='';for await(const chunk of req){body+=chunk;if(body.length>16384){json(res,{error:'Configuration is too large.'},413);return;}}
        const data=JSON.parse(body) as {providers?:unknown;strategy?:unknown;reasoning?:unknown};
        const strategies=new Set(['first-only','round-robin','fallback','master-slaves']);
        if(!Array.isArray(data.providers)||data.providers.length>12||!strategies.has(String(data.strategy))){json(res,{error:'Choose a supported strategy and up to 12 models.'},400);return;}
        if(data.reasoning!==undefined&&!isReasoningSettings(data.reasoning)){json(res,{error:'Choose a supported reasoning level for every inference phase.'},400);return;}
        const nextReasoning:ReasoningSettings=data.reasoning===undefined?agents.reasoningSettings:data.reasoning;
        const previousProviders=providers,previous=new Map(previousProviders.map(provider=>[provider.id,provider]));
        const ids=new Set<string>();const next:ProviderConfig[]=[];
        for(const value of data.providers){
          if(!value||typeof value!=='object'){json(res,{error:'Each model needs valid settings.'},400);return;}
          const row=value as Record<string,unknown>,id=typeof row.id==='string'?row.id:'',type=String(row.type??''),name=typeof row.name==='string'?row.name.trim():'',model=typeof row.model==='string'?row.model.trim():'',copyFromId=typeof row.copyFromId==='string'?row.copyFromId:'';
          if(!/^[a-zA-Z0-9_-]{1,64}$/.test(id)||ids.has(id)){json(res,{error:`${name||'Each model'} needs a unique ID.`},400);return;}
          if(!supportedProviderTypes.has(type)){json(res,{error:`${name||'This model'} uses an unsupported provider: ${type||'none'}.`},400);return;}
          if(!name||name.length>80){json(res,{error:'Each model needs a name of 1 to 80 characters.'},400);return;}
          if(model.length>200){json(res,{error:`The model identifier for ${name} must not exceed 200 characters.`},400);return;}
          if(row.enabled!==undefined&&typeof row.enabled!=='boolean'){json(res,{error:`Activation for ${name} must be true or false.`},400);return;}
          if(row.clearApiKey!==undefined&&typeof row.clearApiKey!=='boolean'){json(res,{error:`Token removal for ${name} must be true or false.`},400);return;}
          if(row.clearVastToken!==undefined&&typeof row.clearVastToken!=='boolean'){json(res,{error:`Vast.ai token removal for ${name} must be true or false.`},400);return;}
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
          const old=previous.get(id),copyCandidate=copyFromId?previous.get(copyFromId):undefined,copyFrom=copyCandidate?.type==='vast-ai'?copyCandidate:undefined,providedKey=typeof row.apiKey==='string'?row.apiKey:'',clearApiKey=row.clearApiKey===true,enabled=row.enabled!==false&&!!model;
          const vast=type==='vast-ai',providedVastToken=typeof row.vastToken==='string'?row.vastToken:'',clearVastToken=row.clearVastToken===true;
          if(copyFromId&&!vast){json(res,{error:`Only Vast.ai models such as ${name} can copy Vast.ai settings.`},400);return;}
          const vastToken=vast?resolveProviderVastToken(previousProviders,id,providedVastToken,clearVastToken,copyFromId):'';
          const vastContainerLabel=vast&&typeof row.vastContainerLabel==='string'?row.vastContainerLabel.trim():'';
          if(vastContainerLabel&&!/^C\.\d+$/.test(vastContainerLabel)){json(res,{error:`The Vast.ai container label for ${name} must look like C.12345.`},400);return;}
          const maxOutputTokens=row.maxOutputTokens??old?.maxOutputTokens??copyFrom?.maxOutputTokens;
          const enableThinking=row.enableThinking??old?.enableThinking??copyFrom?.enableThinking;
          if(row.samplingTemplate!==undefined&&typeof row.samplingTemplate!=='string'){json(res,{error:`Sampling template for ${name} must be a string.`},400);return;}
          const requestedSamplingTemplate=typeof row.samplingTemplate==='string'?row.samplingTemplate.trim():undefined;
          const samplingTemplate=requestedSamplingTemplate===undefined?(old?.samplingTemplate??copyFrom?.samplingTemplate):requestedSamplingTemplate||undefined;
          if(samplingTemplate&&!isSamplingTemplateId(samplingTemplate)){json(res,{error:`Choose a supported sampling template for ${name}.`},400);return;}
          if(samplingTemplate&&!['openai-compatible','vast-ai'].includes(type)){json(res,{error:`Sampling templates are only supported for OpenAI-compatible and Vast.ai models such as ${name}.`},400);return;}
          const samplingTemplateId=samplingTemplate as SamplingTemplateId|undefined;
          if(maxOutputTokens!==undefined&&(!Number.isInteger(maxOutputTokens)||Number(maxOutputTokens)<32||Number(maxOutputTokens)>32768)){json(res,{error:`Output tokens for ${name} must be an integer from 32 to 32768.`},400);return;}
          if(enableThinking!==undefined&&typeof enableThinking!=='boolean'){json(res,{error:`Thinking for ${name} must be true or false.`},400);return;}
          const apiKey=resolveProviderApiKey(previousProviders,type as NonNullable<ProviderConfig['type']>,id,providedKey,clearApiKey,copyFromId);
          if(!apiKey&&!vastToken&&enabled&&type!=='openai-compatible'){json(res,{error:`Enter an API key or deactivate ${name}.`},400);return;}
          if(vast&&apiKey&&vastToken&&!vastContainerLabel){json(res,{error:`Enter the Vast.ai container label for ${name} when both credentials are configured.`},400);return;}
          const sameOldType=(old?.type??'openai-compatible')===type,sameCopiedType=(copyFrom?.type??'openai-compatible')===type;
          const apiKeyRemoved=!providedKey.trim()&&(clearApiKey||(sameOldType&&old?.apiKeyRemoved===true)||(!old&&sameCopiedType&&copyFrom?.apiKeyRemoved===true));
          const vastTokenRemoved=vast&&!providedVastToken.trim()&&(clearVastToken||(sameOldType&&old?.vastTokenRemoved===true)||(!old&&sameCopiedType&&copyFrom?.vastTokenRemoved===true));
          next.push({id,type:type as ProviderConfig['type'],enabled,name,apiKey,...(apiKeyRemoved?{apiKeyRemoved:true}:{}),...(vastToken?{vastToken}:{}),...(vastTokenRemoved?{vastTokenRemoved:true}:{}),...(vastContainerLabel?{vastContainerLabel}:{}),...(tokenless?{tokenless:true}:{}),baseUrl,model,...(region?{region}:{}),timeoutMs:old?.timeoutMs??copyFrom?.timeoutMs,...(maxOutputTokens===undefined?{}:{maxOutputTokens:Number(maxOutputTokens)}),...(enableThinking===undefined?{}:{enableThinking:enableThinking as boolean}),...(samplingTemplateId?{samplingTemplate:samplingTemplateId}:{}),headers:type==='openrouter'?{'X-Title':'Emergent'}:undefined});
        }
        const strategy=data.strategy as ProviderStrategy,tempPath=`${llmConfigPath}.tmp`;
        await writeFile(tempPath,JSON.stringify({strategy,reasoning:nextReasoning,providers:next}),{encoding:'utf8',mode:0o600});await rename(tempPath,llmConfigPath);
        providers=next;reasoningSettings={...nextReasoning};
        for(const candidate of runtimes.values()){
          candidate.configureInference(enabledProviders(providers),strategy,reasoningSettings);
          candidate.broadcast('llm-config',publicLlmConfig(candidate));
        }
        const config=publicLlmConfig(runtime);broadcast('settings',{parallelRequests:agents.parallelRequests});json(res,{...metadata(),llmConfig:config});return;
      }
      if (apiPath === '/api/control' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 2048) { json(res, { error: 'Request too large.' }, 413); return; } }
        const data = JSON.parse(body);
        if(typeof data.running==='boolean'){
          json(res,{id:universe.id,running:runtime.setRunning(data.running)});return;
        }
        if(typeof data.parallelRequests==='boolean'){
          agents.setParallelRequests(data.parallelRequests);
          broadcast('settings',{parallelRequests:agents.parallelRequests});json(res,metadata());return;
        }
        if (typeof data.agentsEnabled === 'boolean') {
          if(data.agentsEnabled&&runtime.hasAgents&&agents.mode==='waiting'){json(res,{error:'Configure and activate a model before enabling agents.'},409);return;}
          runtime.setRunning(data.agentsEnabled);json(res,metadata());return;
        }
        if (typeof data.entityId === 'string' && typeof data.entityEnabled === 'boolean') {
          const entity = engine.entities.find(candidate => candidate.id === data.entityId);
          if (!entity) { json(res, { error: 'Unknown entity.' }, 404); return; }
          if (engine.setEntityEnabled(entity.id, data.entityEnabled)) {
            turnClock.entityChanged();runtime.publishFrame(true);
          }
          json(res, { ...metadata(), entity: engine.entity(entity.id) }); return;
        }
        json(res, { error: 'Provide parallelRequests, agentsEnabled, or entityId with entityEnabled.' }, 400); return;
      }
      if (req.method !== 'GET') { json(res, { error: 'Method not allowed.' }, 405); return; }
      const requestedTick = Number(url.searchParams.get('tick') ?? engine.tick);
      if (!Number.isFinite(requestedTick) || requestedTick < 0) { json(res, { error: 'Invalid tick.' }, 400); return; }
      if (apiPath === '/api/meta') { json(res, metadata()); return; }
      if (apiPath === '/api/state') { json(res, { ...metadata(), state: store.stateAt(requestedTick), events: store.eventsAt(requestedTick) }); return; }
      if (apiPath === '/api/memory') { const actor=url.searchParams.get('actor')?.trim();if(!actor){json(res,{error:'Actor is required.'},400);return;}json(res,store.memoryAt(requestedTick,actor));return; }
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
  for(const runtime of runtimes.values())runtime.broadcast('status',{runtime:runtime.clock.status(),llmConfig:publicLlmConfig(runtime)});
},10000);
server.listen(port,'127.0.0.1',()=>console.log(`Emergent: http://127.0.0.1:${port} (${runtimes.size} universes)`));
server.on('error', error => { console.error(error); void shutdown(1); });
async function shutdown(code = 0) {
  if (stopping) return; stopping = true; clearInterval(timer); clearInterval(heartbeat);
  for(const runtime of runtimes.values())try{runtime.close();}catch(error){console.error(error);code=1;}
  await vite?.close();server.close();process.exit(code);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
