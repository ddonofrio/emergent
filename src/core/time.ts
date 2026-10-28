export const TICKS_PER_SECOND = 20;
export const TURN_TICKS = TICKS_PER_SECOND;
export const FRAME_TICKS = 2;
export const STEP_MS = 1000 / TICKS_PER_SECOND;
export const WORLD_DAY_SECONDS = 24 * 60 * 60;
export const CLOCK_VERSION = 'lockstep-v1';

export function worldTime(tick: number) {
  const totalSeconds = Math.max(0, tick) / TICKS_PER_SECOND;
  const wholeSeconds = Math.floor(totalSeconds);
  return {
    totalSeconds,
    day: Math.floor(wholeSeconds / WORLD_DAY_SECONDS) + 1,
    hour: Math.floor(wholeSeconds % WORLD_DAY_SECONDS / 3600),
    minute: Math.floor(wholeSeconds % 3600 / 60),
    second: wholeSeconds % 60,
    tenth: Math.floor(totalSeconds * 10) % 10,
  };
}

export function formatWorldDuration(tick: number, tenths = false) {
  const value = worldTime(tick), days = value.day - 1;
  const clock = `${String(value.hour).padStart(2,'0')}:${String(value.minute).padStart(2,'0')}:${String(value.second).padStart(2,'0')}${tenths ? `.${value.tenth}` : ''}`;
  return days ? `${days}d ${clock}` : clock;
}

export interface DecisionStatus {
  state: 'planning' | 'thinking' | 'waiting' | 'ready' | 'moving' | 'disabled' | 'turn limit';
  attempts?: number;
  message?: string;
}
export interface TurnStatus {
  phase: 'idle' | 'thinking' | 'advancing' | 'paused';
  enabled: boolean;
  turn: number;
  tick: number;
  agents: Record<string, DecisionStatus>;
}
