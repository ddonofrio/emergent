/**
 * Headless adaptation of LittleWhale's Session and agent-loop
 * step/tool dispatch cycle. MIT, Copyright (c) DeepSeek. See README.md.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { conversationRequest } from './context-window';
import { estimateTokens } from './tool-pairing';
import type { Complete, Completion, CompletionRequest, Message, SessionMetrics, SessionRunOptions, SessionSnapshot } from './types';

const initialMetrics = (): SessionMetrics => ({ llmCalls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, estimatedInputTokens: 0, latencyMs: 0, retries: 0, compactionCalls: 0 });
const preparedTools = (options: SessionRunOptions) => options.prepareTools?.() ?? { tools: options.tools, schemas: options.schemas };

class SessionPersistenceError extends Error {}

/** A session retains continuation state; a host owns durable world history and time. */
export class PersistentSession {
  private data: SessionSnapshot;
  private running = false;
  private saving: Promise<void> = Promise.resolve();

  constructor(readonly id: string, snapshot?: SessionSnapshot) {
    if (snapshot && (snapshot.version !== 1 || snapshot.id !== id)) throw new Error('Unsupported agent session snapshot.');
    // Pick current fields before cloning so legacy append-only logs are released
    // without copying their entire lifetime of messages and reasoning again.
    this.data = snapshot ? structuredClone({
      version: snapshot.version, id: snapshot.id, messages: snapshot.messages,
      pendingCalls: snapshot.pendingCalls, metrics: snapshot.metrics, compactions: snapshot.compactions,
      ...(snapshot.contextPressure ? { contextPressure: snapshot.contextPressure } : {}),
    }) : {
      version: 1, id, messages: [], pendingCalls: [], metrics: initialMetrics(), compactions: 0,
    };
  }

  snapshot(): SessionSnapshot { return structuredClone(this.data); }
  get metrics(): Readonly<SessionMetrics> { return { ...this.data.metrics }; }

  /** Auxiliary memory work shares accounting, never the acting loop or its barrier. */
  async completeAuxiliary(complete: Complete, request: CompletionRequest, signal: AbortSignal): Promise<Completion> {
    this.data.metrics.llmCalls++;
    this.data.metrics.compactionCalls++;
    const started = performance.now();
    try {
      const response = await complete(request, signal);
      this.recordCompletion(response, request);
      return response;
    } catch (error) {
      this.data.metrics.latencyMs += performance.now() - started;
      this.countFailedAttempts(error);
      throw error;
    }
  }

  appendUser(content: string): void {
    if (this.running) throw new Error('External messages cannot interrupt a running agent session.');
    this.appendMessage({ role: 'user', content });
  }

  private appendMessage(message: Message): void {
    this.data.messages.push(structuredClone(message));
  }

  private async save(options: SessionRunOptions): Promise<void> {
    if (!options.persist) return;
    this.saving = this.saving.catch(() => {}).then(async () => {
      try { await options.persist!(); }
      catch (error) { throw new SessionPersistenceError('Could not persist the agent session.', { cause: error }); }
    });
    await this.saving;
  }

  private recordCompletion(completion: Completion, request: CompletionRequest): void {
    const metrics = this.data.metrics;
    metrics.llmCalls += (completion.attempts ?? 1) - 1;
    metrics.latencyMs += completion.latencyMs;
    if (completion.usage) {
      metrics.inputTokens += completion.usage.inputTokens;
      metrics.outputTokens += completion.usage.outputTokens;
      metrics.cachedInputTokens += completion.usage.cachedInputTokens ?? 0;
      if (request.purpose === 'agent') this.data.contextPressure = {
        inputTokens: completion.usage.inputTokens,
        estimatedTokens: estimateTokens({ system: request.system, tools: request.tools, messages: request.messages }),
      };
    } else metrics.estimatedInputTokens += estimateTokens(request);
  }

