import { setTimeout as delay } from 'node:timers/promises';
import type { AgentPlan, Observation } from '../../src/core/types';
import { validateJsonSchemaValue, type JsonSchemaNode } from '../../vendor/deepseek-harness/json-schema';
import { DEFAULT_REASONING_SETTINGS, type CompletionRequest, type CompletionResult, type ReasoningProfile } from './providers';
import { PLAN_REVIEW_INTERVAL } from '../../src/core/memory';
import { inventoryAmounts, milestoneEvidence, goalEvidence, evidenceContext, referencedGoalEvidence } from './milestones';
import { decisionCycle, type recentActions } from './context';
import { InferenceAuditError } from './audit';
import { compactPlanDraft } from './plan-compaction';
import { isDeepStrictEqual } from 'node:util';
import { taskAssessmentProblem, taskAssessmentProperties } from './task-assessment';
import { completionAttempt, FORMAT_REPAIR, jsonTextDraft } from './response-repair';
import { activeProject, projectOutcomeSchema, projectTransition, projectTransitionProblem } from './projects';
import { previousPlanContext, suggestionBasis } from './plan-context';

interface PlanTextLimits { text:number;progress:number }
const COMPACT_LIMITS:PlanTextLimits={text:500,progress:1200};
const EXPANDED_LIMITS:PlanTextLimits={text:1000,progress:2400};
const text=(value:unknown,maximum:number):value is string=>typeof value==='string'&&value.trim().length>0&&value.length<=maximum;
const sentenceSchema=(maximum:number):JsonSchemaNode=>({type:'string',minLength:1,maxLength:maximum});
const shortList=(value:unknown,maximum:number,minimum=0,textMaximum=COMPACT_LIMITS.text):value is string[]=>Array.isArray(value)&&value.length>=minimum&&value.length<=maximum&&value.every(item=>text(item,textMaximum));
const projectSchema=(limits:PlanTextLimits):JsonSchemaNode=>{const sentence=sentenceSchema(limits.text);return{type:'object',properties:{goal:{...sentence,description:`Your sustained project, 1..${limits.text} characters. Preserve it across tasks while it still matters.`},successCondition:{...sentence,description:`What you would observe if this project succeeded, 1..${limits.text} characters.`},progress:{type:'string',minLength:1,maxLength:limits.progress,description:`What has actually happened, what remains, and why. Up to ${limits.progress} characters. Separate hypotheses from observed facts.`},openQuestions:{type:'array',items:sentence,description:`Up to four untested questions or assumptions, each at most ${limits.text} characters.`}},required:['goal','successCondition','progress','openQuestions'],additionalProperties:false};};
const validProject=(value:any,limits=COMPACT_LIMITS):value is NonNullable<AgentPlan['project']>=>value&&text(value.goal,limits.text)&&text(value.successCondition,limits.text)&&text(value.progress,limits.progress)&&shortList(value.openQuestions,4,0,limits.text);
const approachSchema=(limits:PlanTextLimits):JsonSchemaNode=>({type:'array',items:sentenceSchema(limits.text),description:`One to three conditional next actions, at most ${limits.text} characters each. They expire after movement, changed hands/following, failure, or eight decisions. Use current target IDs and explicit prerequisites. Keep reusable methods in project progress; retain useful landmark coordinates there, but never current inventory, position or bearings. Mention journal only for a specific insight or correction.`});
function planningSchema(reviewing:boolean,strategic:boolean,free:boolean,outcomes:string[],limits:PlanTextLimits,reuse=false,reuseProject=reuse):JsonSchemaNode {
  const sentence=sentenceSchema(limits.text),project=projectSchema(limits),approach=approachSchema(limits),identity={...sentence,description:`Your stable first-person understanding of who you are: temperament, values, interests, or commitments that distinguish you from another creature. Do not summarize the current task or project. Preserve it across tasks and revise it only when experience changes your self-understanding. 1..${limits.text} characters.`};
  if(reuseProject)project.required=[];
  return reviewing?{
    type:'object',properties:{outcome:{type:'string',enum:outcomes,description:'Outcome of this immediate task only. Complete a satisfied task even while its parent project continues.'},explanation:{...sentence,description:'Explain how the cited results satisfy the task condition, or why work remains.'},...(strategic?{identity,direction:sentence,project,projectOutcome:projectOutcomeSchema,suggestedActions:approach}:{}),...taskAssessmentProperties,...(free?{evidenceEventIds:{type:'array' as const,items:{type:'integer' as const},description:'For complete, cite recorded event IDs from availableEvidence that support your assessment.'}}:{})},required:['outcome','explanation',...(free?['conditionMet','remaining']:[])],additionalProperties:false,
  }:{
    type:'object',properties:{identity,direction:{...sentence,description:`Your longer-term interest or purpose, chosen by you. 1..${limits.text} characters.`},project,projectOutcome:projectOutcomeSchema,goal:{...sentence,description:`One immediate task that advances your project, 1..${limits.text} characters. Do not combine unrelated activities.`},successCondition:{...sentence,description:`One bounded observable result for this task. Avoid combining independent alternatives or milestones; an unexpected observed result can still complete a learning task.`},suggestedActions:approach,explanation:{...sentence,description:`Why this task now, or why the project changed. 1..${limits.text} characters.`}},required:[...(!reuse?['identity','direction']:[]),...(!reuseProject?['project']:[]),'goal','successCondition','suggestedActions','explanation'],additionalProperties:false,
  };
}
function argumentProblems(parameters:JsonSchemaNode,args:any,strategic:boolean,reviewing:boolean,limits=COMPACT_LIMITS,previous?:AgentPlan) {
  const problems=validateJsonSchemaValue(parameters,args);
  if(problems.length)return problems;
  const check=(path:string,value:unknown,maximum=limits.text)=>{if(!text(value,maximum))problems.push(`${path} must contain 1..${maximum} characters; received ${typeof value==='string'?value.length:typeof value}.`);};
  check('explanation',args.explanation);
  if(!reviewing){check('identity',args.identity??previous?.identity);check('direction',args.direction??previous?.direction);check('goal',args.goal);check('successCondition',args.successCondition);}
  if(strategic||!reviewing){
    if(reviewing)check('identity',args.identity??previous?.identity);
    if(args.direction!==undefined)check('direction',args.direction);
    const project={...previous?.project,...args.project};
    check('project.goal',project.goal);check('project.successCondition',project.successCondition);check('project.progress',project.progress,limits.progress);
    if(!shortList(project.openQuestions,4,0,limits.text))problems.push(`project.openQuestions must be an array of zero to four strings, each 1..${limits.text} characters.`);
    if(!shortList(args.suggestedActions??(reviewing?previous?.suggestedActions:undefined),3,1,limits.text))problems.push(`suggestedActions must be a flat array of one to three strings, each 1..${limits.text} characters.`);
  }
  return problems;
}
// Call only after schema validation: explicit null is invalid, not an omitted update.
function effectivePlanArguments(args:Record<string,any>,previous?:AgentPlan) {
  if(!previous)return args;
  return {...args,identity:args.identity===undefined?previous.identity:args.identity,direction:args.direction===undefined?previous.direction:args.direction,
    project:{...previous.project,...args.project},suggestedActions:args.suggestedActions===undefined?previous.suggestedActions:args.suggestedActions};
}

