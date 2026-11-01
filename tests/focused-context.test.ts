import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from '../src/core/engine';
import {island} from '../src/modules/island';
import type {AgentPlan,Block,Entity} from '../src/core/types';
import {Store} from '../server/store';
import {AgentRuntime} from '../server/agents/runtime';
import {worldTools} from '../server/agents/tools';
import {applicableSuggestions,previousPlanContext,suggestionBasis} from '../server/agents/plan-context';
import {planDecision} from '../server/agents/planning';
import type {CompletionResult} from '../server/agents/providers';
import {projectFields} from './agent-fixtures';

function fixture() {
  const blocks:Block[]=[];
  for(let x=-5;x<=5;x++)for(let z=-5;z<=5;z++)blocks.push([x,0,z,'stone']);
  const entity:Entity={id:'t1',name:'Moss',kind:'troglodyte',controller:'agent',position:[.5,1,.5],height:2,yaw:0,inventory:null,color:'#fff',status:'idle'};
  return new Engine({...island,generate:()=>({blocks,entities:[entity,{...entity,id:'other',name:'Flint',controller:'wander',position:[-3.5,1,.5]}]})});
}
const plan=():AgentPlan=>({version:4,...structuredClone(projectFields),goal:'Inspect the area.',status:'active',steps:[{task:'Describe an observation.',status:'pending'}],explanation:'Learn about this place.',createdTurn:0,reviewedTurn:0,startedAtSecond:0});
const reply=(name:string,args:unknown):CompletionResult=>({provider:'test',providerName:'Test',model:'test',content:null,calls:[{id:'test',type:'function',function:{name,arguments:JSON.stringify(args)}}]});

test('conditional suggestions expire with their originating situation while landmarks and methods survive',()=>{
  const engine=fixture(),observation=engine.observe('t1'),current=plan();
  current.project!.progress='The stone landmark is at [3,1,4]. Looking from the west helped reveal its shape.';
  current.suggestionBasis=suggestionBasis(observation,2);
  assert.deepEqual(applicableSuggestions(current,observation,2).suggestedActions,current.suggestedActions);
  for(const change of [
    (view:typeof observation)=>{view.self.position[0]+=1;},
    (view:typeof observation)=>{view.self.yaw+=90;},
    (view:typeof observation)=>{view.self.inventory={stacks:[{kind:'wood',count:1}],selected:0,capacity:640};},
    (view:typeof observation)=>{view.tick++;view.self.lastAction={ok:false,message:'Blocked.'};},
  ]){
    const changed=structuredClone(observation);change(changed);
    const context=previousPlanContext(current,changed,3);
    assert.equal(context.suggestedActions,undefined);
    assert.equal(context.project!.progress,current.project!.progress);
    assert.equal(context.goal,current.goal);
    assert.match(context.suggestionStatus!,/withheld/);
  }
  assert.equal(applicableSuggestions(current,observation,3,true).suggestedActions,undefined);
  assert.equal(applicableSuggestions(current,observation,10).suggestedActions,undefined);
  assert.equal(applicableSuggestions({...current,suggestionBasis:undefined},observation,3).suggestedActions,undefined);
  assert.ok(current.suggestedActions!.length,'The durable authored plan remains intact.');
});

test('a withheld suggestion does not reappear after a later successful action at the original pose',async()=>{
  const engine=fixture(),store=new Store(':memory:',engine.module.manifest),current=plan();
  current.suggestionBasis=suggestionBasis(engine.observe('t1'),0);
  for(let i=0;i<20;i++)engine.step();
  engine.entity('t1').lastAction={ok:false,message:'A previous attempt failed.'};
  const runtime=new AgentRuntime(engine,store,{providers:[{id:'test',name:'Test',baseUrl:'http://unused.invalid',apiKey:'test',model:'test'}],maxTurns:null,retryDelayMs:1});
  runtime.minds.get('t1')!.plan=current;
  store.record(engine.frame(),engine.state(),runtime.persistence());
  try{
    runtime.inference.complete=async request=>{
      assert.equal(JSON.parse((request.messages[1] as {content:string}).content).plan.suggestedActions,undefined);
      return reply('wait',{});
    };
    const prepared=await runtime.prepareTurn(AbortSignal.timeout(2000),()=>{});
    assert.equal(current.suggestionBasis.invalidated,undefined,'Preparing a decision must not alter the committed plan.');
    engine.step(()=>runtime.commit(prepared));while(engine.tick<40)engine.step();
    store.record(engine.frame(),engine.state(),runtime.persistence());
    assert.equal(engine.entity('t1').lastAction!.ok,true);
    const resumed=new AgentRuntime(engine,store,runtime.config);
    resumed.inference.complete=runtime.inference.complete;
    const next=await resumed.prepareTurn(AbortSignal.timeout(2000),()=>{});
    assert.equal(next.decisions[0].mind.plan!.suggestionBasis!.invalidated,true);
  }finally{store.close();}
});

