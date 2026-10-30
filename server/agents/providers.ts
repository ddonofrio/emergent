import { detectTokenLoop, tokenizeLoopText } from '../../vendor/deepseek-harness/loop-detector';
import { BedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand } from '@aws-sdk/client-bedrock';
import { BedrockRuntimeClient, ConverseCommand, type ConverseCommandInput } from '@aws-sdk/client-bedrock-runtime';

export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string }; }
export interface ProviderConfig {
  id: string;
  type?: 'openai-compatible' | 'openai' | 'openrouter' | 'amazon-bedrock';
  enabled?: boolean;
  name: string;
  apiKey: string;
  apiKeyRemoved?: boolean;
  tokenless?: boolean;
  baseUrl: string;
  model: string;
  region?: string;
  displayModel?: string;
  modelDiscovery?: 'lm-studio';
  reasoningOptions?: ReasoningEffort[];
  timeoutMs?: number;
  maxOutputTokens?: number;
  enableThinking?: boolean;
  headers?: Record<string, string>;
}
export function savedApiKeyForProvider(providers: readonly ProviderConfig[], type: NonNullable<ProviderConfig['type']>, id: string) {
  const providerType = (provider: ProviderConfig) => provider.type ?? 'openai-compatible';
  const existing = providers.find(provider => provider.id === id && providerType(provider) === type);
  if(existing?.apiKeyRemoved)return '';
  return existing?.apiKey.trim()?existing.apiKey:providers.find(provider => providerType(provider) === type && provider.apiKey.trim())?.apiKey ?? '';
}
export function resolveProviderApiKey(providers: readonly ProviderConfig[], type: NonNullable<ProviderConfig['type']>, id: string, providedKey: string, clearSavedKey = false) {
  const provided=providedKey.trim();
  if(provided)return provided;
  if(clearSavedKey)return '';
  const existing=providers.find(provider=>provider.id===id&&(provider.type??'openai-compatible')===type);
  if(existing?.apiKeyRemoved)return '';
  const saved=savedApiKeyForProvider(providers,type,id);
  return existing?.modelDiscovery==='lm-studio'&&saved==='local-lm-studio'?'':saved;
}
export function enabledProviders(providers: readonly ProviderConfig[]) {
  return providers.filter(provider => provider.enabled !== false);
}
export function normalizeSavedProvider(provider: ProviderConfig): ProviderConfig {
  const apiKey=provider.modelDiscovery==='lm-studio'&&provider.apiKey==='local-lm-studio'?'':provider.apiKey;
  if(provider.modelDiscovery==='lm-studio'&&provider.model!=='auto-detect loaded model'){
    const {modelDiscovery:_legacyDiscovery,...configured}=provider;
    return{...configured,apiKey};
  }
  return apiKey===provider.apiKey?provider:{...provider,apiKey};
}
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';
export type ReasoningProfile = 'default' | 'minimum' | 'medium' | 'maximum';
export type ProviderStrategy = 'first-only' | 'round-robin' | 'fallback' | 'master-slaves';
export interface ProviderHealth { state:'unknown'|'ok'|'bad'; detail:string; inFlight?:boolean; }
export interface CompletionRequest { messages: unknown[]; tools: unknown[]; max_tokens: number; reasoning?: ReasoningProfile; reasoning_tokens?: number; }
export const DEFAULT_REASONING:NonNullable<CompletionRequest['reasoning']>='maximum';
export const DEFAULT_REASONING_TOKENS=10000;
export interface CompletionResult {
  provider: string;
  providerName: string;
  model: string;
  content: string | null;
  calls: ToolCall[];
  usage?: unknown;
}
export interface ProviderModel { id:string; label:string; }
export class InvalidCompletionError extends Error {}
export class OutputTokenLimitError extends InvalidCompletionError {
  constructor(readonly providerName:string,readonly outputLimit:number,readonly reasoningLimit:number,readonly generated?:{output?:number;reasoning?:number}) {
    const generatedDetail=generated?.reasoning!==undefined||generated?.output!==undefined
      ? ` The response used${generated.reasoning===undefined?'':` ${generated.reasoning} reasoning tokens`}${generated.reasoning!==undefined&&generated.output!==undefined?' and':''}${generated.output===undefined?'':` ${generated.output} output tokens`}.`
      : '';
    super(`${providerName} reached the token limit for generation (${reasoningLimit} reasoning tokens + ${outputLimit} output tokens).${generatedDetail} The truncated response was discarded.`);
    this.name='OutputTokenLimitError';
  }
}

