import type { Engine } from '../../src/core/engine';
import { knowledgeDescription } from '../../src/core/knowledge';
import { itemCapabilities } from '../../src/core/crafting';
import { TURN_TICKS, TICKS_PER_SECOND } from '../../src/core/time';
import { clone, distance, type Action, type WorldEvent } from '../../src/core/types';
import type { ActionProgress, AgentPort, PerceivedEvent, SimulationAction, ToolOutcome, WaitOptions } from './agent-port';

interface WaitRequest { callId: string; actionId?: string; untilTick?: number; eventTypes?: WaitOptions['eventTypes']; }
interface EntityTasks {
  sequence: number;
  actions: SimulationAction[];
  events: PerceivedEvent[];
  seen: number[];
  requests: WaitRequest[];
  receipts: Record<string, ToolOutcome>;
}
interface Waiter { request: WaitRequest; resolve(value: ToolOutcome): void; reject(error: unknown): void; dispose(): void; }
export interface BridgeSnapshot { entities: Record<string, EntityTasks>; }
const moving = new Set<Action['action']>(['walk', 'run', 'reverse', 'jump', 'follow']);
const scanning = new Set<Action['action']>(['find_material', 'find_entity']);
const motionTask = (action: SimulationAction) => action.channel === 'movement' || (action.command.action !== 'cancel' && scanning.has(action.command.action));
const terminal = (action: SimulationAction) => !['queued', 'running'].includes(action.status);
const ongoing = (action: SimulationAction) => !terminal(action) || action.physicalActive === true;
const ACTION_HISTORY_LIMIT = 200;
const RECEIPT_HISTORY_LIMIT = 1024;
const SEEN_EVENT_LIMIT = 1024;

