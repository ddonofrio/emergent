import { test } from 'node:test';
import { projectReply } from './agent-fixtures';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { Engine } from '../src/core/engine';
import { island } from '../src/modules/island';
import type { AgentPlan, Block, Entity } from '../src/core/types';
import { Store } from '../server/store';
import { AgentRuntime, type PreparedTurn } from '../server/agents/runtime';
import { inventoryAmounts, milestoneEvidence } from '../server/agents/milestones';
import { actionFeedback, compactResult, decisionCycle, decisionView, recentActions, speechContext } from '../server/agents/context';
import { needsPlanReview } from '../server/agents/planning';
import type { CompletionRequest, CompletionResult } from '../server/agents/providers';
import { InferenceAuditError, PROMPT_VERSION } from '../server/agents/audit';
import { worldTools } from '../server/agents/tools';

function fixture() {
  const blocks:Block[]=[];
  for(let x=-5;x<=5;x++)for(let z=-5;z<=7;z++)blocks.push([x,0,z,'stone']);
  blocks.push([0,1,2,'wood']);
  const entity:Entity={id:'t1',name:'Flint',kind:'troglodyte',controller:'agent',position:[.5,1,.5],height:2,yaw:0,inventory:{stacks:[{kind:'wood',count:1}],selected:null,capacity:640},color:'#fff',status:'idle'};
  const other:Entity={...entity,id:'t2',name:'Moss',controller:'wander',position:[2.5,1,4.5],inventory:null};
  const engine=new Engine({...island,generate:()=>({blocks,entities:[entity,other]})});
  const store=new Store(':memory:',engine.module.manifest);
  const runtime=new AgentRuntime(engine,store,{providers:[{id:'stub',name:'Stub',baseUrl:'http://unused.invalid',apiKey:'secret-not-for-recordings',model:'stub'}],maxTurns:null,retryDelayMs:1});
  const plan:AgentPlan={version:2,goal:'Collect one more wood.',steps:[{task:'Collect one more wood.',criterion:{kind:'collect',subject:'wood'},status:'pending'}],status:'active',explanation:'Gather more wood.',createdTurn:0,reviewedTurn:0,startedAtSecond:0,inventoryBaseline:inventoryAmounts(entity.inventory)};
  runtime.minds.get('t1')!.plan=plan;
  store.record(engine.frame(),engine.state(),runtime.persistence());
  return {engine,store,runtime,plan};
}
const answer=(name:string,args:unknown):CompletionResult=>({provider:'stub',providerName:'Stub',model:'stub',content:null,calls:[{type:'function',id:'choice',function:{name,arguments:JSON.stringify(projectReply(name,args))}}]});
const context=(request:CompletionRequest)=>JSON.parse((request.messages[1] as {content:string}).content);
const commit=(engine:Engine,store:Store,runtime:AgentRuntime,turn:PreparedTurn)=>{
  engine.step(()=>runtime.commit(turn));
  while(engine.tick<turn.tick+20)engine.step();
  store.record(engine.frame(),engine.state(),runtime.persistence());
};

test('truncated OpenAI tool calls recover without poisoning history or advancing world time',async t=>{
  const {engine,store,runtime}=fixture();
  let attempts=0;
  t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
    const body=JSON.parse(String(init.body));
    assert.equal(engine.tick,0);
    assert.equal(body.max_tokens,900);
    assert.equal(body.max_completion_tokens,900);
    if(attempts===1){
      const retryText=body.messages.filter((message:{role?:string})=>message.role==='user').at(-1).content;
      assert.equal(retryText.match(/^Limit token usage\./gm)?.length,1);
      assert.match(retryText,/0 reasoning tokens and 900 output tokens/);
    }
    for(const message of body.messages)for(const call of message.tool_calls??[])assert.doesNotThrow(()=>JSON.parse(call.function.arguments));
    attempts++;
    const message=attempts<3?{content:null,tool_calls:[{id:'broken',type:'function',function:{name:'finish_goal',arguments:'{"outcome":"completed","reason":"cut off'}}]}:{content:null,tool_calls:[{id:'valid',type:'function',function:{name:'wait',arguments:'{}'}}]};
    return new Response(JSON.stringify({choices:[{finish_reason:attempts===1?'length':'stop',message}]}));
  });
  try{
    const turn=await runtime.prepareTurn(AbortSignal.timeout(3000),()=>{});
    assert.equal(attempts,3);
    assert.equal(engine.tick,0);
    assert.deepEqual(turn.decisions[0].calls.map(call=>call.function.name),['wait']);
    assert.deepEqual(store.db.prepare('SELECT status FROM inference_audit ORDER BY id').all().map(row=>row.status),['failed','failed','completed']);
    const first=store.db.prepare('SELECT response FROM inference_audit ORDER BY id LIMIT 1').get()!;
    assert.match(JSON.parse(inflateSync(first.response as Uint8Array).toString()).message,/token limit/);
    commit(engine,store,runtime,turn);
    assert.equal(engine.tick,20);
  }finally{store.close();}
});

