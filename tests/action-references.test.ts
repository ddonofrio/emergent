import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from '../src/core/engine';
import {island} from '../src/universes/first-shore';
import type {Block,Entity} from '../src/core/types';
import {worldTools} from '../server/agents/tools';

function fixture(extra:Block[]=[]) {
  const blocks:Block[]=[];
  for(let x=-5;x<=5;x++)for(let z=-5;z<=5;z++)blocks.push([x,0,z,'stone']);
  const entity:Entity={id:'t1',name:'Moss',kind:'troglodyte',controller:'agent',position:[.5,1,.5],height:2,yaw:0,inventory:null,color:'#fff',status:'idle'};
  return new Engine({...island,generate:()=>({blocks:[...blocks,...extra],entities:[entity]})});
}

test('action IDs cover all observable reachable targets rather than the previous two/three samples',()=>{
  const engine=fixture(),empty=engine.observe('t1');
  const hit=worldTools(engine,'t1',{notes:[]},{referenceTargets:true}).find(t=>t.name==='hit')!;
  assert.ok(empty.interactions.hit.length>2);
  assert.equal(hit.parameters.properties!.targetId.enum!.length,empty.interactions.hit.length);
  assert.equal((hit.invoke({targetId:'hit:99,99,99'}) as any).ok,false);
  engine.entity('t1').inventory={stacks:[{kind:'wood',count:10}],selected:0,capacity:640};
  const occupied=engine.observe('t1');
  assert.ok(occupied.interactions.place.length>3);
  const place=worldTools(engine,'t1',{notes:[]},{referenceTargets:true}).find(t=>t.name==='place')!;
  assert.equal(place.parameters.properties!.targetId.enum!.length,occupied.interactions.place.length);
  assert.equal(engine.tick,0);
});

test('an ID resolves to a frozen coordinate and an occluded object is never offered',()=>{
  const wall:Block[]=[];for(let x=-2;x<=2;x++)for(let y=1;y<=4;y++)wall.push([x,y,1,'stone']);
  const engine=fixture([...wall,[0,1,2,'wood']]);
  const hit=worldTools(engine,'t1',{notes:[]},{referenceTargets:true}).find(t=>t.name==='hit')!;
  assert.ok(!hit.parameters.properties!.targetId.enum!.includes('hit:0,1,2'));
  assert.deepEqual(hit.prepare!({targetId:'hit:0,1,1'}),{target:[0,1,1]});
  engine.voxels.set([0,1,1],null);
  assert.equal((hit.invoke({targetId:'hit:0,1,1'}) as any).ok,false);
  assert.equal(engine.blockDamage.size,0);
});

test('checked jumps offer explicit landing heights and a query preserves arbitrary valid destinations',()=>{
  const engine=fixture(),inspected:{angle:number;distance:number}[]=[];
  const catalog=()=>worldTools(engine,'t1',{notes:[]},{referenceTargets:true,inspectedJumps:inspected,onInspectJump:jump=>inspected.push(jump)});
  const before=engine.state();
  const check=catalog().find(t=>t.name==='inspect_jump')!;
  const result=check.invoke({angle:17,distance:1.25}) as any;
  assert.equal(result.checked,true);assert.equal(result.heightChange,0);assert.ok(result.landing);
  assert.deepEqual(engine.state(),before);
  const jump=catalog().find(t=>t.name==='jump')!;
  assert.ok(jump.parameters.properties!.targetId.enum!.includes('jump:17:1.25'));
  assert.deepEqual(jump.prepare!({targetId:result.targetId}),{angle:17,distance:1.25});
  assert.equal((jump.invoke({targetId:result.targetId}) as any).ok,true);
});

test('unsafe or unseen jump destinations are unconfirmed and never enter the available ID set',()=>{
  const engine=fixture([[0,2,1,'leaves']]);
  const before=engine.state();
  assert.equal(engine.inspectJump('t1',0,2).checked,false);
  const tools=worldTools(engine,'t1',{notes:[]},{referenceTargets:true});
  const jump=tools.find(t=>t.name==='jump')!;
  assert.ok(!jump.parameters.properties!.targetId.enum?.includes('jump:0:2'));
  assert.deepEqual(engine.state(),before);
  engine.entity('t1').yaw=180;
  assert.equal(engine.inspectJump('t1',90,2.5,[0]).checked,false,'An unseen sideways landing is not confirmed.');
});
