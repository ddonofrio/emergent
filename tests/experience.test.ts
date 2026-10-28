import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/core/engine';
import { island } from '../src/modules/island';
import type { AgentPlan, Block, Entity } from '../src/core/types';
import { Store } from '../server/store';
import { AgentRuntime } from '../server/agents/runtime';
import { ExperienceMemory } from '../server/agents/experience';
import { compactResult, decisionView, relevantKnowledge } from '../server/agents/context';
import { experienceReviewReason, planDecision } from '../server/agents/planning';
import { goalEvidence, taskEvidenceView } from '../server/agents/milestones';
import { projectFields } from './agent-fixtures';
import type { CompletionResult } from '../server/agents/providers';

const answer=(name:string,args:unknown):CompletionResult=>({provider:'test',providerName:'Test',model:'test',content:null,calls:[{id:'call',type:'function',function:{name,arguments:JSON.stringify(args)}}]});
const plan = ():AgentPlan=>({version:4,...structuredClone(projectFields),goal:'Compare what different strikes do.',steps:[{task:'I have observed two different tested inputs.',status:'pending'}],status:'active',explanation:'Compare exact results.',createdTurn:1,reviewedTurn:1,startedAtSecond:0,reviewedEventId:0});
function fixture(){
  const blocks:Block[]=[];
  for(let x=-5;x<=5;x++)for(let z=-5;z<=5;z++)blocks.push([x,0,z,'stone']);
  const entity:Entity={id:'t1',name:'Flint',kind:'troglodyte',controller:'agent',position:[.5,1,.5],height:2,yaw:0,inventory:{stacks:[{kind:'wood',count:4}],selected:0,capacity:640},color:'#fff',status:'idle'};
  const engine=new Engine({...island,generate:()=>({blocks,entities:[entity]})});
  const store=new Store(':memory:',engine.module.manifest);
  const record=()=>store.record(engine.frame(),engine.state());
  const observe=()=>engine.event('t1','observation','Observed.',{observation:engine.observe('t1')});
  return {engine,store,record,observe};
}

test('experience retains exact older experiments, isolates actors and rebuilds after restart',()=>{
  const {engine,store,record,observe}=fixture();
  try{
    engine.step();observe();engine.act('t1',{action:'strike_held',impact:[.5,1,.5]});record();
    const bucketEvent=engine.recentEvents.find(event=>event.type==='action'&&(event.data as any).action.action==='strike_held')!;
    engine.step();engine.act('t1',{action:'hold',stack:0});observe();engine.act('t1',{action:'strike_held',impact:[.5,.5,.5]});record();
    const beforeForeign=engine.tick;
    engine.step();engine.event('other','discovery','An unrelated actor found a secret.',{knowledge:'hidden-recipe',detail:{product:'secret'}});record();
    for(let index=0;index<80;index++){engine.step();observe();engine.act('t1',{action:'wait'});record();}
    const memory=new ExperienceMemory(store,'t1'),view=memory.read(engine.tick,plan());
    assert.equal(view.totalActions,83);
    const bucket=view.experiments.find(item=>item.result.shaped==='bucket')!;
    assert.equal(bucket.subject,'wood');assert.equal(bucket.parameters.point,'top_center');assert.equal(bucket.firstEventId,bucketEvent.id);
    assert.ok(view.experiments.some(item=>item.result.message.includes('notch')),'Negative experiments remain available.');
    assert.doesNotMatch(JSON.stringify(view),/secret|plank/);
    assert.deepEqual(new ExperienceMemory(store,'t1').read(engine.tick,plan()),view);
    assert.equal(new ExperienceMemory(store,'t1').read(beforeForeign,plan()).totalActions,3);
    const evidence=taskEvidenceView(plan(),memory.experimentActions());
    assert.ok(evidence.some(item=>item.eventId===bucketEvent.id&&item.args.point==='top_center'));
  }finally{store.close();}
});

