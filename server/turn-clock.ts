import type { Engine } from '../src/core/engine';
import { FRAME_TICKS, STEP_MS, TURN_TICKS, type DecisionStatus, type TurnStatus } from '../src/core/time';
import type { AgentRuntime, PreparedTurn } from './agents/runtime';

/** One barrier, one commit, twenty physics steps. Wall time only paces presentation. */
export class TurnClock {
  private phase: TurnStatus['phase'];
  private enabled = true;
  private decisions: Record<string, DecisionStatus> = {};
  private pending?: AbortController;
  private prepared?: PreparedTurn;
  private endTick = 0;
  private previous = 0;
  private closed = false;
  constructor(readonly engine: Engine, readonly agents: AgentRuntime, readonly hooks: {
    frame(): void;
    status(): void;
    fatal(error: unknown): void;
  }, private readonly now: () => number = () => performance.now()) {
    // A restart inside an already committed turn finishes its remaining physics.
    const remainder = engine.tick % TURN_TICKS;
    this.phase = remainder ? 'advancing' : 'idle';
    this.endTick = remainder ? engine.tick + TURN_TICKS - remainder : engine.tick;
    this.previous = now();
  }
  status(): TurnStatus {
    return { phase: this.phase, enabled: this.enabled, turn: this.phase === 'advancing' ? this.endTick / TURN_TICKS : Math.floor(this.engine.tick / TURN_TICKS) + 1, tick: this.engine.tick, agents: { ...this.decisions } };
  }
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled && this.phase !== 'advancing') {
      this.pending?.abort(); this.pending = undefined; this.prepared = undefined; this.phase = 'paused'; this.decisions = {};
    } else if (enabled && this.phase === 'paused') this.phase = 'idle';
    // Once committed, finish the single second before pausing. Never commit half a decision set.
    this.hooks.status();
  }
  pump() {
    if (this.closed) return;
    if (this.phase === 'advancing') {
      const now = this.now();
      while (now - this.previous >= STEP_MS && this.engine.tick < this.endTick) {
        this.previous += STEP_MS;
        const prepared = this.prepared; this.prepared = undefined;
        this.engine.step(prepared ? () => this.agents.commit(prepared) : undefined);
        if (this.engine.tick % FRAME_TICKS === 0) this.hooks.frame();
      }
      if (this.engine.tick === this.endTick) {
        this.phase = this.enabled ? 'idle' : 'paused'; this.decisions = {}; this.hooks.status();
      }
      return;
    }
    if (!this.enabled || this.pending || this.phase === 'limited') return;
    if (!this.agents.canAdvance()) { this.phase = 'limited'; this.hooks.status(); return; }
    const controller = new AbortController(); this.pending = controller; this.phase = 'thinking'; this.decisions = {};
    this.hooks.status();
    void this.agents.prepareTurn(controller.signal, (id, status) => {
      if (this.pending !== controller || controller.signal.aborted) return;
      this.decisions[id] = status; this.hooks.status();
    }).then(prepared => {
      if (this.closed || this.pending !== controller || controller.signal.aborted) return;
      this.pending = undefined; this.prepared = prepared; this.endTick = prepared.tick + TURN_TICKS;
      this.previous = this.now(); this.phase = 'advancing'; this.hooks.status();
    }).catch(error => {
      if (!controller.signal.aborted && !this.closed) this.hooks.fatal(error);
    });
  }
  close() { this.closed = true; this.pending?.abort(); this.pending = undefined; }
}