test('a review that omits suggestions does not renew them or erase useful coordinates',async()=>{
  const engine=fixture(),observation=engine.observe('t1'),previous=plan();
  previous.suggestionBasis=suggestionBasis(observation,0);
  previous.project!.progress='The landmark is at [3,1,4].';
  const next=await planDecision({name:'Moss',turn:8,time:0,plan:previous,context:{},actions:[],observation,signal:AbortSignal.timeout(2000),retryDelayMs:1,waiting(){},save(){},async complete(request){
    const context=JSON.parse((request.messages[1] as {content:string}).content);
    assert.equal(context.previousPlan.suggestedActions,undefined);
    assert.equal(context.previousPlan.project.progress,previous.project!.progress);
    return reply('review_plan',{outcome:'continue',conditionMet:false,remaining:'Observe another side.',explanation:'Continue investigating.'});
  }});
  assert.deepEqual(next.suggestionBasis,previous.suggestionBasis);
  assert.deepEqual(next.suggestedActions,previous.suggestedActions);
  assert.equal(applicableSuggestions(next,observation,8).suggestedActions,undefined);
});

test('planning compaction explicitly preserves useful landmarks and reusable methods',async()=>{
  const progress='The landmark at [3,1,4] is useful to return to this place. '.repeat(24);
  const next=await planDecision({name:'Moss',turn:0,time:0,context:{},actions:[],signal:AbortSignal.timeout(2000),retryDelayMs:1,waiting(){},save(){},async complete(){
    return reply('set_plan',{...structuredClone(projectFields),project:{...projectFields.project,progress},goal:'Inspect the landmark.',successCondition:'Observe its shape.',explanation:'Learn about it.'});
  },async compact(request){
    assert.match((request.messages[0] as {content:string}).content,/Useful landmark coordinates and reusable methods are durable memory/);
    return reply('submit_compacted_plan',{'project.progress':'The landmark at [3,1,4] helps me return to this place.'});
  }});
  assert.match(next.project!.progress,/\[3,1,4\]/);
});

test('a batched look keeps the normal field of view and rejects excess directions without changing state',()=>{
  const engine=fixture(),before=engine.state();
  const look=worldTools(engine,'t1',{notes:[]},{lookBudget:2}).find(tool=>tool.name==='look')!;
  assert.equal((look.invoke({angles:[-90,0,90]}) as any).ok,false);
  assert.equal((look.invoke({angle:0,angles:[90]}) as any).ok,false);
  assert.equal((look.invoke({angles:[90,90]}) as any).ok,false);
  const result=look.invoke({angles:[-90,90]}) as any;
  assert.equal(result.views.length,2);assert.deepEqual(result.inspectedAngles,[-90,90]);
  assert.ok(JSON.stringify(result.views[0]).includes('Flint'));
  assert.ok(!JSON.stringify(result.views[1]).includes('Flint'));
  assert.deepEqual(engine.state(),before);
  const limited=worldTools(engine,'t1',{notes:[]},{lookBudget:1}).find(tool=>tool.name==='look')!;
  assert.equal((limited.invoke({angles:[-90,90]}) as any).ok,false);
});

test('batched views survive corrections and a ready restart, including follow from the earlier view',async()=>{
  const engine=fixture(),store=new Store(':memory:',engine.module.manifest);
  const runtime=new AgentRuntime(engine,store,{providers:[{id:'test',name:'Test',baseUrl:'http://unused.invalid',apiKey:'test',model:'test'}],maxTurns:null,retryDelayMs:1});
  runtime.minds.get('t1')!.plan=plan();store.record(engine.frame(),engine.state(),runtime.persistence());
  let calls=0;
  try{
    runtime.inference.complete=async request=>{
      calls++;assert.equal(engine.tick,0);assert.equal(engine.entity('t1').yaw,0);
      if(calls===1)return reply('look',{angles:[-90,90]});
      const tools=request.tools as any[];
      assert.ok(!tools.some(tool=>tool.function.name==='look'));
      const follow=tools.find(tool=>tool.function.name==='follow')!;
      assert.ok(follow.function.parameters.properties!.entityId.enum!.includes('other'));
      if(calls<=5)return reply('walk',{distance:-1});
      const context=JSON.parse((request.messages[1] as {content:string}).content);
      assert.ok(context.inspectedViews.some((view:any)=>view.viewAngle===-90));
      return reply('follow',{entityId:'other'});
    };
    const prepared=await runtime.prepareTurn(AbortSignal.timeout(3000),()=>{});
    assert.equal(calls,6);
    assert.deepEqual(JSON.parse(prepared.decisions[0].calls[0].function.arguments),{entityId:'other',angle:-90});
    const restored=new AgentRuntime(engine,store,runtime.config);
    restored.inference.complete=async()=>{throw new Error('A ready decision must not call the provider.');};
    const ready=await restored.prepareTurn(AbortSignal.timeout(1000),()=>{});
    assert.deepEqual(ready,JSON.parse(JSON.stringify(prepared)));
    engine.step(()=>restored.commit(ready));
    assert.equal(engine.entity('t1').following!.entityId,'other');
    assert.equal(engine.entity('t1').lastAction!.ok,true);
  }finally{store.close();}
});
