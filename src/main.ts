import './style.css';
import { WorldView } from './view/world-view';
import { advancePlayback, fastScrubSpeed } from './view/playback-clock';
import { formatWorldDuration, worldTime, WORLD_DAY_SECONDS, TURN_TICKS, type TurnStatus } from './core/time';
import { key, unkey, type Frame, type ModuleManifest, type WorldEvent, type WorldState } from './core/types';
import { knowledgeDescription } from './core/knowledge';
import { PLAN_REVIEW_INTERVAL } from './core/memory';

interface ProviderHealth {state:'unknown'|'ok'|'bad';detail:string;inFlight?:boolean;}
interface Metadata { module: ModuleManifest; mode: 'demo' | 'llm'; model: string; providerStrategy:string; llmConfig?:LlmConfig; parallelRequests: boolean; latestTick: number; maxTurns: number | null; runtime: TurnStatus; }
interface Boot extends Metadata { state: WorldState; events: WorldEvent[]; }
interface LlmProvider {id:string;type:string;enabled:boolean;name:string;baseUrl:string;model:string;region?:string;displayModel?:string;apiKeyConfigured:boolean;apiKeyRemoved?:boolean;tokenless?:boolean;apiKeySource?:'own'|'provider';apiKeySavedType?:string;apiKeyCleared?:boolean;apiKey?:string;health?:ProviderHealth;}
interface LlmConfig {strategy:string;currentStatus?:string;providers:LlmProvider[];}
interface ProviderModelOption {id:string;label:string;}
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
        <section class="turn-status-section"><h2>Turn status</h2><ul id="provider-status-list" class="provider-status-list" aria-label="Configured models"></ul><p id="provider-algorithm" class="provider-algorithm"></p><p id="provider-current-status" class="provider-current-status empty" role="status" aria-hidden="true"></p><p id="turn-status" role="status">One turn = one world second</p><div id="toast" role="status"></div></section>
        <section class="journal-section"><header class="journal-heading"><h2>Journal</h2><span id="event-count">0</span></header><div id="journal" class="journal"><p class="empty">Waiting for the first trace.</p></div></section>
      </div>
    </aside>
    <aside id="inspector" class="inspector" aria-label="Properties">
      <header class="panel-heading"><h2>Properties</h2><button id="focus-toggle" class="panel-toggle" type="button" aria-expanded="true" aria-label="Collapse Properties panel" title="Collapse Properties panel"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg><span>Properties</span></button></header>
      <section class="inhabitants"><div class="section-heading"><h2>Inhabitants</h2><span id="entity-count">03</span></div><div id="entity-list"></div></section>
      <section id="record-knowledge" class="record-knowledge" aria-label="Private notes and learned knowledge"></section>
      <section class="focus-section"><div id="details" class="details"></div></section>
    </aside>
  </main>
  <section id="llm-settings" class="settings-screen hidden" aria-labelledby="settings-title" aria-hidden="true">
    <header class="settings-header"><button id="settings-back" class="settings-back">Back</button><div><span class="eyebrow">EMERGENT / SETTINGS</span><h1 id="settings-title">Settings</h1></div></header>
    <div class="settings-content">
      <section class="settings-section"><h2>Request settings</h2><label class="request-setting" title="Changes apply from the next turn."><input id="parallel-requests" type="checkbox" checked disabled>Parallel requests</label></section>
      <form id="llm-settings-form">
        <section class="settings-section"><div class="settings-section-heading"><div><h2>LLM configuration</h2><p>Choose one or more providers and models for agent requests.</p></div><button id="add-model" class="secondary-button" type="button">Add model</button></div><div id="model-list" class="model-list"></div><p class="settings-note">Amazon Bedrock uses an API key and AWS region. Anthropic's native adapter is not connected yet.</p></section>
        <section class="settings-section algorithm-section"><label for="settings-strategy"><h2>Selection algorithm</h2></label><select id="settings-strategy"><option value="first-only">Single model</option><option value="round-robin">Round robin</option><option value="fallback">Fallback</option><option value="master-slaves">Master / slaves</option></select><p id="strategy-description" class="settings-note">Use only the first active model in the list.</p></section>
        <div class="settings-actions"><span id="settings-status" role="status"></span><button class="save-button" type="submit">Save configuration</button></div>
      </form>
    </div>
  </section>
