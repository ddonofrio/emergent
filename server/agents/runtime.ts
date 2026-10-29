import { setTimeout as delay } from 'node:timers/promises';
import type { Engine } from '../../src/core/engine';
import { clone, distance, type Action, type ActionResult, type AgentPlan, type Observation } from '../../src/core/types';
import { validateJsonSchemaValue } from '../../vendor/deepseek-harness/json-schema';
import { PLAN_REMINDER_INTERVAL, PLAN_REVIEW_INTERVAL, PRIVATE_NOTE_LIMIT } from '../../src/core/memory';
import { TICKS_PER_SECOND, TURN_TICKS, type DecisionStatus } from '../../src/core/time';
import { isObservedMaterialKnowledge } from '../../src/core/knowledge';
import type { Store } from '../store';
import { DEFAULT_REASONING, InvalidCompletionError, ProviderChain, type CompletionRequest, type ProviderConfig, type ProviderStrategy, type ToolCall } from './providers';
import { worldTools, type Memory } from './tools';
import { actionFeedback, bodyContext, compactResult, compactView, decisionView, historicalActions, inventoryContext, planningActions, progressContext, recentActions, relevantKnowledge, rounded, speechContext } from './context';
import { compactJournal } from './journal-compaction';
import { experienceReviewReason, needsPlanReview, planDecision } from './planning';
import { ExperienceMemory } from './experience';
import { inventoryAmounts, milestoneEvidence, taskEvidenceView, referencedGoalEvidence } from './milestones';
import { auditedCompletion, InferenceAuditError } from './audit';

