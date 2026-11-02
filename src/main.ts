import './style.css';

interface WorldSummary {
  id: string;
  name: string;
  available: boolean;
  running: boolean;
}

const app=document.querySelector<HTMLDivElement>('#app')!;
const route=/^\/worlds\/([a-z0-9-]+)\/?$/.exec(window.location.pathname);

if(route?.[1]==='first-shore'){
  void openRoutedWorld(route[1]);
}else{
  if(route)history.replaceState(null,'','/');
  renderLauncher();
}

async function openRoutedWorld(id:string){
  try{
    const response=await fetch('/api/worlds');
    const worlds=response.ok?await response.json() as WorldSummary[]:[];
    if(worlds.some(world=>world.id===id&&world.available)){await import('./world-app');return;}
  }catch{}
  history.replaceState(null,'','/');renderLauncher();
}

function renderLauncher(){
  app.innerHTML=`
    <main class="launcher">
      <header class="launcher-header"><a class="brand" href="/" aria-label="Emergent home"><span class="brand-mark"><i></i><i></i><i></i></span>emergent</a></header>
      <section id="world-cards" class="world-cards" aria-label="Worlds"></section>
      <p id="launcher-status" class="sr-only" aria-live="polite"></p>
    </main>`;

  let worlds:WorldSummary[]=[
    {id:'first-shore',name:'First Shore',available:true,running:false},
    {id:'robots-vs-robots',name:'Robots vs Robots',available:false,running:false},
  ];
  const busy=new Set<string>();
  let refreshTimer=0;
  let worldRevision=0;

  const draw=()=>{
    const cards=document.getElementById('world-cards')!;cards.replaceChildren();
    for(const world of worlds){
      const card=document.createElement('article');card.className=`world-card${world.running?' running':''}${world.available?'':' unavailable'}`;
      const enter=document.createElement('button');enter.type='button';enter.className='world-card-enter';enter.disabled=!world.available;enter.setAttribute('aria-label',`Enter ${world.name}`);
      const title=document.createElement('h1');title.textContent=world.name;enter.append(title);
      enter.onclick=()=>{window.clearInterval(refreshTimer);window.location.assign(`/worlds/${world.id}`);};
      const power=document.createElement('button');power.type='button';power.className='world-power';power.disabled=!world.available||busy.has(world.id);power.classList.toggle('stop',world.running);power.setAttribute('aria-label',`${world.running?'Stop':'Start'} ${world.name}`);power.setAttribute('aria-pressed',String(world.running));
      power.append(document.createElement('span'));
      power.onclick=()=>void setRunning(world,!world.running);
      card.append(enter,power);cards.append(card);
    }
  };

  const setRunning=async(world:WorldSummary,running:boolean)=>{
    worldRevision++;
    busy.add(world.id);draw();
    try{
      const response=await fetch(`/api/worlds/${world.id}/control`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({running})});
      const result=await response.json() as {running?:boolean;error?:string};
      if(!response.ok)throw new Error(result.error??`Could not ${running?'start':'stop'} ${world.name}.`);
      const nextRunning=result.running===true;
      worlds=worlds.map(candidate=>candidate.id===world.id?{...candidate,running:nextRunning}:candidate);
      document.getElementById('launcher-status')!.textContent=`${world.name} ${nextRunning?'started':'stopped'}.`;
    }catch(error){document.getElementById('launcher-status')!.textContent=error instanceof Error?error.message:'World control failed.';}
    finally{busy.delete(world.id);draw();}
  };

  const refresh=async()=>{
    const revision=worldRevision;
    try{
      const response=await fetch('/api/worlds');if(!response.ok)throw new Error();
      const next=await response.json() as WorldSummary[];
      if(revision===worldRevision&&JSON.stringify(next)!==JSON.stringify(worlds)){worlds=next;draw();}
    }catch{document.getElementById('launcher-status')!.textContent='World status is unavailable.';}
  };

  draw();void refresh();
  refreshTimer=window.setInterval(()=>{if(document.visibilityState==='visible')void refresh();},2000);
  window.addEventListener('beforeunload',()=>window.clearInterval(refreshTimer),{once:true});
}
