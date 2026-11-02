import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Engine } from '../src/core/engine';
import { robotsVsRobots } from '../src/universes/robots-vs-robots';
import { Store } from '../server/store';

test('Robots vs Robots starts with Pebble and MIN-01 on unbounded procedural terrain',()=>{
  const engine=new Engine(robotsVsRobots);
  assert.equal(engine.module.manifest.infiniteHorizontal,true);
  assert.deepEqual(engine.entities.map(entity=>({id:entity.id,name:entity.name,kind:entity.kind,controller:entity.controller,position:entity.position,height:entity.height})),[
    {id:'duck',name:'Pebble',kind:'duck',controller:'wander',position:[.5,1,.5],height:.65},
    {id:'min-01',name:'MIN-01',kind:'miner-robot',controller:'agent',position:[10.5,1,.5],height:1.4},
  ]);
  assert.equal(engine.entity('min-01').position[0]-engine.entity('duck').position[0],10);
  assert.equal(engine.voxels.get([0,0,0]),'grass');
  assert.equal(engine.voxels.get([10_000_000,-1,-10_000_000]),'dirt');
  assert.equal(engine.voxels.get([-10_000_000,-12,10_000_000]),'stone');
  assert.equal(engine.inside([Number.MAX_SAFE_INTEGER,1,-Number.MAX_SAFE_INTEGER]),true);
});

test('an existing Robots vs Robots world receives MIN-01 once beside Pebble',()=>{
  const state=new Engine(robotsVsRobots).state();
  state.entities=state.entities.filter(entity=>entity.id!=='min-01');
  state.entities[0].position=[4.5,1,-3.5];
  const migration=robotsVsRobots.migrateState!(state)!;
  assert.deepEqual(migration.state.entities.find(entity=>entity.id==='min-01')?.position,[14.5,1,-3.5]);
  assert.equal(migration.state.entities.find(entity=>entity.id==='min-01')?.controller,'agent');
  assert.deepEqual(migration.events,[{
    actor:'min-01',type:'entity-arrival',message:"MIN-01 joined the world ten metres to Pebble's right.",data:{position:[14.5,1,-3.5],relativeTo:'duck'},
  }]);
  assert.equal(robotsVsRobots.migrateState!(migration.state),undefined);
});

test('procedural terrain edits survive a state round trip',()=>{
  const engine=new Engine(robotsVsRobots);
  engine.voxels.set([0,0,0],null);
  const restored=new Engine(robotsVsRobots,engine.state());
  assert.equal(restored.voxels.get([0,0,0]),undefined);
  assert.equal(restored.voxels.get([1,0,0]),'grass');
});

test('procedural terrain removals are reconstructed from recorded frames',()=>{
  const engine=new Engine(robotsVsRobots),store=new Store(':memory:',robotsVsRobots.manifest);
  store.record(engine.frame(),engine.state());
  engine.step();engine.voxels.set([4,0,-7],null);store.record(engine.frame());
  const restored=new Engine(robotsVsRobots,store.stateAt(engine.tick));store.close();
  assert.equal(restored.voxels.get([4,0,-7]),undefined);
  assert.equal(restored.voxels.get([5,0,-7]),'grass');
});
