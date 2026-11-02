import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Engine } from '../src/core/engine';
import { terrainColumn } from '../src/core/procedural-terrain';
import type { Entity, NoiseTerrain } from '../src/core/types';
import { robotsVsRobots } from '../src/universes/robots-vs-robots';
import { Store } from '../server/store';

const terrain=robotsVsRobots.manifest.terrain as NoiseTerrain,seed=robotsVsRobots.manifest.seed;
const isolate=(engine:Engine,id:string)=>{for(const entity of engine.entities)if(entity.id!==id)engine.setEntityEnabled(entity.id,false);engine.frame();};

test('new worlds form front-facing base, lithium-battery, and nuclear-reactor rows',()=>{
  const engine=new Engine(robotsVsRobots);
  assert.equal(engine.module.manifest.infiniteHorizontal,true);
  assert.deepEqual(engine.entities.map(entity=>({id:entity.id,position:entity.position,yaw:entity.yaw,powerModule:entity.appearance?.powerModule})),[
    {id:'min-01',position:[-2.22,5,.5],yaw:0,powerModule:undefined},
    {id:'min-02',position:[.5,5,.5],yaw:0,powerModule:undefined},
    {id:'min-03',position:[3.06,5,.5],yaw:0,powerModule:undefined},
    {id:'min-01bt',position:[-2.22,5,-2.22],yaw:0,powerModule:'lithium-battery'},
    {id:'min-02bt',position:[.5,5,-2.22],yaw:0,powerModule:'lithium-battery'},
    {id:'min-03bt',position:[3.06,5,-2.22],yaw:0,powerModule:'lithium-battery'},
    {id:'min-01nr',position:[-2.22,5,-4.94],yaw:0,powerModule:'nuclear-reactor'},
    {id:'min-02nr',position:[.5,5,-4.94],yaw:0,powerModule:'nuclear-reactor'},
    {id:'min-03nr',position:[3.06,5,-4.94],yaw:0,powerModule:'nuclear-reactor'},
  ]);
  const clearance=(left:Entity,right:Entity)=>Math.hypot(right.position[0]-left.position[0],right.position[2]-left.position[2])-left.hitbox!.radius-right.hitbox!.radius;
  const adjacent=[
    ['min-01','min-02'],['min-02','min-03'],['min-01bt','min-02bt'],['min-02bt','min-03bt'],['min-01nr','min-02nr'],['min-02nr','min-03nr'],
    ['min-01','min-01bt'],['min-02','min-02bt'],['min-03','min-03bt'],['min-01bt','min-01nr'],['min-02bt','min-02nr'],['min-03bt','min-03nr'],
  ];
  assert.ok(adjacent.every(([left,right])=>clearance(engine.entity(left),engine.entity(right))>=1-1e-9));
  assert.equal(engine.entity('min-02').color,'#c4cbcd');
  assert.deepEqual(engine.entity('min-01').hitbox,{radius:.86,height:2.86,terrainRadius:.86});
  assert.deepEqual(engine.entity('min-01bt').appearance,{material:'iron',powerModule:'lithium-battery'});
  assert.deepEqual(engine.entity('min-02bt').appearance,{material:'steel',powerModule:'lithium-battery'});
  assert.deepEqual(engine.entity('min-03nr').appearance,{material:'titanium',widthScale:.82,metalness:.99,roughness:.16,powerModule:'nuclear-reactor'});
  assert.deepEqual(engine.entity('min-03').hitbox,{radius:.7,height:2.86,terrainRadius:.7});
  assert.deepEqual(engine.entity('min-03').appearance,{material:'titanium',widthScale:.82,metalness:.99,roughness:.16});
  assert.equal(engine.voxels.get([0,4,0]),'grass');
  assert.equal(engine.voxels.get([0,-32,0]),'bedrock');
  assert.equal(robotsVsRobots.manifest.materials.bedrock.breakable,false);
  assert.equal(engine.inside([Number.MAX_SAFE_INTEGER,1,-Number.MAX_SAFE_INTEGER]),true);
});

test('noise terrain contains mountains, dry dunes, rivers, and weighted ore clusters',()=>{
  const engine=new Engine(robotsVsRobots),ores=new Map<string,number>();let minimum=Infinity,maximum=-Infinity,rivers=0,drySand=0,highestDune=-Infinity;
  for(let x=-512;x<=512;x+=4)for(let z=-512;z<=512;z+=4){
    const column=terrainColumn(terrain,seed,x,z);minimum=Math.min(minimum,column.top);maximum=Math.max(maximum,column.top);
    if(column.top<=terrain.waterLevel)rivers++;else if(column.surface==='sand'){drySand++;highestDune=Math.max(highestDune,column.top);}
  }
  for(let x=-160;x<=160;x+=4)for(let z=-160;z<=160;z+=4){
    const top=terrainColumn(terrain,seed,x,z).top;
    for(let y=-31;y<=Math.min(10,top-3);y++){const kind=engine.voxels.get([x,y,z]);if(kind&&terrain.ores.some(ore=>ore.kind===kind))ores.set(kind,(ores.get(kind)??0)+1);}
  }
  assert.ok(maximum>=30&&minimum<=terrain.waterLevel,'terrain should contain mountains and river beds');
  assert.ok(rivers>100&&drySand>100&&highestDune>=10,'rivers and raised dry dunes should both occur');
  const common=['iron_ore','copper_ore','quartz','coal'].map(kind=>ores.get(kind)??0),rare=['lithium_ore','titanium_ore'].map(kind=>ores.get(kind)??0);
  assert.ok(rare.every(count=>count>0));assert.ok(Math.min(...common)>Math.max(...rare),'common ores should be substantially more frequent than lithium and titanium');
});