  /** Cancellation retains ready results and pending call IDs for a later run. */
  async run(options: SessionRunOptions): Promise<void> {
    if (this.running) throw new Error('This session already has an execution loop.');
    this.running = true;
    const { signal } = options;
    let attempts = 0;
    try {
      await this.save(options);
      while (true) {
        signal.throwIfAborted();
        if (this.data.pendingCalls.length) {
          options.onState?.('tool');
          const tools = preparedTools(options).tools;
          // Dispatch overlaps, publication remains in model order. The world
          // capability enforces physical concurrency and action exclusivity.
          const settled = await Promise.allSettled(this.data.pendingCalls.map(async pending => {
            if (pending.result) return;
            const executor = tools[pending.call.name];
            let result: unknown;
            let isError = false;
            try {
              const resumed = options.resumeTool?.(pending.call, signal);
              if (resumed !== undefined) result = await resumed;
              else {
                if (!executor) throw new Error(`Unknown tool ${pending.call.name}.`);
                result = await executor(pending.call.arguments, pending.call, signal);
              }
              signal.throwIfAborted();
            } catch (error) {
              signal.throwIfAborted();
              isError = true;
              result = { error: error instanceof Error ? error.message : 'Tool execution failed.' };
            }
            pending.result = {
              role: 'tool', toolCallId: pending.call.id, toolName: pending.call.name,
              content: JSON.stringify(result ?? null), ...(isError ? { isError: true } : {}),
            };
            await this.save(options);
          }));
          signal.throwIfAborted();
          const failed = settled.find(result => result.status === 'rejected');
          if (failed?.status === 'rejected') throw failed.reason;
          for (const pending of this.data.pendingCalls) this.appendMessage(pending.result!);
          this.data.pendingCalls = [];
          await this.save(options);
        }

        options.onState?.('thinking');
        try {
          const toolkit = preparedTools(options);
          const context = conversationRequest({ ...options, schemas: toolkit.schemas }, this.data.messages, this.data.contextPressure);
          if (context.compaction) {
            this.data.messages = context.history;
            this.data.compactions++;
            options.onCompaction?.(context.compaction);
          }
          this.data.messages = context.history;
          const request: CompletionRequest = {
            system: options.system, messages: context.messages, tools: toolkit.schemas,
            maxTokens: options.maxTokens ?? 4096, purpose: 'agent', sessionId: this.id,
          };
          this.data.metrics.llmCalls++;
          await this.save(options);
          const started = performance.now();
          let completion: Completion;
          try { completion = await options.complete(request, signal); }
          catch (error) { this.data.metrics.latencyMs += performance.now() - started; this.countFailedAttempts(error); throw error; }
          signal.throwIfAborted();
          this.recordCompletion(completion, request);
          options.onCompletion?.(completion, 'agent');
          if (completion.finishReason === 'length') throw new Error('Model response reached its output limit before completing.');
          // Physical receipt identity must remain unique even when a provider
          // repeats its own wire IDs in a later step. Replay projects these IDs
          // into the adapter's signed response envelope in model order.
          const calls = completion.calls.map(call => ({ ...call, id: `call_${randomUUID().replaceAll('-', '')}` }));
          this.appendMessage({
            role: 'assistant', content: completion.content,
            ...(calls.length ? { toolCalls: calls } : {}),
            ...(completion.providerState === undefined ? {} : { providerState: completion.providerState }),
          });
          this.data.pendingCalls = calls.map(call => ({ call: structuredClone(call) }));
          if (completion.calls.length === 0) {
            this.appendMessage({ role: 'user', content: 'Choose a tool to act, observe, or wait. Your text alone does not change the world.' });
          }
          attempts = 0;
          await this.save(options);
        } catch (error) {
          if (error instanceof SessionPersistenceError) throw error;
          signal.throwIfAborted();
          attempts++;
          this.data.metrics.retries++;
          const message = error instanceof Error ? error.message : 'Inference unavailable.';
          await this.save(options);
          options.onState?.('retrying', message);
          await delay(Math.min(10000, (options.retryDelayMs ?? 1000) * 2 ** Math.min(attempts - 1, 4)), undefined, { signal });
        }
      }
    } finally {
      this.running = false;
      options.onState?.('stopped');
    }
  }

  private countFailedAttempts(error: unknown): void {
    const attempts = (error as { attempts?: number } | null)?.attempts;
    if (typeof attempts === 'number' && Number.isSafeInteger(attempts) && attempts >= 0) this.data.metrics.llmCalls += attempts - 1;
  }
}
