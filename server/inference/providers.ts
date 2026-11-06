/** Provider composition adapted from LittleWhale llm-pi-ai. See vendor/littlewhale/README.md. */
import { BedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand } from '@aws-sdk/client-bedrock';
import { createModels, createProvider, type Api, type AssistantMessage, type Context, type Message as PiMessage, type Model, type Provider, type Tool, type Usage } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { amazonBedrockProvider } from '@earendil-works/pi-ai/providers/amazon-bedrock';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import type { Completion, CompletionRequest, Message, ToolSchema } from '../../vendor/littlewhale';
import { RequestQueue } from './request-queue';

export interface ProviderConfig {
  id: string;
  type: 'openai-compatible' | 'openai' | 'openrouter' | 'vast-ai' | 'amazon-bedrock';
  name: string;
  enabled?: boolean;
  baseUrl: string;
  model: string;
  apiKey: string;
  region?: string;
  tokenless?: boolean;
  contextWindow?: number;
  reasoning?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  timeoutMs?: number;
  headers?: Record<string, string>;
  vastToken?: string;
  vastContainerLabel?: string;
}

export interface ProviderModel { id: string; label: string; contextWindow?: number; }
export interface ProviderRequestStatus {
  state: 'unknown' | 'ok' | 'bad';
  inFlight: number;
  detail?: string;
}
export const DEFAULT_CONTEXT_WINDOW = 49152;
export const DEFAULT_MAX_TOKENS = 4096;
const PROVIDER_TYPES = new Set(['openai-compatible', 'openai', 'openrouter', 'vast-ai', 'amazon-bedrock']);
const REASONING = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);

/** Configuration is server-owned. Credentials never enter sessions or world recordings. */
export function validateProviders(value: unknown): ProviderConfig[] {
  if (!Array.isArray(value)) throw new Error('Providers must be an array.');
  const ids = new Set<string>();
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid provider.');
    const raw = entry as Record<string, unknown>;
    for (const key of ['id', 'type', 'name', 'baseUrl', 'model', 'apiKey']) {
      if (typeof raw[key] !== 'string') throw new Error(`Provider ${key} must be a string.`);
    }
    if (!raw.id || ids.has(raw.id as string)) throw new Error('Provider IDs must be nonempty and unique.');
    ids.add(raw.id as string);
    if (!PROVIDER_TYPES.has(raw.type as string)) throw new Error('Unsupported provider type.');
    if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw new Error('Provider enabled must be boolean.');
    if (raw.tokenless !== undefined && typeof raw.tokenless !== 'boolean') throw new Error('Provider tokenless must be boolean.');
    for (const key of ['contextWindow', 'timeoutMs']) {
      if (raw[key] !== undefined && (!Number.isSafeInteger(raw[key]) || (raw[key] as number) <= 0)) throw new Error(`Provider ${key} must be a positive integer.`);
    }
    for (const key of ['region', 'vastToken', 'vastContainerLabel']) {
      if (raw[key] !== undefined && typeof raw[key] !== 'string') throw new Error(`Provider ${key} must be a string.`);
    }
    if (raw.reasoning !== undefined && !REASONING.has(raw.reasoning as string)) throw new Error('Invalid reasoning level.');
    const headers = raw.headers;
    if (headers !== undefined && (!headers || typeof headers !== 'object' || Array.isArray(headers) || Object.values(headers).some(value => typeof value !== 'string'))) throw new Error('Invalid provider headers.');
    if (raw.vastContainerLabel && !/^C\.\d+$/.test(raw.vastContainerLabel as string)) throw new Error('Vast container label must have the form C.123456.');
    let baseUrl = (raw.baseUrl as string).trim().replace(/\/+$/, '');
    if (!baseUrl) baseUrl = raw.type === 'openai' ? 'https://api.openai.com/v1' : raw.type === 'openrouter' ? 'https://openrouter.ai/api/v1' : '';
    if (raw.type !== 'amazon-bedrock') {
      let parsed: URL;
      try { parsed = new URL(baseUrl); } catch { throw new Error('Provider endpoint must be an absolute HTTP URL.'); }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Provider endpoint must be an HTTP URL without embedded credentials.');
    }
    const result: ProviderConfig = {
      id: raw.id as string, type: raw.type as ProviderConfig['type'], name: (raw.name as string).trim() || raw.id as string,
      baseUrl, model: (raw.model as string).trim(), apiKey: (raw.apiKey as string).trim(),
      ...(raw.enabled === undefined ? {} : { enabled: raw.enabled as boolean }),
      ...(raw.tokenless === undefined ? {} : { tokenless: raw.tokenless as boolean }),
      ...(raw.contextWindow === undefined ? {} : { contextWindow: raw.contextWindow as number }),
      ...(raw.timeoutMs === undefined ? {} : { timeoutMs: raw.timeoutMs as number }),
      ...(raw.reasoning === undefined ? {} : { reasoning: raw.reasoning as ProviderConfig['reasoning'] }),
      ...(raw.region === undefined ? {} : { region: (raw.region as string).trim() }),
      ...(raw.vastToken === undefined ? {} : { vastToken: (raw.vastToken as string).trim() }),
      ...(raw.vastContainerLabel === undefined ? {} : { vastContainerLabel: (raw.vastContainerLabel as string).trim() }),
      ...(headers === undefined ? {} : { headers: structuredClone(headers) as Record<string, string> }),
    };
    const capacity = result.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    if (capacity < 8192) throw new Error('Context window must be at least 8192 tokens, including the provider core\'s 4096-token safety reserve.');
    return result;
  });
}