function tokenLimitRetryLine(error:OutputTokenLimitError,retry:number) {
  const generated=error.generated?.reasoning!==undefined||error.generated?.output!==undefined
    ? ` The previous attempt generated${error.generated.reasoning===undefined?'':` ${error.generated.reasoning} reasoning tokens`}${error.generated.reasoning!==undefined&&error.generated.output!==undefined?' and':''}${error.generated.output===undefined?'':` ${error.generated.output} output tokens`}.`
    : '';
  return `Limit token usage. Retry ${retry}: the previous attempt exceeded the generation budget.${generated} Use no more than ${error.reasoningLimit} reasoning tokens and ${error.outputLimit} output tokens, then return the required tool call without extra prose.`;
}

function addTokenLimitRetry(request:CompletionRequest,error:OutputTokenLimitError,retry:number):CompletionRequest {
  const messages=[...request.messages],line=tokenLimitRetryLine(error,retry);
  let index=-1;
  for(let candidate=messages.length-1;candidate>=0;candidate--){
    const message=messages[candidate] as {role?:unknown;content?:unknown}|undefined;
    if(message?.role==='user'&&typeof message.content==='string'){index=candidate;break;}
  }
  if(index<0)messages.push({role:'user',content:line});
  else{
    const message=messages[index] as {role?:unknown;content:string};
    messages[index]={...message,content:`${message.content}\n${line}`};
  }
  return{...request,messages};
}

/** Retry only budget exhaustion, varying the prompt with one cumulative line per failure. */
export async function retryTokenLimitedCompletion(request:CompletionRequest,signal:AbortSignal,complete:(candidate:CompletionRequest)=>Promise<CompletionResult>) {
  let candidate=request,retry=0;
  while(true){
    signal.throwIfAborted();
    try{return await complete(candidate);}
    catch(error){
      signal.throwIfAborted();
      if(!(error instanceof OutputTokenLimitError))throw error;
      candidate=addTokenLimitRetry(candidate,error,++retry);
    }
  }
}

export function providerHeaders(provider:ProviderConfig,headers:Record<string,string>={}) {
  const apiKey=provider.apiKey.trim();
  return {...(!provider.tokenless && apiKey ? { Authorization:`Bearer ${apiKey}` } : {}),...headers,...provider.headers};
}

function usageTokenCount(value:unknown) {
  return typeof value==='number'&&Number.isFinite(value)&&value>=0?Math.floor(value):undefined;
}

function completionTokenUsage(usage:unknown):{output?:number;reasoning?:number} {
  if(!usage||typeof usage!=='object')return{};
  const row=usage as Record<string,unknown>;
  const completionDetails=row.completion_tokens_details&&typeof row.completion_tokens_details==='object'?row.completion_tokens_details as Record<string,unknown>:undefined;
  const outputDetails=row.output_tokens_details&&typeof row.output_tokens_details==='object'?row.output_tokens_details as Record<string,unknown>:undefined;
  const reasoning=usageTokenCount(completionDetails?.reasoning_tokens)??usageTokenCount(outputDetails?.reasoning_tokens)??usageTokenCount(row.reasoning_tokens);
  const combined=usageTokenCount(row.completion_tokens)??usageTokenCount(row.output_tokens);
  const explicitOutput=usageTokenCount(row.visible_output_tokens)??usageTokenCount(row.answer_tokens);
  return{
    ...(reasoning===undefined?{}:{reasoning}),
    ...(explicitOutput!==undefined?{output:explicitOutput}:reasoning!==undefined&&combined!==undefined?{output:Math.max(0,combined-reasoning)}:{}),
  };
}

