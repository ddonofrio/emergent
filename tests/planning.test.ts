import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planDecision, needsPlanReview, unboundedMilestone } from '../server/agents/planning';
import type { AgentPlan } from '../src/core/types';
import type { CompletionResult } from '../server/agents/providers';

const plan:AgentPlan={goal:'Inspect the nearby tree.',status:'active',steps:[{task:'Approach the trunk.',status:'completed',evidence:'Arrived beside the trunk.'},{task:'Strike the trunk and observe it.',status:'pending'}],explanation:'I want to see how the tree responds.',createdTurn:1,reviewedTurn:1};
const answer=(name:string,args:unknown):CompletionResult=>({provider:'stub',providerName:'Stub',model:'stub',content:null,calls:[{id:'plan',type:'function',function:{name,arguments:JSON.stringify(args)}}]});

test('planning is required initially and after ten decisions, not ten inference requests',()=>{
  assert.equal(needsPlanReview(undefined,1),true);
  assert.equal(needsPlanReview(plan,10),false);assert.equal(needsPlanReview(plan,11),true);
  assert.equal(needsPlanReview({...plan,status:'completed'},2),true);
});

test('review rejects a second stalled interval and premature closure, then requires a new abstract goal',async()=>{
  const source={...structuredClone(plan),stalledReviews:1},original=structuredClone(source),saved:AgentPlan[]=[];let calls=0;
  const next=await planDecision({name:'Moss',turn:11,plan:source,context:{recent:[]},signal:new AbortController().signal,retryDelayMs:1,waiting(){},save(value){saved.push(structuredClone(value));},
    async complete(request){
      assert.deepEqual(source,original,'Only accepted staged plans may change.');
      const tool=(request.tools[0] as any).function.name;
      calls++;
      if(calls===1){assert.equal(tool,'review_plan');return answer(tool,{outcome:'continue',steps:[{status:'completed',evidence:'Arrived beside the trunk.'},{status:'pending',evidence:''}],explanation:'Nothing changed.'});}
      if(calls===2)return answer(tool,{outcome:'complete',steps:[{status:'completed',evidence:'Arrived.'},{status:'pending',evidence:''}],explanation:'Done.'});
      if(calls===3)return answer(tool,{outcome:'complete',steps:[{status:'completed',evidence:'Arrived.'},{status:'completed',evidence:'The recorded hit cracked the trunk.'}],explanation:'I reached the tree and saw it crack.'});
      assert.equal(tool,'set_plan');assert.equal(saved[0].status,'completed');
      if(calls===4)return answer(tool,{goal:'',steps:[],explanation:'I have no idea.'});
      return answer(tool,{goal:'Investigate the shore.',steps:['Find the shore.','Examine its terrain.','Test one property of its material.'],explanation:'I want to learn what makes the shore distinct.'});
    }});
  assert.equal(calls,5);assert.equal(saved.length,2);assert.equal(next.status,'active');
  assert.equal(next.goal,'Investigate the shore.');assert.equal(next.reviewedTurn,11);
});

test('abandoned plans close all unfinished steps before a replacement can be set',async()=>{
  const saved:AgentPlan[]=[];let calls=0;
  const next=await planDecision({name:'Moss',turn:11,plan,context:{},signal:new AbortController().signal,retryDelayMs:1,waiting(){},save(value){saved.push(value);},
    async complete(){
      if(++calls===1)return answer('review_plan',{outcome:'abandon',steps:[{status:'completed',evidence:'Arrived.'},{status:'abandoned',evidence:'The trunk is no longer reachable.'}],explanation:'I cannot reach the trunk now.'});
      return answer('set_plan',{goal:'Investigate sand.',steps:['Find sand.','Interact with a sand block.','Observe the result.'],explanation:'Sand is available to investigate.'});
    }});
  assert.equal(saved[0].status,'abandoned');assert.equal(saved[0].steps[1].status,'abandoned');assert.equal(next.status,'active');
});

test('unavailable planning waits cancellably without inventing a goal',async()=>{
  const controller=new AbortController();let attempts=0,saves=0;
  await assert.rejects(planDecision({name:'Moss',turn:1,context:{},signal:controller.signal,retryDelayMs:1,save(){saves++;},waiting(){if(++attempts===3)controller.abort();},async complete(){throw new Error('Offline');}}),{name:'AbortError'});
  assert.equal(saves,0);assert.equal(attempts,3);
});

test('planning rejects expanding collections and destinations controlled by another creature',async()=>{
  const invalid=['Interact with all discovered wood pieces.','Arrive at destination Flint indicates or complete exploration segment.'];
  for(const task of invalid)assert.equal(unboundedMilestone(task),true);
  assert.equal(unboundedMilestone('Inspect all three chosen blocks.'),false);
  let calls=0;
  const result=await planDecision({name:'Moss',turn:1,context:{},signal:new AbortController().signal,retryDelayMs:1,save(){},waiting(){},async complete(request){
    const task=invalid[calls++];
    if(task)return answer('set_plan',{goal:'Investigate wood.',steps:['Find one wood block.','Strike the chosen block.',task],explanation:'Explore the material.'});
    assert.match(JSON.parse((request.messages[1] as {content:string}).content).correction,/fixed scope/);
    return answer('set_plan',{goal:'Investigate wood.',steps:['Find one wood block.','Strike the chosen block.','Observe its response.'],explanation:'Learn how one block responds.'});
  }});
  assert.equal(calls,3);assert.equal(result.steps[2].task,'Observe its response.');
});

test('legacy unbounded plans are reviewed immediately and must close before replacement',async()=>{
  const source:AgentPlan={...structuredClone(plan),steps:[plan.steps[0],{task:'Interact with all discovered wood pieces.',status:'pending'}]},saved:AgentPlan[]=[];
  assert.equal(needsPlanReview(source,2),true);
  let calls=0;
  await planDecision({name:'Moss',turn:2,plan:source,context:{},signal:new AbortController().signal,retryDelayMs:1,save(value){saved.push(value);},waiting(){},async complete(){
    calls++;
    if(calls===1)return answer('review_plan',{outcome:'continue',steps:[{status:'completed',evidence:'Rewritten old evidence.'},{status:'pending',evidence:'Keep finding more.'}],explanation:'Continue exploring.'});
    if(calls===2)return answer('review_plan',{outcome:'abandon',steps:[{status:'completed',evidence:'Rewritten old evidence.'},{status:'abandoned',evidence:'The collection has no fixed finish.'}],explanation:'Choose a bounded activity.'});
    return answer('set_plan',{goal:'Investigate wood.',steps:['Find one block.','Strike that block.','Observe its response.'],explanation:'Test one object.'});
  }});
  assert.equal(calls,3);assert.equal(saved[0].status,'abandoned');assert.deepEqual(saved[0].steps[0],source.steps[0]);
});