test('malformed Bedrock tool names never poison correction history or advance world time',async()=>{
  const {engine,store,runtime}=fixture();
  try{
    runtime.setInferenceConfig([{id:'bedrock',type:'amazon-bedrock',name:'Bedrock',apiKey:'test',baseUrl:'',model:'test'},
      {id:'inactive',name:'Inactive',apiKey:'test',baseUrl:'http://unused.invalid',model:'test'}],'first-only');
    let requests=0;
    const clients=(runtime.inference as unknown as {bedrockClients:Map<string,unknown>}).bedrockClients;
    clients.set('bedrock:',{async send(command:{input:{messages:{content:{toolUse?:{name:string}}[]}[]}}){
      assert.equal(engine.tick,0);
      for(const message of command.input.messages)for(const block of message.content){
        if(block.toolUse)assert.match(block.toolUse.name,/^[a-zA-Z0-9_-]+$/);
      }
      return {output:{message:{role:'assistant',content:[{toolUse:{toolUseId:`call-${++requests}`,name:requests===1?'choices</arg_value>':requests===2?'halt</arg_value>':'wait',input:{}}}]}}};
    }});
    const turn=await runtime.prepareTurn(AbortSignal.timeout(3000),()=>{});
    assert.equal(requests,3);
    assert.equal(engine.tick,0);
    assert.deepEqual(turn.decisions[0].calls.map(call=>call.function.name),['wait']);
    assert.deepEqual(store.db.prepare('SELECT status FROM inference_audit ORDER BY id').all().map(row=>row.status),['failed','failed','completed']);
    commit(engine,store,runtime,turn);
    assert.equal(engine.tick,20);
  }finally{store.close();}
});

test('collection requires a new unit, not recycling an owned block; unknown transformations remain undisclosed',()=>{
  const {engine,store,plan}=fixture();
  try{
    engine.step();engine.act('t1',{action:'hold',stack:0});
    assert.equal(engine.act('t1',{action:'place',target:[1,1,1]}).ok,true);
    for(let i=0;i<3;i++)assert.equal(engine.act('t1',{action:'hit',target:[1,1,1]}).ok,true);
    assert.deepEqual(milestoneEvidence(plan,recentActions(engine.recentEvents),engine.observe('t1')),[]);
    engine.act('t1',{action:'store'});
    for(let i=0;i<3;i++)assert.equal(engine.act('t1',{action:'hit',target:[0,1,2]}).ok,true);
    assert.equal(milestoneEvidence(plan,recentActions(engine.recentEvents),engine.observe('t1')).length,1);
    engine.voxels.set([1,1,2],'plant');engine.act('t1',{action:'store'});
    const plantPlan:AgentPlan={...plan,steps:[{task:'Collect a plant.',status:'pending',criterion:{kind:'collect',subject:'plant'}}],inventoryBaseline:inventoryAmounts(engine.entity('t1').inventory),startedAtSecond:engine.time};
    assert.doesNotMatch(JSON.stringify(decisionView(engine.observe('t1'))),/stick/);
    engine.step();for(let i=0;i<3;i++)engine.act('t1',{action:'hit',target:[1,1,2]});
    assert.equal(milestoneEvidence(plantPlan,recentActions(engine.recentEvents),engine.observe('t1')).length,1);
  }finally{store.close();}
});

test('approaching a named creature requires a current local sighting within range',()=>{
  const {engine,store,plan}=fixture();
  try{
    const social:AgentPlan={...plan,goal:'Approach Moss.',steps:[{task:'Get within two metres of Moss.',criterion:{kind:'approach',entityId:'t2'},status:'pending'}]};
    engine.step();engine.act('t1',{action:'walk',distance:2,angle:-90});
    for(let i=0;i<20;i++)engine.step();
    const actions=recentActions(engine.recentEvents);
    assert.deepEqual(milestoneEvidence(social,actions,engine.observe('t1')),[]);
    engine.entity('t1').yaw=0;engine.entity('t2').position=[engine.entity('t1').position[0],1,engine.entity('t1').position[2]+1.9];
    assert.equal(milestoneEvidence(social,actions,engine.observe('t1')).length,1);
    engine.entity('t1').yaw=180;
    assert.deepEqual(milestoneEvidence(social,actions,engine.observe('t1')),[]);
    assert.ok(!engine.observe('t1').entities.some(item=>item.id==='t2'));
  }finally{store.close();}
});