function validateToolCalls(provider:ProviderConfig,calls:unknown):asserts calls is ToolCall[] {
  if(!Array.isArray(calls)||calls.length>16||calls.some(call=>!call||typeof call.id!=='string'||!call.id||call.type!=='function'
    ||typeof call.function?.name!=='string'||!/^[a-zA-Z0-9_-]+$/.test(call.function.name)||typeof call.function?.arguments!=='string')) {
    throw new InvalidCompletionError(`${provider.name} returned invalid tool calls; tool names must contain only letters, numbers, underscores or hyphens.`);
  }
  for(const call of calls){
    let args:unknown;
    try{args=JSON.parse(call.function.arguments);}catch{}
    if(!args||typeof args!=='object'||Array.isArray(args)){
      throw new InvalidCompletionError(`${provider.name} returned invalid arguments for ${call.function.name}; expected a complete JSON object. The call was discarded before entering conversation history.`);
    }
  }
}

/** Keep provider diagnostics short and credential-free before exposing them to status. */
async function httpErrorDetail(response:Response,provider:ProviderConfig):Promise<string>{
  try{
    const payload=await response.json() as {error?:{message?:unknown};detail?:unknown;message?:unknown};
    const detail=payload.error?.message??payload.detail??payload.message;
    if(typeof detail!=='string')return '';
    const apiKey=provider.apiKey.trim();
    return (apiKey?detail.replaceAll(apiKey,'[REDACTED]'):detail).replace(/\s+/g,' ').slice(0,600);
  }catch{return '';}
}

function uniqueProviderModels(models:ProviderModel[]) {
  const ids=new Set<string>();
  return models.filter(model=>{if(!model.id||model.id.length>200||ids.has(model.id))return false;ids.add(model.id);return true;}).slice(0,2000);
}

export async function discoverProviderModels(provider:ProviderConfig,signal:AbortSignal):Promise<ProviderModel[]> {
  if(provider.type==='amazon-bedrock'){
    try{
      const client=new BedrockClient({region:provider.region||undefined,token:async()=>({token:provider.apiKey}),authSchemePreference:['httpBearerAuth']});
      const response=await client.send(new ListFoundationModelsCommand({byOutputModality:'TEXT'}),{abortSignal:signal});
      const textFoundationIds=new Set((response.modelSummaries??[]).flatMap(model=>model.modelId?[model.modelId]:[]));
      const profiles:ProviderModel[]=[],seenTokens=new Set<string>();let nextToken:string|undefined;
      do{
        const page=await client.send(new ListInferenceProfilesCommand({typeEquals:'SYSTEM_DEFINED',...(nextToken?{nextToken}:{})}),{abortSignal:signal});
        profiles.push(...(page.inferenceProfileSummaries??[]).flatMap(profile=>{
          const id=profile.inferenceProfileId?.trim(),supportsText=(profile.models??[]).some(model=>textFoundationIds.has(model.modelArn?.split('foundation-model/')[1]??''));
          if(!id||profile.status!=='ACTIVE'||!supportsText)return[];
          const name=profile.inferenceProfileName?.trim();
          return[{id,label:`${name||id} - Bedrock inference profile`.slice(0,200)}];
        }));
        const returned=page.nextToken?.trim();nextToken=returned&&!seenTokens.has(returned)?returned:undefined;if(nextToken)seenTokens.add(nextToken);
      }while(nextToken);
      profiles.sort((a,b)=>Number(!a.id.startsWith('eu.'))-Number(!b.id.startsWith('eu.'))||a.label.localeCompare(b.label));
      const foundations=(response.modelSummaries??[]).flatMap(model=>{
        const id=model.modelId?.trim();if(!id)return[];
        const name=model.modelName?.trim(),owner=model.providerName?.trim();
        return[{id,label:([name,owner].filter(Boolean).join(' — ')||id).slice(0,200)}];
      });
      const models=uniqueProviderModels([...profiles,...foundations]);
      if(!models.length)throw new Error('No text models were returned.');
      return models;
    }catch(error){
      signal.throwIfAborted();
      throw new Error(`${provider.name} model discovery failed${error instanceof Error&&error.message?`: ${error.message.replaceAll(provider.apiKey,'[REDACTED]').slice(0,300)}`:'.'}`);
    }
  }
  let response:Response;
  try{
    response=await fetch(`${provider.baseUrl.replace(/\/$/,'')}/models`,{headers:providerHeaders(provider),signal});
  }catch{signal.throwIfAborted();throw new Error(`${provider.name} model discovery failed.`);}
  if(!response.ok){const detail=await httpErrorDetail(response,provider);throw new Error(`${provider.name} model discovery returned HTTP ${response.status}.${detail?` ${detail}`:''}`);}
  let payload:{data?:unknown;models?:unknown};
  try{payload=await response.json() as typeof payload;}catch{throw new Error(`${provider.name} model discovery returned invalid JSON.`);}
  const rows=Array.isArray(payload.data)?payload.data:Array.isArray(payload.models)?payload.models:[];
  const models=uniqueProviderModels(rows.flatMap(row=>{
    if(!row||typeof row!=='object')return[];
    const value=row as {id?:unknown;slug?:unknown;name?:unknown;display_name?:unknown};
    const rawId=typeof value.id==='string'?value.id:typeof value.slug==='string'?value.slug:'';
    const id=rawId.trim();if(!id)return[];
    const rawLabel=typeof value.name==='string'?value.name:typeof value.display_name==='string'?value.display_name:'';
    return[{id,label:(rawLabel.trim()||id).slice(0,200)}];
  }));
  if(!models.length)throw new Error(`${provider.name} did not return any models.`);
  return models;
}