interface Message { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string; }
interface Mind extends Memory {
  plan?: AgentPlan;
  turns: number; modelTurns: number; lastResult?: unknown;
  carriedMoves?: number; carryingReminder?: string; emptyHandMoves?: number;
  knownDiscoveries?: string[]; lastEncounters?: Record<string,number>; lastSpoken?: Record<string,number>;
  journalOffer?: string;
  acknowledgedSpeechTick?: number;
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
const MAX_SUPPORTING_CALLS = 4;
const MAX_CORRECTION_ROUNDS = 4;
const REQUIRED_SUPPORT_TOOLS = new Set(['finish_goal','stop_follow','do_not_reply']);

export class AgentRuntime {
  readonly minds = new Map<string, Mind>();
  private readonly experience = new Map<string, ExperienceMemory>();
  inference: ProviderChain;
  parallelRequests: boolean;
  constructor(readonly engine: Engine, readonly store: Store, readonly config: {
    providers: ProviderConfig[]; maxTurns: number | null; retryDelayMs?: number;
  }) {
    this.parallelRequests=store.loadParallelRequests();
    this.inference = new ProviderChain(config.providers);
    for (const entity of engine.entities.filter(e => e.controller === 'agent')) {
      this.experience.set(entity.id,new ExperienceMemory(store,entity.id));
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
  get mode(): 'llm' | 'demo' { return this.inference.enabled ? 'llm' : 'demo'; }
  private infer(id:string,phase:string,request:CompletionRequest,signal:AbortSignal,onAttempt:(provider:ProviderConfig,index:number)=>void) {
    request={reasoning:DEFAULT_REASONING,...request};
    return auditedCompletion(this.store,this.engine.tick,id,phase,request,signal,()=>this.inference.complete(request,signal,onAttempt));
  }
  setParallelRequests(enabled:boolean) { this.store.saveParallelRequests(enabled);this.parallelRequests=enabled; }
  setInferenceConfig(providers:ProviderConfig[],strategy:ProviderStrategy){
    this.config.providers=providers;
    this.inference=new ProviderChain(providers,strategy);
  }
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
          const answer=await this.infer(input.id,'movement',{messages,tools,max_tokens:300},signal,(candidate,index)=>report(input.id,{state:index?'waiting':'thinking',attempts,message:`${index?'Falling back to':'Trying'} ${candidate.name}; world time is held.`}));
          input.mind.modelTurns++;provider=answer.provider;model=answer.model;usage=answer.usage;content=answer.content;
          const calls=answer.calls.filter(call=>call.function.name==='continue_moving'||call.function.name==='stop_moving');
          if(calls.length===1){
            try{const args=JSON.parse(calls[0].function.arguments);if(args&&typeof args==='object'&&!Array.isArray(args)&&Object.keys(args).length===0)return {id:input.id,tick,choice:calls[0].function.name as 'continue_moving'|'stop_moving',mind:input.mind,content,latencyMs:Date.now()-started,attempts,provider,model,...(usage===undefined?{}:{usage})};}catch{}
          }
          messages.push({role:'assistant',content:answer.content,...(answer.calls.length?{tool_calls:answer.calls}:{})},{role:'user',content:'Choose exactly one: continue_moving or stop_moving, with no arguments.'});
        }catch(error){signal.throwIfAborted();if(error instanceof InferenceAuditError)throw error;report(input.id,{state:'waiting',attempts,message:error instanceof Error?error.message:'Inference providers unavailable.'});await delay(Math.min(10000,(this.config.retryDelayMs??1000)*2**Math.min(attempts-1,4)),undefined,{signal});}
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
  private actionHistory(id:string,tick:number,plan?:AgentPlan) {
    const memory=this.experience.get(id)!;
    memory.read(tick,plan);
    const recent=recentActions(this.store.actionEventsAt(tick,id,PLAN_REVIEW_INTERVAL*2),PLAN_REVIEW_INTERVAL*2);
    return [...new Map([...memory.experimentActions(),...recent].map(entry=>[entry.eventId,entry])).values()].sort((a,b)=>a.eventId-b.eventId);
  }
  private async preparePlan(id:string,mind:Mind,observation:Observation,signal:AbortSignal,report:Report,alreadyCounted=0) {
    type StagedPlan={plan:AgentPlan;events:AgentPlan[];modelCalls:number;acknowledged?:boolean};
    const actor=`plan:${id}`,cached=this.store.loadPending<StagedPlan>(observation.tick,actor,this.inference.cacheKey);
    const actions=this.actionHistory(id,observation.tick,mind.plan);
    const upgrade=mind.plan?.version===3;
    const discoveries=this.store.discoveriesSince(observation.tick,id,mind.plan?.reviewedEventId??0).filter(event=>!isObservedMaterialKnowledge((event.data as {knowledge?:unknown}|undefined)?.knowledge));
    const reviewReason=experienceReviewReason(mind.plan,mind.turns,actions,discoveries);
    if(!cached&&!upgrade&&!reviewReason&&!needsPlanReview(mind.plan,mind.turns,actions))return [];
    const staged:StagedPlan=cached??{plan:mind.plan!,events:[],modelCalls:0};
    if(!cached||staged.plan.status!=='active'||![2,3,4].includes(staged.plan.version??0)){
      const capabilities=worldTools(this.engine,id,mind,{following:!!observation.following})
        .filter(tool=>!tool.description.startsWith('Disabled'))
        .map(tool=>({name:tool.name,description:tool.description,parameters:tool.parameters}));
      // Preview only capabilities of already owned items; never execute these tools or change hands.
      const knownCapabilities=new Set(capabilities.map(tool=>tool.name));
      const hands=[null,...(observation.self.inventory?.stacks.map((_,index)=>index)??[])];
      const capabilitiesAfterChangingHands=hands.flatMap(hand=>{
        const stack=hand===null?undefined:observation.self.inventory!.stacks[hand];
        const tools=worldTools(this.engine,id,mind,{following:false,availableOnly:false,previewHand:hand})
          .filter(tool=>!tool.description.startsWith('Disabled')&&!knownCapabilities.has(tool.name))
          .map(tool=>({name:tool.name,description:tool.description,parameters:tool.parameters}));
        return tools.length?[{requires:{holding:stack?.kind??'empty',...(stack?.contents?{contents:stack.contents}:{}),...(observation.following?{stopFollowing:true}:{})},tools}]:[];
      });
      const experience=this.experience.get(id)!.read(observation.tick,cached?.plan??mind.plan);
      const context={...abstractPlanningContext(this.engine,observation,mind,capabilities,actions.slice(-PLAN_REVIEW_INTERVAL)),capabilitiesAfterChangingHands,experience};
      staged.plan=await planDecision({name:observation.self.name,planningInstructions:this.engine.module.manifest.planningInstructions,turn:mind.turns,time:observation.time,plan:cached?.plan??mind.plan,upgrade:!cached&&upgrade,reviewReason,context,actions,observation,signal,retryDelayMs:this.config.retryDelayMs,
        complete:async(request,abort)=>{
          report(id,{state:'planning',message:'Planning a goal and reviewing steps; world time is held.'});
          const answer=await this.infer(id,'planning',request,abort,(provider)=>report(id,{state:'planning',message:`Planning with ${provider.name}; world time is held.`}));
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
    const actions=this.actionHistory(id,observation.tick,mind.plan);
    delete mind.journalOffer;
    const journalCompactions:NonNullable<PreparedDecision['journalCompactions']>=[];
    const journalEntries:string[]=[];
    const journalOptions={
      compactJournal:async(notes:readonly string[],incoming:string)=>{
        const after=await compactJournal({name:observation.self.name,notes,incoming,signal,retryDelayMs:this.config.retryDelayMs,
          complete:async(request,abort)=>{const result=await this.infer(id,'journal',request,abort,(candidate)=>report(id,{state:'thinking',message:`Compacting journal with ${candidate.name}; world time is held.`}));mind.modelTurns++;return result;},
          waiting:message=>report(id,{state:'waiting',message})});
        journalCompactions.push({before:[...notes],after,incoming});return after;
      },
      onJournalEntry:(note:string)=>{journalEntries.push(note);},
      onFinishGoal:(outcome:'completed'|'abandoned'|'blocked',reason:string,evidenceEventIds?:number[])=>{
        const staged=this.store.loadPending<{modelCalls:number;acknowledged?:boolean}>(observation.tick,`plan:${id}`,this.inference.cacheKey);
        if(staged?.acknowledged)return {ok:false,message:'You already changed goals in this decision. Choose one physical action before changing again.'};
        const free=(mind.plan!.version??0)>=3;
        const evidence=free?referencedGoalEvidence(mind.plan!,actions,evidenceEventIds):milestoneEvidence(mind.plan!,actions,observation);
        if(outcome==='completed'&&!evidence?.length)return {ok:false,message:free?'Cite one or more event IDs from plan.availableEvidence and explain how their actual outcomes satisfy your success condition. No recorded evidence was cited.':'No recorded effect proves this milestone yet. Hold and store only change your hands; they do not collect items. Success requires the stated goal condition. Continue, or abandon with a reason.'};
        const closed:AgentPlan={...clone(mind.plan!),intention:undefined,status:outcome,reviewedTurn:mind.turns,explanation:reason,steps:mind.plan!.steps.map(step=>step.status!=='pending'?step:{...step,status:outcome,evidence:free?reason:outcome==='completed'?evidence![0].message:reason,...(outcome==='completed'?{evidenceEventIds:evidence!.map(item=>item.eventId),...(free?{assessment:'agent' as const}:{})}:{})})};
        delete closed.intention;
        this.store.savePending(observation.tick,`plan:${id}`,this.inference.cacheKey,{plan:closed,events:[...planEvents,closed],modelCalls:staged?.modelCalls??0,acknowledged:true});
        mind.plan=closed;
        return {ok:true,message:'Goal closed. Write your next goal before your next physical action.',planningCalls:staged?.modelCalls??0};
      },
    };
    const currentCriterion=()=>mind.plan?.steps.find(step=>step.status==='pending')?.criterion;
    const makeTools=()=>{
      const staged=this.store.loadPending<{acknowledged?:boolean}>(observation.tick,`plan:${id}`,this.inference.cacheKey);
      return worldTools(this.engine,id,mind,{following,viewAngle,speechMenu,concise:true,goalCriterion:currentCriterion(),...journalOptions,...(staged?.acknowledged?{onFinishGoal:undefined}:{})}).map(tool=>tool.physical?{...tool,parameters:{...tool.parameters,properties:{...tool.parameters.properties,intention:{type:'string' as const}}}}:tool);
    };
    const system = ()=>[
      `CURRENT GOAL: ${mind.plan!.goal}\nSUCCESS CONDITION: ${mind.plan!.steps.find(step=>step.status==='pending')?.task??mind.plan!.goal}\n${(mind.plan!.version??0)>=3?'This is your intended task, not proof that its assumptions are true.':milestoneEvidence(mind.plan!,actions,observation).length?`STATUS: Achieved. ${following?'Use stop_follow, then ':''}Call finish_goal with completed now.`:'STATUS: Not yet achieved.'}`,
      this.engine.module.manifest.agentInstructions.replace('{name}', observation.self.name),
      'End this decision with exactly one physical action; never batch two physical tools. You may use supporting tools first. Follow the suggested method only while current facts support it. If the task cannot be tested with available tools, call finish_goal alone with blocked and explain why; this asks your planner to reconsider without completing the project. Optional intention: a next-step reminder of 1..200 characters, never automatically executed. Past speech is historical, not current navigation.',
      'Use journal for important insights, uncertainties, commitments and unfinished work your future self needs. Actions and discoveries are recorded automatically; your interpretations are not. Keep exact experimental conditions and uncertainty. Do not turn an untested idea or a single failure into a universal fact. Append useful new notes. When a discovery contradicts an old note, correct that specific claim instead of carrying its false conclusion forward.',
      lookCalls>=2?'The look limit is exhausted for this decision. Choose from the current observation and available tools.':undefined,
      supportingCalls>=MAX_SUPPORTING_CALLS?'The supporting-tool limit is exhausted for this decision. Choose one available physical action.':undefined,
      !following&&mind.notes.length?'Notes are your past interpretations, oldest first. Check them against observed results; an old note or plan cannot override contradictory evidence.':undefined,
    ].filter(Boolean).join('\n');
    const notes=()=>mind.notes.length?{notes:mind.notes}:{};
    const recent=historicalActions(actions),learned=relevantKnowledge(this.engine,observation,true);
    const lastResult=(observation.self.lastAction??mind.lastResult) as ActionResult|undefined;
    const latest=recent.at(-1),lastRecorded=latest&&latest.result.message===lastResult?.message?latest:undefined;
    const priorActions=lastRecorded?recent.slice(-4,-1):recent.slice(-4);
    const heard=speechContext(observation,mind.acknowledgedSpeechTick);
    const planContext=()=>{
      const plan=mind.plan!,elapsed=mind.turns-plan.reviewedTurn,reached=milestoneEvidence(plan,actions,observation);
      const step=plan.steps.find(step=>step.status==='pending');
      const amounts=inventoryAmounts(observation.self.inventory);
      const inventoryChange=[...new Set([...Object.keys(amounts),...Object.keys(plan.inventoryBaseline??{})])].map(key=>({kind:JSON.parse(key)[0],contents:JSON.parse(key)[1],change:(amounts[key]??0)-(plan.inventoryBaseline?.[key]??0)})).filter(item=>item.change!==0);
      return {goal:plan.goal,successCondition:step?.task,...(plan.project?{project:plan.project.goal,why:plan.explanation,suggestedActions:plan.suggestedActions,openQuestions:plan.project.openQuestions}:{}),...((plan.version??0)>=3?{assessment:'Completion is your assessment. Cite relevant availableEvidence in finish_goal; an accepted action alone does not establish success. A blocked test is not a negative experimental result.',availableEvidence:taskEvidenceView(plan,actions),inventoryChangeSinceGoal:inventoryChange}:{criterion:step?.criterion,goalAchieved:!!reached.length,...(step?.criterion?.kind==='collect'?{inventoryChangeSinceGoal:inventoryChange}:{})}),elapsedTaskDecisions:Math.max(0,mind.turns-plan.createdTurn),
        ...((plan.version??0)<3&&(plan.steps.length!==1||!plan.steps[0].criterion)?{legacyPlan:'This older plan has no verifiable completion criterion. Use finish_goal with abandoned to write your own new goal. Do not continue work whose prerequisite was abandoned.'}:{}),
        ...(reached.length?{milestoneReached:reached,instruction:following?'This milestone is achieved. Use stop_follow, then finish_goal with completed.':'This milestone is achieved. Call finish_goal with completed now.'}:{}),
        ...(elapsed>0&&elapsed%PLAN_REMINDER_INTERVAL===0?{reviewReminder:'Check your goal against recorded progress. Use finish_goal if achieved or no longer useful; otherwise continue. This reminder does not call the planner.'}:{}),
      };
    };
    const terrainChanges=observation.terrainChanges.length?{terrainChanges:observation.terrainChanges.map(notice=>notice.message)}:{};
    const continuation=()=>mind.plan?.intention?{previousIntention:{text:mind.plan.intention,status:lastResult?.ok===false?'The action failed; reconsider this intention.':'Unverified reminder; check current facts before continuing.'}}:{};
    const normalContext=()=>rounded({plan:planContext(),...continuation(),...(lastResult?{lastResult:{...(lastRecorded?{action:lastRecorded.action,args:lastRecorded.args}:{}),...actionFeedback(compactResult(lastResult))}}:{}),inventory:inventoryContext(observation),...heard,...terrainChanges,...decisionView(this.engine.observeAt(id,viewAngle),currentCriterion()),...(observation.beingFollowed?.length?{beingFollowed:observation.beingFollowed.map(follower=>follower.message)}:{}),progress:progressContext(recent.filter(entry=>entry.atSecond>(mind.plan?.startedAtSecond??0))),...(learned.length?{learned}:{}),...notes(),...(priorActions.length?{recent:priorActions.map(entry=>({...entry,result:actionFeedback(entry.result)}))}:{})});
    const initial=following?{plan:planContext(),...continuation(),following:observation.following,...heard,...terrainChanges}:normalContext();
    const cycle:Message[]=[{role:'user',content:JSON.stringify(initial)}];
    let attempts=0,supportingCalls=0,lookCalls=0,correctionRounds=0,invalidCompletions=0,provider='unknown',model='unknown',usage:unknown,content:string|null=null,lastProviderError:string|undefined;
    let tools=makeTools();
    const refreshTools=()=>{
      tools=makeTools().filter(tool=>(tool.name!=='look'||lookCalls<2)&&(tool.physical||supportingCalls<MAX_SUPPORTING_CALLS||REQUIRED_SUPPORT_TOOLS.has(tool.name)));
    };
    const resetCorrectionContext=(reason:string)=>{
      correctionRounds=0;
      cycle.splice(0,cycle.length,{role:'user',content:JSON.stringify(following?{plan:planContext(),...continuation(),following:observation.following,...heard,...terrainChanges}:normalContext())});
      refreshTools();
      report(id,{state:'waiting',attempts,message:`${reason} Retrying with a fresh constrained prompt; world time is held.`});
    };
    refreshTools();
    const complete=async()=>{
      while(true){
        signal.throwIfAborted();attempts++;
        report(id,{state:attempts===1?'thinking':'waiting',attempts,message:lastProviderError?`Model error: ${lastProviderError}. Retrying; world time is held.`:'Waiting for an inference provider; world time is held.'});
        try{
          const answer=await this.infer(id,'action',{messages:[{role:'system',content:system()},...cycle],tools:tools.map(({name,description,parameters})=>({type:'function',function:{name,description,parameters}})),max_tokens:900},signal,(candidate,index)=>report(id,{state:index?'waiting':'thinking',attempts,message:`${index?'Falling back to':'Trying'} ${candidate.name}${lastProviderError?`; previous model error: ${lastProviderError}`:''}; world time is held.`}));
          lastProviderError=undefined;return answer;
        }
        catch(error){
          signal.throwIfAborted();
          if(error instanceof InferenceAuditError)throw error;
          if(error instanceof InvalidCompletionError){
            invalidCompletions++;
            if(invalidCompletions%MAX_CORRECTION_ROUNDS===0)resetCorrectionContext(`The model returned ${invalidCompletions} invalid completions. Last error: ${error.message}`);
            else report(id,{state:'waiting',attempts,message:`Invalid model response ${invalidCompletions}; requesting a corrected action while world time is held.`});
            continue;
          }
          lastProviderError=error instanceof Error?error.message:'Inference providers unavailable.';
          report(id,{state:'waiting',attempts,message:`Model error: ${lastProviderError}. Retrying; world time is held.`});await delay(Math.min(10000,(this.config.retryDelayMs??1000)*2**Math.min(attempts-1,4)),undefined,{signal});
        }
      }
    };
    while(true){
      const answer=await complete();signal.throwIfAborted();mind.modelTurns++;provider=answer.provider;model=answer.model;usage=answer.usage;content=answer.content;
      cycle.push({role:'assistant',content:answer.content,...(answer.calls.length?{tool_calls:answer.calls}:{})});
      const physical:ToolCall[]=[];
      const intentions=new Map<string,string>();
      let invalidPhysical=false;
      let rejectedCall='';
      const wasFollowing=following;
      for(const call of answer.calls){
        const tool=tools.find(candidate=>candidate.name===call.function.name);let result:unknown;
        if(!tool){invalidPhysical=true;result={ok:false,message:'Unknown tool.'};}
        else if(tool.physical){
          let errors:string[];
          try{const args=JSON.parse(call.function.arguments);errors=validateJsonSchemaValue(tool.parameters,args);if(!errors.length){const problem=tool.validate?.(args);if(problem)errors.push(problem);if(typeof args.intention==='string'&&(!args.intention.trim()||args.intention.length>200))errors.push('Intention must contain 1..200 characters.');}}catch{errors=['Invalid JSON arguments.'];}
          if(!errors.length){
            const {intention,...parameters}=JSON.parse(call.function.arguments);
            if(intention)intentions.set(call.id,intention.trim());
            physical.push({...call,function:{name:call.function.name,arguments:JSON.stringify(parameters)}});
            continue;
          }
          invalidPhysical=true;
          result={ok:false,message:errors.join('; ')};
        }
        else{
          const limited=!REQUIRED_SUPPORT_TOOLS.has(tool.name);
          if(limited&&supportingCalls>=MAX_SUPPORTING_CALLS)result={ok:false,message:'The supporting-tool limit is exhausted. Choose one available physical action.'};
          else if(tool.name==='look'&&lookCalls>=2)result={ok:false,message:'Use at most two look calls before acting.'};
          else if(tool.name==='finish_goal'&&answer.calls.length!==1)result={ok:false,message:'Call finish_goal alone before choosing your next physical action.'};
          else{
            if(limited)supportingCalls++;
            if(tool.name==='look')lookCalls++;
            try{result=await tool.invoke(JSON.parse(call.function.arguments),{signal});}catch(error){signal.throwIfAborted();if(error instanceof InferenceAuditError)throw error;result={ok:false,message:'Invalid tool arguments.'};}
          }
        }
        if((result as {ok?:boolean})?.ok===false)rejectedCall=(result as {message?:string}).message??`${call.function.name} was rejected.`;
        if(call.function.name==='look'&&typeof (result as {viewAngle?:number})?.viewAngle==='number'){
          viewAngle=(result as {viewAngle:number}).viewAngle;
          result={plan:planContext(),...(result as object)};
        }
        cycle.push({role:'tool',tool_call_id:call.id,content:JSON.stringify(result)});
        if(call.function.name==='finish_goal'&&(result as {ok?:boolean})?.ok){
          planEvents.splice(0,planEvents.length,...await this.preparePlan(id,mind,observation,signal,report,(result as {planningCalls:number}).planningCalls));
          tools=makeTools();
          cycle.splice(0,cycle.length,{role:'user',content:JSON.stringify(normalContext())});
        }
        if(call.function.name==='journal'&&(result as {ok?:boolean})?.ok){
          tools=makeTools();
        }
        if(call.function.name==='look'&&typeof (result as {viewAngle?:number})?.viewAngle==='number'){
          viewAngle=(result as {viewAngle:number}).viewAngle;
          tools=makeTools();
        }
        if(call.function.name==='say'&&!tool?.physical&&(result as {ok?:boolean})?.ok){
          speechMenu=true;
          tools=makeTools();
        }
        if(call.function.name==='do_not_reply'&&(result as {ok?:boolean})?.ok){
          speechMenu=false;
          tools=makeTools();
        }
        if(call.function.name==='stop_follow'&&(result as {ok?:boolean})?.ok){
          following=false;stopFollowing=true;delete mind.journalOffer;
          refreshTools();
        }
        else refreshTools();
      }
      if(invalidPhysical){for(const call of physical)cycle.push({role:'tool',tool_call_id:call.id,content:JSON.stringify({ok:false,message:'This response contains an invalid physical action. Choose exactly one valid physical action.'})});}
      else if(physical.length===1){
        const intention=intentions.get(physical[0].id);
        if(intention)mind.plan!.intention=intention;else delete mind.plan!.intention;
        return{id,mind,observation,content,calls:physical,planEvents,latencyMs:Date.now()-started,attempts,provider,model,...(journalEntries.length?{journalEntries}:{}),...(journalCompactions.length?{journalCompactions}:{}),...(stopFollowing?{stopFollowing}:{}),...(viewAngle?{viewAngle}:{}),...(usage===undefined?{}:{usage})};
      }
      else if(physical.length>1)for(const call of physical)cycle.push({role:'tool',tool_call_id:call.id,content:JSON.stringify({ok:false,message:'Choose exactly one physical action per response.'})});
      const correction=invalidPhysical?'The model chose an invalid physical action.':physical.length>1?'The model chose more than one physical action.':rejectedCall||(!answer.calls.length?'The model returned no tool call.':'');
      if(correction&&++correctionRounds>=MAX_CORRECTION_ROUNDS){resetCorrectionContext(`${correction} The correction cycle reached ${MAX_CORRECTION_ROUNDS} responses.`);continue;}
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
        for(const plan of decision.planEvents??[])this.engine.event(id,'plan',`${plan.status==='active'?'Plan':plan.status==='completed'?(plan.version??0)>=3?'Agent considers goal complete':'Goal completed':plan.status==='blocked'?'Task blocked':'Goal abandoned'}: ${plan.goal} ${plan.explanation}`,{plan});
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
      mind.acknowledgedSpeechTick=Math.max(mind.acknowledgedSpeechTick??-1,...observation.heard.map(voice=>voice.tick));
      if (this.mode === 'llm') {
        for(const note of decision.journalEntries??mind.notes.filter(note=>!previousMind.notes.includes(note)))this.engine.event(id,'memory',note,{notes:mind.notes});
      }
      this.minds.set(id, mind);
    }
    this.engine.wakeMovingListenersFromSpeech();
  }
}

function abstractPlanningContext(engine:Engine,observation:Observation,mind:Mind,capabilities:unknown[],actions:ReturnType<typeof recentActions>) {
  const kinds=(values:string[])=>[...new Set(values)];
  const interactions=observation.interactions;
  return rounded({
    body:bodyContext(observation),
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
    learned:relevantKnowledge(engine,observation,true),
    notes:mind.notes,
    ...speechContext(observation,mind.acknowledgedSpeechTick),
    recentActions:planningActions(actions.slice(-20)),
    progress:progressContext(actions),
    ...(observation.following?{following:{name:observation.following.name}}:{}),
  });
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
