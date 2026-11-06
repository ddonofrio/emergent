/** Headless adaptation contracts. See README.md for source provenance. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface Message {
  role: 'user' | 'assistant' | 'tool';
  content: string | null;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  /** Adapter-owned response data (including reasoning signatures), never credentials. */
  providerState?: unknown;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
}

export interface CompletionRequest {
  system: string;
  messages: Message[];
  tools: ToolSchema[];
  maxTokens: number;
  purpose: 'agent' | 'compaction';
  sessionId?: string;
}

export interface Completion {
  content: string | null;
  calls: ToolCall[];
  provider: string;
  model: string;
  latencyMs: number;
  /** Physical provider attempts, including ordered fallback. Defaults to one. */
  attempts?: number;
  usage?: TokenUsage;
  providerState?: unknown;
  finishReason?: 'stop' | 'length' | 'toolUse';
}

export type Complete = (request: CompletionRequest, signal: AbortSignal) => Promise<Completion>;
export type ToolExecutor = (args: Record<string, unknown>, call: ToolCall, signal: AbortSignal) => Promise<unknown>;

export interface SessionMetrics {
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** Requests without provider usage are counted separately from measured tokens. */
  estimatedInputTokens: number;
  latencyMs: number;
  retries: number;
  compactionCalls: number;
}

export type SessionState = 'thinking' | 'compacting' | 'tool' | 'retrying' | 'stopped';
export interface PendingCall {
  call: ToolCall;
  /** A result is persisted as soon as it settles, before model-order publication. */
  result?: Message;
}

export interface SessionEvent {
  seq: number;
  type: 'user/message' | 'assistant/message' | 'tool/result' | 'compaction/start' | 'compaction/end' | 'llm/retry';
  data: unknown;
}

export interface SessionSnapshot {
  version: 1;
  id: string;
  /** Compactable model surface. Original messages remain in events. */
  messages: Message[];
  events: SessionEvent[];
  pendingCalls: PendingCall[];
  metrics: SessionMetrics;
  compactions: number;
  /** Provider-reported prompt pressure anchored to the request estimate it measured. */
  contextPressure?: { inputTokens: number; estimatedTokens: number };
}

export interface SessionRunOptions {
  complete: Complete;
  tools: Record<string, ToolExecutor>;
  schemas: ToolSchema[];
  /** Rebuild state-dependent tools immediately before dispatch or inference. */
  prepareTools?: () => { tools: Record<string, ToolExecutor>; schemas: ToolSchema[] };
  /** Rebind an existing operation even when its tool is no longer offered for new calls. */
  resumeTool?: (call: ToolCall, signal: AbortSignal) => Promise<unknown> | undefined;
  system: string;
  signal: AbortSignal;
  persist?: (snapshot: SessionSnapshot) => void | Promise<void>;
  onState?: (state: SessionState, detail?: string) => void;
  onCompletion?: (completion: Completion, purpose: CompletionRequest['purpose']) => void;
  contextWindow?: number;
  maxTokens?: number;
  retryDelayMs?: number;
}