test('inventory cycles request an early review but changing cracks and movement are progress',()=>{
  const {engine,store,plan}=fixture();
  try{
    for(let i=0;i<6;i++){engine.step();engine.act('t1',i%2?{action:'store'}:{action:'hold',stack:0});}
    const actions=recentActions(engine.recentEvents);
    assert.match(decisionCycle(actions)!.message,/same action\/result cycle/);
    assert.equal(needsPlanReview(plan,6,actions),true);
    assert.equal(needsPlanReview({...plan,reviewedEventId:actions.at(-1)!.eventId,reviewedTurn:6},7,actions),false);
    const hits=Array.from({length:6},(_,i)=>({...actions[0],eventId:i+1,action:'hit',args:{target:[0,1,2]},result:compactResult({ok:true,message:'Cracks changed.',feedback:{cracks:i+1}})}));
    assert.equal(decisionCycle(hits),undefined);
    const moves=hits.map((entry,i)=>({...entry,action:'walk',result:compactResult({ok:true,message:'Moved.',feedback:{from:[i,1,0],to:[i+1,1,0]}})}));
    assert.equal(decisionCycle(moves),undefined);
    assert.equal(actionFeedback(actions[0].result).actionStatus,'completed');
    assert.equal('goalAchieved' in actionFeedback(actions[0].result),false);
  }finally{store.close();}
});

test('speech and intention stay staged until commit and survive a ready-decision restart',async()=>{
  const {engine,store,runtime,plan}=fixture();
  try{
    engine.act('t2',{action:'say',word:'Follow me'});
    const voice=engine.observe('t1').heard[0];assert.ok(voice);
    store.record(engine.frame(),engine.state(),runtime.persistence());
    runtime.inference.complete=async(request)=>{
      assert.equal(context(request).newSpeech.length,1);
      assert.equal(context(request).pastSpeech,undefined);
      return answer('hold',{stack:0,intention:'Inspect the held wood before choosing how to use it.'});
    };
    const prepared=await runtime.prepareTurn(AbortSignal.timeout(3000),()=>{});
    assert.equal(runtime.minds.get('t1')!.plan!.intention,undefined);
    assert.equal(runtime.minds.get('t1')!.acknowledgedSpeechTick,undefined);
    assert.doesNotMatch(prepared.decisions[0].calls[0].function.arguments,/intention/);
    const restored=new Engine(engine.module,store.stateAt(0));restored.nextEvent=store.maxEventId()+1;
    const resumed=new AgentRuntime(restored,store,runtime.config);
    resumed.inference.complete=async()=>{throw new Error('Ready decisions must not request inference.');};
    const cached=await resumed.prepareTurn(AbortSignal.timeout(3000),()=>{});commit(restored,store,resumed,cached);
    assert.match(resumed.minds.get('t1')!.plan!.intention!,/Inspect the held wood/);
    assert.equal(resumed.minds.get('t1')!.acknowledgedSpeechTick,voice.tick);
    resumed.inference.complete=async(request)=>{
      const prompt=context(request);assert.equal(prompt.newSpeech,undefined);assert.equal(prompt.pastSpeech[0].from,'Moss');
      assert.doesNotMatch(JSON.stringify(prompt.pastSpeech),/direction|distance/);
      assert.match(prompt.previousIntention.text,/Inspect the held wood/);
      assert.equal(prompt.plan.goal,plan.goal);assert.equal(prompt.plan.goalAchieved,false);
      assert.equal(prompt.lastResult.actionAccepted,true);assert.equal(prompt.lastResult.outcome,undefined);
      return answer('wait',{});
    };
    const next=await resumed.prepareTurn(AbortSignal.timeout(3000),()=>{});commit(restored,store,resumed,next);
    assert.equal(resumed.minds.get('t1')!.plan!.intention,undefined,'Omitted reminders expire instead of becoming permanent instructions.');
    const rows=store.db.prepare('SELECT version, request, response FROM inference_audit').all() as {version:string;request:Uint8Array;response:Uint8Array}[];
    assert.equal(rows.length,2);
    for(const row of rows){assert.equal(row.version,PROMPT_VERSION);assert.doesNotMatch(inflateSync(row.request).toString(),/secret-not-for-recordings|unused.invalid/);assert.ok(JSON.parse(inflateSync(row.response).toString()).calls.length);}
    assert.ok(!store.eventsAt(restored.tick).some(event=>event.type==='inference_audit'));
  }finally{store.close();}
});

