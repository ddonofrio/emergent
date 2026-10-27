import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/core/engine';
import { island, speechIdeas } from '../src/modules/island';
import type { Block, Entity, WorldModule } from '../src/core/types';
import { Store } from '../server/store';
import { worldTools } from '../server/agents/tools';
import { apply } from '../server/agents/harness-plugin';
import { compactResult, compactView, inventoryContext, recentActions, relevantKnowledge, rounded } from '../server/agents/context';
import { exchangeInventory } from '../src/core/inventory';

const entity = (id = 't1', x = .5, z = .5): Entity => ({ id, name: id, kind: 'troglodyte', controller: 'agent', position: [x,1,z], height: 2, yaw: 0, inventory: null, color: '#ffffff', status: 'idle' });
function fixture(blocks: Block[] = [], entities = [entity()]): Engine {
  const floor: Block[] = [];
  for (let x=-8;x<=8;x++) for (let z=-8;z<=8;z++) floor.push([x,0,z,'stone']);
  const module: WorldModule = { ...island, generate: () => ({ blocks: [...floor,...blocks], entities }) };
  return new Engine(module);
}

test('follow is offered only for visible active entities within twenty metres, including animals',()=>{
  const engine=fixture([],[entity(),entity('t2',.5,20.5)]),memory={notes:[]};
  assert.ok(engine.observe('t1').interactions.follow.some(other=>other.id==='t2'));
  assert.ok(worldTools(engine,'t1',memory).some(tool=>tool.name==='follow'));
  engine.entity('t2').position[2]=20.51;
  assert.equal(engine.act('t1',{action:'follow',entityId:'t2'}).ok,false);assert.equal(worldTools(engine,'t1',memory).some(tool=>tool.name==='follow'),false);
  engine.entity('t2').position[2]=4.5;engine.entity('t1').yaw=180;
  assert.equal(engine.act('t1',{action:'follow',entityId:'t2'}).ok,false);
  engine.entity('t1').yaw=0;engine.voxels.set([0,2,2],'stone');
  assert.equal(engine.act('t1',{action:'follow',entityId:'t2'}).ok,false);
  engine.voxels.set([0,2,2],null);engine.setEntityEnabled('t2',false);
  assert.equal(engine.act('t1',{action:'follow',entityId:'t2'}).ok,false);
  engine.setEntityEnabled('t2',true);engine.entity('t2').kind='duck';engine.entity('t2').controller='wander';engine.entity('t2').height=.65;
  assert.equal(engine.act('t1',{action:'follow',entityId:'t2'}).ok,true);
  assert.deepEqual(worldTools(engine,'t1',memory).map(tool=>tool.name),['follow','stop_follow']);
  assert.equal(engine.act('t1',{action:'walk',distance:1}).ok,false);
});

test('being followed removes follow, reports the follower, and prevents mutual follow loops at commit time',()=>{
  const first=entity('t1',.5,.5),second=entity('t2',2.5,.5),third=entity('t3',4.5,.5),engine=fixture([],[first,second,third]);
  engine.entity('t1').yaw=90;engine.entity('t2').yaw=90;engine.entity('t3').yaw=270;
  assert.equal(engine.act('t1',{action:'follow',entityId:'t2'}).ok,true);
  const observed=engine.observe('t2');
  assert.deepEqual(observed.interactions.follow,[]);
  assert.match(observed.beingFollowed![0].message,/t1 is following you/);
  assert.equal(worldTools(engine,'t2',{notes:[]}).some(tool=>tool.name==='follow'),false);
  assert.match(engine.act('t2',{action:'follow',entityId:'t1'}).message,/being followed/);
  assert.equal(engine.entity('t2').following,undefined);

  engine.act('t1',{action:'stop_follow'});
  assert.equal(engine.act('t2',{action:'follow',entityId:'t3'}).ok,true);
  assert.equal(engine.act('t1',{action:'follow',entityId:'t2'}).ok,true);
  assert.equal(engine.entity('t2').following,undefined,'A creature stops its own follow as soon as another creature follows it.');
  assert.ok(engine.entity('t1').following);
});

test('entity hitboxes prevent pass-through and produce a recorded safe rebound',()=>{
  const engine=fixture([],[entity('t1',.5,.5),entity('t2',.5,2.5)]),walker=engine.entity('t1'),other=engine.entity('t2');
  walker.yaw=0;
  assert.equal(engine.act('t1',{action:'walk',distance:5}).ok,true);
  let closest=Infinity,sawBounce=false;
  for(let tick=0;tick<80;tick++){
    engine.step();
    const gap=Math.hypot(walker.position[0]-other.position[0],walker.position[2]-other.position[2]);
    closest=Math.min(closest,gap);
    assert.ok(gap>=(walker.hitbox!.radius+other.hitbox!.radius)-.001,'Hitboxes must never overlap.');
    assert.equal(engine.module.canEnter(walker,walker.position).ok,true,'A rebound must remain in permitted terrain.');
    assert.ok([-.23,.23].some(dx=>[-.23,.23].some(dz=>engine.voxels.solid([walker.position[0]+dx,walker.position[1]-.01,walker.position[2]+dz]))),'A rebound must retain safe ground beneath the character.');
    if(walker.motion?.kind==='bounce'||other.motion?.kind==='bounce')sawBounce=true;
  }
  assert.ok(sawBounce);assert.ok(closest<1);
  assert.match(walker.lastAction!.message,/collide.*bounce back safely/i);
  assert.ok(engine.recentEvents.some(event=>event.type==='collision'&&event.actor==='t1'));
  assert.ok(other.position[2]>2.5,'The struck character also rebounds instead of being passed through.');
  const store=new Store(':memory:',engine.module.manifest);
  try{
    store.record(engine.frame(),engine.state());
    const history=recentActions(store.actionEventsAt(engine.tick,'t1'));
    assert.equal(history.length,1);assert.equal(history[0].result.outcome,'collision');
    assert.deepEqual(history[0].result.from,[.5,1,.5]);assert.deepEqual(history[0].result.to,rounded(walker.position));
  }finally{store.close();}
});

