import { setTimeout as delay } from 'node:timers/promises';
import type { Engine } from '../../src/core/engine';
import { clone, distance, type Action, type Observation } from '../../src/core/types';
import { knowledgeDescription } from '../../src/core/knowledge';
import { PRIVATE_NOTE_LIMIT } from '../../src/core/memory';
import { TURN_TICKS, type DecisionStatus } from '../../src/core/time';
import type { Store } from '../store';
import { ProviderChain, type ProviderConfig, type ToolCall } from './providers';
import { worldTools, type Memory } from './tools';

interface Message { role: 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string; }
interface Mind extends Memory {
  turns: number; modelTurns: number; cycles: Message[][]; lastResult?: unknown;
  carriedMoves?: number; carryingReminder?: string; emptyHandMoves?: number;
  knownDiscoveries?: string[]; lastEncounters?: Record<string,number>; lastSpoken?: Record<string,number>;
  lastReflectionTurn?: number;
}
export interface PreparedDecision {
  id: string;
  observation: Observation;
  mind: Mind;
  content: string | null;
  calls: ToolCall[];
  latencyMs: number;
  attempts: number;
  provider: string;
  model: string;
  reminder?: string;
  hints?: string[];
  reflection?: {turn:number;note:string|null};
  stopFollowing?: boolean;
  viewAngle?: number;
  cycle: Message[];
  usage?: unknown;
}
export interface PreparedTurn { tick: number; decisions: PreparedDecision[]; }
type Report = (id: string, status: DecisionStatus) => void;