test('cancelled requests do not acknowledge speech or change the active intention',async()=>{
  const {engine,store,runtime}=fixture();
  try{
    engine.act('t2',{action:'say',word:'Follow me'});
    runtime.minds.get('t1')!.plan!.intention='Inspect nearby wood.';
    const controller=new AbortController();
    runtime.inference.complete=async()=>{controller.abort();throw controller.signal.reason;};
    await assert.rejects(runtime.prepareTurn(controller.signal,()=>{}),{name:'AbortError'});
    assert.equal(runtime.minds.get('t1')!.acknowledgedSpeechTick,undefined);
    assert.equal(runtime.minds.get('t1')!.plan!.intention,'Inspect nearby wood.');
    assert.equal(store.db.prepare('SELECT status FROM inference_audit').get()!.status,'cancelled');
    assert.equal(engine.tick,0);
  }finally{store.close();}
});

test('decision views keep reachable targets once and historical speech has no usable old bearing',()=>{
  const {engine,store}=fixture();
  try{
    engine.act('t2',{action:'say',word:'Follow me'});
    const observation=engine.observe('t1'),view=decisionView(observation,{kind:'collect',subject:'wood'});
    const hit=worldTools(engine,'t1',{notes:[]}).find(tool=>tool.name==='hit')!;
    assert.ok((hit.parameters.properties!.target.examples as number[][]).some(target=>target.join(',')==='0,1,2'));
    assert.ok(!view.surfaces.some(surface=>surface.target.join(',')==='0,1,2'));
    assert.doesNotMatch(view.perception,/hit|dig|follow|collect/i);
    const speech=speechContext(observation,observation.tick);
    assert.equal(speech.newSpeech,undefined);assert.doesNotMatch(JSON.stringify(speech),/direction|distance/);
  }finally{store.close();}
});

test('changing goals clears the old intention and regenerates the complete action menu',async()=>{
  const {engine,store,runtime}=fixture();let calls=0;
  try{
    runtime.minds.get('t1')!.plan!.intention='Keep working on the wood.';
    runtime.inference.complete=async(request)=>{
      if(++calls===1)return answer('finish_goal',{outcome:'abandoned',reason:'Inspect the surroundings instead.'});
      if(calls===2)return answer('set_plan',{goal:'Find a quiet place to watch Moss.',successCondition:'I have found somewhere with a clear view of Moss.',explanation:'I want a fresh view.'});
      const prompt=context(request);
      assert.equal(prompt.previousIntention,undefined);
      assert.equal(prompt.plan.goal,'Find a quiet place to watch Moss.');
      assert.equal(prompt.plan.successCondition,'I have found somewhere with a clear view of Moss.');
      assert.equal(prompt.plan.goalAchieved,undefined);
      assert.ok((request.tools as any[]).some(tool=>tool.function.name==='find_material'));
      return answer('find_material',{});
    };
    const turn=await runtime.prepareTurn(AbortSignal.timeout(3000),()=>{});commit(engine,store,runtime,turn);
    assert.equal(calls,3);assert.equal(runtime.minds.get('t1')!.plan!.intention,undefined);
    assert.equal(runtime.minds.get('t1')!.plan!.goal,'Find a quiet place to watch Moss.');
    assert.equal(runtime.minds.get('t1')!.plan!.steps[0].criterion,undefined);
  }finally{store.close();}
});

test('oversized intentions are corrected before commit and failed actions invalidate their reminder',async()=>{
  const {engine,store,runtime}=fixture();let calls=0;
  try{
    runtime.inference.complete=async(request)=>{
      if(++calls===1)return answer('hit',{target:[0,1,2],intention:'x'.repeat(201)});
      assert.match((request.messages.at(-1) as {content:string}).content,/1\.\.200/);
      assert.equal(engine.tick,0);
      return answer('hit',{target:[0,1,2],intention:'Continue observing this wood block.'});
    };
    const turn=await runtime.prepareTurn(AbortSignal.timeout(3000),()=>{});
    engine.voxels.set([0,1,2],null);commit(engine,store,runtime,turn);
    runtime.inference.complete=async(request)=>{
      assert.match(context(request).previousIntention.status,/failed; reconsider/);
      assert.equal(context(request).lastResult.actionAccepted,false);
      return answer('wait',{});
    };
    await runtime.prepareTurn(AbortSignal.timeout(3000),()=>{});
  }finally{store.close();}
});

