import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { Store } from '../server/store';
import { island } from '../src/modules/island';
import { auditedCompletion } from '../server/agents/audit';
import type { CompletionRequest, CompletionResult } from '../server/agents/providers';

for(const outcome of ['completed','failed','cancelled'] as const)test(`inference timing is recorded for ${outcome} requests without entering model data`,async()=>{
  const store=new Store(':memory:',island.manifest),controller=new AbortController();
  const request:CompletionRequest={messages:[],tools:[],max_tokens:10};
  const answer:CompletionResult={provider:'stub',providerName:'Stub',model:'stub',content:null,calls:[]};
  try{
    const completion=auditedCompletion(store,40,'t1','planning',request,controller.signal,async()=>{
      if(outcome==='cancelled'){controller.abort();throw controller.signal.reason;}
      if(outcome==='failed')throw new Error('Private transport diagnostics.');
      return answer;
    });
    if(outcome==='completed')assert.equal(await completion,answer);
    else await assert.rejects(completion);
    const row=store.db.prepare('SELECT tick,actor,phase,status,request,response FROM inference_audit').get()!;
    assert.equal(row.tick,40);assert.equal(row.actor,'t1');assert.equal(row.phase,'planning');assert.equal(row.status,outcome);
    assert.deepEqual(JSON.parse(inflateSync(row.request as Uint8Array).toString()),request);
    const {timing,...recorded}=JSON.parse(inflateSync(row.response as Uint8Array).toString());
    assert.ok(Number.isFinite(Date.parse(timing.startedAt)));
    assert.ok(Date.parse(timing.finishedAt)>=Date.parse(timing.startedAt));
    assert.ok(Number.isInteger(timing.durationMs)&&timing.durationMs>=0);
    assert.equal('timing' in answer,false);assert.equal('timing' in request,false);
    if(outcome==='completed')assert.deepEqual(recorded,answer);
    else assert.doesNotMatch(JSON.stringify(recorded),/Private transport diagnostics/);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM events').get()!.count,0);
  }finally{store.close();}
});
