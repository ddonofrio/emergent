import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CompletionResult } from '../server/agents/providers';
import { normalizeTextToolCall } from '../server/agents/tool-normalization';

const say={type:'function',function:{name:'say',parameters:{type:'object',properties:{word:{type:'string'},intention:{type:'string',maxLength:200}},required:['word'],additionalProperties:false}}};
const wait={type:'function',function:{name:'wait',parameters:{type:'object',properties:{},additionalProperties:false}}};
const response=(content:string):CompletionResult=>({provider:'stub',providerName:'Stub',model:'stub',content,calls:[]});

test('observed JSON tool envelopes preserve arguments, raw content and normalization provenance',()=>{
  const args={word:'Hi Pebble',intention:"Test Pebble's responsiveness to vocal stimuli while following."};
  for(const [draft,format,tools] of [
    [{tool:'say',...args},'tool-inline',[say,wait]],
    [{tool:'say',parameters:args},'tool-parameters',[say,wait]],
    [{say:args},'named-tool',[say,wait]],
    [args,'single-tool-arguments',[say]],
  ] as const){
    const original=response(JSON.stringify(draft)),before=structuredClone(original);
    const normalized=normalizeTextToolCall(original,[...tools]);
    assert.deepEqual(original,before);
    assert.equal(normalized.content,original.content);
    assert.deepEqual(normalized.normalization,{source:'content',format});
    assert.equal(normalized.calls.length,1);assert.equal(normalized.calls[0].function.name,'say');
    assert.deepEqual(JSON.parse(normalized.calls[0].function.arguments),args);
    assert.match(normalized.calls[0].id,/^text_/);
  }
});

test('normalization rejects prose, incomplete JSON, unknown tools and invalid arguments without guessing',()=>{
  for(const content of [
    'Please call {"tool":"say","word":"Hi Pebble"}',
    '```json\n{"tool":"say","word":"Hi Pebble"}\n```',
    '{"tool":"say","word":"Hi Pebble"',
    '{"tool":"say","word":"Hi Pebble"} trailing prose',
    '{"tool":"say","word":"Hi Pebble"}{"tool":"wait"}',
    '[{"tool":"say","word":"Hi Pebble"}]','null','"say"',
    '{"tool":"unavailable","parameters":{}}',
    '{"tool":"say","parameters":{}}',
    '{"tool":"say","parameters":{"word":7}}',
    '{"tool":"say","parameters":"{\\"word\\":\\"Hi Pebble\\"}"}',
    '{"tool":"say","parameters":{"word":"Hi Pebble"},"extra":true}',
    '{"tool":"say","word":"Hi Pebble","extra":true}',
    '{"say":{"word":"Hi Pebble"},"wait":{}}',
    JSON.stringify({tool:'say',word:'Hi Pebble',intention:'x'.repeat(201)}),
  ]){
    const original=response(content);
    assert.equal(normalizeTextToolCall(original,[say,wait]),original,content);
  }
});

test('unlabelled arguments require one available tool and ambiguous interpretations are rejected',()=>{
  const bare=response('{"word":"Hi Pebble"}');
  assert.equal(normalizeTextToolCall(bare,[say,wait]),bare);
  assert.equal(normalizeTextToolCall(bare,[]),bare);
  const named=response('{"tool":"say","word":"Hi Pebble"}');
  assert.equal(normalizeTextToolCall(named,[say,say]),named);
  const open={type:'function',function:{name:'say',parameters:{type:'object'}}};
  assert.equal(normalizeTextToolCall(named,[open]),named,'Both a labelled call and bare arguments would validate.');
});

test('native calls always take precedence, including invalid native arguments',()=>{
  for(const args of ['{}','{']){
    const original:CompletionResult={...response('{"tool":"say","word":"Hi Pebble"}'),calls:[{id:'native',type:'function',function:{name:'wait',arguments:args}}]};
    assert.equal(normalizeTextToolCall(original,[say,wait]),original);
  }
});
