import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { Engine } from '../src/core/engine';
import { island } from '../src/modules/island';
import type { Action, Block, Entity, Frame } from '../src/core/types';
import { Store } from '../server/store';
import { AgentRuntime } from '../server/agents/runtime';
import { TurnClock } from '../server/turn-clock';
import { advancePlayback } from '../src/view/playback-clock';

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
  request.response.setHeader('Content-Type','application/json');
  request.response.end(JSON.stringify({choices:[{message:{content:null,tool_calls:[{id:'call-'+request.id,type:'function',function:{name:'act',arguments:JSON.stringify(action)}}]}}],usage:{total_tokens:42}}));
}
async function until(predicate:()=>boolean) {
  const deadline=Date.now()+3000;
  while(!predicate() && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,5));
  assert.ok(predicate(),'The expected async state was not reached.');
}
function run(engine: Engine, store: Store, url: string) {
  const runtime=new AgentRuntime(engine,store,{apiKey:'test-key',baseUrl:url,model:'stub-model',maxTurns:10,retryDelayMs:5});
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
      for(const req of p.requests) assert.equal(JSON.parse(req.body.messages.at(-1).content).tick,0);
      respond(p.requests.find(req=>req.id===first)!,{action:'remove',target:[0,1,1]});
      await until(()=>r.clock.status().agents[first]?.state==='ready');
      r.advance(90000);
      assert.deepEqual(engine.state(),initial); assert.equal(store.latestTick(),0); assert.equal(r.frames.length,0);
      assert.equal(r.runtime.minds.get(first)!.modelTurns,0);
      respond(p.requests.find(req=>req.id!==first)!,{action:'remove',target:[0,1,1]});
      await until(()=>r.clock.status().phase==='advancing'); r.advance(1000);
      assert.equal(engine.time,1); assert.equal(r.frames.length,10);
      assert.equal(engine.entity('t1').inventory?.kind,'wood'); assert.equal(engine.entity('t2').inventory,null);
      assert.ok(Math.abs(engine.entity('duck').position[2]-1.5)<1e-8);
      assert.equal(store.loadPending(0,'t1','stub-model'),undefined);
      assert.equal(store.eventsAt(0).length,0,'The initial snapshot must not contain a later decision.');
      assert.deepEqual(store.stateAt(20),engine.state()); assert.deepEqual(r.failures,[]);
      return engine.state();
    } finally {r.clock.close();store.close();p.close();}
  };
  assert.deepEqual(await simulate('t1'),await simulate('t2'));
});

test('long motion takes two world turns and results enter the next model context',async()=>{
  const p=await provider(), engine=world(), store=new Store(':memory:',engine.module.manifest), r=run(engine,store,p.url);
  store.record(engine.frame(),engine.state());
  try {
    r.clock.pump(); await until(()=>p.requests.length===2);
    for(const req of p.requests)respond(req,req.id==='t1'?{action:'move',distance:4}:{action:'turn',angle:90});
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
    respond(p.requests.find(req=>req.id==='t1')!,{action:'turn',angle:90});
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
    r.clock.pump();await until(()=>p.requests.length===2);for(const req of p.requests)respond(req,{action:'turn',angle:90});
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
