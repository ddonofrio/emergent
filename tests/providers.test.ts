import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand } from '@aws-sdk/client-bedrock';
import { bedrockInferenceModelId, bedrockThinkingConfig, DEFAULT_REASONING_TOKENS, discoverProviderModels, enabledProviders, InvalidCompletionError, normalizeSavedProvider, OutputTokenLimitError, ProviderChain, providerHeaders, resolveProviderApiKey, retryTokenLimitedCompletion, savedApiKeyForProvider, type CompletionRequest, type CompletionResult, type ProviderConfig } from '../server/agents/providers';

const request:CompletionRequest={messages:[],tools:[],max_tokens:32};
const provider=(id:string):ProviderConfig=>({id,name:id,apiKey:'test-key',baseUrl:'http://localhost/v1',model:`model-${id}`});
const result=(config:ProviderConfig):CompletionResult=>({provider:config.id,providerName:config.name,model:config.model,content:'ok',calls:[]});
const intercept=(chain:ProviderChain,handler:(config:ProviderConfig)=>Promise<CompletionResult>)=>{
  (chain as unknown as {request:(config:ProviderConfig,request:CompletionRequest,signal:AbortSignal)=>Promise<CompletionResult>}).request=handler;
};

test('saved provider keys default by provider while existing entries keep their own key',()=>{
  const providers:ProviderConfig[]=[
    {...provider('first-bedrock'),type:'amazon-bedrock',apiKey:'first-key'},
    {...provider('second-bedrock'),type:'amazon-bedrock',apiKey:'second-key'},
    {...provider('openai'),type:'openai',apiKey:'openai-key'},
  ];
  assert.equal(savedApiKeyForProvider(providers,'amazon-bedrock','new-model'),'first-key');
  assert.equal(savedApiKeyForProvider(providers,'amazon-bedrock','second-bedrock'),'second-key');
  assert.equal(savedApiKeyForProvider(providers,'openai','new-model'),'openai-key');
  assert.equal(savedApiKeyForProvider(providers,'openrouter','new-model'),'');
  assert.equal(resolveProviderApiKey(providers,'amazon-bedrock','new-model','',true),'','explicit removal must not inherit another provider token');
  assert.equal(resolveProviderApiKey(providers,'amazon-bedrock','new-model',' replacement ',true),'replacement','a replacement token wins over removal');
  const removed=[{...providers[0],apiKey:'',apiKeyRemoved:true},providers[1],providers[2]];
  assert.equal(resolveProviderApiKey(removed,'amazon-bedrock','first-bedrock',''),'','a removed model token must not be inherited again');
  assert.equal(resolveProviderApiKey(removed,'amazon-bedrock','second-bedrock',''),'second-key','removing one model token must preserve another model token');
});

test('providers are enabled by default and disabled providers are excluded',()=>{
  const providers=[provider('default'),{...provider('enabled'),enabled:true},{...provider('disabled'),enabled:false}];
  assert.deepEqual(enabledProviders(providers).map(candidate=>candidate.id),['default','enabled']);
  assert.deepEqual(new ProviderChain(providers).providers.map(candidate=>candidate.id),['default','enabled'],'The runtime must enforce activation even if a caller passes the complete saved list.');
});

test('a saved concrete model no longer performs legacy LM Studio discovery',()=>{
  const legacy={...provider('local'),apiKey:'local-lm-studio',model:'ornith-ai/Ornith-1.5-9B-GGUF',modelDiscovery:'lm-studio' as const};
  assert.deepEqual(normalizeSavedProvider(legacy),{...provider('local'),apiKey:'',model:'ornith-ai/Ornith-1.5-9B-GGUF'});
  const automatic={...legacy,model:'auto-detect loaded model'};
  assert.deepEqual(normalizeSavedProvider(automatic),{...automatic,apiKey:''});
});

test('tokenless providers never send an Authorization header',()=>{
  const authenticated={...provider('authenticated'),apiKey:'secret'};
  assert.equal(providerHeaders(authenticated).Authorization,'Bearer secret');
  assert.equal(providerHeaders({...authenticated,tokenless:true}).Authorization,undefined);
  assert.equal(providerHeaders({...authenticated,apiKey:''}).Authorization,undefined);
});

test('model discovery preserves provider order, labels models and removes duplicates',async t=>{
  const config={...provider('openrouter'),type:'openrouter' as const,apiKey:'discovery-key',baseUrl:'https://openrouter.ai/api/v1'};
  t.mock.method(globalThis,'fetch',async(url:unknown,init:RequestInit)=>{
    assert.equal(String(url),'https://openrouter.ai/api/v1/models');
    assert.equal((init.headers as Record<string,string>).Authorization,'Bearer discovery-key');
    return new Response(JSON.stringify({data:[{id:'first',name:'First model'},{id:'second'},{id:'first',name:'Duplicate'},{name:'Missing ID'}]}));
  });
  assert.deepEqual(await discoverProviderModels(config,AbortSignal.timeout(1000)),[
    {id:'first',label:'First model'},
    {id:'second',label:'second'},
  ]);
});

