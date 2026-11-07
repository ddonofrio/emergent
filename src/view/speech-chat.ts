import type { Entity, WorldEvent } from '../core/types';

export const CHAT_LIFETIME_MS = 8000;
const CHAT_LINE_LIMIT = 8;
const speakerColors = ['#bce6ad', '#a9cdff', '#f5b8a5', '#dcc0ff', '#a7e1db', '#f1c68f'];
export interface ChatLine {
  id: number;
  name: string;
  text: string;
  color: string;
  received: number;
}
export function speechMessageKey(event: WorldEvent): string | undefined {
  const word = (event.data as { word?: unknown } | undefined)?.word;
  return event.type === 'speech' && typeof word === 'string' ? JSON.stringify([event.actor, word]) : undefined;
}
export function speechChatLine(event: WorldEvent, entities: Pick<Entity, 'id' | 'name'>[], now: number): ChatLine | undefined {
  if (event.type !== 'speech') return;
  const data = event.data as { word?: unknown; speakerName?: unknown; broadcast?: boolean } | undefined;
  if (typeof data?.word !== 'string') return;
  const index = entities.findIndex(entity => entity.id === event.actor);
  return { id: event.id, name: typeof data.speakerName === 'string' ? data.speakerName : entities[index]?.name ?? event.actor,
    text: data.word, color: data.broadcast ? '#ffe59a' : speakerColors[Math.max(0, index) % speakerColors.length], received: now };
}

/** Display time stays independent of the simulation's decision barrier. */
export class SpeechChat {
  private seen = new Set<number>();
  private messages = new Set<string>();
  private lines: ChatLine[] = [];
  add(events: WorldEvent[], entities: Pick<Entity, 'id' | 'name'>[], now: number) {
    for (const event of events) {
      if (event.type !== 'speech' || this.seen.has(event.id)) continue;
      const line = speechChatLine(event, entities, now);
      if (!line) continue;
      this.seen.add(event.id);
      const message = speechMessageKey(event)!;
      if (this.messages.has(message)) continue;
      this.messages.add(message);
      this.lines.push(line);
    }
    this.lines = this.lines.slice(-CHAT_LINE_LIMIT);
    if (this.seen.size > 512) this.seen = new Set([...this.seen].slice(-256));
  }
  visible(now: number) { return this.lines.filter(line => now - line.received < CHAT_LIFETIME_MS); }
  reset() { this.lines = []; this.seen.clear(); this.messages.clear(); }
}
