import { detectTokenLoop, tokenizeLoopText } from '../../vendor/deepseek-harness/loop-detector';
import { BedrockRuntimeClient, ConverseCommand, type ConverseCommandInput } from '@aws-sdk/client-bedrock-runtime';

export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string }; }
export interface ProviderConfig {
  id: string;
  type?: 'openai-compatible' | 'openai' | 'openrouter' | 'amazon-bedrock';
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  region?: string;
  displayModel?: string;
  modelDiscovery?: 'lm-studio';
  reasoningOptions?: ReasoningEffort[];
  timeoutMs?: number;
  headers?: Record<string, string>;
}
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';
export type ProviderStrategy = 'first-only' | 'round-robin' | 'fallback' | 'master-slaves';
export interface ProviderHealth { state:'unknown'|'ok'|'bad'; detail:string; }
export interface CompletionRequest { messages: unknown[]; tools: unknown[]; max_tokens: number; reasoning?: 'minimum' | 'maximum'; }
export interface CompletionResult {
  provider: string;
  providerName: string;
  model: string;
  content: string | null;
  calls: ToolCall[];
  usage?: unknown;
}
export class InvalidCompletionError extends Error {}

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
    apiKey: env.LOCAL_LLM_API_KEY?.trim() || 'local-lm-studio',
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
  constructor(readonly providers: ProviderConfig[], public strategy: ProviderStrategy = 'fallback') {}
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
    const failures: string[] = [];
    let invalid = 0;
    for (const {index,provider} of this.providerOrder()) {
      signal.throwIfAborted();
      try {
        this.currentStatus=`${failures.length?`${failures.join(' ')} `:''}Connecting to ${provider.name}…`;
        if (provider.modelDiscovery === 'lm-studio') await this.discoverLmStudioModel(provider, signal);
        onAttempt(provider, index);
        const result=await this.request(provider, request, signal);
        this.providerHealth.set(provider.id,{state:'ok',detail:'Last inference request succeeded.'});
        this.currentStatus=`${provider.name}: connected; last inference request succeeded.${failures.length?` Earlier provider failures: ${failures.join(' ')}`:''}`;
        if(this.strategy==='fallback')this.stickyIndex=index;
        return result;
      } catch (error) {
        signal.throwIfAborted();
        if(error instanceof InvalidCompletionError)invalid++;
        const detail=error instanceof Error?error.message:`${provider.name} failed.`;
        this.providerHealth.set(provider.id,{state:'bad',detail});
        const failure=`${provider.name}: ${detail}`;
        this.currentStatus=failure;
        failures.push(failure);
      }
    }
    if(invalid===this.providers.length){this.currentStatus=`All inference providers returned invalid completions. ${failures.join(' ')}`;throw new InvalidCompletionError(this.currentStatus);}
    this.currentStatus=`All inference providers are unavailable. ${failures.join(' ')}`;
    throw new Error(this.currentStatus);
  }

  private async discoverLmStudioModel(provider: ProviderConfig, signal: AbortSignal) {
    const endpoint = new URL('/api/v1/models', provider.baseUrl).toString();
    let response: Response;
    try {
      response = await fetch(endpoint, { headers: { Authorization: `Bearer ${provider.apiKey}`, ...provider.headers }, signal });
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
    const {reasoning,...completion}=request;
    const reasoningEffort=reasoning&&provider.reasoningOptions?.length?selectReasoningEffort(provider.reasoningOptions,reasoning):undefined;
    try {
      response = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json', ...provider.headers },
        signal: requestSignal,
        body: JSON.stringify({ ...completion, model: provider.model, ...(reasoningEffort?{reasoning_effort:reasoningEffort}:{}) }),
      });
    } catch (error) {
      signal.throwIfAborted();
      if (timeout?.aborted) throw new Error(`${provider.name} timed out and yielded to the next provider.`);
      throw new Error(`${provider.name} connection failed.`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`${provider.name} returned HTTP ${response.status}.`);
    }
    let payload:{ model?: string; choices?: { message: { content?: string; tool_calls?: ToolCall[] } }[]; usage?: unknown };
    try{payload=await response.json() as typeof payload;}
    catch{throw new InvalidCompletionError(`${provider.name} returned invalid JSON.`);}
    const answer = payload.choices?.[0]?.message;
    if (!answer) throw new InvalidCompletionError(`${provider.name} returned an incomplete response.`);
    const content = typeof answer.content === 'string' ? answer.content.slice(0, 5000) : null;
    if (content && detectTokenLoop(tokenizeLoopText(content))) throw new InvalidCompletionError(`${provider.name} returned repeating output.`);
    const calls = answer.tool_calls ?? [];
    if (!Array.isArray(calls) || calls.length > 16 || calls.some(call => typeof call.id !== 'string' || call.type !== 'function' || typeof call.function?.name !== 'string' || typeof call.function?.arguments !== 'string')) {
      throw new InvalidCompletionError(`${provider.name} returned invalid tool calls.`);
    }
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
    const answer=response.output?.message?.content??[];
    const content=answer.flatMap(block=>'text'in block&&typeof block.text==='string'?[block.text]:[]).join(' ').slice(0,5000)||null;
    const calls:ToolCall[]=answer.flatMap(block=>{
      if(!('toolUse'in block)||!block.toolUse?.name||!block.toolUse.toolUseId)return[];
      return[{id:block.toolUse.toolUseId,type:'function' as const,function:{name:block.toolUse.name,arguments:JSON.stringify(block.toolUse.input??{})}}];
    });
    if(!content&&!calls.length)throw new InvalidCompletionError(`${provider.name} returned an incomplete response.`);
    if(calls.length>16)throw new InvalidCompletionError(`${provider.name} returned too many tool calls.`);
    if(content&&detectTokenLoop(tokenizeLoopText(content)))throw new InvalidCompletionError(`${provider.name} returned repeating output.`);
    return{provider:provider.id,providerName:provider.name,model:provider.model,content,calls,...(response.usage?{usage:response.usage}:{})};
  }
}