test('following parks at one metre, resumes when the target moves, and replays without decisions',()=>{
  const engine=fixture([],[entity(),entity('t2',.5,5.5)]),store=new Store(':memory:',engine.module.manifest);
  try{
    assert.equal(engine.act('t1',{action:'follow',entityId:'t2'}).ok,true);store.record(engine.frame(),engine.state());
    for(let tick=0;tick<50;tick++){engine.step();store.record(engine.frame());}
    assert.ok(Math.abs(engine.entity('t1').position[2]-4.5)<1e-8);assert.equal(engine.entity('t1').motion,undefined);
    assert.deepEqual(store.stateAt(50),engine.state());
    const restored=new Engine(engine.module,store.stateAt(50));restored.nextEvent=store.maxEventId()+1;
    assert.equal(restored.act('t2',{action:'walk',distance:2}).ok,true);
    for(let tick=0;tick<20;tick++)restored.step();
    assert.ok(restored.entity('t1').position[2]>6.2);assert.ok(restored.entity('t2').position[2]-restored.entity('t1').position[2]>=.99);
    const tick=restored.tick;assert.equal(restored.act('t1',{action:'stop_follow'}).ok,true);assert.equal(restored.act('t1',{action:'turn',angle:90}).ok,true);
    assert.equal(restored.tick,tick);assert.equal(restored.entity('t1').following,undefined);
  }finally{store.close();}
});

test('following stops at unsafe terrain and loses contact without exposing a hidden target location',()=>{
  const engine=fixture([[0,1,2,'stone']],[entity(),entity('t2',.5,5.5)]);
  engine.act('t1',{action:'follow',entityId:'t2'});for(let tick=0;tick<20;tick++)engine.step();
  assert.equal(engine.entity('t1').following?.blocked?.kind,'rise');assert.ok(engine.entity('t1').position[2]<1.8);
  assert.match(engine.observe('t1').following!.message,/Stop following/);
  for(let y=1;y<5;y++)engine.voxels.set([0,y,3],'stone');
  const obscured=engine.observe('t1').following!;assert.equal(obscured.metres,undefined);assert.equal(obscured.direction,undefined);
  engine.step();assert.equal(engine.entity('t1').following,undefined);assert.match(engine.entity('t1').lastAction!.message,/lose direct contact/);
  const water=fixture([],[entity(),entity('t2',.5,4.5)]);water.entity('t1').position[1]=-1;water.entity('t2').position[1]=-1;
  for(let z=-1;z<=5;z++){water.voxels.set([0,0,z],null);water.voxels.set([0,-2,z],z<=0?'sand':null);}
  assert.equal(water.act('t1',{action:'follow',entityId:'t2'}).ok,true);for(let tick=0;tick<20;tick++)water.step();
  assert.equal(water.entity('t1').following?.blocked?.kind,'water');assert.ok(water.discoveries.get('t1')?.has('deep-water-limit'));
});

test('voices broadcast to bystanders and animals with recorded direction and distance; ducks reply without recursion',()=>{
  const duck:Entity={...entity('duck',2.5,2.5),name:'Pebble',kind:'duck',controller:'wander',height:.65};
  const listener=entity('t2',.5,5.5),outside=entity('outside',.5,11),blocked=entity('blocked',-4.5,.5);
  const engine=fixture([[-2,2,0,'stone']],[entity(),listener,duck,outside,blocked]),store=new Store(':memory:',island.manifest);
  try{
    assert.equal(engine.act('t1',{action:'say',word:'Follow me'}).ok,true);
    const heard=engine.observe('t2').heard;assert.equal(heard.length,2);
    assert.deepEqual(heard[0],{from:'t1',speakerId:'t1',word:'Follow me',tick:0,direction:'behind',distance:5});
    assert.equal(heard[1].from,'Pebble');assert.equal(heard[1].word,'quack');assert.equal(typeof heard[1].distance,'number');assert.ok(heard[1].direction);
    assert.equal(engine.observe('t1').heard.at(-1)!.word,'quack');assert.equal(engine.observe('duck').heard[0].word,'Follow me');
    assert.equal(engine.observe('outside').heard.some(voice=>voice.from==='t1'),false);assert.equal(engine.observe('blocked').heard.some(voice=>voice.from==='t1'),false);
    assert.equal(engine.entity('duck').speech?.word,'quack');assert.equal(engine.recentEvents.filter(event=>event.type==='speech').length,2);
    store.record(engine.frame(),engine.state());const restored=new Engine(engine.module,store.stateAt(0));assert.deepEqual(restored.observe('t2').heard,heard);
  }finally{store.close();}
});

test('any audible message interrupts walking for an explicit continue or stop decision',()=>{
  const engine=fixture([],[entity(),entity('t2',.5,5.5)]);
  assert.equal(engine.act('t2',{action:'walk',distance:8}).ok,true);
  assert.equal(engine.act('t1',{action:'say',word:'I like you'}).ok,true);
  engine.wakeMovingListenersFromSpeech();
  const prompt=engine.entity('t2').movementPrompt!;
  assert.equal(prompt.messages[0].word,'I like you');
  assert.equal(prompt.messages[0].speakerName,'t1');
  assert.equal(typeof prompt.messages[0].direction,'string');
  assert.equal(typeof prompt.messages[0].distance,'number');
  const motion=engine.entity('t2').motion;
  assert.equal(engine.resolveMovementPrompt('t2','continue_moving').ok,true);
  assert.equal(engine.entity('t2').motion,motion);
  assert.equal(engine.entity('t2').movementPrompt,undefined);

  assert.equal(engine.act('t1',{action:'say',word:'Come here'}).ok,true);
  engine.wakeMovingListenersFromSpeech();
  assert.equal(engine.resolveMovementPrompt('t2','stop_moving').ok,true);
  assert.equal(engine.entity('t2').motion,undefined);
  assert.match(engine.entity('t2').lastAction!.message,/next turn/);
});