`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let view: WorldView;
try { view = new WorldView($('world'), id => selectEntity(id)); }
catch { $('loading').textContent = 'WebGL is unavailable. Enable hardware acceleration and reload to observe the world.'; throw new Error('WebGL unavailable.'); }
let meta: Metadata;
let shown: WorldState;
let liveDynamic: Omit<WorldState,'blocks'>;
const liveCells = new Map<string,string>();
let latest = 0, selected = 't1', isLive = true, playing = false, cursor = 0, scrubTarget: number | null = null, events: WorldEvent[] = [], liveEvents: WorldEvent[] = [];
let epoch = 0, seekTimer: ReturnType<typeof setTimeout>, replayFrames: Frame[] = [], fetching = false, replayClock = 0, replayRequest = 0, lastPlayback = performance.now(), lastUi = 0, nextReplayFetch = 0, seeking = false;
let dayCount = 0,detailsSignature='';
let memoryRequest=0,memoryView:{actor:string;tick:number;notes:string[]}|undefined;

function toast(message: string) { $('toast').textContent = message; $('toast').classList.add('visible'); setTimeout(() => $('toast').classList.remove('visible'),3500); }
let llmConfig:LlmConfig={strategy:'first-only',providers:[]};
const modelOptionsCache=new Map<string,ProviderModelOption[]>();
function settingField(parent:HTMLElement,title:string,field:string,value:string,type='text',placeholder=''){
  const label=document.createElement('label');label.className='model-field';label.textContent=title;
  const input=document.createElement('input');input.type=type;input.dataset.field=field;input.value=value;input.placeholder=placeholder;input.autocomplete=type==='password'?'new-password':'off';label.append(input);parent.append(label);return input;
}
function readModelRows():LlmProvider[]{
  return Array.from($('model-list').children).map(card=>{
    const field=(name:string)=>(card.querySelector(`[data-field="${name}"]`) as HTMLInputElement|HTMLSelectElement).value;
    const enabled=(card.querySelector('[data-field="enabled"]') as HTMLInputElement).checked;
    const apiKey=card.querySelector('[data-field="apiKey"]') as HTMLInputElement;
    const tokenless=(card.querySelector('[data-field="tokenless"]') as HTMLInputElement).checked;
    const apiKeySource=apiKey.dataset.keySource as LlmProvider['apiKeySource'];
    const apiKeySavedType=apiKey.dataset.savedType||undefined,apiKeyCleared=apiKey.dataset.clear==='true',apiKeyRemoved=apiKey.dataset.removed==='true';
    return{id:(card as HTMLElement).dataset.id!,type:field('type'),enabled,name:field('name'),baseUrl:field('baseUrl'),model:field('model'),region:field('region'),apiKey:apiKey.value,apiKeyConfigured:!!apiKeySavedType||!!apiKeySource,apiKeyRemoved,tokenless,...(apiKeySource?{apiKeySource}:{}),...(apiKeySavedType?{apiKeySavedType}:{}),...(apiKeyCleared?{apiKeyCleared:true}:{})};
  });
}
function renderModelRows(providers:LlmProvider[]){
  const list=$('model-list');list.replaceChildren();
  for(const provider of providers){
    const card=document.createElement('fieldset');card.className='model-card';card.dataset.id=provider.id;
    const heading=document.createElement('div');heading.className='model-card-heading';
    const expand=document.createElement('button');expand.type='button';expand.className='model-expand';expand.textContent='+';expand.title='Expand model settings';expand.setAttribute('aria-label',`Expand ${provider.name} settings`);expand.setAttribute('aria-expanded','false');heading.append(expand);
    const enabledLabel=document.createElement('label');enabledLabel.className='model-enabled';enabledLabel.title='Include this model in the selection strategy.';
    const enabledInput=document.createElement('input');enabledInput.type='checkbox';enabledInput.dataset.field='enabled';enabledInput.checked=provider.enabled!==false;
    const enabledText=document.createElement('span');enabledText.textContent='Active';enabledLabel.append(enabledInput,enabledText);
    const titleBlock=document.createElement('span');titleBlock.className='model-title';
    const title=document.createElement('strong');title.textContent=provider.name||'Model';
    const summary=document.createElement('small');summary.textContent=provider.model||provider.type;titleBlock.append(title,summary);heading.append(titleBlock);
    const order=document.createElement('div');order.className='model-order-controls';
    const move=(delta:number)=>{const rows=readModelRows(),from=rows.findIndex(row=>row.id===provider.id),to=from+delta;if(to<0||to>=rows.length)return;[rows[from],rows[to]]=[rows[to],rows[from]];renderModelRows(rows);};
    const up=document.createElement('button');up.type='button';up.className='model-order-button';up.textContent='↑';up.title='Move model up';up.setAttribute('aria-label',`Move ${provider.name} up`);up.disabled=providers.indexOf(provider)===0;up.onclick=()=>move(-1);
    const down=document.createElement('button');down.type='button';down.className='model-order-button';down.textContent='↓';down.title='Move model down';down.setAttribute('aria-label',`Move ${provider.name} down`);down.disabled=providers.indexOf(provider)===providers.length-1;down.onclick=()=>move(1);
    order.append(up,down);heading.append(order);
    heading.append(enabledLabel);
    const remove=document.createElement('button');remove.type='button';remove.className='remove-model';remove.textContent='Remove';remove.onclick=()=>{card.remove();updateStrategyControl();};heading.append(remove);card.append(heading);
    const grid=document.createElement('div');grid.className='model-fields';
    grid.hidden=true;
    const typeLabel=document.createElement('label');typeLabel.className='model-field';typeLabel.textContent='Provider';
    const type=document.createElement('select');type.dataset.field='type';
    for(const [value,labelText,disabled] of [['openai-compatible','OpenAI Compatible',false],['openai','OpenAI',false],['openrouter','OpenRouter',false],['amazon-bedrock','Amazon Bedrock',false],['anthropic','Anthropic (adapter pending)',true]] as [string,string,boolean][]){const option=new Option(labelText,value);option.disabled=disabled;type.add(option);}
    type.value=provider.type;typeLabel.append(type);grid.append(typeLabel);
    const nameInput=settingField(grid,'Name','name',provider.name);
    const endpoint=settingField(grid,'Base URL','baseUrl',provider.baseUrl,'url','https://...');
    const modelField=document.createElement('div');modelField.className='model-field';
    const modelLabel=document.createElement('label');modelLabel.textContent='Model';modelLabel.htmlFor=`model-picker-${provider.id}`;
    const modelControl=document.createElement('div');modelControl.className='model-picker-control';
    const modelSelect=document.createElement('select');modelSelect.id=modelLabel.htmlFor;modelSelect.dataset.field='model';
    if(provider.model)modelSelect.add(new Option(provider.model,provider.model));else modelSelect.add(new Option('Refresh to detect models',''));
    const refreshModelsButton=document.createElement('button');refreshModelsButton.type='button';refreshModelsButton.className='model-refresh';refreshModelsButton.textContent='Refresh';refreshModelsButton.title='Refresh available models';
    const modelStatus=document.createElement('small');modelStatus.className='model-discovery-status';modelControl.append(modelSelect,refreshModelsButton);modelField.append(modelLabel,modelControl,modelStatus);grid.append(modelField);
    const apiKey=settingField(grid,'API key','apiKey',provider.apiKey??'', 'password');
    const region=settingField(grid,'AWS region','region',provider.region??'','text','e.g. eu-west-1');
    const tokenlessField=document.createElement('label');tokenlessField.className='request-setting tokenless-setting';tokenlessField.title='Never send an Authorization header to this OpenAI-compatible server.';
    const tokenlessInput=document.createElement('input');tokenlessInput.type='checkbox';tokenlessInput.dataset.field='tokenless';tokenlessInput.checked=provider.tokenless===true;
    const tokenlessText=document.createElement('span');tokenlessText.textContent='Tokenless server';tokenlessField.append(tokenlessInput,tokenlessText);grid.append(tokenlessField);
    const endpointField=endpoint.closest('.model-field')!,apiKeyField=apiKey.closest('.model-field')!,regionField=region.closest('.model-field')!;
    const savedKeyType=provider.apiKeySavedType??(provider.apiKeyConfigured&&provider.apiKeySource!=='provider'?provider.type:'');apiKey.dataset.savedType=savedKeyType;apiKey.dataset.clear=String(provider.apiKeyCleared===true);apiKey.dataset.removed=String(provider.apiKeyRemoved===true);
    const clearKeyButton=document.createElement('button');clearKeyButton.type='button';clearKeyButton.className='api-key-clear';
    const apiKeyStatus=document.createElement('small');apiKeyStatus.className='api-key-status';apiKeyField.append(clearKeyButton,apiKeyStatus);
    const updateProviderFields=()=>{
      const bedrock=type.value==='amazon-bedrock',openaiCompatible=type.value==='openai-compatible';if(!openaiCompatible)tokenlessInput.checked=false;endpointField.classList.toggle('hidden',bedrock);apiKeyField.classList.toggle('hidden',openaiCompatible&&tokenlessInput.checked);regionField.classList.toggle('hidden',!bedrock);tokenlessField.classList.toggle('hidden',!openaiCompatible);
      const clearing=apiKey.dataset.clear==='true',removed=apiKey.dataset.removed==='true'&&type.value===provider.type,ownKey=!clearing&&!removed&&apiKey.dataset.savedType===type.value;
      const providerKey=!clearing&&!removed&&!ownKey&&llmConfig.providers.some(candidate=>candidate.type===type.value&&candidate.apiKeyConfigured);
      apiKey.dataset.keySource=ownKey?'own':providerKey?'provider':'';
      apiKey.placeholder=clearing?'Token will be removed when saved':removed?'No token saved for this model':ownKey?'Saved on server; blank keeps it':providerKey?'Saved provider key; blank reuses it':type.value==='openai-compatible'?'Enter API key (optional for local models)':'Enter API key';
      clearKeyButton.hidden=apiKey.dataset.savedType!==type.value&&!clearing;clearKeyButton.textContent=clearing?'Undo token removal':'Remove saved token';apiKeyStatus.textContent=clearing?'The model is inactive until a token is configured.':'';
    };
    tokenlessInput.onchange=updateProviderFields;
    type.onchange=()=>{
      if(type.value==='openai')endpoint.value='https://api.openai.com/v1';else if(type.value==='openrouter')endpoint.value='https://openrouter.ai/api/v1';else if(!endpoint.value||endpoint.value.includes('api.openai.com')||endpoint.value.includes('openrouter.ai'))endpoint.value='';
      modelSelect.replaceChildren(new Option('Loading models…',''));modelStatus.textContent='';updateProviderFields();summary.textContent=type.options[type.selectedIndex]?.text||type.value;void refreshModels(true);
    };
    updateProviderFields();
    const updateActive=()=>{card.classList.toggle('disabled-model',!enabledInput.checked);updateStrategyControl();};
    enabledInput.onchange=updateActive;updateActive();
    const restoreAfterTokenRemoval=()=>{apiKey.dataset.clear='false';apiKey.dataset.removed='false';if(apiKey.dataset.wasEnabled==='true')enabledInput.checked=true;updateActive();updateProviderFields();};
    clearKeyButton.onclick=event=>{event.preventDefault();event.stopPropagation();if(apiKey.dataset.clear==='true'){restoreAfterTokenRemoval();return;}apiKey.dataset.wasEnabled=String(enabledInput.checked);apiKey.dataset.clear='true';apiKey.value='';enabledInput.checked=false;updateActive();updateProviderFields();};
    apiKey.oninput=()=>{if(apiKey.value.trim()&&apiKey.dataset.clear==='true')restoreAfterTokenRemoval();};
    nameInput.oninput=()=>{title.textContent=nameInput.value||'Model';expand.setAttribute('aria-label',`Expand ${title.textContent} settings`);};
    modelSelect.onchange=()=>{summary.textContent=modelSelect.value||type.options[type.selectedIndex]?.text||type.value;};
    let discoveryRequest=0;
    const applyModels=(models:ProviderModelOption[],selectFirst:boolean)=>{
      const current=modelSelect.value,keepCurrent=!selectFirst&&models.some(model=>model.id===current);
      modelSelect.replaceChildren(...models.map(model=>new Option(model.label===model.id?model.id:`${model.label} (${model.id})`,model.id)));
      if(keepCurrent)modelSelect.value=current;else if(models[0])modelSelect.value=models[0].id;
      summary.textContent=modelSelect.value||type.options[type.selectedIndex]?.text||type.value;
    };
    const refreshModels=async(automatic=false)=>{
      const bedrock=type.value==='amazon-bedrock';
      if((bedrock&&!region.value.trim())||(!bedrock&&!endpoint.value.trim())){if(!automatic)modelStatus.textContent=bedrock?'Enter an AWS region first.':'Enter a base URL first.';return;}
      const cacheKey=JSON.stringify([provider.id,type.value,endpoint.value.trim(),region.value.trim()]),cached=modelOptionsCache.get(cacheKey);
      if(automatic&&cached){applyModels(cached,!modelSelect.value||modelSelect.value==='auto-detect loaded model');modelStatus.textContent=`${cached.length} models available.`;return;}
      const request=++discoveryRequest;refreshModelsButton.disabled=true;modelStatus.textContent='Loading models…';
      try{
        const apiKeyValue=apiKey.value.trim(),body={id:provider.id,type:type.value,baseUrl:endpoint.value,region:region.value,clearApiKey:apiKey.dataset.clear==='true',tokenless:tokenlessInput.checked,...(apiKeyValue?{apiKey:apiKeyValue}:{})};
        const response=await fetch('/api/llm-models',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
        const data=await response.json() as {models?:ProviderModelOption[];error?:string};
        if(!response.ok)throw new Error(data.error??'Could not load models.');
        const models=(data.models??[]).filter(model=>model&&typeof model.id==='string'&&typeof model.label==='string');if(!models.length)throw new Error('The provider returned no models.');
        if(request!==discoveryRequest)return;modelOptionsCache.set(cacheKey,models);applyModels(models,!modelSelect.value||modelSelect.value==='auto-detect loaded model');modelStatus.textContent=`${models.length} models available.`;
      }catch(error){if(request===discoveryRequest)modelStatus.textContent=error instanceof Error?error.message:'Could not load models.';}
      finally{if(request===discoveryRequest)refreshModelsButton.disabled=false;}
    };
    refreshModelsButton.onclick=()=>void refreshModels();
    queueMicrotask(()=>void refreshModels(true));
    expand.onclick=()=>{const open=grid.hidden;grid.hidden=!open;card.classList.toggle('expanded',open);expand.textContent=open?'−':'+';expand.title=`${open?'Collapse':'Expand'} model settings`;expand.setAttribute('aria-label',`${open?'Collapse':'Expand'} ${title.textContent} settings`);expand.setAttribute('aria-expanded',String(open));};
    card.append(grid);list.append(card);
  }
  updateStrategyControl();
}
const inhabitantPortraits:Record<string,string>={
  Flint:new URL('./assets/flint.png',import.meta.url).href,
  Moss:new URL('./assets/moss.png',import.meta.url).href,
};
function troglodytePortrait(id:string){
  const colors=id==='t2'?{fur:'#493326',trim:'#b8874d',hair:'#302c26',skin:'#cfae83',beard:'#40352b'}:{fur:'#b8874d',trim:'#493326',hair:'#514d3e',skin:'#d9b98d',beard:'#514638'};
  return `<svg class="troglodyte-portrait" viewBox="0 0 48 52" aria-hidden="true"><rect width="48" height="52" rx="4" fill="#2c3b30"/><path d="M5 52 7 39q1-6 9-9l5-2h7l5 2q8 3 9 9l2 13Z" fill="${colors.fur}"/><path d="m9 39 5 2 4-2 5 3 5-3 5 3 5-3 5 2-1 11H7Z" fill="${colors.trim}"/><path d="m16 30 8 6 8-6 3 3-8 9h-6l-8-9Z" fill="${colors.fur}"/><path d="M18 25h12v8q-6 5-12 0Z" fill="${colors.skin}"/><ellipse cx="14" cy="17" rx="3" ry="4" fill="${colors.skin}"/><ellipse cx="34" cy="17" rx="3" ry="4" fill="${colors.skin}"/><path d="M15 12q0-8 9-9 10 1 10 10v7q-2 7-10 9-8-2-9-9Z" fill="${colors.skin}"/><path d="M14 14Q13 4 24 3q11 1 11 11l-3-3-2-4q-5 4-14 3l-1 5Z" fill="${colors.hair}"/><path d="M16 18q2 1 4 0m8 0q2 1 4 0" fill="none" stroke="#382f25" stroke-width="1.5" stroke-linecap="round"/><path d="M24 18v4l-2 1" fill="none" stroke="#a67f60" stroke-width="1.2" stroke-linecap="round"/><path d="M17 21q2-2 5 0h4q3-2 5 0l-1 6-3 4-3 2-3-2-3-4Z" fill="${colors.beard}"/><path d="m18 22 4 1 2-1 2 1 4-1" fill="none" stroke="${colors.beard}" stroke-width="2" stroke-linecap="round"/><path d="m16 30 8 6 8-6 2 3-6 6h-8l-6-6Z" fill="${colors.trim}"/><path d="m21 37 3 3 3-3" fill="none" stroke="${colors.fur}" stroke-width="2" stroke-linecap="round"/></svg>`;
}
function updateStrategyControl(){
  const control=$<HTMLSelectElement>('settings-strategy'),count=Array.from($('model-list').querySelectorAll<HTMLInputElement>('[data-field="enabled"]')).filter(input=>input.checked).length,description=$('strategy-description');
  control.disabled=count<2;
  if(count===0){control.value='first-only';description.textContent='No active models are configured.';return;}
  if(count===1){control.value='first-only';description.textContent='Only one model is active.';return;}
  const messages:Record<string,string>={'first-only':'Use only the first active model in the list.','round-robin':'Rotate to the next model for each request; try others if one fails.','fallback':'Keep using the last successful model; move to the next when it fails.','master-slaves':'Contact the primary model every time; try the remaining models only if it fails.'};
  description.textContent=messages[control.value]??messages.fallback;
}
async function loadProviderStatus(){
  try{
    const response=await fetch('/api/llm-config');if(!response.ok)return;llmConfig=await response.json() as LlmConfig;
    if(llmConfig.providers.some(provider=>!provider.health||provider.health.state==='unknown')){
      const eventResponse=await fetch(`/api/events?tick=${meta?.latestTick??latest}`);
      if(eventResponse.ok){
        const events=await eventResponse.json() as WorldEvent[];let mostRecent:{provider:string;turn:number}|undefined;
        for(const event of events){
          if(event.type!=='decision'&&event.type!=='movement-decision')continue;
          const providerId=(event.data as {provider?:unknown}|undefined)?.provider;if(typeof providerId!=='string')continue;
          const provider=llmConfig.providers.find(candidate=>candidate.id===providerId);if(!provider)continue;
          const turn=Math.floor(event.tick/TURN_TICKS)+1;
          if(!provider.health||provider.health.state==='unknown')provider.health={state:'ok',detail:`Successful inference in turn ${turn}.`};
          mostRecent={provider:provider.name,turn};
        }
        if(!llmConfig.currentStatus&&mostRecent)llmConfig.currentStatus=`${mostRecent.provider}: last successful inference in turn ${mostRecent.turn}.`;
      }
    }
    if(meta){meta.llmConfig=llmConfig;renderProviderStatus();}
  }catch{/* The turn status remains available if provider details cannot be loaded. */}
}
async function loadLlmSettings(){
  $('settings-status').textContent='Loading current configuration…';
  try{
    const response=await fetch('/api/llm-config');if(!response.ok)throw new Error();
    llmConfig=await response.json() as LlmConfig;$<HTMLSelectElement>('settings-strategy').value=llmConfig.strategy;renderProviderStatus(llmConfig);
    renderModelRows(llmConfig.providers);if(meta)$<HTMLInputElement>('parallel-requests').checked=meta.parallelRequests;
    $('settings-status').textContent='';
  }catch{$('settings-status').textContent='Could not load LLM configuration.';}
}
function showSettings(open:boolean){
  $('main').classList.toggle('hidden',open);$('llm-settings').classList.toggle('hidden',!open);$('llm-settings').setAttribute('aria-hidden',String(!open));
  if(open)void loadLlmSettings();
}
function dayOf(tick: number) { return worldTime(tick).day; }
function renderProviderStatus(config:LlmConfig|undefined=meta?.llmConfig??llmConfig){
  const providers=(config?.providers??[]).filter(provider=>provider.enabled!==false),list=$('provider-status-list');list.replaceChildren();
  for(const provider of providers){
    const row=document.createElement('li');row.className='provider-status-row';
    const state=provider.health?.state??'unknown',detail=provider.health?.detail??'No inference result recorded yet.',inFlight=provider.health?.inFlight===true,tooltip=`${state.toUpperCase()}${inFlight?' · REQUEST IN PROGRESS':''}: ${detail}`,dot=document.createElement('span');dot.className=`provider-status-dot ${state}${inFlight?' in-flight':''}`;dot.setAttribute('aria-label',`${state}${inFlight?', request in progress':''}: ${detail}`);dot.title=tooltip;
    const name=document.createElement('span');name.className='provider-status-name';name.textContent=provider.name;
    row.title=tooltip;name.title=tooltip;row.append(dot,name);list.append(row);
  }
  const names:Record<string,string>={'first-only':'Single model','round-robin':'Round robin','fallback':'Fallback','master-slaves':'Master / slaves'};
  $('provider-algorithm').textContent=providers.length?(names[config?.strategy??'']??config?.strategy??''):'';
  const current=$('provider-current-status');
  const waiting=Object.entries(meta?.runtime.agents??{}).find(([,status])=>status.state==='waiting'&&status.message);
  const waitingName=waiting?shown?.entities.find(entity=>entity.id===waiting[0])?.name??waiting[0]:'';
  const providerError=config?.currentStatus&&/error|failed|unavailable|invalid|timed out|connection|HTTP \d{3}|earlier provider failures|unsupported|access denied/i.test(config.currentStatus);
  current.textContent=providerError?config!.currentStatus!:waiting?`${waitingName}: ${waiting[1].message}`:config?.currentStatus||'';
  current.classList.toggle('empty',!current.textContent);
  current.setAttribute('aria-hidden',String(!current.textContent));
  current.classList.toggle('error',/error|failed|unavailable|invalid|timed out|connection|HTTP \d{3}/i.test(current.textContent));
}
function selectEntity(id: string) { selected = id; detailsSignature='';view.select(id);renderInspector();void loadMemory(); }
async function loadMemory(){
  const request=++memoryRequest,actor=selected,tick=cursor;memoryView=undefined;renderDetails();
  try{const response=await fetch(`/api/memory?tick=${tick}&actor=${encodeURIComponent(actor)}`);if(!response.ok)throw new Error();const notes=await response.json() as string[];if(request===memoryRequest){memoryView={actor,tick,notes};renderDetails();}}
  catch{if(request===memoryRequest){memoryView={actor,tick,notes:[]};renderDetails();}}
}
function setBoot(boot: Boot) {
  meta = boot; latest = boot.latestTick; liveDynamic = boot.state; liveCells.clear();
  for (const [x,y,z,kind] of boot.state.blocks) liveCells.set(key([x,y,z]),kind);
  liveEvents = boot.events; $('loading').classList.add('hidden');
  renderProviderStatus(meta.llmConfig);
  if(!meta.llmConfig||meta.llmConfig.providers.some(provider=>!provider.health||provider.health.state==='unknown'))void loadProviderStatus();
  $<HTMLInputElement>('parallel-requests').checked=meta.parallelRequests;
  $<HTMLInputElement>('parallel-requests').disabled=false;
  $('module-name').textContent = meta.module.name;
  if (isLive) goLive(); else renderTimeline();
}
const stream = new EventSource('/api/stream');
stream.addEventListener('boot', event => { setBoot(JSON.parse((event as MessageEvent).data)); });
stream.addEventListener('settings',event=>{
  if(!meta)return;
  meta.parallelRequests=JSON.parse((event as MessageEvent).data).parallelRequests;
  $<HTMLInputElement>('parallel-requests').checked=meta.parallelRequests;
});
stream.addEventListener('llm-config',event=>{
  if(!meta)return;
  meta.llmConfig=JSON.parse((event as MessageEvent).data) as LlmConfig;meta.providerStrategy=meta.llmConfig.strategy;renderProviderStatus();
});
stream.addEventListener('status', event => {
  if (!meta) return;
  const packet=JSON.parse((event as MessageEvent).data) as {runtime:TurnStatus;llmConfig?:LlmConfig};
  meta.runtime=packet.runtime;if(packet.llmConfig)meta.llmConfig=packet.llmConfig;renderProviderStatus();
  renderTimeline(); renderInspector();
});
stream.addEventListener('frame', event => {
  const packet = JSON.parse((event as MessageEvent).data) as { frame: Frame; runtime: TurnStatus }, frame = packet.frame;
  if (!meta) return;
  latest = frame.tick; meta.runtime = packet.runtime; liveDynamic = frame;
  for (const [k,kind] of frame.changes) { if (kind) liveCells.set(k,kind); else liveCells.delete(k); }
  liveEvents = [...liveEvents,...frame.events].slice(-200);
  if (isLive) {
    shown = { ...frame,blocks: [] }; cursor = frame.tick; events = liveEvents; view.update(frame);
    if (frame.events.length) renderJournal();
  }
  if(frame.events.some(event=>event.type==='memory'&&event.actor===selected))void loadMemory();
  if (performance.now()-lastUi > 200) { renderTimeline(); renderInspector(); lastUi = performance.now(); }
});

function goLive() {
  if (!meta || !liveDynamic) return;
  epoch++; replayRequest++; fetching = false; seeking = false; clearTimeout(seekTimer); isLive = true; playing = false; scrubTarget = null; replayFrames = [];
  shown = { ...liveDynamic, blocks: [...liveCells].map(([k,kind]) => [...unkey(k),kind]) };
  cursor = latest; events = liveEvents; view.load(shown,meta.module); detailsSignature='';renderTimeline();renderInspector();renderJournal();void loadMemory();
}
async function seek(tick: number) {
  const request = ++epoch; replayRequest++; fetching = false; seeking = true; isLive = false; playing = false; scrubTarget = null; replayFrames = []; view.hold();
  cursor = Math.min(latest,Math.max(0,tick)); renderTimeline();
  try {
    const response = await fetch(`/api/state?tick=${cursor}`); if (!response.ok) throw new Error('Could not load recorded history.');
    const data = await response.json() as Boot; if (request !== epoch) return;
    shown = data.state; cursor = shown.tick; replayClock = cursor; seeking = false; events = data.events; view.load(shown,meta.module); detailsSignature='';renderTimeline();renderInspector();renderJournal();void loadMemory();
  } catch (error) { if (request === epoch) toast(error instanceof Error ? error.message : 'History unavailable.'); }
  finally { if (request === epoch) seeking = false; }
}
async function fetchReplay() {
  if (fetching || seeking || isLive || (!playing && scrubTarget === null) || performance.now() < nextReplayFetch || (replayFrames.at(-1)?.tick ?? cursor) >= Math.min(latest,scrubTarget ?? latest)) return;
  const request = ++replayRequest, modeEpoch = epoch; fetching = true;
  nextReplayFetch = performance.now() + 200;
  try {
    const after = replayFrames.at(-1)?.tick ?? cursor;
    const response = await fetch(`/api/frames?tick=${after}`); if (!response.ok) throw new Error('Replay fetch failed.');
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
        const frame = replayFrames.shift()!; cursor = frame.tick; shown = { ...frame,blocks: [] }; view.update(frame,false,speed); events = [...events,...frame.events].slice(-200); changed = true;memoryChanged ||= frame.events.some(event=>event.type==='memory'&&event.actor===selected);
      }
      if (changed) { renderTimeline(); renderInspector(); renderJournal(); }
      if(memoryChanged)void loadMemory();
      if (scrubTarget !== null && cursor >= scrubTarget) { scrubTarget = null; replayFrames = []; view.hold(); renderTimeline(); }
    }
    // Stay in replay at the recording edge. Only the Live button changes observer mode.
  }
  requestAnimationFrame(playback);
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
  const waitingEntries=Object.entries(meta.runtime.agents).filter(([,status])=>['planning','thinking','waiting'].includes(status.state));
  const waiting=waitingEntries.map(([id])=>shown?.entities.find(e=>e.id===id)?.name??id);
  const diagnostic=waitingEntries.find(([,status])=>status.state==='waiting'&&status.message&&/model error|failed|unavailable|invalid|timed out|connection|HTTP \d{3}/i.test(status.message))??waitingEntries.find(([,status])=>status.state==='waiting'&&status.message);
  const turnStatus=$('turn-status');
  const diagnosticText=diagnostic?.[1].message??'';
  turnStatus.classList.toggle('error',/error|failed|unavailable|invalid|timed out|connection|HTTP \d{3}/i.test(diagnosticText));
  if(meta.runtime.phase==='thinking'){
    const [id,status]=diagnostic??[];
    const name=id?shown?.entities.find(e=>e.id===id)?.name??id:'';
    turnStatus.textContent=diagnostic&&name?`Turn ${meta.runtime.turn} · ${name}: ${status?.message??''}`:`Turn ${meta.runtime.turn} · Waiting for ${waiting.join(', ')||'decisions'}`;
    turnStatus.title=status?.message??'';
  }else if(meta.runtime.phase==='paused'){turnStatus.textContent='World paused';turnStatus.title='';}
  else{turnStatus.textContent=`Turn ${meta.runtime.turn} · One world second`;turnStatus.title='';}
  const marks = $('event-marks'); marks.replaceChildren();
  for (const event of liveEvents.filter(e => ['discovery','lost','memory','encounter','agent-error'].includes(e.type))) {
    const mark = document.createElement('i'); mark.style.left = `${event.tick/Math.max(1,latest)*100}%`; mark.className = event.type; mark.title = event.message; marks.append(mark);
  }
}
function renderInspector() {
  if (!shown) return;
  $('entity-count').textContent=String(shown.entities.length).padStart(2,'0');
  const list=$('entity-list');
  for(const e of shown.entities){
    const enabled=e.enabled!==false;
    const displayStatus=enabled?isLive&&meta.runtime.phase==='thinking'?meta.runtime.agents[e.id]?.state??'held':e.status:'disabled';
    const existing=document.getElementById(`entity-${e.id}`);
    if(existing){
      existing.classList.toggle('selected',e.id===selected);existing.classList.toggle('disabled',!enabled);
      const select=existing.querySelector<HTMLButtonElement>('.inhabitant-select')!;select.setAttribute('aria-pressed',String(e.id===selected));
      const toggle=existing.querySelector<HTMLInputElement>('.entity-toggle')!;toggle.checked=enabled;toggle.disabled=!isLive;
      const status=existing.querySelector<HTMLElement>('.entity-status')!;status.textContent=displayStatus;status.classList.toggle('thinking',['planning','thinking','waiting'].includes(displayStatus));status.classList.toggle('error',displayStatus==='error');continue;
    }
    const row=document.createElement('div');row.className=`inhabitant ${e.id===selected?'selected':''} ${enabled?'':'disabled'}`;row.id=`entity-${e.id}`;
    const button=document.createElement('button');button.className='inhabitant-select';button.setAttribute('aria-pressed',String(e.id===selected));
    const avatar=document.createElement('span');avatar.className=`avatar ${e.kind}`;avatar.style.setProperty('--entity-color',e.color);avatar.setAttribute('aria-hidden','true');
    const portrait=e.kind==='troglodyte'?inhabitantPortraits[e.name]:undefined;
    if(portrait){
      const image=document.createElement('img');image.src=portrait;image.alt='';image.width=31;image.height=36;image.decoding='async';avatar.append(image);
    }else avatar.innerHTML=e.kind==='troglodyte'?troglodytePortrait(e.id):'<i></i>';
    const text=document.createElement('span');text.className='inhabitant-text';const name=document.createElement('strong');name.textContent=e.name;
    const kind=document.createElement('small');kind.textContent=e.kind==='troglodyte'?'Troglodyte':'Duck · NPC';text.append(name,kind);
    const status=document.createElement('span');status.className=`entity-status ${['planning','thinking','waiting'].includes(displayStatus)?'thinking':''} ${displayStatus==='error'?'error':''}`;status.textContent=displayStatus;
    const toggle=document.createElement('input');toggle.type='checkbox';toggle.className='entity-toggle';toggle.checked=enabled;toggle.disabled=!isLive;toggle.title=`Enable ${e.name}`;toggle.setAttribute('aria-label',`Enable ${e.name}`);toggle.onchange=()=>void setEntityEnabled(e.id,toggle.checked,toggle);
    button.append(avatar,text,status);button.onclick=()=>selectEntity(e.id);button.ondblclick=()=>view.focus(e.id);row.append(button,toggle);list.append(row);
  }
  renderDetails();
}
async function setEntityEnabled(id: string, enabled: boolean, toggle: HTMLInputElement) {
  toggle.disabled = true;
  try {
    const response = await fetch('/api/control',{ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entityId: id, entityEnabled: enabled }) });
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
function renderDetails() {
  const e = shown.entities.find(e => e.id === selected); if (!e) return;
  const signature=JSON.stringify({id:e.id,name:e.name,kind:e.kind,status:e.status,enabled:e.enabled,inventory:e.inventory,plan:e.plan,memory:memoryView,knowledge:shown.discoveries?.[selected]});
  const panel = $('details'),recordPanel=$('record-knowledge');
  if(signature===detailsSignature){
    const position=panel.querySelector<HTMLElement>('[data-detail="Position"] .detail-value');if(position)position.textContent=`${e.position.map(v=>v.toFixed(1)).join(' / ')} / ${Math.round(e.yaw)}º`;
    return;
  }
  detailsSignature=signature;panel.replaceChildren();recordPanel.replaceChildren();
  const held=e.inventory?.selected===null||!e.inventory?undefined:e.inventory.stacks[e.inventory.selected];
  const inventory=e.inventory?.stacks.map((stack,index)=>`${index}: ${stack.count} × ${stack.kind}${stack.contents?` (${stack.contents})`:''}`).join(', ')??'Empty';
  const pairs = [['Position',`${e.position.map(v => v.toFixed(1)).join(' / ')} / ${Math.round(e.yaw)}º`],['Hands',held?`${held.kind}${held.contents?` · ${held.contents}`:''}`:'Empty'],['Inventory',inventory],['Perception',`${meta.module.perception.range} m · ${meta.module.perception.fieldOfView}°`],['Speech','10 m · clear line of sight']];
  for (const [label,value] of pairs) { const row = document.createElement('div'); row.className = 'detail-row';row.dataset.detail=label; const a = document.createElement('span'); a.textContent = label; const b = document.createElement('span');b.className='detail-value'; b.textContent = value; row.append(a,b); panel.append(row); }
  if(e.controller==='agent'){
    const section=document.createElement('section');section.className='agent-plan';section.setAttribute('aria-label','Recorded goal and steps');
    const planLabel=document.createElement('h4');planLabel.textContent='PROJECT AND TASK IN THIS RECORD';section.append(planLabel);
    if(e.plan){
      if(e.plan.direction){const direction=document.createElement('p');direction.className='muted';direction.textContent=`Direction: ${e.plan.direction}`;section.append(direction);}
      if(e.plan.project){
        const project=document.createElement('p');project.className='plan-goal';project.textContent=`Project: ${e.plan.project.goal}`;
        const progress=document.createElement('p');progress.textContent=`Agent's progress assessment: ${e.plan.project.progress}`;
        const success=document.createElement('p');success.className='muted';success.textContent=`Project success condition: ${e.plan.project.successCondition}`;section.append(project,progress,success);
        if(e.plan.project.openQuestions.length){const questions=document.createElement('p');questions.className='muted';questions.textContent=`Open questions: ${e.plan.project.openQuestions.join(' ')}`;section.append(questions);}
      }
      const goal=document.createElement('p');goal.className='plan-goal';goal.textContent=e.plan.goal;section.append(goal);
      const steps=document.createElement('ol');
      for(const step of e.plan.steps){
        const item=document.createElement('li');item.dataset.status=step.status;
        const status=document.createElement('span');status.className='plan-step-status';status.textContent=step.assessment==='agent'?`${step.status} (agent assessment)`:step.status;
        const task=document.createElement('div');task.textContent=step.task;item.append(status,task);
        if(step.evidence){const evidence=document.createElement('p');evidence.className='muted';evidence.textContent=step.evidence;item.append(evidence);}
        steps.append(item);
      }
      section.append(steps);
      if(e.plan.suggestedActions?.length){const approach=document.createElement('p');approach.className='muted';approach.textContent=`Suggested next actions: ${e.plan.suggestedActions.join(' Then, if still applicable: ')}`;section.append(approach);}
      const explanation=document.createElement('p');explanation.textContent=`Agent explanation: ${e.plan.explanation}`;section.append(explanation);
      const review=document.createElement('p');review.className='muted';review.textContent=`${e.plan.status} · Reviewed at decision ${e.plan.reviewedTurn} · Review by decision ${e.plan.reviewedTurn+PLAN_REVIEW_INTERVAL}, or earlier after new evidence or obstacles`;section.append(review);
    }else{const empty=document.createElement('p');empty.className='muted';empty.textContent='No plan recorded yet.';section.append(empty);}
    panel.append(section);
  }
  const label = document.createElement('h4'); label.textContent = 'Private Notes in This Record'; recordPanel.append(label);
  if(memoryView?.actor!==selected){const p=document.createElement('p');p.className='muted';p.textContent='Loading private memory.';recordPanel.append(p);}
  else if(!memoryView.notes.length){const p=document.createElement('p');p.className='muted';p.textContent='No private memory notes yet.';recordPanel.append(p);}
  else for(const note of memoryView.notes){const p=document.createElement('p');p.textContent=note;recordPanel.append(p);}
  const knowledgeLabel=document.createElement('h4');knowledgeLabel.textContent='Learned Knowledge';recordPanel.append(knowledgeLabel);
  const learned=(shown.discoveries?.[selected]??[]).map(knowledgeDescription);
  if(!learned.length){const p=document.createElement('p');p.className='muted';p.textContent='Nothing discovered yet.';recordPanel.append(p);}
  else for(const knowledge of learned){const p=document.createElement('p');p.textContent=knowledge;recordPanel.append(p);}
}
function renderJournal() {
  const journal = $('journal'), wasAtTop = journal.scrollTop < 20; journal.replaceChildren();
  const visible = events.filter(e => !['observation','tool-result','decision','turn'].includes(e.type)).reverse(); $('event-count').textContent = String(visible.length);
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
  if(event.type==='plan')return 'Goal and plan review';
  if(event.type==='action'||event.type==='rejected'){
    const action=(event.data as {action?:{action?:string}}|undefined)?.action?.action??'action';
    const labels:Record<string,string>={walk:'Walking',run:'Running',jump:'Jumping',turn:'Turning',wait:'Waiting',find_material:'Scanning for materials',find_entity:'Searching for living beings',hit:'Striking a block',dig:'Digging with a shovel',strike_held:'Crafting with wood',join:'Joining door halves',open:'Opening a door',close:'Closing a door',place:'Placing an item',throw:'Throwing an item',pickup:'Picking up an item',hold:'Taking an item in hand',store:'Putting an item away',fill:'Filling a bucket',empty:'Emptying a bucket',say:'Speaking',follow:'Following',stop_follow:'Stopping following'};
    const label=labels[action]??'Action';return event.type==='rejected'?`${label} failed`:label;
  }
  const labels:Record<string,string>={damage:'Block damaged',discovery:'Learned',memory:'Journal note',arrived:'Movement complete',scanned:'Material scan complete',blocked:'Movement blocked',collision:'Collision',settled:'Block settled',lost:'Item lost',speech:'Speech',encounter:'Encounter',collapse:'Tree collapse',reflection:'Reflection','journal-compaction':'Journal condensed','agent-error':'Agent paused','entity-control':'Entity control','knowledge-correction':'Knowledge update','follow-ended':'Follow ended','follow-blocked':'Follow blocked',splash:'Water splashed'};
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
  const number=$('model-list').children.length+1;
  renderModelRows([...readModelRows(),{id:`model-${Date.now()}-${number}`,type:'openai-compatible',enabled:true,name:`Model ${number}`,baseUrl:'',model:'',apiKeyConfigured:false}]);
};
$<HTMLSelectElement>('settings-strategy').onchange=updateStrategyControl;
$<HTMLFormElement>('llm-settings-form').onsubmit=async event=>{
  event.preventDefault();const status=$('settings-status');status.textContent='Saving configuration…';
  const providers=Array.from($('model-list').children).map(card=>{
    const field=(name:string)=>(card.querySelector(`[data-field="${name}"]`) as HTMLInputElement|HTMLSelectElement).value;
    const enabled=(card.querySelector('[data-field="enabled"]') as HTMLInputElement).checked;
    const tokenless=(card.querySelector('[data-field="tokenless"]') as HTMLInputElement).checked;
    const apiKeyInput=card.querySelector('[data-field="apiKey"]') as HTMLInputElement,apiKey=apiKeyInput.value.trim();
    return{id:(card as HTMLElement).dataset.id,type:field('type'),enabled,tokenless,name:field('name'),baseUrl:field('baseUrl'),model:field('model'),region:field('region'),clearApiKey:apiKeyInput.dataset.clear==='true',...(apiKey?{apiKey}:{})};
  });
  const requestedStrategy=$<HTMLSelectElement>('settings-strategy').value;
  try{
    const response=await fetch('/api/llm-config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({providers,strategy:requestedStrategy})});
    const data=await response.json() as Metadata&{llmConfig?:LlmConfig;error?:string};
    if(!response.ok)throw new Error(data.error??'Could not save configuration.');
    if(meta){meta.mode=data.mode;meta.model=data.model;meta.providerStrategy=data.providerStrategy;}
    if(data.llmConfig)llmConfig=data.llmConfig;
    if(data.llmConfig){if(meta)meta.llmConfig=data.llmConfig;renderProviderStatus(data.llmConfig);}
    renderModelRows(llmConfig.providers);$<HTMLSelectElement>('settings-strategy').value=llmConfig.strategy;
    status.textContent='Configuration saved.';
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
$<HTMLInputElement>('parallel-requests').onchange=async event=>{
  if(!meta)return;
  const input=event.target as HTMLInputElement,parallelRequests=input.checked;input.disabled=true;
  try{
    const response=await fetch('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parallelRequests})});
    if(!response.ok)throw new Error();
    meta.parallelRequests=(await response.json() as Metadata).parallelRequests;
  }catch{toast('Could not change request mode. Check the connection.');}
  finally{input.checked=meta.parallelRequests;input.disabled=false;}
};
window.addEventListener('beforeunload', () => { stream.close(); view.dispose(); });
