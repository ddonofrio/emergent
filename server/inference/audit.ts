import type { Completion, CompletionRequest } from '../../vendor/littlewhale';

export const INFERENCE_AUDIT_LIMIT = 256;

/** Diagnostics must never retain another copy of conversations or provider envelopes. */
export function auditRequest(request: CompletionRequest) {
  return { sessionId: request.sessionId, maxTokens: request.maxTokens,
    messageCount: request.messages?.length ?? 0, tools: request.tools?.map(tool => tool.name) ?? [] };
}

export function auditResponse(response: Partial<Completion> & { message?: string; timing?: { startedAt: string; durationMs: number } }) {
  return {
    provider: response.provider, model: response.model, latencyMs: response.latencyMs,
    attempts: response.attempts, usage: response.usage, finishReason: response.finishReason,
    timing: response.timing, message: response.message?.slice(0, 1000),
    tools: response.calls?.map(call => call.name),
  };
}
