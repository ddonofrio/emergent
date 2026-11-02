import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadUniverse, universeCatalog } from '../src/universes';

test('the launcher catalog exposes independent universes',()=>{
  assert.deepEqual(universeCatalog.map(universe=>({id:universe.id,name:universe.name,available:universe.available,observerLayout:universe.observerLayout})),[
    {id:'first-shore',name:'First Shore',available:true,observerLayout:'full'},
    {id:'robots-vs-robots',name:'Robots vs Robots',available:true,observerLayout:'world-only'},
  ]);
  assert.equal(loadUniverse('first-shore').manifest.name,'First Shore');
  assert.equal(loadUniverse('robots-vs-robots').manifest.name,'Robots vs Robots');
  assert.throws(()=>loadUniverse('unknown'),/Unknown universe/);
});