export class AgentRuntime {
  readonly mode: 'llm' | 'demo';
  readonly minds = new Map<string, Mind>();
  readonly inference: ProviderChain;
  parallelRequests: boolean;
  constructor(readonly engine: Engine, readonly store: Store, readonly config: {
    providers: ProviderConfig[]; maxTurns: number | null; retryDelayMs?: number;
  }) {
    this.parallelRequests=store.loadParallelRequests();
    this.inference = new ProviderChain(config.providers);
    this.mode = this.inference.enabled ? 'llm' : 'demo';
    for (const entity of engine.entities.filter(e => e.controller === 'agent')) {
      const saved = store.loadMind<Mind>(entity.id);
      this.minds.set(entity.id, saved ? { ...saved, notes:saved.notes.slice(-PRIVATE_NOTE_LIMIT), modelTurns: saved.modelTurns ?? 0 } : { notes: [], turns: 0, modelTurns: 0, cycles: [] });
      if(engine.discoveries.get(entity.id)?.delete('unsafe-terrain-edge'))engine.event(entity.id,'knowledge-correction','Removed the generic terrain-edge discovery; only the deep-water island boundary is learned.',{removed:'unsafe-terrain-edge'});
      if (!engine.active(entity)) entity.status = 'disabled';
      else if (entity.following) entity.status = 'following';
      else if (!entity.motion) entity.status = 'idle';
    }
  }
  persistence(): [string, unknown][] { return [...this.minds]; }
  setParallelRequests(enabled:boolean) { this.store.saveParallelRequests(enabled);this.parallelRequests=enabled; }
  async prepareTurn(signal: AbortSignal, report: Report): Promise<PreparedTurn> {
    signal.throwIfAborted();
    const tick = this.engine.tick;
    // Capture every observation before starting requests. Responses cannot change the world.
    const inputs = [...this.minds].sort(([a], [b]) => a.localeCompare(b)).flatMap(([id, mind]) => {
      const entity = this.engine.entity(id);
      if (!this.engine.active(entity)) { report(id, { state: 'disabled' }); return []; }
      if (entity.motion&&!entity.following) { report(id, { state: 'moving' }); return []; }
      if (this.mode === 'llm' && this.config.maxTurns !== null && mind.modelTurns >= this.config.maxTurns) { report(id, { state: 'turn limit' }); return []; }
      return [{ id, mind: clone(mind), observation: this.engine.observe(id) }];
    });
    const parallelRequests=this.parallelRequests;
    const prepare=async ({ id, mind, observation }:typeof inputs[number]) => {
      signal.throwIfAborted();
      const cached = this.store.loadPending<PreparedDecision>(tick, id, this.inference.cacheKey);
      if (cached) { report(id, { state: 'ready' }); return cached; }
      mind.turns++;
      const prepared = this.mode === 'demo'
        ? this.demoDecision(id,mind,observation,tick)
        : await this.request(id, mind, observation, signal, report);
      signal.throwIfAborted();
      // Ready decisions survive outages, pause/resume and process restarts.
      this.store.savePending(tick, id, this.inference.cacheKey, prepared);
      report(id, { state: 'ready', attempts: prepared.attempts });
      return prepared;
    };
    const decisions:PreparedDecision[]=[];
    if(parallelRequests)decisions.push(...await Promise.all(inputs.map(prepare)));
    else{
      for(const input of inputs)report(input.id,{state:'waiting',message:'Queued for sequential inference; world time is held.'});
      for(const input of inputs)decisions.push(await prepare(input));
    }
    signal.throwIfAborted();
    return { tick, decisions };
  }
  private demoDecision(id:string,mind:Mind,observation:Observation,tick:number):PreparedDecision{
    const action=demoAction(observation,mind.turns,id),name=action.action,args={...action} as Record<string,unknown>;delete args.action;
    const call={id:'demo-'+tick+'-'+id,type:'function' as const,function:{name,arguments:JSON.stringify(args)}};
    const cycle:Message[]=[{role:'user',content:JSON.stringify({perception:observation.description,navigation:observation.navigation})},{role:'assistant',content:null,tool_calls:[call]}];
    return{id,mind,observation,content:null,calls:[call],cycle,latencyMs:0,attempts:0,provider:'demo',model:'demo'};
  }
  private async request(id: string, mind: Mind, observation: Observation, signal: AbortSignal, report: Report): Promise<PreparedDecision> {
    let following=!!observation.self.following,stopFollowing=false,viewAngle=0;
    const reflectionDue=Math.floor(mind.turns/100)>Math.floor((mind.lastReflectionTurn??0)/100);
    let reflectionPending=reflectionDue&&!following;
    let reflection:PreparedDecision['reflection'];
    const started = Date.now();
    let tools = worldTools(this.engine, id, mind,{reflection:reflectionPending,following});
    const discoveries=[...(this.engine.discoveries.get(id)??[])];
    const learnedKnowledge=discoveries.map(knowledgeDescription).filter(knowledge=>!mind.notes.includes(knowledge));
    const hints=this.engine.module.agentHints?.(observation,new Set(discoveries))??[];
    if(discoveries.some(knowledge=>!mind.knownDiscoveries?.includes(knowledge)))hints.push('You have discovered something new. Learned facts are already remembered. You may use journal to note what you would like to try next.');
    if(!following)mind.knownDiscoveries=discoveries;
    mind.lastEncounters??={};
    for(const notice of observation.encounters)mind.lastEncounters[notice.otherId]=Math.max(mind.lastEncounters[notice.otherId]??0,notice.tick);
    const listeners=observation.interactions.speak.filter(other=>(mind.lastSpoken?.[other.id]??-1)<(mind.lastEncounters![other.id]??0));
    if(listeners.length){
      const greeting=this.engine.module.manifest.vocabulary.includes('hey')?'hey':this.engine.module.manifest.vocabulary[0];
      if(greeting)hints.push(`${listeners.map(other=>other.name).join(', ')} ${listeners.length===1?'is':'are'} visible and within speaking range. It could be good to greet them or reply with say, for example word="${greeting}". You may choose whether to speak.`);
    }
    const system = `${this.engine.module.manifest.agentInstructions}
Your name is ${observation.self.name}.
Words you can say: ${this.engine.module.manifest.vocabulary.join(', ')}.
Private memory: ${JSON.stringify(mind.notes)}
Learned knowledge: ${JSON.stringify(learnedKnowledge)}
Last action result: ${JSON.stringify(observation.self.lastAction ?? mind.lastResult ?? null)}
You may freely use journal to keep optional private notes about goals, plans, or things you want to do. Recent conversations fade; a note lets you resume an intention later. For example: "Return to the tree and investigate its wood." Your latest ${PRIVATE_NOTE_LIMIT} notes are remembered; older entries are forgotten. Writing takes no world time.
Choose one embodied action. You may call look or journal first and will receive their results before choosing. While following someone, choose only follow or stop_follow; stopping gives you an immediate normal action. Voice directions and distances describe where a voice was when heard. Do not invent outcomes.`;
    delete mind.carryingReminder;
    const held=observation.self.inventory?.selected===null||!observation.self.inventory?undefined:observation.self.inventory.stacks[observation.self.inventory.selected];
    let reminder=held&&(mind.carriedMoves??0)>=10?carryingReminder(held.kind,held.contents):undefined;
    if((mind.emptyHandMoves??0)>=10&&!held){
      const reachable=observation.interactions.hit;
      const wood=reachable.find(block=>block.kind==='wood');
      if(wood)reminder=`The wood within reach at block [${wood.target.join(',')}] could be useful. You could try hit on it to see what happens.`;
      else if(reachable.length)reminder=`The blocks in this world look like they can be struck. You could try hit on the ${reachable[0].kind} at block [${reachable[0].target.join(',')}].`;
      else reminder='The blocks in this world look like they can be struck. You could look for one within arm\'s reach and try hit.';
    }
    const reflectionQuestion='Pause to reflect: is there anything you want to keep in your private journal, such as a goal or something to try? Use journal to write it, or reflect with remember=false if there is nothing to save. Then choose your physical action. Reflection takes no world time.';
    const encounters=observation.encounters.filter(notice=>(mind.lastSpoken?.[notice.otherId]??-1)<notice.tick);
    const normalContext={body:{position:observation.self.position,yaw:observation.self.yaw},perception:observation.description,navigation:observation.navigation,interactions:observation.interactions,heard:observation.heard,inventory:observation.self.inventory,...(encounters.length?{encounters}:{}),...(reminder?{reminder}:{}),...(hints.length?{hints}:{})};
    const initial=following?{following:observation.following,heard:observation.heard,question:'Continue with follow, or use stop_follow to stop and choose another action immediately.'}:{...normalContext,...(reflectionPending?{reflection:reflectionQuestion}:{})};
    const cycle:Message[]=[{role:'user',content:JSON.stringify(initial)}];
    let attempts=0,supporting=0,provider='unknown',model='unknown',usage:unknown,content:string|null=null;
    const complete=async()=>{
      while(true){
        signal.throwIfAborted();attempts++;
        report(id,{state:attempts===1?'thinking':'waiting',attempts,message:'Waiting for an inference provider; world time is held.'});
        try{return await this.inference.complete({messages:[{role:'system',content:system},...mind.cycles.flat(),...cycle],tools:tools.filter(tool=>reflectionPending?!tool.physical:tool.name!=='reflect').map(({name,description,parameters})=>({type:'function',function:{name,description,parameters}})),max_tokens:900},signal,(candidate,index)=>report(id,{state:index?'waiting':'thinking',attempts,message:`${index?'Falling back to':'Trying'} ${candidate.name}; world time is held.`}));}
        catch(error){signal.throwIfAborted();report(id,{state:'waiting',attempts,message:error instanceof Error?error.message:'Inference providers unavailable.'});await delay(Math.min(10000,(this.config.retryDelayMs??1000)*2**Math.min(attempts-1,4)),undefined,{signal});}
      }
    };
    while(true){
      const answer=await complete();signal.throwIfAborted();mind.modelTurns++;provider=answer.provider;model=answer.model;usage=answer.usage;content=answer.content;
      cycle.push({role:'assistant',content:answer.content,...(answer.calls.length?{tool_calls:answer.calls}:{})});
      const physical:ToolCall[]=[];
      const wasReflecting=reflectionPending;
      const wasFollowing=following;
      for(const call of answer.calls){
        const tool=tools.find(candidate=>candidate.name===call.function.name);let result:unknown;
        if(!tool)result={ok:false,message:'Unknown tool.'};
        else if(tool.physical){
          if(!reflectionPending){physical.push(call);continue;}
          result={ok:false,message:'First answer the reflection: use journal to write a note, or reflect with remember=false. No physical action has happened.'};
        }
        else if(tool.name==='reflect'&&!reflectionPending)result={ok:false,message:'The reflection is already complete. Choose a physical action.'};
        else if(tool.name==='look'&&supporting++>=2)result={ok:false,message:'Use at most two look calls before acting. Journal remains freely available.'};
        else{try{result=tool.invoke(JSON.parse(call.function.arguments),{signal});}catch{result={ok:false,message:'Invalid tool arguments.'};}}
        cycle.push({role:'tool',tool_call_id:call.id,content:JSON.stringify(result)});
        if(call.function.name==='look'&&typeof (result as {viewAngle?:number})?.viewAngle==='number'){
          viewAngle=(result as {viewAngle:number}).viewAngle;
          tools=worldTools(this.engine,id,mind,{reflection:reflectionPending,following,viewAngle});
        }
        if(call.function.name==='stop_follow'&&(result as {ok?:boolean})?.ok){
          following=false;stopFollowing=true;reflectionPending=reflectionDue;
          mind.knownDiscoveries=discoveries;
          tools=worldTools(this.engine,id,mind,{reflection:reflectionPending,following:false,viewAngle});
        }
        if(reflectionPending&&['journal','reflect'].includes(call.function.name)&&(result as {ok?:boolean})?.ok){
          const args=JSON.parse(call.function.arguments);
          reflection={turn:mind.turns,note:call.function.name==='reflect'&&!args.remember?null:args.note.trim()};
          reflectionPending=false;
          mind.lastReflectionTurn=mind.turns;
        }
      }
      if(physical.length===1)return{id,mind,observation,content,calls:physical,cycle,latencyMs:Date.now()-started,attempts,provider,model,...(!following&&reminder?{reminder}:{}),...(!following&&hints.length?{hints}:{}),...(reflection?{reflection}:{}),...(stopFollowing?{stopFollowing}:{}),...(viewAngle?{viewAngle}:{}),...(usage===undefined?{}:{usage})};
      if(physical.length>1){for(const call of physical)cycle.push({role:'tool',tool_call_id:call.id,content:JSON.stringify({ok:false,message:'Choose exactly one physical action.'})});}
      if(wasFollowing&&!following)cycle.push({role:'user',content:JSON.stringify({...normalContext,message:'You can now choose another action at the same world instant.',...(reflectionPending?{reflection:reflectionQuestion}:{})})});
      else if(wasReflecting&&!reflectionPending)cycle.push({role:'user',content:'Reflection complete. Choose one physical action; the world has not advanced.'});
      else if(!answer.calls.length)cycle.push({role:'user',content:following?'Choose follow to continue, or stop_follow to stop and act immediately.':reflectionPending?'Use journal to save a note, or reflect with remember=false to decline.': 'Choose one available physical action, or wait explicitly.'});
    }
  }
  commit(turn: PreparedTurn) {
    if (this.engine.tick !== turn.tick + 1) throw new Error('Decisions must commit on the first step of their own turn.');
    // Rotate deterministic priority. Network response order never wins resource conflicts.
    const ids = [...this.minds.keys()].sort();
    const offset = Math.floor(turn.tick / TURN_TICKS) % Math.max(1, ids.length);
    const priority = [...ids.slice(offset), ...ids.slice(0, offset)];
    const decisions = [...turn.decisions].sort((a, b) => priority.indexOf(a.id) - priority.indexOf(b.id));
    this.engine.event('world', 'turn', 'One world-second turn started.', { turn: Math.floor(turn.tick / TURN_TICKS) + 1, observedTick: turn.tick, initiative: priority });
    for (const decision of decisions) {
      const { id, observation, content, calls } = decision;
      if (!this.engine.active(this.engine.entity(id))) continue;
      const previousMind=this.minds.get(id)!,mind = clone(decision.mind);
      if (this.mode === 'llm') {
        this.engine.event(id, 'observation', 'Observed the shared turn boundary.', { provider: decision.provider, model: decision.model, observation, memory: mind.notes, reminder:decision.reminder??null, hints:decision.hints??[], reflection:decision.reflection??null, turn: mind.turns });
        if(decision.reflection)this.engine.event(id,'reflection',decision.reflection.note?'Chose to save a private note during reflection.':'Chose not to add a private note during reflection.',decision.reflection);
        this.engine.event(id, 'decision', content?.slice(0, 500) || `Requested ${calls.length} tool calls.`, {
          provider: decision.provider, model: decision.model, latencyMs: decision.latencyMs, attempts: decision.attempts, usage: decision.usage ?? null, toolCalls: calls,
        });
      }
      const cycle:Message[]=clone(decision.cycle);
      if(decision.stopFollowing)this.engine.act(id,{action:'stop_follow'});
      const tools=worldTools(this.engine,id,mind,{viewAngle:decision.viewAngle});
      for (const call of calls) {
        let result: unknown;
        try {
          const tool = tools.find(t => t.name === call.function.name && t.physical);
          result = tool ? tool.invoke(JSON.parse(call.function.arguments)) : { ok: false, message: 'That physical action is not currently available.' };
        } catch { result = { ok: false, message: 'Invalid tool arguments.' }; }
        if (this.mode === 'llm') this.engine.event(id, 'tool-result', call.function.name, { callId: call.id, result });
        cycle.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        mind.lastResult = result;
        const held=observation.self.inventory?.selected===null||!observation.self.inventory?undefined:observation.self.inventory.stacks[observation.self.inventory.selected];
        const succeeded=(result as {ok?:boolean})?.ok===true;
        if(succeeded){
          if(call.function.name==='say'){
            const recipients=(result as {feedback?:{recipientIds?:string[]}}).feedback?.recipientIds??[];
            mind.lastSpoken??={};for(const recipient of recipients)mind.lastSpoken[recipient]=this.engine.tick;
          }
          const moved=call.function.name==='walk'||call.function.name==='jump';
          if(call.function.name==='hit')mind.emptyHandMoves=0;
          else if(moved&&!held)mind.emptyHandMoves=Math.min(10,(mind.emptyHandMoves??0)+1);
          const usedHeld=held&&['place','throw','strike_held','fill','empty','store'].includes(call.function.name);
          if(moved&&held)mind.carriedMoves=Math.min(10,(mind.carriedMoves??0)+1);
          else if(usedHeld||!held||(mind.carriedMoves??0)<10)mind.carriedMoves=0;
        }
      }
      this.engine.acknowledgeEncounters(id,observation.encounters??[]);
      if (this.mode === 'llm') {
        for(const note of mind.notes.filter(note=>!previousMind.notes.includes(note)))this.engine.event(id,'memory',note,{notes:mind.notes});
        mind.cycles.push(cycle);
        while (mind.cycles.length > 4 || (JSON.stringify(mind.cycles).length > 24000 && mind.cycles.length > 1)) mind.cycles.shift();
      }
      this.minds.set(id, mind);
    }
  }
}