test('model discovery errors redact provider credentials',async t=>{
  const config=provider('local');
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({error:{message:`Invalid token ${config.apiKey}`}}),{status:401}));
  await assert.rejects(discoverProviderModels(config,AbortSignal.timeout(1000)),error=>error instanceof Error&&/HTTP 401.*\[REDACTED\]/.test(error.message)&&!error.message.includes(config.apiKey));
});

test('Bedrock model discovery lists EU inference profiles before text foundation models',async t=>{
  const prototype=BedrockClient.prototype as unknown as {send(command:ListFoundationModelsCommand|ListInferenceProfilesCommand,options:{abortSignal:AbortSignal}):Promise<unknown>};
  let profilePage=0;
  t.mock.method(prototype,'send',async(command:ListFoundationModelsCommand|ListInferenceProfilesCommand,options:{abortSignal:AbortSignal})=>{
    assert.ok(options.abortSignal);
    if(command instanceof ListFoundationModelsCommand){assert.equal(command.input.byOutputModality,'TEXT');return{modelSummaries:[{modelId:'anthropic.claude-test',modelName:'Claude Test',providerName:'Anthropic'}]};}
    assert.equal(command.input.typeEquals,'SYSTEM_DEFINED');
    const textModel=[{modelArn:'arn:aws:bedrock:eu-west-1::foundation-model/anthropic.claude-test'}];
    if(profilePage++===0){assert.equal(command.input.nextToken,undefined);return{inferenceProfileSummaries:[{inferenceProfileId:'global.anthropic.claude-global',inferenceProfileName:'Global Claude',status:'ACTIVE',models:textModel},{inferenceProfileId:'eu.anthropic.claude-eu',inferenceProfileName:'EU Claude',status:'ACTIVE',models:textModel},{inferenceProfileId:'eu.anthropic.inactive',inferenceProfileName:'Inactive EU Claude',status:'INACTIVE',models:textModel},{inferenceProfileId:'eu.cohere.embed',inferenceProfileName:'EU Embed',status:'ACTIVE',models:[{modelArn:'arn:aws:bedrock:eu-west-1::foundation-model/cohere.embed-v4:0'}]}],nextToken:'page-2'};}
    assert.equal(command.input.nextToken,'page-2');return{inferenceProfileSummaries:[{inferenceProfileId:'eu.anthropic.claude-second',inferenceProfileName:'Second EU Claude',status:'ACTIVE',models:textModel}]};
  });
  const config={...provider('bedrock'),type:'amazon-bedrock' as const,baseUrl:'',region:'eu-west-1'};
  assert.deepEqual(await discoverProviderModels(config,AbortSignal.timeout(1000)),[
    {id:'eu.anthropic.claude-eu',label:'EU Claude - Bedrock inference profile'},
    {id:'eu.anthropic.claude-second',label:'Second EU Claude - Bedrock inference profile'},
    {id:'global.anthropic.claude-global',label:'Global Claude - Bedrock inference profile'},
    {id:'anthropic.claude-test',label:'Claude Test — Anthropic'},
  ]);
});

test('round robin starts successive requests with successive providers',async()=>{
  const providers=[provider('first'),provider('second')],chain=new ProviderChain(providers,'round-robin'),attempted:string[]=[];
  intercept(chain,async config=>{attempted.push(config.id);return result(config);});
  await chain.complete(request,AbortSignal.timeout(1000),()=>{});
  await chain.complete(request,AbortSignal.timeout(1000),()=>{});
  assert.deepEqual(attempted,['first','second']);
});

test('provider health pulses the existing state while a request is in progress',async()=>{
  const config=provider('local'),chain=new ProviderChain([config]);
  let observed;
  intercept(chain,async candidate=>result(candidate));
  await chain.complete(request,AbortSignal.timeout(1000),()=>{observed=chain.healthFor(config.id);});
  assert.deepEqual(observed,{state:'unknown',detail:'No inference result recorded yet.',inFlight:true});
  assert.deepEqual(chain.healthFor(config.id),{state:'ok',detail:'Last inference request succeeded.'});
});

test('cancelling an in-flight request stops the provider pulse without changing its last state',async()=>{
  const config=provider('local'),chain=new ProviderChain([config]),controller=new AbortController();
  intercept(chain,async()=>{controller.signal.throwIfAborted();return result(config);});
  const pending=chain.complete(request,controller.signal,()=>controller.abort());
  await assert.rejects(pending,error=>error===controller.signal.reason);
  assert.deepEqual(chain.healthFor(config.id),{state:'unknown',detail:'No inference result recorded yet.'});
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
  const planning={...request,max_tokens:4400,messages:[{role:'user',content:'Review my recorded experience.'}]};
  assert.deepEqual(bedrockThinkingConfig(sonnet,planning),{inferenceConfig:{maxTokens:14400},additionalModelRequestFields:{thinking:{type:'adaptive'},output_config:{effort:'high'}}});
  assert.deepEqual(bedrockThinkingConfig(sonnet,{...planning,reasoning:'medium'}),{inferenceConfig:{maxTokens:14400},additionalModelRequestFields:{thinking:{type:'adaptive'},output_config:{effort:'medium'}}});
  assert.deepEqual(bedrockThinkingConfig(sonnet,{...planning,reasoning:'default'}),{inferenceConfig:{maxTokens:4400}});
  assert.deepEqual(bedrockThinkingConfig(sonnet,{...planning,reasoning:'minimum'}),{inferenceConfig:{maxTokens:4400}});
  assert.deepEqual(bedrockThinkingConfig({...sonnet,model:'unknown-model'},planning),{inferenceConfig:{maxTokens:4400}});
  assert.deepEqual(bedrockThinkingConfig({...sonnet,model:'eu.anthropic.claude-haiku-4-5-20251001-v1:0'},planning),{inferenceConfig:{maxTokens:14400},additionalModelRequestFields:{thinking:{type:'enabled',budget_tokens:10000}}});
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
  await assert.rejects(chain.complete(request,AbortSignal.timeout(1000),()=>{}),error=>error instanceof OutputTokenLimitError&&/token limit for generation \(10000 reasoning tokens \+ 32 output tokens\)/.test(error.message));
});

