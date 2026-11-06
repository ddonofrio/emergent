/**
 * Adapted from LittleWhale packages/compaction/compaction/src/tool-pairing.ts.
 * MIT, Copyright (c) DeepSeek. The headless surface uses message indices.
 */
import type { Message } from './types';

/** Every true entry describes a cut with no assistant/tool pair crossing it. */
export function balancedCuts(messages: readonly Message[]): boolean[] {
  const cuts = [true];
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) {
        if (pending.has(call.id)) throw new Error(`Duplicate pending tool call ${call.id}.`);
        pending.add(call.id);
      }
    } else if (message.role === 'tool') {
      if (!message.toolCallId || !pending.delete(message.toolCallId)) {
        throw new Error('Tool result has no matching assistant call.');
      }
    }
    cuts.push(pending.size === 0);
  }
  return cuts;
}

/** Pressure estimate only; provider-reported usage is recorded independently. */
export function estimateTokens(value: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8') / 3);
}