const positive = (value: string | undefined, fallback: number) => {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export function providersFromEnv(env: NodeJS.ProcessEnv = process.env): ProviderConfig[] {
  const providers: ProviderConfig[] = [];
  if (env.OPENROUTER_ENABLED !== 'false' && env.OPENROUTER_API_KEY?.trim()) providers.push({
    id: 'openrouter',
    type: 'openrouter',
    name: 'OpenRouter Free',
    apiKey: env.OPENROUTER_API_KEY.trim(),
    baseUrl: env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
    model: env.OPENROUTER_MODEL ?? 'openrouter/free',
    timeoutMs: positive(env.OPENROUTER_TIMEOUT_MS, 120000),
    headers: { 'X-Title': 'Emergent' },
  });
  if (env.LOCAL_LLM_BASE_URL?.trim()) providers.push({
    id: 'local',
    type: 'openai-compatible',
    name: 'Local LM Studio',
    apiKey: env.LOCAL_LLM_API_KEY?.trim()==='local-lm-studio'?'':env.LOCAL_LLM_API_KEY?.trim()??'',
    baseUrl: env.LOCAL_LLM_BASE_URL.trim(),
    model: env.LOCAL_LLM_MODEL?.trim() || 'auto-detect loaded model',
    modelDiscovery: 'lm-studio',
  });
  if (!providers.length && env.LLM_API_KEY?.trim()) providers.push({
    id: 'legacy',
    type: 'openai-compatible',
    name: 'Configured provider',
    apiKey: env.LLM_API_KEY.trim(),
    baseUrl: env.LLM_BASE_URL ?? 'https://api.deepseek.com',
    model: env.LLM_MODEL ?? 'deepseek-chat',
  });
  return providers;
}

export class ProviderChain {
  private roundRobinIndex = 0;
  private stickyIndex = 0;
  private bedrockClients = new Map<string,BedrockRuntimeClient>();
  private providerHealth = new Map<string,ProviderHealth>();
  currentStatus='';
  readonly providers:ProviderConfig[];
  constructor(providers: ProviderConfig[], public strategy: ProviderStrategy = 'fallback') {
    this.providers=enabledProviders(providers);
  }
  get enabled() { return this.providers.length > 0; }
  healthFor(id:string):ProviderHealth{return this.providerHealth.get(id)??{state:'unknown',detail:'No inference result recorded yet.'};}
  seedHistoricalSuccess(id:string,turn:number){
    const provider=this.providers.find(candidate=>candidate.id===id);if(!provider)return;
    const detail=`Last successful inference in turn ${turn}.`;
    this.providerHealth.set(id,{state:'ok',detail});this.currentStatus=`${provider.name}: ${detail}`;
  }
  get cacheKey() { return `${this.strategy}:${this.providers.map(provider => `${provider.id}:${provider.type??'openai-compatible'}:${provider.region??''}:${provider.model}`).join('->') || 'demo'}`; }
  get label() { return this.providers.map(provider => `${provider.name} (${provider.displayModel ?? provider.model})`).join(' -> ') || 'Scripted demo'; }

  private providerOrder() {
    const count=this.providers.length;
    if(count<2)return this.providers.map((provider,index)=>({provider,index}));
    if(this.strategy==='first-only')return[{provider:this.providers[0],index:0}];
    if(this.strategy==='round-robin'){
      const start=this.roundRobinIndex++%count;
      return Array.from({length:count},(_,offset)=>{const index=(start+offset)%count;return{provider:this.providers[index],index};});
    }
    const start=this.strategy==='fallback'?this.stickyIndex%count:0;
    return Array.from({length:count},(_,offset)=>{const index=(start+offset)%count;return{provider:this.providers[index],index};});
  }

  async refreshDiscoveredModels(signal: AbortSignal) {
    await Promise.all(this.providers.filter(provider => provider.modelDiscovery === 'lm-studio').map(provider => this.discoverLmStudioModel(provider, signal)));
  }

  async complete(request: CompletionRequest, signal: AbortSignal, onAttempt: (provider: ProviderConfig, index: number) => void): Promise<CompletionResult> {
    request={reasoning:DEFAULT_REASONING,reasoning_tokens:DEFAULT_REASONING_TOKENS,...request};
    const failures: string[] = [];
    let invalid = 0;
    let tokenLimit:OutputTokenLimitError|undefined;
    const order=this.providerOrder();
    for (const {index,provider} of order) {
      signal.throwIfAborted();
      try {
        this.currentStatus=`${failures.length?`${failures.join(' ')} `:''}Requesting inference from ${provider.name}…`;
        this.providerHealth.set(provider.id,{...this.healthFor(provider.id),inFlight:true});
        if (provider.modelDiscovery === 'lm-studio') await this.discoverLmStudioModel(provider, signal);
        onAttempt(provider, index);
        const result=await this.request(provider, request, signal);
        validateToolCalls(provider,result.calls);
        this.providerHealth.set(provider.id,{state:'ok',detail:'Last inference request succeeded.'});
        this.currentStatus=`${provider.name}: connected; last inference request succeeded.${failures.length?` Earlier provider failures: ${failures.join(' ')}`:''}`;
        if(this.strategy==='fallback')this.stickyIndex=index;
        return result;
      } catch (error) {
        if(signal.aborted){
          const {inFlight:_inFlight,...health}=this.healthFor(provider.id);
          this.providerHealth.set(provider.id,health);
          signal.throwIfAborted();
        }
        if(error instanceof InvalidCompletionError)invalid++;
        if(error instanceof OutputTokenLimitError)tokenLimit=error;
        const detail=error instanceof Error?error.message:`${provider.name} failed.`;
        this.providerHealth.set(provider.id,{state:'bad',detail});
        const failure=detail.startsWith(`${provider.name} `)?detail:`${provider.name}: ${detail}`;
        this.currentStatus=failure;
        failures.push(failure);
      }
    }
    if(tokenLimit){this.currentStatus=`All inference providers exhausted or failed before producing a complete response. ${failures.join(' ')}`;throw tokenLimit;}
    if(order.length&&invalid===order.length){this.currentStatus=`All inference providers returned invalid completions. ${failures.join(' ')}`;throw new InvalidCompletionError(this.currentStatus);}
    this.currentStatus=`All inference providers are unavailable. ${failures.join(' ')}`;
    throw new Error(this.currentStatus);
  }

  private async discoverLmStudioModel(provider: ProviderConfig, signal: AbortSignal) {
    const endpoint = new URL('/api/v1/models', provider.baseUrl).toString();
    let response: Response;
    try {
      response = await fetch(endpoint, { headers: providerHeaders(provider), signal });
    } catch {
      signal.throwIfAborted();
      throw new Error(`${provider.name} model discovery failed.`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`${provider.name} model discovery returned HTTP ${response.status}.`);
    }
    const payload = await response.json() as { models?: LmStudioModel[] };
    const loaded = (payload.models ?? []).filter(model => (model.type === 'llm' || model.type === 'decision') && model.loaded_instances?.length);
    if (!loaded.length) throw new Error(`${provider.name} has no loaded language model.`);
    const preferred = loaded.find(model => matchesModel(model, provider.model)) ?? loaded[0];
    const instance = preferred.loaded_instances![0];
    if (!instance.id?.trim()) throw new Error(`${provider.name} returned a loaded model without an instance identifier.`);
    provider.model = instance.id.trim();
    provider.displayModel = preferred.selected_variant?.trim() || preferred.key?.trim() || preferred.display_name?.trim() || provider.model;
    provider.reasoningOptions = normalizeReasoningOptions(preferred.capabilities?.reasoning?.allowed_options);
  }

  private async request(provider: ProviderConfig, request: CompletionRequest, signal: AbortSignal): Promise<CompletionResult> {
    if(provider.type==='amazon-bedrock')return this.requestBedrock(provider,request,signal);
    const timeout = provider.timeoutMs ? AbortSignal.timeout(provider.timeoutMs) : undefined;
    const requestSignal = timeout ? AbortSignal.any([signal, timeout]) : signal;
    let response: Response;
    const {reasoning,reasoning_tokens,max_tokens,...completion}=request;
    const reasoningEffort=reasoning&&reasoning!=='default'&&provider.reasoningOptions?.length?selectReasoningEffort(provider.reasoningOptions,reasoning):undefined;
    const outputLimit=provider.maxOutputTokens??max_tokens;
    const reasoningLimit=reasoning==='maximum'||reasoning==='medium'?(reasoning_tokens??DEFAULT_REASONING_TOKENS):0;
    const generationLimit=outputLimit+reasoningLimit;
    try {
      response = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: providerHeaders(provider,{'Content-Type':'application/json'}),
        signal: requestSignal,
        body: JSON.stringify({ ...completion, model: provider.model,
          stream:false,
          max_tokens:generationLimit,
          max_completion_tokens:generationLimit,
          ...(provider.enableThinking===true?{enable_thinking:true}:{}),
          ...(reasoningEffort?{reasoning_effort:reasoningEffort}:{}) }),
      });
    } catch (error) {
      signal.throwIfAborted();
      if (timeout?.aborted) throw new Error(`${provider.name} timed out and yielded to the next provider.`);
      throw new Error(`${provider.name} connection failed.`);
    }
    if (!response.ok) {
      const detail=await httpErrorDetail(response,provider);
      throw new Error(`${provider.name} returned HTTP ${response.status}.${detail?` ${detail}`:''}`);
    }
    let payload:{ model?: string; choices?: { finish_reason?:string; message: { content?: string; tool_calls?: ToolCall[] } }[]; usage?: unknown };
    try{payload=await response.json() as typeof payload;}
    catch{throw new InvalidCompletionError(`${provider.name} returned invalid JSON.`);}
    const answer = payload.choices?.[0]?.message;
    if (!answer) throw new InvalidCompletionError(`${provider.name} returned an incomplete response.`);
    const generated=completionTokenUsage(payload.usage);
    if(payload.choices?.[0]?.finish_reason==='length'||(generated.reasoning!==undefined&&generated.reasoning>reasoningLimit)||(generated.output!==undefined&&generated.output>outputLimit)){
      throw new OutputTokenLimitError(provider.name,outputLimit,reasoningLimit,generated);
    }
    const content = typeof answer.content === 'string' ? answer.content.slice(0, 5000) : null;
    if (content && detectTokenLoop(tokenizeLoopText(content))) throw new InvalidCompletionError(`${provider.name} returned repeating output.`);
    const calls = answer.tool_calls ?? [];
    return { provider: provider.id, providerName: provider.name, model: payload.model ?? provider.model, content, calls, ...(payload.usage === undefined ? {} : { usage: payload.usage }) };
  }

  private async requestBedrock(provider:ProviderConfig,request:CompletionRequest,signal:AbortSignal):Promise<CompletionResult>{
    const cacheKey=`${provider.id}:${provider.region??''}`;
    let client=this.bedrockClients.get(cacheKey);
    if(!client){
      client=new BedrockRuntimeClient({region:provider.region||undefined,token:async()=>({token:provider.apiKey}),authSchemePreference:['httpBearerAuth']});
      this.bedrockClients.set(cacheKey,client);
    }
    const system:{text:string}[]=[],messages:{role:'user'|'assistant';content:Record<string,unknown>[];toolResults?:boolean}[]=[];
    for(const raw of request.messages as {role?:string;content?:unknown;tool_calls?:ToolCall[];tool_call_id?:string}[]){
      const content=typeof raw.content==='string'?raw.content:raw.content==null?'':JSON.stringify(raw.content);
      if(raw.role==='system'||raw.role==='developer'){if(content)system.push({text:content});continue;}
      if(raw.role==='tool'){
        const block={toolResult:{toolUseId:raw.tool_call_id??'tool-result',content:[{text:content}]}};
        const previous=messages.at(-1);
        if(previous?.role==='user'&&previous.toolResults)previous.content.push(block);
        else messages.push({role:'user',content:[block],toolResults:true});
        continue;
      }
      if(raw.role!=='user'&&raw.role!=='assistant')continue;
      const blocks:Record<string,unknown>[]=[];
      if(content)blocks.push({text:content});
      for(const call of raw.tool_calls??[]){
        let input:Record<string,unknown>={};try{const parsed=JSON.parse(call.function.arguments);if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))input=parsed;}catch{}
        blocks.push({toolUse:{toolUseId:call.id,name:call.function.name,input}});
      }
      messages.push({role:raw.role,content:blocks.length?blocks:[{text:'Continue.'}]});
    }
    const tools=(request.tools as {type?:string;function?:{name?:string;description?:string;parameters?:unknown}}[])
      .filter(tool=>tool.type==='function'&&tool.function?.name)
      .map(tool=>({toolSpec:{name:tool.function!.name!,description:tool.function!.description??'',inputSchema:{json:tool.function!.parameters??{type:'object',properties:{}}}}}));
    const response=await client.send(new ConverseCommand({
      modelId:bedrockInferenceModelId(provider),
      ...(system.length?{system}:{}),
      messages:messages.map(({role,content})=>({role,content:content as never})),
      ...(tools.length?{toolConfig:{tools:tools as never}}:{}),
      ...bedrockThinkingConfig(provider,request),
    }),{abortSignal:signal});
    const budgets=bedrockBudgets(provider,request);
    if(response.stopReason==='max_tokens')throw new OutputTokenLimitError(provider.name,budgets.output,budgets.reasoning);
    const answer=response.output?.message?.content??[];
    const content=answer.flatMap(block=>'text'in block&&typeof block.text==='string'?[block.text]:[]).join(' ').slice(0,5000)||null;
    const calls:ToolCall[]=answer.flatMap(block=>{
      if(!('toolUse'in block)||!block.toolUse?.name||!block.toolUse.toolUseId)return[];
      return[{id:block.toolUse.toolUseId,type:'function' as const,function:{name:block.toolUse.name,arguments:JSON.stringify(block.toolUse.input??{})}}];
    });
    if(!content&&!calls.length)throw new InvalidCompletionError(`${provider.name} returned an incomplete response.`);
    if(content&&detectTokenLoop(tokenizeLoopText(content)))throw new InvalidCompletionError(`${provider.name} returned repeating output.`);
    return{provider:provider.id,providerName:provider.name,model:provider.model,content,calls,...(response.usage?{usage:response.usage}:{})};
  }
}

