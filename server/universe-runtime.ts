import type { ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { Engine } from '../src/core/engine';
import { CLOCK_VERSION, TICKS_PER_SECOND, TURN_TICKS } from '../src/core/time';
import type { UniverseModule } from '../src/core/types';
import { AgentRuntime } from './agents/runtime';
import type { ProviderConfig, ProviderStrategy, ReasoningSettings } from './agents/providers';
import { Store } from './store';
import { TurnClock } from './turn-clock';

export class UniverseRuntime {
  readonly store: Store;
  readonly engine: Engine;
  readonly agents: AgentRuntime;
  readonly clock: TurnClock;
  readonly clients = new Set<ServerResponse>();
  requestedRunning = false;
  private autoPausedForMissingModel = false;

  constructor(
    readonly universe: UniverseModule,
    dataDirectory: string,
    config: {
      providers: ProviderConfig[];
      providerStrategy: ProviderStrategy;
      reasoning: ReasoningSettings;
      maxTurns: number | null;
      scriptedDemo: boolean;
      fatal(error: unknown): void;
    },
  ) {
    this.store=new Store(resolve(dataDirectory,`${universe.manifest.id}.sqlite`),universe.manifest);
    this.store.cancelInterruptedInferences();
    const storedState=this.store.hasWorld()?this.store.stateAt(this.store.latestTick()):undefined;
    const migration=storedState?universe.migrateState?.(storedState):undefined;
    this.engine=new Engine(universe,migration?.state??storedState);
    this.engine.nextEvent=this.store.maxEventId()+1;
    for(const event of migration?.events??[])this.engine.event(event.actor,event.type,event.message,event.data);
    this.agents=new AgentRuntime(this.engine,this.store,{providers:config.providers,maxTurns:config.maxTurns,scriptedDemo:config.scriptedDemo,reasoning:config.reasoning});
    this.agents.setInferenceConfig(config.providers,config.providerStrategy,config.reasoning);
    this.autoPausedForMissingModel=this.hasAgents&&this.agents.mode==='waiting';
    for(const event of this.store.eventsAt(this.engine.tick,'',500)){
      if(event.type!=='decision'&&event.type!=='movement-decision')continue;
      const provider=(event.data as {provider?:unknown}|undefined)?.provider;
      if(typeof provider==='string')this.agents.inference.seedHistoricalSuccess(provider,Math.floor(event.tick/TURN_TICKS)+1);
    }
    const runtimeMode=this.hasAgents?(this.agents.mode==='demo'?'scripted demo':this.agents.mode==='waiting'?'model-waiting':'LLM'):'engine-only';
    this.engine.event('world','session',`World ${this.store.hasWorld()?'resumed':'created'} in ${runtimeMode} mode.`);
    this.store.record(this.engine.frame(),this.engine.state(),this.agents.persistence());
    this.clock=new TurnClock(this.engine,this.agents,{
      frame:()=>this.publishFrame(this.engine.tick%600===0),
      status:()=>this.broadcast('status',{runtime:this.clock.status()}),
      fatal:config.fatal,
    });
    this.clock.setEnabled(false);
  }

  get hasAgents() { return this.engine.entities.some(entity=>entity.controller==='agent'); }

  metadata(llmConfig: unknown) {
    return {
      universe:this.universe.manifest,
      mode:this.agents.mode,
      model:this.agents.mode==='demo'?'Scripted demo':this.agents.inference.label,
      providerStrategy:this.agents.inference.strategy,
      llmConfig,
      parallelRequests:this.agents.parallelRequests,
      running:this.clock.status().enabled,
      agentsEnabled:this.clock.status().enabled,
      latestTick:this.engine.tick,
      maxTurns:this.agents.config.maxTurns,
      clock:{version:CLOCK_VERSION,ticksPerSecond:TICKS_PER_SECOND,turnTicks:TURN_TICKS},
      runtime:this.clock.status(),
    };
  }

  setRunning(running: boolean) {
    this.requestedRunning=running;this.autoPausedForMissingModel=false;this.clock.setEnabled(running);
    return this.clock.status().enabled;
  }

  configureInference(providers: ProviderConfig[],strategy: ProviderStrategy,reasoning: ReasoningSettings) {
    const resumeAfterModelConfiguration=this.autoPausedForMissingModel;
    this.agents.setInferenceConfig(providers,strategy,reasoning);
    if(this.hasAgents&&this.agents.mode==='waiting'){
      this.autoPausedForMissingModel=true;this.clock.setEnabled(false);
    }else if(resumeAfterModelConfiguration&&this.requestedRunning){
      this.autoPausedForMissingModel=false;this.clock.setEnabled(true);
    }
  }

  broadcast(event: string,value: unknown) {
    const message=`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
    for(const client of this.clients){
      if(client.writableLength>2_000_000){client.end();this.clients.delete(client);}
      else client.write(message);
    }
  }

  publishFrame(checkpoint=false) {
    const frame=this.engine.frame();
    this.store.record(frame,checkpoint?this.engine.state():undefined,this.agents.persistence());
    this.broadcast('frame',{frame,agentsEnabled:this.clock.status().enabled,runtime:this.clock.status()});
  }

  pump() { this.clock.pump(); }

  close() {
    this.clock.close();
    this.store.record(this.engine.frame(),this.engine.state(),this.agents.persistence());
    for(const client of this.clients)client.end();
    this.clients.clear();this.store.close();
  }
}
