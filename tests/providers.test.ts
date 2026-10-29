import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bedrockInferenceModelId, bedrockThinkingConfig, InvalidCompletionError, ProviderChain, type CompletionRequest, type CompletionResult, type ProviderConfig } from '../server/agents/providers';

const request:CompletionRequest={messages:[],tools:[],max_tokens:32};
const provider=(id:string):ProviderConfig=>({id,name:id,apiKey:'test-key',baseUrl:'http://localhost/v1',model:`model-${id}`});
const result=(config:ProviderConfig):CompletionResult=>({provider:config.id,providerName:config.name,model:config.model,content:'ok',calls:[]});
const intercept=(chain:ProviderChain,handler:(config:ProviderConfig)=>Promise<CompletionResult>)=>{
  (chain as unknown as {request:(config:ProviderConfig,request:CompletionRequest,signal:AbortSignal)=>Promise<CompletionResult>}).request=handler;
};

test('round robin starts successive requests with successive providers',async()=>{
  const providers=[provider('first'),provider('second')],chain=new ProviderChain(providers,'round-robin'),attempted:string[]=[];
  intercept(chain,async config=>{attempted.push(config.id);return result(config);});
  await chain.complete(request,AbortSignal.timeout(1000),()=>{});
  await chain.complete(request,AbortSignal.timeout(1000),()=>{});
  assert.deepEqual(attempted,['first','second']);
});

test('provider failure retains its exact health detail after fallback succeeds',async()=>{
  const providers=[provider('bedrock'),provider('local')],chain=new ProviderChain(providers,'round-robin');
  intercept(chain,async config=>{
    if(config.id==='bedrock')throw new Error('Inference profile unavailable for test model.');
    return result(config);
  });
  const completion=await chain.complete(request,AbortSignal.timeout(1000),()=>{});
  assert.equal(completion.provider,'local');
  assert.deepEqual(chain.healthFor('bedrock'),{state:'bad',detail:'Inference profile unavailable for test model.'});
  assert.deepEqual(chain.healthFor('local'),{state:'ok',detail:'Last inference request succeeded.'});
  assert.match(chain.currentStatus,/bedrock: Inference profile unavailable for test model/);
});

test('first-only rejects malformed model tool names before accepting a response, with configured backups inactive',async()=>{
  const providers=[provider('primary'),provider('inactive')],chain=new ProviderChain(providers,'first-only');
  const attempted:string[]=[];
  let name='choices</arg_value>';
  intercept(chain,async config=>{
    attempted.push(config.id);
    return {...result(config),calls:[{id:'call',type:'function',function:{name,arguments:'{}'}}]};
  });
  for(name of ['choices</arg_value>','halt</arg_value>','functions.wait','']){
    await assert.rejects(chain.complete(request,AbortSignal.timeout(1000),()=>{}),error=>error instanceof InvalidCompletionError&&/invalid tool calls/.test(error.message));
  }
  name='wait';
  assert.equal((await chain.complete(request,AbortSignal.timeout(1000),()=>{})).calls[0].function.name,'wait');
  assert.deepEqual(attempted,Array(5).fill('primary'));
  assert.equal(chain.healthFor('inactive').state,'unknown');
});

test('Bedrock uses the European inference profile for Claude Sonnet 4.6',()=>{
  assert.equal(bedrockInferenceModelId({id:'sonnet',name:'Sonnet',apiKey:'test',baseUrl:'',model:'anthropic.claude-sonnet-4-6',region:'eu-north-1'}),'eu.anthropic.claude-sonnet-4-6');
  assert.equal(bedrockInferenceModelId({id:'sonnet',name:'Sonnet',apiKey:'test',baseUrl:'',model:'anthropic.claude-sonnet-4-6',region:'us-east-1'}),'anthropic.claude-sonnet-4-6');
});

