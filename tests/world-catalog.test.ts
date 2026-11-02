import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModule, worldCatalog } from '../src/modules';

test('the launcher catalog exposes implemented and future worlds separately',()=>{
  assert.deepEqual(worldCatalog.map(world=>({id:world.id,name:world.name,available:world.available})),[
    {id:'first-shore',name:'First Shore',available:true},
    {id:'robots-vs-robots',name:'Robots vs Robots',available:false},
  ]);
  assert.equal(loadModule('first-shore').manifest.name,'First Shore');
  assert.throws(()=>loadModule('robots-vs-robots'),/Unknown world module/);
});
