import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Engine } from '../src/core/engine';
import { robotsVsRobots } from '../src/universes/robots-vs-robots';
import { Store } from '../server/store';

test('Robots vs Robots starts with only Pebble on unbounded procedural terrain',()=>{
  const engine=new Engine(robotsVsRobots);
  assert.equal(engine.module.manifest.infiniteHorizontal,true);
  assert.deepEqual(engine.entities.map(entity=>({id:entity.id,kind:entity.kind,position:entity.position})),[
    {id:'duck',kind:'duck',position:[.5,1,.5]},
  ]);
  assert.equal(engine.voxels.get([0,0,0]),'grass');
  assert.equal(engine.voxels.get([10_000_000,-1,-10_000_000]),'dirt');
  assert.equal(engine.voxels.get([-10_000_000,-12,10_000_000]),'stone');
  assert.equal(engine.inside([Number.MAX_SAFE_INTEGER,1,-Number.MAX_SAFE_INTEGER]),true);
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