test('local interaction targets are actionable, exclude supporting blocks and refresh with the hands',()=>{
  const engine=fixture([[0,1,2,'wood'],[0,2,2,'stone'],[0,3,2,'stone'],[0,1,4,'wood']]);
  engine.bodies.push({id:'near',kind:'arrow',position:[-.5,1.6,1.5],velocity:[0,0,0],resting:true},{id:'far',kind:'arrow',position:[4.5,1.6,6.5],velocity:[0,0,0],resting:true});
  const targets=engine.observe('t1').interactions;
  assert.ok(targets.hit.length>0);assert.ok(targets.hit.length<=2);assert.equal(targets.hit[0].kind,'wood');
  for(const hit of targets.hit){
    assert.notDeepEqual(hit.target,[0,0,0]);assert.notDeepEqual(hit.target,[0,1,4]);
    const copy=new Engine(engine.module,engine.state());assert.equal(copy.act('t1',{action:'hit',target:hit.target}).ok,true);
  }
  assert.deepEqual(targets.pickup.map(item=>item.itemId),['near']);
  assert.ok(engine.observeAt('t1').interactions.pickup.some(item=>item.itemId==='near'));
  engine.entity('t1').inventory={stacks:[{kind:'wood',count:1}],selected:0,capacity:64};
  const held=engine.observe('t1');assert.deepEqual(held.interactions.hit,[]);assert.deepEqual(held.interactions.pickup,[]);
  assert.match(held.description,/You hold wood/);assert.doesNotMatch(held.description,/strike_held|Store or place/);
});

test('a visible trunk face can be struck even when its centre is hidden by the upper trunk',()=>{
  const engine=fixture([[0,1,1,'wood'],[0,2,1,'wood']]);
  assert.equal(engine.voxels.clearLine(engine.eye(engine.entity('t1')),[.5,1.5,1.5],true),false);
  assert.ok(engine.observe('t1').interactions.hit.some(hit=>hit.target.join(',')==='0,1,1'));
  for(let strike=0;strike<3;strike++)assert.equal(engine.act('t1',{action:'hit',target:[0,1,1]}).ok,true);
  assert.equal(engine.held(engine.entity('t1'))?.kind,'wood');
  const hidden=fixture([[0,1,1,'stone'],[0,2,1,'stone'],[0,3,1,'stone'],[0,1,2,'wood']]);
  assert.match(hidden.act('t1',{action:'hit',target:[0,1,2]}).message,/hides.*surface/);
  assert.match(hidden.act('t1',{action:'hit',target:[0,0,7]}).message,/farther than 3 metres/);
});

test('full inventories omit pickup, storing only frees hands, and arguments select real local items and stacks',()=>{
  const engine=fixture(),actor=engine.entity('t1'),memory={notes:[]};
  engine.bodies.push({id:'near-arrow',kind:'arrow',position:[.5,1.2,1.5],velocity:[0,0,0],resting:true});
  actor.inventory={stacks:['wood','sand','stone','grass','dirt','leaves','stick','plank','knife','spear'].map(kind=>({kind,count:64})),selected:0,capacity:640};
  assert.equal((worldTools(engine,'t1',memory).find(tool=>tool.name==='store')!.invoke({}) as any).ok,true);
  const inventory=inventoryContext(engine.observe('t1'));
  assert.equal(inventory.stackSlots,10);assert.equal(inventory.freeStackSlots,0);assert.equal(inventory.maxPerStack,64);assert.equal(inventory.hand,null);
  assert.equal(worldTools(engine,'t1',memory).some(tool=>tool.name==='pickup'),false);
  const hold=worldTools(engine,'t1',memory).find(tool=>tool.name==='hold')!;
  assert.equal((hold.invoke({stack:99}) as any).ok,false);assert.equal((hold.invoke({stack:1}) as any).ok,true);
  assert.deepEqual(worldTools(engine,'t1',memory).find(tool=>tool.name==='hold')!.parameters.properties!.stack.enum,[0,2,3,4,5,6,7,8,9]);
  actor.inventory=null;
  const pickup=worldTools(engine,'t1',memory).find(tool=>tool.name==='pickup')!;
  assert.equal((pickup.invoke({itemId:'arrow'}) as any).ok,false);
  assert.equal((pickup.invoke({itemId:'near-arrow'}) as any).ok,true);
});

test('offered place and bucket targets are executable and shaping points do not reveal recipes',()=>{
  for(const stack of [{kind:'wood',count:1},{kind:'arrow',count:1},{kind:'bucket',count:1},{kind:'bucket',count:1,contents:'sand'},{kind:'bucket',count:1,contents:'water'}]){
    const engine=fixture([[0,1,2,'sand']]);engine.entity('t1').inventory={stacks:[stack],selected:0,capacity:64};
    const targets=engine.observe('t1').interactions;
    for(const action of ['place','fill','empty'] as const){
      assert.equal(worldTools(engine,'t1',{notes:[]}).some(tool=>tool.name===action),targets[action].length>0);
      for(const target of targets[action]){const copy=new Engine(engine.module,engine.state());assert.equal(copy.act('t1',{action,target}).ok,true,`${action} at ${target}`);}
    }
  }
  const engine=fixture();engine.entity('t1').inventory={stacks:[{kind:'wood',count:1}],selected:0,capacity:64};
  const strike=worldTools(engine,'t1',{notes:[]}).find(tool=>tool.name==='strike_held')!;
  assert.doesNotMatch(JSON.stringify({description:strike.description,parameters:strike.parameters}),/bucket|knife|spear|arrow/);
  assert.equal((strike.invoke({point:'top_center'}) as any).ok,true);
  assert.equal(engine.held(engine.entity('t1'))?.kind,'bucket');
  assert.equal(worldTools(engine,'t1',{notes:[]}).some(tool=>tool.name==='strike_held'),false);
});

