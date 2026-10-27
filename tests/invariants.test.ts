import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/core/engine';
import { island } from '../src/modules/island';
import type { Block, Entity, WorldModule } from '../src/core/types';
import { Store } from '../server/store';
import { worldTools } from '../server/agents/tools';
import { apply } from '../server/agents/harness-plugin';

const entity = (id = 't1', x = .5, z = .5): Entity => ({ id, name: id, kind: 'troglodyte', controller: 'agent', position: [x,1,z], height: 2, yaw: 0, inventory: null, color: '#ffffff', status: 'idle' });
function fixture(blocks: Block[] = [], entities = [entity()]): Engine {
  const floor: Block[] = [];
  for (let x=-8;x<=8;x++) for (let z=-8;z<=8;z++) floor.push([x,0,z,'stone']);
  const module: WorldModule = { ...island, generate: () => ({ blocks: [...floor,...blocks], entities }) };
  return new Engine(module);
}
test('generated plants never replace tree roots and all nine trunks reach the terrain',()=>{
  const {blocks}=island.generate(),columns=new Map<string,number[]>();
  for(const [x,y,z,kind] of blocks)if(kind==='wood'){const column=`${x},${z}`,heights=columns.get(column)??[];heights.push(y);columns.set(column,heights);}
  const trunks=[...columns].filter(([,heights])=>heights.length>=4);assert.equal(trunks.length,9);
  for(const [column,heights] of trunks){const [x,z]=column.split(',').map(Number),ground=blocks.filter(block=>block[0]===x&&block[2]===z&&['grass','dirt','sand','stone'].includes(block[3]));assert.equal(Math.min(...heights),Math.max(...ground.map(block=>block[1]))+1,`Tree root at ${column} must touch the ground.`);}
  assert.ok(blocks.some(block=>block[0]===5&&block[1]===4&&block[2]===-25&&block[3]==='wood'));
});
test('half-height water boundary and swept movement refuse a deep intermediate cell', () => {
  const e = entity();
  assert.equal(island.canEnter(e,[0,-1,0]).ok,true);
  assert.equal(island.canEnter(e,[0,-1.01,0]).ok,false);
  const engine = fixture();
  engine.voxels.set([0,0,1],null); engine.voxels.set([0,-2,1],'sand');
  assert.ok(engine.observe('t1').navigation.paths.find(path => path.turn === 0)!.clearance < 1);
  const before = engine.state();
  const result=engine.act('t1',{action:'walk',distance:3});
  assert.equal(result.ok,true,'A distant hazard should allow the safe part of the walk.');
  for(let tick=0;tick<40;tick++)engine.step();
  assert.ok(engine.entity('t1').position[2]>before.entities[0].position[2]);
  assert.ok(engine.entity('t1').position[2]<1.24,'The rear of the footprint can still be supported at the edge.');
  assert.match(engine.entity('t1').lastAction!.message,/water|drops away/i);
});
test('movement continues without decisions and cannot walk through a newly placed obstacle', () => {
  const engine = fixture();
  assert.equal(engine.act('t1',{action:'walk',distance:4}).ok,true);
  for(let i=0;i<10;i++) engine.step();
  assert.ok(engine.entity('t1').position[2] > .5);
  for(let y=1;y<=4;y++) engine.voxels.set([0,y,2],'stone');
  for(let i=0;i<80;i++) engine.step();
  assert.ok(engine.entity('t1').position[2] < 2);
  assert.equal(engine.entity('t1').motion,undefined);
});
test('walking and running step down one block without inventing a gap',()=>{
  for(const action of ['walk','run'] as const)for(const angle of [0,45]){
    const blocks:Block[]=[];for(let x=-5;x<=5;x++)for(let z=-4;z<=0;z++)blocks.push([x,1,z,'stone']);
    const engine=fixture(blocks);engine.entity('t1').position=[.5,2,.5];
    const result=engine.act('t1',{action,distance:2,angle});assert.equal(result.ok,true,result.message);
    for(let tick=0;tick<40;tick++)engine.step();
    assert.equal(engine.entity('t1').position[1],1);assert.equal(engine.entity('t1').motion,undefined);
    assert.equal(engine.entity('t1').lastAction!.feedback!.outcome,'arrived');
  }
  const high:Block[]=[];for(let x=-3;x<=3;x++)for(let z=-2;z<=0;z++){high.push([x,1,z,'stone'],[x,2,z,'stone']);}
  const engine=fixture(high);engine.entity('t1').position=[.5,3,.5];engine.act('t1',{action:'walk',distance:2});for(let tick=0;tick<40;tick++)engine.step();
  assert.equal(engine.entity('t1').position[1],3);assert.ok(engine.entity('t1').position[2]<1.24,'A two-block drop is still refused.');
});
test('navigation separates distant approaches from possible jumps and respects occupied hands',()=>{
  const distant=fixture([[0,1,7,'stone']]);
  const forward=distant.observe('t1').navigation.paths[1];
  assert.ok(forward.approach);assert.ok(forward.options!.includes('walk'));assert.equal(forward.jump,undefined);assert.equal(forward.options!.includes('hit'),false);assert.equal(forward.options!.includes('jump'),false);
  const near=fixture([[0,1,1,'wood']]);near.entity('t1').inventory={stacks:[{kind:'grass',count:1}],selected:0,capacity:64};
  const observation=near.observe('t1'),tools=worldTools(near,'t1',{notes:[]}).map(tool=>tool.name);
  assert.match(observation.description,/hands are occupied.*Store or place/);
  for(const path of observation.navigation.paths){for(const option of path.options??[])assert.ok(tools.includes(option),`Unavailable option ${option}`);if(path.jump){const copy=new Engine(near.module,near.state());assert.equal(copy.act('t1',{action:'jump',...path.jump}).ok,true);}}
  assert.ok(observation.navigation.paths[1].options!.includes('store'));assert.equal(observation.navigation.paths[1].options!.includes('hit'),false);
  const tree=fixture([[0,1,1,'wood'],[0,2,1,'wood'],[0,3,1,'wood']]);assert.match(tree.observe('t1').description,/tree trunk/);assert.doesNotMatch(tree.observe('t1').description,/wood wall/);
});
test('looking sideways reports movement angles relative to the unchanged body and turn is usable',()=>{
  const engine=fixture(),before=engine.entity('t1').yaw,view=engine.observeAt('t1',90);
  assert.equal(engine.entity('t1').yaw,before);assert.equal(view.bodyYaw,before);assert.equal(view.viewAngle,90);assert.deepEqual(view.navigation.paths.map(path=>path.turn),[45,90,135]);
  const turn=worldTools(engine,'t1',{notes:[]}).find(tool=>tool.name==='turn')!;assert.ok(turn);
  assert.equal((turn.invoke({angle:90}) as {ok:boolean}).ok,true);assert.equal(engine.entity('t1').yaw,90);
});
test('ordinary gaps do not teach the deep-water island boundary',()=>{
  const engine=fixture();engine.voxels.set([0,0,2],null);engine.voxels.set([0,0,3],null);
  engine.observe('t1');assert.equal(engine.discoveries.size,0,'Looking alone must not create a discovery.');
  assert.equal(engine.act('t1',{action:'walk',distance:4}).ok,true);
  assert.equal(engine.discoveries.size,0,'The character must reach the edge before learning.');
  for(let tick=0;tick<40;tick++)engine.step();
  engine.act('t1',{action:'walk',distance:1});
  assert.equal(engine.recentEvents.filter(event=>event.type==='discovery').length,0);
  assert.equal(engine.discoveries.get('t1')?.has('deep-water-limit')??false,false);
  const jump=fixture();jump.voxels.set([0,0,1],null);
  assert.equal(jump.act('t1',{action:'jump',distance:2}).ok,true);for(let tick=0;tick<20;tick++)jump.step();
  assert.equal(jump.discoveries.size,0,'A safe landing across a hole is not an unsafe edge encounter.');
});
test('the underwater shore ending in deep water teaches the exact island-boundary fact once',()=>{
  const creature=entity();creature.position=[.5,-1,.5];
  const engine=new Engine({...island,generate:()=>({blocks:[[0,-2,0,'sand']],entities:[creature]})});
  engine.observe('t1');assert.equal(engine.discoveries.size,0);
  const result=engine.act('t1',{action:'walk',distance:1});
  assert.equal(result.ok,true,result.message);assert.equal(engine.discoveries.size,0);
  for(let tick=0;tick<40;tick++)engine.step();
  assert.ok(engine.discoveries.get('t1')?.has('deep-water-limit'));
  assert.equal((engine.entity('t1').lastAction?.feedback?.issue as {kind:string}).kind,'water');
  engine.act('t1',{action:'walk',distance:1});
  const discoveries=engine.recentEvents.filter(event=>event.type==='discovery');
  assert.equal(discoveries.length,1);
  assert.equal(discoveries[0].message,'The island ends at deep water. I cannot leave it because the water would rise above half my height.');
  const shallow=fixture();shallow.entity('t1').position=[.5,-1,.5];
  for(let z=0;z<=3;z++){shallow.voxels.set([0,0,z],null);shallow.voxels.set([0,-2,z],'sand');}
  shallow.act('t1',{action:'walk',distance:1});for(let tick=0;tick<40;tick++)shallow.step();
  assert.equal(shallow.discoveries.size,0,'Safe shallow water must not teach a boundary.');
});
test('navigation exposes visible local clearance and a rejected move returns alternatives', () => {
  const engine = fixture([[0,1,2,'stone'],[0,2,2,'stone'],[0,3,2,'stone']]);
  const navigation = engine.observe('t1').navigation;
  assert.deepEqual(navigation.paths.map(path => path.turn),[-45,0,45]);
  assert.ok(navigation.paths.find(path => path.turn === 0)!.clearance < 1.5);
  assert.ok(navigation.paths.find(path => path.turn === -45)!.clearance > 2);
  const before = [...engine.entity('t1').position];
  const result = engine.act('t1',{action:'walk',distance:3});
  assert.equal(result.ok,true);
  assert.deepEqual(engine.entity('t1').position,before,'Motion starts but does not teleport.');
  assert.ok(result.navigation);
  assert.ok(result.navigation.blockedAfter! < 1.5);
  assert.equal(result.navigation.paths.length,3);
  for(let tick=0;tick<40;tick++)engine.step();
  assert.match(engine.entity('t1').lastAction!.message,/wall/i);
});
test('one-block rises are jumpable, two-block walls are not, and feedback names the difference',()=>{
  const one=fixture([[0,1,1,'dirt']]);
  const blocked=one.act('t1',{action:'walk',distance:2});assert.equal(blocked.ok,false);assert.match(blocked.message,/one-block dirt rise/);assert.ok(blocked.navigation!.paths[1].options!.includes('jump'));
  const jumped=one.act('t1',{action:'jump',distance:2});assert.equal(jumped.ok,true,jumped.message);for(let tick=0;tick<20;tick++)one.step();assert.ok(one.entity('t1').position[2]>=2);
  const two=fixture([[0,1,1,'stone'],[0,2,1,'stone']]);
  const wall=two.act('t1',{action:'walk',distance:2});assert.equal(wall.ok,false);assert.match(wall.message,/2-block stone wall/);assert.equal(wall.navigation!.paths[1].options!.includes('jump'),false);
  assert.equal(two.act('t1',{action:'jump',distance:2}).ok,false);
});
test('a creature can jump while carrying a raw block but still cannot run or hit',()=>{
  const engine=fixture();
  engine.entity('t1').inventory={stacks:[{kind:'stone',count:1}],selected:0,capacity:64};
  assert.equal(engine.act('t1',{action:'jump',distance:2}).ok,true);
  for(let tick=0;tick<20;tick++)engine.step();
  assert.ok(engine.entity('t1').position[2]>=2);
  assert.equal(engine.act('t1',{action:'run',distance:2}).ok,false);
  assert.equal(engine.act('t1',{action:'hit',target:[0,0,3]}).ok,false);
  const names=worldTools(engine,'t1',{notes:[]}).map(tool=>tool.name);
  assert.ok(names.includes('jump'));assert.equal(names.includes('run'),false);assert.equal(names.includes('hit'),false);
});
test('a placed arrow remains a loose grounded object instead of becoming a voxel',()=>{
  const engine=fixture();
  engine.entity('t1').inventory={stacks:[{kind:'arrow',count:1}],selected:0,capacity:64};
  const result=engine.act('t1',{action:'place',target:[0,1,1]});
  assert.equal(result.ok,true,result.message);assert.equal(engine.voxels.get([0,1,1]),undefined);
  assert.equal(engine.bodies.length,1);assert.equal(engine.bodies[0].kind,'arrow');assert.equal(engine.bodies[0].resting,true);
  assert.equal(engine.entity('t1').inventory,null);
  assert.equal(engine.act('t1',{action:'pickup',itemId:engine.bodies[0].id}).ok,true);
  assert.equal(engine.held(engine.entity('t1'))!.kind,'arrow');
});
test('every block cracks twice, breaks on the third hit and conserves inventory', () => {
  const engine = fixture([[1,1,0,'wood'],[-1,1,0,'dirt']]);
  const before = engine.voxels.cells.size;
  assert.match(engine.act('t1',{action:'hit',target:[1,1,0]}).message,/Thin cracks/);
  assert.equal(engine.blockDamage.get('1,1,0'),1);
  assert.match(engine.act('t1',{action:'hit',target:[1,1,0]}).message,/cracks spread/);
  assert.equal(engine.voxels.get([1,1,0]),'wood');
  assert.match(engine.act('t1',{action:'hit',target:[1,1,0]}).message,/breaks/);
  assert.equal(engine.voxels.cells.size,before-1);assert.equal(engine.blockDamage.has('1,1,0'),false);
  assert.equal(engine.act('t1',{action:'place',target:[1,1,0]}).ok,true);
  assert.equal(engine.voxels.cells.size,before);
  assert.equal(engine.entity('t1').inventory,null);
});
test('crafting, block breaking and the deep-water limit are journaled once per creature',()=>{
  const engine=fixture([[1,1,0,'wood']]);
  for(let hit=0;hit<3;hit++)engine.act('t1',{action:'hit',target:[1,1,0]});
  assert.equal(engine.act('t1',{action:'strike_held',impact:[.5,1,.5]}).ok,true);
  engine.entity('t1').inventory={stacks:[{kind:'wood',count:1}],selected:0,capacity:64};
  assert.equal(engine.act('t1',{action:'strike_held',impact:[.5,1,.5]}).ok,true);
  engine.entity('t1').inventory=null;
  engine.module.canEnter=()=>({ok:false,message:'Refused: the water would rise above half my height.'});
  assert.equal(engine.act('t1',{action:'walk',distance:1}).ok,false);engine.act('t1',{action:'walk',distance:1});
  const discoveries=engine.recentEvents.filter(event=>event.type==='discovery');
  assert.deepEqual(discoveries.map(event=>(event.data as {knowledge:string}).knowledge),['blocks-break-after-three-hits','wood-shape:bucket','deep-water-limit']);
  const restored=new Engine(engine.module,engine.state());
  assert.deepEqual([...restored.discoveries.get('t1')!],['blocks-break-after-three-hits','wood-shape:bucket','deep-water-limit']);
});
test('held wood can be discovered as a bucket, filled with water and emptied', () => {
  const engine = fixture([[1,1,0,'wood']]);
  for(let hit=0;hit<3;hit++)assert.equal(engine.act('t1',{action:'hit',target:[1,1,0]}).ok,true);
  assert.equal(engine.voxels.get([1,1,0]),undefined);
  assert.equal(engine.act('t1',{action:'strike_held',impact:[.5,1,.5]}).ok,true);
  assert.equal(engine.held(engine.entity('t1'))!.kind,'bucket');
  engine.entity('t1').position=[.5,-1,.5];
  engine.voxels.set([0,0,0],null); engine.voxels.set([1,0,0],null);
  engine.voxels.set([1,-1,0],null);
  assert.equal(engine.act('t1',{action:'fill',target:[1,-1,0]}).ok,true);
  assert.equal(engine.held(engine.entity('t1'))!.contents,'water');
  assert.equal(engine.act('t1',{action:'empty',target:[1,-1,0]}).ok,true);
  assert.equal(engine.held(engine.entity('t1'))!.contents,undefined);
});
test('buckets are independent inventory units and dirt filling conserves a world block',()=>{
  const engine=fixture([[1,1,0,'dirt']]);
  engine.entity('t1').inventory={stacks:[{kind:'bucket',count:1},{kind:'bucket',count:1}],selected:0,capacity:64};
  const before=engine.voxels.cells.size;
  assert.equal(engine.act('t1',{action:'fill',target:[1,1,0]}).ok,true);
  assert.equal(engine.voxels.cells.size,before-1);
  assert.equal(engine.entity('t1').inventory!.stacks[0].contents,'dirt');
  assert.equal(engine.entity('t1').inventory!.stacks[1].contents,undefined);
  assert.equal(engine.act('t1',{action:'empty',target:[1,1,0]}).ok,true);
  assert.equal(engine.voxels.cells.size,before);
});
test('supporting blocks reject damage with a clear creature-specific error',()=>{
  const engine=fixture([], [entity(),entity('t2',1.5,.5)]);
  const result=engine.act('t1',{action:'hit',target:[1,0,0]});assert.equal(result.ok,false);assert.match(result.message,/t2 is standing on it/);assert.equal(engine.blockDamage.size,0);
});
test('speech requires vocabulary, clear line of sight and ten-metre range; inbox survives resume', () => {
  const engine = fixture([], [entity(),entity('t2',.5,5.5)]);
  assert.equal(engine.act('t1',{action:'say',word:'hello'}).ok,false);
  assert.equal(engine.act('t1',{action:'say',word:'hey'}).ok,true);
  assert.equal(engine.observe('t2').heard.length,1);
  engine.voxels.set([0,2,3],'stone');
  engine.act('t1',{action:'say',word:'look'});
  assert.equal(engine.observe('t2').heard.length,1);
  engine.voxels.set([0,2,3],null); engine.entity('t2').position[2]=11;
  engine.act('t1',{action:'say',word:'come'});
  assert.equal(engine.observe('t2').heard.length,1);
  const resumed = new Engine(engine.module,engine.state());
  assert.deepEqual(resumed.observe('t2').heard,engine.observe('t2').heard);
});
test('encounters support multiple Troglodytes, persist and emit once until they separate',()=>{
  const second=entity('t2',.5,4.5);second.yaw=180;
  const third=entity('t3',3.5,3.5);third.yaw=225;
  const duck:Entity={...entity('duck',1.5,3.5),kind:'duck',controller:'wander',height:.65};
  const engine=fixture([],[entity(),second,third,duck]),store=new Store(':memory:',engine.module.manifest);
  try{
    store.record(engine.frame(),engine.state());engine.step();store.record(engine.frame());
    const notices=engine.observe('t1').encounters;assert.equal(notices.length,2);assert.ok(notices.every(notice=>notice.canSpeakNow));assert.ok(notices.every(notice=>notice.message.includes('use say')));
    assert.equal(store.eventsAt(1,'t1').filter(event=>event.type==='encounter').length,2);
    const restored=new Engine(engine.module,store.stateAt(1));restored.nextEvent=store.maxEventId()+1;assert.deepEqual(restored.observe('t1').encounters,notices);
    restored.step();assert.equal(restored.frame().events.filter(event=>event.type==='encounter').length,0,'Remaining in view must not repeat encounters after restart.');
    restored.acknowledgeEncounters('t1',notices);assert.equal(restored.observe('t1').encounters.length,0);
    restored.entity('t3').position=[30.5,1,3.5];restored.step();restored.frame();
    restored.entity('t3').position=[3.5,1,3.5];restored.step();
    assert.equal(restored.observe('t1').encounters.length,1);assert.equal(restored.observe('t1').encounters[0].otherId,'t3');
  }finally{store.close();}
});
test('encounters respect sight, occlusion, speech range and disabled characters',()=>{
  const engine=fixture([],[entity(),entity('t2',.5,4.5)]);
  engine.entity('t1').yaw=180;engine.step();assert.equal(engine.observe('t1').encounters.length,0);
  engine.entity('t1').yaw=0;engine.voxels.set([0,2,2],'stone');engine.step();assert.equal(engine.observe('t1').encounters.length,0);
  engine.voxels.set([0,2,2],null);engine.entity('t2').position[2]=11;engine.step();assert.equal(engine.observe('t1').encounters.length,0);
  engine.entity('t2').position[2]=4.5;engine.setEntityEnabled('t2',false);engine.step();assert.equal(engine.observe('t1').encounters.length,0);
  engine.setEntityEnabled('t2',true);engine.step();assert.equal(engine.observe('t1').encounters.length,1);
  engine.entity('t2').position[2]=11;engine.step();assert.equal(engine.observe('t1').encounters[0].canSpeakNow,false,'A past encounter must not imply the character is still within range.');
  engine.setEntityEnabled('t2',false);assert.equal(engine.observe('t1').encounters.length,0);
});
test('observations do not reveal creatures behind solid walls or behind the observer', () => {
  const engine = fixture([], [entity(),entity('t2',.5,4.5)]);
  assert.equal(engine.observe('t1').entities.length,1);
  engine.voxels.set([0,2,2],'stone');
  assert.equal(engine.observe('t1').entities.length,0);
  engine.voxels.set([0,2,2],null); engine.entity('t1').yaw=180;
  assert.equal(engine.observe('t1').entities.length,0);
});
test('disabled entities are invisible, non-physical, inert and persist across resume', () => {
  const duck: Entity = { ...entity('duck',3.5,3.5), name:'Pebble', kind:'duck', controller:'wander', height:.65, motion:{destination:[3.5,1,6.5],speed:1} };
  const engine = fixture([], [entity(),entity('t2',.5,2.5),duck]);
  assert.equal(engine.setEntityEnabled('t2',false),true);
  assert.equal(engine.setEntityEnabled('duck',false),true);
  assert.equal(engine.entity('t2').status,'disabled');
  assert.equal(engine.observe('t1').entities.length,0);
  assert.equal(engine.act('t2',{action:'wait'}).ok,false);
  assert.equal(engine.act('t1',{action:'walk',distance:3}).ok,true,'A disabled creature must not block movement.');
  const duckPosition=[...engine.entity('duck').position];
  for(let i=0;i<30;i++) engine.step();
  assert.deepEqual(engine.entity('duck').position,duckPosition);
  const resumed=new Engine(engine.module,engine.state());
  assert.equal(resumed.entity('t2').enabled,false);
  assert.equal(resumed.entity('duck').enabled,false);
});
test('flat terrain is visible by its exposed faces, rather than its buried block centres', () => {
  const engine = fixture();
  const observation = engine.observe('t1');
  assert.ok(observation.surfaces.find(s=>s.kind==='stone')!.count > 50);
  assert.ok(observation.blocks.some(b=>b[2]>=5));
});
test('thrown stone is lost in the abyss while wood floats; neither duplicates inventory', () => {
  const engine = fixture();
  engine.entity('t1').inventory={stacks:[{kind:'stone',count:1}],selected:0,capacity:64};
  assert.equal(engine.act('t1',{action:'throw',force:8}).ok,true);
  assert.equal(engine.entity('t1').inventory,null);
  engine.bodies[0].position=[30,-33,30]; engine.bodies[0].velocity=[0,0,0];
  engine.bodies.push({id:'wood',kind:'wood',position:[31,1,30],velocity:[0,0,0],resting:false});
  for(let i=0;i<400;i++) engine.step();
  assert.equal(engine.lost,1);
  assert.equal(engine.bodies.length,1);
  assert.equal(engine.bodies[0].kind,'wood');
  assert.ok(engine.bodies[0].position[1] > -1);
  assert.ok(engine.discoveries.get('t1')?.has('nonfloating-objects-sink'));
});
test('a thrown raw block teaches its owner that resting blocks join the terrain',()=>{
  const engine=fixture();engine.entity('t1').inventory={stacks:[{kind:'dirt',count:1}],selected:0,capacity:64};
  assert.equal(engine.act('t1',{action:'throw',force:1}).ok,true);Object.assign(engine.bodies[0],{position:[0.5,1.3,2.5],velocity:[0,0,0],resting:true});engine.step();
  assert.equal(engine.voxels.get([0,1,2]),'dirt');assert.equal(engine.bodies.length,0);assert.ok(engine.discoveries.get('t1')?.has('thrown-blocks-settle'));
  assert.equal(engine.recentEvents.filter(event=>event.type==='discovery'&&(event.data as {knowledge?:string})?.knowledge==='thrown-blocks-settle').length,1);
});
test('SQLite replays exact edits, dynamics and events, including same-tick restart records', () => {
  const engine = fixture([[1,1,0,'wood']]), store = new Store(':memory:',engine.module.manifest);
  store.record(engine.frame(),engine.state());
  const initial = store.stateAt(0);
  for(let hit=0;hit<3;hit++)engine.act('t1',{action:'hit',target:[1,1,0]}); engine.step(); engine.step();
  const atTwo = engine.state(); store.record(engine.frame());
  engine.event('world','session','Restart'); store.record(engine.frame(),engine.state());
  engine.act('t1',{action:'throw',force:3}); engine.step(); engine.step(); store.record(engine.frame());
  assert.deepEqual(store.stateAt(0),initial);
  assert.deepEqual(store.stateAt(2),atTwo);
  assert.deepEqual(store.stateAt(4),engine.state());
  assert.ok(store.framesAfter(0)[0].changes.some(([key,kind]) => key==='1,1,0' && kind===null));
  assert.ok(store.eventsAt(4).length>=3);
  store.close();
});
test('SQLite reconstructs the last twenty private memory notes at a recorded instant',()=>{
  const engine=fixture(),store=new Store(':memory:',engine.module.manifest);store.record(engine.frame(),engine.state());
  for(let index=0;index<22;index++)engine.event('t1','memory',`memory ${index}`);store.record(engine.frame());
  assert.deepEqual(store.memoryAt(0,'t1'),Array.from({length:20},(_,index)=>`memory ${index+2}`));store.close();
});
test('the Harness schema guard validates contextual embodied tools', async () => {
  const engine = fixture([[1,1,0,'wood']]), memory = {notes:[] as string[]}, tools=worldTools(engine,'t1',memory);
  assert.deepEqual(tools.map(t=>t.name),['look','walk','turn','run','jump','hit','pickup','say','wait','journal']);
  const invalid = await tools.find(tool=>tool.name==='walk')!.execute({distance:'8'}) as {ok:boolean};
  assert.equal(invalid.ok,false);
  const journal=tools.find(tool=>tool.name==='journal')!;for(let i=0;i<23;i++)await journal.execute({note:`note ${i}`});
  assert.deepEqual(memory.notes,Array.from({length:20},(_,index)=>`note ${index+3}`));
  await journal.execute({note:'note 22'});assert.equal(memory.notes.length,20,'Duplicate private notes must not be stored twice.');
  engine.discoveries.set('t1',new Set(['thrown-blocks-settle']));await journal.execute({note:'Thrown blocks settle and become part of the terrain.'});assert.equal(memory.notes.length,20,'Learned knowledge must not be duplicated as a private note.');
  let registered=0; apply({tools:{register(tool){assert.equal(typeof tool.output.render,'function');registered++;return()=>{};}}},{engine,entityId:'t1',memory});
  assert.equal(registered,tools.length);
  for(let hit=0;hit<3;hit++)engine.act('t1',{action:'hit',target:[1,1,0]});
  const carrying=worldTools(engine,'t1',memory).map(tool=>tool.name);
  assert.ok(carrying.includes('strike_held'));assert.equal(carrying.includes('hit'),false);assert.equal(carrying.includes('run'),false);
});
