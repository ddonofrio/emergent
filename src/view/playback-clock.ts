import { TICKS_PER_SECOND } from '../core/time';

// An empty buffer never accumulates time debt. Resuming cannot accelerate creatures.
export function advancePlayback(tick: number, elapsedMs: number, speed: number, availableTick: number) {
  return Math.min(availableTick, tick + Math.max(0, elapsedMs) / 1000 * TICKS_PER_SECOND * speed);
}