export function publicProviders(providers: readonly ProviderConfig[]) {
  return providers.map(({ apiKey, vastToken, headers, ...provider }) => ({
    ...provider, hasApiKey: Boolean(apiKey), hasVastToken: Boolean(vastToken), hasConfiguredHeaders: Boolean(headers && Object.keys(headers).length),
  }));
}

export function providersFromEnv(): ProviderConfig[] {
  const env = process.env;
  const model = env.EMERGENT_LLM_MODEL ?? env.OPENAI_MODEL;
  const baseUrl = env.EMERGENT_LLM_BASE_URL ?? env.OPENAI_BASE_URL;
  if (!model || !baseUrl) return [];
  const apiKey = env.EMERGENT_LLM_API_KEY ?? env.OPENAI_API_KEY ?? '';
  return validateProviders([{ id: 'environment', type: 'openai-compatible', name: 'Environment model', model, baseUrl, apiKey, tokenless: !apiKey }]);
}

const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

function catalogProvider(type: ProviderConfig['type']): Provider | undefined {
  if (type === 'openai') return openaiProvider();
  if (type === 'openrouter') return openrouterProvider();
  if (type === 'amazon-bedrock') return amazonBedrockProvider();
  return undefined;
}

function modelFor(config: ProviderConfig, id = config.model): Model<Api> {
  const base = catalogProvider(config.type)?.getModels().find(model => model.id === id);
  const api = base?.api ?? (config.type === 'amazon-bedrock' ? 'bedrock-converse-stream' : config.type === 'openai' ? 'openai-responses' : 'openai-completions');
  return {
    id, name: base?.name ?? id, api, provider: config.id,
    baseUrl: config.baseUrl || base?.baseUrl || '',
    reasoning: config.reasoning === undefined ? base?.reasoning ?? false : config.reasoning !== 'off',
    input: ['text'], cost: base?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindow ?? base?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: base?.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(base?.compat === undefined ? {} : { compat: base.compat }),
    ...(base?.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: base.thinkingLevelMap }),
  };
}

/** LittleWhale's catalog-provider reuse keeps protocol implementations and native auth intact. */
function buildProvider(config: ProviderConfig, model: Model<Api>): Provider {
  const catalog = catalogProvider(config.type);
  const localAuth = {
    name: config.name,
    resolve: async () => ({ auth: { apiKey: config.apiKey || config.vastToken || (config.tokenless ? 'local' : undefined) }, source: config.name }),
  };
  if (catalog) return {
    id: config.id, name: config.name, auth: config.type === 'amazon-bedrock' && !config.apiKey ? catalog.auth : { apiKey: localAuth },
    getModels: () => [model], stream: (target, context, options) => catalog.stream(target, context, options),
    streamSimple: (target, context, options) => catalog.streamSimple(target, context, options),
  };
  return createProvider({ id: config.id, name: config.name, baseUrl: config.baseUrl, auth: { apiKey: localAuth }, models: [model], api: model.api === 'openai-responses' ? openAIResponsesApi() : openAICompletionsApi() });
}

function providerHeaders(config: ProviderConfig): Record<string, string> {
  const headers = { ...config.headers };
  if (config.type === 'vast-ai' && config.apiKey && config.vastToken && config.vastContainerLabel) {
    headers.Cookie = `${config.vastContainerLabel}_auth_token=${config.vastToken}`;
  }
  return headers;
}

