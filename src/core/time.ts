export const TICKS_PER_SECOND = 20;
export const TURN_TICKS = TICKS_PER_SECOND;
export const FRAME_TICKS = 2;
export const STEP_MS = 1000 / TICKS_PER_SECOND;
export const CLOCK_VERSION = 'lockstep-v1';

export interface DecisionStatus {
  state: 'thinking' | 'waiting' | 'ready' | 'moving' | 'disabled' | 'turn limit';
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
