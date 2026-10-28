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
import { impactPoints } from '../server/agents/tools';
import { recentActions } from '../server/agents/context';

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
async function provider(manualPlanning=false) {
  const requests: Request[] = [];
  const planningRequests: Request[] = [];
  const server = createServer(async (req,res) => {
    let body=''; for await(const chunk of req) body+=chunk;
    const data=JSON.parse(body), id=data.messages[0].content.includes('You are t1,')?'t1':'t2';
    const planningTool=data.tools?.length===1?data.tools[0].function.name:undefined;
    if(['set_plan','review_plan'].includes(planningTool)){
      const request={id,body:data,response:res};planningRequests.push(request);
      if(!manualPlanning){
        const context=JSON.parse(data.messages[1].content);
        respondTool(request,planningTool,planningTool==='set_plan'
          ?{goal:'Investigate the terrain.',milestone:'scan',explanation:'I want to learn about this place.'}
          :{outcome:context.allowedOutcomes[0],explanation:'I reviewed the recorded progress.'});return;
      }
    }
    requests.push({id,body:data,response:res});
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  return { requests, planningRequests, url:`http://127.0.0.1:${(server.address() as {port:number}).port}`, close(){server.closeAllConnections();server.close();} };
}
function respond(request: Request, action: Action) {
  const {action:name,...argumentsValue}=action;
  if(name==='strike_held')return respondTool(request,name,{point:Object.entries(impactPoints).find(([,point])=>JSON.stringify(point)===JSON.stringify(action.impact))?.[0]});
  respondTool(request,name,argumentsValue);
}
function respondTool(request:Request,name:string,argumentsValue:unknown){
  request.response.setHeader('Content-Type','application/json');
  request.response.end(JSON.stringify({choices:[{message:{content:null,tool_calls:[{id:'call-'+request.id,type:'function',function:{name,arguments:JSON.stringify(argumentsValue)}}]}}],usage:{total_tokens:42}}));
}
function respondActions(request:Request,actions:Action[]){
  const tool_calls=actions.map((action,index)=>{
    const {action:name,...argumentsValue}=action;
    return {id:`call-${request.id}-${index}`,type:'function',function:{name,arguments:JSON.stringify(argumentsValue)}};
  });
  request.response.setHeader('Content-Type','application/json');
  request.response.end(JSON.stringify({choices:[{message:{content:null,tool_calls}}],usage:{total_tokens:42}}));
}
async function respondWithCommunicationMenu(p:Awaited<ReturnType<typeof provider>>,request:Request,action:Action){
  if(action.action!=='say'){respond(request,action);return;}
  const closed=request.body.tools.find((tool:any)=>tool.function.name==='say');
  assert.deepEqual(closed.function.parameters.properties,{});
  const before=p.requests.length;respondTool(request,'say',{});await until(()=>p.requests.length===before+1);
  const choice=p.requests[before];assert.equal(choice.id,request.id);
  assert.deepEqual(choice.body.tools.map((tool:any)=>tool.function.name),['say','do_not_reply']);
  const opened=choice.body.tools.find((tool:any)=>tool.function.name==='say');
  assert.ok(opened.function.parameters.properties.word.enum.includes(action.word));
  respond(choice,action);
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

test('planning holds time, reminds every five decisions and reviews after thirty with retained evidence',async()=>{
  const p=await provider(true),engine=world(),store=new Store(':memory:',engine.module.manifest),r=run(engine,store,p.url,null);
  let cursor=0;
  const nextRequest=async()=>{await until(()=>p.requests.length>cursor);return p.requests[cursor++];};
  try{
    engine.setEntityEnabled('t2',false);engine.setEntityEnabled('duck',false);
    store.record(engine.frame(),engine.state(),r.runtime.persistence());
    r.clock.pump();const first=await nextRequest();
    assert.deepEqual(first.body.tools.map((tool:any)=>tool.function.name),['set_plan']);
    r.advance(60000);assert.equal(engine.tick,0);assert.equal(engine.entity('t1').plan,undefined);
    respondTool(first,'set_plan',{goal:'',steps:[],explanation:'Nothing.'});
    const retry=await nextRequest();assert.equal(engine.tick,0);
    respondTool(retry,'set_plan',{goal:'Investigate nearby movement.',milestone:'scan',explanation:'I want to learn how nearby creatures behave.'});
    for(let turn=1;turn<=30;turn++){
      const action=await nextRequest(),prompt=JSON.parse(action.body.messages.at(-1).content);
      assert.equal(prompt.plan.goal,'Investigate nearby movement.');
      assert.equal(prompt.plan.currentStep,'Inspect the surroundings with one scan.');
      if(turn>1)assert.ok(prompt.plan.milestoneReached.length);
      assert.equal(!!prompt.plan.reviewReminder,turn>1&&(turn-1)%5===0);
      assert.equal(p.planningRequests.length,2,'Reminders do not make separate planning requests.');
      assert.equal(action.body.tools.some((tool:any)=>['set_plan','review_plan'].includes(tool.function.name)),false);
      respond(action,{action:turn===1?'find_material':'wait'});await until(()=>r.clock.status().phase==='advancing');r.advance(1000);
      assert.equal(engine.tick,turn*20);r.clock.pump();
    }
    const review=await nextRequest();assert.equal(review.body.tools[0].function.name,'review_plan');
    const situation=JSON.parse(review.body.messages[1].content);
    assert.equal(situation.situation.actionsSinceLastReview.length,5);assert.equal(situation.previousPlan.reviewedTurn,1);
    assert.equal(situation.verifiedProgress.complete,true);
    respondTool(review,'review_plan',{outcome:'complete',explanation:'I investigated nearby movement.'});
    const replacement=await nextRequest();assert.deepEqual(replacement.body.tools.map((tool:any)=>tool.function.name),['set_plan']);
    assert.equal(JSON.parse(replacement.body.messages[1].content).previousPlan.status,'completed');
    assert.equal(engine.tick,600,'Closing and replacing a plan must not consume world time.');
    respondTool(replacement,'set_plan',{goal:'Investigate wood.',milestone:'collect_wood',explanation:'I now want to investigate wood.'});
    const action=await nextRequest();assert.equal(JSON.parse(action.body.messages.at(-1).content).plan.goal,'Investigate wood.');
    assert.doesNotMatch(action.body.messages[0].content,/What memorable fact did you learn about the world/);
    respond(action,{action:'wait'});await until(()=>r.clock.status().phase==='advancing');r.advance(1000);
    const historical=store.stateAt(600).entities.find(entity=>entity.id==='t1')!.plan!;
    const current=store.stateAt(620).entities.find(entity=>entity.id==='t1')!.plan!;
    assert.equal(historical.goal,'Investigate nearby movement.');assert.equal(historical.steps[0].status,'pending');
    assert.equal(current.goal,'Investigate wood.');assert.equal(current.reviewedTurn,31);
    assert.deepEqual(store.eventsAt(620,'t1',300).filter(event=>event.type==='plan').map(event=>(event.data as any).plan.status),['active','completed','active']);
    assert.equal(store.stateAt(0).entities.find(entity=>entity.id==='t1')!.plan,undefined);
    assert.deepEqual(r.failures,[]);
  }finally{r.clock.close();store.close();p.close();}
});

test('early goal acknowledgment requires evidence, survives restart and resets the thirty-decision clock',async()=>{
  const p=await provider(),engine=world(),store=new Store(':memory:',engine.module.manifest),r=run(engine,store,p.url,null);
  let resumed:ReturnType<typeof run>|undefined,cursor=0;
  const next=async()=>{await until(()=>p.requests.length>cursor);return p.requests[cursor++];};
  try{
    engine.setEntityEnabled('t2',false);engine.setEntityEnabled('duck',false);
    store.record(engine.frame(),engine.state(),r.runtime.persistence());r.clock.pump();
    respondTool(await next(),'finish_goal',{outcome:'completed',reason:'I intend to scan.'});
    const rejected=await next();assert.match(rejected.body.messages.at(-1).content,/No recorded effect/);assert.equal(p.planningRequests.length,1);
    respond(rejected,{action:'find_material'});await until(()=>r.clock.status().phase==='advancing');r.advance(1000);r.clock.pump();
    const achieved=await next();assert.ok(JSON.parse(achieved.body.messages.at(-1).content).plan.milestoneReached.length);
    respondTool(achieved,'finish_goal',{outcome:'completed',reason:'The scan finished.'});
    const replacement=await next();assert.equal(p.planningRequests.length,2);assert.equal(engine.tick,20);
    assert.equal(JSON.parse(replacement.body.messages.at(-1).content).plan.reviewInDecisions,30);
    assert.equal(store.stateAt(20).entities.find(item=>item.id==='t1')!.plan!.reviewedTurn,1);
    r.clock.close();const restored=new Engine(engine.module,store.stateAt(20));restored.nextEvent=store.maxEventId()+1;
    resumed=run(restored,store,p.url,null);resumed.clock.pump();
    const afterRestart=await next();assert.equal(p.planningRequests.length,2,'The staged replacement must be reused.');
    assert.equal(JSON.parse(afterRestart.body.messages.at(-1).content).plan.reviewInDecisions,30);
    assert.equal(afterRestart.body.tools.some((tool:any)=>tool.function.name==='finish_goal'),false,'A second goal change is not offered in the same decision.');
    respond(afterRestart,{action:'wait'});await until(()=>resumed!.clock.status().phase==='advancing');resumed.advance(1000);
    assert.equal(restored.entity('t1').plan!.reviewedTurn,2);
    assert.deepEqual(store.eventsAt(40,'t1').filter(event=>event.type==='plan').map(event=>(event.data as any).plan.status),['active','completed','active']);
    for(let turn=3;turn<=31;turn++){
      resumed.clock.pump();respond(await next(),{action:'wait'});await until(()=>resumed!.clock.status().phase==='advancing');resumed.advance(1000);
      assert.equal(p.planningRequests.length,2,'No automatic review before thirty decisions since acknowledgment.');
    }
    resumed.clock.pump();const reviewed=await next();
    assert.equal(p.planningRequests.length,3);assert.equal(JSON.parse(p.planningRequests[2].body.messages[1].content).previousPlan.reviewedTurn,2);
    respond(reviewed,{action:'wait'});await until(()=>resumed!.clock.status().phase==='advancing');resumed.advance(1000);
    assert.deepEqual(resumed.failures,[]);
  }finally{r.clock.close();resumed?.clock.close();store.close();p.close();}
});

test('selected action references persist as physical arguments and revalidate at the shared commit',async()=>{
  const p=await provider(),engine=world(),store=new Store(':memory:',engine.module.manifest),r=run(engine,store,p.url,null);
  let resumed:ReturnType<typeof run>|undefined;
  try{
    engine.setEntityEnabled('t2',false);engine.setEntityEnabled('duck',false);
    engine.entity('t1').inventory={stacks:[{kind:'leaves',count:2}],selected:0,capacity:640};
    store.record(engine.frame(),engine.state(),r.runtime.persistence());r.clock.pump();await until(()=>p.requests.length===1);
    const prompt=JSON.parse(p.requests[0].body.messages.at(-1).content),choice=prompt.choices.find((item:any)=>item.action.action==='place');assert.ok(choice);
    respondTool(p.requests[0],'choose_action',{option:choice.id});await until(()=>r.clock.status().phase==='advancing');
    const pending=store.loadPending<any>(0,'t1',r.runtime.inference.cacheKey);
    assert.equal(pending.calls[0].function.name,'place');assert.deepEqual(JSON.parse(pending.calls[0].function.arguments).target,choice.action.target);
    r.clock.close();const restored=new Engine(engine.module,store.stateAt(0));restored.nextEvent=store.maxEventId()+1;
    restored.voxels.set(choice.action.target,'stone');
    resumed=run(restored,store,p.url,null);resumed.clock.pump();await until(()=>resumed!.clock.status().phase==='advancing');resumed.advance(1000);
    assert.equal(p.requests.length,1,'Ready physical decisions must survive restart without inference.');
    assert.equal(restored.entity('t1').inventory!.stacks[0].count,2);
    assert.ok(store.eventsAt(20,'t1').some(event=>event.type==='rejected'));
  }finally{r.clock.close();resumed?.clock.close();store.close();p.close();}
});

test('an accepted plan survives restart before the physical decision and becomes visible only at commit',async()=>{
  const p=await provider(),engine=world(),store=new Store(':memory:',engine.module.manifest),r=run(engine,store,p.url,null);
  let resumed:ReturnType<typeof run>|undefined;
  try{
    engine.setEntityEnabled('t2',false);engine.setEntityEnabled('duck',false);
    store.record(engine.frame(),engine.state(),r.runtime.persistence());
    r.clock.pump();await until(()=>p.requests.length===1);
    assert.equal(p.planningRequests.length,1);assert.equal(engine.entity('t1').plan,undefined);
    assert.equal(store.loadMind<any>('t1').plan,undefined);
    r.clock.close();const restored=new Engine(engine.module,store.stateAt(0));restored.nextEvent=store.maxEventId()+1;
    resumed=run(restored,store,p.url,null);resumed.clock.pump();await until(()=>p.requests.length===2);
    assert.equal(p.planningRequests.length,1,'An accepted staged plan must not be requested again after restart.');
    assert.equal(JSON.parse(p.requests[1].body.messages.at(-1).content).plan.goal,'Investigate the terrain.');
    respond(p.requests[1],{action:'wait'});await until(()=>resumed!.clock.status().phase==='advancing');resumed.advance(1000);
    assert.equal(restored.entity('t1').plan!.goal,'Investigate the terrain.');
    assert.equal(resumed.runtime.minds.get('t1')!.modelTurns,2);
    assert.deepEqual(store.stateAt(20).entities.find(entity=>entity.id==='t1')!.plan,restored.entity('t1').plan);
    assert.equal(store.eventsAt(20,'t1').filter(event=>event.type==='plan').length,1);
    assert.deepEqual(resumed.failures,[]);
  }finally{r.clock.close();resumed?.clock.close();store.close();p.close();}
});

test('multiple physical actions are rejected before one corrected action consumes a world turn',async()=>{
  const p=await provider(),engine=world(),store=new Store(':memory:',engine.module.manifest),r=run(engine,store,p.url,null);
  try{
    engine.setEntityEnabled('t2',false);engine.setEntityEnabled('duck',false);
    r.clock.pump();await until(()=>p.requests.length===1);
    assert.equal(p.requests[0].body.max_tokens,900);assert.match(p.requests[0].body.messages[0].content,/End this decision with exactly one physical action/i);
    respondActions(p.requests[0],[{action:'turn',angle:90},{action:'wait'}]);
    await until(()=>p.requests.length===2);
    assert.equal(engine.tick,0);assert.equal(engine.entity('t1').yaw,0);
    const corrections=p.requests[1].body.messages.filter((message:any)=>message.role==='tool').map((message:any)=>JSON.parse(message.content).message);
    assert.deepEqual(corrections,['Choose exactly one physical action per response.','Choose exactly one physical action per response.']);
    respond(p.requests[1],{action:'wait'});await until(()=>r.clock.status().phase==='advancing');r.advance(1000);
    assert.equal(engine.tick,20);assert.equal(engine.entity('t1').yaw,0);
    assert.deepEqual(store.eventsAt(20,'t1').filter(event=>event.type==='action').map(event=>(event.data as any).action.action),['wait']);
  }finally{r.clock.close();store.close();p.close();}
});

test('speech wakes a moving agent with only continue or stop while world time remains frozen',async()=>{
  const p=await provider(),engine=world(),store=new Store(':memory:',engine.module.manifest),r=run(engine,store,p.url,null);
  try{
    engine.setEntityEnabled('duck',false);engine.entity('t1').yaw=90;engine.entity('t2').yaw=0;
    r.clock.pump();await until(()=>p.requests.length===2);
    const moss=p.requests.find(request=>request.id==='t1')!,flint=p.requests.find(request=>request.id==='t2')!;
    respond(flint,{action:'walk',distance:8});
    await respondWithCommunicationMenu(p,moss,{action:'say',word:'I like you'});
    await until(()=>r.clock.status().phase==='advancing');

    r.advance(50);await until(()=>p.requests.length===4);
    const interruption=p.requests[3];
    assert.equal(interruption.id,'t2');
    assert.deepEqual(interruption.body.tools.map((tool:any)=>tool.function.name),['continue_moving','stop_moving']);
    const prompt=JSON.parse(interruption.body.messages.at(-1).content);
    assert.equal(prompt.urgentSpeech[0].message,'I like you');
    assert.equal(typeof prompt.urgentSpeech[0].direction,'string');
    assert.equal(typeof prompt.urgentSpeech[0].distanceMetres,'number');
    const tick=engine.tick,position=[...engine.entity('t2').position];
    assert.ok(engine.entity('t2').motion,'The current walk remains active while the model decides.');
    r.advance(5000);
    assert.equal(engine.tick,tick);assert.deepEqual(engine.entity('t2').position,position);

    respondTool(interruption,'stop_moving',{});
    await until(()=>r.clock.status().phase==='advancing');
    assert.equal(engine.entity('t2').motion,undefined);
    assert.equal(p.requests.length,4,'Stopping does not grant an immediate replacement action.');
    r.advance(950);assert.equal(engine.tick,20);assert.equal(r.clock.status().phase,'idle');
    assert.equal(p.requests.length,4);
    r.clock.pump();await until(()=>p.requests.length===6);
    const resumedFlint=p.requests.slice(4).find(request=>request.id==='t2');assert.ok(resumedFlint,'The agent acts again on the next shared turn.');
  }finally{r.clock.close();store.close();p.close();}
});

test('looking sideways makes follow available for the newly seen entity without spending a turn',async()=>{
  const p=await provider(),engine=world(),store=new Store(':memory:',engine.module.manifest),r=run(engine,store,p.url,null);
  try{
    engine.setEntityEnabled('t2',false);delete engine.entity('duck').motion;
    r.clock.pump();await until(()=>p.requests.length===1);assert.equal(p.requests[0].body.tools.some((tool:any)=>tool.function.name==='follow'),false);
    respondTool(p.requests[0],'look',{angle:90});await until(()=>p.requests.length===2);
    assert.equal(engine.tick,0);assert.equal(engine.entity('t1').yaw,0);assert.ok(p.requests[1].body.tools.some((tool:any)=>tool.function.name==='follow'));
    assert.ok(JSON.parse(p.requests[1].body.messages.at(-1).content).interactions.follow.some((target:any)=>target.id==='duck'));
    respond(p.requests[1],{action:'follow',entityId:'duck'});await until(()=>r.clock.status().phase==='advancing');r.advance(1000);
    assert.equal(engine.entity('t1').following?.entityId,'duck');assert.ok(engine.entity('t1').position[0]>1);assert.equal(engine.time,1);
  }finally{r.clock.close();store.close();p.close();}
});

test('a followed agent receives a concise instruction and no follow tool',async()=>{
  const p=await provider(),engine=world(),store=new Store(':memory:',engine.module.manifest),r=run(engine,store,p.url,null);
  try{
    engine.setEntityEnabled('duck',false);engine.entity('t1').yaw=90;engine.entity('t2').yaw=270;
    assert.equal(engine.act('t1',{action:'follow',entityId:'t2'}).ok,true);
    r.clock.pump();await until(()=>p.requests.length===2);
    const followed=p.requests.find(request=>request.id==='t2')!,prompt=JSON.parse(followed.body.messages.at(-1).content);
    assert.deepEqual(prompt.beingFollowed,['t1 is following you. You cannot follow another creature while they follow you; continue choosing your own actions.']);
    assert.equal(followed.body.tools.some((tool:any)=>tool.function.name==='follow'),false);
    assert.ok(followed.body.tools.some((tool:any)=>tool.function.name==='walk'));
    for(const request of p.requests)respond(request,request.id==='t1'?{action:'follow'}:{action:'wait'});
    await until(()=>r.clock.status().phase==='advancing');r.advance(1000);
  }finally{r.clock.close();store.close();p.close();}
});

test('following asks every world second; stopping stages a free normal action that survives a ready-decision restart',async()=>{
  const p=await provider(),engine=world(),store=new Store(':memory:',engine.module.manifest),r=run(engine,store,p.url,null);
  let resumed:ReturnType<typeof run>|undefined;
  try{
    engine.setEntityEnabled('t2',false);const duck=engine.entity('duck');delete duck.motion;duck.position=[-.5,1,5.5];
    engine.entity('t1').inventory={stacks:[{kind:'wood',count:1}],selected:0,capacity:64};
    store.record(engine.frame(),engine.state(),r.runtime.persistence());
    r.clock.pump();await until(()=>p.requests.length===1);
    assert.ok(JSON.parse(p.requests[0].body.messages.at(-1).content).interactions.follow.some((target:any)=>target.id==='duck'));
    respond(p.requests[0],{action:'follow',entityId:'duck'});await until(()=>r.clock.status().phase==='advancing');r.advance(1000);
    assert.equal(engine.tick,20);assert.ok(engine.entity('t1').motion);
    r.clock.pump();await until(()=>p.requests.length===2);
    assert.deepEqual(p.requests[1].body.tools.map((tool:any)=>tool.function.name),['follow','stop_follow']);
    const prompt=JSON.parse(p.requests[1].body.messages.at(-1).content);assert.equal(prompt.following.entityId,'duck');assert.ok(Math.abs(prompt.following.metres-3)<.01);
    assert.equal(prompt.inventory,undefined);assert.equal(prompt.notes,undefined);assert.equal(prompt.hints,undefined);assert.equal(prompt.recent,undefined);
    const frozen=engine.state();r.advance(90000);assert.deepEqual(engine.state(),frozen);
    respond(p.requests[1],{action:'follow'});await until(()=>r.clock.status().phase==='advancing');r.advance(1000);
    assert.equal(engine.tick,40);assert.ok(Math.abs(engine.entity('t1').position[2]-4.5)<1e-8);
    r.clock.pump();await until(()=>p.requests.length===3);respondTool(p.requests[2],'stop_follow',{});await until(()=>p.requests.length===4);
    assert.equal(engine.tick,40);assert.ok(engine.entity('t1').following,'Stopping must not mutate the shared observation instant.');
    assert.ok(p.requests[3].body.tools.some((tool:any)=>tool.function.name==='place'));
    respond(p.requests[3],{action:'place',target:[-1,1,3]});await until(()=>r.clock.status().phase==='advancing');
    assert.ok(engine.entity('t1').following);r.clock.close();
    const restored=new Engine(engine.module,store.stateAt(40));restored.nextEvent=store.maxEventId()+1;
    resumed=run(restored,store,p.url,null);resumed.clock.pump();await until(()=>resumed!.clock.status().phase==='advancing');
    assert.equal(p.requests.length,4,'A ready stop-and-act decision must not call the model again.');
    resumed.advance(1000);assert.equal(restored.tick,60);assert.equal(restored.entity('t1').following,undefined);assert.equal(restored.voxels.get([-1,1,3]),'wood');
    assert.equal(resumed.runtime.minds.get('t1')!.turns,3);
    const actions=store.eventsAt(60,'t1').filter(event=>event.type==='action'&&event.tick===41).map(event=>(event.data as any).action.action);
    assert.deepEqual(actions,['stop_follow','place']);assert.deepEqual(resumed.failures,[]);
  }finally{r.clock.close();resumed?.clock.close();store.close();p.close();}
});

test('a legacy goal-learning journal offer cannot interrupt execution after following stops',async()=>{
  const p=await provider(),engine=world(),store=new Store(':memory:',engine.module.manifest),r=run(engine,store,p.url,null);
  try{
    engine.setEntityEnabled('t2',false);const duck=engine.entity('duck');delete duck.motion;duck.position=[-.5,1,5.5];
    engine.act('t1',{action:'follow',entityId:'duck'});
    Object.assign(r.runtime.minds.get('t1')!,{journalOffer:'You completed a goal. What memorable fact did you learn about the world?'});
    r.clock.pump();await until(()=>p.requests.length===1);
    assert.deepEqual(p.requests[0].body.tools.map((tool:any)=>tool.function.name),['follow','stop_follow']);
    assert.doesNotMatch(p.requests[0].body.messages[0].content,/memorable fact/);
    respondTool(p.requests[0],'stop_follow',{});await until(()=>p.requests.length===2);
    assert.doesNotMatch(p.requests[1].body.messages[0].content,/memorable fact/);
    assert.ok(p.requests[1].body.tools.some((tool:any)=>tool.function.name==='walk'));
    assert.equal(p.requests[1].body.tools.some((tool:any)=>tool.function.name==='reflect'),false);
    assert.equal(engine.tick,0);respond(p.requests[1],{action:'turn',angle:90});
    await until(()=>r.clock.status().phase==='advancing');r.advance(1000);
    assert.equal(engine.tick,20);assert.equal(engine.entity('t1').following,undefined);
    assert.deepEqual(r.runtime.minds.get('t1')!.notes,[]);
  }finally{r.clock.close();store.close();p.close();}
});

test('execution foregrounds the assigned result and current matching targets without unrelated suggestions',async()=>{
  const p=await provider(),engine=world(),store=new Store(':memory:',engine.module.manifest),r=run(engine,store,p.url,null);
  try{
    engine.setEntityEnabled('t2',false);engine.voxels.set([0,1,1],null);engine.voxels.set([0,1,2],'wood');
    const mind=r.runtime.minds.get('t1')!;
    mind.plan={goal:'Collect wood.',status:'active',steps:[{task:'Collect one wood from the world.',status:'pending',criterion:{kind:'collect',subject:'wood'}}],explanation:'Gather one block.',createdTurn:0,reviewedTurn:0,startedAtSecond:0};
    mind.emptyHandMoves=10;mind.carriedMoves=10;mind.notes=['Explore the coast next.'];
    r.clock.pump();await until(()=>p.requests.length===1);
    const first=p.requests[0],prompt=JSON.parse(first.body.messages.at(-1).content);
    assert.match(first.body.messages[0].content,/^CURRENT GOAL: Collect wood\.\nREQUIRED RESULT: Collect one wood/);
    assert.equal(Object.keys(prompt)[0],'plan');
    assert.deepEqual(prompt.plan.criterion,{kind:'collect',subject:'wood'});
    assert.ok(prompt.plan.matchingReachableChoices.length);
    for(const id of prompt.plan.matchingReachableChoices){
      const choice=prompt.choices.find((item:any)=>item.id===id);
      assert.equal(choice.action.action,'hit');assert.deepEqual(choice.action.target,[0,1,2]);
    }
    assert.equal(prompt.reminder,undefined);assert.equal(prompt.hints,undefined);
    assert.match(prompt.actionRequest,/Collect one wood/);
    respondTool(first,'look',{angle:180});await until(()=>p.requests.length===2);
    assert.match(p.requests[1].body.messages[0].content,/^CURRENT GOAL: Collect wood/);
    assert.deepEqual(JSON.parse(p.requests[1].body.messages.at(-1).content).plan.matchingReachableChoices,[]);
    respondTool(p.requests[1],'finish_goal',{outcome:'abandoned',reason:'Choose a different activity.'});await until(()=>p.requests.length===3);
    const changed=p.requests[2];
    assert.match(changed.body.messages[0].content,/^CURRENT GOAL: Investigate the terrain/);
    assert.doesNotMatch(changed.body.messages[0].content,/Collect wood/);
    assert.equal(JSON.parse(changed.body.messages.at(-1).content).plan.reviewInDecisions,30);
    respond(changed,{action:'wait'});
  }finally{r.clock.close();store.close();p.close();}
});

test('curiosity suggestions reach the planner without becoming execution instructions',async()=>{
  const p=await provider(),engine=world(),store=new Store(':memory:',engine.module.manifest),r=run(engine,store,p.url,null);
  try{
    engine.setEntityEnabled('t2',false);
    engine.entity('t1').inventory={stacks:[{kind:'wood',count:1}],selected:0,capacity:64};
    r.runtime.minds.get('t1')!.carriedMoves=10;
    r.clock.pump();await until(()=>p.requests.length===1);
    const planning=JSON.parse(p.planningRequests[0].body.messages[1].content);
    assert.match(planning.situation.suggestions.join(' '),/shapeable/);
    const execution=JSON.parse(p.requests[0].body.messages.at(-1).content);
    assert.equal(execution.hints,undefined);assert.equal(execution.reminder,undefined);
    assert.equal(execution.inventory.holding,'wood');
    assert.ok(p.requests[0].body.tools.some((tool:any)=>tool.function.name==='strike_held'));
    respond(p.requests[0],{action:'wait'});
  }finally{r.clock.close();store.close();p.close();}
});

test('opening communication forces a phrase or an explicit free cancellation',async()=>{
  const p=await provider(),engine=world(),store=new Store(':memory:',engine.module.manifest),r=run(engine,store,p.url,null);
  try{
    engine.setEntityEnabled('t2',false);const duck=engine.entity('duck');delete duck.motion;duck.position=[-.5,1,4.5];
    r.clock.pump();await until(()=>p.requests.length===1);
    assert.ok(p.requests[0].body.tools.some((tool:any)=>tool.function.name==='say'));
    respondTool(p.requests[0],'say',{});await until(()=>p.requests.length===2);
    assert.deepEqual(p.requests[1].body.tools.map((tool:any)=>tool.function.name),['say','do_not_reply']);
    assert.equal(engine.tick,0);
    respondTool(p.requests[1],'do_not_reply',{});await until(()=>p.requests.length===3);
    assert.ok(p.requests[2].body.tools.some((tool:any)=>tool.function.name==='walk'));
    assert.ok(p.requests[2].body.tools.some((tool:any)=>tool.function.name==='say'));
    assert.equal(engine.tick,0);
    respond(p.requests[2],{action:'wait'});await until(()=>r.clock.status().phase==='advancing');r.advance(1000);
    assert.equal(engine.time,1);
  }finally{r.clock.close();store.close();p.close();}
});

test('sequential inference finishes one complete agent decision before starting the next and preserves the shared instant',async()=>{
  const p=await provider(),engine=world(),store=new Store(':memory:',engine.module.manifest),r=run(engine,store,p.url,null);
  try{
    assert.equal(r.runtime.parallelRequests,true);r.runtime.setParallelRequests(false);
    assert.equal(new AgentRuntime(engine,store,r.runtime.config).parallelRequests,false,'The server preference survives runtime reconstruction.');
    store.record(engine.frame(),engine.state(),r.runtime.persistence());const initial=engine.state();
    r.clock.pump();await until(()=>p.requests.length===1);assert.equal(p.requests[0].id,'t1');
    r.advance(90000);assert.deepEqual(engine.state(),initial);assert.equal(p.requests.length,1);
    respondTool(p.requests[0],'look',{angle:0});await until(()=>p.requests.length===2);
    assert.equal(p.requests[1].id,'t1','Supporting tool calls belong to the same sequential decision.');
    assert.deepEqual(engine.state(),initial);assert.equal(r.clock.status().agents.t2?.state,'waiting');
    respond(p.requests[1],{action:'wait'});await until(()=>p.requests.length===3);
    assert.equal(p.requests[2].id,'t2');assert.equal(r.clock.status().agents.t1?.state,'ready');
    assert.deepEqual(engine.state(),initial);assert.equal(store.latestTick(),0);
    r.runtime.setParallelRequests(true);assert.equal(p.requests.length,3,'A mode change does not cancel or duplicate the current turn.');
    respond(p.requests[2],{action:'wait'});await until(()=>r.clock.status().phase==='advancing');r.advance(1000);
    assert.equal(engine.time,1);
    const observations=store.eventsAt(engine.tick).filter(event=>event.type==='observation');
    assert.equal(observations.length,2);assert.ok(observations.every(event=>(event.data as any).observation.tick===0));
    r.clock.pump();await until(()=>p.requests.length===5);assert.deepEqual(p.requests.slice(3).map(request=>request.id).sort(),['t1','t2']);
    for(const request of p.requests.slice(3))respond(request,{action:'wait'});
    assert.equal(new AgentRuntime(engine,store,r.runtime.config).parallelRequests,true);assert.deepEqual(r.failures,[]);
  }finally{r.clock.close();store.close();p.close();}
});

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

test('the provider rejects excessive tool calls',async()=>{
  const server=createServer(async(req,res)=>{
    for await(const _ of req){}
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({choices:[{message:{content:null,tool_calls:Array.from({length:24},(_,index)=>({id:`call-${index}`,type:'function',function:{name:'wait',arguments:'{}'}}))}}]}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const chain=new ProviderChain([{id:'local',name:'Local',apiKey:'local',baseUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}`,model:'model'}]);
  try{
    await assert.rejects(chain.complete({messages:[],tools:[],max_tokens:900},new AbortController().signal,()=>{}),/invalid tool calls/);
  }finally{server.closeAllConnections();server.close();}
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
    assert.equal(unlimited.runtime.minds.get('t1')!.modelTurns,252);

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
    assert.equal(r.runtime.minds.get('t1')!.modelTurns,2);
    assert.equal(r.runtime.minds.get('t2')!.modelTurns,0);
    assert.equal(engine.entity('t2').status,'disabled');
  }finally{r.clock.close();store.close();p.close();}
});

test('look returns perception inside the same frozen decision before a physical action',async()=>{
  const p=await provider(),engine=world(),store=new Store(':memory:',engine.module.manifest),r=run(engine,store,p.url,null);
  try{
    engine.setEntityEnabled('t2',false);r.clock.pump();await until(()=>p.requests.length===1);
    respondTool(p.requests[0],'look',{angle:90});await until(()=>p.requests.length===2);
    assert.equal(engine.tick,0);assert.ok(p.requests[1].body.messages.some((message:any)=>message.role==='tool'&&JSON.parse(message.content).perception));
    respond(p.requests[1],{action:'wait'});await until(()=>r.clock.status().phase==='advancing');assert.equal(engine.tick,0);r.advance(1000);
    assert.equal(engine.time,1);assert.equal(r.runtime.minds.get('t1')!.modelTurns,3);
  }finally{r.clock.close();store.close();p.close();}
});

test('an out-of-range jump is corrected during inference without consuming a world turn',async()=>{
  const p=await provider(),engine=world(),store=new Store(':memory:',engine.module.manifest),r=run(engine,store,p.url,null);
  try{
    engine.setEntityEnabled('t2',false);r.clock.pump();await until(()=>p.requests.length===1);
    respond(p.requests[0],{action:'jump',angle:-161,distance:1});await until(()=>p.requests.length===2);
    assert.equal(engine.tick,0);assert.equal(engine.entity('t1').motion,undefined);
    const correction=JSON.parse(p.requests[1].body.messages.at(-1).content);
    assert.equal(correction.ok,false);assert.match(correction.message,/Turn first/);
    respond(p.requests[1],{action:'wait'});await until(()=>r.clock.status().phase==='advancing');r.advance(1000);
    assert.equal(engine.tick,20);assert.equal(store.eventsAt(20,'t1').filter(event=>event.type==='rejected').length,0);
  }finally{r.clock.close();store.close();p.close();}
});

test('repeated supporting tools stop in a visible recoverable error without advancing time',async()=>{
  const p=await provider(),engine=world(),store=new Store(':memory:',engine.module.manifest),r=run(engine,store,p.url,null);
  try{
    engine.setEntityEnabled('t2',false);r.clock.pump();await until(()=>p.requests.length===1);
    for(let index=0;index<4;index++){
      respondTool(p.requests[index],'journal',{note:`Temporary observation ${index}.`});
      await until(()=>p.requests.length===index+2);
    }
    respondTool(p.requests[4],'journal',{note:'One supporting call too many.'});
    await until(()=>r.clock.status().phase==='error');
    const status=r.clock.status();
    assert.equal(engine.tick,0);assert.equal(status.agents.t1.state,'error');
    assert.match(status.agents.t1.message!,/limit of 4 supporting tool calls/);
    assert.deepEqual(r.runtime.minds.get('t1')!.notes,[],'Uncommitted supporting calls are discarded.');
    assert.deepEqual(r.failures,[],'A decision loop is not a fatal server error.');
    r.clock.setEnabled(false);assert.equal(r.clock.status().phase,'paused');
    r.clock.setEnabled(true);r.clock.pump();await until(()=>p.requests.length===6);
    respond(p.requests[5],{action:'wait'});await until(()=>r.clock.status().phase==='advancing');r.advance(1000);
    assert.equal(engine.tick,20);
  }finally{r.clock.close();store.close();p.close();}
});

test('repeated invalid physical choices stop after four correction rounds',async()=>{
  const p=await provider(),engine=world(),store=new Store(':memory:',engine.module.manifest),r=run(engine,store,p.url,null);
  try{
    engine.setEntityEnabled('t2',false);r.clock.pump();await until(()=>p.requests.length===1);
    for(let index=0;index<4;index++){
      respondTool(p.requests[index],'choose_action',{option:'not_a_current_choice'});
      if(index<3)await until(()=>p.requests.length===index+2);
    }
    await until(()=>r.clock.status().phase==='error');
    assert.equal(engine.tick,0);assert.equal(p.requests.length,4);
    assert.match(r.clock.status().agents.t1.message!,/correction limit of 4/);
    assert.deepEqual(r.failures,[]);
  }finally{r.clock.close();store.close();p.close();}
});

test('goal leads crack attention and the last result, and attention disappears after the block breaks',async()=>{
  const p=await provider(),engine=world(),store=new Store(':memory:',engine.module.manifest),r=run(engine,store,p.url,null);
  try{
    engine.setEntityEnabled('t2',false);engine.act('t1',{action:'hit',target:[0,1,1]});
    for(let index=0;index<2;index++){
      r.clock.pump();await until(()=>p.requests.length===index+1);
      const request=p.requests[index],context=JSON.parse(request.body.messages.at(-1).content);
      assert.deepEqual(Object.keys(context).slice(0,3),['plan','attention','lastResult']);
      assert.match(context.attention,/wood block at \[0,1,1\].*same block/);
      assert.equal(request.body.tools[0].function.name,'choose_action');
      respond(request,{action:'hit',target:[0,1,1]});await until(()=>r.clock.status().phase==='advancing');r.advance(1000);
    }
    assert.ok(store.eventsAt(engine.tick,'t1').some(event=>event.type==='observation'&&(event.data as any).attention?.includes('same block')));
    r.clock.pump();await until(()=>p.requests.length===3);
    assert.equal(JSON.parse(p.requests[2].body.messages.at(-1).content).attention,undefined);
    const disabledHit=p.requests[2].body.tools.find((tool:any)=>tool.function.name==='hit');
    assert.equal(disabledHit.function.description.includes('Disabled while you hold wood'),true);
    respond(p.requests[2],{action:'wait'});
  }finally{r.clock.close();store.close();p.close();}
});

test('full journal compaction is staged, persists with ready decisions, and only repeats when full again',async()=>{
  const p=await provider(),engine=world(),store=new Store(':memory:',engine.module.manifest),r=run(engine,store,p.url,null);
  let resumed:ReturnType<typeof run>|undefined;
  try{
    engine.setEntityEnabled('t2',false);
    const old=Array.from({length:10},(_,i)=>`Shore task ${i}: unfinished.`),compacted=['Shore tasks 0 through 4: unfinished.',...old.slice(5)];
    r.runtime.minds.get('t1')!.notes=[...old];store.record(engine.frame(),engine.state(),r.runtime.persistence());
    r.clock.pump();await until(()=>p.requests.length===1);
    respondTool(p.requests[0],'journal',{note:'New goal: build a shelter.'});await until(()=>p.requests.length===2);
    assert.deepEqual(p.requests[1].body.tools.map((tool:any)=>tool.function.name),['submit_journal']);
    assert.deepEqual(r.runtime.minds.get('t1')!.notes,old);
    const frozen=engine.state();r.advance(30000);assert.deepEqual(engine.state(),frozen);
    respondTool(p.requests[1],'submit_journal',{notes:compacted});await until(()=>p.requests.length===3);
    const next=[...compacted,'New goal: build a shelter.'];
    assert.deepEqual(JSON.parse(p.requests[2].body.messages.at(-1).content).notes,next);
    assert.deepEqual(r.runtime.minds.get('t1')!.notes,old,'Changes wait for the shared commit.');
    respond(p.requests[2],{action:'wait'});await until(()=>r.clock.status().phase==='advancing');r.clock.close();
    const restored=new Engine(engine.module,store.stateAt(0));restored.nextEvent=store.maxEventId()+1;
    resumed=run(restored,store,p.url,null);resumed.clock.pump();await until(()=>resumed!.clock.status().phase==='advancing');
    assert.equal(p.requests.length,3,'A ready decision reuses its compaction after restart.');
    resumed.advance(1000);assert.deepEqual(store.memoryAt(restored.tick,'t1'),next);
    const recorded=store.eventsAt(restored.tick,'t1').find(event=>event.type==='journal-compaction')!;
    assert.deepEqual((recorded.data as any).before,old);assert.deepEqual((recorded.data as any).after,compacted);
    resumed.clock.pump();await until(()=>p.requests.length===4);
    for(let index=0;index<3;index++){
      respondTool(p.requests[3+index],'journal',{note:`Shelter progress ${index}: gathered material.`});await until(()=>p.requests.length===5+index);
      assert.ok(p.requests[4+index].body.tools.some((tool:any)=>tool.function.name==='journal'),'Free slots do not require compaction.');
    }
    respondTool(p.requests[6],'journal',{note:'Shelter goal completed.'});await until(()=>p.requests.length===8);
    assert.deepEqual(p.requests[7].body.tools.map((tool:any)=>tool.function.name),['submit_journal']);
    const current=JSON.parse(p.requests[7].body.messages[1].content).journal;
    assert.equal(current.length,10);
    respondTool(p.requests[7],'submit_journal',{notes:current});await until(()=>p.requests.length===9);
    const finalNotes=[...current.slice(1),'Shelter goal completed.'];
    assert.deepEqual(JSON.parse(p.requests[8].body.messages.at(-1).content).notes,finalNotes);
    respond(p.requests[8],{action:'wait'});await until(()=>resumed!.clock.status().phase==='advancing');resumed.advance(1000);
    assert.deepEqual(store.memoryAt(restored.tick,'t1'),finalNotes);
    assert.equal(store.eventsAt(restored.tick,'t1').filter(event=>event.type==='journal-compaction').length,2);
  }finally{r.clock.close();resumed?.clock.close();store.close();p.close();}
});

test('journal favors durable world knowledge and persists notes for future prompts',async()=>{
  const p=await provider(),engine=world(),store=new Store(':memory:',engine.module.manifest),r=run(engine,store,p.url,null);
  try{
    engine.setEntityEnabled('t2',false);r.clock.pump();await until(()=>p.requests.length===1);
    assert.match(p.requests[0].body.tools.find((tool:any)=>tool.function.name==='journal').function.description,/memorable fact learned about the world/i);
    assert.match(p.requests[0].body.messages[0].content,/current goal and its one observable milestone/);
    assert.match(p.requests[0].body.messages[0].content,/Your mission is to complete/);
    assert.doesNotMatch(p.requests[0].body.messages[0].content,/curious|curiosity/i);
    assert.match(p.planningRequests[0].body.messages[0].content,/You are t1, a curious Troglodyte/);
    assert.match(p.planningRequests[0].body.messages[0].content,/Choose worthwhile activities from curiosity/);
    assert.doesNotMatch(p.planningRequests[0].body.messages[0].content,/Your mission is to complete/);
    assert.match(p.requests[0].body.messages[0].content,/milestoneReached confirms success, use finish_goal/);
    assert.match(p.requests[0].body.messages[0].content,/Prefer a labeled choice for reachable interactions or checked movement/);
    assert.doesNotMatch(p.requests[0].body.messages[0].content,/journal/);
    const firstContext=JSON.parse(p.requests[0].body.messages.at(-1).content);
    assert.deepEqual(firstContext.plan.matchingReachableChoices,['scan_surroundings']);
    assert.equal(firstContext.choices[0].id,'scan_surroundings');
    assert.ok(p.requests[0].body.tools.find((tool:any)=>tool.function.name==='choose_action').function.parameters.properties.option.enum.includes('scan_surroundings'));
    for(let index=0;index<3;index++){
      respondTool(p.requests[index],'journal',{note:`I want to explore area ${index}.`});await until(()=>p.requests.length===index+2);
      assert.equal(engine.tick,0);
      const result=JSON.parse(p.requests[index+1].body.messages.at(-1).content);assert.equal(result.ok,true);
    }
    respond(p.requests[3],{action:'wait'});await until(()=>r.clock.status().phase==='advancing');r.advance(1000);
    assert.deepEqual(store.memoryAt(engine.tick,'t1'),Array.from({length:3},(_,index)=>`I want to explore area ${index}.`));
    r.clock.pump();await until(()=>p.requests.length===5);assert.ok(JSON.parse(p.requests[4].body.messages.at(-1).content).notes.includes('I want to explore area 2.'));
    respond(p.requests[4],{action:'wait'});
  }finally{r.clock.close();store.close();p.close();}
});

test('replacing an obsolete journal goal stays staged, needs no compaction and survives restart',async()=>{
  const p=await provider(),engine=world(),store=new Store(':memory:',engine.module.manifest),r=run(engine,store,p.url,null);
  let resumed:ReturnType<typeof run>|undefined;
  try{
    engine.setEntityEnabled('t2',false);
    const old=Array.from({length:10},(_,index)=>`Goal ${index}: explore this area.`);
    r.runtime.minds.get('t1')!.notes=[...old];store.record(engine.frame(),engine.state(),r.runtime.persistence());
    r.clock.pump();await until(()=>p.requests.length===1);
    const journal=p.requests[0].body.tools.find((tool:any)=>tool.function.name==='journal');
    assert.deepEqual(journal.function.parameters.properties.replace.enum,[0,1,2,3,4,5,6,7,8,9]);
    assert.match(p.requests[0].body.messages[0].content,/past records.*oldest first/);
    const note='Coastal path at [4,1,8]: rise crossed; next gather sand to extend the path.';
    respondTool(p.requests[0],'journal',{replace:99,note});await until(()=>p.requests.length===2);
    assert.equal(JSON.parse(p.requests[1].body.messages.at(-1).content).ok,false);
    respondTool(p.requests[1],'journal',{replace:0,note});await until(()=>p.requests.length===3);
    const next=[...old.slice(1),note];
    assert.deepEqual(JSON.parse(p.requests[2].body.messages.at(-1).content).notes,next);
    assert.ok(p.requests[2].body.tools.some((tool:any)=>tool.function.name==='walk'));
    assert.deepEqual(r.runtime.minds.get('t1')!.notes,old);
    respond(p.requests[2],{action:'wait'});await until(()=>r.clock.status().phase==='advancing');r.clock.close();
    const restored=new Engine(engine.module,store.stateAt(0));restored.nextEvent=store.maxEventId()+1;
    resumed=run(restored,store,p.url,null);resumed.clock.pump();await until(()=>resumed!.clock.status().phase==='advancing');
    assert.equal(p.requests.length,3,'A ready journal edit is not inferred again on restart.');
    resumed.advance(1000);
    assert.deepEqual(store.memoryAt(restored.tick,'t1'),next);assert.deepEqual(resumed.runtime.minds.get('t1')!.notes,next);
    assert.equal(store.eventsAt(restored.tick).some(event=>event.type==='journal-compaction'),false);
  }finally{r.clock.close();resumed?.clock.close();store.close();p.close();}
});

test('invalid item IDs are repaired before committing and valid choices are rechecked against the shared world',async()=>{
  const p=await provider(),engine=world(),store=new Store(':memory:',engine.module.manifest),r=run(engine,store,p.url,null);
  try{
    engine.setEntityEnabled('t2',false);
    engine.bodies.push({id:'near-arrow',kind:'arrow',position:[-.5,1.3,1.5],velocity:[0,0,0],resting:true});
    r.clock.pump();await until(()=>p.requests.length===1);
    assert.deepEqual(p.requests[0].body.tools.find((tool:any)=>tool.function.name==='pickup').function.parameters.properties.itemId.enum,['near-arrow']);
    respondTool(p.requests[0],'pickup',{itemId:'arrow'});await until(()=>p.requests.length===2);
    assert.equal(engine.tick,0);assert.equal(engine.entity('t1').inventory,null);
    assert.equal(JSON.parse(p.requests[1].body.messages.at(-1).content).ok,false);
    respondTool(p.requests[1],'pickup',{itemId:'near-arrow'});await until(()=>r.clock.status().phase==='advancing');
    engine.bodies=engine.bodies.filter(body=>body.id!=='near-arrow');r.advance(1000);
    assert.equal(engine.entity('t1').lastAction!.ok,false);assert.match(engine.entity('t1').lastAction!.message,/no longer loose/);
    assert.equal(engine.entity('t1').inventory,null);assert.equal(r.runtime.minds.get('t1')!.turns,1);
  }finally{r.clock.close();store.close();p.close();}
});

test('disabled occupied-hand actions and a missing shaping orientation are repaired before a world turn commits',async()=>{
  const p=await provider(),engine=world(),store=new Store(':memory:',engine.module.manifest),r=run(engine,store,p.url,null);
  try{
    engine.setEntityEnabled('t2',false);engine.entity('t1').inventory={stacks:[{kind:'wood',count:1}],selected:0,capacity:64};
    r.clock.pump();await until(()=>p.requests.length===1);
    respondTool(p.requests[0],'run',{distance:4});await until(()=>p.requests.length===2);
    assert.match(JSON.parse(p.requests[1].body.messages.at(-1).content).message,/Run is unavailable/);assert.equal(engine.tick,0);
    respondTool(p.requests[1],'hit',{target:[0,1,1]});await until(()=>p.requests.length===3);
    assert.match(JSON.parse(p.requests[2].body.messages.at(-1).content).message,/Hit is unavailable while you hold wood/);assert.equal(engine.tick,0);
    respondTool(p.requests[2],'strike_held',{point:'front_edge'});await until(()=>p.requests.length===4);
    assert.match(JSON.parse(p.requests[3].body.messages.at(-1).content).message,/orientation up or down/);
    assert.equal(engine.tick,0);assert.equal(engine.held(engine.entity('t1'))?.kind,'wood');
    respondTool(p.requests[3],'strike_held',{point:'front_edge',orientation:'up'});await until(()=>r.clock.status().phase==='advancing');
    r.advance(1000);assert.equal(engine.held(engine.entity('t1'))?.kind,'door_half_up');
    assert.equal(store.actionEventsAt(engine.tick,'t1').length,1);
  }finally{r.clock.close();store.close();p.close();}
});

test('resuming trims private notes and sources recent actions from the recorded world history',()=>{
  const engine=world(),store=new Store(':memory:',engine.module.manifest);
  try{
    const notes=Array.from({length:20},(_,index)=>`note ${index}`);
    engine.act('t1',{action:'turn',angle:-90});engine.act('t1',{action:'walk',distance:4});
    store.record(engine.frame(),engine.state(),[['t1',{notes,turns:4,modelTurns:4,cycles:[[{role:'user',content:'old landscape and stale item IDs'}]]}]]);
    const runtime=new AgentRuntime(engine,store,{providers:[],maxTurns:null});
    assert.deepEqual(runtime.minds.get('t1')!.notes,notes.slice(-10));
    assert.doesNotMatch(JSON.stringify(runtime.minds.get('t1')),/old landscape|stale item IDs/);
    assert.deepEqual(recentActions(store.actionEventsAt(engine.tick,'t1')),[
      {eventId:1,atSecond:0,action:'turn',args:{angle:-90},result:{ok:true,outcome:'completed',message:'Turned to 270 degrees.',facing:270}},
      {eventId:2,atSecond:0,action:'walk',args:{distance:4},result:{ok:true,outcome:'started',message:'You start walking toward a point 4.0 metres ahead.',from:[-.5,1,.5],destination:[-4.5,1,.5]}},
    ]);
    store.record(engine.frame(),engine.state(),runtime.persistence());
    assert.deepEqual(store.loadMind<{notes:string[]}>('t1')!.notes,notes.slice(-10));
  }finally{store.close();}
});

test('encounter notices reach both prompts and are acknowledged only at the shared commit',async()=>{
  const p=await provider(),engine=world(),store=new Store(':memory:',engine.module.manifest);
  engine.setEntityEnabled('duck',false);
  engine.entity('t1').yaw=90;engine.entity('t2').yaw=270;
  for(let tick=0;tick<20;tick++)engine.step();store.record(engine.frame(),engine.state());
  const r=run(engine,store,p.url,null);
  try{
    r.clock.pump();await until(()=>p.requests.length===2);
    for(const request of p.requests){const prompt=JSON.parse(request.body.messages.at(-1).content);assert.equal(prompt.interactions.speak.length,1);assert.equal(prompt.hints,undefined);assert.equal(prompt.encounters,undefined);}
    respond(p.requests.find(request=>request.id==='t1')!,{action:'wait'});await until(()=>r.clock.status().agents.t1?.state==='ready');assert.equal(engine.observe('t1').encounters.length,1);
    respond(p.requests.find(request=>request.id==='t2')!,{action:'wait'});await until(()=>r.clock.status().phase==='advancing');r.advance(1000);
    assert.equal(engine.observe('t1').encounters.length,0);assert.equal(engine.observe('t2').encounters.length,0);
    r.clock.pump();await until(()=>p.requests.length===4);for(const request of p.requests.slice(2)){assert.equal(JSON.parse(request.body.messages.at(-1).content).encounters,undefined);respond(request,{action:'wait'});}
  }finally{r.clock.close();store.close();p.close();}
});

test('authoritative discoveries enter future prompts as persistent learned knowledge',async()=>{
  const p=await provider(),engine=world(),store=new Store(':memory:',engine.module.manifest),r=run(engine,store,p.url,null);
  try{
    engine.setEntityEnabled('t2',false);engine.discoveries.set('t1',new Set(['thrown-blocks-settle','deep-water-limit']));
    engine.entity('t1').inventory={stacks:[{kind:'wood',count:1}],selected:0,capacity:64};r.clock.pump();await until(()=>p.requests.length===1);
    assert.deepEqual(JSON.parse(p.requests[0].body.messages.at(-1).content).learned,['Thrown blocks settle and become part of the terrain.','The island ends at deep water. I cannot leave it because the water would rise above half my height.']);
    assert.doesNotMatch(p.requests[0].body.messages[0].content,/Learned knowledge/);
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

test('long motion takes two world turns and results enter the next model context',async()=>{
  const p=await provider(), engine=world(), store=new Store(':memory:',engine.module.manifest), r=run(engine,store,p.url);
  store.record(engine.frame(),engine.state());
  try {
    r.clock.pump(); await until(()=>p.requests.length===2);
    for(const req of p.requests)respond(req,req.id==='t1'?{action:'walk',distance:4}:{action:'wait'});
    await until(()=>r.clock.status().phase==='advancing'); r.advance(1000);
    assert.ok(Math.abs(engine.entity('t1').position[2]-2.5)<1e-8); assert.ok(engine.entity('t1').motion);
    r.clock.pump();await until(()=>p.requests.length===3);
    assert.equal(p.requests[2].id,'t2');assert.equal(JSON.parse(p.requests[2].body.messages.at(-1).content).recent[0].action,'wait');assert.equal(p.requests[2].body.messages.some((m:any)=>m.role==='tool'),false);
    r.advance(600000); assert.equal(engine.time,1); assert.ok(Math.abs(engine.entity('t1').position[2]-2.5)<1e-8);
    respond(p.requests[2],{action:'wait'}); await until(()=>r.clock.status().phase==='advancing'); r.advance(1000);
    assert.equal(engine.time,2); assert.ok(Math.abs(engine.entity('t1').position[2]-4.5)<1e-8); assert.equal(engine.entity('t1').motion,undefined);
    assert.equal(r.runtime.minds.get('t1')!.modelTurns,2); assert.deepEqual(r.failures,[]);
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
    assert.equal(resumed.runtime.minds.get('t1')!.modelTurns,2);assert.deepEqual(resumed.failures,[]);
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
