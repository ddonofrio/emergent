import type { DecisionStatus } from '../../src/core/time';
import { PersistentSession, conversationRequest, type CompletionRequest, type Message, type SessionSnapshot, type SessionState } from '../../vendor/littlewhale';
import { InferenceClient, type ProviderConfig } from '../inference/providers';
import { RequestQueue } from '../inference/request-queue';
import type { Store } from '../store';
import type { AgentPort } from '../simulation/agent-port';
import type { AgentBridge, BridgeSnapshot } from '../simulation/agent-bridge';
import type { WorldConnection } from '../simulation/connection';
import { agentTools, currentObservation, resumeAgentTool, type AgentToolMemory, type FailedCallCounter, type LookState, type RepeatedToolFailures } from './tools';
import { sequenceContext, sequenceRetainedCalls, type SavedSequence, type SequenceRun } from './sequences';
import { AgentMemory, type MemorySnapshot } from './memory-record';
import { sanitizeAgentIntent, type AgentMemoryRecord } from '../../src/core/types';

export interface AgentSnapshot { session: SessionSnapshot; notes?: string[]; memory?: MemorySnapshot; viewAngle?: number; look?: LookState; toolFailures?: RepeatedToolFailures; failedCalls?: FailedCallCounter; sequence?: SequenceRun; routines?: SavedSequence[]; }
export interface RuntimeSnapshot { version: 1; agents: Record<string, AgentSnapshot>; simulation: BridgeSnapshot; }
interface Agent extends AgentToolMemory {
  port: AgentPort;
  sourcePort: AgentPort;
  memory: AgentMemory;
  system?: string;
  session: PersistentSession;
  state: SessionState;
  detail?: string;
  controller?: AbortController;
  job?: Promise<void>;
}

const withoutRetiredIdentity = (value: unknown): unknown => Array.isArray(value)
  ? value.map(withoutRetiredIdentity)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'identity').map(([key, entry]) => [key, withoutRetiredIdentity(entry)]))
    : value;
const cleanMessage = (message: Message): Message => {
  const cleaned = structuredClone(message);
  if (cleaned.content) {
    try { cleaned.content = JSON.stringify(withoutRetiredIdentity(JSON.parse(cleaned.content))); }
    catch { /* Non-JSON conversation text is unchanged. */ }
  }
  if (cleaned.toolCalls) cleaned.toolCalls = cleaned.toolCalls.map(call => call.name === 'set_intent'
    ? { ...call, arguments: withoutRetiredIdentity(call.arguments) as Record<string, unknown> } : call);
  if (cleaned.providerState && JSON.stringify(cleaned.providerState).includes('"identity"')) delete cleaned.providerState;
  return cleaned;
};
const cleanSession = (snapshot: SessionSnapshot | undefined): SessionSnapshot | undefined => snapshot ? {
  version: snapshot.version, id: snapshot.id, metrics: snapshot.metrics, compactions: snapshot.compactions,
  ...(snapshot.contextPressure ? { contextPressure: snapshot.contextPressure } : {}),
  messages: snapshot.messages.map(cleanMessage),
  pendingCalls: snapshot.pendingCalls.map(pending => ({
    call: pending.call.name === 'set_intent'
      ? { ...structuredClone(pending.call), arguments: withoutRetiredIdentity(pending.call.arguments) as Record<string, unknown> }
      : structuredClone(pending.call),
    ...(pending.result ? { result: cleanMessage(pending.result) } : {}),
  })),
} : undefined;