// Planner and journal requests are independent decisions, so no thinking signatures cross turns.
// https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-adaptive-thinking.html
export function bedrockThinkingConfig(provider:ProviderConfig,request:CompletionRequest):Pick<ConverseCommandInput,'inferenceConfig'|'additionalModelRequestFields'> {
  const base={inferenceConfig:{maxTokens:request.max_tokens}};
  if(request.reasoning!=='maximum'||request.messages.some(message=>(message as {role?:string}).role==='assistant'))return base;
  if(/anthropic\.claude-(?:sonnet|opus)-4-6(?:\b|-)/.test(provider.model))return {
    inferenceConfig:{maxTokens:request.max_tokens+8192},
    additionalModelRequestFields:{thinking:{type:'adaptive'},output_config:{effort:'high'}},
  };
  if(/anthropic\.claude-(?:haiku|sonnet|opus)-4-5(?:\b|-)/.test(provider.model))return {
    inferenceConfig:{maxTokens:request.max_tokens+4096},
    additionalModelRequestFields:{thinking:{type:'enabled',budget_tokens:4096}},
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

function selectReasoningEffort(options:ReasoningEffort[],profile:'minimum'|'maximum') {
  const preference:ReasoningEffort[]=profile==='minimum'
    ?['none','low','medium','high']
    :['high','medium','low','none'];
  return preference.find(value=>options.includes(value));
}

function matchesModel(model: LmStudioModel, configured: string) {
  if (!configured || configured === 'auto-detect loaded model') return false;
  const needle = configured.toLowerCase();
  return [model.key, model.display_name, model.selected_variant, ...(model.loaded_instances ?? []).map(instance => instance.id)]
    .some(value => value?.toLowerCase() === needle || value?.toLowerCase().includes(needle));
}