test('context selects relevant learned facts without forgetting authoritative discoveries',()=>{
  const engine=fixture();engine.entity('t1').position[1]=4;
  const facts=['deep-water-limit','thrown-blocks-settle','wood-shape:bucket'];engine.discoveries.set('t1',new Set(facts));
  assert.deepEqual(relevantKnowledge(engine,engine.observe('t1')),[]);
  engine.entity('t1').inventory={stacks:[{kind:'wood',count:1}],selected:0,capacity:64};
  assert.deepEqual(relevantKnowledge(engine,engine.observe('t1')),['Thrown blocks settle and become part of the terrain.','Strike wood at top_center to make a bucket.']);
  assert.deepEqual([...engine.discoveries.get('t1')!],facts);
});

test('visible cracks take priority over fresh wood and lose attention when unreachable or broken',()=>{
  const engine=fixture([[0,1,2,'wood'],[-1,1,2,'wood'],[1,1,0,'plant']]),memory={notes:[]};
  const before=worldTools(engine,'t1',memory).map(tool=>tool.name);
  assert.equal(engine.act('t1',{action:'hit',target:[1,1,0]}).ok,true);
  const observation=engine.observe('t1'),view=compactView(observation);
  assert.deepEqual(observation.interactions.hit[0].target,[1,1,0]);
  assert.match(view.attention!,/plant block at \[1,1,0\].*visible cracks.*same block/);
  const tools=worldTools(engine,'t1',memory).map(tool=>tool.name);
  assert.equal(tools[0],'hit');assert.deepEqual([...tools].sort(),[...before].sort(),'Attention does not remove other choices.');
  engine.entity('t1').position=[6.5,1,-6.5];assert.equal(compactView(engine.observe('t1')).attention,undefined);
  engine.entity('t1').position=[.5,1,.5];engine.act('t1',{action:'hit',target:[1,1,0]});
  assert.match(compactView(engine.observe('t1')).attention!,/deep cracks.*close to breaking/);
  engine.act('t1',{action:'hit',target:[1,1,0]});engine.act('t1',{action:'store'});
  assert.equal(compactView(engine.observe('t1')).attention,undefined);
});

test('breaking a tree reports its visible collapse along with the collected block',()=>{
  const engine=fixture([[0,1,1,'wood'],[0,2,1,'wood'],[0,3,1,'wood']]);
  engine.entity('t1').position=[.5,1,-.5];
  for(let hit=0;hit<2;hit++)engine.act('t1',{action:'hit',target:[0,1,1]});
  const result=engine.act('t1',{action:'hit',target:[0,1,1]});
  assert.equal(result.ok,true);assert.match(result.message,/pick it up.*unsupported part of the tree falls/);
  assert.equal(engine.bodies.length,2);assert.equal(engine.held(engine.entity('t1'))?.kind,'wood');
});

test('pickup explains visible settling without disclosing a hidden settlement location',()=>{
  const engine=fixture();
  engine.bodies.push({id:'settling',kind:'leaves',position:[.5,1.3,1.5],velocity:[0,0,0],resting:true});
  assert.ok(engine.observe('t1').interactions.pickup.some(item=>item.itemId==='settling'));
  engine.step();
  assert.equal(engine.bodies.length,0);
  const result=engine.act('t1',{action:'pickup',itemId:'settling'});
  assert.equal(result.ok,false);assert.match(result.message,/settled into leaves terrain at block \[0,1,1\].*no longer loose/);
  assert.ok(engine.observe('t1').interactions.hit.some(item=>item.kind==='leaves'));
  for(let y=1;y<=4;y++)engine.voxels.set([0,y,2],'stone');
  engine.voxels.set([0,1,4],'wood');engine.event('world','settled','A loose wood settled into the terrain.',{itemId:'hidden',target:[0,1,4],kind:'wood'});
  const hidden=engine.act('t1',{action:'pickup',itemId:'hidden'});
  assert.equal(hidden.ok,false);assert.match(hidden.message,/Use look/);assert.doesNotMatch(hidden.message,/\[0,1,4\]/);
});
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

