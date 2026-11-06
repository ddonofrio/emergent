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
  private recordedMetricsSignature = '';
  private lastRecordedTurnTick = 0;
  private lastTurnSampleAt = performance.now();

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
    this.lastRecordedTurnTick = Math.floor(this.engine.tick / TURN_TICKS) * TURN_TICKS;
    this.lastTurnSampleAt = performance.now();
    this.recordedMetricsSignature = JSON.stringify(this.store.metricsAt(this.engine.tick) ?? {});
    for (const event of migration?.events ?? []) this.engine.event(event.actor, event.type, event.message, event.data);
    const snapshot = this.store.loadAgentState<RuntimeSnapshot>();
    if (snapshot && snapshot.version !== 1) throw new Error('Unsupported agent runtime snapshot.');
    this.bridge = new AgentBridge(this.engine, snapshot?.simulation, () => this.publishFrame());
    this.agents = new AgentRuntime(this.bridge, this.store, config.providers, snapshot, {
      changed: () => {
        if (this.clock) { this.clock.barrierChanged(); this.publishMetricsIfChanged(); this.broadcast('status', this.observerStatus()); }
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
    const frame=this.engine.frame();this.appendTurnSpeed(frame);this.appendMetricsSnapshot(frame);
    this.store.record(frame, this.engine.state(), this.agents.persistence());
    this.acceptFrameStats(frame);
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
      secondsPerTurn: this.store.secondsPerTurnAt(this.engine.tick),
      ...this.observerStatus() };
  }
  setRunning(running: boolean) {
    if(this.clock.status().enabled!==running)this.lastTurnSampleAt=performance.now();
    this.clock.setEnabled(running);return this.clock.status().enabled;
  }
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
    this.appendTurnSpeed(frame);this.appendMetricsSnapshot(frame);
    try { this.store.record(frame, checkpoint ? this.engine.state() : undefined, this.agents.persistence()); }
    catch (error) {
      this.failedFrame = frame; this.agents.fail(error); throw error;
    }
    this.acceptFrameStats(frame);
    this.failedFrame = undefined;
    this.broadcast('frame', { frame, runtime: this.clock.status() });
  }
  private tokenMetrics() {
    return Object.fromEntries(Object.entries(this.agents.metrics()).map(([id, metrics]) => [id, {
      llmCalls: metrics.llmCalls,
      inputTokens: metrics.inputTokens,
      outputTokens: metrics.outputTokens,
      cachedInputTokens: metrics.cachedInputTokens,
    }]));
  }
  private appendMetricsSnapshot(frame: Frame) {
    const metrics=this.tokenMetrics(),signature=JSON.stringify(metrics);
    const queued=frame.events.findLast(event=>event.type==='llm-metrics');
    const previous=queued?JSON.stringify(queued.data):this.recordedMetricsSignature;
    if(signature===previous)return;
    frame.events.push({id:this.engine.nextEvent++,tick:frame.tick,time:frame.time,day:this.engine.day,actor:'world',type:'llm-metrics',message:'Recorded cumulative LLM usage.',data:metrics});
  }
  private appendTurnSpeed(frame:Frame) {
    if(frame.tick===0||frame.tick%TURN_TICKS!==0||frame.tick<=this.lastRecordedTurnTick)return;
    if(frame.events.some(event=>event.type==='turn-speed'&&event.tick===frame.tick))return;
    const secondsPerTurn=(performance.now()-this.lastTurnSampleAt)/1000;
    frame.events.push({id:this.engine.nextEvent++,tick:frame.tick,time:frame.time,day:this.engine.day,actor:'world',type:'turn-speed',message:'Recorded turn duration.',data:{secondsPerTurn}});
  }
  private acceptFrameStats(frame:Frame) {
    const event=frame.events.findLast(candidate=>candidate.type==='llm-metrics');
    if(event)this.recordedMetricsSignature=JSON.stringify(event.data);
    const turn=frame.events.findLast(candidate=>candidate.type==='turn-speed');
    if(turn&&turn.tick>this.lastRecordedTurnTick){this.lastRecordedTurnTick=turn.tick;this.lastTurnSampleAt=performance.now();}
  }
  private publishMetricsIfChanged() {
    if(JSON.stringify(this.tokenMetrics())!==this.recordedMetricsSignature)this.publishFrame();
  }
  pump() { this.clock.pump(); }
  close() {
    this.clock.close();
    const frame=this.failedFrame??this.engine.frame();this.appendTurnSpeed(frame);this.appendMetricsSnapshot(frame);
    this.store.record(frame, this.engine.state(), this.agents.persistence());this.acceptFrameStats(frame);
    for (const client of this.clients) client.end();
    this.clients.clear(); this.store.close();
  }
}
