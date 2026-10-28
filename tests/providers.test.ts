import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bedrockInferenceModelId, bedrockThinkingConfig, ProviderChain, type CompletionRequest, type CompletionResult, type ProviderConfig } from '../server/agents/providers';

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

test('Bedrock uses the European inference profile for Claude Sonnet 4.6',()=>{
  assert.equal(bedrockInferenceModelId({id:'sonnet',name:'Sonnet',apiKey:'test',baseUrl:'',model:'anthropic.claude-sonnet-4-6',region:'eu-north-1'}),'eu.anthropic.claude-sonnet-4-6');
  assert.equal(bedrockInferenceModelId({id:'sonnet',name:'Sonnet',apiKey:'test',baseUrl:'',model:'anthropic.claude-sonnet-4-6',region:'us-east-1'}),'anthropic.claude-sonnet-4-6');
});

test('Bedrock planner thinking reaches the wire with a separate budget, without changing executor requests',()=>{
  const sonnet={...provider('sonnet'),model:'eu.anthropic.claude-sonnet-4-6'};
  const planning={...request,max_tokens:2200,reasoning:'maximum' as const,messages:[{role:'user',content:'Review my recorded experience.'}]};
  assert.deepEqual(bedrockThinkingConfig(sonnet,planning),{inferenceConfig:{maxTokens:10392},additionalModelRequestFields:{thinking:{type:'adaptive'},output_config:{effort:'high'}}});
  assert.deepEqual(bedrockThinkingConfig(sonnet,{...planning,reasoning:'minimum'}),{inferenceConfig:{maxTokens:2200}});
  assert.deepEqual(bedrockThinkingConfig({...sonnet,model:'unknown-model'},planning),{inferenceConfig:{maxTokens:2200}});
  assert.deepEqual(bedrockThinkingConfig({...sonnet,model:'eu.anthropic.claude-haiku-4-5-20251001-v1:0'},planning),{inferenceConfig:{maxTokens:6296},additionalModelRequestFields:{thinking:{type:'enabled',budget_tokens:4096}}});
  assert.equal(bedrockThinkingConfig(sonnet,{...planning,messages:[{role:'assistant',content:'An existing tool conversation.'}]}).additionalModelRequestFields,undefined,'Do not enable thinking midway through a conversation lacking signed reasoning blocks.');
});