test('token-limit retries add one cumulative instruction line per failure',async()=>{
  const candidates:CompletionRequest[]=[];
  const original={...request,messages:[{role:'user',content:'Choose an action.'}]};
  const answer=await retryTokenLimitedCompletion(original,AbortSignal.timeout(1000),async candidate=>{
    candidates.push(candidate);
    if(candidates.length<3)throw new OutputTokenLimitError('local',2200,DEFAULT_REASONING_TOKENS);
    return result(provider('local'));
  });
  assert.equal(answer.provider,'local');
  assert.equal(candidates.length,3);
  const retryLines=(candidate:CompletionRequest)=>String((candidate.messages.at(-1) as {content?:unknown}).content).match(/^Limit token usage\./gm)?.length??0;
  assert.equal(retryLines(candidates[0]),0);
  assert.equal(retryLines(candidates[1]),1);
  assert.equal(retryLines(candidates[2]),2);
  assert.match(String((candidates[2].messages.at(-1) as {content?:unknown}).content),/10000 reasoning tokens and 2200 output tokens/);
});

test('reported reasoning and visible output usage are enforced separately',async t=>{
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:null,tool_calls:[{id:'wait',type:'function',function:{name:'wait',arguments:'{}'}}]}}],usage:{completion_tokens:10011,completion_tokens_details:{reasoning_tokens:10001}}})));
  await assert.rejects(new ProviderChain([provider('local')]).complete(request,AbortSignal.timeout(1000),()=>{}),error=>{
    assert.ok(error instanceof OutputTokenLimitError);
    assert.deepEqual(error.generated,{reasoning:10001,output:10});
    return true;
  });
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

test('tokenless HTTP diagnostics remain readable when the provider key is empty',async t=>{
  const config={...provider('local'),name:'Ornith-1.5-9B',apiKey:'',tokenless:true};
  const message="No model is loaded, and keyless API access cannot load 'ornith-ai/Ornith-1.5-9B-GGUF' by request. Load it in Unsloth Studio, or send an Unsloth API key.";
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({error:{message}}),{status:400}));
  await assert.rejects(new ProviderChain([config]).complete(request,AbortSignal.timeout(1000),()=>{}),error=>{
    assert.ok(error instanceof Error);
    assert.equal(error.message,`All inference providers are unavailable. Ornith-1.5-9B returned HTTP 400. ${message}`);
    assert.doesNotMatch(error.message,/\[REDACTED\]/);
    return true;
  });
});

test('local reasoning and output budgets are separate and legacy thinking false is ignored',async t=>{
  const bodies:Record<string,unknown>[]=[];
  t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:null,tool_calls:[{id:'wait',type:'function',function:{name:'wait',arguments:'{}'}}]}}]}));
  });
  const configured={...provider('local'),enableThinking:false,maxOutputTokens:4096};
  await new ProviderChain([configured]).complete(request,AbortSignal.timeout(1000),()=>{});
  await new ProviderChain([provider('default')]).complete(request,AbortSignal.timeout(1000),()=>{});
  await new ProviderChain([{...provider('explicit'),enableThinking:true}]).complete({...request,reasoning:'minimum'},AbortSignal.timeout(1000),()=>{});
  assert.equal(bodies[0].enable_thinking,undefined);
  assert.equal(bodies[0].max_tokens,4096+DEFAULT_REASONING_TOKENS);
  assert.equal(bodies[0].max_completion_tokens,4096+DEFAULT_REASONING_TOKENS);
  assert.equal(bodies[1].enable_thinking,undefined);
  assert.equal(bodies[1].max_tokens,request.max_tokens+DEFAULT_REASONING_TOKENS);
  assert.equal(bodies[1].max_completion_tokens,request.max_tokens+DEFAULT_REASONING_TOKENS);
  assert.equal(bodies[2].enable_thinking,true);
  assert.equal(bodies[2].max_tokens,request.max_tokens);
  assert.equal(bodies[2].max_completion_tokens,request.max_tokens);
  assert.equal(bodies.every(body=>body.stream===false),true);
});