test('Bedrock reasoning defaults on with a separate thinking budget',()=>{
  const sonnet={...provider('sonnet'),model:'eu.anthropic.claude-sonnet-4-6'};
  const planning={...request,max_tokens:2200,messages:[{role:'user',content:'Review my recorded experience.'}]};
  assert.deepEqual(bedrockThinkingConfig(sonnet,planning),{inferenceConfig:{maxTokens:10392},additionalModelRequestFields:{thinking:{type:'adaptive'},output_config:{effort:'high'}}});
  assert.deepEqual(bedrockThinkingConfig(sonnet,{...planning,reasoning:'minimum'}),{inferenceConfig:{maxTokens:2200}});
  assert.deepEqual(bedrockThinkingConfig({...sonnet,model:'unknown-model'},planning),{inferenceConfig:{maxTokens:2200}});
  assert.deepEqual(bedrockThinkingConfig({...sonnet,model:'eu.anthropic.claude-haiku-4-5-20251001-v1:0'},planning),{inferenceConfig:{maxTokens:6296},additionalModelRequestFields:{thinking:{type:'enabled',budget_tokens:4096}}});
  assert.equal(bedrockThinkingConfig(sonnet,{...planning,messages:[{role:'assistant',content:'An existing tool conversation.'}]}).additionalModelRequestFields,undefined,'Do not enable thinking midway through a conversation lacking signed reasoning blocks.');
});

test('malformed JSON tool arguments are rejected before entering conversation history',async()=>{
  const config=provider('local'),chain=new ProviderChain([config]);
  let args='';
  intercept(chain,async()=>({...result(config),calls:[{id:'call',type:'function',function:{name:'wait',arguments:args}}]}));
  for(args of ['{"reason":"cut off','not json','null','[]','"encoded object"']){
    await assert.rejects(chain.complete(request,AbortSignal.timeout(1000),()=>{}),error=>error instanceof InvalidCompletionError&&/JSON object/.test(error.message));
  }
  args='{}';
  assert.equal((await chain.complete(request,AbortSignal.timeout(1000),()=>{})).calls[0].function.arguments,'{}');
});

test('token-limit responses are explicit invalid completions instead of empty successes',async t=>{
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({choices:[{finish_reason:'length',message:{content:'',reasoning_content:'Still thinking.',tool_calls:[]}}]})));
  const chain=new ProviderChain([provider('local')]);
  await assert.rejects(chain.complete(request,AbortSignal.timeout(1000),()=>{}),error=>error instanceof InvalidCompletionError&&/token limit/.test(error.message));
});

test('provider HTTP diagnostics retain the cause and redact its credential',async t=>{
  const config=provider('local');
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({error:{message:`Failed to parse tool call arguments as JSON. Token ${config.apiKey}`}}),{status:500}));
  const chain=new ProviderChain([config]);
  await assert.rejects(chain.complete(request,AbortSignal.timeout(1000),()=>{}),error=>{
    assert.ok(error instanceof Error);
    assert.match(error.message,/HTTP 500.*Failed to parse tool call arguments as JSON/);
    assert.ok(!error.message.includes(config.apiKey));
    return true;
  });
});

test('local reasoning and output budget are opt-in provider settings',async t=>{
  const bodies:Record<string,unknown>[]=[];
  t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:null,tool_calls:[{id:'wait',type:'function',function:{name:'wait',arguments:'{}'}}]}}]}));
  });
  const configured={...provider('local'),enableThinking:false,maxOutputTokens:4096};
  await new ProviderChain([configured]).complete(request,AbortSignal.timeout(1000),()=>{});
  await new ProviderChain([provider('default')]).complete(request,AbortSignal.timeout(1000),()=>{});
  assert.equal(bodies[0].enable_thinking,false);
  assert.equal(bodies[0].max_tokens,4096);
  assert.equal(bodies[1].enable_thinking,undefined);
  assert.equal(bodies[1].max_tokens,request.max_tokens);
});