test('walking and running are half speed when one block of water reaches half the body',()=>{
  for(const [action,distance,speed] of [['walk',3,1],['run',3,2]] as const){
    const engine=fixture(),actor=engine.entity('t1');
    for(let x=-1;x<=1;x++)for(let z=-1;z<=8;z++){
      engine.voxels.set([x,0,z],null);
      engine.voxels.set([x,-2,z],'stone');
    }
    actor.position=[.5,-1,.5];
    assert.equal(island.manifest.waterLevel-actor.position[1],actor.height/2,'One water block reaches exactly half the Troglodyte height.');
    assert.equal(island.canEnter(actor,actor.position).ok,true);
    assert.equal(island.movementSpeed!(actor,actor.position,speed*2),speed);
    assert.equal(engine.act('t1',{action,distance}).ok,true);
    for(let tick=0;tick<20;tick++)engine.step();
    assert.ok(Math.abs(actor.position[2]-(.5+speed))<1e-8,`${action} should travel ${speed} m in one second at this depth.`);
  }
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
  assert.match(observation.description,/You hold grass/);
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
test('a creature can jump while carrying a raw block and sees why run, hit, and pickup are disabled',()=>{
  const engine=fixture();
  engine.entity('t1').inventory={stacks:[{kind:'stone',count:1}],selected:0,capacity:64};
  assert.equal(engine.act('t1',{action:'jump',distance:2}).ok,true);
  for(let tick=0;tick<20;tick++)engine.step();
  assert.ok(engine.entity('t1').position[2]>=2);
  assert.equal(engine.act('t1',{action:'run',distance:2}).ok,false);
  assert.equal(engine.act('t1',{action:'hit',target:[0,0,3]}).ok,false);
  const names=worldTools(engine,'t1',{notes:[]}).map(tool=>tool.name);
  assert.ok(names.includes('jump'));assert.ok(names.includes('run'));
  for(const action of ['run','hit','pickup']){
    const disabled=worldTools(engine,'t1',{notes:[]}).find(tool=>tool.name===action)!;
    assert.equal(disabled.physical,false);assert.match(disabled.description,/Disabled while you hold stone/);
  }
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
test('striking faces the target and plants become loose stick-shaped items',()=>{
  const engine=fixture([[1,1,0,'plant']]),actor=engine.entity('t1');actor.yaw=270;
  assert.match(engine.act('t1',{action:'hit',target:[1,1,0]}).message,/Thin cracks/);
  assert.equal(actor.yaw,90);
  assert.match(engine.act('t1',{action:'hit',target:[1,1,0]}).message,/cracks spread/);
  assert.match(engine.act('t1',{action:'hit',target:[1,1,0]}).message,/pick up a stick/);
  assert.equal(engine.held(actor)?.kind,'stick');
  assert.equal(engine.act('t1',{action:'place',target:[0,1,1]}).ok,true);
  assert.equal(engine.voxels.get([0,1,1]),undefined);
  assert.equal(engine.bodies[0].kind,'stick');assert.equal(engine.bodies[0].resting,true);
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
test('wood shaping makes five thin planks and a shovel with its one-strike tool behavior',()=>{
  const planks=fixture();planks.entity('t1').inventory={stacks:[{kind:'wood',count:1}],selected:0,capacity:64};
  assert.equal(planks.act('t1',{action:'strike_held',impact:[.5,0,.5]}).ok,true);
  assert.deepEqual(planks.held(planks.entity('t1')),{kind:'plank',count:5});
  assert.match(planks.recentEvents.find(event=>event.type==='discovery')!.message,/five planks/);

  const shovel=fixture([[0,1,1,'sand']]);shovel.entity('t1').inventory={stacks:[{kind:'wood',count:1}],selected:0,capacity:64};
  assert.equal(shovel.act('t1',{action:'strike_held',impact:[0,1,1]}).ok,true);
  assert.equal(shovel.held(shovel.entity('t1'))?.kind,'shovel');
  const dig=worldTools(shovel,'t1',{notes:[]}).find(tool=>tool.name==='dig')!;
  assert.match(dig.description,/sand, dirt, or grass with one shovel strike/);
  const disabledHit=worldTools(shovel,'t1',{notes:[]}).find(tool=>tool.name==='hit')!;
  assert.equal(disabledHit.physical,false);assert.match(disabledHit.description,/Use dig.*sand, dirt, or grass/i);
  assert.equal((dig.invoke({target:[0,1,1]}) as {ok:boolean}).ok,true);
  assert.equal(shovel.voxels.get([0,1,1]),undefined);
  assert.equal(shovel.held(shovel.entity('t1'))?.kind,'shovel');
  assert.equal(shovel.discoveries.get('t1')?.has('blocks-break-after-three-hits'),false);
});
test('shovel prompts consistently expose dig and omit bare-hand advice',()=>{
  const engine=fixture([[0,1,1,'dirt']]),actor=engine.entity('t1');
  actor.inventory={stacks:[{kind:'shovel',count:1}],selected:0,capacity:64};
  engine.blockDamage.set('0,1,1',2);engine.discoveries.set('t1',new Set(['blocks-break-after-three-hits']));
  const observation=engine.observe('t1'),view=compactView(observation);
  assert.ok(view.interactions.dig);assert.equal(view.interactions.hit,undefined);
  assert.match(view.attention!,/Use dig/);assert.doesNotMatch(view.attention!,/Try hit/);
  assert.deepEqual(relevantKnowledge(engine,observation),[]);
  assert.ok(observation.navigation.paths.find(path=>path.turn===0)?.options?.includes('dig'));
  const tool=worldTools(engine,'t1',{notes:[]}).find(tool=>tool.name==='dig')!;
  assert.equal((tool.invoke({target:[0,1,1]}) as {ok:boolean}).ok,true);
  assert.equal(recentActions(engine.recentEvents).at(-1)!.action,'dig');
});
test('wood transformation preserves resources when five output pieces do not fit',()=>{
  const engine=fixture(),actor=engine.entity('t1');
  actor.inventory={stacks:[{kind:'wood',count:1},{kind:'plank',count:60}],selected:0,capacity:640};
  const before=structuredClone(actor.inventory);
  assert.equal(engine.act('t1',{action:'strike_held',impact:[.5,0,.5]}).ok,false);
  assert.deepEqual(actor.inventory,before);assert.equal(engine.discoveries.get('t1'),undefined);
  actor.inventory!.stacks[1].count=59;
  assert.equal(engine.act('t1',{action:'strike_held',impact:[.5,0,.5]}).ok,true);
  assert.equal(actor.inventory!.stacks.reduce((sum,stack)=>sum+stack.count,0),64);
  assert.equal(engine.held(actor)?.count,64);
});
test('the last twenty recorded actions retain final movement outcomes and callable shaping arguments',()=>{
  const engine=fixture(),store=new Store(':memory:',engine.module.manifest);
  try{
    for(let index=0;index<24;index++)engine.act('t1',{action:'wait'});
    engine.act('t1',{action:'walk',distance:2});
    for(let tick=0;tick<20;tick++)engine.step();
    store.record(engine.frame(),engine.state());
    const started=recentActions(store.actionEventsAt(0,'t1')),completed=recentActions(store.actionEventsAt(20,'t1'));
    assert.equal(completed.length,20);assert.match(started.at(-1)!.result.message,/start walking/);
    assert.match(completed.at(-1)!.result.message,/finish walking/);assert.deepEqual(completed.at(-1)!.args,{distance:2});
    assert.deepEqual(store.actionEventsAt(20,'someone-else'),[]);
    engine.entity('t1').inventory={stacks:[{kind:'wood',count:1}],selected:0,capacity:64};
    engine.act('t1',{action:'strike_held',impact:[.5,1,.5]});store.record(engine.frame());
    const shaping=recentActions(store.actionEventsAt(20,'t1')).at(-1)!;
    assert.deepEqual(shaping.args,{point:'top_center'});assert.equal(shaping.action,'strike_held');
  }finally{store.close();}
});
test('recorded movement distinguishes partial progress from a rejected move that changes facing',()=>{
  const engine=fixture([[0,1,2,'stone']]),store=new Store(':memory:',engine.module.manifest);
  try{
    assert.equal(engine.act('t1',{action:'walk',distance:4}).ok,true);
    for(let tick=0;tick<40;tick++)engine.step();
    const end=rounded(engine.entity('t1').position);
    assert.ok(end[2]>.5);store.record(engine.frame(),engine.state());
    const entry=recentActions(store.actionEventsAt(engine.tick,'t1')).at(-1)!;
    assert.equal(entry.result.outcome,'partial');assert.deepEqual(entry.result.from,[.5,1,.5]);assert.deepEqual(entry.result.to,end);
    assert.equal(compactResult(engine.entity('t1').lastAction!).outcome,'partial');

    engine.entity('t1').yaw=90;
    const rejected=engine.act('t1',{action:'walk',distance:1,angle:-90});
    assert.equal(rejected.ok,false);store.record(engine.frame());
    const failure=recentActions(store.actionEventsAt(engine.tick,'t1')).at(-1)!;
    assert.equal(failure.result.outcome,'rejected');assert.equal(failure.result.facing,0);
    assert.deepEqual(rounded(engine.entity('t1').position),end);
  }finally{store.close();}
});
test('speech decisions update the original recorded walk without inventing another physical action',()=>{
  for(const choice of ['continue_moving','stop_moving'] as const){
    const engine=fixture([],[entity(),entity('t2',2.5,.5)]),store=new Store(':memory:',engine.module.manifest);
    try{
      engine.act('t1',{action:'walk',distance:3});
      for(let tick=0;tick<5;tick++)engine.step();
      engine.act('t2',{action:'say',word:'Come here'});engine.wakeMovingListenersFromSpeech();
      store.record(engine.frame(),engine.state());
      engine.resolveMovementPrompt('t1',choice);store.record(engine.frame());
      const reacted=recentActions(store.actionEventsAt(engine.tick,'t1'));
      assert.equal(reacted.length,1);assert.equal(reacted[0].reaction?.choice,choice);
      assert.equal(reacted[0].result.outcome,choice==='stop_moving'?'stopped':'started');
      for(let tick=0;tick<40;tick++)engine.step();store.record(engine.frame());
      const final=recentActions(store.actionEventsAt(engine.tick,'t1'))[0];
      assert.equal(final.reaction?.choice,choice);assert.equal(final.result.outcome,choice==='stop_moving'?'stopped':'completed');
      assert.deepEqual(final.result.from,[.5,1,.5]);assert.deepEqual(final.result.to,rounded(engine.entity('t1').position));
    }finally{store.close();}
  }
});
test('front-edge wood strikes make chosen door halves which join into one rustic door',()=>{
  const engine=fixture();engine.entity('t1').inventory={stacks:[{kind:'wood',count:2}],selected:0,capacity:64};
  assert.equal(engine.act('t1',{action:'strike_held',impact:[0,.5,1]}).ok,false);
  assert.match(engine.act('t1',{action:'strike_held',impact:[0,.5,1],orientation:'up'}).message,/upper/);
  const woodIndex=engine.entity('t1').inventory!.stacks.findIndex(stack=>stack.kind==='wood');
  assert.equal(engine.act('t1',{action:'hold',stack:woodIndex}).ok,true);
  assert.match(engine.act('t1',{action:'strike_held',impact:[0,.5,1],orientation:'down'}).message,/lower/);
  const join=worldTools(engine,'t1',{notes:[]}).find(tool=>tool.name==='join');assert.ok(join);
  assert.equal(engine.act('t1',{action:'join'}).ok,true);
  assert.equal(engine.held(engine.entity('t1'))?.kind,'door');
});
test('bucket stacks split and merge by contents while dirt filling conserves one world block',()=>{
  const engine=fixture([[1,1,0,'dirt']]);
  engine.entity('t1').inventory={stacks:[{kind:'bucket',count:64}],selected:0,capacity:640};
  const before=engine.voxels.cells.size;
  assert.equal(engine.act('t1',{action:'fill',target:[1,1,0]}).ok,true);
  assert.equal(engine.voxels.cells.size,before-1);
  assert.deepEqual(engine.entity('t1').inventory!.stacks,[{kind:'bucket',count:63},{kind:'bucket',count:1,contents:'dirt'}]);
  assert.equal(engine.held(engine.entity('t1'))?.contents,'dirt');
  assert.equal(engine.act('t1',{action:'empty',target:[1,1,0]}).ok,true);
  assert.equal(engine.voxels.cells.size,before);
  assert.deepEqual(engine.entity('t1').inventory!.stacks,[{kind:'bucket',count:64}]);
});
test('ten distinct stacks admit matching items up to sixty-four and reject an eleventh kind',()=>{
  const kinds=['grass','dirt','sand','stone','wood','leaves','stick','bucket','plank','spear'];
  const inventory={stacks:kinds.map(kind=>({kind,count:64})),selected:null,capacity:640};
  assert.equal(exchangeInventory(inventory,[],[{kind:'knife',count:1}]),undefined);
  assert.equal(exchangeInventory(inventory,[],[{kind:'wood',count:1}]),undefined);
  inventory.stacks[4].count=63;
  const toppedUp=exchangeInventory(inventory,[],[{kind:'wood',count:1}]);
  assert.equal(toppedUp?.stacks.length,10);assert.equal(toppedUp?.stacks[4].count,64);
  assert.equal(inventory.stacks[4].count,63,'Capacity planning never mutates the source.');
  assert.equal(exchangeInventory({stacks:[{kind:'wood',count:64}],selected:0,capacity:640},[],[{kind:'wood',count:1}]),undefined,'A full kind cannot spill into a second stack.');
});

test('full inventory rejects bucket splitting and crafting atomically but permits slot reuse',()=>{
  const engine=fixture([[1,1,0,'sand']]),actor=engine.entity('t1');
  const other=['grass','dirt','stone','wood','leaves','stick','plank','spear','knife'].map(kind=>({kind,count:2}));
  actor.inventory={stacks:[{kind:'bucket',count:2},...other],selected:0,capacity:640};
  const before=structuredClone(actor.inventory);
  assert.equal(engine.act('t1',{action:'fill',target:[1,1,0]}).ok,false);
  assert.deepEqual(actor.inventory,before);assert.equal(engine.voxels.get([1,1,0]),'sand');
  assert.deepEqual(engine.observe('t1').interactions.fill,[]);
  actor.inventory!.stacks[0].count=1;
  assert.equal(engine.act('t1',{action:'fill',target:[1,1,0]}).ok,true);
  assert.equal(actor.inventory!.stacks.length,10);assert.equal(engine.held(actor)?.contents,'sand');
  actor.inventory!.selected=actor.inventory!.stacks.findIndex(stack=>stack.kind==='wood');
  const unchanged=structuredClone(actor.inventory);
  assert.equal(engine.act('t1',{action:'strike_held',impact:[.5,1,.5]}).ok,false);
  assert.deepEqual(actor.inventory,unchanged);
  actor.inventory!.stacks[actor.inventory!.selected!].count=1;
  assert.equal(engine.act('t1',{action:'strike_held',impact:[.5,1,.5]}).ok,true);
  assert.equal(actor.inventory!.stacks.length,10);assert.equal(engine.held(actor)?.contents,undefined);
});

test('bucket emptying and door joining preserve resources when their result cannot fit',()=>{
  const engine=fixture(),actor=engine.entity('t1');
  const other=['grass','dirt','stone','wood','leaves','stick','plank','spear','knife'].map(kind=>({kind,count:2}));
  actor.inventory={stacks:[{kind:'bucket',count:2,contents:'sand'},...other],selected:0,capacity:640};
  const before=structuredClone(actor.inventory);
  assert.equal(engine.act('t1',{action:'empty',target:[1,1,0]}).ok,false);
  assert.deepEqual(actor.inventory,before);assert.equal(engine.voxels.get([1,1,0]),undefined);
  actor.inventory={stacks:[{kind:'door_half_up',count:2},{kind:'door_half_down',count:2},...other.slice(0,8)],selected:0,capacity:640};
  const halves=structuredClone(actor.inventory);
  assert.equal(engine.act('t1',{action:'join'}).ok,false);assert.deepEqual(actor.inventory,halves);
  actor.inventory.stacks[0].count=1;
  assert.equal(engine.act('t1',{action:'join'}).ok,true);assert.equal(engine.held(actor)?.kind,'door');
});

test('resuming merges legacy bucket stacks by contents and preserves the selected kind',()=>{
  const actor=entity();actor.inventory={stacks:[{kind:'bucket',count:1},{kind:'bucket',count:2,water:true},{kind:'bucket',count:3},{kind:'bucket',count:1,contents:'water'}],selected:3,capacity:64};
  const engine=fixture([],[actor]);
  assert.deepEqual(engine.entity('t1').inventory,{stacks:[{kind:'bucket',count:4},{kind:'bucket',count:3,contents:'water'}],selected:1,capacity:640});
});

test('resuming converts legacy carried and loose plants into sticks',()=>{
  const actor=entity();actor.inventory={stacks:[{kind:'plant',count:2}],selected:0,capacity:64};
  const engine=fixture([],[actor]),state=engine.state();
  assert.deepEqual(engine.held(engine.entity('t1')),{kind:'stick',count:2});
  state.bodies.push({id:'legacy-plant',kind:'plant',position:[1.5,1.5,1.5],velocity:[0,0,0],resting:true});
  const resumed=new Engine(engine.module,state);
  assert.equal(resumed.bodies[0].kind,'stick');
});

test('supporting blocks reject damage with a clear creature-specific error',()=>{
  const engine=fixture([], [entity(),entity('t2',1.5,.5)]);
  const result=engine.act('t1',{action:'hit',target:[1,0,0]});assert.equal(result.ok,false);assert.match(result.message,/t2 is standing on it/);assert.equal(engine.blockDamage.size,0);
});
test('speech requires vocabulary, clear line of sight and ten-metre range; inbox survives resume', () => {
  const engine = fixture([], [entity(),entity('t2',.5,5.5)]);
  assert.equal(engine.act('t1',{action:'say',word:'hello'}).ok,false);
  assert.equal(engine.act('t1',{action:'say',word:'Follow me'}).ok,true);
  assert.equal(engine.observe('t2').heard.length,1);
  engine.voxels.set([0,2,3],'stone');
  engine.act('t1',{action:'say',word:'Look at this'});
  assert.equal(engine.observe('t2').heard.length,1);
  engine.voxels.set([0,2,3],null); engine.entity('t2').position[2]=11;
  engine.act('t1',{action:'say',word:'Come here'});
  assert.equal(engine.observe('t2').heard.length,1);
  const resumed = new Engine(engine.module,engine.state());
  assert.deepEqual(resumed.observe('t2').heard,engine.observe('t2').heard);
});
test('communication ideas stay hidden until the agent opens say',async()=>{
  const engine=fixture([],[entity(),entity('t2',.5,5.5)]);
  const closed=worldTools(engine,'t1',{notes:[]}).find(tool=>tool.name==='say')!;
  assert.equal(closed.physical,false);assert.deepEqual(closed.parameters.properties,{});
  const serialized=JSON.stringify(closed);for(const idea of speechIdeas)assert.equal(serialized.includes(idea),false);
  const menu=await closed.invoke({}) as {ok:boolean;options:string[]};
  assert.equal(menu.ok,true);assert.deepEqual(menu.options,[...speechIdeas]);
  const opened=worldTools(engine,'t1',{notes:[]},{speechMenu:true}).find(tool=>tool.name==='say')!;
  assert.equal(opened.physical,true);assert.deepEqual(opened.parameters.properties!.word.enum,[...speechIdeas]);
  assert.deepEqual(worldTools(engine,'t1',{notes:[]},{speechMenu:true}).map(tool=>tool.name),['say','do_not_reply']);
});
test('encounters support multiple Troglodytes and animals, persist and emit once until they separate',()=>{
  const second=entity('t2',.5,4.5);second.yaw=180;
  const third=entity('t3',3.5,3.5);third.yaw=225;
  const duck:Entity={...entity('duck',1.5,3.5),kind:'duck',controller:'wander',height:.65};
  const engine=fixture([],[entity(),second,third,duck]),store=new Store(':memory:',engine.module.manifest);
  try{
    store.record(engine.frame(),engine.state());engine.step();store.record(engine.frame());
    const notices=engine.observe('t1').encounters;assert.equal(notices.length,3);assert.ok(notices.every(notice=>notice.canSpeakNow));assert.ok(notices.every(notice=>notice.message.includes('use say')));
    assert.equal(store.eventsAt(1,'t1').filter(event=>event.type==='encounter').length,3);
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
test('agent language and new materials can extend a recording without changing its physical rules',()=>{
  const directory=mkdtempSync(join(tmpdir(),'emergent-material-test-')),path=join(directory,'test.sqlite');
  try{
    const previous=structuredClone(island.manifest);
    previous.materials.bucket.stackLimit=1;
    for(const kind of ['plank','shovel','door_half_up','door_half_down','door'])delete previous.materials[kind];
    new Store(path,previous).close();
    const newLanguage=structuredClone(island.manifest);newLanguage.vocabulary=['A completely new idea'];newLanguage.agentInstructions='New instructions for future decisions.';
    new Store(path,newLanguage).close();
    new Store(path,island.manifest).close();
    const incompatible=structuredClone(island.manifest);incompatible.materials.wood.floats=false;
    assert.throws(()=>new Store(path,incompatible),/Module configuration changed/);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
test('SQLite reconstructs the last ten private memory notes at a recorded instant',()=>{
  const engine=fixture(),store=new Store(':memory:',engine.module.manifest);store.record(engine.frame(),engine.state());
  for(let index=0;index<22;index++)engine.event('t1','memory',`memory ${index}`);store.record(engine.frame());
  assert.deepEqual(store.memoryAt(0,'t1'),Array.from({length:10},(_,index)=>`memory ${index+12}`));store.close();
});
test('running is disabled only while a raw block is in hand, not while stored',()=>{
  const engine=fixture(),memory={notes:[]};
  let run=worldTools(engine,'t1',memory).find(tool=>tool.name==='run')!;assert.equal(run.physical,true);
  engine.entity('t1').inventory={stacks:[{kind:'wood',count:1}],selected:null,capacity:64};
  run=worldTools(engine,'t1',memory).find(tool=>tool.name==='run')!;assert.equal(run.physical,true);
  engine.entity('t1').inventory!.selected=0;
  run=worldTools(engine,'t1',memory).find(tool=>tool.name==='run')!;assert.equal(run.physical,false);assert.match(run.description,/Disabled.*hold wood/i);
  const tick=engine.tick,result=run.invoke({distance:4}) as {ok:boolean;message:string};
  assert.equal(result.ok,false);assert.match(result.message,/store, place, or throw/i);assert.equal(engine.tick,tick);
});
test('the Harness schema guard validates contextual embodied tools', async () => {
  const engine = fixture([[1,1,0,'wood']]), memory = {notes:[] as string[]}, tools=worldTools(engine,'t1',memory);
  assert.deepEqual(tools.map(t=>t.name),['look','find_material','walk','turn','run','jump','hit','wait','journal']);
  const scan=tools.find(tool=>tool.name==='find_material')!.invoke({}) as any;
  assert.equal(scan.ok,true);assert.ok(scan.feedback.materials.some((item:any)=>item.material==='wood'&&Number.isFinite(item.bodyRelativeDegrees)&&Number.isFinite(item.directionXZ.x)&&Number.isFinite(item.directionXZ.z)));
  assert.equal(engine.entity('t1').motion?.kind,'scan');for(let tick=0;tick<20;tick++)engine.step();assert.equal(engine.entity('t1').motion,undefined);
  const invalid = await tools.find(tool=>tool.name==='walk')!.execute({distance:'8'}) as {ok:boolean};
  assert.equal(invalid.ok,false);
  const journal=tools.find(tool=>tool.name==='journal')!;for(let i=0;i<10;i++)await journal.execute({note:`note ${i}`});
  const before=[...memory.notes];
  assert.equal((await journal.execute({note:'new goal'}) as {ok:boolean}).ok,false);
  assert.deepEqual(memory.notes,before,'Without a compactor, existing notes must never be silently dropped.');
  await journal.execute({note:'note 9'});assert.equal(memory.notes.length,10,'Duplicate private notes must not be stored twice.');
  engine.discoveries.set('t1',new Set(['thrown-blocks-settle']));await journal.execute({note:'Thrown blocks settle and become part of the terrain.'});assert.equal(memory.notes.length,10,'Learned knowledge must not be duplicated as a private note.');
  let registered=0; apply({tools:{register(tool){assert.equal(typeof tool.output.render,'function');registered++;return()=>{};}}},{engine,entityId:'t1',memory});
  assert.equal(registered,tools.length);
  for(let hit=0;hit<3;hit++)engine.act('t1',{action:'hit',target:[1,1,0]});
  const carrying=worldTools(engine,'t1',memory).map(tool=>tool.name);
  assert.ok(carrying.includes('strike_held'));assert.ok(carrying.includes('hit'));assert.ok(carrying.includes('pickup'));assert.ok(carrying.includes('run'));
  for(const action of ['run','hit','pickup'])assert.equal(worldTools(engine,'t1',memory).find(tool=>tool.name===action)!.physical,false);
});
