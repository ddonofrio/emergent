import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactJournal } from '../server/agents/journal-compaction';
import { journalReminder, type JournalSchedule } from '../server/agents/journal';
import type { CompletionResult } from '../server/agents/providers';

const notes=Array.from({length:10},(_,i)=>`Goal ${i}: return to the shore.`);
const response=(notes:unknown):CompletionResult=>({provider:'stub',providerName:'Stub',model:'stub',content:null,calls:[{id:'compact',type:'function',function:{name:'submit_journal',arguments:JSON.stringify({notes})}}]});

test('compaction retries outages and invalid output without changing source notes',async()=>{
  const source=[...notes],controller=new AbortController();let calls=0;
  const result=await compactJournal({name:'Moss',notes:source,incoming:'Build a shelter.',signal:controller.signal,retryDelayMs:1,waiting(){},
    async complete(request){
      assert.deepEqual(source,notes);
      assert.deepEqual((request.tools as any[]).map(tool=>tool.function.name),['submit_journal']);
      const system=(request.messages[0] as any).content;
      assert.match(system,/permanently forgotten/);assert.match(system,/Do not invent/);
      const context=JSON.parse((request.messages[1] as any).content);assert.deepEqual(context.journal,notes);
      if(++calls===1)throw new Error('Offline');
      if(calls===2)return response([...notes,'An eleventh entry.']);
      if(calls===3)return response(Array(9).fill('Repeated note'));
      if(calls===4)return response(['Build a shelter.',...notes.slice(0,8)]);
      return response(['Goals 0 and 1: return to the shore.',...notes.slice(2)]);
    }});
  assert.equal(calls,5);assert.equal(result.length,9);assert.deepEqual(source,notes);
});

test('compaction accepts fewer notes and drops only the oldest when ten are returned',async()=>{
  for(const count of [0,1,6,9,10]){
    let calls=0;
    const result=await compactJournal({name:'Moss',notes,incoming:'Build a shelter.',signal:new AbortController().signal,waiting(){},
      async complete(){calls++;return response(notes.slice(0,count));}});
    assert.equal(calls,1);assert.deepEqual(result,notes.slice(0,count).slice(-9));
  }
});

test('unavailable journal compaction is cancellable and retains all notes',async()=>{
  const controller=new AbortController(),source=[...notes];let attempts=0;
  await assert.rejects(compactJournal({name:'Moss',notes:source,incoming:'Build a shelter.',signal:controller.signal,retryDelayMs:1,
    waiting(){if(++attempts===3)controller.abort();},async complete(){throw new Error('Offline');}}),{name:'AbortError'});
  assert.deepEqual(source,notes);assert.equal(attempts,3);
});

test('empty journal reminders span ten to twenty decisions; populated journals use fifty',()=>{
  for(const [random,interval] of [[0,10],[.999,20]]){
    const mind:JournalSchedule={notes:[],turns:1};assert.equal(journalReminder(mind,()=>random),undefined);
    assert.equal(mind.nextJournalPromptTurn,interval);
    mind.turns=interval-1;assert.equal(journalReminder(mind,()=>random),undefined);
    mind.turns++;assert.match(journalReminder(mind,()=>random)!,/keep exploring/);
    assert.equal(mind.nextJournalPromptTurn,interval*2);
    mind.notes=['Build a shelter.'];mind.turns=interval*2;
    assert.match(journalReminder(mind,()=>random)!,/skip it if nothing meaningful changed/);
    assert.equal(mind.nextJournalPromptTurn,mind.turns+50);
  }
});
