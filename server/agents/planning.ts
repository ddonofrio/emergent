import { setTimeout as delay } from 'node:timers/promises';
import type { AgentPlan, Observation } from '../../src/core/types';
import { validateJsonSchemaValue, type JsonSchemaNode } from '../../vendor/deepseek-harness/json-schema';
import type { CompletionRequest, CompletionResult } from './providers';
import { PLAN_REVIEW_INTERVAL } from '../../src/core/memory';
import { inventoryAmounts, milestoneEvidence, goalEvidence, referencedGoalEvidence } from './milestones';
import { decisionCycle, type recentActions } from './context';
import { InferenceAuditError } from './audit';
import { compactPlanDraft } from './plan-compaction';

interface PlanTextLimits { text:number;progress:number }
const COMPACT_LIMITS:PlanTextLimits={text:500,progress:1200};
const EXPANDED_LIMITS:PlanTextLimits={text:1000,progress:2400};
const text=(value:unknown,maximum:number):value is string=>typeof value==='string'&&value.trim().length>0&&value.length<=maximum;
const sentenceSchema=(maximum:number):JsonSchemaNode=>({type:'string',minLength:1,maxLength:maximum});
const shortList=(value:unknown,maximum:number,minimum=0,textMaximum=COMPACT_LIMITS.text):value is string[]=>Array.isArray(value)&&value.length>=minimum&&value.length<=maximum&&value.every(item=>text(item,textMaximum));
const projectSchema=(limits:PlanTextLimits):JsonSchemaNode=>{const sentence=sentenceSchema(limits.text);return{type:'object',properties:{goal:{...sentence,description:`Your sustained project, 1..${limits.text} characters. Preserve it across tasks while it still matters.`},successCondition:{...sentence,description:`What you would observe if this project succeeded, 1..${limits.text} characters.`},progress:{type:'string',minLength:1,maxLength:limits.progress,description:`What has actually happened, what remains, and why. Up to ${limits.progress} characters. Separate hypotheses from observed facts.`},openQuestions:{type:'array',items:sentence,description:`Up to four untested questions or assumptions, each at most ${limits.text} characters.`}},required:['goal','successCondition','progress','openQuestions'],additionalProperties:false};};
const validProject=(value:any,limits=COMPACT_LIMITS):value is NonNullable<AgentPlan['project']>=>value&&text(value.goal,limits.text)&&text(value.successCondition,limits.text)&&text(value.progress,limits.progress)&&shortList(value.openQuestions,4,0,limits.text);
const approachSchema=(limits:PlanTextLimits):JsonSchemaNode=>({type:'array',items:sentenceSchema(limits.text),description:`One to three conditional next actions for the executor, at most ${limits.text} characters each. Use available capabilities; these are suggestions, not an automatic queue. One action must tell the executor to call journal after a relevant new finding so it is not lost.`});
const hasJournalAction=(value:unknown):value is string[]=>Array.isArray(value)&&value.some(item=>typeof item==='string'&&/\bjournal\b/i.test(item));
function planningSchema(reviewing:boolean,strategic:boolean,free:boolean,outcomes:string[],limits:PlanTextLimits):JsonSchemaNode {
  const sentence=sentenceSchema(limits.text),project=projectSchema(limits),approach=approachSchema(limits);
  return reviewing?{
    type:'object',properties:{outcome:{type:'string',enum:outcomes},explanation:sentence,...(strategic?{project,suggestedActions:approach}:{}),...(free?{evidenceEventIds:{type:'array' as const,items:{type:'integer' as const},description:'For complete, cite recorded event IDs from availableEvidence that support your assessment.'}}:{})},required:['outcome','explanation',...(strategic?['project','suggestedActions']:[])],additionalProperties:false,
  }:{
    type:'object',properties:{direction:{...sentence,description:`Your longer-term interest or purpose, chosen by you. 1..${limits.text} characters.`},project,goal:{...sentence,description:`One immediate task that advances your project, 1..${limits.text} characters. Do not combine unrelated activities.`},successCondition:{...sentence,description:`A bounded, observable result for this task, 1..${limits.text} characters. Untested possibilities are not ruled out by one failure.`},suggestedActions:approach,explanation:{...sentence,description:`Why this task now, or why the project changed. 1..${limits.text} characters.`}},required:['direction','project','goal','successCondition','suggestedActions','explanation'],additionalProperties:false,
  };
}
function argumentProblems(parameters:JsonSchemaNode,args:any,strategic:boolean,reviewing:boolean,limits=COMPACT_LIMITS) {
  const problems=validateJsonSchemaValue(parameters,args);
  if(problems.length)return problems;
  const check=(path:string,value:unknown,maximum=limits.text)=>{if(!text(value,maximum))problems.push(`${path} must contain 1..${maximum} characters; received ${typeof value==='string'?value.length:typeof value}.`);};
  check('explanation',args.explanation);
  if(!reviewing){check('direction',args.direction);check('goal',args.goal);check('successCondition',args.successCondition);}
  if(strategic||!reviewing){
    check('project.goal',args.project.goal);check('project.successCondition',args.project.successCondition);check('project.progress',args.project.progress,limits.progress);
    if(!shortList(args.project.openQuestions,4,0,limits.text))problems.push(`project.openQuestions must be an array of zero to four strings, each 1..${limits.text} characters.`);
    if(!shortList(args.suggestedActions,3,1,limits.text))problems.push(`suggestedActions must be a flat array of one to three strings, each 1..${limits.text} characters.`);
    else if(!hasJournalAction(args.suggestedActions))problems.push('suggestedActions must include a conditional action to call journal after a relevant new finding.');
  }
  return problems;
}
function changedDecisionProblems(draft:any,value:any,reviewing:boolean,free:boolean) {
  if(!reviewing)return [];
  const problems:string[]=[];
  if(value?.outcome!==draft?.outcome)problems.push('Compaction must preserve outcome exactly.');
  if(free&&JSON.stringify(value?.evidenceEventIds??[])!==JSON.stringify(draft?.evidenceEventIds??[]))problems.push('Compaction must preserve evidenceEventIds exactly.');
  return problems;
}
export function needsPlanReview(plan:AgentPlan|undefined,turn:number,actions:ReturnType<typeof recentActions>=[]) {
  return !plan||![2,3,4].includes(plan.version??0)||plan.steps.length!==1||((plan.version??0)<3&&!plan.steps[0].criterion)||(plan.version===4&&(!validProject(plan.project)||!shortList(plan.suggestedActions,3,1)||!hasJournalAction(plan.suggestedActions)))||plan.status!=='active'||!plan.steps.some(step=>step.status==='pending')||turn-plan.reviewedTurn>=PLAN_REVIEW_INTERVAL
    || !!decisionCycle(actions.filter(entry=>entry.atSecond>(plan.startedAtSecond??0)&&entry.eventId>(plan.reviewedEventId??0)));
}

