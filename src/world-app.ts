import { WorldView } from './view/world-view';
import { advancePlayback, fastScrubSpeed } from './view/playback-clock';
import { formatWorldDuration, worldTime, WORLD_DAY_SECONDS, TURN_TICKS, type TurnStatus } from './core/time';
import { key, unkey, type Frame, type UniverseManifest, type WorldEvent, type WorldState } from './core/types';
import { knowledgeDescription } from './core/knowledge';
import { loadUniverse } from './universes';
import { entityDisplayStatus } from './view/entity-status';
import { firstShoreAppearance } from './universes/first-shore/appearance';
import './universes/first-shore/style.css';
import { WorldChat } from './view/world-chat';

interface AgentMetrics { llmCalls?:number; inputTokens?:number; outputTokens?:number; cachedInputTokens?:number; }
interface ModelRequestStatus { state:'unknown'|'ok'|'bad'; inFlight:number; detail?:string; }
interface Metadata { universe: UniverseManifest; observerVoice?:{name:string}; mode: 'llm' | 'waiting'; model: string; inferenceConfig?:InferenceConfig; metrics?:Record<string,AgentMetrics>; providerStatus?:Record<string,ModelRequestStatus>; latestTick: number; runtime: TurnStatus; secondsPerTurn?:number; }
interface Boot extends Metadata { state: WorldState; events: WorldEvent[]; recordedMetrics?:Record<string,AgentMetrics>; recordedSecondsPerTurn?:number; }
interface ModelProvider { id:string; type:string; name:string; enabled?:boolean; baseUrl:string; model:string; region?:string; tokenless?:boolean; contextWindow?:number; reasoning?:string; hasApiKey?:boolean; apiKey?:string; clearApiKey?:boolean; hasVastToken?:boolean; vastToken?:string; clearVastToken?:boolean; vastContainerLabel?:string; }
interface InferenceConfig { version:1; parallelRequests?:boolean; providers:ModelProvider[]; }
interface ProviderModelOption { id:string; label:string; contextWindow?:number; }
const universeId=/^\/universes\/([a-z0-9-]+)\/?$/.exec(window.location.pathname)?.[1];
if(!universeId)throw new Error('A universe route is required.');
const worldApi=`/api/universes/${universeId}`;
const rosterLayout=universeId==='robots-vs-robots';
document.body.classList.toggle('roster-layout',rosterLayout);
document.body.dataset.universe=universeId;
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <main id="main">
    <section class="observation-area" aria-label="World observation">
      <div class="world-toolbar"><div class="world-brand"><a class="brand" href="/" aria-label="Emergent home"><span class="brand-mark"><i></i><i></i><i></i></span>emergent</a><span class="world-brand-divider" aria-hidden="true">|</span><h1 id="module-name">First Shore</h1></div><button id="settings-open" class="settings-open" title="Settings" aria-label="Open settings"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.25a3.75 3.75 0 1 0 0 7.5 3.75 3.75 0 0 0 0-7.5Z"/><path d="m19.4 13.5 1.1.85-1.1 1.9-1.35-.45a7.8 7.8 0 0 1-1.55.9l-.25 1.4h-2.2l-.25-1.4a7.8 7.8 0 0 1-1.55-.9l-1.35.45-1.1-1.9 1.1-.85a7 7 0 0 1 0-1.8l-1.1-.85 1.1-1.9 1.35.45a7.8 7.8 0 0 1 1.55-.9l.25-1.4h2.2l.25 1.4a7.8 7.8 0 0 1 1.55.9l1.35-.45 1.1 1.9-1.1.85a7 7 0 0 1 0 1.8Z" transform="translate(-1.4 -1.5)"/></svg></button></div>
      <div id="world" class="world"><div class="loading" id="loading"><span class="loader"></span>Opening the observatory…</div></div>
      <section class="timeline" aria-label="Recorded world timeline">
        <div class="timeline-top">
          <div class="playback-controls"><button id="play" class="play-button" title="Pause observation" aria-label="Pause observation">Ⅱ</button><button id="live" class="live-button active"><span></span> Live</button><select id="speed" aria-label="Playback speed"><option value="1">1×</option><option value="2">2×</option><option value="4">4×</option><option value="8">8×</option></select><span class="timeline-divider"></span><span id="playback-time">00:00:00.0</span><span id="time-to-live">LIVE</span></div>
          <div class="timeline-view-controls"><div class="camera-tools"><button id="overview" title="Overview" aria-label="Overview">◈</button><button id="top-down" title="Top view" aria-label="Top view">⊞</button><button id="follow" title="Follow selected inhabitant" aria-label="Follow selected inhabitant">◎</button></div></div>
          <div class="timeline-right"><select id="day" aria-label="Recorded day"><option value="1">Day 001</option></select></div>
        </div>
        <div class="scrubber"><div id="event-marks"></div><input id="seek" type="range" min="0" max="1" value="0" step="2" aria-label="Seek world history"></div>
        <div class="timeline-labels"><span id="range-start">00:00:00</span><span id="range-end">00:00:00</span></div>
      </section>
    </section>
    <aside id="debug-panel" class="debug-panel collapsed" aria-label="Debug and journal">
      <header class="panel-heading"><button id="debug-toggle" class="panel-toggle" type="button" aria-expanded="false" aria-label="Expand debug panel" title="Expand debug panel"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg><span>Debug</span></button></header>
      <div class="debug-content">
        <section class="turn-status-section"><h2>Turn status</h2><ul id="provider-status-list" class="provider-status-list" aria-label="Configured models"></ul><div id="toast" role="status"></div></section>
        <section class="stats-section" aria-label="Stats"><h2>Stats</h2><div id="stats-rows"></div></section>
        <section class="journal-section"><header class="journal-heading"><h2>Journal</h2><span id="event-count">0</span></header><div id="journal" class="journal"><p class="empty">Waiting for the first trace.</p></div></section>
      </div>
    </aside>
    <aside id="inspector" class="inspector" aria-label="Properties">
      <header class="panel-heading"><h2>Properties</h2><button id="focus-toggle" class="panel-toggle" type="button" aria-expanded="true" aria-label="Collapse Properties panel" title="Collapse Properties panel"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg><span>Properties</span></button></header>
      <section class="roster-world-controls" aria-label="World control"><div class="section-heading"><h2>World control</h2><span id="roster-world-state">Stopped</span></div><div class="roster-control-actions"><button id="roster-play" type="button">Play</button><button id="roster-stop" type="button">Stop</button><button id="roster-reset" class="danger" type="button">Restart from zero</button></div><p id="roster-control-message" role="status"></p></section>
      <section id="roster-view-controls" class="roster-view-controls" aria-label="World view controls"><div class="section-heading"><h2>View</h2></div></section>
      <section class="inhabitants"><div class="section-heading"><h2>Inhabitants</h2><span id="entity-count">09</span></div><div id="entity-list"></div><p id="roster-move-message" class="roster-move-message" role="status"></p></section>
      <section id="record-knowledge" class="record-knowledge" aria-label="Private notes and learned knowledge"></section>
      <section class="focus-section"><div id="details" class="details"></div></section>
    </aside>
  </main>
  <section id="llm-settings" class="settings-screen hidden" aria-labelledby="settings-title" aria-hidden="true">
    <header class="settings-header"><button id="settings-back" class="settings-back">Back</button><div><span class="eyebrow">EMERGENT / SETTINGS</span><h1 id="settings-title">Settings</h1></div></header>
    <div class="settings-content">
      <form id="llm-settings-form">
        <section class="settings-section"><h2>Request settings</h2><label class="request-setting"><input id="parallel-requests" type="checkbox" checked>Parallel requests</label><p class="settings-note">Allow multiple model requests at once. Uncheck to send one request at a time.</p></section>
        <section class="settings-section"><div class="settings-section-heading"><div><h2>Models</h2><p>Each inhabitant keeps one ongoing conversation. Active models are tried in this order when inference is unavailable. World time stays frozen while an agent is thinking or retrying.</p></div><button id="add-model" class="secondary-button" type="button">Add model</button></div><div id="model-list" class="model-list"></div><p class="settings-note">Credentials stay on the server. Context limits control LittleWhale conversation compaction. Provider changes apply to the next request in each existing conversation.</p></section>
        <div class="settings-actions"><span id="settings-status" role="status"></span><button class="save-button" type="submit">Save configuration</button></div>
      </form>
    </div>
  </section>
