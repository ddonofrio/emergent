import type { DecisionStatus } from '../../src/core/time';

/** A clock participant can hold the barrier, but can never advance world time. */
export interface WorldConnection {
  resume(): void;
  suspend(): void;
  ready(): boolean;
  commit(): void;
  afterStep(): void;
  status(): Record<string, DecisionStatus>;
  close(): void;
}

export const disconnectedWorld: WorldConnection = {
  resume() {}, suspend() {}, ready: () => true, commit() {}, afterStep() {},
  status: () => ({}), close() {},
};