/** One persistent LittleWhale conversation per entity, using entity-scoped ports. */
export class AgentRuntime implements WorldConnection {
  readonly agents = new Map<string, Agent>();
  inference: InferenceClient;
  private enabled = false;
  private closed = false;
  private failed = false;
  private dirtyAgents = new Set<string>();
  constructor(readonly bridge: AgentBridge, readonly store: Store, providers: ProviderConfig[], snapshot: RuntimeSnapshot | undefined,
    private hooks: { changed(): void; inferenceChanged?(): void; fatal(error: unknown): void }, private requestQueue = new RequestQueue()) {
    this.inference = new InferenceClient(providers, () => this.hooks.inferenceChanged?.(), this.requestQueue);
    for (const port of bridge.ports()) {
      const saved = snapshot?.agents[port.id];
      const session = new PersistentSession(port.id, cleanSession(saved?.session));
      const memory = new AgentMemory({ intent: sanitizeAgentIntent(port.observe().self.intent), notes: saved?.notes ?? [], learned: port.knowledge() }, port.knowledge(), saved?.memory, {
        sessionId: port.id,
        context: () => this.agentContext(agent),
        complete: (request, signal) => session.completeAuxiliary((req, sig) => this.complete(agent, req, sig), request, signal),
        save: () => this.persist(agent),
        publish: (record, source) => this.publishMemory(agent, record, source),
        event: event => {
          try { this.dirtyAgents.add(port.id); port.recordMemoryCompaction({ ...event }); this.persist(agent); this.hooks.inferenceChanged?.(); }
          catch (error) { this.fail(error); throw error; }
        },
        fatal: error => this.fail(error),
      });
      const agent: Agent = { sourcePort: port, port: { ...port, get tick() { return port.tick; }, knowledge: () => {
        memory.discover(port.knowledge()); return memory.record.learned;
      } }, session, memory,
        get notes() { return memory.record.notes; }, writeMemory: update => memory.write(update), viewAngle: saved?.viewAngle,
        ...(saved?.sequence ? { sequence: structuredClone(saved.sequence) } : {}),
        ...(saved?.routines ? { routines: structuredClone(saved.routines) } : {}),
        saveTools: () => { this.dirtyAgents.add(port.id); this.persist(agent); },
        ...(saved?.look ? { look: { ...saved.look } } : {}), ...(saved?.toolFailures ? { toolFailures: structuredClone(saved.toolFailures) } : {}), state: 'stopped' };
      if (saved?.failedCalls) agent.failedCalls = { ...saved.failedCalls };
      this.agents.set(port.id, agent);
      this.dirtyAgents.add(port.id);
      port.retainCalls([...session.snapshot().pendingCalls.filter(pending => !pending.result).map(pending => pending.call.id), ...sequenceRetainedCalls(agent)]);
    }
  }
  get mode(): 'llm' | 'waiting' { return this.inference.enabled ? 'llm' : 'waiting'; }
  configure(providers: ProviderConfig[]) {
    this.inference = new InferenceClient(providers, () => this.hooks.inferenceChanged?.(), this.requestQueue);
    for (const agent of this.agents.values()) { agent.memory.pause(); agent.controller?.abort(new Error('Inference configuration changed.')); }
    this.hooks.changed();
  }
  persistence(): RuntimeSnapshot {
    return { version: 1, simulation: this.bridge.snapshot(), agents: Object.fromEntries([...this.agents].map(([id, agent]) => [id, this.agentSnapshot(agent)])) };
  }
  /** A physics checkpoint includes only agent state changed outside the acting loop. */
  checkpoint(): RuntimeSnapshot {
    return { version: 1, simulation: this.bridge.snapshot(), agents: Object.fromEntries([...this.dirtyAgents].map(id => [id, this.agentSnapshot(this.agents.get(id)!)])) };
  }
  acceptCheckpoint() { this.dirtyAgents.clear(); }
  private agentSnapshot(agent: Agent): AgentSnapshot {
    return {
      session: agent.session.snapshot(), memory: agent.memory.snapshot(), ...(agent.viewAngle ? { viewAngle: agent.viewAngle } : {}),
      ...(agent.look ? { look: { ...agent.look } } : {}),
      ...(agent.toolFailures ? { toolFailures: structuredClone(agent.toolFailures) } : {}),
      ...(agent.failedCalls ? { failedCalls: { ...agent.failedCalls } } : {}),
      ...(agent.sequence ? { sequence: structuredClone(agent.sequence) } : {}),
      ...(agent.routines?.length ? { routines: structuredClone(agent.routines) } : {}),
    };
  }
  metrics() { return Object.fromEntries([...this.agents].map(([id, agent]) => [id, agent.session.metrics])); }
  private persist(agent: Agent) {
    try {
      const snapshot = this.agentSnapshot(agent);
      this.store.saveAgentSession(agent.port.id, snapshot);
      agent.port.retainCalls([...snapshot.session.pendingCalls.filter(pending => !pending.result).map(pending => pending.call.id), ...sequenceRetainedCalls(agent)]);
    }
    catch (error) { this.fail(error); throw error; }
  }
  resume() {
    if (this.closed || this.failed) return;
    this.enabled = true;
    for (const agent of this.agents.values()) {
      if (!agent.port.active()) { agent.memory.pause(); agent.controller?.abort(new Error('Entity disabled.')); continue; }
      if (!agent.job) { this.syncMemory(agent); this.launch(agent); }
      if (this.inference.enabled) agent.memory.resume();
    }
  }
  suspend() {
    this.enabled = false;
    for (const agent of this.agents.values()) { agent.memory.pause(); agent.controller?.abort(new Error('World paused.')); }
  }
  fail(error: unknown) {
    if (this.failed || this.closed) return;
    this.failed = true; this.suspend(); this.hooks.fatal(error);
  }
  ready() {
    return [...this.agents.values()].filter(agent => agent.port.active()).every(agent => agent.state === 'tool' && agent.port.waiting());
  }
  commit() { this.bridge.commit(); }
  afterStep() { this.bridge.afterStep(); }
  status(): Record<string, DecisionStatus> {
    return Object.fromEntries([...this.agents].map(([id, agent]) => [id, { state: !agent.port.active() ? 'disabled' : agent.state === 'tool' && agent.port.waiting() ? 'ready' : agent.state === 'retrying' || !this.inference.enabled ? 'waiting' : 'thinking', ...(agent.detail ? { message: agent.detail } : {}) }]));
  }
  private syncMemory(agent: Agent) {
    const observedIntent = agent.sourcePort.observe().self.intent;
    const intent = sanitizeAgentIntent(observedIntent);
    if (observedIntent && JSON.stringify(observedIntent) !== JSON.stringify(intent)) agent.sourcePort.setIntent(intent!);
    if (JSON.stringify(intent) !== JSON.stringify(agent.memory.record.intent)) agent.memory.write({ intent });
    agent.memory.discover(agent.sourcePort.knowledge());
  }
  private currentContext(agent: Agent) {
    this.syncMemory(agent);
    return JSON.stringify({ record: agent.memory.record, observation: currentObservation(agent.port, agent.viewAngle), ...sequenceContext(agent) });
  }
  private agentContext(agent: Agent) {
    const tools = agentTools(agent.port, agent).schemas;
    const snapshot = agent.session.snapshot();
    return { system: agent.system, tools, messages: conversationRequest({ system: agent.system ?? '', schemas: tools,
      currentContext: () => this.currentContext(agent), contextWindow: this.inference.contextWindow }, snapshot.messages, snapshot.contextPressure).messages };
  }
  private publishMemory(agent: Agent, record: AgentMemoryRecord, source: 'write' | 'compaction') {
    try {
      this.dirtyAgents.add(agent.port.id);
      if (record.intent && JSON.stringify(agent.sourcePort.observe().self.intent) !== JSON.stringify(record.intent)) agent.sourcePort.setIntent(record.intent);
      agent.sourcePort.recordMemory(record, source);
      this.persist(agent); this.hooks.inferenceChanged?.();
    } catch (error) { this.fail(error); throw error; }
  }
  private launch(agent: Agent) {
    const controller = new AbortController(); agent.controller = controller;
    const tools = agentTools(agent.port, agent);
    const system = `${agent.port.instructions.replaceAll('{name}', agent.port.name)}
Each request ends with your current memory record and local observation, superseding old state. Tool receipts describe what happened. History is compacted under context pressure; use remember for at most ten private notes and recall for original discoveries. Preserve useful techniques, uncertainty and commitments. An experiment establishes only the tested inputs. Use set_intent for your own goal, success condition and optional next step; reconsider after discoveries, blockage or completion.
Choose eventTypes when starting an action or waiting; event names are listed on wait_for_event. [] defers events until completion; ordinary actions without a filter return on any event (look normally waits for completion). Deferred events remain available. An event does not stop movement or require a reply. wait_for_event always returns within five world seconds.
Calls in one response run concurrently. Submit at most one body or locomotion action; speech and private planning can accompany ordinary movement. For predictable dependent steps, use run_sequence as the only physical call. Its steps are checked separately and consume normal world time. After interruption, resume with its sequenceId or cancel the remaining steps. Save your own reusable procedures with save_sequence; read them before reuse when needed. Saved procedures are not proof of success.
Scans and hand interactions need a free stationary body. Check bodyActivity and hand constraints before repositioning. World time freezes during inference or retry; tool waits open the shared clock. Self positions use x,yHeight,z; block targets use [x,y,z]; walk_to uses horizontal x,z. Capabilities describe uses and prerequisites; listed tools describe current availability. Visible counts are local observations. Never assume unseen facts. Call tools to proceed.`;
    agent.system = system;
    agent.job = agent.session.run({
      system, schemas: tools.schemas, tools: tools.executors, signal: controller.signal,
      currentContext: () => this.currentContext(agent),
      prepareTools: () => { const current = agentTools(agent.port, agent); return { schemas: current.schemas, tools: current.executors }; },
      resumeTool: (call, signal) => call.name === 'run_sequence'
        ? agentTools(agent.port, agent).executors.run_sequence(call.arguments, call, signal)
        : resumeAgentTool(agent.port, agent, call.id, signal),
      complete: (request, signal) => this.complete(agent, request, signal),
      contextWindow: this.inference.contextWindow,
      persist: () => this.persist(agent),
      onCompaction: details => agent.sourcePort.recordContextCompaction(details),
      onState: (state, detail) => {
        agent.state = state; agent.detail = detail;
        this.hooks.changed();
      },
    }).catch(error => {
      if (!controller.signal.aborted && !this.closed) this.fail(error);
    }).finally(() => {
      agent.job = undefined; agent.controller = undefined;
      if (this.closed || this.failed) return;
      try {
        this.persist(agent); this.hooks.changed();
        if (this.enabled && agent.port.active()) this.launch(agent);
      } catch (error) { this.fail(error); }
    });
  }
  private async complete(agent: Agent, request: CompletionRequest, signal: AbortSignal) {
    const startedAt = new Date().toISOString(), started = performance.now();
    const durable = <T>(operation: () => T): T => {
      try { return operation(); }
      catch (error) { this.fail(error); throw error; }
    };
    const audit = durable(() => this.store.beginInference(this.bridge.tick, agent.port.id, request.purpose, 'compact-v1', request));
    try {
      const answer = await this.inference.complete(request, signal);
      signal.throwIfAborted();
      durable(() => this.store.finishInference(audit, { ...answer, timing: { startedAt, durationMs: performance.now() - started } }, 'completed'));
      return answer;
    } catch (error) {
      if (!this.closed) durable(() => this.store.finishInference(audit, { message: signal.aborted ? 'Inference cancelled.' : this.inference.describeError(error), timing: { startedAt, durationMs: performance.now() - started } }, signal.aborted ? 'cancelled' : 'failed'));
      throw error;
    }
  }
  close() {
    this.closed = true;
    for (const agent of this.agents.values()) agent.memory.close();
    this.suspend();
    for (const agent of this.agents.values()) this.persist(agent);
    this.bridge.close();
  }
}
