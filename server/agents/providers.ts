import { detectTokenLoop, tokenizeLoopText } from '../../vendor/deepseek-harness/loop-detector';

export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string }; }
export interface ProviderConfig {
  id: string;
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
}
export interface CompletionRequest { messages: unknown[]; tools: unknown[]; max_tokens: number; }
export interface CompletionResult {
  provider: string;
  providerName: string;
  model: string;
  content: string | null;
  calls: ToolCall[];
  usage?: unknown;
}

const positive = (value: string | undefined, fallback: number) => {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export function providersFromEnv(env: NodeJS.ProcessEnv = process.env): ProviderConfig[] {
  const providers: ProviderConfig[] = [];
  if (env.OPENROUTER_API_KEY?.trim()) providers.push({
    id: 'openrouter',
    name: 'OpenRouter Free',
    apiKey: env.OPENROUTER_API_KEY.trim(),
    baseUrl: env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
    model: env.OPENROUTER_MODEL ?? 'openrouter/free',
    timeoutMs: positive(env.OPENROUTER_TIMEOUT_MS, 120000),
    headers: { 'X-Title': 'Emergent' },
  });
  if (env.LOCAL_LLM_BASE_URL?.trim()) providers.push({
    id: 'local',
    name: 'Local LM Studio',
    apiKey: env.LOCAL_LLM_API_KEY?.trim() || 'local-lm-studio',
    baseUrl: env.LOCAL_LLM_BASE_URL.trim(),
    model: env.LOCAL_LLM_MODEL?.trim() || 'omnicoder-9b',
  });
  if (!providers.length && env.LLM_API_KEY?.trim()) providers.push({
    id: 'legacy',
    name: 'Configured provider',
    apiKey: env.LLM_API_KEY.trim(),
    baseUrl: env.LLM_BASE_URL ?? 'https://api.deepseek.com',
    model: env.LLM_MODEL ?? 'deepseek-chat',
  });
  return providers;
}

export class ProviderChain {
  constructor(readonly providers: ProviderConfig[]) {}
  get enabled() { return this.providers.length > 0; }
  get cacheKey() { return this.providers.map(provider => `${provider.id}:${provider.model}`).join('->') || 'demo'; }
  get label() { return this.providers.map(provider => `${provider.name} (${provider.model})`).join(' -> ') || 'Scripted demo'; }

  async complete(request: CompletionRequest, signal: AbortSignal, onAttempt: (provider: ProviderConfig, index: number) => void): Promise<CompletionResult> {
    const failures: string[] = [];
    for (const [index, provider] of this.providers.entries()) {
      signal.throwIfAborted();
      onAttempt(provider, index);
      try {
        return await this.request(provider, request, signal);
      } catch (error) {
        signal.throwIfAborted();
        failures.push(error instanceof Error ? error.message : `${provider.name} failed.`);
      }
    }
    throw new Error(`All inference providers are unavailable. ${failures.join(' ')}`);
  }

  private async request(provider: ProviderConfig, request: CompletionRequest, signal: AbortSignal): Promise<CompletionResult> {
    const timeout = provider.timeoutMs ? AbortSignal.timeout(provider.timeoutMs) : undefined;
    const requestSignal = timeout ? AbortSignal.any([signal, timeout]) : signal;
    let response: Response;
    try {
      response = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json', ...provider.headers },
        signal: requestSignal,
        body: JSON.stringify({ ...request, model: provider.model }),
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
    const payload = await response.json() as { model?: string; choices?: { message: { content?: string; tool_calls?: ToolCall[] } }[]; usage?: unknown };
    const answer = payload.choices?.[0]?.message;
    if (!answer) throw new Error(`${provider.name} returned an incomplete response.`);
    const content = typeof answer.content === 'string' ? answer.content.slice(0, 5000) : null;
    if (content && detectTokenLoop(tokenizeLoopText(content))) throw new Error(`${provider.name} returned repeating output.`);
    const calls = answer.tool_calls ?? [];
    if (!Array.isArray(calls) || calls.length > 16 || calls.some(call => typeof call.id !== 'string' || call.type !== 'function' || typeof call.function?.name !== 'string' || typeof call.function?.arguments !== 'string')) {
      throw new Error(`${provider.name} returned invalid tool calls.`);
    }
    return { provider: provider.id, providerName: provider.name, model: payload.model ?? provider.model, content, calls, ...(payload.usage === undefined ? {} : { usage: payload.usage }) };
  }
}
