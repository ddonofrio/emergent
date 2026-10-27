import './style.css';
import { WorldView } from './view/world-view';
import { advancePlayback, fastScrubSpeed } from './view/playback-clock';
import { formatWorldDuration, worldTime, WORLD_DAY_SECONDS, type TurnStatus } from './core/time';
import { key, unkey, type Frame, type ModuleManifest, type WorldEvent, type WorldState } from './core/types';
import { knowledgeDescription } from './core/knowledge';
import { PLAN_REVIEW_INTERVAL } from './core/memory';

interface Metadata { module: ModuleManifest; mode: 'demo' | 'llm'; model: string; parallelRequests: boolean; latestTick: number; maxTurns: number | null; runtime: TurnStatus; }
interface Boot extends Metadata { state: WorldState; events: WorldEvent[]; }
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <header class="app-header">
    <a class="brand" href="/" aria-label="Emergent home"><span class="brand-mark"><i></i><i></i><i></i></span>emergent<span class="version">LAB / 001</span></a>
    <div class="header-middle"><span class="status-dot" id="connection-dot"></span><span id="connection">Connecting</span><span class="divider">/</span><span>World observatory</span></div>
    <div class="header-actions"><button id="help-button" class="quiet">Field guide</button><a href="/api/export" class="quiet export">Export record <span>↗</span></a></div>
  </header>
  <main>
    <section class="observation-area" aria-label="World observation">
      <div class="world-toolbar"><div><span class="eyebrow">ACTIVE MODULE</span><h1 id="module-name">First Shore <span>01</span></h1></div><div class="world-stats"><span><i class="tiny-square"></i> 1 m voxels</span><span id="world-size">100 m island</span><span id="population">3 inhabitants</span></div></div>
      <div id="world" class="world"><div class="loading" id="loading"><span class="loader"></span>Opening the observatory…</div>
        <div class="world-top"><span class="glass-tag" id="view-mode">LIVE OBSERVATION</span><span class="glass-tag world-clock" id="world-clock">DAY 001 · 00:00</span></div>
        <div class="camera-tools"><button id="overview" title="Overview" aria-label="Overview">◈</button><button id="top-down" title="Top view" aria-label="Top view">⊞</button><button id="follow" title="Follow selected inhabitant" aria-label="Follow selected inhabitant">◎</button></div>
        <div class="world-bottom"><div class="scale"><span>N ↑</span><i></i><span>100 m / ISLAND DIAMETER</span></div><div class="camera-hint">DRAG Orbit <b>·</b> SCROLL Zoom <b>·</b> WASD + Q/E Fly</div></div>
        <div id="toast" role="status"></div>
      </div>
      <section class="timeline" aria-label="Recorded world timeline">
        <div class="timeline-top"><div class="playback-controls"><button id="play" class="play-button" title="Pause observation" aria-label="Pause observation">Ⅱ</button><button id="live" class="live-button active"><span></span> Live</button><select id="speed" aria-label="Playback speed"><option value="1">1×</option><option value="2">2×</option><option value="4">4×</option><option value="8">8×</option></select><span class="timeline-divider"></span><span id="playback-time">00:00:00.0</span><span id="time-to-live">LIVE</span></div><div class="timeline-right"><span id="record-status">Recording every 100 ms</span><select id="day" aria-label="Recorded day"><option value="1">Day 001</option></select></div></div>
        <div class="scrubber"><div id="event-marks"></div><input id="seek" type="range" min="0" max="1" value="0" step="2" aria-label="Seek world history"></div>
        <div class="timeline-labels"><span id="range-start">00:00:00</span><span>PAST <span class="timeline-line">─────────────────</span> NET WORLD TIME <span class="timeline-line">─────────────────</span> PRESENT</span><span id="range-end">00:00:00</span></div>
      </section>
    </section>
    <aside class="inspector" aria-label="World inspector">
      <details id="experiment-panel" class="experiment"><summary class="experiment-heading"><span class="experiment-heading-text"><span class="eyebrow">EXPERIMENT 001</span><span class="seed">SEED 731</span></span><span class="experiment-collapse-mark" aria-hidden="true">+</span></summary><div class="experiment-content"><div id="runtime-mode" class="runtime-mode">Connecting to runtime</div><label class="request-setting" title="Changes apply from the next turn."><input id="parallel-requests" type="checkbox" checked disabled>Parallel requests</label><p id="turn-status" role="status">One turn = one world second</p></div></details>
      <div class="inhabitants"><div class="section-heading"><h2>Inhabitants</h2><span id="entity-count">03</span></div><div id="entity-list"></div></div>
      <div class="inspector-tabs" role="tablist"><button id="journal-tab" role="tab" aria-selected="true" class="active">Journal</button><button id="details-tab" role="tab" aria-selected="false">In focus</button><span id="event-count">0</span></div>
      <div id="journal" class="journal" role="tabpanel"><p class="empty">Waiting for the first trace.</p></div>
      <div id="details" class="details hidden" role="tabpanel"></div>
      <div class="inspector-footer"><span class="status-dot"></span><span id="persistence">Local persistent recording</span><span id="lost">0 lost</span></div>
    </aside>
  </main>
  <dialog id="guide"><button id="close-guide" class="dialog-close" aria-label="Close field guide">×</button><span class="eyebrow">EMERGENT / FIELD GUIDE</span><h2>Observe. Rewind. Discover.</h2><p>Two Troglodytes share a finite island with a wandering duck. There is no assigned objective. Each shared turn advances one world second after all model decisions arrive. The world waits for unavailable models; your camera and recorded history remain usable.</p><dl><dt>Move the camera</dt><dd>Drag to orbit, right-drag to pan, scroll to zoom. Focus the world and use WASD + Q/E to fly. Shift moves faster. Select a name, then use Follow.</dd><dt>Read the past</dt><dd>Drag the timeline to any recorded moment, choose a day, or pause and play at up to 8×. Live returns to the present. Observer playback never rewinds the actual experiment.</dd><dt>Run a model</dt><dd>Copy <code>.env.example</code> to <code>.env</code>, then configure OpenRouter and/or a local OpenAI-compatible provider. Without either provider, the clearly labelled scripted demo exercises the same actions. Agent decisions are unlimited unless an explicit optional cap is configured.</dd><dt>Keep an experiment</dt><dd>The server records physics at 10 Hz, events and private notes in SQLite, with checkpoints every 30 seconds. Reopening resumes the world. Export downloads the complete history.</dd><dt>Physical limits</dt><dd>Ten different item stacks, up to 64 identical items each. Buckets stack by contents. Three-metre reach. Speech offers twenty ideas after opening the communication menu, travels at most 10 metres and cannot pass through solid blocks. Water deeper than half a Troglodyte is refused. Sinking items beyond the lower boundary are permanently lost.</dd></dl><p class="guide-note">MVP: voxel terrain stays fixed until edited; thrown items use gravity, collisions and buoyancy. Poured water disperses. Inference waiting has no duration in world history. At 1×, one recorded turn takes one real second. Long actions continue across turns at their normal speed.</p></dialog>`;

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
let activeTab = 'journal', dayCount = 0;
let memoryRequest=0,memoryView:{actor:string;tick:number;notes:string[]}|undefined;

function toast(message: string) { $('toast').textContent = message; $('toast').classList.add('visible'); setTimeout(() => $('toast').classList.remove('visible'),3500); }
function dayOf(tick: number) { return worldTime(tick).day; }
function clock(tick: number) { const value=worldTime(tick);return `${String(value.hour).padStart(2,'0')}:${String(value.minute).padStart(2,'0')}:${String(value.second).padStart(2,'0')}`; }
function setConnection(connected: boolean) { $('connection').textContent = connected ? 'Connected' : 'Reconnecting'; $('connection-dot').classList.toggle('offline',!connected); }
function selectEntity(id: string) { selected = id; view.select(id); renderInspector(); if(activeTab==='details')void loadMemory(); }
async function loadMemory(){
  const request=++memoryRequest,actor=selected,tick=cursor;memoryView=undefined;renderDetails();
  try{const response=await fetch(`/api/memory?tick=${tick}&actor=${encodeURIComponent(actor)}`);if(!response.ok)throw new Error();const notes=await response.json() as string[];if(request===memoryRequest){memoryView={actor,tick,notes};renderDetails();}}
  catch{if(request===memoryRequest){memoryView={actor,tick,notes:[]};renderDetails();}}
}
function setBoot(boot: Boot) {
  meta = boot; latest = boot.latestTick; liveDynamic = boot.state; liveCells.clear();
  for (const [x,y,z,kind] of boot.state.blocks) liveCells.set(key([x,y,z]),kind);
  liveEvents = boot.events; $('loading').classList.add('hidden');
  $('runtime-mode').textContent = meta.mode === 'demo' ? 'SCRIPTED DEMO · No LLM connected' : `LLM CONNECTED · ${meta.model}`;
  $('runtime-mode').classList.toggle('model',meta.mode === 'llm');
  $<HTMLInputElement>('parallel-requests').checked=meta.parallelRequests;
  $<HTMLInputElement>('parallel-requests').disabled=false;
  $('module-name').textContent = meta.module.name; $('population').textContent = `${boot.state.entities.length} inhabitants`;
  if (isLive) goLive(); else renderTimeline();
}
const stream = new EventSource('/api/stream');
stream.addEventListener('boot', event => { setConnection(true); setBoot(JSON.parse((event as MessageEvent).data)); });
stream.addEventListener('settings',event=>{
  if(!meta)return;
  meta.parallelRequests=JSON.parse((event as MessageEvent).data).parallelRequests;
  $<HTMLInputElement>('parallel-requests').checked=meta.parallelRequests;
});
stream.addEventListener('status', event => {
  if (!meta) return;
  meta.runtime = JSON.parse((event as MessageEvent).data).runtime;
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
  if(activeTab==='details'&&frame.events.some(event=>event.type==='memory'&&event.actor===selected))void loadMemory();
  if (performance.now()-lastUi > 200) { renderTimeline(); renderInspector(); lastUi = performance.now(); }
});
stream.onerror = () => setConnection(false);

function goLive() {
  if (!meta || !liveDynamic) return;
  epoch++; replayRequest++; fetching = false; seeking = false; clearTimeout(seekTimer); isLive = true; playing = false; scrubTarget = null; replayFrames = [];
  shown = { ...liveDynamic, blocks: [...liveCells].map(([k,kind]) => [...unkey(k),kind]) };
  cursor = latest; events = liveEvents; view.load(shown,meta.module); renderTimeline(); renderInspector(); renderJournal();if(activeTab==='details')void loadMemory();
}
async function seek(tick: number) {
  const request = ++epoch; replayRequest++; fetching = false; seeking = true; isLive = false; playing = false; scrubTarget = null; replayFrames = []; view.hold();
  cursor = Math.min(latest,Math.max(0,tick)); renderTimeline();
  try {
    const response = await fetch(`/api/state?tick=${cursor}`); if (!response.ok) throw new Error('Could not load recorded history.');
    const data = await response.json() as Boot; if (request !== epoch) return;
    shown = data.state; cursor = shown.tick; replayClock = cursor; seeking = false; events = data.events; view.load(shown,meta.module); renderTimeline(); renderInspector(); renderJournal();if(activeTab==='details')void loadMemory();
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
      if(memoryChanged&&activeTab==='details')void loadMemory();
      if (scrubTarget !== null && cursor >= scrubTarget) { scrubTarget = null; replayFrames = []; view.hold(); renderTimeline(); }
    }
    // Stay in replay at the recording edge. Only the Live button changes observer mode.
  }
  requestAnimationFrame(playback);
}
requestAnimationFrame(playback);

function renderTimeline() {
  if (!meta) return;
  $('view-mode').textContent = isLive ? meta.runtime.phase === 'thinking' ? 'LIVE · WAITING FOR MODELS' : meta.runtime.phase === 'paused' ? 'LIVE · WORLD PAUSED' : 'LIVE OBSERVATION' : scrubTarget !== null ? 'FAST SCRUB PLAYBACK' : playing ? 'RECORDED PLAYBACK' : 'PAUSED OBSERVATION';
  $('view-mode').classList.toggle('past',!isLive); $('world-clock').textContent = `DAY ${String(dayOf(cursor)).padStart(3,'0')} · ${clock(cursor)}`;
  $('live').classList.toggle('active',isLive); $('play').textContent = isLive || playing ? 'Ⅱ' : '▶'; $('play').setAttribute('aria-label',isLive || playing ? 'Pause observation' : 'Play recording');
  $('playback-time').textContent = formatWorldDuration(cursor,true);
  $('time-to-live').textContent = isLive ? 'LIVE' : `${formatWorldDuration(Math.max(0,latest-cursor))} TO LIVE`;
  $('range-end').textContent = formatWorldDuration(latest);
  const sliderTick=scrubTarget??cursor,slider = $<HTMLInputElement>('seek'); slider.max = String(Math.max(2,latest)); slider.value = String(sliderTick); slider.style.setProperty('--progress',`${sliderTick/Math.max(1,latest)*100}%`);
  const count = dayOf(latest);
  if (count !== dayCount) { const day = $<HTMLSelectElement>('day'); day.replaceChildren(); for (let i = 1;i<=count;i++) { const option = new Option(`Day ${String(i).padStart(3,'0')}`,String(i)); day.add(option); } dayCount = count; }
  $<HTMLSelectElement>('day').value = String(dayOf(cursor));
  const waiting = Object.entries(meta.runtime.agents).filter(([,s]) => s.state === 'planning' || s.state === 'thinking' || s.state === 'waiting').map(([id]) => shown?.entities.find(e=>e.id===id)?.name ?? id);
  $('turn-status').textContent = meta.runtime.phase === 'thinking' ? `Turn ${meta.runtime.turn} · Waiting for ${waiting.join(', ') || 'decisions'}` : meta.runtime.phase === 'paused' ? 'World paused' : `Turn ${meta.runtime.turn} · One world second`;
  $('record-status').textContent = isLive ? '1 turn = 1 world second' : playing && cursor >= latest ? 'Waiting for the next recorded turn' : 'World time · inference waits omitted';
  const marks = $('event-marks'); marks.replaceChildren();
  for (const event of liveEvents.filter(e => ['discovery','lost','memory','encounter','agent-error'].includes(e.type))) {
    const mark = document.createElement('i'); mark.style.left = `${event.tick/Math.max(1,latest)*100}%`; mark.className = event.type; mark.title = event.message; marks.append(mark);
  }
}
function renderInspector() {
  if (!shown) return;
  $('lost').textContent = `${shown.lost} lost`; $('entity-count').textContent = String(shown.entities.length).padStart(2,'0');
  const list = $('entity-list');
  for (const e of shown.entities) {
    const enabled = e.enabled !== false;
    const displayStatus = enabled ? isLive && meta.runtime.phase === 'thinking' ? meta.runtime.agents[e.id]?.state ?? 'held' : e.status : 'disabled';
    const existing = document.getElementById(`entity-${e.id}`);
    if (existing) {
      existing.classList.toggle('selected',e.id===selected); existing.classList.toggle('disabled',!enabled);
      const select = existing.querySelector('.inhabitant-select')!; select.setAttribute('aria-pressed',String(e.id===selected));
      const toggle = existing.querySelector<HTMLInputElement>('.entity-toggle')!; toggle.checked = enabled; toggle.disabled = !isLive;
      const status = existing.querySelector('.entity-status')!; status.textContent=displayStatus; status.classList.toggle('thinking',displayStatus==='planning' || displayStatus==='thinking' || displayStatus==='waiting'); continue;
    }
    const row = document.createElement('div'); row.className = `inhabitant ${e.id === selected ? 'selected' : ''} ${enabled ? '' : 'disabled'}`; row.id = `entity-${e.id}`;
    const button = document.createElement('button'); button.className = 'inhabitant-select'; button.setAttribute('aria-pressed',String(e.id === selected));
    const avatar = document.createElement('span'); avatar.className = `avatar ${e.kind}`; avatar.style.setProperty('--entity-color',e.color); avatar.innerHTML = '<i></i>';
    const text = document.createElement('span'); text.className = 'inhabitant-text'; const name = document.createElement('strong'); name.textContent = e.name;
    const kind = document.createElement('small'); kind.textContent = e.kind === 'troglodyte' ? 'Troglodyte' : 'Duck · NPC'; text.append(name,kind);
    const status = document.createElement('span'); status.className = `entity-status ${displayStatus === 'planning' || displayStatus === 'thinking' || displayStatus === 'waiting' ? 'thinking' : ''}`; status.textContent = displayStatus;
    const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.className = 'entity-toggle'; toggle.checked = enabled; toggle.disabled = !isLive;
    toggle.title = `Enable ${e.name}`; toggle.setAttribute('aria-label',`Enable ${e.name}`); toggle.onchange = () => void setEntityEnabled(e.id,toggle.checked,toggle);
    button.append(avatar,text,status); button.onclick = () => selectEntity(e.id); button.ondblclick = () => view.focus(e.id); row.append(button,toggle); list.append(row);
  }
  if (activeTab === 'details') renderDetails();
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
  const panel = $('details'); panel.replaceChildren();
  const title = document.createElement('h3'); title.textContent = `${e.name} / ${e.kind}`; panel.append(title);
  const held=e.inventory?.selected===null||!e.inventory?undefined:e.inventory.stacks[e.inventory.selected];
  const inventory=e.inventory?.stacks.map((stack,index)=>`${index}: ${stack.count} × ${stack.kind}${stack.contents?` (${stack.contents})`:''}`).join(', ')??'Empty';
  const pairs = [['Position',e.position.map(v => v.toFixed(1)).join(' / ')],['Facing',`${Math.round(e.yaw)}°`],['State',e.status],['Hands',held?`${held.kind}${held.contents?` · ${held.contents}`:''}`:'Empty'],['Inventory',inventory],['Perception',`${meta.module.perception.range} m · ${meta.module.perception.fieldOfView}°`],['Speech','10 m · clear line of sight']];
  for (const [label,value] of pairs) { const row = document.createElement('div'); row.className = 'detail-row'; const a = document.createElement('span'); a.textContent = label; const b = document.createElement('span'); b.textContent = value; row.append(a,b); panel.append(row); }
  const focus = document.createElement('button'); focus.className = 'focus-button'; focus.textContent = `Follow ${e.name}`; focus.onclick = () => view.focus(e.id); panel.append(focus);
  if(e.controller==='agent'){
    const section=document.createElement('section');section.className='agent-plan';section.setAttribute('aria-label','Recorded goal and steps');
    const planLabel=document.createElement('h4');planLabel.textContent='GOAL AND STEPS IN THIS RECORD';section.append(planLabel);
    if(e.plan){
      const goal=document.createElement('p');goal.className='plan-goal';goal.textContent=e.plan.goal;section.append(goal);
      const steps=document.createElement('ol');
      for(const step of e.plan.steps){
        const item=document.createElement('li');item.dataset.status=step.status;
        const status=document.createElement('span');status.className='plan-step-status';status.textContent=step.status;
        const task=document.createElement('div');task.textContent=step.task;item.append(status,task);
        if(step.evidence){const evidence=document.createElement('p');evidence.className='muted';evidence.textContent=step.evidence;item.append(evidence);}
        steps.append(item);
      }
      section.append(steps);
      const explanation=document.createElement('p');explanation.textContent=`Agent explanation: ${e.plan.explanation}`;section.append(explanation);
      const review=document.createElement('p');review.className='muted';review.textContent=`${e.plan.status} · Reviewed at decision ${e.plan.reviewedTurn} · Next review at ${e.plan.reviewedTurn+PLAN_REVIEW_INTERVAL}`;section.append(review);
    }else{const empty=document.createElement('p');empty.className='muted';empty.textContent='No plan recorded yet.';section.append(empty);}
    panel.append(section);
  }
  const label = document.createElement('h4'); label.textContent = 'PRIVATE NOTES IN THIS RECORD'; panel.append(label);
  if(memoryView?.actor!==selected){const p=document.createElement('p');p.className='muted';p.textContent='Loading private memory.';panel.append(p);}
  else if(!memoryView.notes.length){const p=document.createElement('p');p.className='muted';p.textContent='No private memory notes yet.';panel.append(p);}
  else for(const note of memoryView.notes){const p=document.createElement('p');p.textContent=note;panel.append(p);}
  const knowledgeLabel=document.createElement('h4');knowledgeLabel.textContent='LEARNED KNOWLEDGE';panel.append(knowledgeLabel);
  const learned=(shown.discoveries?.[selected]??[]).map(knowledgeDescription);
  if(!learned.length){const p=document.createElement('p');p.className='muted';p.textContent='Nothing discovered yet.';panel.append(p);}
  else for(const knowledge of learned){const p=document.createElement('p');p.textContent=knowledge;panel.append(p);}
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
    const labels:Record<string,string>={walk:'Walking',run:'Running',jump:'Jumping',turn:'Turning',wait:'Waiting',find_material:'Scanning for materials',find_entity:'Searching for living beings',hit:'Striking a block',dig:'Digging with a shovel',strike_held:'Crafting with wood',join:'Joining door halves',place:'Placing an item',throw:'Throwing an item',pickup:'Picking up an item',hold:'Taking an item in hand',store:'Putting an item away',fill:'Filling a bucket',empty:'Emptying a bucket',say:'Speaking',follow:'Following',stop_follow:'Stopping following'};
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
$<HTMLDetailsElement>('experiment-panel').addEventListener('toggle',event=>{
  const panel=event.currentTarget as HTMLDetailsElement;
  panel.querySelector('.experiment-collapse-mark')!.textContent=panel.open?'−':'+';
});
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
for (const tab of ['journal','details']) $(tab+'-tab').onclick = () => {
  activeTab = tab; for (const name of ['journal','details']) { $(name).classList.toggle('hidden',name!==tab); $(name+'-tab').classList.toggle('active',name===tab); $(name+'-tab').setAttribute('aria-selected',String(name===tab)); }
  if (tab === 'details') { renderDetails();void loadMemory(); }
};
$('help-button').onclick = () => $<HTMLDialogElement>('guide').showModal();
$('close-guide').onclick = () => $<HTMLDialogElement>('guide').close();
window.addEventListener('beforeunload', () => { stream.close(); view.dispose(); });