/** Persistent simulation tasks outlive individual tool responses and model requests. */
export class AgentBridge {
  private entities: Record<string, EntityTasks>;
  private waiters = new Map<string, Map<string, Waiter>>();
  private unsubscribe: () => void;
  private dirty = false;
  private flushScheduled = false;
  private closed = false;
  constructor(private engine: Engine, snapshot?: BridgeSnapshot, private checkpoint: () => void = () => {}) {
    this.entities = clone(snapshot?.entities ?? {});
    for (const entity of engine.entities.filter(entity => entity.controller === 'agent')) {
      this.entities[entity.id] ??= { sequence: 0, actions: [], events: [], seen: [], requests: [], receipts: {} };
    }
    this.unsubscribe = engine.subscribeEvents(event => this.collectEvent(event));
    for (const id of Object.keys(this.entities)) engine.learnHeldItem(id);
  }
  snapshot(): BridgeSnapshot { return clone({ entities: this.entities }); }
  get tick() { return this.engine.tick; }
  ports(): AgentPort[] {
    return this.engine.entities.filter(entity => entity.controller === 'agent').map(entity => {
      const id = entity.id, engine = this.engine;
      return {
        id, name: entity.name, kind: entity.kind, instructions: this.engine.module.manifest.agentInstructions,
        get tick() { return engine.tick; },
        active: () => this.engine.active(this.engine.entity(id)),
        observe: (angle = 0) => this.engine.observeAt(id, angle),
        knowledge: (angle = 0) => {
          const observation = this.engine.observeAt(id, angle);
          return [...(this.engine.discoveries.get(id) ?? [])]
            .filter(knowledge => this.engine.module.relevantKnowledge?.(observation, knowledge) ?? true)
            .map(knowledge => knowledgeDescription(knowledge, this.engine.module.crafting));
        },
        capabilities: view => itemCapabilities(this.engine.module.crafting, view),
        recall: query => {
          const terms = query.toLowerCase().trim().split(/\s+/);
          const facts = [...(this.engine.discoveries.get(id) ?? [])].flatMap(key => {
            const description = knowledgeDescription(key, this.engine.module.crafting);
            return terms.every(term => `${key} ${description}`.toLowerCase().includes(term)) ? [description] : [];
          });
          return { facts: facts.slice(0, 20), total: facts.length };
        },
        bodyActivity: () => {
          const action = this.state(id).actions.find(action => action.channel === 'body'
            && (action.status === 'queued' || action.status === 'running' && (action.physicalActive || action.dueTick! > this.engine.tick)));
          return action ? { id: action.id, kind: action.kind, ...(action.dueTick === undefined ? {} : { untilTick: action.dueTick }) } : undefined;
        },
        inspectJump: (angle, metres) => this.engine.inspectJump(id, angle, metres),
        resume: (callId, signal) => {
          if (this.closed) return Promise.reject(new Error('Simulation connection is closed.'));
          signal.throwIfAborted();
          const state = this.state(id);
          if (state.receipts[callId]) return Promise.resolve(clone(state.receipts[callId]));
          const action = state.actions.find(action => action.callId === callId);
          const request = state.requests.find(request => request.callId === callId);
          return request || action ? this.bind(id, request ?? { callId, actionId: action!.id }, signal) : undefined;
        },
        submit: (callId, command, signal) => this.submit(id, callId, command, signal),
        cancel: (callId, actionId, signal) => this.submit(id, callId, { action: 'cancel', actionId }, signal),
        wait: (callId, options, signal) => this.wait(id, callId, options, signal),
        setIntent: intent => { this.engine.entity(id).intent = clone(intent); this.engine.event(id, 'intent', intent.goal, { intent }); this.checkpoint(); },
        remember: notes => { this.engine.event(id, 'memory', 'Updated private notes.', { notes }); this.checkpoint(); },
        waiting: () => (this.waiters.get(id)?.size ?? 0) > 0
          && (this.state(id).actions.some(action => action.status === 'queued')
            || ![...this.waiters.get(id)!.values()].some(waiter => this.hasWakeEvent(waiter.request, this.state(id).events))),
      };
    });
  }
  private state(id: string) { return this.entities[id]; }
  private submit(id: string, callId: string, command: SimulationAction['command'], signal: AbortSignal) {
    if (this.closed) return Promise.reject(new Error('Simulation connection is closed.'));
    signal.throwIfAborted();
    const state = this.state(id);
    if (state.receipts[callId]) return Promise.resolve(clone(state.receipts[callId]));
    let action = state.actions.find(action => action.callId === callId);
    if (!action) {
      const position = clone(this.engine.entity(id).position);
      action = { id: `${id}:${++state.sequence}`, callId, command: clone(command), kind: command.action,
        channel: command.action === 'say' ? 'speech' : command.action !== 'cancel' && moving.has(command.action) ? 'movement' : 'body',
        status: 'queued', createdTick: this.engine.tick, origin: position, position: clone(position), distanceTravelled: 0, remainingDistance: 0 };
      state.actions.push(action); this.dirty = true;
    }
    return this.bind(id, { callId, actionId: action.id }, signal);
  }
  private wait(id: string, callId: string, options: WaitOptions, signal: AbortSignal) {
    if (this.closed) return Promise.reject(new Error('Simulation connection is closed.'));
    signal.throwIfAborted();
    const state = this.state(id);
    if (state.receipts[callId]) return Promise.resolve(clone(state.receipts[callId]));
    if (options.actionId && !state.actions.some(action => action.id === options.actionId)) {
      return Promise.resolve(this.outcome(id, 'rejected', undefined, [{ id: 0, tick: this.engine.tick, type: 'error', message: 'Unknown action ID for this entity.' }]));
    }
    const previous = state.requests.find(request => request.callId === callId);
    return this.bind(id, previous ?? { callId, actionId: options.actionId,
      ...(options.eventTypes === undefined ? {} : { eventTypes: [...options.eventTypes] }),
      ...(options.seconds === undefined ? {} : { untilTick: this.engine.tick + Math.max(1, Math.ceil(options.seconds * TICKS_PER_SECOND)) }) }, signal);
  }
  private hasWakeEvent(request: WaitRequest, events: PerceivedEvent[]) {
    return events.some(event => {
      if (request.eventTypes !== undefined
        && !request.eventTypes.includes(event.type as NonNullable<WaitOptions['eventTypes']>[number])) return false;
      if (!request.actionId || !event.type.startsWith('action-')) return true;
      const data = event.data as { actionId?: string; action?: { id?: string } } | undefined;
      const eventActionId = data?.actionId ?? data?.action?.id;
      return eventActionId === undefined || eventActionId === request.actionId;
    });
  }
  private bind(id: string, request: WaitRequest, signal: AbortSignal): Promise<ToolOutcome> {
    const state = this.state(id);
    if (!state.requests.some(previous => previous.callId === request.callId)) state.requests.push(clone(request));
    this.dirty = true;
    return new Promise((resolve, reject) => {
      const waiters = this.waiters.get(id) ?? new Map<string, Waiter>(); this.waiters.set(id, waiters);
      const abort = () => { waiters.delete(request.callId); reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
      waiters.set(request.callId, { request, resolve, reject, dispose: () => signal.removeEventListener('abort', abort) });
      // Group synchronous parallel tool calls before distributing an already queued event batch.
      this.scheduleFlush();
    });
  }
  commit() {
    if (this.closed) return;
    const ids = Object.keys(this.entities).sort();
    const offset = Math.floor(this.engine.tick / TURN_TICKS) % Math.max(1, ids.length);
    for (const id of [...ids.slice(offset), ...ids.slice(0, offset)]) {
      let movementCommitted = false;
      for (const action of this.state(id).actions.filter(action => action.status === 'queued')) {
        const entity = this.engine.entity(id), command = action.command;
        const immediateControl = command.action === 'cancel' || command.action === 'stop_follow';
        const bodyBusy = this.state(id).actions.find(other => other.id !== action.id && other.channel === 'body'
          && other.status === 'running' && (other.physicalActive || other.dueTick! > this.engine.tick));
        if (!immediateControl && action.channel !== 'speech' && bodyBusy) {
          action.result = { ok: false, message: `Your body is busy with ${bodyBusy.id} until world tick ${bodyBusy.dueTick}. Wait for its completion before starting another body or movement action.` };
        } else if (action.channel === 'body' && !immediateControl && (entity.motion || entity.following)) {
          action.result = { ok: false, message: 'Body interactions require a stationary body. Wait for movement to finish or explicitly cancel it. Speech can continue during movement.' };
        } else if (action.channel === 'movement' && movementCommitted) {
          action.result = { ok: false, message: 'Only one movement operation can start in the same tool batch. Replace its destination with a later tool call after receiving a result.' };
        }
        if (!action.result && (action.channel === 'movement' || immediateControl)) {
          const previous = this.state(id).actions.filter(previous => previous.id !== action.id
            && (previous.status === 'running' || previous.physicalActive)
            && (command.action === 'cancel' ? previous.physicalActive
              : command.action === 'stop_follow' ? previous.command.action === 'follow' : previous.channel === 'movement'));
          if (command.action === 'cancel' && !previous.some(previous => previous.id === command.actionId)) {
            action.result = { ok: false, message: 'That action is not an ongoing action belonging to you.' };
          } else {
            for (const previousAction of previous.filter(previous => command.action !== 'cancel' || previous.id === command.actionId)) {
              previousAction.result = this.engine.cancelMotion(id);
              previousAction.physicalActive = false;
              this.updateProgress(id, previousAction);
              this.finish(id, previousAction, 'cancelled');
            }
          }
        }
        action.startedTick = this.engine.tick;
        action.result ??= command.action === 'cancel' ? { ok: true, message: 'Cancelled the action.' } : this.engine.act(id, command);
        if (action.channel === 'movement' && action.result.ok) movementCommitted = true;
        action.target = action.channel === 'movement' && entity.motion ? clone(entity.motion.destination) : undefined;
        action.position = clone(entity.position);
        action.remainingDistance = action.target ? distance(entity.position, action.target) : 0;
        action.physicalActive = motionTask(action) && action.result.ok && (!!entity.motion || !!entity.following);
        action.motion = action.physicalActive ? clone(entity.motion) : undefined;
        if (!action.result.ok) this.finish(id, action, 'rejected');
        else if (immediateControl) this.finish(id, action, 'completed');
        else { action.status = 'running'; action.dueTick = scanning.has(command.action)
          ? this.engine.tick + TURN_TICKS : (Math.floor(this.engine.tick / TURN_TICKS) + 1) * TURN_TICKS; }
        this.engine.event(id, 'simulation-action', `${action.kind}: ${action.status}`, { action: this.publicAction(action) });
        this.dirty = true;
      }
    }
    this.flush();
  }
  afterStep() {
    if (this.closed) return;
    for (const [id, state] of Object.entries(this.entities)) {
      const entity = this.engine.entity(id);
      for (const action of state.actions.filter(action => action.status === 'running' || action.physicalActive)) {
        this.updateProgress(id, action);
        if (!this.engine.active(entity)) { action.physicalActive = false; this.finish(id, action, 'cancelled'); }
        else if (motionTask(action)) {
          action.physicalActive = !!entity.motion || !!entity.following;
          if (terminal(action)) continue;
          if (!entity.motion && !entity.following) {
            action.result = clone(entity.lastAction ?? action.result!);
            this.finish(id, action, action.result.ok ? 'completed' : 'blocked');
          }
        } else if (this.engine.tick >= action.dueTick!) this.finish(id, action, 'completed');
      }
      const notices = this.engine.notices(id);
      for (const notice of notices.encounters) this.queue(id, { id: notice.eventId, tick: notice.tick, type: 'encounter', message: notice.message, data: { otherId: notice.otherId, otherName: notice.otherName } });
      for (const notice of notices.terrainChanges) this.queue(id, { id: notice.eventId, tick: notice.tick, type: 'terrain', message: notice.message, data: { target: notice.target, kind: notice.kind } });
      for (const notice of notices.impacts) this.queue(id, { id: notice.eventId, tick: notice.tick, type: 'block-impact', message: notice.message, data: { itemId: notice.itemId, kind: notice.kind } });
      this.engine.acknowledgeEncounters(id, notices.encounters);
      this.engine.acknowledgeTerrainChanges(id, notices.terrainChanges);
      this.engine.acknowledgeBlockImpacts(id, notices.impacts);
      this.dirty = true;
    }
    this.flush();
  }
  private collectEvent(event: WorldEvent) {
    if (event.type === 'speech') {
      const data = event.data as { word: string; recipientIds: string[] };
      for (const id of data.recipientIds) {
        if (!this.entities[id]) continue;
        const heard = this.engine.inbox.get(id)?.find(heard => heard.eventId === event.id);
        if (heard) this.queue(id, { id: event.id, tick: event.tick, type: 'speech', message: `${heard.from}: ${heard.word}`, data: clone(heard) });
      }
    } else if (this.entities[event.actor] && event.type === 'terrain-perceived') {
      this.queue(event.actor, { id: event.id, tick: event.tick, type: 'terrain', message: event.message, data: clone(event.data) });
    } else if (this.entities[event.actor] && ['encounter', 'block-impact', 'discovery', 'collision', 'blocked', 'arrived', 'scanned', 'follow-ended', 'follow-blocked', 'rebound-ended', 'action-completed', 'action-blocked', 'action-cancelled', 'action-rejected'].includes(event.type)) {
      this.queue(event.actor, { id: event.id, tick: event.tick, type: event.type, message: event.message, data: clone(event.data) });
      if (['collision', 'blocked', 'follow-blocked'].includes(event.type)) {
        const action = this.state(event.actor).actions.find(action => action.channel === 'movement' && action.status === 'running');
        if (action) {
          action.result = clone(this.engine.entity(event.actor).lastAction!);
          this.updateProgress(event.actor, action);
          const entity = this.engine.entity(event.actor);
          action.physicalActive = !!entity.motion || !!entity.following;
          this.finish(event.actor, action, 'blocked');
        }
      }
    }
  }
  private queue(id: string, event: PerceivedEvent) {
    if (this.closed) return;
    const state = this.state(id);
    if (state.seen.includes(event.id)) return;
    state.seen.push(event.id); state.events.push(clone(event)); this.dirty = true;
    this.scheduleFlush();
  }
  private scheduleFlush() {
    if (this.closed || this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      if (this.closed) return;
      try { this.flush(); }
      catch (error) { this.rejectWaiters(error); }
    });
  }
  private rejectWaiters(error: unknown) {
    for (const waiters of this.waiters.values()) for (const waiter of waiters.values()) { waiter.dispose(); waiter.reject(error); }
    this.waiters.clear();
  }
  private updateProgress(id: string, action: SimulationAction) {
    const entity = this.engine.entity(id);
    if (action.channel === 'movement') action.distanceTravelled += distance(action.position, entity.position);
    action.position = clone(entity.position);
    action.remainingDistance = action.target ? distance(entity.position, action.target) : 0;
    action.motion = motionTask(action) ? clone(entity.motion) : undefined;
  }
  private finish(id: string, action: SimulationAction, status: Extract<SimulationAction['status'], 'completed' | 'blocked' | 'cancelled' | 'rejected'>) {
    if (action.status === status && action.finishedEventId !== undefined) return;
    action.status = status; action.finishedTick = this.engine.tick;
    const event = this.engine.event(id, `action-${status}`, `${action.kind}: ${status}.`, { actionId: action.id, status, action: this.publicAction(action) });
    action.finishedEventId = event.id;
    this.dirty = true;
  }
  private trim(state: EntityTasks) {
    const referenced = new Set(state.requests.flatMap(request => request.actionId ? [request.actionId] : []));
    for (const event of state.events) {
      const data = event.data as { actionId?: string; action?: { id?: string } } | undefined;
      const id = data?.actionId ?? data?.action?.id;
      if (id) referenced.add(id);
    }
    const settled = state.actions.filter(action => !ongoing(action) && !referenced.has(action.id));
    const keep = new Set(settled.slice(-ACTION_HISTORY_LIMIT).map(action => action.id));
    state.actions = state.actions.filter(action => ongoing(action) || referenced.has(action.id) || keep.has(action.id));
    const receiptIds = Object.keys(state.receipts);
    const protectedCalls = new Set([...state.requests.map(request => request.callId), ...state.actions.filter(ongoing).map(action => action.callId)]);
    for (const callId of receiptIds.slice(0, -RECEIPT_HISTORY_LIMIT)) if (!protectedCalls.has(callId)) delete state.receipts[callId];
    const queuedEvents = new Set(state.events.map(event => event.id));
    state.seen = state.seen.filter((id, index) => index >= state.seen.length - SEEN_EVENT_LIMIT || queuedEvents.has(id));
  }
  /** Close the barrier synchronously, checkpoint receipts, then release tool promises. */
  flush() {
    if (this.closed) return;
    const releases: { waiter: Waiter; value: ToolOutcome }[] = [];
    for (const [id, waiters] of this.waiters) {
      const state = this.state(id);
      // Every submitted operation must pass the shared commit before parallel waits return.
      if (state.actions.some(action => action.status === 'queued')) continue;
      const queuedEvents = [...state.events];
      for (const [callId, waiter] of waiters) {
        const hasEvents = this.hasWakeEvent(waiter.request, queuedEvents);
        const action = state.actions.find(action => action.id === waiter.request.actionId);
        const completed = action && terminal(action);
        const timedOut = waiter.request.untilTick !== undefined && this.engine.tick >= waiter.request.untilTick;
        if (!completed && !timedOut && !hasEvents) continue;
        // A command must commit before an old event can release its tool call.
        if (action?.status === 'queued') continue;
        const events = state.events.splice(0);
        const value = this.outcome(id, completed ? action.status === 'rejected' ? 'rejected' : 'completed' : hasEvents ? 'event' : 'timeout', action, events);
        state.receipts[callId] = clone(value); state.requests = state.requests.filter(request => request.callId !== callId);
        waiters.delete(callId); waiter.dispose(); releases.push({ waiter, value }); this.dirty = true;
      }
    }
    if (this.dirty) {
      try {
        for (const state of Object.values(this.entities)) this.trim(state);
        this.checkpoint(); this.dirty = false;
      } catch (error) {
        this.closed = true; this.unsubscribe();
        for (const { waiter } of releases) waiter.reject(error);
        this.rejectWaiters(error);
        throw error;
      }
    }
    for (const { waiter, value } of releases) waiter.resolve(value);
  }
  private publicAction(action: SimulationAction): ActionProgress {
    return clone({
      id: action.id, kind: action.kind, channel: action.channel, status: action.status,
      position: action.position, ...(action.target ? { target: action.target } : {}),
      distanceTravelled: Math.round(action.distanceTravelled * 1000) / 1000,
      remainingDistance: Math.round(action.remainingDistance * 1000) / 1000,
      ...(action.physicalActive ? { physicalActive: true } : {}),
      ...(action.result ? { result: action.result } : {}),
    });
  }
  private outcome(id: string, reason: ToolOutcome['reason'], action?: SimulationAction, events: PerceivedEvent[] = []): ToolOutcome {
    const entity = this.engine.entity(id);
    return { tick: this.engine.tick, position: clone(entity.position), reason,
      ...(entity.motion ? { motion: clone(entity.motion) } : {}),
      ...(entity.following ? { following: clone(entity.following) } : {}),
      ...(action ? { action: this.publicAction(action) } : {}),
      actions: this.state(id).actions.filter(other => ongoing(other) && other.id !== action?.id).map(action => this.publicAction(action)), events };
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.unsubscribe();
    this.rejectWaiters(new Error('Simulation connection closed.'));
  }
}