/** Replay signed reasoning data only on the exact serving route and model. */
function replayMessages(messages: Message[], model: Model<Api>): PiMessage[] {
  return messages.map(message => {
    if (message.role === 'user') return { role: 'user', content: message.content ?? '', timestamp: 0 };
    if (message.role === 'tool') return {
      role: 'toolResult', toolCallId: message.toolCallId!, toolName: message.toolName ?? '',
      content: [{ type: 'text', text: message.content ?? '' }], isError: message.isError ?? false, timestamp: 0,
    };
    const replay = message.providerState as AssistantMessage | undefined;
    if (replay?.role === 'assistant' && replay.provider === model.provider && replay.model === model.id && replay.api === model.api) {
      const restored = structuredClone(replay);
      let callIndex = 0;
      restored.content = restored.content.map(block => block.type === 'toolCall' ? { ...block, ...message.toolCalls?.[callIndex++] } : block);
      return restored;
    }
    return {
      role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      content: [
        ...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
        ...(message.toolCalls ?? []).map(call => ({ type: 'toolCall' as const, ...call })),
      ], usage: emptyUsage(), stopReason: message.toolCalls?.length ? 'toolUse' : 'stop', timestamp: 0,
    };
  });
}

function safeError(error: unknown, configs: readonly ProviderConfig[]): string {
  let message = error instanceof Error ? error.message : 'Model provider failed.';
  for (const config of configs) for (const secret of [config.apiKey, config.vastToken, ...Object.values(config.headers ?? {})]) {
    if (secret) message = message.split(secret).join('[redacted]');
  }
  return message;
}

export class InferenceClient {
  providers: ProviderConfig[];
  private requestStatuses = new Map<string, ProviderRequestStatus>();
  constructor(providers: ProviderConfig[], private onStatusChanged?: () => void, private requestQueue = new RequestQueue()) { this.providers = validateProviders(providers); }
  configure(providers: ProviderConfig[]): void { this.providers = validateProviders(providers); }
  describeError(error: unknown): string { return safeError(error, this.providers); }
  statuses(): Record<string, ProviderRequestStatus> {
    return Object.fromEntries(this.providers.map(provider => [provider.id, { ...(this.requestStatuses.get(provider.id) ?? { state: 'unknown' as const, inFlight: 0 }) }]));
  }
  private updateStatus(id: string, update: Partial<ProviderRequestStatus>) {
    this.requestStatuses.set(id, { ...(this.requestStatuses.get(id) ?? { state: 'unknown', inFlight: 0 }), ...update });
    // Observer delivery must never change a provider request or its outcome.
    try { this.onStatusChanged?.(); } catch { /* The next status packet can refresh the observer. */ }
  }
  private inFlight(id: string, change: number) {
    this.updateStatus(id, { inFlight: Math.max(0, (this.requestStatuses.get(id)?.inFlight ?? 0) + change) });
  }
  get enabled(): boolean { return this.providers.some(provider => provider.enabled !== false && provider.model); }
  get label(): string { const provider = this.providers.find(provider => provider.enabled !== false && provider.model); return provider ? `${provider.name}: ${provider.model}` : 'No model configured'; }
  get contextWindow(): number {
    const active = this.providers.filter(provider => provider.enabled !== false && provider.model);
    return active.length ? Math.min(...active.map(provider => modelFor(provider).contextWindow)) : DEFAULT_CONTEXT_WINDOW;
  }
  get maxTokens(): number {
    const active = this.providers.filter(provider => provider.enabled !== false && provider.model);
    return active.length ? Math.min(...active.map(provider => modelFor(provider).maxTokens)) : DEFAULT_MAX_TOKENS;
  }

  /** One attempt per configured route. The session owns indefinite cancellable retries. */
  complete(request: CompletionRequest, signal: AbortSignal): Promise<Completion> {
    // Auxiliary memory work must not occupy the serial foreground decision queue.
    if (request.purpose === 'memory') return this.request(request, signal);
    return this.requestQueue.run(() => this.request(request, signal), signal);
  }