export function experienceReviewReason(plan:AgentPlan|undefined,turn:number,actions:ReturnType<typeof recentActions>,discoveries:{message:string}[]) {
  if(plan?.version!==4)return undefined;
  if(discoveries.length)return `New observed knowledge may change your method: ${discoveries.map(item=>item.message).join(' ')}`;
  const recent=actions.filter(entry=>entry.eventId>(plan.reviewedEventId??0)).slice(-12);
  if(recent.filter(entry=>!entry.result.ok||['blocked','partial','rejected'].includes(entry.result.outcome)).length>=3)return 'Several attempts were blocked or only partially executed. Review the available capabilities and change the method or suspend this task.';
  if(turn-plan.reviewedTurn<8)return undefined;
  const emptySearches=recent.filter(entry=>entry.action==='find_entity'&&!entry.result.entities?.length);
  if(emptySearches.length>=4)return 'At least four recent creature searches found nobody. Use your recorded search regions and last sightings to choose a different search method, or suspend the search. Repeating an empty scan does not establish progress.';
  const scans=recent.filter(entry=>entry.action==='find_material');
  if(scans.length>=4&&new Set(scans.map(entry=>JSON.stringify(entry.result.materials?.map((item:{material:string})=>item.material).sort()))).size===1)return 'Recent material scans keep finding the same material types. Decide what new information your next action would provide or how to use what you already learned.';
  return undefined;
}

