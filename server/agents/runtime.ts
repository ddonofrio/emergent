import type { DecisionStatus } from '../../src/core/time';
import { PersistentSession, type CompletionRequest, type SessionSnapshot, type SessionState } from '../../vendor/littlewhale';
import { DEFAULT_CONTEXT_WINDOW, InferenceClient, type ProviderConfig } from '../inference/providers';
import { RequestQueue } from '../inference/request-queue';
import type { Store } from '../store';
import type { AgentPort } from '../simulation/agent-port';
import type { AgentBridge, BridgeSnapshot } from '../simulation/agent-bridge';
import type { WorldConnection } from '../simulation/connection';
import { agentTools, localView } from './tools';

export interface AgentSnapshot { session: SessionSnapshot; notes: string[]; viewAngle?: number; }
export interface RuntimeSnapshot { version: 1; agents: Record<string, AgentSnapshot>; simulation: BridgeSnapshot; }
interface Agent {
  port: AgentPort;
  session: PersistentSession;
  notes: string[];
  viewAngle?: number;
  state: SessionState;
  detail?: string;
  controller?: AbortController;
  job?: Promise<void>;
}

/** One persistent LittleWhale conversation per entity, using entity-scoped ports. */
export class AgentRuntime implements WorldConnection {
  readonly agents = new Map<string, Agent>();
  inference: InferenceClient;
  private enabled = false;
  private closed = false;
  private failed = false;
  constructor(readonly bridge: AgentBridge, readonly store: Store, providers: ProviderConfig[], snapshot: RuntimeSnapshot | undefined,
    private hooks: { changed(): void; inferenceChanged?(): void; fatal(error: unknown): void }, private requestQueue = new RequestQueue()) {
    this.inference = new InferenceClient(providers, () => this.hooks.inferenceChanged?.(), this.requestQueue);
    for (const port of bridge.ports()) {
      const saved = snapshot?.agents[port.id];
      const session = new PersistentSession(port.id, saved?.session);
      const agent: Agent = { port, session, notes: saved?.notes ?? [], viewAngle: saved?.viewAngle, state: 'stopped' };
      if (!saved) session.appendUser(JSON.stringify({ observation: localView(port.observe(), port.knowledge(), agent.notes), instruction: 'Choose your own goals and act through the currently available tools.' }));
      this.agents.set(port.id, agent);
    }
  }
  get mode(): 'llm' | 'waiting' { return this.inference.enabled ? 'llm' : 'waiting'; }
  configure(providers: ProviderConfig[]) {
    this.inference = new InferenceClient(providers, () => this.hooks.inferenceChanged?.(), this.requestQueue);
    for (const agent of this.agents.values()) agent.controller?.abort(new Error('Inference configuration changed.'));
    this.hooks.changed();
  }
  persistence(): RuntimeSnapshot {
    return { version: 1, simulation: this.bridge.snapshot(), agents: Object.fromEntries([...this.agents].map(([id, agent]) => [id, { session: agent.session.snapshot(), notes: [...agent.notes], ...(agent.viewAngle ? { viewAngle: agent.viewAngle } : {}) }])) };
  }
  metrics() { return Object.fromEntries([...this.agents].map(([id, agent]) => [id, agent.session.metrics])); }
  private persist() { this.store.saveAgentState(this.persistence()); }
  resume() {
    if (this.closed || this.failed) return;
    this.enabled = true;
    for (const agent of this.agents.values()) {
      if (!agent.port.active()) { agent.controller?.abort(new Error('Entity disabled.')); continue; }
      if (!agent.job) this.launch(agent);
    }
  }
  suspend() {
    this.enabled = false;
    for (const agent of this.agents.values()) agent.controller?.abort(new Error('World paused.'));
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
  private launch(agent: Agent) {
    const controller = new AbortController(); agent.controller = controller;
    const tools = agentTools(agent.port, agent);
    const system = `${agent.port.instructions.replaceAll('{name}', agent.port.name)}
You have one continuous private conversation. Choose your own identity, goals and observable success conditions; reassess them from current tool outcomes and mark an intent completed when its full condition is met. Keep at most ten private notes with remember.
Events arrive through tool results. A returned event leaves movement active: speak, then wait_for_event for more events or completion. Actions have persistent IDs. Only arrival, blockage, explicit cancellation or replacement ends movement. Speech is concurrent; locomotion is exclusive; hand interactions and scans require a stationary body. Calls in one response run concurrently and are validated at a shared commit boundary.
World time freezes during every agent's inference or retry. Tool waits let the shared clock advance. Self and creature positions name x, yHeight and z; voxel targets use [x,y,z], where y is height; walk_to uses horizontal x,z.
The current context in observations and physical tool results overrides older positions, inventory, intent and learned facts. Never route from a stale sighting: after a collision, unexpected blockage or uncertain target location, look again. The offered tools are refreshed from your current body, hands and local view. Never assume unseen facts. Call tools to proceed.`;
    const providers = this.inference.providers.filter(provider => provider.enabled !== false && provider.model);
    agent.job = agent.session.run({
      system, schemas: tools.schemas, tools: tools.executors, signal: controller.signal,
      prepareTools: () => { const current = agentTools(agent.port, agent); return { schemas: current.schemas, tools: current.executors }; },
      complete: (request, signal) => this.complete(agent, request, signal),
      contextWindow: providers.length ? Math.min(...providers.map(provider => provider.contextWindow ?? DEFAULT_CONTEXT_WINDOW)) : DEFAULT_CONTEXT_WINDOW,
      maxOutputTokens: providers.length ? Math.min(...providers.map(provider => provider.maxOutputTokens ?? 4096)) : 4096,
      persist: () => this.persist(),
      onState: (state, detail) => { agent.state = state; agent.detail = detail; this.hooks.changed(); },
    }).catch(error => {
      if (!controller.signal.aborted && !this.closed) this.fail(error);
    }).finally(() => {
      agent.job = undefined; agent.controller = undefined;
      if (this.closed || this.failed) return;
      try {
        this.persist(); this.hooks.changed();
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
    const audit = durable(() => this.store.beginInference(this.bridge.tick, agent.port.id, request.purpose, 'persistent-tools-v1', request));
    try {
      const answer = await this.inference.complete(request, signal);
      signal.throwIfAborted();
      durable(() => this.store.finishInference(audit, { ...answer, timing: { startedAt, durationMs: performance.now() - started } }, 'completed'));
      return answer;
    } catch (error) {
      if (!this.closed) durable(() => this.store.finishInference(audit, { message: signal.aborted ? 'Inference cancelled.' : 'Provider unavailable; the same conversation will retry.', timing: { startedAt, durationMs: performance.now() - started } }, signal.aborted ? 'cancelled' : 'failed'));
      throw error;
    }
  }
  close() { this.closed = true; this.suspend(); this.persist(); this.bridge.close(); }
}
