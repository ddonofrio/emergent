import type { ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { Engine } from '../src/core/engine';
import { CLOCK_VERSION, TICKS_PER_SECOND, TURN_TICKS } from '../src/core/time';
import type { Frame, UniverseModule } from '../src/core/types';
import { AgentRuntime, type RuntimeSnapshot } from './agents/runtime';
import type { ProviderConfig } from './inference/providers';
import type { RequestQueue } from './inference/request-queue';
import { AgentBridge } from './simulation/agent-bridge';
import { Store } from './store';
import { TurnClock } from './turn-clock';

export class UniverseRuntime {
  readonly store: Store;
  readonly engine: Engine;
  readonly agents: AgentRuntime;
  readonly bridge: AgentBridge;
  readonly clock: TurnClock;
  readonly clients = new Set<ServerResponse>();
  private failedFrame?: Frame;

  constructor(readonly universe: UniverseModule, dataDirectory: string, private readonly config: {
    providers: ProviderConfig[];
    requestQueue?: RequestQueue;
    fatal(error: unknown): void;
  }) {
    this.store = new Store(resolve(dataDirectory, `${universe.manifest.id}.sqlite`), universe.manifest);
    this.store.cancelInterruptedInferences();
    const storedState = this.store.hasWorld() ? this.store.stateAt(this.store.latestTick()) : undefined;
    const migration = storedState ? universe.migrateState?.(storedState) : undefined;
    this.engine = new Engine(universe, migration?.state ?? storedState);
    this.engine.nextEvent = this.store.maxEventId() + 1;
    for (const event of migration?.events ?? []) this.engine.event(event.actor, event.type, event.message, event.data);
    const snapshot = this.store.loadAgentState<RuntimeSnapshot>();
    if (snapshot && snapshot.version !== 1) throw new Error('Unsupported agent runtime snapshot.');
    this.bridge = new AgentBridge(this.engine, snapshot?.simulation, () => this.publishFrame());
    this.agents = new AgentRuntime(this.bridge, this.store, config.providers, snapshot, {
      changed: () => {
        if (this.clock) { this.clock.barrierChanged(); this.broadcast('status', this.observerStatus()); }
      },
      inferenceChanged: () => { if (this.clock) this.broadcast('status', this.observerStatus()); },
      fatal: config.fatal,
    }, config.requestQueue);
    this.clock = new TurnClock(this.engine, this.agents, {
      frame: () => this.publishFrame(this.engine.tick % 600 === 0),
      status: () => this.broadcast('status', this.observerStatus()),
      fatal: config.fatal,
    });
    this.engine.event('world', 'session', `World ${storedState ? 'resumed' : 'created'} with persistent agent sessions.`);
    this.store.record(this.engine.frame(), this.engine.state(), this.agents.persistence());
  }
  get hasAgents() { return this.agents.agents.size > 0; }
  observerStatus() {
    return { runtime: this.clock.status(), metrics: this.agents.metrics(), providerStatus: this.agents.inference.statuses() };
  }
  metadata(inferenceConfig: unknown) {
    return { universe: this.universe.manifest, mode: this.agents.mode,
      model: this.agents.inference.label, inferenceConfig,
      running: this.clock.status().enabled, latestTick: this.engine.tick,
      clock: { version: CLOCK_VERSION, ticksPerSecond: TICKS_PER_SECOND, turnTicks: TURN_TICKS },
      ...this.observerStatus() };
  }
  setRunning(running: boolean) { this.clock.setEnabled(running); return this.clock.status().enabled; }
  configureInference(providers: ProviderConfig[]) { this.agents.configure(providers); }
  broadcast(event: string, value: unknown) {
    const message = `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
    for (const client of this.clients) {
      if (client.writableLength > 2_000_000) { client.end(); this.clients.delete(client); }
      else client.write(message);
    }
  }
  publishFrame(checkpoint = false) {
    const frame = this.failedFrame ?? this.engine.frame();
    try { this.store.record(frame, checkpoint ? this.engine.state() : undefined, this.agents.persistence()); }
    catch (error) {
      this.failedFrame = frame; this.agents.fail(error); throw error;
    }
    this.failedFrame = undefined;
    this.broadcast('frame', { frame, runtime: this.clock.status() });
  }
  pump() { this.clock.pump(); }
  close() {
    this.clock.close();
    this.store.record(this.failedFrame ?? this.engine.frame(), this.engine.state(), this.agents.persistence());
    for (const client of this.clients) client.end();
    this.clients.clear(); this.store.close();
  }
}