function carryingReminder(kind:string,contents?:string) {
  if(kind==='wood')return 'You are still holding a wood block. You can place it, throw it, work it with strike_held, or store it.';
  if(kind==='bucket')return contents?`You are still holding a bucket containing ${contents}. You can empty it, place it, throw it, or store it.`:'You are still holding an empty bucket. You can fill it, place it, throw it, or store it.';
  if(['dirt','grass','sand','stone','leaves','plant'].includes(kind))return `You are still holding a ${kind} block. You can place it, throw it, or store it.`;
  return `You are still holding a ${kind}. You can place it, throw it, or store it.`;
}

// Deliberately deterministic and labelled in the UI. This is a mechanical demo,
// not evidence of LLM behavior. It uses exactly the same local observations/tools.
function demoAction(o: Observation, turn: number, id: string): Action {
  if(o.self.following)return {action:'follow'};
  const phase = (turn + (id === 't2' ? 4 : 0)) % 16;
  const eye = [o.self.position[0], o.self.position[1] + 1.5, o.self.position[2]] as [number,number,number];
  const nearby = o.blocks.filter(b => distance(eye, [b[0]+.5,b[1]+.5,b[2]+.5]) < 2.9);
  const held=o.self.inventory?.selected===null||!o.self.inventory?undefined:o.self.inventory.stacks[o.self.inventory.selected];
  if (held) return phase % 2 ? { action: 'throw', force: 7 } : { action: 'place', target: [Math.floor(o.self.position[0] + Math.sin(o.self.yaw * Math.PI / 180) * 2), Math.floor(o.self.position[1]), Math.floor(o.self.position[2] + Math.cos(o.self.yaw * Math.PI / 180) * 2)] };
  const wood = nearby.find(b => b[3] === 'wood');
  if (wood) return { action: 'hit', target: wood.slice(0,3) as [number,number,number] };
  if (phase === 0 || phase === 8) return { action: 'say', word: phase ? 'look' : 'hey' };
  if (phase === 2 && o.items.length) return { action: 'pickup', itemId: o.items[0].id };
  if (phase === 6 && nearby.length) { const block = nearby.find(b => b[3] !== 'grass') ?? nearby[0]; return { action: 'hit', target: block.slice(0,3) as [number,number,number] }; }
  if (phase % 3 === 0) return { action: 'turn', angle: id === 't1' ? 57 : -73 };
  return { action: 'walk', distance: 6 };
}
