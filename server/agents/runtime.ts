import { setTimeout as delay } from 'node:timers/promises';
import type { Engine } from '../../src/core/engine';
import { clone, distance, type Action, type ActionResult, type AgentPlan, type Observation } from '../../src/core/types';
import { validateJsonSchemaValue } from '../../vendor/deepseek-harness/json-schema';
import { PLAN_REMINDER_INTERVAL, PLAN_REVIEW_INTERVAL, PRIVATE_NOTE_LIMIT } from '../../src/core/memory';
import { TICKS_PER_SECOND, TURN_TICKS, type DecisionStatus } from '../../src/core/time';
import type { Store } from '../store';
import { ProviderChain, type ProviderConfig, type ToolCall } from './providers';
import { worldTools, type Memory } from './tools';
import { compactResult, compactView, historicalActions, inventoryContext, planningActions, progressContext, recentActions, relevantKnowledge, rounded } from './context';
import { compactJournal } from './journal-compaction';
import { needsPlanReview, planDecision } from './planning';
import { milestoneEvidence, milestoneOptions } from './milestones';

interface Message { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string; }
interface Mind extends Memory {
  plan?: AgentPlan;
  turns: number; modelTurns: number; lastResult?: unknown;
  carriedMoves?: number; carryingReminder?: string; emptyHandMoves?: number;
  knownDiscoveries?: string[]; lastEncounters?: Record<string,number>; lastSpoken?: Record<string,number>;
  journalOffer?: string;
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
  journalOffer?: string;
  journalEntries?: string[];
  planEvents?: AgentPlan[];
  journalCompactions?: {before:string[];after:string[];incoming:string}[];
  stopFollowing?: boolean;
  viewAngle?: number;
  usage?: unknown;
}
export interface PreparedTurn { tick: number; decisions: PreparedDecision[]; }
export interface PreparedMovementPrompt {
  id:string; tick:number; choice:'continue_moving'|'stop_moving'; mind:Mind;
  content:string|null; latencyMs:number; attempts:number; provider:string; model:string; usage?:unknown;
}
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
      const saved = store.loadMind<Mind & {cycles?:Message[][];actionQueue?:unknown;sequenceInterruption?:unknown}>(entity.id);
      if(saved){
        const {cycles:_legacyCycles,actionQueue:_legacyQueue,sequenceInterruption:_legacyInterruption,...mind}=saved;
        this.minds.set(entity.id,{...mind,notes:saved.notes.slice(-PRIVATE_NOTE_LIMIT),modelTurns:saved.modelTurns??0});
      }else this.minds.set(entity.id,{notes:[],turns:0,modelTurns:0});
      if(engine.discoveries.get(entity.id)?.delete('unsafe-terrain-edge'))engine.event(entity.id,'knowledge-correction','Removed the generic terrain-edge discovery; only the deep-water island boundary is learned.',{removed:'unsafe-terrain-edge'});
      if (!engine.active(entity)) entity.status = 'disabled';
      else if (entity.following) entity.status = 'following';
      else if (!entity.motion) entity.status = 'idle';
    }
  }
  persistence(): [string, unknown][] { return [...this.minds]; }
  setParallelRequests(enabled:boolean) { this.store.saveParallelRequests(enabled);this.parallelRequests=enabled; }
  async prepareMovementPrompts(signal:AbortSignal,report:Report):Promise<PreparedMovementPrompt[]> {
    const tick=this.engine.tick,inputs=this.engine.movementPrompts().map(entity=>({id:entity.id,mind:clone(this.minds.get(entity.id)!),prompt:clone(entity.movementPrompt!),motion:clone(entity.motion!)}));
    const prepare=async(input:typeof inputs[number])=>{
      if(this.mode==='demo'||(this.config.maxTurns!==null&&input.mind.modelTurns>=this.config.maxTurns))return {id:input.id,tick,choice:'continue_moving' as const,mind:input.mind,content:null,latencyMs:0,attempts:0,provider:'demo',model:'demo'};
      const urgentSpeech=input.prompt.messages.map(message=>({speaker:message.speakerName,message:message.word,direction:message.direction,distanceMetres:message.distance}));
      const started=Date.now(),messages:Message[]=[
        {role:'system',content:`You are ${this.engine.entity(input.id).name}, a Troglodyte moving through a physical world. Choose exactly one available tool.`},
        {role:'user',content:JSON.stringify({urgentSpeech,currentMovement:{kind:input.motion.kind??'walk',remainingMetres:rounded(distance(this.engine.entity(input.id).position,input.motion.destination))},...(input.mind.plan?{goal:input.mind.plan.goal}:{}),instruction:'You heard this while moving. Choose only whether to continue the current movement or stop. Stopping does not grant another action until the next shared turn.'})},
      ];
      const tools=[
        {type:'function' as const,function:{name:'continue_moving',description:'Keep the current movement unchanged.',parameters:{type:'object',properties:{},required:[],additionalProperties:false}}},
        {type:'function' as const,function:{name:'stop_moving',description:'Stop the current movement now. Choose a new action on the next shared turn.',parameters:{type:'object',properties:{},required:[],additionalProperties:false}}},
      ];
      let attempts=0,provider='unknown',model='unknown',usage:unknown,content:string|null=null;
      while(true){
        signal.throwIfAborted();attempts++;report(input.id,{state:attempts===1?'thinking':'waiting',attempts,message:'Considering speech heard during movement; world time is held.'});
        try{
          const answer=await this.inference.complete({messages,tools,max_tokens:300,reasoning:'minimum'},signal,(candidate,index)=>report(input.id,{state:index?'waiting':'thinking',attempts,message:`${index?'Falling back to':'Trying'} ${candidate.name}; world time is held.`}));
          input.mind.modelTurns++;provider=answer.provider;model=answer.model;usage=answer.usage;content=answer.content;
          const calls=answer.calls.filter(call=>call.function.name==='continue_moving'||call.function.name==='stop_moving');
          if(calls.length===1){
            try{const args=JSON.parse(calls[0].function.arguments);if(args&&typeof args==='object'&&!Array.isArray(args)&&Object.keys(args).length===0)return {id:input.id,tick,choice:calls[0].function.name as 'continue_moving'|'stop_moving',mind:input.mind,content,latencyMs:Date.now()-started,attempts,provider,model,...(usage===undefined?{}:{usage})};}catch{}
          }
          messages.push({role:'assistant',content:answer.content,...(answer.calls.length?{tool_calls:answer.calls}:{})},{role:'user',content:'Choose exactly one: continue_moving or stop_moving, with no arguments.'});
        }catch(error){signal.throwIfAborted();report(input.id,{state:'waiting',attempts,message:error instanceof Error?error.message:'Inference providers unavailable.'});await delay(Math.min(10000,(this.config.retryDelayMs??1000)*2**Math.min(attempts-1,4)),undefined,{signal});}
      }
    };
    const decisions:PreparedMovementPrompt[]=[];
    if(this.parallelRequests)decisions.push(...await Promise.all(inputs.map(prepare)));
    else for(const input of inputs)decisions.push(await prepare(input));
    return decisions;
  }
  commitMovementPrompts(decisions:PreparedMovementPrompt[]) {
    for(const decision of decisions){
      const entity=this.engine.entity(decision.id);
      if(!entity.movementPrompt||decision.tick!==this.engine.tick)continue;
      if(this.mode==='llm')this.engine.event(decision.id,'movement-decision',decision.content?.slice(0,500)||`Chose ${decision.choice}.`,{choice:decision.choice,provider:decision.provider,model:decision.model,latencyMs:decision.latencyMs,attempts:decision.attempts,usage:decision.usage??null});
      const result=this.engine.resolveMovementPrompt(decision.id,decision.choice);
      decision.mind.lastResult=result;this.minds.set(decision.id,decision.mind);
    }
  }
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
      const cached = this.store.loadPending<PreparedDecision & {queued?:boolean;generatedCalls?:ToolCall[]}>(tick, id, this.inference.cacheKey);
      if (cached && !cached.queued && (this.mode==='demo'||cached.mind.plan)) {
        cached.mind.notes=cached.mind.notes.slice(-PRIVATE_NOTE_LIMIT);
        delete (cached.mind as Mind & {cycles?:Message[][];actionQueue?:unknown;sequenceInterruption?:unknown}).cycles;
        delete (cached.mind as Mind & {actionQueue?:unknown}).actionQueue;
        delete (cached.mind as Mind & {sequenceInterruption?:unknown}).sequenceInterruption;
        delete cached.generatedCalls;
        delete cached.queued;
        report(id, { state: 'ready' }); return cached;
      }
      mind.turns++;
      const prepared=this.mode==='demo'?this.demoDecision(id,mind,observation,tick):await this.request(id,mind,observation,signal,report);
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
    return{id,mind,observation,content:null,calls:[call],latencyMs:0,attempts:0,provider:'demo',model:'demo'};
  }
  private async preparePlan(id:string,mind:Mind,observation:Observation,signal:AbortSignal,report:Report,alreadyCounted=0) {
    type StagedPlan={plan:AgentPlan;events:AgentPlan[];modelCalls:number;acknowledged?:boolean};
    const actor=`plan:${id}`,cached=this.store.loadPending<StagedPlan>(observation.tick,actor,this.inference.cacheKey);
    if(!cached&&!needsPlanReview(mind.plan,mind.turns))return [];
    const staged:StagedPlan=cached??{plan:mind.plan!,events:[],modelCalls:0};
    if(!cached||staged.plan.status!=='active'){
      const capabilities=worldTools(this.engine,id,mind,{following:!!observation.following})
        .filter(tool=>tool.name!=='journal'&&!tool.description.startsWith('Disabled'))
        .map(tool=>tool.name);
      const actions=recentActions(this.store.actionEventsAt(observation.tick,id,PLAN_REVIEW_INTERVAL*2),PLAN_REVIEW_INTERVAL*2);
      const context=abstractPlanningContext(this.engine,observation,mind,capabilities,actions.slice(-PLAN_REVIEW_INTERVAL));
      staged.plan=await planDecision({name:observation.self.name,turn:mind.turns,time:observation.time,plan:cached?.plan??mind.plan,context,milestones:milestoneOptions(observation),actions,signal,retryDelayMs:this.config.retryDelayMs,
        complete:async(request,abort)=>{
          report(id,{state:'planning',message:'Planning a goal and reviewing steps; world time is held.'});
          const answer=await this.inference.complete(request,abort,(provider)=>report(id,{state:'planning',message:`Planning with ${provider.name}; world time is held.`}));
          staged.modelCalls++;return answer;
        },
        waiting:message=>report(id,{state:'waiting',message}),
        save:plan=>{staged.plan=clone(plan);staged.events.push(clone(plan));this.store.savePending(observation.tick,actor,this.inference.cacheKey,staged);},
      });
    }
    signal.throwIfAborted();mind.plan=clone(staged.plan);mind.modelTurns+=staged.modelCalls-alreadyCounted;
    return staged.events;
  }
  private async request(id: string, mind: Mind, observation: Observation, signal: AbortSignal, report: Report): Promise<PreparedDecision> {
    let following=!!observation.self.following,stopFollowing=false,viewAngle=0,speechMenu=false;
    const started = Date.now();
    const planEvents=await this.preparePlan(id,mind,observation,signal,report);
    const actions=recentActions(this.store.actionEventsAt(observation.tick,id,PLAN_REVIEW_INTERVAL*2),PLAN_REVIEW_INTERVAL*2);
    const completedGoal=[...planEvents].reverse().find(plan=>plan.status==='completed');
    if(completedGoal)mind.journalOffer=goalLearningOffer(completedGoal);
    const journalCompactions:NonNullable<PreparedDecision['journalCompactions']>=[];
    const journalEntries:string[]=[];
    let journalHint=following?undefined:mind.journalOffer;
    if(journalHint)delete mind.journalOffer;
    let journalOfferUsed=journalHint;
    const journalOptions={
      compactJournal:async(notes:readonly string[],incoming:string)=>{
        const after=await compactJournal({name:observation.self.name,notes,incoming,signal,retryDelayMs:this.config.retryDelayMs,
          complete:async(request,abort)=>{const result=await this.inference.complete(request,abort,(candidate)=>report(id,{state:'thinking',message:`Compacting journal with ${candidate.name}; world time is held.`}));mind.modelTurns++;return result;},
          waiting:message=>report(id,{state:'waiting',message})});
        journalCompactions.push({before:[...notes],after,incoming});return after;
      },
      onJournalEntry:(note:string)=>{journalEntries.push(note);journalHint=undefined;},
      onFinishGoal:(outcome:'completed'|'abandoned',reason:string)=>{
        const staged=this.store.loadPending<{modelCalls:number;acknowledged?:boolean}>(observation.tick,`plan:${id}`,this.inference.cacheKey);
        if(staged?.acknowledged)return {ok:false,message:'You already changed goals in this decision. Choose one physical action before changing again.'};
        const evidence=milestoneEvidence(mind.plan!,actions);
        if(outcome==='completed'&&!evidence.length)return {ok:false,message:'No recorded effect proves this milestone yet. Finding is not collecting and holding is not placing. Continue, or abandon with a reason.'};
        const closed:AgentPlan={...clone(mind.plan!),status:outcome,reviewedTurn:mind.turns,explanation:reason,steps:mind.plan!.steps.map(step=>step.status!=='pending'?step:{...step,status:outcome,evidence:outcome==='completed'?evidence[0].message:reason,...(outcome==='completed'?{evidenceEventIds:evidence.map(item=>item.eventId)}:{})})};
        this.store.savePending(observation.tick,`plan:${id}`,this.inference.cacheKey,{plan:closed,events:[...planEvents,closed],modelCalls:staged?.modelCalls??0,acknowledged:true});
        mind.plan=closed;
        return {ok:true,message:'Goal closed. Choose a new milestone before your next physical action.',planningCalls:staged?.modelCalls??0};
      },
    };
    let tools = worldTools(this.engine, id, mind,{following,speechMenu,...journalOptions});
    const discoveries=[...(this.engine.discoveries.get(id)??[])];
    const hints=this.engine.module.agentHints?.(observation,new Set(discoveries))??[];
    const knownDiscoveries=new Set(mind.knownDiscoveries??discoveries);
    const firstWoodShape=knownDiscoveries.size!==discoveries.length&&!([...knownDiscoveries].some(fact=>fact.startsWith('wood-shape:')))
      ?discoveries.find(fact=>fact.startsWith('wood-shape:')&&!knownDiscoveries.has(fact))
      :undefined;
    if(!following&&firstWoodShape){
      const product=woodProductName(firstWoodShape.slice('wood-shape:'.length));
      const made=product==='planks'?product:`${/^[aeiou]/.test(product)?'an':'a'} ${product}`;
      hints.push(`You shaped wood into ${made} for the first time. Wood may have other useful forms besides ${product==='planks'?product:`the ${product}`}. You need more raw wood to test them. Consider this discovery when reviewing your plan; journal can preserve useful details for later investigation.`);
    }
    if(!following)mind.knownDiscoveries=discoveries;
    mind.lastEncounters??={};
    for(const notice of observation.encounters)mind.lastEncounters[notice.otherId]=Math.max(mind.lastEncounters[notice.otherId]??0,notice.tick);
    const listeners=observation.interactions.speak.filter(other=>(mind.lastSpoken?.[other.id]??-1)<(mind.lastEncounters![other.id]??0));
    if(listeners.length)hints.push(`You can greet or reply to ${listeners.map(other=>other.name).join(', ')} with say.`);
    const system = ()=>[this.engine.module.manifest.agentInstructions.replace('{name}', observation.self.name),'End this decision with exactly one physical action. You may use supporting tools first; call finish_goal alone to close a goal before acting. Prefer choose_action with a current choices ID. Facts and current results override your intentions. If blocked, use the navigation summary before repeating a move.',!following&&mind.notes.length?'Notes are past records, oldest first; your current plan takes priority. Use journal with replace for outdated notes. Old locations and directions may no longer apply.':undefined,journalHint].filter(Boolean).join('\n');
    delete mind.carryingReminder;
    const held=observation.self.inventory?.selected===null||!observation.self.inventory?undefined:observation.self.inventory.stacks[observation.self.inventory.selected];
    let reminder=held&&(mind.carriedMoves??0)>=10?carryingReminder(held.kind,held.contents,observation.interactions.hit.length>0):undefined;
    if((mind.emptyHandMoves??0)>=10&&!held){
      const reachable=observation.interactions.hit;
      const wood=reachable.find(block=>block.kind==='wood');
      if(wood)reminder=`The wood within reach at block [${wood.target.join(',')}] could be useful. You could try hit on it to see what happens.`;
      else if(reachable.length)reminder=`The blocks in this world look like they can be struck. You could try hit on the ${reachable[0].kind} at block [${reachable[0].target.join(',')}].`;
      else reminder='The blocks in this world look like they can be struck. You could look for one within arm\'s reach and try hit.';
    }
    if(reminder&&held?.kind==='wood')hints.splice(0,hints.length,...hints.filter(hint=>!hint.includes('shapeable')));
    const notes=()=>mind.notes.length?{notes:mind.notes}:{};
    const recent=historicalActions(actions),learned=relevantKnowledge(this.engine,observation);
    const lastResult=(observation.self.lastAction??mind.lastResult) as ActionResult|undefined;
    const heard=observation.heard.length?{heard:observation.heard.map(({tick,direction,distance,...voice})=>({...voice,secondsAgo:(observation.tick-tick)/TICKS_PER_SECOND,directionWhenHeard:direction,distanceWhenHeard:distance}))}:{};
    const {attention,...view}=compactView(observation);
    const planContext=()=>{
      const plan=mind.plan!,elapsed=mind.turns-plan.reviewedTurn,reached=milestoneEvidence(plan,actions);
      return {goal:plan.goal,currentStep:plan.steps.find(step=>step.status==='pending')?.task,reviewInDecisions:Math.max(0,PLAN_REVIEW_INTERVAL-elapsed),
        ...(plan.steps.length!==1||!plan.steps[0].criterion?{legacyPlan:'This older plan has no verifiable completion criterion. Use finish_goal with abandoned to replace it with one coherent milestone. Do not continue work whose prerequisite was abandoned.'}:{}),
        ...(reached.length?{milestoneReached:reached,instruction:'This milestone is achieved. Call finish_goal with completed now; do not repeat or enlarge it.'}:{}),
        ...(elapsed>0&&elapsed%PLAN_REMINDER_INTERVAL===0?{reviewReminder:'Check your goal against recorded progress. Use finish_goal if achieved or no longer useful; otherwise continue. This reminder does not call the planner.'}:{}),
      };
    };
    const terrainChanges=observation.terrainChanges.length?{terrainChanges:observation.terrainChanges.map(notice=>notice.message)}:{};
    const normalContext=()=>rounded({...(attention?{attention}:{}),...(lastResult?{lastResult:compactResult(lastResult)}:{}),...(viewAngle?compactView(this.engine.observeAt(id,viewAngle)):view),plan:planContext(),progress:progressContext(recent),...notes(),body:{position:observation.self.position,yaw:observation.self.yaw},...heard,...terrainChanges,...(observation.beingFollowed?.length?{beingFollowed:observation.beingFollowed.map(follower=>follower.message)}:{}),inventory:inventoryContext(observation),...(learned.length?{learned}:{}),...(recent.length?{recent:recent.slice(-4)}:{}),...(reminder?{reminder}:{}),...(hints.length?{hints}:{})});
    const initial=following?{following:observation.following,plan:planContext(),...heard,...terrainChanges}:normalContext();
    const cycle:Message[]=[{role:'user',content:JSON.stringify(initial)}];
    let attempts=0,supporting=0,provider='unknown',model='unknown',usage:unknown,content:string|null=null;
    const complete=async()=>{
      while(true){
        signal.throwIfAborted();attempts++;
        report(id,{state:attempts===1?'thinking':'waiting',attempts,message:'Waiting for an inference provider; world time is held.'});
        try{return await this.inference.complete({messages:[{role:'system',content:system()},...cycle],tools:tools.map(({name,description,parameters})=>({type:'function',function:{name,description,parameters}})),max_tokens:900,reasoning:'minimum'},signal,(candidate,index)=>report(id,{state:index?'waiting':'thinking',attempts,message:`${index?'Falling back to':'Trying'} ${candidate.name}; world time is held.`}));}
        catch(error){signal.throwIfAborted();report(id,{state:'waiting',attempts,message:error instanceof Error?error.message:'Inference providers unavailable.'});await delay(Math.min(10000,(this.config.retryDelayMs??1000)*2**Math.min(attempts-1,4)),undefined,{signal});}
      }
    };
    while(true){
      const answer=await complete();signal.throwIfAborted();mind.modelTurns++;provider=answer.provider;model=answer.model;usage=answer.usage;content=answer.content;
      cycle.push({role:'assistant',content:answer.content,...(answer.calls.length?{tool_calls:answer.calls}:{})});
      const physical:ToolCall[]=[];
      let invalidPhysical=false;
      const wasFollowing=following;
      for(const call of answer.calls){
        const tool=tools.find(candidate=>candidate.name===call.function.name);let result:unknown;
        if(!tool){invalidPhysical=true;result={ok:false,message:'Unknown tool.'};}
        else if(tool.physical){
          let errors:string[];
          try{const args=JSON.parse(call.function.arguments);errors=validateJsonSchemaValue(tool.parameters,args);if(!errors.length){const problem=tool.validate?.(args);if(problem)errors.push(problem);}}catch{errors=['Invalid JSON arguments.'];}
          if(!errors.length){
            if(tool.resolveAction){
              const {action,...args}=tool.resolveAction(JSON.parse(call.function.arguments));
              physical.push({...call,function:{name:action,arguments:JSON.stringify(args)}});
            }else physical.push(call);
            continue;
          }
          invalidPhysical=true;
          result={ok:false,message:errors.join('; ')};
        }
        else if(tool.name==='look'&&supporting++>=2)result={ok:false,message:'Use at most two look calls before acting. Journal remains freely available.'};
        else if(tool.name==='finish_goal'&&answer.calls.length!==1)result={ok:false,message:'Call finish_goal alone before choosing your next physical action.'};
        else{try{result=await tool.invoke(JSON.parse(call.function.arguments),{signal});}catch{signal.throwIfAborted();result={ok:false,message:'Invalid tool arguments.'};}}
        cycle.push({role:'tool',tool_call_id:call.id,content:JSON.stringify(result)});
        if(call.function.name==='finish_goal'&&(result as {ok?:boolean})?.ok){
          const finished=mind.plan!;
          planEvents.splice(0,planEvents.length,...await this.preparePlan(id,mind,observation,signal,report,(result as {planningCalls:number}).planningCalls));
          if(finished.status==='completed'){journalHint=goalLearningOffer(finished);journalOfferUsed=journalHint;}
          tools=worldTools(this.engine,id,mind,{following,viewAngle,speechMenu,...journalOptions});
          cycle.splice(0,cycle.length,{role:'user',content:JSON.stringify(normalContext())});
        }
        if(call.function.name==='journal'&&(result as {ok?:boolean})?.ok){
          tools=worldTools(this.engine,id,mind,{following,viewAngle,speechMenu,...journalOptions});
        }
        if(call.function.name==='look'&&typeof (result as {viewAngle?:number})?.viewAngle==='number'){
          viewAngle=(result as {viewAngle:number}).viewAngle;
          tools=worldTools(this.engine,id,mind,{following,viewAngle,speechMenu,...journalOptions});
        }
        if(call.function.name==='say'&&!tool?.physical&&(result as {ok?:boolean})?.ok){
          speechMenu=true;
          tools=worldTools(this.engine,id,mind,{following,viewAngle,speechMenu,...journalOptions});
        }
        if(call.function.name==='do_not_reply'&&(result as {ok?:boolean})?.ok){
          speechMenu=false;
          tools=worldTools(this.engine,id,mind,{following,viewAngle,speechMenu,...journalOptions});
        }
        if(call.function.name==='stop_follow'&&(result as {ok?:boolean})?.ok){
          following=false;stopFollowing=true;journalHint=mind.journalOffer;delete mind.journalOffer;journalOfferUsed??=journalHint;
          mind.knownDiscoveries=discoveries;
          tools=worldTools(this.engine,id,mind,{following:false,viewAngle,speechMenu,...journalOptions});
        }
      }
      if(invalidPhysical){for(const call of physical)cycle.push({role:'tool',tool_call_id:call.id,content:JSON.stringify({ok:false,message:'This response contains an invalid physical action. Choose exactly one valid physical action.'})});}
      else if(physical.length===1)return{id,mind,observation,content,calls:physical,planEvents,latencyMs:Date.now()-started,attempts,provider,model,...(!following&&reminder?{reminder}:{}),...(!following&&hints.length?{hints}:{}),...(journalOfferUsed?{journalOffer:journalOfferUsed}:{}),...(journalEntries.length?{journalEntries}:{}),...(journalCompactions.length?{journalCompactions}:{}),...(stopFollowing?{stopFollowing}:{}),...(viewAngle?{viewAngle}:{}),...(usage===undefined?{}:{usage})};
      else if(physical.length>1)for(const call of physical)cycle.push({role:'tool',tool_call_id:call.id,content:JSON.stringify({ok:false,message:'Choose exactly one physical action per response.'})});
      if(wasFollowing&&!following)cycle.push({role:'user',content:JSON.stringify(normalContext())});
      else if(!answer.calls.length)cycle.push({role:'user',content:following?'Choose exactly one: follow or stop_follow.':'Choose exactly one available physical action.'});
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
      if(mind.plan)this.engine.entity(id).plan=clone(mind.plan);
      if (this.mode === 'llm') {
        for(const plan of decision.planEvents??[])this.engine.event(id,'plan',`${plan.status==='active'?'Plan':plan.status==='completed'?'Goal completed':'Goal abandoned'}: ${plan.goal} ${plan.explanation}`,{plan});
        this.engine.event(id, 'observation', 'Observed the shared turn boundary.', { provider: decision.provider, model: decision.model, observation, memory: mind.notes, attention:observation.following&&!decision.stopFollowing?null:compactView(observation).attention??null, reminder:decision.reminder??null, hints:decision.hints??[], journalOffer:decision.journalOffer??null, turn: mind.turns });
        for(const compaction of decision.journalCompactions??[])this.engine.event(id,'journal-compaction',`Condensed ${compaction.before.length} private notes into ${compaction.after.length} before saving a new note.`,compaction);
        this.engine.event(id, 'decision', content?.slice(0, 500) || `Requested one physical action.`, {
          provider: decision.provider, model: decision.model, latencyMs: decision.latencyMs, attempts: decision.attempts, usage: decision.usage ?? null, toolCalls: calls,
        });
      }
      if(decision.stopFollowing)this.engine.act(id,{action:'stop_follow'});
      const tools=worldTools(this.engine,id,mind,{viewAngle:decision.viewAngle,availableOnly:false});
      const speechTools=worldTools(this.engine,id,mind,{viewAngle:decision.viewAngle,availableOnly:false,speechMenu:true});
      for (const call of calls) {
        let result: unknown;
        try {
          const tool = (call.function.name==='say'?speechTools:tools).find(t => t.name === call.function.name && t.physical);
          const args=JSON.parse(call.function.arguments);
          // Ready decisions from older recordings may still contain physical impact coordinates.
          result=call.function.name==='strike_held'&&args.impact&&!args.point
            ?this.engine.act(id,{action:'strike_held',impact:args.impact,orientation:args.orientation})
            :tool?tool.invoke(args):{ok:false,message:'That physical action is not currently available.'};
        } catch { result = { ok: false, message: 'Invalid tool arguments.' }; }
        if (this.mode === 'llm') this.engine.event(id, 'tool-result', call.function.name, { callId: call.id, result });
        mind.lastResult = result;
        this.engine.entity(id).lastAction=result as import('../../src/core/types').ActionResult;
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
          const usedHeld=held&&['place','throw','strike_held','fill','empty','store','dig','join'].includes(call.function.name);
          if(moved&&held)mind.carriedMoves=Math.min(10,(mind.carriedMoves??0)+1);
          else if(usedHeld||!held||(mind.carriedMoves??0)<10)mind.carriedMoves=0;
        }
      }
      this.engine.acknowledgeEncounters(id,observation.encounters??[]);
      this.engine.acknowledgeTerrainChanges(id,observation.terrainChanges??[]);
      if (this.mode === 'llm') {
        for(const note of decision.journalEntries??mind.notes.filter(note=>!previousMind.notes.includes(note)))this.engine.event(id,'memory',note,{notes:mind.notes});
      }
      this.minds.set(id, mind);
    }
    this.engine.wakeMovingListenersFromSpeech();
  }
}