test('planner sees accumulated experience and learned recipes while holding a different object',async()=>{
  const {engine,store,record,observe}=fixture();
  try{
    engine.step();observe();engine.act('t1',{action:'strike_held',impact:[.5,1,.5]});record();
    engine.step();record();
    assert.equal(engine.held(engine.entity('t1'))!.kind,'bucket');
    assert.ok(relevantKnowledge(engine,engine.observe('t1'),true).some(fact=>fact.includes('top_center')));
    const runtime=new AgentRuntime(engine,store,{providers:[{id:'test',name:'Test',baseUrl:'http://unused.invalid',apiKey:'test',model:'test'}],maxTurns:null,retryDelayMs:1});
    const old=plan();old.version=3;delete old.project;delete old.direction;delete old.suggestedActions;
    runtime.minds.get('t1')!.plan=old;
    let calls=0;
    runtime.inference.complete=async request=>{
      const context=JSON.parse((request.messages[1] as any).content);
      if(++calls===1){
        assert.match(context.transition,/Reframe/);
        assert.ok(context.situation.learned.some((fact:string)=>fact.includes('top_center')));
        assert.ok(context.situation.experience.experiments.some((item:any)=>item.subject==='wood'&&item.parameters.point==='top_center'));
        assert.ok(context.situation.capabilities.some((tool:any)=>tool.name==='store'&&tool.description));
        assert.ok(context.situation.capabilities.some((tool:any)=>tool.name==='journal'&&tool.parameters.properties.note));
        const wood=context.situation.capabilitiesAfterChangingHands.find((option:any)=>option.requires.holding==='wood');
        assert.ok(wood.tools.some((tool:any)=>tool.name==='strike_held'&&tool.parameters.properties.point.enum.includes('bottom_center')));
        assert.equal(engine.held(engine.entity('t1'))!.kind,'bucket','Previewing capabilities must not change the world.');
        assert.doesNotMatch(JSON.stringify(context),/five planks|bottom_center to make/);
        return answer('set_plan',{...structuredClone(projectFields),goal:'Examine my recorded strike.',successCondition:'I have compared the observed input and output.',explanation:'Continue learning from my own experiments.'});
      }
      assert.equal(context.plan.project,projectFields.project.goal);
      assert.deepEqual(context.plan.suggestedActions,projectFields.suggestedActions);
      assert.equal(context.plan.reviewInDecisions,undefined);
      return answer('wait',{});
    };
    const prepared=await runtime.prepareTurn(AbortSignal.timeout(3000),()=>{});
    assert.equal(prepared.decisions[0].mind.plan!.version,4);
    assert.equal(runtime.minds.get('t1')!.plan!.version,3,'Upgraded plans remain staged until commit.');
    const restored=new AgentRuntime(engine,store,runtime.config);
    restored.inference.complete=async()=>{throw new Error('A ready upgraded decision must survive restart.');};
    assert.deepEqual(await restored.prepareTurn(AbortSignal.timeout(1000),()=>{}),JSON.parse(JSON.stringify(prepared)));
  }finally{store.close();}
});

test('unavailable task can return to its project without a false completion or world time',async()=>{
  const {engine,store,record}=fixture();
  try{
    const runtime=new AgentRuntime(engine,store,{providers:[{id:'test',name:'Test',baseUrl:'http://unused.invalid',apiKey:'test',model:'test'}],maxTurns:null,retryDelayMs:1});
    runtime.minds.get('t1')!.plan=plan();record();let calls=0;
    runtime.inference.complete=async request=>{
      if(++calls===1)return answer('finish_goal',{outcome:'blocked',reason:'The needed interaction is unavailable. I have not tested its result.'});
      if(calls===2){
        const context=JSON.parse((request.messages[1] as any).content);
        assert.equal(context.previousPlan.status,'blocked');assert.equal(context.previousPlan.project.goal,projectFields.project.goal);
        return answer('set_plan',{...structuredClone(projectFields),goal:'Inspect another available interaction.',successCondition:'I have observed its result.',explanation:'Keep the project while changing the method.'});
      }
      return answer('wait',{});
    };
    const prepared=await runtime.prepareTurn(AbortSignal.timeout(3000),()=>{});
    assert.equal(engine.tick,0);assert.deepEqual(prepared.decisions[0].planEvents!.map(item=>item.status),['blocked','active']);
    assert.equal(prepared.decisions[0].mind.plan!.project!.goal,projectFields.project.goal);
  }finally{store.close();}
});