`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
if(rosterLayout){
  document.querySelector('#inspector .panel-heading h2')!.textContent='Characters';
  $('roster-view-controls').append(document.querySelector('.timeline-view-controls')!);
}
let view: WorldView;
try { view = new WorldView($('world'), id => selectEntity(id), universeId==='first-shore'?firstShoreAppearance:undefined); }
catch { $('loading').textContent = 'WebGL is unavailable. Enable hardware acceleration and reload to observe the world.'; throw new Error('WebGL unavailable.'); }
let meta: Metadata;
let shown: WorldState;
let liveDynamic: Omit<WorldState,'blocks'>;
const liveCells = new Map<string,string>();
const liveRemoved = new Set<string>();
let latest = 0, selected = 't1', isLive = true, playing = false, cursor = 0, scrubTarget: number | null = null, events: WorldEvent[] = [], liveEvents: WorldEvent[] = [];
let shownMetrics:Record<string,AgentMetrics>|undefined;
let shownSecondsPerTurn:number|undefined;
let epoch = 0, seekTimer: ReturnType<typeof setTimeout>, replayFrames: Frame[] = [], fetching = false, replayClock = 0, replayRequest = 0, lastPlayback = performance.now(), lastUi = 0, nextReplayFetch = 0, seeking = false;
let dayCount = 0,detailsSignature='',statsSignature='';
let memoryRequest=0,memoryView:{actor:string;tick:number;notes:string[];learned?:string[]}|undefined;
const worldChat = new WorldChat($('world'),worldApi,()=>({available:!!meta,live:isLive&&!seeking,tick:cursor,
  entities:shown?.entities??[],voice:meta?.observerVoice,settingsOpen:!$('llm-settings').classList.contains('hidden')}));

function toast(message: string) { $('toast').textContent = message; $('toast').classList.add('visible'); setTimeout(() => $('toast').classList.remove('visible'),3500); }
let inferenceConfig:InferenceConfig={version:1,parallelRequests:true,providers:[]};
function settingField(parent:HTMLElement,title:string,field:string,value:string,type='text',placeholder=''){
  const label=document.createElement('label');label.className='model-field';label.textContent=title;
  const input=document.createElement('input');input.type=type;input.dataset.field=field;input.value=value;input.placeholder=placeholder;input.autocomplete=type==='password'?'new-password':'off';label.append(input);parent.append(label);return input;
}
function readModelRows():ModelProvider[]{
  return Array.from($('model-list').children).map(card=>{
    const field=(name:string)=>(card.querySelector(`[data-field="${name}"]`) as HTMLInputElement|HTMLSelectElement).value;
    const checked=(name:string)=>(card.querySelector(`[data-field="${name}"]`) as HTMLInputElement).checked;
    const apiKey=field('apiKey').trim(),vastToken=field('vastToken').trim();
    const contextWindow=Number(field('contextWindow'));
    return {id:(card as HTMLElement).dataset.id!,type:field('type'),name:field('name'),enabled:checked('enabled'),baseUrl:field('baseUrl'),model:field('model'),region:field('region'),tokenless:checked('tokenless'),contextWindow,
      ...(field('reasoning')?{reasoning:field('reasoning')}:{ }),hasApiKey:(card as HTMLElement).dataset.hasApiKey==='true',clearApiKey:checked('clearApiKey'),...(apiKey?{apiKey}:{}),
      hasVastToken:(card as HTMLElement).dataset.hasVastToken==='true',clearVastToken:checked('clearVastToken'),...(vastToken?{vastToken}:{}),vastContainerLabel:field('vastContainerLabel')};
  });
}
function renderModelRows(providers:ModelProvider[]){
  const list=$('model-list');list.replaceChildren();
  for(const provider of providers){
    const card=document.createElement('fieldset');card.className='model-card expanded';card.dataset.id=provider.id;card.dataset.hasApiKey=String(provider.hasApiKey===true);card.dataset.hasVastToken=String(provider.hasVastToken===true);
    const heading=document.createElement('div');heading.className='model-card-heading';
    const title=document.createElement('strong');title.textContent=provider.name||'Model';heading.append(title);
    const checkbox=(parent:HTMLElement,title:string,field:string,checked:boolean)=>{const label=document.createElement('label');label.className='request-setting';const input=document.createElement('input');input.type='checkbox';input.dataset.field=field;input.checked=checked;label.append(input,document.createTextNode(title));parent.append(label);return input;};
    checkbox(heading,'Active','enabled',provider.enabled!==false);
    const move=(delta:number)=>{const rows=readModelRows(),from=rows.findIndex(row=>row.id===provider.id),to=from+delta;if(to<0||to>=rows.length)return;[rows[from],rows[to]]=[rows[to],rows[from]];renderModelRows(rows);};
    for(const [label,delta] of [['Up',-1],['Down',1]] as const){const button=document.createElement('button');button.type='button';button.className='model-order-button';button.textContent=label;button.disabled=providers.indexOf(provider)+delta<0||providers.indexOf(provider)+delta>=providers.length;button.onclick=()=>move(delta);heading.append(button);}
    const remove=document.createElement('button');remove.type='button';remove.className='remove-model';remove.textContent='Remove';remove.onclick=()=>card.remove();heading.append(remove);card.append(heading);
    const grid=document.createElement('div');grid.className='model-fields';
    const typeLabel=document.createElement('label');typeLabel.className='model-field';typeLabel.textContent='Provider';const type=document.createElement('select');type.dataset.field='type';
    for(const [value,label] of [['openai-compatible','OpenAI Compatible'],['openai','OpenAI'],['openrouter','OpenRouter'],['vast-ai','Vast.ai'],['amazon-bedrock','Amazon Bedrock']])type.add(new Option(label,value));
    type.value=provider.type;typeLabel.append(type);grid.append(typeLabel);
    const name=settingField(grid,'Name','name',provider.name);name.oninput=()=>title.textContent=name.value||'Model';
    const endpoint=settingField(grid,'Base URL','baseUrl',provider.baseUrl,'url','https://...');
    const model=settingField(grid,'Model ID','model',provider.model,'text','Enter a model ID or refresh');
    const modelList=document.createElement('datalist');modelList.id=`model-options-${provider.id}`;model.setAttribute('list',modelList.id);grid.append(modelList);
    const refresh=document.createElement('button');refresh.type='button';refresh.className='model-refresh';refresh.textContent='Refresh models';grid.append(refresh);
    const modelStatus=document.createElement('small');modelStatus.className='model-discovery-status';grid.append(modelStatus);
    const apiKey=settingField(grid,'API key','apiKey',provider.apiKey??'','password',provider.hasApiKey?'Saved on server; blank keeps it':'Enter API key');
    const clearKey=checkbox(grid,'Remove saved API key','clearApiKey',provider.clearApiKey===true);
    const tokenless=checkbox(grid,'Tokenless server','tokenless',provider.tokenless===true);
    const region=settingField(grid,'AWS region','region',provider.region??'','text','eu-west-1');
    const vastToken=settingField(grid,'Vast.ai gateway token','vastToken',provider.vastToken??'','password',provider.hasVastToken?'Saved on server; blank keeps it':'Optional gateway token');
    const clearVast=checkbox(grid,'Remove saved gateway token','clearVastToken',provider.clearVastToken===true);
    const vastLabel=settingField(grid,'Vast.ai container label','vastContainerLabel',provider.vastContainerLabel??'','text','C.12345');
    const context=settingField(grid,'Context window (tokens)','contextWindow',String(provider.contextWindow??49152),'number');context.min='8192';context.step='1';
    const reasoningLabel=document.createElement('label');reasoningLabel.className='model-field';reasoningLabel.textContent='Reasoning';const reasoning=document.createElement('select');reasoning.dataset.field='reasoning';reasoning.add(new Option('Provider default',''));for(const value of ['off','minimal','low','medium','high','xhigh'])reasoning.add(new Option(value,value));reasoning.value=provider.reasoning??'';reasoningLabel.append(reasoning);grid.append(reasoningLabel);
    const updateFields=()=>{const bedrock=type.value==='amazon-bedrock',vast=type.value==='vast-ai';endpoint.parentElement!.hidden=bedrock;region.parentElement!.hidden=!bedrock;vastToken.parentElement!.hidden=!vast;clearVast.parentElement!.hidden=!vast;vastLabel.parentElement!.hidden=!vast;tokenless.parentElement!.hidden=type.value!=='openai-compatible';};
    type.onchange=()=>{if(type.value==='openai')endpoint.value='https://api.openai.com/v1';else if(type.value==='openrouter')endpoint.value='https://openrouter.ai/api/v1';updateFields();};updateFields();
    refresh.onclick=async()=>{
      refresh.disabled=true;modelStatus.textContent='Discovering models...';
      try{
        const row=readModelRows().find(row=>row.id===provider.id)!;
        const response=await fetch(`${worldApi}/models`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(row)});
        const data=await response.json() as {models?:ProviderModelOption[];error?:string};if(!response.ok)throw new Error(data.error??'Model discovery failed.');
        const models=data.models??[];modelList.replaceChildren(...models.map(value=>new Option(value.label,value.id)));
        if(!model.value&&models.length){model.value=models[0].id;if(models[0].contextWindow)context.value=String(models[0].contextWindow);}
        modelStatus.textContent=`${models.length} models available.`;
      }catch(error){modelStatus.textContent=error instanceof Error?error.message:'Model discovery failed.';}
      finally{refresh.disabled=false;}
    };
    apiKey.oninput=()=>{if(apiKey.value.trim())clearKey.checked=false;};vastToken.oninput=()=>{if(vastToken.value.trim())clearVast.checked=false;};
    card.append(grid);list.append(card);
  }
}
const inhabitantPortraits:Record<string,string>={
  Flint:new URL('./assets/flint.png',import.meta.url).href,
  Moss:new URL('./assets/moss.png',import.meta.url).href,
};
function troglodytePortrait(id:string){
  const colors=id==='t2'?{fur:'#493326',trim:'#b8874d',hair:'#302c26',skin:'#cfae83',beard:'#40352b'}:{fur:'#b8874d',trim:'#493326',hair:'#514d3e',skin:'#d9b98d',beard:'#514638'};
  return `<svg class="troglodyte-portrait" viewBox="0 0 48 52" aria-hidden="true"><rect width="48" height="52" rx="4" fill="#2c3b30"/><path d="M5 52 7 39q1-6 9-9l5-2h7l5 2q8 3 9 9l2 13Z" fill="${colors.fur}"/><path d="m9 39 5 2 4-2 5 3 5-3 5 3 5-3 5 2-1 11H7Z" fill="${colors.trim}"/><path d="m16 30 8 6 8-6 3 3-8 9h-6l-8-9Z" fill="${colors.fur}"/><path d="M18 25h12v8q-6 5-12 0Z" fill="${colors.skin}"/><ellipse cx="14" cy="17" rx="3" ry="4" fill="${colors.skin}"/><ellipse cx="34" cy="17" rx="3" ry="4" fill="${colors.skin}"/><path d="M15 12q0-8 9-9 10 1 10 10v7q-2 7-10 9-8-2-9-9Z" fill="${colors.skin}"/><path d="M14 14Q13 4 24 3q11 1 11 11l-3-3-2-4q-5 4-14 3l-1 5Z" fill="${colors.hair}"/><path d="M16 18q2 1 4 0m8 0q2 1 4 0" fill="none" stroke="#382f25" stroke-width="1.5" stroke-linecap="round"/><path d="M24 18v4l-2 1" fill="none" stroke="#a67f60" stroke-width="1.2" stroke-linecap="round"/><path d="M17 21q2-2 5 0h4q3-2 5 0l-1 6-3 4-3 2-3-2-3-4Z" fill="${colors.beard}"/><path d="m18 22 4 1 2-1 2 1 4-1" fill="none" stroke="${colors.beard}" stroke-width="2" stroke-linecap="round"/><path d="m16 30 8 6 8-6 2 3-6 6h-8l-6-6Z" fill="${colors.trim}"/><path d="m21 37 3 3 3-3" fill="none" stroke="${colors.fur}" stroke-width="2" stroke-linecap="round"/></svg>`;
}
function robotMaterial(entity:WorldState['entities'][number]){return entity.appearance?.material??(parseInt(entity.color.replace('#','').slice(0,2),16)>160?'steel':'iron');}
function robotPowerModuleLabel(entity:WorldState['entities'][number]){return entity.appearance?.powerModule==='lithium-battery'?' · Lithium Battery':entity.appearance?.powerModule==='nuclear-reactor'?' · Nuclear Reactor':'';}
function minerRobotPortrait(entity:WorldState['entities'][number]){
  const material=robotMaterial(entity),palette=material==='titanium'
    ?{base:entity.color,mid:'#d5e0e4',dark:'#819299',black:'#536167',light:'#ffffff'}
    :material==='steel'?{base:entity.color,mid:'#aeb8bb',dark:'#596366',black:'#31393b',light:'#eef3f4'}
    :{base:entity.color,mid:'#8c928e',dark:'#454b48',black:'#202624',light:'#aeb3ae'},width=entity.appearance?.widthScale??1,offset=24*(1-width);
  const moduleVisual=entity.appearance?.powerModule==='lithium-battery'
    ?'<path d="M6 25h36v19H6z" fill="#403f47"/><path d="M8 28h5v13H8zm27 0h5v13h-5z" fill="#c8bed8"/><path d="M20 27h8v3h-8z" fill="#8f82a3"/>'
    :entity.appearance?.powerModule==='nuclear-reactor'?'<path d="M5 25h38v19H5z" fill="#303638"/><circle cx="7" cy="34" r="5" fill="#77817e"/><circle cx="7" cy="34" r="2.5" fill="#d7eea3"/><circle cx="41" cy="34" r="5" fill="#77817e"/><circle cx="41" cy="34" r="2.5" fill="#d7eea3"/>':'';
  return `<svg class="miner-robot-portrait" viewBox="0 0 48 52" aria-hidden="true"><rect width="48" height="52" rx="4" fill="#2c3b30"/><g transform="translate(${offset} 0) scale(${width} 1)">${moduleVisual}<path d="M9 41h30v7H9z" fill="${palette.dark}"/><path d="M5 39h10v12H5zm28 0h10v12H33z" fill="${palette.black}"/><circle cx="10" cy="43" r="3" fill="${palette.mid}"/><circle cx="10" cy="48" r="2" fill="${palette.light}"/><circle cx="38" cy="43" r="3" fill="${palette.mid}"/><circle cx="38" cy="48" r="2" fill="${palette.light}"/><path d="M11 27h26v16H11z" fill="${palette.base}"/><path d="M16 23h16v5H16z" fill="${palette.dark}"/><path d="M8 10h32v15H8z" fill="${palette.mid}"/><path d="M11 14h26v8H11z" fill="${palette.black}"/><path d="M14 16h7v4h-7zm13 0h7v4h-7z" fill="#e2bd70"/><path d="M21 5h6v6h-6z" fill="${palette.dark}"/><path d="M22 6h4v3h-4z" fill="#f0d994"/><path d="M7 30h4v11H7zm30 0h4v11h-4z" fill="${palette.mid}"/></g></svg>`;
}
async function loadLlmSettings(){
  $('settings-status').textContent='Loading current configuration...';
  try{const response=await fetch(`${worldApi}/inference-config`);if(!response.ok)throw new Error();inferenceConfig=await response.json() as InferenceConfig;$<HTMLInputElement>('parallel-requests').checked=inferenceConfig.parallelRequests!==false;renderModelRows(inferenceConfig.providers);renderProviderStatus(inferenceConfig);$('settings-status').textContent='';}
  catch{$('settings-status').textContent='Could not load inference configuration.';}
}
function showSettings(open:boolean){
  $('main').classList.toggle('hidden',open);$('llm-settings').classList.toggle('hidden',!open);$('llm-settings').setAttribute('aria-hidden',String(!open));
  if(open)void loadLlmSettings();
}
function dayOf(tick:number){return worldTime(tick).day;}
async function loadProviderStatus(){
  try{const response=await fetch(`${worldApi}/inference-config`);if(!response.ok)return;inferenceConfig=await response.json() as InferenceConfig;if(meta){meta.inferenceConfig=inferenceConfig;renderProviderStatus();}}
  catch{/* Runtime status remains available while settings are unavailable. */}
}
function renderProviderStatus(config:InferenceConfig|undefined=meta?.inferenceConfig??inferenceConfig){
  const active=(config?.providers??[]).filter(provider=>provider.enabled!==false),list=$('provider-status-list');list.replaceChildren();
  for(const provider of active){
    const status=meta?.providerStatus?.[provider.id];
    const state=status?.inFlight?'in-flight':status?.state??'unknown';
    const label=state==='in-flight'?'Request in progress':state==='ok'?'Last request succeeded':state==='bad'?'Last request failed':'No request result yet';
    const row=document.createElement('li');row.className='provider-status-row';
    const dot=document.createElement('span');dot.className=`provider-status-dot ${state}`;dot.setAttribute('role','img');dot.setAttribute('aria-label',label);
    const name=document.createElement('span');name.className='provider-status-name';name.textContent=provider.name.trim()||'Unnamed model';
    row.title=[label,status?.detail,provider.model].filter(Boolean).join('\n');row.append(dot,name);list.append(row);
  }
}
function selectEntity(id: string) { selected = id; detailsSignature='';view.select(id);renderInspector();void loadMemory(); }
function acceptTurnSpeed(frame:Frame){
  const event=frame.events.findLast(candidate=>candidate.type==='turn-speed');if(!event)return;
  const duration=(event.data as {secondsPerTurn?:number}).secondsPerTurn,turns=Math.floor(event.tick/TURN_TICKS);
  if(!Number.isFinite(duration)||duration!<0||turns<1)return;
  shownSecondsPerTurn=shownSecondsPerTurn===undefined||turns===1?duration!:(shownSecondsPerTurn*(turns-1)+duration!)/turns;
}
async function loadMemory(){
  const request=++memoryRequest,actor=selected,tick=cursor;memoryView=undefined;renderDetails();
  try{const response=await fetch(`${worldApi}/memory-record?tick=${tick}&actor=${encodeURIComponent(actor)}`);if(!response.ok)throw new Error();const record=await response.json() as {notes:string[];learned?:string[]};if(request===memoryRequest){memoryView={actor,tick,...record};renderDetails();}}
  catch{if(request===memoryRequest){memoryView={actor,tick,notes:[]};renderDetails();}}
}
function setBoot(boot: Boot) {
  meta = boot; latest = boot.latestTick; liveDynamic = boot.state;shownMetrics=boot.metrics;shownSecondsPerTurn=boot.secondsPerTurn; liveCells.clear();liveRemoved.clear();
  for (const [x,y,z,kind] of boot.state.blocks) liveCells.set(key([x,y,z]),kind);
  for(const voxel of boot.state.removedBlocks??[])liveRemoved.add(voxel);
  if(!boot.state.entities.some(entity=>entity.id===selected)&&boot.state.entities[0]){selected=boot.state.entities[0].id;view.select(selected);}
  liveEvents = boot.events; $('loading').classList.add('hidden');
  renderProviderStatus(meta.inferenceConfig);if(!meta.inferenceConfig)void loadProviderStatus();
  $('module-name').textContent = meta.universe.name;
  renderWorldControls();
  if (isLive) goLive(); else renderTimeline();
}
const stream = new EventSource(`${worldApi}/stream`);
stream.addEventListener('boot', event => { setBoot(JSON.parse((event as MessageEvent).data)); });
stream.addEventListener('inference-config',event=>{
  if(!meta)return;meta.inferenceConfig=JSON.parse((event as MessageEvent).data) as InferenceConfig;inferenceConfig=meta.inferenceConfig;renderProviderStatus();
});
stream.addEventListener('status', event => {
  if (!meta) return;
  const packet=JSON.parse((event as MessageEvent).data) as {runtime:TurnStatus;inferenceConfig?:InferenceConfig;metrics?:Record<string,AgentMetrics>;providerStatus?:Record<string,ModelRequestStatus>};
  meta.runtime=packet.runtime;if(packet.inferenceConfig)meta.inferenceConfig=packet.inferenceConfig;if(packet.metrics){meta.metrics=packet.metrics;if(isLive)shownMetrics=packet.metrics;}if(packet.providerStatus)meta.providerStatus=packet.providerStatus;renderProviderStatus();
  renderTimeline(); renderInspector();renderWorldControls();
});
stream.addEventListener('frame', event => {
  const packet = JSON.parse((event as MessageEvent).data) as { frame: Frame; runtime: TurnStatus }, frame = packet.frame;
  if (!meta) return;
  latest = frame.tick; meta.runtime = packet.runtime; liveDynamic = frame;
  for (const [k,kind] of frame.changes) { if (kind){liveCells.set(k,kind);liveRemoved.delete(k);}else{liveCells.delete(k);if(meta.universe.terrain)liveRemoved.add(k);} }
  liveEvents = [...liveEvents,...frame.events].slice(-200);
  if (isLive) {
    const metricsEvent=frame.events.findLast(event=>event.type==='llm-metrics');if(metricsEvent)shownMetrics=metricsEvent.data as Record<string,AgentMetrics>;
    acceptTurnSpeed(frame);
    shown = { ...frame,blocks: [] }; cursor = frame.tick; events = liveEvents; view.update(frame);worldChat.add(frame.events);
    if (frame.events.length) renderJournal();
  }
  if(frame.events.some(event=>event.type==='memory'&&event.actor===selected))void loadMemory();
  if (performance.now()-lastUi > 200) { renderTimeline(); renderInspector(); lastUi = performance.now(); }
});

function goLive() {
  if (!meta || !liveDynamic) return;
  epoch++; replayRequest++; fetching = false; seeking = false; clearTimeout(seekTimer); isLive = true; playing = false; scrubTarget = null; replayFrames = [];
  shown = { ...liveDynamic, blocks: [...liveCells].map(([k,kind]) => [...unkey(k),kind]), ...(liveRemoved.size?{removedBlocks:[...liveRemoved]}:{}) };
  cursor = latest; shownMetrics=meta.metrics;shownSecondsPerTurn=meta.secondsPerTurn;events = liveEvents; view.load(shown,meta.universe);worldChat.reset(); detailsSignature='';renderTimeline();renderInspector();renderJournal();void loadMemory();
}
async function seek(tick: number) {
  const request = ++epoch; replayRequest++; fetching = false; seeking = true; isLive = false; playing = false; scrubTarget = null; replayFrames = []; view.hold();
  cursor = Math.min(latest,Math.max(0,tick)); renderTimeline();
  try {
    const response = await fetch(`${worldApi}/state?tick=${cursor}`); if (!response.ok) throw new Error('Could not load recorded history.');
    const data = await response.json() as Boot; if (request !== epoch) return;
    shown = data.state; cursor = shown.tick; replayClock = cursor;shownMetrics=data.recordedMetrics;shownSecondsPerTurn=data.recordedSecondsPerTurn;seeking = false; events = data.events; view.load(shown,meta.universe);worldChat.reset(data.events); detailsSignature='';renderTimeline();renderInspector();renderJournal();void loadMemory();
  } catch (error) { if (request === epoch) toast(error instanceof Error ? error.message : 'History unavailable.'); }
  finally { if (request === epoch) seeking = false; }
}
async function fetchReplay() {
  if (fetching || seeking || isLive || (!playing && scrubTarget === null) || performance.now() < nextReplayFetch || (replayFrames.at(-1)?.tick ?? cursor) >= Math.min(latest,scrubTarget ?? latest)) return;
  const request = ++replayRequest, modeEpoch = epoch; fetching = true;
  nextReplayFetch = performance.now() + 200;
  try {
    const after = replayFrames.at(-1)?.tick ?? cursor;
    const response = await fetch(`${worldApi}/frames?tick=${after}`); if (!response.ok) throw new Error('Replay fetch failed.');
    const data = await response.json() as Frame[];
    if (request === replayRequest && modeEpoch === epoch && !isLive) replayFrames.push(...data);
  } catch { if (modeEpoch === epoch) { playing = false; toast('Replay interrupted. Press play to retry.'); } }
  finally { if (request === replayRequest) fetching = false; }
}
function playback(now: number) {
  const dt = Math.min(now-lastPlayback,100); lastPlayback = now;
  if ((playing || scrubTarget !== null) && !isLive) {
    if (replayFrames.length < 80) void fetchReplay();
    if (replayFrames.length) {
      const destination = scrubTarget ?? replayFrames.at(-1)!.tick;
      const speed = scrubTarget === null ? Number($<HTMLSelectElement>('speed').value) : fastScrubSpeed(replayClock,destination);
      replayClock = advancePlayback(replayClock, dt, speed, Math.min(destination,replayFrames.at(-1)!.tick));
      let changed = false,memoryChanged=false;
      while (replayFrames.length && replayFrames[0].tick <= replayClock) {
        const frame = replayFrames.shift()!; cursor = frame.tick; shown = { ...frame,blocks: [] };const metricsEvent=frame.events.findLast(event=>event.type==='llm-metrics');if(metricsEvent)shownMetrics=metricsEvent.data as Record<string,AgentMetrics>;acceptTurnSpeed(frame);view.update(frame,false,speed);worldChat.add(frame.events); events = [...events,...frame.events].slice(-200); changed = true;memoryChanged ||= frame.events.some(event=>event.type==='memory'&&event.actor===selected);
      }
      if (changed) { renderTimeline(); renderInspector(); renderJournal(); }
      if(memoryChanged)void loadMemory();
      if (scrubTarget !== null && cursor >= scrubTarget) { scrubTarget = null; replayFrames = []; view.hold(); renderTimeline(); }
    }
    // Stay in replay at the recording edge. Only the Live button changes observer mode.
  }
  worldChat.render(now);requestAnimationFrame(playback);
}
requestAnimationFrame(playback);

function renderTimeline() {
  if (!meta) return;
  $('live').classList.toggle('active',isLive); $('play').textContent = isLive || playing ? 'Ⅱ' : '▶'; $('play').setAttribute('aria-label',isLive || playing ? 'Pause observation' : 'Play recording');
  $('playback-time').textContent = formatWorldDuration(cursor,true);
  $('time-to-live').textContent = isLive ? 'LIVE' : `${formatWorldDuration(Math.max(0,latest-cursor))} TO LIVE`;
  $('range-end').textContent = formatWorldDuration(latest);
  const sliderTick=scrubTarget??cursor,slider = $<HTMLInputElement>('seek'); slider.max = String(Math.max(2,latest)); slider.value = String(sliderTick); slider.style.setProperty('--progress',`${sliderTick/Math.max(1,latest)*100}%`);
  const count = dayOf(latest);
  if (count !== dayCount) { const day = $<HTMLSelectElement>('day'); day.replaceChildren(); for (let i = 1;i<=count;i++) { const option = new Option(`Day ${String(i).padStart(3,'0')}`,String(i)); day.add(option); } dayCount = count; }
  $<HTMLSelectElement>('day').value = String(dayOf(cursor));
  const marks = $('event-marks'); marks.replaceChildren();
  for (const event of liveEvents.filter(e => ['discovery','lost','memory','encounter','agent-error'].includes(e.type))) {
    const mark = document.createElement('i'); mark.style.left = `${event.tick/Math.max(1,latest)*100}%`; mark.className = event.type; mark.title = event.message; marks.append(mark);
  }
}
function renderInspector() {
  if (!shown) return;
  $('entity-count').textContent=String(shown.entities.length).padStart(2,'0');
  const list=$('entity-list');
  const visibleIds=new Set(shown.entities.map(entity=>`entity-${entity.id}`));
  for(const child of [...list.children])if(!visibleIds.has(child.id))child.remove();
  for(const e of shown.entities){
    const enabled=e.enabled!==false;
    const activity=entityDisplayStatus(e,meta.runtime,isLive),displayStatus=activity.text;
    const existing=document.getElementById(`entity-${e.id}`);
    if(existing){
      existing.classList.toggle('selected',e.id===selected);existing.classList.toggle('disabled',!enabled);
      const select=existing.querySelector<HTMLButtonElement>('.inhabitant-select')!;select.setAttribute('aria-pressed',String(e.id===selected));
      const toggle=existing.querySelector<HTMLInputElement>('.entity-toggle')!;toggle.checked=enabled;toggle.disabled=!isLive;
      const mode=existing.querySelector<HTMLSelectElement>('.entity-control-mode');if(mode){mode.value=e.controller==='automaton'?'automaton':'manual';mode.disabled=!isLive;}
      const status=existing.querySelector<HTMLElement>('.entity-status')!;status.textContent=displayStatus;status.title=activity.title??'';status.classList.toggle('thinking',activity.thinking);status.classList.toggle('error',displayStatus==='error');continue;
    }
    const row=document.createElement('div');row.className=`inhabitant ${e.id===selected?'selected':''} ${enabled?'':'disabled'}`;row.id=`entity-${e.id}`;
    const button=document.createElement('button');button.className='inhabitant-select';button.setAttribute('aria-pressed',String(e.id===selected));
    const avatar=document.createElement('span');avatar.className=`avatar ${e.kind}`;avatar.style.setProperty('--entity-color',e.color);avatar.setAttribute('aria-hidden','true');
    const portrait=e.kind==='troglodyte'?inhabitantPortraits[e.name]:undefined;
    if(portrait){
      const image=document.createElement('img');image.src=portrait;image.alt='';image.width=31;image.height=36;image.decoding='async';avatar.append(image);
    }else avatar.innerHTML=e.kind==='troglodyte'?troglodytePortrait(e.id):e.kind==='miner-robot'?minerRobotPortrait(e):'<i></i>';
    const text=document.createElement('span');text.className='inhabitant-text';const name=document.createElement('strong');name.textContent=e.name;
    const kind=document.createElement('small');kind.textContent=e.kind==='troglodyte'?'Troglodyte':e.kind==='miner-robot'?`${robotMaterial(e).replace(/^./,letter=>letter.toUpperCase())} Miner Robot${robotPowerModuleLabel(e)}`:'Duck · NPC';text.append(name,kind);
    const status=document.createElement('span');status.className=`entity-status ${activity.thinking?'thinking':''} ${displayStatus==='error'?'error':''}`;status.textContent=displayStatus;status.title=activity.title??'';
    const mode=document.createElement('select');mode.className='entity-control-mode';mode.setAttribute('aria-label',`${e.name} control mode`);mode.append(new Option('Manual','manual'),new Option('Automaton','automaton'));mode.value=e.controller==='automaton'?'automaton':'manual';mode.disabled=!isLive;mode.onchange=()=>void setEntityControlMode(e.id,mode.value as 'manual'|'automaton',mode);
    const toggle=document.createElement('input');toggle.type='checkbox';toggle.className='entity-toggle';toggle.checked=enabled;toggle.disabled=!isLive;toggle.title=`Enable ${e.name}`;toggle.setAttribute('aria-label',`Enable ${e.name}`);toggle.onchange=()=>void setEntityEnabled(e.id,toggle.checked,toggle);
    button.append(avatar,text,status);button.onclick=()=>selectEntity(e.id);button.ondblclick=()=>view.focus(e.id);row.append(button,...(e.kind==='miner-robot'?[mode]:[]),toggle);list.append(row);
  }
  renderDetails();
  renderStats();
}
function renderWorldControls(){
  if(!rosterLayout||!meta)return;
  const running=meta.runtime.enabled,state=$('roster-world-state'),play=$<HTMLButtonElement>('roster-play'),stop=$<HTMLButtonElement>('roster-stop');
  state.textContent=running?'Running':'Stopped';state.classList.toggle('running',running);play.disabled=running;stop.disabled=!running;
}
async function playWorld(){
  const play=$<HTMLButtonElement>('roster-play'),stop=$<HTMLButtonElement>('roster-stop'),reset=$<HTMLButtonElement>('roster-reset'),message=$('roster-control-message');play.disabled=true;stop.disabled=true;reset.disabled=true;message.textContent='Resuming world...';
  try{
    const response=await fetch(`${worldApi}/control`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({running:true})});
    const packet=await response.json() as Metadata&{error?:string};if(!response.ok)throw new Error(packet.error??'Could not resume the world.');
    meta.runtime=packet.runtime;message.textContent='World running.';renderWorldControls();
  }catch(error){message.textContent=error instanceof Error?error.message:'Could not resume the world.';}
  finally{reset.disabled=false;renderWorldControls();}
}
async function stopWorld(){
  const play=$<HTMLButtonElement>('roster-play'),stop=$<HTMLButtonElement>('roster-stop'),reset=$<HTMLButtonElement>('roster-reset'),message=$('roster-control-message');play.disabled=true;stop.disabled=true;reset.disabled=true;message.textContent='Stopping world...';
  try{
    const response=await fetch(`${worldApi}/control`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({running:false})});
    const packet=await response.json() as Metadata&{error?:string};if(!response.ok)throw new Error(packet.error??'Could not stop the world.');
    meta.runtime=packet.runtime;message.textContent='World stopped.';renderWorldControls();
  }catch(error){message.textContent=error instanceof Error?error.message:'Could not stop the world.';}
  finally{reset.disabled=false;renderWorldControls();}
}
async function resetWorld(){
  if(!window.confirm('Restart Robots vs Robots from zero? This permanently deletes its active history and cannot be undone.'))return;
  const play=$<HTMLButtonElement>('roster-play'),stop=$<HTMLButtonElement>('roster-stop'),reset=$<HTMLButtonElement>('roster-reset'),message=$('roster-control-message');play.disabled=true;stop.disabled=true;reset.disabled=true;message.textContent='Restarting world from zero...';
  try{
    const response=await fetch(`${worldApi}/control`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reset:true})});
    const packet=await response.json() as {error?:string};if(!response.ok)throw new Error(packet.error??'Could not restart the world.');window.location.reload();
  }catch(error){message.textContent=error instanceof Error?error.message:'Could not restart the world.';reset.disabled=false;renderWorldControls();}
}
let manualMovePending=false;
async function moveSelected(direction:'up'|'down'|'left'|'right'){
  if(manualMovePending||!meta.runtime.enabled)return;
  const entity=shown.entities.find(candidate=>candidate.id===selected),message=$('roster-move-message');
  if(!entity||entity.controller!=='static')return;
  manualMovePending=true;let moved=false;message.textContent='';
  try{
    const response=await fetch(`${worldApi}/control`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({entityId:entity.id,manualDirection:direction})});
    const packet=await response.json() as Metadata&{entity?:WorldState['entities'][number];result?:{ok:boolean;message:string};error?:string};
    if(!response.ok)throw new Error(packet.error??'Could not move the selected character.');
    meta.runtime=packet.runtime;moved=packet.result?.ok===true;
    if(packet.entity){const live=liveDynamic.entities.find(candidate=>candidate.id===entity.id);if(live)Object.assign(live,packet.entity);const visible=shown.entities.find(candidate=>candidate.id===entity.id);if(visible)Object.assign(visible,packet.entity);}
    message.textContent=packet.result?.ok?'':packet.result?.message??'';renderInspector();
  }catch(error){message.textContent=error instanceof Error?error.message:'Could not move the selected character.';}
  finally{window.setTimeout(()=>{manualMovePending=false;},moved?280:0);}
}
async function setEntityEnabled(id: string, enabled: boolean, toggle: HTMLInputElement) {
  toggle.disabled = true;
  try {
    const response = await fetch(`${worldApi}/control`,{ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entityId: id, entityEnabled: enabled }) });
    if (!response.ok) throw new Error();
    const packet = await response.json() as Metadata & { entity: WorldState['entities'][number] };
    Object.assign(meta,packet);
    const live = liveDynamic.entities.find(entity => entity.id === id); if (live) Object.assign(live,packet.entity);
    if (isLive) { const visible = shown.entities.find(entity => entity.id === id); if (visible) Object.assign(visible,packet.entity); }
    renderInspector();
  } catch {
    toggle.checked = !enabled; toggle.disabled = !isLive; toast('Could not change inhabitant state. Check the connection.');
  }
}
async function setEntityControlMode(id:string,controlMode:'manual'|'automaton',select:HTMLSelectElement){
  select.disabled=true;
  try{
    const response=await fetch(`${worldApi}/control`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({entityId:id,controlMode})});
    const packet=await response.json() as Metadata&{entity:WorldState['entities'][number];error?:string};if(!response.ok)throw new Error(packet.error??'Could not change control mode.');
    Object.assign(meta,packet);const live=liveDynamic.entities.find(entity=>entity.id===id);if(live)Object.assign(live,packet.entity);const visible=shown.entities.find(entity=>entity.id===id);if(visible)Object.assign(visible,packet.entity);renderInspector();
  }catch(error){select.value=controlMode==='manual'?'automaton':'manual';$('roster-move-message').textContent=error instanceof Error?error.message:'Could not change control mode.';}
  finally{select.disabled=!isLive;}
}
function renderDetails() {
  const e = shown.entities.find(e => e.id === selected); if (!e) return;
  const signature=JSON.stringify({id:e.id,name:e.name,kind:e.kind,status:e.status,enabled:e.enabled,inventory:e.inventory,intent:e.intent,memory:memoryView,knowledge:shown.discoveries?.[selected]});
  const panel = $('details'),recordPanel=$('record-knowledge');
  if(signature===detailsSignature){
    const position=panel.querySelector<HTMLElement>('[data-detail="Position"] .detail-value');if(position)position.textContent=`${e.position.map(v=>v.toFixed(1)).join(' / ')} / ${Math.round(e.yaw)}º`;
    return;
  }
  detailsSignature=signature;panel.replaceChildren();recordPanel.replaceChildren();
  const held=e.inventory?.selected===null||!e.inventory?undefined:e.inventory.stacks[e.inventory.selected];
  const inventory=e.inventory?.stacks.map((stack,index)=>`${index}: ${stack.count} × ${stack.kind}${stack.contents?` (${stack.contents})`:''}`).join(', ')??'Empty';
  const pairs = [['Position',`${e.position.map(v => v.toFixed(1)).join(' / ')} / ${Math.round(e.yaw)}º`],['Hands',held?`${held.kind}${held.contents?` · ${held.contents}`:''}`:'Empty'],['Inventory',inventory],['Perception',`${meta.universe.perception.range} m · ${meta.universe.perception.fieldOfView}°`],['Speech',`${meta.universe.perception.range} m · clear line of sight`]];
  for (const [label,value] of pairs) { const row = document.createElement('div'); row.className = 'detail-row';row.dataset.detail=label; const a = document.createElement('span'); a.textContent = label; const b = document.createElement('span');b.className='detail-value'; b.textContent = value; row.append(a,b); panel.append(row); }
  if(e.controller==='agent'){
    const section=document.createElement('section');section.className='agent-intent';section.setAttribute('aria-label','Agent-authored intent');
    const label=document.createElement('h4');label.textContent='Intent in this record';section.append(label);
    if(e.intent){
      const rows=[`Goal: ${e.intent.goal}`,`Success condition: ${e.intent.successCondition}`,`Status: ${e.intent.status} (agent assessment)`,...(e.intent.nextStep?[`Next step: ${e.intent.nextStep}`]:[]),...(e.intent.expectedObservation?[`Expected observation: ${e.intent.expectedObservation}`]:[]),...(e.intent.reconsiderWhen?[`Reconsider when: ${e.intent.reconsiderWhen}`]:[]),...(e.intent.assessment?[`Assessment: ${e.intent.assessment}`]:[])];
      for(const text of rows){const paragraph=document.createElement('p');paragraph.textContent=text;section.append(paragraph);}
    }else{const paragraph=document.createElement('p');paragraph.className='muted';paragraph.textContent='No intent recorded yet.';section.append(paragraph);}
    panel.append(section);
  }
  const label = document.createElement('h4'); label.textContent = 'Private Notes in This Record'; recordPanel.append(label);
  if(memoryView?.actor!==selected){const p=document.createElement('p');p.className='muted';p.textContent='Loading private memory.';recordPanel.append(p);}
  else if(!memoryView.notes.length){const p=document.createElement('p');p.className='muted';p.textContent='No private memory notes yet.';recordPanel.append(p);}
  else for(const note of memoryView.notes){const p=document.createElement('p');p.textContent=note;recordPanel.append(p);}
  const knowledgeLabel=document.createElement('h4');knowledgeLabel.textContent='Learned Knowledge';recordPanel.append(knowledgeLabel);
  const learned=(memoryView?.actor===selected?memoryView.learned:undefined)??(shown.discoveries?.[selected]??[]).map(knowledge=>knowledgeDescription(knowledge,loadUniverse(universeId!).crafting));
  if(!learned.length){const p=document.createElement('p');p.className='muted';p.textContent='Nothing discovered yet.';recordPanel.append(p);}
  else for(const knowledge of learned){const p=document.createElement('p');p.textContent=knowledge;recordPanel.append(p);}
}
function renderStats(){
  if(!shown||!meta)return;
  const turns=Math.floor(cursor/TURN_TICKS),realSeconds=shownSecondsPerTurn===undefined?undefined:turns*shownSecondsPerTurn;
  const gameToRealRatio=realSeconds===undefined||realSeconds===0||turns===0?undefined:turns/realSeconds;
  const totals=Object.values(shownMetrics??{}).reduce((sum,metrics)=>({
    calls:sum.calls+(metrics.llmCalls??0),output:sum.output+(metrics.outputTokens??0),input:sum.input+(metrics.inputTokens??0),cache:sum.cache+(metrics.cachedInputTokens??0),
  }),{calls:0,output:0,input:0,cache:0});
  const callsPerTurn=turns?totals.calls/turns:undefined;
  const rows:[string,string][]=[
    ['Turns/Speed',`${Math.floor(cursor/TURN_TICKS)} turns (${shownSecondsPerTurn===undefined?'—':shownSecondsPerTurn.toFixed(2)} sec/turn)`],
    ['Game/Real Time',gameToRealRatio===undefined?'—':`${(gameToRealRatio*100).toFixed(1)} %`],
    ['Calls/Calls-Turn Ratio',shownMetrics?`${totals.calls.toLocaleString('en-US')} (${callsPerTurn===undefined?'—':callsPerTurn.toLocaleString('en-US',{maximumFractionDigits:2})+':1'})`:'—'],
    ['Tokens out',shownMetrics?`${totals.output.toLocaleString('en-US')} tok`:'— tok'],
    ['Tokens in',shownMetrics?`${totals.input.toLocaleString('en-US')} tok`:'— tok'],
    ['Cached tokens',shownMetrics?`${totals.cache.toLocaleString('en-US')} tok`:'— tok'],
    ['Cache hit',shownMetrics&&totals.input>0?`${(totals.cache/totals.input*100).toFixed(1)} %`:'—%'],
  ];
  const signature=JSON.stringify({rows,hasSnapshot:shownMetrics!==undefined});if(signature===statsSignature)return;
  statsSignature=signature;
  const panel=$('stats-rows');panel.replaceChildren();
  for(const [label,value] of rows){const row=document.createElement('div');row.className='detail-row';row.dataset.detail=label;const name=document.createElement('span');name.textContent=label;const detail=document.createElement('span');detail.className='detail-value';detail.textContent=value;row.append(name,detail);panel.append(row);}
}
function renderJournal() {
  const journal = $('journal'), wasAtTop = journal.scrollTop < 20; journal.replaceChildren();
  const visible = events.filter(e => !['observation','tool-result','decision','turn','llm-metrics','turn-speed'].includes(e.type)).reverse(); $('event-count').textContent = String(visible.length);
  for (const event of visible) {
    const row = document.createElement('article'); row.className = `journal-entry ${event.type}`;
    const time = document.createElement('button'); time.className = 'event-time'; time.textContent = formatWorldDuration(event.tick); time.title = 'Jump to this recorded moment'; time.onclick = () => void seek(event.tick);
    const content = document.createElement('div'); const header = document.createElement('div'); header.className = 'event-heading';
    const actor = document.createElement('strong'); actor.textContent = shown?.entities.find(e => e.id === event.actor)?.name ?? 'World';
    const type = document.createElement('span'); type.textContent = journalEventLabel(event); header.append(actor,type);
    const message = document.createElement('p'); message.textContent = journalEventMessage(event); content.append(header,message);
    if (event.data) { const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = 'Trace'; const pre = document.createElement('pre'); pre.textContent = JSON.stringify(event.data,null,2); details.append(summary,pre); content.append(details); }
    row.append(time,content); journal.append(row);
  }
  if (!visible.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'No events at this point in the recording.'; journal.append(empty); }
  if (wasAtTop) journal.scrollTop = 0;
}
function journalEventLabel(event:WorldEvent) {
  if(event.type==='intent')return 'Agent intent';
  if(event.type==='action'||event.type==='rejected'){
    const action=(event.data as {action?:{action?:string}}|undefined)?.action?.action??'action';
    const labels:Record<string,string>={walk:'Walking',run:'Running',jump:'Jumping',turn:'Turning',wait:'Waiting',find_material:'Scanning for materials',find_entity:'Searching for living beings',hit:'Striking a block',dig:'Digging with a shovel',strike_held:'Crafting with wood',join:'Joining door halves',open:'Opening a door',close:'Closing a door',place:'Placing an item',throw:'Throwing an item',pickup:'Picking up an item',hold:'Taking an item in hand',store:'Putting an item away',fill:'Filling a bucket',empty:'Emptying a bucket',say:'Speaking',follow:'Following',stop_follow:'Stopping following'};
    const label=labels[action]??'Action';return event.type==='rejected'?`${label} failed`:label;
  }
  const labels:Record<string,string>={damage:'Block damaged',discovery:'Learned',memory:'Private note','memory-compaction':'Memory maintenance',arrived:'Movement complete',scanned:'Material scan complete',blocked:'Movement blocked',collision:'Collision',settled:'Block settled',lost:'Item lost',speech:'Speech',encounter:'Encounter',collapse:'Tree collapse',reflection:'Reflection','context-compaction':'Conversation compaction','context-compacted':'Conversation compacted','agent-error':'Agent paused','entity-control':'Entity control','entity-arrival':'Entity arrival','knowledge-correction':'Knowledge update','follow-ended':'Follow ended','follow-blocked':'Follow blocked',splash:'Water splashed'};
  return labels[event.type]??event.type.replaceAll('-',' ');
}
function journalEventMessage(event:WorldEvent) {
  if(event.type==='action'||event.type==='rejected'){
    const result=(event.data as {result?:{message?:string}}|undefined)?.result;
    if(result?.message)return result.message;
  }
  return event.message;
}
$('settings-open').onclick=()=>showSettings(true);
$('settings-back').onclick=()=>showSettings(false);
$('debug-toggle').onclick=()=>{
  const panel=$('debug-panel'),open=panel.classList.contains('collapsed');panel.classList.toggle('collapsed',!open);
  $('main').classList.toggle('debug-open',open);$('debug-toggle').setAttribute('aria-expanded',String(open));$('debug-toggle').setAttribute('aria-label',`${open?'Collapse':'Expand'} debug panel`);$('debug-toggle').title=`${open?'Collapse':'Expand'} debug panel`;
};
$('focus-toggle').onclick=()=>{
  const panel=$('inspector'),open=panel.classList.contains('collapsed');panel.classList.toggle('collapsed',!open);
  $('main').classList.toggle('focus-collapsed',!open);$('focus-toggle').setAttribute('aria-expanded',String(open));$('focus-toggle').setAttribute('aria-label',`${open?'Collapse':'Expand'} Properties panel`);$('focus-toggle').title=`${open?'Collapse':'Expand'} Properties panel`;
};
$('add-model').onclick=()=>{
  const rows=readModelRows(),number=rows.length+1;renderModelRows([...rows,{id:`model-${Date.now()}-${number}`,type:'openai-compatible',name:`Model ${number}`,enabled:false,baseUrl:'',model:'',contextWindow:49152}]);
};
$<HTMLFormElement>('llm-settings-form').onsubmit=async event=>{
  event.preventDefault();const status=$('settings-status');status.textContent='Saving configuration...';
  try{
    const response=await fetch(`${worldApi}/inference-config`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:1,parallelRequests:$<HTMLInputElement>('parallel-requests').checked,providers:readModelRows()})});
    const data=await response.json() as Metadata&{inferenceConfig?:InferenceConfig;error?:string};if(!response.ok)throw new Error(data.error??'Could not save configuration.');
    if(meta){meta.mode=data.mode;meta.model=data.model;}
    if(data.inferenceConfig){inferenceConfig=data.inferenceConfig;if(meta)meta.inferenceConfig=inferenceConfig;}
    $<HTMLInputElement>('parallel-requests').checked=inferenceConfig.parallelRequests!==false;renderModelRows(inferenceConfig.providers);renderProviderStatus(inferenceConfig);status.textContent='Configuration saved.';
  }catch(error){status.textContent=error instanceof Error?error.message:'Could not save configuration.';}
};
$('live').onclick = goLive;
$('play').onclick = () => {
  if (!meta || seeking) return;
  if (isLive) { isLive = false; playing = false; replayClock = cursor; epoch++; view.hold(); }
  else { playing = !playing; replayClock = cursor; if (playing) void fetchReplay(); else view.hold(); }
  renderTimeline();
};
$<HTMLInputElement>('seek').oninput = event => {
  const tick=Number((event.target as HTMLInputElement).value);clearTimeout(seekTimer);
  if(tick<=cursor){scrubTarget=null;playing=false;seeking=true;view.hold();renderTimeline();seekTimer=setTimeout(()=>void seek(tick),60);return;}
  if(isLive){isLive=false;epoch++;replayRequest++;fetching=false;replayFrames=[];}
  seeking=false;playing=false;scrubTarget=Math.min(latest,tick);replayClock=cursor;renderTimeline();void fetchReplay();
};
$<HTMLSelectElement>('day').onchange = event => void seek((Number((event.target as HTMLSelectElement).value)-1)*WORLD_DAY_SECONDS*20);
$('overview').onclick = () => view.overview(); $('top-down').onclick = () => view.topDown(); $('follow').onclick = () => view.focus(selected);
$('roster-play').onclick=()=>void playWorld();$('roster-stop').onclick=()=>void stopWorld();$('roster-reset').onclick=()=>void resetWorld();
window.addEventListener('keydown',event=>{
  if(!rosterLayout||!isLive||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey)return;
  if((event.target as HTMLElement|null)?.closest('input,select,textarea,button,[contenteditable="true"]'))return;
  const directions:Record<string,'up'|'down'|'left'|'right'>={ArrowUp:'up',ArrowDown:'down',ArrowLeft:'left',ArrowRight:'right'},direction=directions[event.key];
  if(!direction||shown?.entities.find(entity=>entity.id===selected)?.controller!=='static')return;
  event.preventDefault();void moveSelected(direction);
});
window.addEventListener('beforeunload', () => { stream.close();worldChat.dispose(); view.dispose(); });
