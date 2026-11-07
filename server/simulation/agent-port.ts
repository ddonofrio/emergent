import type { Action, ActionResult, AgentIntent, AgentMemoryRecord, Entity, Observation, Vec3 } from '../../src/core/types';
import type { ItemCapability } from '../../src/core/crafting';

export const wakeEventTypes = ['speech', 'encounter', 'discovery', 'terrain', 'block-impact', 'collision', 'blocked', 'arrived', 'scanned', 'follow-ended', 'follow-blocked', 'rebound-ended', 'action-completed', 'action-blocked', 'action-cancelled', 'action-rejected'] as const;
export interface WaitOptions { actionId?: string; seconds?: number; eventTypes?: (typeof wakeEventTypes)[number][]; }
export interface BodyActivity { id: string; kind: string; untilTick?: number; }
export interface ContextCompactionDetails {
  pressure: number;
  contextWindow: number;
  inputCapacity: number;
  thresholdTokens: number;
  projectedInputTokensBefore: number;
  projectedInputTokensAfter: number;
  messagesBefore: number;
  messagesAfter: number;
}

export interface PerceivedEvent {
  id: number;
  tick: number;
  type: string;
  message: string;
  data?: unknown;
}
export interface SimulationAction {
  id: string;
  callId: string;
  kind: string;
  channel: 'movement' | 'speech' | 'perception' | 'body';
  status: 'queued' | 'running' | 'completed' | 'blocked' | 'cancelled' | 'rejected';
  createdTick: number;
  startedTick?: number;
  finishedTick?: number;
  origin: Vec3;
  position: Vec3;
  target?: Vec3;
  distanceTravelled: number;
  remainingDistance: number;
  physicalActive?: boolean;
  motion?: Entity['motion'];
  result?: ActionResult;
  attemptedFailure?: boolean;
  command: Action | { action: 'cancel'; actionId: string };
  dueTick?: number;
  finishedEventId?: number;
}
export type ActionProgress = Pick<SimulationAction, 'id' | 'kind' | 'channel' | 'status' | 'position' | 'target' | 'distanceTravelled' | 'remainingDistance' | 'physicalActive' | 'result'>;
export interface ToolOutcome {
  tick: number;
  position: Vec3;
  motion?: Entity['motion'];
  following?: Entity['following'];
  reason: 'completed' | 'event' | 'timeout' | 'rejected';
  action?: ActionProgress;
  actions: ActionProgress[];
  events: PerceivedEvent[];
}

/** An entity-scoped capability. The agent runtime never receives the engine. */
export interface AgentPort {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly instructions: string;
  readonly tick: number;
  active(): boolean;
  observe(angle?: number): Observation;
  knowledge(angle?: number): string[];
  lookCount(turn?: number): number;
  remainingSpeechWords(): number;
  recall(query: string): { facts: string[]; total: number };
  capabilities(view: Observation): ItemCapability[];
  bodyActivity(): BodyActivity | undefined;
  resume(callId: string, signal: AbortSignal): Promise<ToolOutcome> | undefined;
  inspectJump(angle: number, distance: number): unknown;
  submit(callId: string, action: Action, signal: AbortSignal): Promise<ToolOutcome>;
  cancel(callId: string, actionId: string, signal: AbortSignal): Promise<ToolOutcome>;
  wait(callId: string, options: WaitOptions, signal: AbortSignal): Promise<ToolOutcome>;
  yieldTurn(callId: string, signal: AbortSignal): Promise<ToolOutcome>;
  recordContextCompaction(details: ContextCompactionDetails): void;
  recordMemoryCompaction(details?: Record<string, unknown>): void;
  recordMemory(record: AgentMemoryRecord, source: 'write' | 'compaction'): void;
  setIntent(intent: AgentIntent): void;
  remember(notes: string[]): void;
  waiting(): boolean;
}