// Planner and journal requests are independent decisions, so no thinking signatures cross turns.
// https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-adaptive-thinking.html
function bedrockBudgets(provider:ProviderConfig,request:CompletionRequest) {
  const output=provider.maxOutputTokens??request.max_tokens;
  const supportsThinking=/anthropic\.claude-(?:(?:sonnet|opus)-4-6|(?:haiku|sonnet|opus)-4-5)(?:\b|-)/.test(provider.model);
  const profile=request.reasoning??DEFAULT_REASONING;
  const reasoning=(profile==='maximum'||profile==='medium')&&supportsThinking&&!request.messages.some(message=>(message as {role?:string}).role==='assistant')
    ? request.reasoning_tokens??DEFAULT_REASONING_TOKENS
    : 0;
  return{output,reasoning};
}

export function bedrockThinkingConfig(provider:ProviderConfig,request:CompletionRequest):Pick<ConverseCommandInput,'inferenceConfig'|'additionalModelRequestFields'> {
  const budgets=bedrockBudgets(provider,request),base={inferenceConfig:{maxTokens:budgets.output}};
  if(!budgets.reasoning)return base;
  if(/anthropic\.claude-(?:sonnet|opus)-4-6(?:\b|-)/.test(provider.model))return {
    inferenceConfig:{maxTokens:budgets.output+budgets.reasoning},
    additionalModelRequestFields:{thinking:{type:'adaptive'},output_config:{effort:request.reasoning==='medium'?'medium':'high'}},
  };
  if(/anthropic\.claude-(?:haiku|sonnet|opus)-4-5(?:\b|-)/.test(provider.model))return {
    inferenceConfig:{maxTokens:budgets.output+budgets.reasoning},
    additionalModelRequestFields:{thinking:{type:'enabled',budget_tokens:budgets.reasoning}},
  };
  return base;
}

