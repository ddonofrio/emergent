import { balancedCuts, estimateTokens } from './tool-pairing';
import type { ContextCompaction, Message, SessionRunOptions, SessionSnapshot } from './types';

export const RECENT_STEPS = 10;
export const COMPACTION_PRESSURE = 0.9;
const RETAINED_PRESSURE = 0.25;
export const HISTORY_NOTICE = 'You are continuing an existing conversation. Your current intent, private notes, learned knowledge, and complete action results are retained below; some earlier transient context may be absent. Use remember to preserve important information for future steps, set_intent to keep your goals and next step current, and recall to search learned knowledge. Do not assume missing details.';
const CURRENT_CONTEXT_NOTICE = 'Current memory record and local observation. This supersedes older snapshots in the conversation.';

/** Keep complete response/tool groups; never replay reasoning or an old checkpoint. */
export function recentConversation(messages: readonly Message[], tokenBudget = Infinity): Message[] {
  let clean = messages.map(({ providerState: _state, ...message }) => structuredClone(message));
  let cuts = balancedCuts(clean);
  const completeEnd = cuts.lastIndexOf(true);
  clean = clean.slice(0, completeEnd);
  cuts = cuts.slice(0, completeEnd + 1);
  const starts = clean.flatMap((message, index) => message.role === 'assistant' && cuts[index] ? [index] : []);
  if (!starts.length) {
    const last = clean.findLast(message => message.role === 'user' && !message.content?.includes('<compacted-summary>'));
    return last && estimateTokens([last]) <= tokenBudget ? [last] : [];
  }
  let first = Math.max(0, starts.length - RECENT_STEPS);
  while (first < starts.length && estimateTokens(clean.slice(starts[first])) > tokenBudget) first++;
  return first < starts.length ? clean.slice(starts[first]) : [];
}

function projectedTokens(estimatedTokens: number, sample?: SessionSnapshot['contextPressure']): number {
  return sample ? Math.max(0, sample.inputTokens + estimatedTokens - sample.estimatedTokens) : estimatedTokens;
}

function requestHistory(history: Message[]): Message[] {
  return history[0]?.role === 'assistant' ? [{ role: 'user', content: HISTORY_NOTICE }, ...history] : history;
}

export function conversationRequest(
  options: Pick<SessionRunOptions, 'system' | 'schemas' | 'currentContext' | 'contextWindow'>,
  messages: readonly Message[],
  sample?: SessionSnapshot['contextPressure'],
): { history: Message[]; messages: Message[]; compaction?: ContextCompaction } {
  const context = options.currentContext?.();
  const current: Message[] = context === undefined ? [] : [{ role: 'user', content: `${CURRENT_CONTEXT_NOTICE}\n\n${context}` }];
  let history = messages.filter(message => !message.content?.includes('<compacted-summary>')).map(message => structuredClone(message));
  // A fresh host context replaces a bootstrap observation when the agent has
  // not produced an action yet.
  if (current.length && !history.some(message => message.role === 'assistant')) history = [];
  const fullMessages = [...requestHistory(history), ...current];
  const estimatedBefore = estimateTokens({ system: options.system, tools: options.schemas, messages: fullMessages });
  const projectedBefore = projectedTokens(estimatedBefore, sample);
  const contextWindow = options.contextWindow ?? 49152;
  // Conversation pressure is measured against the configured context window.
  // Response limits are a separate inference concern and must not shrink the
  // compaction threshold.
  const inputCapacity = contextWindow;
  const thresholdTokens = Math.floor(inputCapacity * COMPACTION_PRESSURE);
  if (projectedBefore < thresholdTokens) return { history, messages: fullMessages };

  // Compact infrequently, then leave enough room for the conversation to grow
  // back toward the pressure threshold instead of trimming on every request.
  const recent = recentConversation(history, Math.max(0, Math.floor(inputCapacity * RETAINED_PRESSURE)));
  const compactedMessages = [...requestHistory(recent), ...current];
  const estimatedAfter = estimateTokens({ system: options.system, tools: options.schemas, messages: compactedMessages });
  const changed = recent.length !== history.length || history.some(message => message.providerState !== undefined);
  if (!changed) return { history, messages: fullMessages };
  return {
    history: recent,
    messages: compactedMessages,
    compaction: {
      pressure: COMPACTION_PRESSURE,
      contextWindow,
      inputCapacity,
      thresholdTokens,
      projectedInputTokensBefore: projectedBefore,
      projectedInputTokensAfter: projectedTokens(estimatedAfter, sample),
      messagesBefore: messages.length,
      messagesAfter: recent.length,
    },
  };
}