export function needsPlanReview(plan:AgentPlan|undefined,turn:number,actions:ReturnType<typeof recentActions>=[]) {
  return !plan||![2,3,4].includes(plan.version??0)||plan.steps.length!==1||((plan.version??0)<3&&!plan.steps[0].criterion)||(plan.version===4&&(!text(plan.identity,COMPACT_LIMITS.text)||!validProject(plan.project)||!shortList(plan.suggestedActions,3,1)))||plan.status!=='active'||!plan.steps.some(step=>step.status==='pending')||turn-plan.reviewedTurn>=PLAN_REVIEW_INTERVAL
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
  signal:AbortSignal;retryDelayMs?:number;reasoning?:ReasoningProfile;compactionReasoning?:ReasoningProfile;
  complete(request:CompletionRequest,signal:AbortSignal):Promise<CompletionResult>;
  compact?(request:CompletionRequest,signal:AbortSignal):Promise<CompletionResult>;
  waiting(message:string):void;save(plan:AgentPlan):void;
}):Promise<AgentPlan> {
  let previous=options.plan,correction='',previousAttempt:unknown,formatDraft:Record<string,unknown>|undefined;
  while(true){
    options.signal.throwIfAborted();
    const reviewing=!options.upgrade&&previous?.status==='active'&&previous.steps.some(step=>step.status==='pending');
    const free=(previous?.version??0)>=3;
    const strategic=previous?.version===4;
    const legacy=reviewing&&(![2,3,4].includes(previous!.version??0)||previous!.steps.length!==1||(!free&&!previous!.steps[0].criterion)||previous!.startedAtSecond===undefined);
    const evidence=reviewing&&!legacy?milestoneEvidence(previous!,options.actions,options.observation):[];
    const availableEvidence=reviewing?evidenceContext(goalEvidence(previous!,options.actions)):[];
    const projectActions=options.actions.filter(entry=>entry.result.collected||entry.result.placed||entry.result.shaped||entry.result.inventoryDelta?.length).slice(-24);
    const projectEvidence=evidenceContext(goalEvidence({...previous,startedAtSecond:-1} as AgentPlan,[...new Map([...projectActions,...options.actions.slice(-8)].map(entry=>[entry.eventId,entry])).values()].sort((a,b)=>a.eventId-b.eventId)));
    const name=reviewing?'review_plan':'set_plan';
    const outcomes=legacy?['abandon']:free?['continue',...(availableEvidence.length?['complete']:[]),'blocked','abandon']:evidence.length?['complete','abandon']:(previous?.stalledReviews??0)>=1?['abandon']:['continue','abandon'];
    const reuse=previous?.version===4&&text(previous.identity,500)&&text(previous.direction,500)&&validProject(previous.project);
    const inherited=reuse?previous:undefined;
    const parameters=planningSchema(reviewing,strategic,free,outcomes,COMPACT_LIMITS,reuse,reuse&&activeProject(previous));
    const acceptedParameters=planningSchema(reviewing,strategic,free,outcomes,EXPANDED_LIMITS,reuse,reuse&&activeProject(previous));
    const compactParameters=parameters;
    const instruction=reviewing
      ? !free?'Review verifiedProgress against the task condition. Choose an allowed outcome; older incompatible tasks must be abandoned. Explain the recorded progress.':'Assess the immediate task only. Explain how recorded results match its condition and what remains. When conditionMet is true, complete the task even if its project continues. Cite availableEvidence for complete. You may continue, block or abandon an unfinished task; a reminder does not force a change.'
      : 'Choose one immediate task and one bounded observable success condition, with one to three conditional suggestions. You author the task and project; no activity is assigned. A learning task can end with an unexpected observed result. A blocked task does not erase its project.';
    const following=(options.context as {decisionState?:{following:boolean}})?.decisionState?.following;
    const historicalPlan=previous?previousPlanContext(previous,options.observation,options.turn,following):undefined;
    let saving=false;
    try{
      const answer=await options.complete({messages:[
        {role:'system',content:`${options.planningInstructions?.replaceAll('{name}',options.name)??`You are ${options.name}, planning your life in a physical world.`} ${instruction} ${reuse?'Omit unchanged identity, direction and project fields; omitted fields retain their values. Project updates merge field by field. Review suggestions can be omitted; a new task needs its own suggestions.':'Write your stable identity, longer-term direction and sustained project.'} Current state and recorded results override old plans and notes. Distinguish facts from hypotheses; speech is another creature's belief. Compare exact experiment inputs; a currently unavailable capability may become possible when its stated condition changes. Check conditional capabilities before declaring a test impossible. Paths describe individual directions, not a global blockage. Keep project progress durable; omit transient inventory and bearings. Suggest journal only for a specific insight or correction, using replaceNoteIds for obsolete claims. Write concise text fields of at most 500 characters; project.progress allows 1200. Keep the complete visible tool response within 2200 output tokens. Call only ${name}, using JSON objects and arrays, with no extra prose. Planning consumes no world time.`},
        {role:'user',content:JSON.stringify({...(reviewing?{successCondition:previous!.steps.find(step=>step.status==='pending')?.task,...(free?{availableEvidence,assessment:'Judge progress against the task success condition; cite actual observed effects. Completing a task does not automatically complete the project.'}:{verifiedProgress:{complete:!!evidence.length,evidence,legacy}}),allowedOutcomes:outcomes,previousPlan:historicalPlan,elapsedDecisions:options.turn-previous!.createdTurn}:{...(previous?{previousPlan:historicalPlan}:{})}),...(options.upgrade?{transition:'Reframe your existing activity as a project and one immediate task. Keep useful progress and commitments, but question unsupported assumptions.'}:{}),...(options.reviewReason?{reviewReason:options.reviewReason}:{}),situation:options.context,...(correction?{correction,previousAttempt}:{})})},
        {role:'user',content:JSON.stringify({projectLifecycle:'Assess whether your existing project still matters. Use projectOutcome to complete, suspend or abandon it before replacing its goal or success condition. Closing a task alone keeps its project. A closed project needs a new, fully specified project before another task. Keep the choice and success assessment your own.',projectEvidence})},
      ],tools:[{type:'function',function:{name,description:reviewing?'Review your task, update project progress and adjust the suggested method using observed results.':'Write your own direction, project, immediate task and suggested actions.',parameters}}],max_tokens:4400,reasoning:options.reasoning??DEFAULT_REASONING_SETTINGS.planning},options.signal);
      options.signal.throwIfAborted();
      let args:any;
      if(answer.calls.length===1&&answer.calls[0].function.name===name){try{args=JSON.parse(answer.calls[0].function.arguments);}catch{}}
      const authoredSuggestions=!!args&&Object.hasOwn(args,'suggestedActions');
      let problems=args?argumentProblems(acceptedParameters,args,strategic,reviewing,EXPANDED_LIMITS,inherited):[`Call ${name} exactly once with valid JSON arguments.`];
      if(args&&!problems.length){const problem=projectTransitionProblem(previous,args,reviewing,projectEvidence.map(entry=>entry.eventId));if(problem)problems.push(problem);}
      if(formatDraft&&args&&!problems.length&&!isDeepStrictEqual(effectivePlanArguments(args,inherited),effectivePlanArguments(formatDraft,inherited)))problems.push('Format repair must preserve the effective values of previousAttempt; unchanged inherited fields may be omitted or repeated.');
      if(reviewing&&free&&args){const problem=taskAssessmentProblem(args.outcome,args);if(problem)problems.push(problem);}
      // A compactor may shorten a decision, but cannot repair its missing or invalid citations.
      if(reviewing&&free&&args?.outcome==='complete'&&!referencedGoalEvidence(previous!,options.actions,args.evidenceEventIds)){
        problems.push(`For outcome "complete", evidenceEventIds must contain 1..10 integer IDs from availableEvidence; received ${JSON.stringify(args.evidenceEventIds)??'no evidenceEventIds field'}. References in explanation do not populate evidenceEventIds.`);
      }
      if(args&&!problems.length){
        const compactProblems=argumentProblems(compactParameters,args,strategic,reviewing,COMPACT_LIMITS,inherited);
        if(compactProblems.length){
          options.waiting('Compacting an expanded planning draft; world time is held.');
          args=await compactPlanDraft({name:options.name,mode:name,draft:args,parameters:compactParameters,signal:options.signal,retryDelayMs:options.retryDelayMs,
            validate:value=>argumentProblems(compactParameters,value,strategic,reviewing,COMPACT_LIMITS,inherited),complete:options.compact??options.complete,waiting:options.waiting,reasoning:options.compactionReasoning});
          problems=argumentProblems(compactParameters,args,strategic,reviewing,COMPACT_LIMITS,inherited);
        }
      }
      if(args&&!problems.length){
        const projectState=strategic||!reviewing?projectTransition(previous,args,reviewing):undefined;
        args={...effectivePlanArguments(args,inherited),...projectState};
      }
      let next:AgentPlan|undefined;
      if(args&&!problems.length){
        if(!reviewing){
          if(text(args.identity,500)&&text(args.direction,500)&&validProject(args.project)&&shortList(args.suggestedActions,3,1)&&text(args.goal,500)&&text(args.successCondition,500))next={version:4,identity:args.identity.trim(),direction:args.direction.trim(),project:args.project,suggestedActions:args.suggestedActions,goal:args.goal.trim(),status:'active',steps:[{task:args.successCondition.trim(),status:'pending'}],explanation:args.explanation.trim(),createdTurn:options.turn,reviewedTurn:options.turn,startedAtSecond:options.time,stalledReviews:0,inventoryBaseline:inventoryAmounts(options.observation?.self.inventory??null),reviewedEventId:options.actions.at(-1)?.eventId??0};
        }else if(reviewing&&outcomes.includes(args.outcome)){
          const status=args.outcome==='continue'?'active':args.outcome==='complete'?'completed':args.outcome==='blocked'?'blocked':'abandoned';
          const references=free?referencedGoalEvidence(previous!,options.actions,args.evidenceEventIds):evidence;
          if((!strategic||(text(args.identity,500)&&validProject(args.project)&&shortList(args.suggestedActions,3,1)))&&(status!=='completed'||references?.length))next={...previous!,...(strategic?{identity:args.identity.trim(),direction:args.direction??previous!.direction,project:args.project,suggestedActions:args.suggestedActions}:{}),...(status==='active'?{}:{intention:undefined}),status,...(free?{taskAssessment:{conditionMet:args.conditionMet,remaining:args.remaining.trim()}}:{}),reviewedTurn:options.turn,reviewedEventId:options.actions.at(-1)?.eventId??0,explanation:args.explanation.trim(),stalledReviews:status==='active'?(previous!.stalledReviews??0)+1:0,
            steps:previous!.steps.map(step=>step.status!=='pending'?step:status==='active'?step:{...step,status,evidence:free?args.explanation.trim():status==='completed'?references!.map(item=>item.message).join(' ').slice(0,500):args.explanation.trim(),...(status==='completed'?{evidenceEventIds:references!.map(item=>item.eventId),...(free?{assessment:'agent' as const}:{})}:{})})};
        }
      }
      if(next){
        if(options.observation&&(!reviewing||authoredSuggestions))next.suggestionBasis=suggestionBasis(options.observation,options.turn,following);
        if(args.projectHistory)next.projectHistory=args.projectHistory;
        if(next.intention===undefined)delete next.intention;
        saving=true;options.save(next);saving=false;
        if(next.status==='active')return next;
        previous=next;correction='';previousAttempt=undefined;formatDraft=undefined;continue;
      }
      if(!answer.calls.length){
        const draft=jsonTextDraft(answer);
        // Freeze only a valid decision. Invalid drafts still need semantic correction.
        if(!formatDraft&&draft&&!argumentProblems(acceptedParameters,draft,strategic,reviewing,EXPANDED_LIMITS,inherited).length
          &&!projectTransitionProblem(previous,draft,reviewing,projectEvidence.map(entry=>entry.eventId))
          &&(!reviewing||!free||(!taskAssessmentProblem(String(draft.outcome),draft)&&
            (draft.outcome!=='complete'||!!referencedGoalEvidence(previous!,options.actions,draft.evidenceEventIds)))))formatDraft=draft;
      }
      correction=!answer.calls.length?FORMAT_REPAIR:`Correct only these errors: ${problems.join(' ')} Invented evidence cannot complete a task. Preserve unaffected fields; do not rewrite the decision.`;
      if(formatDraft)correction+=' Preserve the effective values from previousAttempt; unchanged inherited fields may be omitted or repeated.';
      previousAttempt=formatDraft??completionAttempt(answer);
      options.waiting('Waiting for a valid goal or review; world time is held.');
    }catch(error){
      if(saving||error instanceof InferenceAuditError)throw error;
      options.signal.throwIfAborted();options.waiting(error instanceof Error?error.message:'Waiting for planning inference.');
    }
    await delay(options.retryDelayMs??1000,undefined,{signal:options.signal});
  }
}