/** The model authors its goal and success condition; recorded effects ground its reviews. */
export async function planDecision(options:{
  name:string;turn:number;time:number;plan?:AgentPlan;context:unknown;planningInstructions?:string;
  actions:ReturnType<typeof recentActions>;observation?:Observation;
  upgrade?:boolean;reviewReason?:string;
  signal:AbortSignal;retryDelayMs?:number;
  complete(request:CompletionRequest,signal:AbortSignal):Promise<CompletionResult>;
  compact?(request:CompletionRequest,signal:AbortSignal):Promise<CompletionResult>;
  waiting(message:string):void;save(plan:AgentPlan):void;
}):Promise<AgentPlan> {
  let previous=options.plan,correction='',previousAttempt:unknown;
  while(true){
    options.signal.throwIfAborted();
    const reviewing=!options.upgrade&&previous?.status==='active'&&previous.steps.some(step=>step.status==='pending');
    const free=(previous?.version??0)>=3;
    const strategic=previous?.version===4;
    const legacy=reviewing&&(![2,3,4].includes(previous!.version??0)||previous!.steps.length!==1||(!free&&!previous!.steps[0].criterion)||previous!.startedAtSecond===undefined);
    const evidence=reviewing&&!legacy?milestoneEvidence(previous!,options.actions,options.observation):[];
    const availableEvidence=reviewing?goalEvidence(previous!,options.actions):[];
    const name=reviewing?'review_plan':'set_plan';
    const outcomes=legacy?['abandon']:free?['continue',...(availableEvidence.length?['complete']:[]),'abandon']:evidence.length?['complete','abandon']:(previous?.stalledReviews??0)>=1?['abandon']:['continue','abandon'];
    const parameters=planningSchema(reviewing,strategic,free,outcomes,COMPACT_LIMITS);
    const acceptedParameters=planningSchema(reviewing,strategic,free,outcomes,EXPANDED_LIMITS);
    const compactParameters=parameters;
    const instruction=reviewing
      ? free?'Review your own success condition against current observations and availableEvidence. Explain progress or obstacles. For complete, cite relevant event IDs and explain how their actual results satisfy the condition; successful tool execution alone is not goal completion. Completion is your assessment, not a verified world fact. You may continue or abandon; a reminder or repeated cycle does not force a new goal.':'Review verifiedProgress and any repeated cycle. Only recorded effects prove success. Moving inventory between hands and storage does not collect anything. Choose an allowed outcome. Older incompatible plans must be abandoned before writing a new goal. Explain what changed or prevented progress.'
      : 'Choose your own direction and sustained project, then give your executor one immediate task and one to three conditional next actions. Preserve the project and its progress across tasks unless you have a reason to change it. There is no assigned activity or goal catalog. Use your accumulated experience, current observations and interests. A blocked task does not erase its parent project. Record unanswered questions instead of treating assumptions as facts.';
    let saving=false;
    try{
      const answer=await options.complete({messages:[
        {role:'system',content:`${options.planningInstructions?.replaceAll('{name}',options.name)??`You are ${options.name}, a curious agent planning your next activity in a physical world.`} ${instruction} Distinguish observations, hypotheses and wishes. Always include one suggestedActions entry that tells the executor to call journal before its next physical action when it has a relevant new finding. Relevant findings include durable world knowledge, exact experiment results, useful locations, corrected beliefs, and unresolved work or uncertainty needed later; routine movement and repeated facts do not qualify. If a relevant finding is already visible in this planning context but absent from the notes, make that journal action specific enough to preserve it. Old plans and journal notes can contain mistakes: verify their claims against learned facts and recorded experiments before preserving them. If your reasoning corrects an old private note, make the journal action name the stable note IDs to correct using replaceNoteIds. Current inventory overrides historical quantities. Ideas from other worlds or games are hypotheses here, never known recipes. Compare exact experiment inputs before generalizing; unavailable tools mean a blocked test, not a tested negative result. Check capabilitiesAfterChangingHands before declaring a test unavailable. For a learning task, success means observing and recording a bounded test, even if its outcome differs from your prediction. Use earlier discoveries even when the material is not in your hands. On repeated failure, change the method or suspend the task rather than merely repeat it. Past speech and locations are historical. Write each short text field as one concise sentence of at most 500 characters; project.progress may use at most 1200 characters. Keep the complete visible tool response within 2200 output tokens. Call only ${name}; no extra prose. Use actual JSON objects and arrays, not JSON encoded inside strings. Planning consumes no world time.`},
        {role:'user',content:JSON.stringify({...(reviewing?{successCondition:previous!.steps.find(step=>step.status==='pending')?.task,...(free?{availableEvidence,assessment:'Judge progress against the task success condition; cite actual observed effects. Completing a task does not automatically complete the project.'}:{verifiedProgress:{complete:!!evidence.length,evidence,legacy}}),allowedOutcomes:outcomes,previousPlan:previous,elapsedDecisions:options.turn-previous!.createdTurn}:{...(previous?{previousPlan:previous}:{})}),...(options.upgrade?{transition:'Reframe your existing activity as a project and one immediate task. Keep useful progress and commitments, but question unsupported assumptions.'}:{}),...(options.reviewReason?{reviewReason:options.reviewReason}:{}),situation:options.context,...(correction?{correction,previousAttempt}:{})})},
      ],tools:[{type:'function',function:{name,description:reviewing?'Review your task, update project progress and adjust the suggested method using observed results.':'Write your own direction, project, immediate task and suggested actions.',parameters}}],max_tokens:4400,reasoning:'maximum'},options.signal);
      options.signal.throwIfAborted();
      let args:any;
      if(answer.calls.length===1&&answer.calls[0].function.name===name){try{args=JSON.parse(answer.calls[0].function.arguments);}catch{}}
      let problems=args?argumentProblems(acceptedParameters,args,strategic,reviewing,EXPANDED_LIMITS):[`Call ${name} exactly once with valid JSON arguments.`];
      if(args&&!problems.length){
        const compactProblems=argumentProblems(compactParameters,args,strategic,reviewing,COMPACT_LIMITS);
        if(compactProblems.length){
          options.waiting('Compacting an expanded planning draft; world time is held.');
          const draft=args;
          args=await compactPlanDraft({name:options.name,mode:name,draft:args,parameters:compactParameters,signal:options.signal,retryDelayMs:options.retryDelayMs,
            validate:value=>[...argumentProblems(compactParameters,value,strategic,reviewing,COMPACT_LIMITS),...changedDecisionProblems(draft,value,reviewing,free)],complete:options.compact??options.complete,waiting:options.waiting});
          problems=[...argumentProblems(compactParameters,args,strategic,reviewing,COMPACT_LIMITS),...changedDecisionProblems(draft,args,reviewing,free)];
        }
      }
      let next:AgentPlan|undefined;
      if(args&&!problems.length){
        if(!reviewing){
          if(text(args.direction,500)&&validProject(args.project)&&shortList(args.suggestedActions,3,1)&&text(args.goal,500)&&text(args.successCondition,500))next={version:4,direction:args.direction.trim(),project:args.project,suggestedActions:args.suggestedActions,goal:args.goal.trim(),status:'active',steps:[{task:args.successCondition.trim(),status:'pending'}],explanation:args.explanation.trim(),createdTurn:options.turn,reviewedTurn:options.turn,startedAtSecond:options.time,stalledReviews:0,inventoryBaseline:inventoryAmounts(options.observation?.self.inventory??null),reviewedEventId:options.actions.at(-1)?.eventId??0};
        }else if(reviewing&&outcomes.includes(args.outcome)){
          const status=args.outcome==='continue'?'active':args.outcome==='complete'?'completed':'abandoned';
          const references=free?referencedGoalEvidence(previous!,options.actions,args.evidenceEventIds):evidence;
          if((!strategic||(validProject(args.project)&&shortList(args.suggestedActions,3,1)))&&(status!=='completed'||references?.length))next={...previous!,...(strategic?{project:args.project,suggestedActions:args.suggestedActions}:{}),...(status==='active'?{}:{intention:undefined}),status,reviewedTurn:options.turn,reviewedEventId:options.actions.at(-1)?.eventId??0,explanation:args.explanation.trim(),stalledReviews:status==='active'?(previous!.stalledReviews??0)+1:0,
            steps:previous!.steps.map(step=>step.status!=='pending'?step:status==='active'?step:{...step,status:status==='completed'?'completed':'abandoned',evidence:free?args.explanation.trim():status==='completed'?references!.map(item=>item.message).join(' ').slice(0,500):args.explanation.trim(),...(status==='completed'?{evidenceEventIds:references!.map(item=>item.eventId),...(free?{assessment:'agent' as const}:{})}:{})})};
        }
      }
      if(next){
        if(next.intention===undefined)delete next.intention;
        saving=true;options.save(next);saving=false;
        if(next.status==='active')return next;
        previous=next;correction='';previousAttempt=undefined;continue;
      }
      correction=reviewing?`Choose only an allowed outcome: ${outcomes.join(', ')}. Invented evidence cannot complete a goal. For complete, cite IDs from availableEvidence.${strategic?' Include the updated project and one to three suggestedActions, with one conditional action that calls journal after a relevant new finding.':''} Follow the contract: explanation must be at most 500 characters.`:'Supply direction, project (goal, successCondition, progress, openQuestions), goal, successCondition, one to three suggestedActions (including a conditional action that calls journal after a relevant new finding), and explanation. Follow the contract: text fields are 1..500 characters, except project.progress (1..1200), and use at most four openQuestions.';
      if(problems.length)correction=`Correct these errors in your previous attempt: ${problems.join(' ')} ${correction}`;
      previousAttempt=JSON.stringify(answer.calls).slice(0,10000);
      options.waiting('Waiting for a valid goal or review; world time is held.');
    }catch(error){
      if(saving||error instanceof InferenceAuditError)throw error;
      options.signal.throwIfAborted();options.waiting(error instanceof Error?error.message:'Waiting for planning inference.');
    }
    await delay(options.retryDelayMs??1000,undefined,{signal:options.signal});
  }
}
