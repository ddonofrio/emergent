/**
 * Headless adaptation of LittleWhale compaction-basic/{region,summarizer}.ts.
 * MIT, Copyright (c) DeepSeek. See README.md for the exact adaptation boundary.
 */
import { estimateTokens, selectCompactableRange } from './tool-pairing';
import type { Complete, Completion, Message, SessionRunOptions } from './types';

const COMPACTION_INSTRUCTION = [
  'Act as a compaction engine for this embodied agent. Condense the conversation above into a checkpoint that preserves its essential context.',
  'Output concise English bullets under these headings, in order: Self-authored goals and success conditions; Known local facts; Decisions and action results; Current work and pending action IDs; Private notes; Next step.',
  'Use (none) for empty sections. Preserve exact entity IDs, action IDs, coordinates, quantities, errors, utterances when relevant, and the agent\'s own goals.',
  'Include only information already present. Preserve uncertainty and distinguish observations from guesses. Never invent discoveries, actions, achievements, or goals.',
  'Merge any previous checkpoint with newer information, dropping stale facts. Retain at most ten private notes.',
  'Output only the checkpoint text. Do not call tools or take another action.',
].join('\n');

const CHECKPOINT_PREAMBLE = 'This checkpoint condenses earlier conversation. Treat it as established background and continue from the messages that follow without restating it.';

export function frameSummary(summary: string): Message {
  return { role: 'user', content: `${CHECKPOINT_PREAMBLE}\n\n<compacted-summary>\n${summary}\n</compacted-summary>` };
}

/** Replay the original prefix, then append the directive to preserve cache reuse. */
export async function summarizeWithLlm(
  complete: Complete,
  options: Pick<SessionRunOptions, 'system' | 'schemas' | 'signal'>,
  messages: Message[],
  sessionId: string,
  maxOutputTokens: number,
): Promise<Completion> {
  const completion = await complete({
    system: options.system,
    messages: [...messages, { role: 'user', content: COMPACTION_INSTRUCTION }],
    tools: options.schemas,
    maxOutputTokens,
    sessionId,
    purpose: 'compaction',
  }, options.signal);
  if (completion.finishReason === 'length') throw new Error('Compaction summary was truncated.');
  if (completion.calls.length || !completion.content?.trim()) throw new Error('Compaction produced no text-only checkpoint.');
  return completion;
}

export function compactablePrefix(options: SessionRunOptions, messages: Message[]): number {
  const contextWindow = options.contextWindow ?? 49152;
  const outputTokens = options.maxOutputTokens ?? 4096;
  const available = contextWindow - outputTokens;
  const requestTokens = estimateTokens({ system: options.system, tools: options.schemas, messages });
  if (requestTokens < available * 0.75) return 0;
  return selectCompactableRange(messages, Math.max(256, Math.floor(available * 0.25)));
}