test('bedrock is exposed as permanent terrain and cannot be struck',()=>{
  const generated=robotsVsRobots.generate(),robot={...generated.entities.find(entity=>entity.id==='min-01')!,position:[.5,1,.5] as [number,number,number]};
  const module={...robotsVsRobots,manifest:{...robotsVsRobots.manifest,waterLevel:-32,terrain:{type:'layers' as const,top:0,layers:[{min:0,kind:'bedrock'}]}},generate:()=>({blocks:[],entities:[robot]})};
  const engine=new Engine(module),result=engine.act('min-01',{action:'hit',target:[0,0,0]},'manual');
  assert.equal(result.ok,false);assert.match(result.message,/permanent/);assert.equal(engine.voxels.get([0,0,0]),'bedrock');assert.equal(engine.blockDamage.size,0);
});

test('existing worlds migrate once into the nine-robot three-row formation',()=>{
  const engine=new Engine(robotsVsRobots),state=engine.state(),robot=state.entities.find(entity=>entity.id==='min-01')!;
  robot.controller='agent';robot.status='planning';robot.height=1.4;robot.hitbox={radius:.43,height:1.4};robot.motion={kind:'walk',origin:[...robot.position],destination:[12.5,5,.5],speed:2};
  robot.lastAction={ok:true,message:'Legacy action.'};
  const duck:Entity={...state.entities[1],id:'duck',name:'Pebble',kind:'duck',controller:'wander',position:[.5,5,.5],height:.65,hitbox:{radius:.24,height:.65},color:'#f3e6bb'};delete duck.appearance;
  state.entities=[duck,...state.entities.filter(entity=>['min-01','min-02','min-03'].includes(entity.id))];
  const migration=robotsVsRobots.migrateState!(state)!,migrated=migration.state.entities.find(entity=>entity.id==='min-01')!;
  assert.deepEqual(migration.state.entities.map(entity=>entity.id),['min-01','min-02','min-03','min-01bt','min-02bt','min-03bt','min-01nr','min-02nr','min-03nr']);
  assert.equal(migrated.controller,'static');assert.equal(migrated.status,'idle');assert.equal(migrated.yaw,0);assert.equal(migrated.height,2.86);assert.equal(migrated.hitbox?.height,2.86);assert.equal(migrated.motion,undefined);assert.equal(migrated.lastAction,undefined);
  assert.equal(migration.state.entities.find(entity=>entity.id==='min-01bt')?.appearance?.powerModule,'lithium-battery');
  assert.equal(migration.state.entities.find(entity=>entity.id==='min-03nr')?.appearance?.powerModule,'nuclear-reactor');
  assert.equal(migration.state.entities.find(entity=>entity.id==='min-03')?.appearance?.material,'titanium');assert.equal(migration.events[0].type,'entity-formation');
  assert.equal(robotsVsRobots.migrateState!(migration.state),undefined);
  const restored=new Engine(robotsVsRobots,migration.state),before=[...restored.entity('min-01').position];
  assert.deepEqual(restored.act('min-01',{action:'walk',distance:1}),{ok:false,message:'This entity has no actions.'});
  for(let tick=0;tick<180;tick++)restored.step();
  assert.deepEqual(restored.entity('min-01').position,before);
  assert.equal(restored.act('min-01',{action:'walk',target:[before[0],before[1],before[2]-.5]},'manual').ok,true);
  for(let tick=0;tick<20;tick++)restored.step();
  assert.deepEqual(restored.entity('min-01').position,[before[0],before[1],before[2]-.5]);
});

test('MIN-01 automaton traces a ten-metre square, showcases, reverses, and returns to manual control',()=>{
  const engine=new Engine(robotsVsRobots);isolate(engine,'min-01');
  const origin=[...engine.entity('min-01').position];assert.equal(engine.setEntityControlMode('min-01','automaton'),true);
  assert.deepEqual(engine.act('min-01',{action:'walk',distance:1}),{ok:false,message:'This entity is controlled by its automaton.'});
  let maximumX=origin[0],maximumZ=origin[2],showcase=false,reverse=false;
  for(let tick=0;tick<760;tick++){
    engine.step();const robot=engine.entity('min-01');maximumX=Math.max(maximumX,robot.position[0]);maximumZ=Math.max(maximumZ,robot.position[2]);showcase||=robot.motion?.kind==='showcase';reverse||=robot.motion?.kind==='reverse';
  }
  assert.ok(maximumX>=origin[0]+9.9);assert.ok(maximumZ>=origin[2]+9.9);assert.equal(showcase,true);assert.equal(reverse,true);
  assert.ok(engine.recentEvents.some(event=>event.type==='automaton-display'));
  assert.equal(engine.setEntityControlMode('min-01','manual'),true);const stopped=[...engine.entity('min-01').position];assert.equal(engine.entity('min-01').automation,undefined);
  for(let tick=0;tick<100;tick++)engine.step();assert.deepEqual(engine.entity('min-01').position,stopped);
});