function carryingReminder(kind:string,contents?:string,canDig=false) {
  if(kind==='wood')return 'You are still holding a wood block; try shaping it with strike_held.';
  if(kind==='shovel')return canDig?'Your shovel can remove the reachable soil with dig.':'You are holding a shovel. Look for reachable soil to dig.';
  if(kind==='bucket')return contents?`Your bucket holds ${contents}; you can empty it.`:'Your empty bucket can carry material when fill is available.';
  return `You are still holding ${kind}; you could place or throw it.`;
}

function goalLearningOffer(plan:AgentPlan) {
  return `You completed the goal "${plan.goal}". What memorable fact did you learn about the world? If you discovered a durable rule, useful method, important location, or surprising property, use journal now to preserve that lesson. Record the learned fact, not a recap of actions or merely that the goal is complete. Skip journal if nothing memorable was learned.`;
}

function abstractPlanningContext(engine:Engine,observation:Observation,mind:Mind,capabilities:string[],actions:ReturnType<typeof recentActions>) {
  const kinds=(values:string[])=>[...new Set(values)];
  const interactions=observation.interactions;
  return rounded({
    surroundings:{
      terrain:observation.surfaces.map(({kind,count,nearest})=>({kind,visibleBlocks:count,nearest})),
      creatures:observation.entities.map(({name,kind})=>({name,kind})),
      obstacles:kinds(observation.navigation.paths.flatMap(path=>path.issue?[path.issue.message]:[])),
      possibleInteractions:{
        hit:interactions.hit,
        pickup:kinds(interactions.pickup.map(target=>target.kind)),
        speak:interactions.speak.map(target=>target.name),
        follow:interactions.follow.map(target=>target.name),
        ...(interactions.place.length?{place:true}:{}),
        ...(interactions.fill.length?{fill:true}:{}),
        ...(interactions.empty.length?{empty:true}:{}),
      },
    },
    capabilities,
    inventory:inventoryContext(observation),
    learned:relevantKnowledge(engine,observation),
    notes:mind.notes,
    ...(observation.heard.length?{heard:observation.heard.map(({tick,speakerId:_,direction:__,distance:___,...voice})=>({...voice,secondsAgo:(observation.tick-tick)/TICKS_PER_SECOND}))}:{}),
    actionsSinceLastReview:planningActions(actions.slice(-5)),
    progress:progressContext(actions),
    ...(observation.following?{following:{name:observation.following.name}}:{}),
  });
}

function woodProductName(kind:string) {
  if(kind==='plank')return 'planks';
  if(kind==='door_half_up')return 'upper door half';
  if(kind==='door_half_down')return 'lower door half';
  if(kind==='door')return 'rustic door';
  return kind.replaceAll('_',' ');
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
  if (phase === 0 || phase === 8) return { action: 'say', word: phase ? 'Look at this' : "Let's explore together" };
  if (phase === 2 && o.items.length) return { action: 'pickup', itemId: o.items[0].id };
  if (phase === 6 && nearby.length) { const block = nearby.find(b => b[3] !== 'grass') ?? nearby[0]; return { action: 'hit', target: block.slice(0,3) as [number,number,number] }; }
  if (phase % 3 === 0) return { action: 'turn', angle: id === 't1' ? 57 : -73 };
  return { action: 'walk', distance: 6 };
}
