import { TURN_TICKS } from './time';
import type { Entity } from './types';

export const SPEECH_WORD_LIMIT = 3;
const words = new Intl.Segmenter('en', { granularity: 'word' });
export const speechWordCount = (text: string) => [...words.segment(text)].filter(part => part.isWordLike).length;
// Decisions commit on the first physics tick of their shared turn.
export const speechTurn = (tick: number) => Math.floor(Math.max(0, tick - 1) / TURN_TICKS);
export const speechWordsRemaining = (entity: Entity, tick: number) => SPEECH_WORD_LIMIT - (entity.speechBudget?.turn === speechTurn(tick) ? entity.speechBudget.words : 0);
export function speechProblem(text: unknown, remaining = SPEECH_WORD_LIMIT) {
  if (typeof text !== 'string' || !text.trim() || !speechWordCount(text)) return 'Say one to three words of your choice.';
  const count = speechWordCount(text);
  if (count > remaining) return `You have ${remaining} words left this turn; this phrase contains ${count}. Say a shorter phrase.`;
  return undefined;
}
