import './style.css';
import { appPath, routePath } from './base-path';
import { interfaceRoutePath, parseInterfaceRoute } from './interface-routing';

interface UniverseSummary {
  id: string;
  name: string;
  available: boolean;
  running: boolean;
  observerLayout: 'full' | 'roster';
}

const app=document.querySelector<HTMLDivElement>('#app')!;
const interfaceRoute=parseInterfaceRoute(routePath());
const interfaceMode=interfaceRoute.mode;
const scopedPath=(path:string)=>appPath(interfaceRoutePath(interfaceMode,path));
const route=/^\/universes\/([a-z0-9-]+)\/?$/.exec(interfaceRoute.contentPath);

void start();

async function start(){
  if(interfaceMode==='admin'&&!await hasAdminSession()){renderAdminLogin();return;}
  if(route)await openRoutedUniverse(route[1]);else renderLauncher();
}

async function hasAdminSession(){
  try{return (await fetch(appPath('/api/admin/session'))).ok;}catch{return false;}
}

function renderAdminLogin(){
  app.innerHTML=`
    <main class="admin-login">
      <form id="admin-login-form" class="admin-login-card">
        <a class="brand" href="${appPath('/')}" aria-label="Emergent observer"><span class="brand-mark"><i></i><i></i><i></i></span>emergent</a>
        <div><span class="eyebrow">EMERGENT / ADMIN</span><h1>Administrator access</h1><p>Enter the access key to manage universes and model settings.</p></div>
        <label for="admin-key">Access key</label><input id="admin-key" name="key" type="password" autocomplete="current-password" required autofocus>
        <p id="admin-login-status" class="admin-login-status" role="status"></p>
        <button class="save-button" type="submit">Enter administrator</button>
      </form>
    </main>`;
  const form=document.getElementById('admin-login-form') as HTMLFormElement;
  form.onsubmit=async event=>{
    event.preventDefault();
    const input=document.getElementById('admin-key') as HTMLInputElement,status=document.getElementById('admin-login-status')!,button=form.querySelector<HTMLButtonElement>('button')!;
    button.disabled=true;status.textContent='Checking access key...';
    try{
      const response=await fetch(appPath('/api/admin/login'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:input.value})});
      if(!response.ok){status.textContent='The access key is incorrect.';input.select();return;}
      app.replaceChildren();if(route)await openRoutedUniverse(route[1]);else renderLauncher();
    }catch{status.textContent='Administrator access is unavailable.';}
    finally{button.disabled=false;}
  };
}

async function openRoutedUniverse(id:string){
  try{
    const response=await fetch(appPath('/api/universes'));
    const universes=response.ok?await response.json() as UniverseSummary[]:[];
    if(universes.some(universe=>universe.id===id&&universe.available)){await import('./world-app');return;}
  }catch{}
  history.replaceState(null,'',scopedPath('/'));renderLauncher();
}

function renderLauncher(){
  app.innerHTML=`
    <main class="launcher">
      <header class="launcher-header"><a class="brand" href="${scopedPath('/')}" aria-label="Emergent home"><span class="brand-mark"><i></i><i></i><i></i></span>emergent</a>${interfaceMode==='observer'?'<span class="observer-badge">Read only</span>':''}</header>
      <section id="world-cards" class="world-cards" aria-label="Universes"></section>
      <p id="launcher-status" class="sr-only" aria-live="polite"></p>
    </main>`;

  let universes:UniverseSummary[]=[
    {id:'first-shore',name:'First Shore',available:true,running:false,observerLayout:'full'},
    {id:'robots-vs-robots',name:'Robots vs Robots',available:true,running:false,observerLayout:'roster'},
  ];
  const busy=new Set<string>();
  let refreshTimer=0;
  let worldRevision=0;

  const draw=()=>{
    const cards=document.getElementById('world-cards')!;cards.replaceChildren();
    for(const universe of universes){
      const card=document.createElement('article');card.className=`world-card${interfaceMode==='observer'?' read-only':''}${universe.running?' running':''}${universe.available?'':' unavailable'}`;
      const enter=document.createElement('button');enter.type='button';enter.className='world-card-enter';enter.disabled=!universe.available;enter.setAttribute('aria-label',`Enter ${universe.name}`);
      const title=document.createElement('h1');title.textContent=universe.name;enter.append(title);
      enter.onclick=()=>{window.clearInterval(refreshTimer);window.location.assign(scopedPath(`/universes/${universe.id}`));};
      const power=document.createElement('button');power.type='button';power.className='world-power';power.disabled=!universe.available||busy.has(universe.id);power.classList.toggle('stop',universe.running);power.setAttribute('aria-label',`${universe.running?'Stop':'Start'} ${universe.name}`);power.setAttribute('aria-pressed',String(universe.running));
      power.append(document.createElement('span'));
      power.onclick=()=>void setRunning(universe,!universe.running);
      card.append(enter,...(interfaceMode==='admin'?[power]:[]));cards.append(card);
    }
  };

  const setRunning=async(universe:UniverseSummary,running:boolean)=>{
    worldRevision++;
    busy.add(universe.id);draw();
    try{
      const response=await fetch(appPath(`/api/universes/${universe.id}/control`),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({running})});
      const result=await response.json() as {running?:boolean;error?:string};
      if(!response.ok)throw new Error(result.error??`Could not ${running?'start':'stop'} ${universe.name}.`);
      const nextRunning=result.running===true;
      universes=universes.map(candidate=>candidate.id===universe.id?{...candidate,running:nextRunning}:candidate);
      document.getElementById('launcher-status')!.textContent=`${universe.name} ${nextRunning?'started':'stopped'}.`;
    }catch(error){document.getElementById('launcher-status')!.textContent=error instanceof Error?error.message:'World control failed.';}
    finally{busy.delete(universe.id);draw();}
  };

  const refresh=async()=>{
    const revision=worldRevision;
    try{
      const response=await fetch(appPath('/api/universes'));if(!response.ok)throw new Error();
      const next=await response.json() as UniverseSummary[];
      if(revision===worldRevision&&JSON.stringify(next)!==JSON.stringify(universes)){universes=next;draw();}
    }catch{document.getElementById('launcher-status')!.textContent='World status is unavailable.';}
  };

  draw();void refresh();
  refreshTimer=window.setInterval(()=>{if(document.visibilityState==='visible')void refresh();},2000);
  window.addEventListener('beforeunload',()=>window.clearInterval(refreshTimer),{once:true});
}