  private async request(request: CompletionRequest, signal: AbortSignal): Promise<Completion> {
    const configs = this.providers.filter(config => config.enabled !== false && config.model);
    const started = performance.now();
    const failures: string[] = [];
    let attempts = 0;
    for (const config of configs) {
      signal.throwIfAborted();
      attempts++;
      this.inFlight(config.id, 1);
      try {
        const selected = config.model === 'auto' ? (await discoverModels(config, signal))[0]?.id : config.model;
        if (!selected) throw new Error('No available model was discovered.');
        const model = modelFor(config, selected);
        const collection = createModels();
        collection.setProvider(buildProvider(config, model));
        const context: Context = {
          systemPrompt: request.system, messages: replayMessages(request.messages, model),
          tools: request.tools.map((tool: ToolSchema) => ({ ...tool, parameters: tool.parameters as Tool['parameters'] })),
        };
        const response = await collection.completeSimple(model, context, {
          signal, maxTokens: request.maxTokens,
          maxRetries: 0, timeoutMs: config.timeoutMs ?? 120000, sessionId: request.sessionId,
          ...(config.reasoning && config.reasoning !== 'off' ? { reasoning: config.reasoning } : {}),
          ...(config.region ? { env: { AWS_REGION: config.region } } : {}),
          headers: { ...providerHeaders(config), ...(config.tokenless ? { authorization: null } : {}) },
        });
        signal.throwIfAborted();
        if (response.stopReason === 'error' || response.stopReason === 'aborted') throw new Error(response.errorMessage || 'Model provider returned no completion.');
        const content = response.content.filter(block => block.type === 'text').map(block => block.text).join('\n') || null;
        const calls = response.content.filter(block => block.type === 'toolCall').map(({ id, name, arguments: args }) => ({ id, name, arguments: args }));
        // A reasoning-only response can exhaust its output budget before emitting text.
        // Preserve its finish reason and usage for the session and durable audit.
        if (!content && !calls.length && response.stopReason !== 'length') throw new Error('Model returned no text or tool calls.');
        this.updateStatus(config.id, response.stopReason === 'length'
          ? { state: 'bad', detail: `Model reached its output limit after ${response.usage.output} tokens.` }
          : { state: 'ok', detail: 'Request completed.' });
        return {
          content, calls, provider: config.id, model: selected, latencyMs: performance.now() - started, attempts,
          usage: { inputTokens: response.usage.input + response.usage.cacheRead + response.usage.cacheWrite, outputTokens: response.usage.output, totalTokens: response.usage.totalTokens, cachedInputTokens: response.usage.cacheRead },
          providerState: response, finishReason: response.stopReason,
        };
      } catch (error) {
        signal.throwIfAborted();
        const detail = safeError(error, configs);
        this.updateStatus(config.id, { state: 'bad', detail });
        failures.push(`${config.name}: ${detail}`);
      } finally {
        this.inFlight(config.id, -1);
      }
    }
    const error = new Error(failures.join('; ') || 'No inference provider is configured.') as Error & { attempts: number };
    error.attempts = attempts;
    throw error;
  }
}

/** Read the listing with LittleWhale's complete-body bound, including streamed replies. */
async function readBounded(response: Response): Promise<unknown> {
  const limit = 4 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new Error('Model listing exceeds 4 MiB.');
  }
  if (!response.body) throw new Error('Model listing is empty.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new Error('Model listing exceeds 4 MiB.');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function discoverModels(config: ProviderConfig, signal?: AbortSignal): Promise<ProviderModel[]> {
  if (config.type === 'amazon-bedrock') {
    const client = new BedrockClient({ region: config.region || 'us-east-1', ...(config.apiKey ? { token: { token: config.apiKey } } : {}) });
    try {
      const [foundation, profiles] = await Promise.all([
        client.send(new ListFoundationModelsCommand({ byOutputModality: 'TEXT' }), { abortSignal: signal }),
        client.send(new ListInferenceProfilesCommand({}), { abortSignal: signal }),
      ]);
      return [
        ...(profiles.inferenceProfileSummaries ?? []).map(model => ({ id: model.inferenceProfileId ?? model.inferenceProfileArn ?? '', label: model.inferenceProfileName ?? model.inferenceProfileId ?? '' })),
        ...(foundation.modelSummaries ?? []).filter(model => model.inputModalities?.includes('TEXT')).map(model => ({ id: model.modelId ?? '', label: model.modelName ?? model.modelId ?? '' })),
      ].filter(model => model.id);
    } finally { client.destroy(); }
  }
  // Installed catalog metadata is authoritative for a catalog route at its native endpoint.
  if (config.type === 'openai' && (!config.baseUrl || config.baseUrl === 'https://api.openai.com/v1')) {
    return openaiProvider().getModels().map(model => ({ id: model.id, label: model.name, contextWindow: model.contextWindow }));
  }
  const baseUrl = config.baseUrl || (config.type === 'openrouter' ? 'https://openrouter.ai/api/v1' : 'https://api.openai.com/v1');
  const headers: Record<string, string> = { accept: 'application/json', ...providerHeaders(config) };
  const key = config.tokenless ? '' : config.apiKey || config.vastToken;
  if (key) headers.authorization = `Bearer ${key}`;
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, { headers, signal });
  if (!response.ok) throw new Error(`Model listing answered HTTP ${response.status}.`);
  const body = await readBounded(response) as { data?: unknown[] };
  if (!Array.isArray(body.data)) throw new Error('Model listing has no data array.');
  return body.data.flatMap(raw => {
    if (!raw || typeof raw !== 'object') return [];
    const model = raw as Record<string, unknown>;
    if (typeof model.id !== 'string' || !model.id) return [];
    const capacity = model.context_window ?? model.context_length;
    return [{ id: model.id, label: String(model.name ?? model.display_name ?? model.id),
      ...(Number.isSafeInteger(capacity) && (capacity as number) > 0 ? { contextWindow: capacity as number } : {}),
    }];
  });
}
