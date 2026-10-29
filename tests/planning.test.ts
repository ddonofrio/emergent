import { test } from 'node:test';
import { projectFields, projectReply } from './agent-fixtures';
import assert from 'node:assert/strict';
import { planDecision, needsPlanReview } from '../server/agents/planning';
import { milestoneEvidence } from '../server/agents/milestones';
import { compactResult } from '../server/agents/context';
import type { AgentPlan, MilestoneCriterion } from '../src/core/types';
import type { CompletionResult } from '../server/agents/providers';
import { Engine } from '../src/core/engine';
import { island } from '../src/modules/island';

const plan:AgentPlan={version:2,inventoryBaseline:{},goal:'Collect wood.',status:'active',steps:[{task:'Collect one wood from the world.',status:'pending',criterion:{kind:'collect',subject:'wood'}}],explanation:'I want to try wood.',createdTurn:1,reviewedTurn:1,startedAtSecond:0};
const authored={goal:'Compare the shade on opposite sides of the tree.',successCondition:'I have observed both sides and can describe how their shade differs.',explanation:'I wonder whether the tree changes the light around it.'};
const engine=new Engine(island);engine.entity('t1').inventory={stacks:[{kind:'wood',count:1}],selected:0,capacity:640};
const observation=engine.observe('t1');
const answer=(name:string,args:unknown):CompletionResult=>({provider:'stub',providerName:'Stub',model:'stub',content:null,calls:[{id:'plan',type:'function',function:{name,arguments:JSON.stringify(projectReply(name,args))}}]});
const base=()=>({name:'Moss',turn:31,time:30,context:{},observation,actions:[],signal:AbortSignal.timeout(2000),retryDelayMs:1,waiting(){},save(_plan:AgentPlan){}});
const recorded=(action:string,feedback:Record<string,unknown>,eventId=10)=>({eventId,atSecond:1,action,args:{},result:compactResult({ok:true,message:'Recorded effect.',feedback:{...(feedback.collected?{inventoryDelta:[{kind:feedback.collected,change:1}]}:{}),...feedback}})});

test('planning runs initially and after thirty decisions, including legacy plans',()=>{
  assert.equal(needsPlanReview(undefined,1),true);
  assert.equal(needsPlanReview(plan,30),false);assert.equal(needsPlanReview(plan,31),true);
  const legacy={...plan,steps:[{task:'Collect all nearby wood.',status:'pending' as const}]};
  assert.equal(needsPlanReview(legacy,2),true);assert.equal(needsPlanReview(legacy,31),true);
  assert.equal(needsPlanReview({...plan,version:undefined},2),true);
});

test('scanning, holding, cracking, and older successes cannot prove collection',()=>{
  const actions=[recorded('find_material',{materials:[{material:'wood',target:[1,1,1]}]}),recorded('hold',{}),recorded('hit',{material:'wood',blockOutcome:'cracked'}),{...recorded('hit',{collected:'wood'}),atSecond:0}];
  assert.deepEqual(milestoneEvidence(plan,actions),[]);
  const collected=recorded('hit',{material:'wood',blockOutcome:'collected',collected:'wood'},42);
  assert.deepEqual(milestoneEvidence(plan,[...actions,collected],observation),[{eventId:42,message:'Recorded effect.'}]);
});

test('different milestone kinds require their own actual effects',()=>{
  const verify=(criterion:MilestoneCriterion,entry:ReturnType<typeof recorded>)=>milestoneEvidence({...plan,steps:[{...plan.steps[0],criterion}]},[entry]).length;
  assert.equal(verify({kind:'locate',subject:'wood'},recorded('find_material',{materials:[{material:'wood'}]})),1);
  assert.equal(verify({kind:'place',subject:'wood'},recorded('hold',{})),0);
  assert.equal(verify({kind:'place',subject:'wood'},recorded('place',{placed:'leaves'})),0);
  assert.equal(verify({kind:'place',subject:'wood'},recorded('place',{placed:'wood'})),1);
  assert.equal(verify({kind:'move'},recorded('walk',{outcome:'started',from:[0,1,0],destination:[4,1,0]})),0);
  assert.equal(verify({kind:'move'},recorded('walk',{from:[0,1,0],to:[3,1,0]})),1);
  assert.equal(verify({kind:'communicate'},recorded('say',{recipientIds:[]})),0);
  assert.equal(verify({kind:'communicate'},recorded('say',{recipientIds:['t2']})),1);
});

test('invented completion is rejected and a second stalled interval closes before replacement',async()=>{
  let calls=0;const saved:AgentPlan[]=[];
  const next=await planDecision({...base(),plan:{...plan,stalledReviews:1},save(value){saved.push(value);},async complete(request){
    if(++calls===1)return answer('review_plan',{outcome:'complete',explanation:'I scanned wood so I collected it.'});
    if(calls===2){assert.match(JSON.parse((request.messages[1] as {content:string}).content).correction,/Invented evidence/);return answer('review_plan',{outcome:'continue',explanation:'Keep trying.'});}
    if(calls===3)return answer('review_plan',{outcome:'abandon',explanation:'No collection was recorded.'});
    return answer('set_plan',authored);
  }});
  assert.equal(calls,4);assert.deepEqual(saved.map(item=>item.status),['abandoned','active']);assert.equal(next.steps.length,1);
});