export function bedrockInferenceModelId(provider:ProviderConfig){
  const model=provider.model.trim();
  if(model==='anthropic.claude-sonnet-4-6'&&provider.region?.startsWith('eu-'))return `eu.${model}`;
  if(model==='anthropic.claude-haiku-4-5-20251001-v1:0'&&provider.region?.startsWith('eu-'))return `eu.${model}`;
  return model;
}

interface LmStudioModel {
  type?: string;
  key?: string;
  display_name?: string;
  selected_variant?: string;
  capabilities?: { reasoning?: { allowed_options?: string[]; default?: string } };
  loaded_instances?: { id?: string }[];
}

function normalizeReasoningOptions(options:string[]|undefined):ReasoningEffort[]|undefined {
  if(!options?.length)return undefined;
  const normalized=options.flatMap(value=>value==='off'?['none' as const]:value==='on'?['high' as const]:isReasoningEffort(value)?[value]:[]);
  return [...new Set(normalized)];
}

function isReasoningEffort(value:string):value is ReasoningEffort {
  return ['none','low','medium','high'].includes(value);
}

function selectReasoningEffort(options:ReasoningEffort[],profile:Exclude<ReasoningProfile,'default'>) {
  const preference:ReasoningEffort[]=profile==='minimum'
    ?['none','low','medium','high']
    :profile==='medium'?['medium','high','low','none']:['high','medium','low','none'];
  return preference.find(value=>options.includes(value));
}

function matchesModel(model: LmStudioModel, configured: string) {
  if (!configured || configured === 'auto-detect loaded model') return false;
  const needle = configured.toLowerCase();
  return [model.key, model.display_name, model.selected_variant, ...(model.loaded_instances ?? []).map(instance => instance.id)]
    .some(value => value?.toLowerCase() === needle || value?.toLowerCase().includes(needle));
}
