import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planDecision} from '../server/agents/planning';
import {worldTools} from '../server/agents/tools';
import {Engine} from '../src/core/engine';
import {island} from '../src/modules/island';
import type {AgentPlan} from '../src/core/types';
import type {CompletionResult} from '../server/agents/providers';
import {compactResult} from '../server/agents/context';
import {projectFields} from './agent-fixtures';

const reply=(name:string,args:unknown):CompletionResult=>({provider:'test',providerName:'Test',model:'test',content:null,calls:[{id:'test',type:'function',function:{name,arguments:JSON.stringify(args)}}]});
const current=():AgentPlan=>({version:4,...structuredClone(projectFields),goal:'Inspect a change.',status:'active',steps:[{task:'A change was observed.',status:'pending'}],explanation:'I want to understand it.',createdTurn:1,reviewedTurn:1,startedAtSecond:0});
const actions=[{eventId:42,atSecond:1,action:'hit',args:{target:[0,1,2]},result:compactResult({ok:true,message:'Wood collected.',feedback:{collected:'wood',inventoryDelta:[{kind:'wood',change:1}]}})}];

test('project closure is recorded before a fully specified replacement and preserves identity and history',async()=>{
  const previous=current(),saved:AgentPlan[]=[];let calls=0;
  const next=await planDecision({name:'Moss',turn:31,time:30,plan:previous,context:{},actions,signal:AbortSignal.timeout(2000),retryDelayMs:1,waiting(){},save:p=>saved.push(structuredClone(p)),async complete(request){
    if(++calls===1)return reply('review_plan',{outcome:'complete',conditionMet:true,remaining:'',explanation:'I observed a change.',evidenceEventIds:[42],projectOutcome:{status:'completed',reason:'The collection documents the change I wanted to understand.',evidenceEventIds:[42]}});
    assert.equal(JSON.parse((request.messages[1] as any).content).previousPlan.project.status,'completed');
    if(calls===2)return reply('set_plan',{goal:'Watch the shore.',successCondition:'Observe a wave.',suggestedActions:['Look toward the shore.'],explanation:'A different interest.'});
    return reply('set_plan',{project:{goal:'Understand the shore.',successCondition:'Describe the shore.',progress:'Beginning.',openQuestions:['What changes here?']},goal:'Watch the shore.',successCondition:'Observe a wave.',suggestedActions:['Look toward the shore.'],explanation:'A different interest.'});
  }});
  assert.equal(calls,3);assert.equal(saved[0].project!.status,'completed');assert.deepEqual(saved[0].project!.evidenceEventIds,[42]);
  assert.equal(next.project!.goal,'Understand the shore.');assert.equal(next.project!.status,undefined);
  assert.equal(next.identity,previous.identity);assert.equal(next.projectHistory!.length,1);assert.equal(next.projectHistory![0].goal,previous.project!.goal);
  assert.equal(previous.project!.status,undefined,'The source plan remains unchanged.');
});

test('invented project evidence cannot close a project and suspension does not claim success',async()=>{
  const previous=current(),saved:AgentPlan[]=[];let calls=0;
  await planDecision({name:'Moss',turn:31,time:30,plan:previous,context:{},actions,signal:AbortSignal.timeout(2000),retryDelayMs:1,waiting(){},save:p=>saved.push(p),async complete(request){
    calls++;
    if(calls<=2)return reply('review_plan',{outcome:'blocked',conditionMet:false,remaining:'Need a different method.',explanation:'Reconsider.',projectOutcome:{status:calls===1?'completed':'suspended',reason:'I want to return later.',evidenceEventIds:[999]}});
    assert.equal(JSON.parse((request.messages[1] as any).content).previousPlan.project.status,'suspended');
    return reply('set_plan',{project:{goal:'Learn another material.',successCondition:'Describe a new result.',progress:'Starting.',openQuestions:[]},goal:'Inspect stone.',successCondition:'Record its appearance.',suggestedActions:['Look at stone.'],explanation:'Try another interest.'});
  }});
  assert.equal(calls,3);assert.equal(saved[0].project!.status,'suspended');assert.deepEqual(saved[0].project!.evidenceEventIds,[]);
});

test('split task controls derive consistent assessments and tolerate concise draft overruns',async()=>{
  const engine=new Engine(island),closed:any[]=[];
  const tools=worldTools(engine,'t1',{notes:[]},{onFinishGoal:(...args)=>{closed.push(args);return {ok:true};}});
  assert.ok(!tools.some(t=>t.name==='finish_goal'));
  const complete=tools.find(t=>t.name==='complete_task')!,replan=tools.find(t=>t.name==='replan_task')!;
  assert.equal((await complete.invoke({reason:'x'.repeat(976),evidenceEventIds:[42]}) as any).ok,true);
  assert.deepEqual(closed[0][3],{conditionMet:true,remaining:''});
  assert.equal((await replan.invoke({outcome:'blocked',reason:'The way is obstructed.',remaining:'Find another approach.'}) as any).ok,true);
  assert.deepEqual(closed[1][3],{conditionMet:false,remaining:'Find another approach.'});
  assert.equal((await complete.invoke({reason:'x'.repeat(1001),evidenceEventIds:[42]}) as any).ok,false);
  assert.equal((await replan.invoke({outcome:'blocked',reason:'Blocked.',remaining:' '}) as any).ok,false);
  assert.equal(closed.length,2);
});
