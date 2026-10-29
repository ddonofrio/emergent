import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from '../src/core/engine';
import {island} from '../src/modules/island';
import type {Block,Entity} from '../src/core/types';
import {compactView,progressContext,recentActions} from '../server/agents/context';
import {worldTools} from '../server/agents/tools';

function fixture(extra:Block[]=[]) {
  const blocks:Block[]=[];
  for(let x=-5;x<=5;x++)for(let z=-5;z<=5;z++)blocks.push([x,0,z,'stone']);
  const entity:Entity={id:'t1',name:'Moss',kind:'troglodyte',controller:'agent',position:[.5,1,.5],height:2,yaw:0,inventory:null,color:'#fff',status:'idle'};
  return new Engine({...island,generate:()=>({blocks:[...blocks,...extra],entities:[entity]})});
}

test('direct target tools expose reachable coordinates and never expose an occluded target',()=>{
  const wall:Block[]=[];
  for(let x=-2;x<=2;x++)for(let y=1;y<=4;y++)wall.push([x,y,1,'sand']);
  const engine=fixture([...wall,[0,1,2,'wood']]);
  const hit=worldTools(engine,'t1',{notes:[]}).find(tool=>tool.name==='hit')!;
  const schema=(hit.parameters.properties!.target as any),targets=schema.examples as number[][];
  assert.ok(targets.length);assert.match(schema.description,/sand at/);
  for(const target of targets)assert.equal(engine.voxels.get(target as [number,number,number]),'sand');
  assert.doesNotMatch(schema.description,/wood/);
});

test('a cramped local view reports a checked jump that the direct jump tool can execute',()=>{
  const engine=fixture([[-1,1,1,'leaves'],[0,1,1,'leaves'],[1,1,1,'leaves']]);
  const view=compactView(engine.observe('t1'));
  assert.match(view.navigationSummary!,/Walking is blocked.*checked jump/);
  const jump=view.paths.find(path=>path.jump)?.jump;assert.ok(jump);
  const tool=worldTools(engine,'t1',{notes:[]}).find(tool=>tool.name==='jump')!;
  assert.equal((tool.invoke(jump) as {ok:boolean}).ok,true);
  for(let tick=0;tick<20;tick++)engine.step();
  assert.ok(engine.recentEvents.some(event=>event.type==='arrived'));
  assert.equal(engine.entity('t1').motion,undefined);
});

test('geometry includes visible overhead surfaces and never reveals blocks behind an opaque wall',()=>{
  const wall:Block[]=[];
  for(let x=-2;x<=2;x++)for(let y=1;y<=4;y++)wall.push([x,y,1,'stone']);
  const engine=fixture([...wall,[0,3,0,'leaves'],[0,1,2,'wood']]);
  const geometry=compactView(engine.observe('t1')).geometry!;
  assert.ok(geometry.visibleSurfaces.some(surface=>surface.direction==='overhead'&&surface.material==='leaves'));
  assert.ok(!geometry.visibleSurfaces.some(surface=>surface.material==='wood'));
  assert.match(geometry.unknown,/unknown, not an opening/);
});

test('low canopy blocks headroom rather than offering a jump, and clearing it opens the route',()=>{
  const engine=fixture([[0,2,1,'leaves']]);
  const forward=engine.observe('t1').navigation.paths[1];
  assert.equal(forward.issue?.kind,'overhang');assert.deepEqual(forward.issue?.target,[0,2,1]);
  assert.match(forward.issue!.message,/headroom/);assert.doesNotMatch(forward.issue!.message,/rise/);
  assert.equal(forward.jump,undefined);assert.ok(forward.options!.includes('hit'));
  assert.equal(engine.act('t1',{action:'jump',distance:2}).ok,false);
  for(let hit=0;hit<3;hit++)assert.equal(engine.act('t1',{action:'hit',target:[0,2,1]}).ok,true);
  engine.act('t1',{action:'store'});
  assert.ok(engine.observe('t1').navigation.paths[1].clearance>=2,'Removing the canopy opens the checked approach.');
  assert.equal(engine.act('t1',{action:'walk',distance:2}).ok,true);
  for(let tick=0;tick<20;tick++)engine.step();
  assert.ok(engine.entity('t1').position[2]>2);
  const high=fixture([[0,3,1,'leaves']]);
  assert.ok(high.observe('t1').navigation.paths[1].clearance>=2,'A canopy above the body leaves enough walking headroom.');
});

test('direct inventory tools name available stacks by kind and contents',()=>{
  const engine=fixture();engine.entity('t1').inventory={stacks:[{kind:'leaves',count:3},{kind:'bucket',contents:'water',count:1}],selected:null,capacity:640};
  const hold=worldTools(engine,'t1',{notes:[]},{viewAngle:90}).find(tool=>tool.name==='hold')!;
  const stack=hold.parameters.properties!.stack;
  assert.match(stack.description!,/1: bucket containing water/);assert.deepEqual(stack.enum,[0,1]);
  assert.equal(engine.entity('t1').yaw,0);
});

test('direct target coordinates are revalidated rather than reassigned when the world changes',()=>{
  const engine=fixture([[0,1,1,'wood']]);
  const tool=worldTools(engine,'t1',{notes:[]}).find(tool=>tool.name==='hit')!;
  const target=(tool.parameters.properties!.target.examples as number[][]).find(value=>value.join(',')==='0,1,1')!;
  engine.voxels.set([0,1,1],null);engine.voxels.set([1,1,1],'wood');
  assert.deepEqual(target,[0,1,1]);assert.equal((tool.invoke({target}) as {ok:boolean}).ok,false);
  assert.equal(engine.blockDamage.size,0);
  assert.equal((tool.invoke({target:[99,99,99]}) as {ok:boolean}).ok,false);
});

test('progress reports actual inventory changes and flags repeated blocked moves without claiming collection',()=>{
  const engine=fixture([[0,1,1,'wood'],[0,2,1,'wood']]);
  for(let i=0;i<3;i++){engine.act('t1',{action:'walk',distance:3});for(let tick=0;tick<20;tick++)engine.step();}
  let progress=progressContext(recentActions(engine.recentEvents));
  assert.ok(progress.blockage);assert.deepEqual(progress.collected,[]);
  for(let i=0;i<3;i++)engine.act('t1',{action:'hit',target:[0,1,1]});
  progress=progressContext(recentActions(engine.recentEvents));
  assert.equal(progress.collected.length,1);assert.ok(progress.inventoryChanges.some(change=>change.kind==='wood'&&change.change===1));
  engine.act('t1',{action:'store'});
  assert.equal(progressContext(recentActions(engine.recentEvents)).inventoryChanges.length,progress.inventoryChanges.length);
});