test('repeated empty searches trigger review across different movements, but ordinary travel does not',()=>{
  const current=plan();
  const actions=Array.from({length:8},(_,index)=>({eventId:index+1,atSecond:index+1,action:index%2?'walk':'find_entity',args:index%2?{angle:index,distance:3}:{},result:compactResult({ok:true,message:index%2?'Arrived.':'No creatures seen.',feedback:index%2?{from:[index,1,0],to:[index+3,1,0]}:{entities:[]}})}));
  assert.match(experienceReviewReason(current,9,actions,[])!,/four recent creature searches/);
  assert.equal(experienceReviewReason({...current,reviewedTurn:9,reviewedEventId:8},10,actions,[]),undefined);
  assert.equal(experienceReviewReason(current,9,actions.filter(item=>item.action==='walk'),[]),undefined);
  assert.match(experienceReviewReason(current,2,[],[{message:'Observed a new transformation.'}])!,/New observed knowledge/);
});

test('visible loose objects remain in decisions with occupied hands, and occluded items stay hidden',()=>{
  const {engine,store}=fixture();
  try{
    engine.bodies.push({id:'visible',kind:'plank',position:[.5,1.1,2.5],velocity:[0,0,0],resting:true});
    const observation=engine.observe('t1'),view=decisionView(observation);
    assert.ok(view.looseObjects.some(item=>item.id==='visible'&&!item.canPickUpNow));
    engine.voxels.set([0,1,1],'stone');engine.voxels.set([0,2,1],'stone');
    assert.ok(!decisionView(engine.observe('t1')).looseObjects.some(item=>item.id==='visible'));
  }finally{store.close();}
});

test('looking changes the reported view direction but preserves the body frame for movement',()=>{
  const {engine,store}=fixture();
  try{
    const ahead=decisionView(engine.observeAt('t1',0)),behind=decisionView(engine.observeAt('t1',180));
    assert.deepEqual(ahead.body.forwardXZ,{x:0,z:1});
    assert.deepEqual(behind.body.forwardXZ,ahead.body.forwardXZ);
    assert.deepEqual(behind.body.viewForwardXZ,{x:0,z:-1});
    assert.equal(engine.entity('t1').yaw,0);
    engine.entity('t1').yaw=90;
    assert.deepEqual(decisionView(engine.observeAt('t1')).body.forwardXZ,{x:1,z:0});
  }finally{store.close();}
});

test('project reviews preserve the parent and reject an empty method before continuing',async()=>{
  const current=plan(),saved:AgentPlan[]=[];let calls=0;
  const next=await planDecision({name:'Flint',turn:10,time:9,plan:current,context:{},actions:[],signal:AbortSignal.timeout(1000),retryDelayMs:1,waiting(){},save(value){saved.push(value);},complete:async request=>{
    if(calls){const context=JSON.parse((request.messages[1] as any).content);assert.match(context.correction,/suggestedActions must be a flat array/);assert.ok(context.previousAttempt);}
    return answer('review_plan',{outcome:'continue',project:{...current.project,progress:'The previous method was blocked; I will inspect another approach.'},suggestedActions:++calls===1?[]:['Inspect a currently available interaction.'],explanation:'Change the method while retaining the project.'});
  }});
  assert.equal(calls,2);assert.equal(saved.length,1);assert.equal(next.direction,current.direction);assert.equal(next.project!.goal,current.project!.goal);
  assert.equal(next.suggestedActions!.length,1);
  assert.equal(goalEvidence(next,[]).length,0);
});
