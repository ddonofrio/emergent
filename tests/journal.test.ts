import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactJournal } from '../server/agents/journal-compaction';
import type { CompletionResult } from '../server/agents/providers';
import { Engine } from '../src/core/engine';
import { island } from '../src/modules/island';
import { worldTools, type Memory } from '../server/agents/tools';
import { journalEntries, setJournalNotes } from '../server/agents/journal';
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '../vendor/deepseek-harness/json-schema';

const notes=Array.from({length:10},(_,i)=>`Goal ${i}: return to the shore.`);
const response=(notes:unknown):CompletionResult=>({provider:'stub',providerName:'Stub',model:'stub',content:null,calls:[{id:'compact',type:'function',function:{name:'submit_journal',arguments:JSON.stringify({notes})}}]});

test('stable note IDs correct multiple claims without renumbering unrelated memories or reusing retired IDs',async()=>{
  const engine=new Engine(island),memory:Memory={notes:['Height uses z.','Moss is at [14,7,9].','The shore is useful.']};
  assert.deepEqual(journalEntries(memory).map(entry=>entry.id),['note-1','note-2','note-3']);
  const journal=worldTools(engine,'t1',memory).find(tool=>tool.name==='journal')!;
  const first=await journal.invoke({note:'Y is height.',replaceNoteIds:['note-1']}) as {ok:boolean};assert.equal(first.ok,true);
  assert.deepEqual(memory.noteIds,['note-2','note-3','note-4']);
  const second=await journal.invoke({note:'Moss is elsewhere; y is height.',replaceNoteIds:['note-2','note-4']}) as {ok:boolean};assert.equal(second.ok,true);
  assert.deepEqual(memory.noteIds,['note-3','note-5']);assert.equal(memory.notes[0],'The shore is useful.');
  const restored=structuredClone(memory),before=structuredClone(memory);
  assert.equal((await journal.invoke({note:'Wrong reference.',replaceNoteIds:['note-1']}) as {ok:boolean}).ok,false);
  assert.deepEqual(memory,before);
  setJournalNotes(restored,['The shore is useful.','Combined finding.']);
  assert.deepEqual(restored.noteIds,['note-3','note-6']);
});

test('journal and goal reasons accept 500 characters and reject excess with precise feedback',async()=>{
  const engine=new Engine(island),memory:Memory={notes:[]};let closed=false;
  const tools=worldTools(engine,'t1',memory,{onFinishGoal:()=>{closed=true;return {ok:true};}});
  const journal=tools.find(tool=>tool.name==='journal')!,finish=tools.find(tool=>tool.name==='finish_goal')!;
  assert.equal((await journal.invoke({note:'a'.repeat(500)}) as {ok:boolean}).ok,true);
  const rejected=await journal.invoke({note:'b'.repeat(501)}) as {ok:boolean;message:string};
  assert.equal(rejected.ok,false);assert.match(rejected.message,/501 characters; maximum 500/);assert.equal(memory.notes.length,1);
  assert.equal((finish.invoke({outcome:'blocked',reason:'c'.repeat(501)}) as {ok:boolean}).ok,false);assert.equal(closed,false);
  assert.equal((finish.invoke({outcome:'blocked',reason:'c'.repeat(500)}) as {ok:boolean}).ok,true);assert.equal(closed,true);
  assert.throws(()=>assertSupportedJsonSchema({type:'number',maxLength:500}));
  assert.throws(()=>assertSupportedJsonSchema({type:'string',minLength:2,maxLength:1}));
  assert.throws(()=>assertSupportedJsonSchema({type:'string',maxLength:-1}));
  assert.deepEqual(validateJsonSchemaValue({type:'string',maxLength:1},'\u{10400}'),[]);
});

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

test('compaction accepts fewer notes and rejects ten without silently losing the oldest',async()=>{
  for(const count of [0,1,6,9]){
    let calls=0;
    const result=await compactJournal({name:'Moss',notes,incoming:'Build a shelter.',signal:new AbortController().signal,waiting(){},
      async complete(){calls++;return response(notes.slice(0,count));}});
    assert.equal(calls,1);assert.deepEqual(result,notes.slice(0,count).slice(-9));
  }
  let calls=0;
  const result=await compactJournal({name:'Moss',notes,incoming:'New observation.',signal:AbortSignal.timeout(2000),retryDelayMs:1,waiting(){},
    async complete(){return response(++calls===1?notes:[notes[0]+' '+notes[1],...notes.slice(2)]);}});
  assert.equal(calls,2);assert.ok(result[0].includes(notes[0]));assert.deepEqual(notes,Array.from({length:10},(_,i)=>`Goal ${i}: return to the shore.`));
});

test('unavailable journal compaction is cancellable and retains all notes',async()=>{
  const controller=new AbortController(),source=[...notes];let attempts=0;
  await assert.rejects(compactJournal({name:'Moss',notes:source,incoming:'Build a shelter.',signal:controller.signal,retryDelayMs:1,
    waiting(){if(++attempts===3)controller.abort();},async complete(){throw new Error('Offline');}}),{name:'AbortError'});
  assert.deepEqual(source,notes);assert.equal(attempts,3);
});
