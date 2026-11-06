import { balancedCuts, estimateTokens } from './tool-pairing';
import type { Message, SessionRunOptions } from './types';

export const RECENT_STEPS = 10;
export const HISTORY_NOTICE = 'Earlier conversation history is no longer included. Your current intent, private notes, learned knowledge, and recent action results below are your retained context. Use remember to preserve important information for future steps, set_intent to keep your goals and next step current, and recall to search learned knowledge. Do not assume missing details. The current record and observation supersede older snapshots in the recent results.';

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

export function conversationRequest(options: Pick<SessionRunOptions, 'system' | 'schemas' | 'currentContext' | 'contextWindow' | 'maxTokens'>, messages: readonly Message[]) {
  const context = options.currentContext?.();
  const prefix: Message[] = context === undefined ? [] : [{ role: 'user', content: `${HISTORY_NOTICE}\n\n${context}` }];
  const available = Math.max(0, (options.contextWindow ?? 49152) - (options.maxTokens ?? 4096)
    - estimateTokens({ system: options.system, tools: options.schemas, messages: prefix }));
  const recent = recentConversation(messages, available);
  // A fresh host context replaces bootstrap observations when no action has happened yet.
  const history = prefix.length && !recent.some(message => message.role === 'assistant') ? [] : recent;
  return { history, messages: [...prefix, ...history] };
}
