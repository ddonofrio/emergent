import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { Engine } from '../src/core/engine';
import { island } from '../src/modules/island';
import type { Action, Block, Entity, Frame } from '../src/core/types';
import { Store } from '../server/store';
import { AgentRuntime } from '../server/agents/runtime';
import { ProviderChain, providersFromEnv, type ProviderConfig } from '../server/agents/providers';
import { TurnClock } from '../server/turn-clock';
import { advancePlayback, fastScrubSpeed } from '../src/view/playback-clock';
import { formatWorldDuration, worldTime, WORLD_DAY_SECONDS } from '../src/core/time';

function world() {
  const blocks: Block[] = [];
  for (let x=-6;x<=6;x++) for(let z=-6;z<=9;z++) blocks.push([x,0,z,'stone']);
  blocks.push([0,1,1,'wood']);
  const creature = (id: string, x: number): Entity => ({id,name:id,kind:'troglodyte',controller:'agent',position:[x,1,.5],height:2,yaw:0,inventory:null,color:'#ffffff',status:'idle'});
  const duck: Entity = {...creature('duck',4.5),kind:'duck',controller:'wander',height:.65,status:'walking',motion:{destination:[4.5,1,6.5],speed:1}};
  const engine = new Engine({...island,generate:()=>({blocks,entities:[creature('t1',-.5),creature('t2',1.5),duck]})});
  engine.bodies.push({id:'falling',kind:'stone',position:[-4,7,4],velocity:[0,0,0],resting:false});
  return engine;
}
interface Request { id: string; body: any; response: ServerResponse; }
async function provider() {
  const requests: Request[] = [];
  const server = createServer(async (req,res) => {
    let body=''; for await(const chunk of req) body+=chunk;
    const data=JSON.parse(body), id=data.messages[0].content.includes('Your name is t1.')?'t1':'t2';
    requests.push({id,body:data,response:res});
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  return { requests, url:`http://127.0.0.1:${(server.address() as {port:number}).port}`, close(){server.closeAllConnections();server.close();} };
}
function respond(request: Request, action: Action) {
  const {action:name,...argumentsValue}=action;
  respondTool(request,name,argumentsValue);
}
function respondTool(request:Request,name:string,argumentsValue:unknown){
  request.response.setHeader('Content-Type','application/json');
  request.response.end(JSON.stringify({choices:[{message:{content:null,tool_calls:[{id:'call-'+request.id,type:'function',function:{name,arguments:JSON.stringify(argumentsValue)}}]}}],usage:{total_tokens:42}}));
}
async function until(predicate:()=>boolean) {
  const deadline=Date.now()+3000;
  while(!predicate() && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,5));
  assert.ok(predicate(),'The expected async state was not reached.');
}
function run(engine: Engine, store: Store, url: string, maxTurns: number | null = 10) {
  const runtime=new AgentRuntime(engine,store,{providers:[{id:'stub',name:'Stub provider',apiKey:'test-key',baseUrl:url,model:'stub-model'}],maxTurns,retryDelayMs:5});
  let wall=0; const frames: Frame[]=[], failures: unknown[]=[];
  const clock=new TurnClock(engine,runtime,{
    frame(){const frame=engine.frame();frames.push(frame);store.record(frame,undefined,runtime.persistence());},
    status(){},fatal(error){failures.push(error);},
  },()=>wall);
  return {runtime,clock,frames,failures,advance(ms:number){wall+=ms;clock.pump();}};
}

test('both decisions share one instant; response order and 90 seconds of waiting cannot move the duck or physics',async()=>{
  const simulate=async(first:string)=>{
    const p=await provider(), engine=world(), store=new Store(':memory:',engine.module.manifest), r=run(engine,store,p.url);
    store.record(engine.frame(),engine.state()); const initial=engine.state();
    try {
      r.clock.pump(); await until(()=>p.requests.length===2);
      for(const req of p.requests) assert.match(JSON.parse(req.body.messages.at(-1).content).perception,/hands are empty/i);
      respond(p.requests.find(req=>req.id===first)!,{action:'hit',target:[0,1,1]});
      await until(()=>r.clock.status().agents[first]?.state==='ready');
      r.advance(90000);
      assert.deepEqual(engine.state(),initial); assert.equal(store.latestTick(),0); assert.equal(r.frames.length,0);
      assert.equal(r.runtime.minds.get(first)!.modelTurns,0);
      respond(p.requests.find(req=>req.id!==first)!,{action:'hit',target:[0,1,1]});
      await until(()=>r.clock.status().phase==='advancing'); r.advance(1000);
      assert.equal(engine.time,1); assert.equal(r.frames.length,10);
      assert.equal(engine.blockDamage.get('0,1,1'),2);assert.equal(engine.entity('t1').inventory,null);assert.equal(engine.entity('t2').inventory,null);
      assert.ok(Math.abs(engine.entity('duck').position[2]-1.5)<1e-8);
      assert.equal(store.loadPending(0,'t1','stub:stub-model'),undefined);
      assert.equal(store.eventsAt(0).length,0,'The initial snapshot must not contain a later decision.');
      assert.deepEqual(store.stateAt(20),engine.state()); assert.deepEqual(r.failures,[]);
      return engine.state();
    } finally {r.clock.close();store.close();p.close();}
  };
  assert.deepEqual(await simulate('t1'),await simulate('t2'));
});

test('a stalled primary provider yields to the local fallback without advancing world time',async()=>{
  const primary=await provider(), local=await provider();
  const providers: ProviderConfig[]=[
    {id:'primary',name:'Primary',apiKey:'primary-key',baseUrl:primary.url,model:'primary-model',timeoutMs:25},
    {id:'local',name:'Local',apiKey:'local-key',baseUrl:local.url,model:'local-model'},
  ];
  const chain=new ProviderChain(providers), attempted:string[]=[];
  const pending=chain.complete({messages:[{role:'system',content:'Your name is t1.'}],tools:[],max_tokens:20},new AbortController().signal,provider=>attempted.push(provider.id));
  try {
    await until(()=>primary.requests.length===1);
    await until(()=>local.requests.length===1);
    respond(local.requests[0],{action:'wait'});
    const result=await pending;
    assert.deepEqual(attempted,['primary','local']);
    assert.equal(result.provider,'local');
    assert.equal(result.model,'local-model');
  }finally{primary.close();local.close();}
});

test('OpenRouter can be disabled without removing its credential',()=>{
  const providers=providersFromEnv({OPENROUTER_ENABLED:'false',OPENROUTER_API_KEY:'retained-secret',LOCAL_LLM_BASE_URL:'http://127.0.0.1:1234/v1'} as NodeJS.ProcessEnv);
  assert.deepEqual(providers.map(provider=>provider.id),['local']);
});

test('LM Studio discovery uses the loaded instance and exposes its full variant in the UI label',async()=>{
  let completionModel='';
  const server=createServer(async(req,res)=>{
    if(req.method==='GET'&&req.url==='/api/v1/models'){
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify({models:[{type:'llm',key:'local-author/ornith-9b-instruct',display_name:'Ornith 9B Instruct',selected_variant:'local-author/ornith-9b-instruct@q6_k',loaded_instances:[{id:'ornith-loaded-instance'}]}]}));
      return;
    }
    let body='';for await(const chunk of req)body+=chunk;
    completionModel=JSON.parse(body).model;
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({model:completionModel,choices:[{message:{content:null,tool_calls:[{id:'wait',type:'function',function:{name:'wait',arguments:'{}'}}]}}]}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const chain=new ProviderChain([{id:'local',name:'Local LM Studio',apiKey:'local',baseUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`,model:'ornith',modelDiscovery:'lm-studio'}]);
  try{
    const result=await chain.complete({messages:[],tools:[],max_tokens:20},new AbortController().signal,()=>{});
    assert.equal(completionModel,'ornith-loaded-instance');
    assert.equal(result.model,'ornith-loaded-instance');
    assert.match(chain.label,/local-author\/ornith-9b-instruct@q6_k/);
  }finally{server.closeAllConnections();server.close();}
});

test('unlimited agents continue beyond old counters and an explicit cap never freezes physics',async()=>{
  const p=await provider();
  const unlimitedEngine=world(), unlimitedStore=new Store(':memory:',unlimitedEngine.module.manifest), unlimited=run(unlimitedEngine,unlimitedStore,p.url,null);
  let capped:ReturnType<typeof run>|undefined, cappedStore:Store|undefined;
  try {
    for(const mind of unlimited.runtime.minds.values()) mind.modelTurns=250;
    unlimited.clock.pump();await until(()=>p.requests.length===2);
    for(const request of p.requests)respond(request,{action:'wait'});
    await until(()=>unlimited.clock.status().phase==='advancing');unlimited.advance(1000);
    assert.equal(unlimited.runtime.minds.get('t1')!.modelTurns,251);

    const cappedEngine=world();cappedStore=new Store(':memory:',cappedEngine.module.manifest);capped=run(cappedEngine,cappedStore,p.url,1);
    for(const mind of capped.runtime.minds.values()) mind.modelTurns=1;
    const duckStart=cappedEngine.entity('duck').position[2];
    capped.clock.pump();await until(()=>capped!.clock.status().phase==='advancing');
    assert.equal(p.requests.length,2,'Capped agents must not request another decision.');
    capped.advance(1000);
    assert.ok(cappedEngine.entity('duck').position[2]>duckStart,'Autonomous physics must continue after an optional agent cap.');
  }finally{
    unlimited.clock.close();unlimitedStore.close();capped?.clock.close();cappedStore?.close();p.close();
  }
});

test('disabled agents request and consume no model turns',async()=>{
  const p=await provider(), engine=world(), store=new Store(':memory:',engine.module.manifest), r=run(engine,store,p.url,null);
  try {
    engine.setEntityEnabled('t2',false);
    r.clock.pump();await until(()=>p.requests.length===1);
    assert.equal(p.requests[0].id,'t1');
    respond(p.requests[0],{action:'wait'});await until(()=>r.clock.status().phase==='advancing');r.advance(1000);
    assert.equal(r.runtime.minds.get('t1')!.modelTurns,1);
    assert.equal(r.runtime.minds.get('t2')!.modelTurns,0);
    assert.equal(engine.entity('t2').status,'disabled');
  }finally{r.clock.close();store.close();p.close();}
});

test('look returns perception inside the same frozen decision before a physical action',async()=>{
  const p=await provider(),engine=world(),store=new Store(':memory:',engine.module.manifest),r=run(engine,store,p.url,null);
  try{
    engine.setEntityEnabled('t2',false);r.clock.pump();await until(()=>p.requests.length===1);
    respondTool(p.requests[0],'look',{angle:90});await until(()=>p.requests.length===2);
    assert.equal(engine.tick,0);assert.ok(p.requests[1].body.messages.some((message:any)=>message.role==='tool'&&JSON.parse(message.content).description));
    respond(p.requests[1],{action:'wait'});await until(()=>r.clock.status().phase==='advancing');assert.equal(engine.tick,0);r.advance(1000);
    assert.equal(engine.time,1);assert.equal(r.runtime.minds.get('t1')!.modelTurns,2);
  }finally{r.clock.close();store.close();p.close();}
});

test('journal is freely available within a frozen decision and persists notes for future prompts',async()=>{
  const p=await provider(),engine=world(),store=new Store(':memory:',engine.module.manifest),r=run(engine,store,p.url,null);
  try{
    engine.setEntityEnabled('t2',false);r.clock.pump();await until(()=>p.requests.length===1);
    assert.match(p.requests[0].body.messages[0].content,/freely use journal/);
    for(let index=0;index<3;index++){
      respondTool(p.requests[index],'journal',{note:`I want to explore area ${index}.`});await until(()=>p.requests.length===index+2);
      assert.equal(engine.tick,0);
      const result=JSON.parse(p.requests[index+1].body.messages.at(-1).content);assert.equal(result.ok,true);
    }
    respond(p.requests[3],{action:'wait'});await until(()=>r.clock.status().phase==='advancing');r.advance(1000);
    assert.deepEqual(store.memoryAt(engine.tick,'t1'),Array.from({length:3},(_,index)=>`I want to explore area ${index}.`));
    r.clock.pump();await until(()=>p.requests.length===5);assert.match(p.requests[4].body.messages[0].content,/I want to explore area 2\./);
    respond(p.requests[4],{action:'wait'});
  }finally{r.clock.close();store.close();p.close();}
});

test('encounter notices reach both prompts and are acknowledged only at the shared commit',async()=>{
  const p=await provider(),engine=world(),store=new Store(':memory:',engine.module.manifest);
  engine.entity('t1').yaw=90;engine.entity('t2').yaw=270;
  for(let tick=0;tick<20;tick++)engine.step();store.record(engine.frame(),engine.state());
  const r=run(engine,store,p.url,null);
  try{
    r.clock.pump();await until(()=>p.requests.length===2);
    for(const request of p.requests){const prompt=JSON.parse(request.body.messages.at(-1).content);assert.equal(prompt.encounters.length,1);assert.match(prompt.encounters[0].message,/another Troglodyte.*use say/);assert.equal(prompt.encounters[0].canSpeakNow,true);}
    respond(p.requests.find(request=>request.id==='t1')!,{action:'wait'});await until(()=>r.clock.status().agents.t1?.state==='ready');assert.equal(engine.observe('t1').encounters.length,1);
    respond(p.requests.find(request=>request.id==='t2')!,{action:'wait'});await until(()=>r.clock.status().phase==='advancing');r.advance(1000);
    assert.equal(engine.observe('t1').encounters.length,0);assert.equal(engine.observe('t2').encounters.length,0);
    r.clock.pump();await until(()=>p.requests.length===4);for(const request of p.requests.slice(2)){assert.equal(JSON.parse(request.body.messages.at(-1).content).encounters,undefined);respond(request,{action:'wait'});}
  }finally{r.clock.close();store.close();p.close();}
});

test('authoritative discoveries enter future prompts as persistent learned knowledge',async()=>{
  const p=await provider(),engine=world(),store=new Store(':memory:',engine.module.manifest),r=run(engine,store,p.url,null);
  try{
    engine.setEntityEnabled('t2',false);engine.discoveries.set('t1',new Set(['thrown-blocks-settle']));r.clock.pump();await until(()=>p.requests.length===1);
    assert.match(p.requests[0].body.messages[0].content,/Learned knowledge: \["Thrown blocks settle and become part of the terrain\."\]/);
    respond(p.requests[0],{action:'wait'});
  }finally{r.clock.close();store.close();p.close();}
});

test('a restart removes the generic edge fact without learning the water boundary from gaps',()=>{
  const engine=world(),store=new Store(':memory:',engine.module.manifest);
  try{
    engine.event('t1','blocked','No safe ground ahead.',{issue:{kind:'gap'}});store.record(engine.frame(),engine.state());
    engine.discoveries.set('t1',new Set(['unsafe-terrain-edge']));
    new AgentRuntime(engine,store,{providers:[],maxTurns:null});
    assert.equal(engine.discoveries.get('t1')?.has('unsafe-terrain-edge'),false);
    assert.equal(engine.discoveries.get('t1')?.has('deep-water-limit'),false);
    assert.equal(engine.discoveries.has('t2'),false);
    store.record(engine.frame(),engine.state());
    const restored=new Engine(engine.module,store.stateAt(0));restored.nextEvent=store.maxEventId()+1;
    new AgentRuntime(restored,store,{providers:[],maxTurns:null});
    assert.equal(restored.frame().events.length,0);
    assert.equal(store.eventsAt(0,'t1').filter(event=>event.type==='discovery').length,0);
    assert.equal(store.eventsAt(0,'t1').filter(event=>event.type==='knowledge-correction').length,1);
  }finally{store.close();}
});

test('a carrying reminder persists through turns, failed uses and waiting until the object is used',async()=>{
  const p=await provider(),engine=world(),store=new Store(':memory:',engine.module.manifest),r=run(engine,store,p.url,null);
  try{
    engine.setEntityEnabled('t2',false);engine.entity('t1').inventory={stacks:[{kind:'wood',count:1}],selected:0,capacity:64};
    (r.runtime.minds.get('t1') as any).carriedMoves=9;
    const actions:Action[]=[{action:'jump',distance:.5},{action:'jump',distance:1,angle:-90},{action:'turn',angle:45},{action:'place',target:[0,0,0]},{action:'wait'},{action:'store'},{action:'wait'}];
    for(const [index,action] of actions.entries()){
      r.clock.pump();await until(()=>p.requests.length===index+1);
      const prompt=JSON.parse(p.requests[index].body.messages.at(-1).content);
      if(index>=2&&index<=5){assert.match(prompt.reminder,/still holding a wood block/i);assert.match(prompt.reminder,/place it, throw it, work it/);}
      else assert.equal(prompt.reminder,undefined);
      respond(p.requests[index],action);await until(()=>r.clock.status().phase==='advancing');r.advance(1000);
      if(index===0)assert.equal((r.runtime.minds.get('t1') as any).carriedMoves,9,'A failed movement preserves the count before the reminder is active.');
      if(index>=1&&index<5)assert.equal((r.runtime.minds.get('t1') as any).carriedMoves,10);
    }
    assert.equal((r.runtime.minds.get('t1') as any).carriedMoves,0);
    assert.ok(store.eventsAt(engine.tick,'t1').filter(event=>event.type==='observation'&&(event.data as any).reminder).length>=4,'Delivered reminders must be recorded.');
  }finally{r.clock.close();store.close();p.close();}
});

test('a hit reminder stays in every decision after ten empty-handed moves until a successful hit',async()=>{
  const p=await provider(),engine=world(),store=new Store(':memory:',engine.module.manifest),r=run(engine,store,p.url,null);
  try{
    engine.setEntityEnabled('t2',false);engine.voxels.set([0,1,1],null);
    for(let index=0;index<=20;index++){
      r.clock.pump();await until(()=>p.requests.length===index+1);
      const prompt=JSON.parse(p.requests[index].body.messages.at(-1).content);
      if(index>=10)assert.match(prompt.reminder,/blocks in this world look like they can be struck/i);
      else assert.equal(prompt.reminder,undefined);
      respond(p.requests[index],index===20?{action:'wait'}:{action:index%2?'walk':'jump',distance:1,angle:index===0?-90:90});
      await until(()=>r.clock.status().phase==='advancing');r.advance(1000);
    }
    r.clock.pump();await until(()=>p.requests.length===22);
    assert.match(JSON.parse(p.requests[21].body.messages.at(-1).content).reminder,/try hit/);respond(p.requests[21],{action:'hit',target:[-1,0,1]});
    await until(()=>r.clock.status().phase==='advancing');r.advance(1000);assert.equal(engine.entity('t1').lastAction?.ok,true);
    r.clock.pump();await until(()=>p.requests.length===23);assert.equal(JSON.parse(p.requests[22].body.messages.at(-1).content).reminder,undefined);respond(p.requests[22],{action:'wait'});
  }finally{r.clock.close();store.close();p.close();}
});

test('the shared hit hint counter prioritizes reachable wood and ignores distant or hidden wood',async()=>{
  for(const scenario of ['reachable','distant','hidden','held']){
    const p=await provider(),engine=world(),store=new Store(':memory:',engine.module.manifest),r=run(engine,store,p.url,null);
    try{
      engine.setEntityEnabled('t2',false);
      if(scenario==='distant'){engine.voxels.set([0,1,1],null);engine.voxels.set([0,1,5],'wood');}
      if(scenario==='hidden'){engine.voxels.set([0,1,1],'stone');engine.voxels.set([0,2,1],'stone');engine.voxels.set([0,3,1],'stone');engine.voxels.set([0,1,3],'wood');}
      if(scenario==='held')engine.entity('t1').inventory={stacks:[{kind:'wood',count:1}],selected:0,capacity:64};
      (r.runtime.minds.get('t1') as any).emptyHandMoves=10;
      r.clock.pump();await until(()=>p.requests.length===1);
      const reminder=JSON.parse(p.requests[0].body.messages.at(-1).content).reminder;
      if(scenario==='reachable'){assert.match(reminder,/wood within reach at block \[0,1,1\] could be useful/);assert.match(reminder,/try hit/);}
      else if(scenario==='held')assert.equal(reminder,undefined);
      else assert.match(reminder,/blocks in this world look like they can be struck/);
      respond(p.requests[0],{action:'wait'});await until(()=>r.clock.status().phase==='advancing');r.advance(1000);
      assert.equal((r.runtime.minds.get('t1') as any).emptyHandMoves,10);
      r.clock.pump();await until(()=>p.requests.length===2);assert.equal(JSON.parse(p.requests[1].body.messages.at(-1).content).reminder,reminder);respond(p.requests[1],{action:'wait'});
    }finally{r.clock.close();store.close();p.close();}
  }
});

test('failed hits preserve the hit reminder count before and after activation',async()=>{
  const p=await provider(),engine=world(),store=new Store(':memory:',engine.module.manifest),r=run(engine,store,p.url,null);
  try{
    engine.setEntityEnabled('t2',false);(r.runtime.minds.get('t1') as any).emptyHandMoves=9;
    const actions:Action[]=[{action:'hit',target:[30,1,30]},{action:'walk',distance:1,angle:-90},{action:'turn',angle:90},{action:'hit',target:[30,1,30]},{action:'wait'},{action:'hit',target:[-2,0,1]},{action:'wait'}];
    for(const [index,action] of actions.entries()){
      r.clock.pump();await until(()=>p.requests.length===index+1);
      const prompt=JSON.parse(p.requests[index].body.messages.at(-1).content);
      if(index>=2&&index<=5)assert.match(prompt.reminder,/try hit/);else assert.equal(prompt.reminder,undefined);
      respond(p.requests[index],action);await until(()=>r.clock.status().phase==='advancing');r.advance(1000);
      const count=(r.runtime.minds.get('t1') as any).emptyHandMoves;
      assert.equal(count,index===0?9:index<5?10:0);
      assert.equal((store.loadMind('t1') as any).emptyHandMoves,count,'The active counter survives persistence.');
      if(index===5)assert.equal(engine.entity('t1').lastAction?.ok,true);
    }
  }finally{r.clock.close();store.close();p.close();}
});

test('carried movement does not advance the empty-handed hit reminder counter',async()=>{
  const p=await provider(),engine=world(),store=new Store(':memory:',engine.module.manifest),r=run(engine,store,p.url,null);
  try{
    engine.setEntityEnabled('t2',false);engine.entity('t1').inventory={stacks:[{kind:'wood',count:1}],selected:0,capacity:64};
    (r.runtime.minds.get('t1') as any).emptyHandMoves=9;
    r.clock.pump();await until(()=>p.requests.length===1);respond(p.requests[0],{action:'jump',distance:1,angle:-90});
    await until(()=>r.clock.status().phase==='advancing');r.advance(1000);
    assert.equal((r.runtime.minds.get('t1') as any).emptyHandMoves,9);
    r.clock.pump();await until(()=>p.requests.length===2);assert.equal(JSON.parse(p.requests[1].body.messages.at(-1).content).reminder,undefined);
    respond(p.requests[1],{action:'store'});await until(()=>r.clock.status().phase==='advancing');r.advance(1000);
    r.clock.pump();await until(()=>p.requests.length===3);assert.equal(JSON.parse(p.requests[2].body.messages.at(-1).content).reminder,undefined);respond(p.requests[2],{action:'walk',distance:1,angle:90});
    await until(()=>r.clock.status().phase==='advancing');r.advance(1000);r.clock.pump();await until(()=>p.requests.length===4);
    assert.match(JSON.parse(p.requests[3].body.messages.at(-1).content).reminder,/try hit/);respond(p.requests[3],{action:'wait'});
  }finally{r.clock.close();store.close();p.close();}
});

test('long motion takes two world turns and results enter the next model context',async()=>{
  const p=await provider(), engine=world(), store=new Store(':memory:',engine.module.manifest), r=run(engine,store,p.url);
  store.record(engine.frame(),engine.state());
  try {
    r.clock.pump(); await until(()=>p.requests.length===2);
    for(const req of p.requests)respond(req,req.id==='t1'?{action:'walk',distance:4}:{action:'wait'});
    await until(()=>r.clock.status().phase==='advancing'); r.advance(1000);
    assert.ok(Math.abs(engine.entity('t1').position[2]-2.5)<1e-8); assert.ok(engine.entity('t1').motion);
    r.clock.pump();await until(()=>p.requests.length===3);
    assert.equal(p.requests[2].id,'t2'); assert.ok(p.requests[2].body.messages.some((m:any)=>m.role==='tool' && JSON.parse(m.content).ok));
    r.advance(600000); assert.equal(engine.time,1); assert.ok(Math.abs(engine.entity('t1').position[2]-2.5)<1e-8);
    respond(p.requests[2],{action:'wait'}); await until(()=>r.clock.status().phase==='advancing'); r.advance(1000);
    assert.equal(engine.time,2); assert.ok(Math.abs(engine.entity('t1').position[2]-4.5)<1e-8); assert.equal(engine.entity('t1').motion,undefined);
    assert.equal(r.runtime.minds.get('t1')!.modelTurns,1); assert.deepEqual(r.failures,[]);
  }finally{r.clock.close();store.close();p.close();}
});

test('provider outages retry without timeouts, world errors or consumed model turns; ready decisions survive pause and restart',async()=>{
  const p=await provider(), engine=world(), store=new Store(':memory:',engine.module.manifest), r=run(engine,store,p.url);
  store.record(engine.frame(),engine.state()); let resumed: ReturnType<typeof run>|undefined;
  try {
    r.clock.pump();await until(()=>p.requests.length===2);
    respond(p.requests.find(req=>req.id==='t1')!,{action:'walk',distance:1,angle:90});
    const failed=p.requests.find(req=>req.id==='t2')!;failed.response.writeHead(503);failed.response.end();
    await until(()=>p.requests.filter(req=>req.id==='t2').length===2 && r.clock.status().agents.t1?.state==='ready');
    r.advance(24*60*60*1000);
    assert.equal(engine.tick,0); assert.equal(engine.entity('t1').yaw,0); assert.equal(r.clock.status().phase,'thinking');
    assert.equal(r.runtime.minds.get('t2')!.modelTurns,0);assert.equal(engine.recentEvents.some(e=>e.type==='agent-error'),false);
    r.clock.setEnabled(false);r.advance(1000);assert.equal(r.clock.status().phase,'paused');r.clock.close();
    const restored=new Engine(engine.module,store.stateAt(0));resumed=run(restored,store,p.url);
    resumed.clock.pump();await until(()=>p.requests.filter(req=>req.id==='t2').length===3);
    assert.equal(p.requests.filter(req=>req.id==='t1').length,1,'The ready decision must not be requested again.');
    respond(p.requests.at(-1)!,{action:'wait'});await until(()=>resumed!.clock.status().phase==='advancing');resumed.advance(1000);
    assert.equal(restored.entity('t1').yaw,90);assert.equal(restored.time,1);assert.deepEqual(resumed.failures,[]);
  }finally{r.clock.close();resumed?.clock.close();store.close();p.close();}
});

test('restart halfway through a committed turn finishes only its remaining physics',async()=>{
  const p=await provider(), engine=world(), store=new Store(':memory:',engine.module.manifest), r=run(engine,store,p.url);
  store.record(engine.frame(),engine.state()); let resumed: ReturnType<typeof run>|undefined;
  try {
    r.clock.pump();await until(()=>p.requests.length===2);for(const req of p.requests)respond(req,{action:'walk',distance:1,angle:90});
    await until(()=>r.clock.status().phase==='advancing');r.advance(400);assert.equal(engine.tick,8);r.clock.close();
    const restored=new Engine(engine.module,store.stateAt(8));restored.nextEvent=store.maxEventId()+1;resumed=run(restored,store,p.url);
    resumed.advance(600);assert.equal(restored.tick,20);assert.equal(restored.entity('t1').yaw,90);assert.equal(p.requests.length,2);
    assert.equal(resumed.runtime.minds.get('t1')!.modelTurns,1);assert.deepEqual(resumed.failures,[]);
  }finally{r.clock.close();resumed?.clock.close();store.close();p.close();}
});

test('pausing a committed turn completes exactly one second and no additional turn',async()=>{
  const p=await provider(),engine=world(),store=new Store(':memory:',engine.module.manifest),r=run(engine,store,p.url);
  store.record(engine.frame(),engine.state());
  try{
    r.clock.pump();await until(()=>p.requests.length===2);for(const req of p.requests)respond(req,{action:'wait'});
    await until(()=>r.clock.status().phase==='advancing');r.advance(250);r.clock.setEnabled(false);r.advance(5000);r.clock.pump();
    assert.equal(engine.tick,20);assert.equal(r.clock.status().phase,'paused');assert.equal(p.requests.length,2);
  }finally{r.clock.close();store.close();p.close();}
});

test('playback consumes world time without accumulating a backlog at the recording edge',()=>{
  let tick=advancePlayback(0,1000,1,20);assert.equal(tick,20);
  tick=advancePlayback(tick,60000,1,20);assert.equal(tick,20);
  tick=advancePlayback(tick,50,1,22);assert.equal(tick,21);
  tick=advancePlayback(tick,50,1,22);assert.equal(tick,22);
  assert.equal(advancePlayback(0,1000,1,200),20);
  assert.equal(advancePlayback(0,1000,2,200),40);
});

test('net world time uses 24-hour days and fast scrubbing remains bounded',()=>{
  const tick=(WORLD_DAY_SECONDS+3661.5)*20,value=worldTime(tick);
  assert.deepEqual({day:value.day,hour:value.hour,minute:value.minute,second:value.second,tenth:value.tenth},{day:2,hour:1,minute:1,second:1,tenth:5});
  assert.equal(formatWorldDuration(tick,true),'1d 01:01:01.5');
  assert.equal(fastScrubSpeed(0,20),8);
  assert.equal(fastScrubSpeed(0,20*1000),128);
});