test('completion evidence is copied from history, not model prose, and cannot carry into the next goal',async()=>{
  let calls=0;const saved:AgentPlan[]=[];
  const actions=[recorded('pickup',{collected:'wood'},42)];
  const next=await planDecision({...base(),plan,actions,save(value){saved.push(value);},async complete(){
    if(++calls===1)return answer('review_plan',{outcome:'complete',explanation:'Collected many trees.'});
    return answer('set_plan',authored);
  }});
  assert.deepEqual(saved[0].steps[0].evidenceEventIds,[42]);assert.equal(saved[0].steps[0].evidence,'Recorded effect.');
  assert.deepEqual(milestoneEvidence(next,actions),[]);
});

test('legacy dependent steps must all close before selecting one replacement milestone',async()=>{
  let calls=0;const saved:AgentPlan[]=[];
  const legacy:AgentPlan={...plan,steps:[{task:'Build foundation.',status:'abandoned',evidence:'Blocked.'},{task:'Add finishing touches.',status:'pending'}]};
  await planDecision({...base(),plan:legacy,save(value){saved.push(value);},async complete(){
    if(++calls===1)return answer('review_plan',{outcome:'continue',explanation:'Add more leaves.'});
    if(calls===2)return answer('review_plan',{outcome:'abandon',explanation:'The prerequisite is abandoned.'});
    return answer('set_plan',authored);
  }});
  assert.equal(calls,3);assert.ok(saved[0].steps.every(step=>step.status==='abandoned'));assert.deepEqual(saved[0].steps[0],legacy.steps[0]);
});

test('the planner authors goals outside any catalog and preserves its exact success condition',async()=>{
  let calls=0;
  const next=await planDecision({...base(),async complete(request){
    const schema=(request.tools[0] as any).function.parameters;
    assert.deepEqual(Object.keys(schema.properties),['direction','project','goal','successCondition','suggestedActions','explanation']);
    assert.equal(schema.properties.goal.enum,undefined);
    assert.equal(schema.properties.successCondition.enum,undefined);
    assert.doesNotMatch(JSON.stringify(request),/milestoneOptions|collect_wood|shape_wood/);
    if(++calls===1)return answer('set_plan',{milestone:'scan',explanation:'The old selector must no longer work.'});
    if(calls===2)return answer('set_plan',{...authored,successCondition:''});
    return answer('set_plan',authored);
  }});
  assert.equal(calls,3);assert.equal(next.version,4);assert.equal(next.steps.length,1);assert.equal(next.steps[0].criterion,undefined);
  assert.equal(next.goal,authored.goal);assert.equal(next.steps[0].task,authored.successCondition);
  assert.equal(next.explanation,authored.explanation);
  assert.equal(needsPlanReview(next,32),false,'A free-text goal needs no programmed criterion.');
});

test('planning truncates explanation after three consecutive overlong corrections',async()=>{
  let calls=0;const explanation='x'.repeat(302);
  const next=await planDecision({...base(),async complete(){calls++;return answer('set_plan',{...authored,explanation});}});
  assert.equal(calls,4);assert.equal(next.explanation,'x'.repeat(300));
});

test('identical surroundings allow different model-authored goals without substitution',async()=>{
  const other={goal:'Stay beside Moss while listening to the duck.',successCondition:'I have heard the duck while standing beside Moss.',explanation:'I want to share this sound.'};
  const first=await planDecision({...base(),async complete(){return answer('set_plan',authored);}});
  const second=await planDecision({...base(),async complete(){return answer('set_plan',other);}});
  assert.equal(first.goal,authored.goal);assert.equal(second.goal,other.goal);
  assert.equal(second.steps[0].task,other.successCondition);
});

test('free goals can continue after repeated reviews and completion validates citations without claiming engine verification',async()=>{
  const free:AgentPlan={...plan,version:3,goal:authored.goal,steps:[{task:authored.successCondition,status:'pending'}],stalledReviews:9};
  const continued=await planDecision({...base(),plan:free,async complete(request){
    const context=JSON.parse((request.messages[1] as any).content);
    assert.ok(context.allowedOutcomes.includes('continue'));
    assert.equal(context.verifiedProgress,undefined);
    return answer('review_plan',{outcome:'continue',explanation:'I still want to compare both sides.'});
  }});
  assert.equal(continued.goal,free.goal);assert.equal(continued.status,'active');
  let calls=0;const saved:AgentPlan[]=[];
  const actions=[recorded('turn',{from:[0,1,0],to:[0,1,0]},42),{...recorded('wait',{},7),atSecond:0}];
  await planDecision({...base(),plan:free,actions,save(value){saved.push(value);},async complete(){
    if(++calls===1)return answer('review_plan',{outcome:'complete',explanation:'I compared the views.',evidenceEventIds:[999]});
    if(calls===2)return answer('review_plan',{outcome:'complete',explanation:'I compared the views.',evidenceEventIds:[7]});
    if(calls===3)return answer('review_plan',{outcome:'complete',explanation:'Turning let me compare the views.',evidenceEventIds:[42]});
    return answer('set_plan',authored);
  }});
  assert.equal(calls,4);assert.equal(saved[0].steps[0].assessment,'agent');
  assert.deepEqual(saved[0].steps[0].evidenceEventIds,[42]);
  assert.equal(saved[0].steps[0].evidence,'Turning let me compare the views.');
});

test('unavailable planning waits cancellably without inventing a goal',async()=>{
  const controller=new AbortController();let attempts=0,saves=0;
  await assert.rejects(planDecision({...base(),signal:controller.signal,save(){saves++;},waiting(){if(++attempts===3)controller.abort();},async complete(){throw new Error('Offline');}}),{name:'AbortError'});
  assert.equal(saves,0);assert.equal(attempts,3);
});
