import type { Engine } from '../src/core/engine';
import { FRAME_TICKS, STEP_MS, TURN_TICKS, type TurnStatus } from '../src/core/time';
import { disconnectedWorld, type WorldConnection } from './simulation/connection';

/** The sole owner of time. Connections only open or close the decision barrier. */
export class TurnClock {
  private enabled = false;
  private closed = false;
  private previous: number;
  private endTick: number;
  private phase: TurnStatus['phase'] = 'paused';
  constructor(readonly engine: Engine, readonly connection: WorldConnection = disconnectedWorld, readonly hooks: {
    frame(): void;
    status(): void;
    fatal(error: unknown): void;
  }, private now: () => number = () => performance.now()) {
    this.previous = now();
    this.endTick = engine.tick % TURN_TICKS ? Math.ceil(engine.tick / TURN_TICKS) * TURN_TICKS : engine.tick;
  }
  status(): TurnStatus {
    return { enabled: this.enabled, phase: this.phase, tick: this.engine.tick,
      turn: Math.floor(this.engine.tick / TURN_TICKS) + 1, agents: this.connection.status() };
  }
  setEnabled(enabled: boolean) {
    if (this.closed) return;
    this.enabled = enabled; this.previous = this.now();
    if (enabled) { this.connection.resume(); this.phase = 'idle'; }
    else { this.connection.suspend(); this.phase = 'paused'; this.hooks.frame(); }
    this.hooks.status();
  }
  entityChanged() {
    if (this.enabled) this.connection.resume();
    this.previous = this.now(); this.hooks.status();
  }
  /** Called synchronously on model-state changes, even between timer pumps. */
  barrierChanged() {
    this.previous = this.now();
    if (this.enabled && !this.connection.ready()) this.phase = 'thinking';
  }
  pump() {
    if (this.closed || !this.enabled) return;
    try {
      this.connection.resume();
      // Resolving a tool closes the barrier before its promise continuation runs.
      if (!this.connection.ready()) { this.hold(); return; }
      this.connection.commit();
      if (!this.connection.ready()) { this.hold(); return; }
      if (this.phase !== 'advancing') {
        if (this.phase === 'thinking') this.previous = this.now();
        this.phase = 'advancing'; this.hooks.status();
      }
      if (this.engine.tick >= this.endTick) this.endTick = this.engine.tick + TURN_TICKS;
      const now = this.now();
      while (now - this.previous >= STEP_MS && this.engine.tick < this.endTick) {
        this.previous += STEP_MS;
        this.engine.step(); this.connection.afterStep();
        if (this.engine.tick % FRAME_TICKS === 0) this.hooks.frame();
        if (!this.connection.ready()) { this.hold(); return; }
      }
      if (this.engine.tick === this.endTick) { this.phase = 'idle'; this.hooks.status(); }
    } catch (error) { this.hooks.fatal(error); }
  }
  private hold() {
    this.previous = this.now();
    if (this.phase !== 'thinking') { this.phase = 'thinking'; this.hooks.status(); }
  }
  close() {
    this.closed = true; this.enabled = false; this.connection.close(); this.phase = 'paused';
  }
}
