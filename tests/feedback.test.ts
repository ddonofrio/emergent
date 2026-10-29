import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/core/engine';
import { island } from '../src/modules/island';
import type { Block, Entity } from '../src/core/types';
import { compactResult, decisionCycle, historicalActions, recentActions } from '../server/agents/context';
import { worldTools } from '../server/agents/tools';
import { Store } from '../server/store';

function fixture(withOther=false) {
  const blocks:Block[]=[];
  for(let x=-5;x<=5;x++)for(let z=-5;z<=5;z++)blocks.push([x,0,z,'stone']);
  const actor:Entity={id:'t1',name:'Moss',kind:'troglodyte',controller:'agent',position:[.5,1,.5],height:2,yaw:0,inventory:null,color:'#fff',status:'idle'};
  const other:Entity={...structuredClone(actor),id:'t2',name:'Flint',position:[.5,1,4.5]};
  return new Engine({...island,generate:()=>({blocks,entities:withOther?[actor,other]:[actor]})});
}
const completeScan=(engine:Engine)=>{for(let tick=0;tick<20;tick++)engine.step();return engine.entity('t1').lastAction!;};

test('identical consecutive scans are concise for inference but retain full durable results across restart',()=>{
  const engine=fixture(),store=new Store(':memory:',engine.module.manifest);
  try{
    engine.act('t1',{action:'find_material'});const first=completeScan(engine);
    assert.equal(first.feedback?.unchanged,undefined);
    const second=engine.act('t1',{action:'find_material'});
    assert.equal(second.feedback?.unchanged,true);
    assert.equal(second.feedback?.previousScanEventId,first.feedback?.scanEventId);
    store.record(engine.frame(),engine.state());
    const resumed=new Engine(engine.module,store.stateAt(engine.tick));resumed.nextEvent=store.maxEventId()+1;
    const result=completeScan(resumed);store.record(resumed.frame(),resumed.state());
    assert.equal(result.feedback?.unchanged,true);assert.ok(Array.isArray(result.feedback?.materials));
    assert.equal(compactResult(result,true).materials,undefined);
    assert.match(compactResult(result,true).message,/Nothing has changed/);
    const scanTool=worldTools(resumed,'t1',{notes:[]}).find(tool=>tool.name==='find_material')!;
    assert.equal(JSON.parse(scanTool.output.render({},result)[0].text).materials,undefined);
    const recorded=store.eventsAt(resumed.tick,'t1',100);
    const lastScan=recorded.filter(event=>event.type==='scanned').at(-1)!;
    assert.ok((lastScan.data as {materials:unknown[]}).materials.length);
    const actions=recentActions(recorded);
    assert.ok(actions.at(-1)!.result.materials?.length);
    assert.equal(historicalActions(actions).at(-1)!.result.materials,undefined);
    assert.equal(store.stateAt(resumed.tick).entities[0].lastAction?.feedback?.unchanged,true);
    const third=resumed.act('t1',{action:'find_material'});
    assert.equal(third.feedback?.previousScanEventId,lastScan.id);
  }finally{store.close();}
});

test('scan references do not disguise an unchanged result from the existing cycle detector',()=>{
  const engine=fixture();
  for(let scan=0;scan<7;scan++){engine.act('t1',{action:'find_material'});completeScan(engine);}
  const actions=historicalActions(recentActions(engine.recentEvents,7)).slice(-6);
  assert.equal(new Set(actions.map(entry=>entry.result.previousScanEventId)).size,6);
  assert.ok(decisionCycle(actions));
});

test('scan suppression requires the same pose, scan type, consecutive actions and visible result',()=>{
  for(const change of ['position','facing','material','intervening-action','scan-type'] as const){
    const engine=fixture();engine.act('t1',{action:'find_material'});completeScan(engine);
    if(change==='position')engine.entity('t1').position[0]+=.2;
    if(change==='facing')engine.entity('t1').yaw=45;
    if(change==='material')engine.voxels.set([0,1,2],'wood');
    if(change==='intervening-action')engine.act('t1',{action:'wait'});
    const result=engine.act('t1',{action:change==='scan-type'?'find_entity':'find_material'});
    assert.equal(result.feedback?.unchanged,undefined,change);
  }
  const engine=fixture(true);engine.act('t1',{action:'find_entity'});completeScan(engine);
  engine.act('t1',{action:'find_entity'});assert.equal(completeScan(engine).feedback?.unchanged,true);
  engine.entity('t2').position[0]+=1;
  assert.equal(engine.act('t1',{action:'find_entity'}).feedback?.unchanged,undefined,'A moving creature changes the result even when its ID is unchanged.');
});

test('generic tools remain visible without targets and do not disclose hidden materials or item recipes',()=>{
  const engine=fixture();
  const tools=worldTools(engine,'t1',{notes:[]});
  for(const name of ['hit','pickup','follow','say'])assert.ok(tools.some(tool=>tool.name===name));
  assert.doesNotMatch(JSON.stringify(tools),/bucket|shovel|knife|sand|wood|door/);
  engine.entity('t1').inventory={stacks:[{kind:'bucket',count:1}],selected:0,capacity:640};
  const fill=worldTools(engine,'t1',{notes:[]}).find(tool=>tool.name==='fill')!;
  assert.doesNotMatch(JSON.stringify(fill),/sand|dirt|water/);
});

test('the duck stops and faces the speaker before quacking, including on a wandering tick and in replay',()=>{
  const engine=fixture(true),duck=engine.entity('t2');
  duck.kind='duck';duck.controller='wander';duck.height=.65;duck.yaw=30;
  duck.motion={kind:'walk',origin:[...duck.position],destination:[4,1,4.5],speed:1};
  engine.tick=59;
  const before=[...duck.position];engine.act('t1',{action:'say',word:'Hello Pebble'});
  const reply=engine.recentEvents.find(event=>event.actor==='t2'&&event.type==='speech')!;
  assert.equal((reply.data as {word:string;facing:number}).word,'quack');
  assert.equal((reply.data as {facing:number}).facing,180);
  engine.step();assert.deepEqual(duck.position,before);assert.equal(duck.yaw,180);assert.equal(duck.motion,undefined);
  const store=new Store(':memory:',engine.module.manifest);
  try{store.record(engine.frame(),engine.state());assert.equal(store.stateAt(60).entities[1].yaw,180);}finally{store.close();}
});

test('speaking while following stays within the word budget and retains the follow target',()=>{
  const engine=fixture(true);assert.equal(engine.act('t1',{action:'follow',entityId:'t2'}).ok,true);
  const say=worldTools(engine,'t1',{notes:[]}).find(tool=>tool.name==='say')!;
  assert.equal((say.invoke({word:'Wait for me'}) as {ok:boolean}).ok,true);
  assert.equal(engine.entity('t1').following?.entityId,'t2');
  assert.equal(engine.observe('t2').heard[0].word,'Wait for me');
  assert.equal((say.invoke({word:'Again'}) as {ok:boolean}).ok,false);
});
