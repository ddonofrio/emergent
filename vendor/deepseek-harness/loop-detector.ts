/** Pure token-like repeated-output detection used by the concrete agent loop. */


/** Stream categories that may contribute to repeated-output detection. */
export interface LoopDetectionStreamSelection {
  text: boolean
  reasoning: boolean
  toolCall: boolean
}

/** A block repeated three times at the end of a model response. */
export interface TokenLoop {
  /** Index where the repeated suffix starts. */
  start: number
  /** Number of token-like units in one repetition. */
  length: number
  /** The repeated token-like units. */
  block: readonly string[]
}

/**
 * Find a block that occurs three times consecutively at the end of `tokens`.
 *
 * The stream vocabulary does not expose provider tokenizer ids, so the loop
 * uses stable word/punctuation units. This keeps detection provider-neutral
 * while still spanning arbitrary stream chunk boundaries.
 * @param tokens - token-like units from one assistant response.
 * @param minimumLength - shortest repeated block to accept.
 * @returns the repeated suffix, or `undefined` when no loop is present.
 */
export function detectTokenLoop(tokens: readonly string[], minimumLength = 5): TokenLoop | undefined {
  const total = tokens.length
  for (let length = minimumLength; length <= Math.floor(total / 3); length += 1) {
    const start = total - 3 * length
    const first = tokens.slice(start, start + length)
    const second = tokens.slice(start + length, start + 2 * length)
    const third = tokens.slice(start + 2 * length)
    if (first.every((token, index) => token === second[index] && token === third[index])) {
      return { start, length, block: first }
    }
  }
  return undefined
}

/** Split model content into provider-neutral token-like units. */
export function tokenizeLoopText(text: string): string[] {
  return text.match(/\p{L}[\p{L}\p{M}\p{N}_]*|\p{N}+|[^\p{L}\p{N}\s]/gu) ?? []
}