test('MIN-02 shares the miner controls and traces its own square',()=>{
  const engine=new Engine(robotsVsRobots);isolate(engine,'min-02');
  const origin=[...engine.entity('min-02').position];assert.equal(engine.setEntityControlMode('min-02','automaton'),true);
  for(let tick=0;tick<140;tick++)engine.step();
  const robot=engine.entity('min-02');assert.ok(robot.position[2]>=origin[2]+9.9);assert.ok(robot.position[0]>origin[0]);
  assert.equal(engine.setEntityControlMode('min-02','manual'),true);
});

test('the slimmer titanium MIN-03 shares the deterministic controls',()=>{
  const engine=new Engine(robotsVsRobots);isolate(engine,'min-03');
  const origin=[...engine.entity('min-03').position];assert.equal(engine.setEntityControlMode('min-03','automaton'),true);
  for(let tick=0;tick<140;tick++)engine.step();
  assert.ok(engine.entity('min-03').position[2]>=origin[2]+9.9);assert.equal(engine.setEntityControlMode('min-03','manual'),true);
});

test('powered variants preserve their base construction and miner controls',()=>{
  const engine=new Engine(robotsVsRobots);
  for(const stem of ['01','02','03']){
    const base=engine.entity(`min-${stem}`),battery=engine.entity(`min-${stem}bt`),reactor=engine.entity(`min-${stem}nr`);
    assert.equal(battery.appearance?.material,base.appearance?.material);assert.equal(reactor.appearance?.material,base.appearance?.material);
    assert.equal(battery.appearance?.widthScale,base.appearance?.widthScale);assert.equal(reactor.appearance?.widthScale,base.appearance?.widthScale);
    assert.deepEqual(battery.hitbox,base.hitbox);assert.deepEqual(reactor.hitbox,base.hitbox);
    assert.equal(battery.appearance?.powerModule,'lithium-battery');assert.equal(reactor.appearance?.powerModule,'nuclear-reactor');
  }
  isolate(engine,'min-01nr');const origin=[...engine.entity('min-01nr').position];assert.equal(engine.setEntityControlMode('min-01nr','automaton'),true);
  for(let tick=0;tick<140;tick++)engine.step();
  assert.ok(engine.entity('min-01nr').position[2]>=origin[2]+9.9);
});

test('MIN-01 automaton detours around an obstacle and recovers its square route',()=>{
  const generated=robotsVsRobots.generate(),robot=generated.entities.find(entity=>entity.id==='min-01')!,obstacleZ=Math.floor(robot.position[2]+2),module={...robotsVsRobots,generate:()=>({blocks:[[Math.floor(robot.position[0]),robot.position[1],obstacleZ,'stone'] as [number,number,number,string]],entities:[robot]})};
  const engine=new Engine(module),origin=[...engine.entity('min-01').position];engine.setEntityControlMode('min-01','automaton');
  let deviated=false,passed=false;
  for(let tick=0;tick<300;tick++){engine.step();const [x,,z]=engine.entity('min-01').position;deviated||=Math.abs(x-origin[0])>.55;passed||=z>origin[2]+3;}
  assert.equal(deviated,true,'the robot should leave the blocked edge to go around the obstacle');
  assert.equal(passed,true,'the robot should recover its square route beyond the obstacle');
});

test('procedural terrain edits survive a state round trip',()=>{
  const engine=new Engine(robotsVsRobots),top=terrainColumn(terrain,seed,0,0).top;
  engine.voxels.set([0,top,0],null);
  const restored=new Engine(robotsVsRobots,engine.state());
  assert.equal(restored.voxels.get([0,top,0]),undefined);
  assert.equal(restored.voxels.get([1,top,0]),'grass');
});

test('procedural terrain removals are reconstructed from recorded frames',()=>{
  const engine=new Engine(robotsVsRobots),store=new Store(':memory:',robotsVsRobots.manifest);
  store.record(engine.frame(),engine.state());
  const top=terrainColumn(terrain,seed,4,-7).top;engine.step();engine.voxels.set([4,top,-7],null);store.record(engine.frame());
  const restored=new Engine(robotsVsRobots,store.stateAt(engine.tick));store.close();
  assert.equal(restored.voxels.get([4,top,-7]),undefined);
  assert.equal(restored.voxels.get([5,top,-7]),'grass');
});