test('audit persistence failures stop the decision without repeating a received model response',async()=>{
  const {engine,store,runtime}=fixture();let calls=0;
  try{
    runtime.inference.complete=async()=>{calls++;return answer('wait',{});};
    store.finishInference=()=>{throw new Error('Storage is unavailable.');};
    await assert.rejects(runtime.prepareTurn(AbortSignal.timeout(3000),()=>{}),InferenceAuditError);
    assert.equal(calls,1);assert.equal(engine.tick,0);assert.equal(runtime.minds.get('t1')!.turns,0);
    assert.equal(store.loadPending(0,'t1',runtime.inference.cacheKey),undefined);
  }finally{store.close();}
});

test('an older staged plan is reviewed without discarding a ready physical decision',async()=>{
  const {engine,store,runtime,plan}=fixture();let calls=0;
  try{
    const legacy={...plan};delete legacy.version;
    store.savePending(0,'plan:t1',runtime.inference.cacheKey,{plan:legacy,events:[],modelCalls:0});
    runtime.inference.complete=async(request)=>{
      if(++calls===1){assert.deepEqual(context(request).allowedOutcomes,['abandon']);return answer('review_plan',{outcome:'abandon',explanation:'Replace the older success contract.'});}
      if(calls===2)return answer('set_plan',{goal:'Inspect this place.',successCondition:'I have scanned the area.',explanation:'Inspect the area.'});
      return answer('wait',{});
    };
    const turn=await runtime.prepareTurn(AbortSignal.timeout(3000),()=>{});
    assert.equal(turn.decisions[0].mind.plan!.version,4);assert.equal(calls,3);assert.equal(engine.tick,0);
    runtime.inference.complete=async()=>{throw new Error('Do not replace a ready physical decision.');};
    const cached=await runtime.prepareTurn(AbortSignal.timeout(3000),()=>{});
    assert.deepEqual(cached.decisions[0].calls,turn.decisions[0].calls);
  }finally{store.close();}
});

test('a reached social goal can stop following and close before selecting the next physical action',async()=>{
  const {engine,store,runtime,plan}=fixture();
  try{
    engine.voxels.set([0,1,2],null);
    runtime.minds.get('t1')!.plan={...plan,goal:'Approach Moss.',steps:[{task:'Get within two metres of Moss.',criterion:{kind:'approach',entityId:'t2'},status:'pending'}]};
    runtime.inference.complete=async()=>answer('follow',{entityId:'t2'});
    commit(engine,store,runtime,await runtime.prepareTurn(AbortSignal.timeout(3000),()=>{}));
    runtime.inference.complete=async()=>answer('follow',{});
    for(let i=0;i<2&&!milestoneEvidence(runtime.minds.get('t1')!.plan!,recentActions(store.actionEventsAt(engine.tick,'t1')),engine.observe('t1')).length;i++)
      commit(engine,store,runtime,await runtime.prepareTurn(AbortSignal.timeout(3000),()=>{}));
    let calls=0;
    runtime.inference.complete=async(request)=>{
      if(++calls===1){assert.equal(context(request).plan.goalAchieved,true);assert.match(context(request).plan.instruction,/stop_follow/);return answer('stop_follow',{});}
      if(calls===2){assert.ok((request.tools as any[]).some(tool=>tool.function.name==='finish_goal'));return answer('finish_goal',{outcome:'completed',reason:'I can see Moss within two metres.'});}
      if(calls===3){assert.equal((request.tools[0] as any).function.name,'set_plan');return answer('set_plan',{goal:'Inspect this place.',successCondition:'I have scanned this place.',explanation:'Inspect this place.'});}
      assert.ok((request.tools as any[]).some(tool=>tool.function.name==='wait'));
      return answer('wait',{});
    };
    const turn=await runtime.prepareTurn(AbortSignal.timeout(3000),()=>{});commit(engine,store,runtime,turn);
    assert.equal(calls,4);assert.equal(engine.entity('t1').following,undefined);
    assert.ok(store.eventsAt(engine.tick,'t1',100).some(event=>event.type==='plan'&&(event.data as {plan:AgentPlan}).plan.status==='completed'));
  }finally{store.close();}
});
