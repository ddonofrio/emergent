import { setTimeout as delay } from 'node:timers/promises';
import type { AgentPlan, Observation } from '../../src/core/types';
import { validateJsonSchemaValue, type JsonSchemaNode } from '../../vendor/deepseek-harness/json-schema';
import type { CompletionRequest, CompletionResult } from './providers';
import { PLAN_REVIEW_INTERVAL } from '../../src/core/memory';
import { inventoryAmounts, milestoneEvidence, goalEvidence, referencedGoalEvidence } from './milestones';
import { decisionCycle, type recentActions } from './context';
import { InferenceAuditError } from './audit';

const text=(value:unknown,maximum:number):value is string=>typeof value==='string'&&value.trim().length>0&&value.length<=maximum;
export function needsPlanReview(plan:AgentPlan|undefined,turn:number,actions:ReturnType<typeof recentActions>=[]) {
  return !plan||![2,3].includes(plan.version??0)||plan.steps.length!==1||(plan.version!==3&&!plan.steps[0].criterion)||plan.status!=='active'||!plan.steps.some(step=>step.status==='pending')||turn-plan.reviewedTurn>=PLAN_REVIEW_INTERVAL
    || !!decisionCycle(actions.filter(entry=>entry.atSecond>(plan.startedAtSecond??0)&&entry.eventId>(plan.reviewedEventId??0)));
}

/** The model authors its goal and success condition; recorded effects ground its reviews. */
export async function planDecision(options:{
  name:string;turn:number;time:number;plan?:AgentPlan;context:unknown;planningInstructions?:string;
  actions:ReturnType<typeof recentActions>;observation?:Observation;
  signal:AbortSignal;retryDelayMs?:number;
  complete(request:CompletionRequest,signal:AbortSignal):Promise<CompletionResult>;
  waiting(message:string):void;save(plan:AgentPlan):void;
}):Promise<AgentPlan> {
  let previous=options.plan,correction='';
  while(true){
    options.signal.throwIfAborted();
    const reviewing=previous?.status==='active'&&previous.steps.some(step=>step.status==='pending');
    const free=previous?.version===3;
    const legacy=reviewing&&(![2,3].includes(previous!.version??0)||previous!.steps.length!==1||(!free&&!previous!.steps[0].criterion)||previous!.startedAtSecond===undefined);
    const evidence=reviewing&&!legacy?milestoneEvidence(previous!,options.actions,options.observation):[];
    const availableEvidence=reviewing?goalEvidence(previous!,options.actions):[];
    const name=reviewing?'review_plan':'set_plan';
    const outcomes=legacy?['abandon']:free?['continue',...(availableEvidence.length?['complete']:[]),'abandon']:evidence.length?['complete','abandon']:(previous?.stalledReviews??0)>=1?['abandon']:['continue','abandon'];
    const parameters:JsonSchemaNode=reviewing?{
      type:'object',properties:{outcome:{type:'string',enum:outcomes},explanation:{type:'string'},...(free?{evidenceEventIds:{type:'array' as const,items:{type:'integer' as const},description:'For complete, cite recorded event IDs from availableEvidence that support your assessment.'}}:{})},required:['outcome','explanation'],additionalProperties:false,
    }:{
      type:'object',properties:{goal:{type:'string',description:'In your own words, what you want to achieve. 1..300 characters.'},successCondition:{type:'string',description:'What you would need to observe to consider your goal achieved. 1..300 characters.'},explanation:{type:'string',description:'Why you chose this goal. 1..300 characters.'}},required:['goal','successCondition','explanation'],additionalProperties:false,
    };
    const instruction=reviewing
      ? free?'Review your own success condition against current observations and availableEvidence. Explain progress or obstacles. For complete, cite relevant event IDs and explain how their actual results satisfy the condition; successful tool execution alone is not goal completion. Completion is your assessment, not a verified world fact. You may continue or abandon; a reminder or repeated cycle does not force a new goal.':'Review verifiedProgress and any repeated cycle. Only recorded effects prove success. Moving inventory between hands and storage does not collect anything. Choose an allowed outcome. Older incompatible plans must be abandoned before writing a new goal. Explain what changed or prevented progress.'
      : 'Write your own goal and its observable success condition. There is no assigned activity or goal catalog. Ground your choices in current observations, memories and interests; unknown outcomes remain hypotheses to investigate. Past speech is a memory, not a fresh instruction or a current location. Consider recent progress when deciding what you want to do.';
    let saving=false;
    try{
      const answer=await options.complete({messages:[
        {role:'system',content:`${options.planningInstructions?.replaceAll('{name}',options.name)??`You are ${options.name}, a curious agent planning your next activity in a physical world.`} ${instruction} Explanation: at most 300 characters. Call only ${name}. Planning consumes no world time. Reviews occur after ${PLAN_REVIEW_INTERVAL} decisions or a repeated cycle.`},
        {role:'user',content:JSON.stringify({...(reviewing?{successCondition:previous!.steps.find(step=>step.status==='pending')?.task,...(free?{availableEvidence,assessment:'Judge progress against your success condition.'}:{verifiedProgress:{complete:!!evidence.length,evidence,legacy}}),allowedOutcomes:outcomes,previousPlan:previous}:{...(previous?{previousPlan:previous}:{})}),situation:options.context,...(correction?{correction}:{})})},
      ],tools:[{type:'function',function:{name,description:reviewing?'Review your goal using observed results.':'Write your own goal, success condition and motivation.',parameters}}],max_tokens:700,reasoning:'maximum'},options.signal);
      options.signal.throwIfAborted();
      let args:any;
      if(answer.calls.length===1&&answer.calls[0].function.name===name){try{args=JSON.parse(answer.calls[0].function.arguments);}catch{}}
      let next:AgentPlan|undefined;
      if(args&&!validateJsonSchemaValue(parameters,args).length&&text(args.explanation,300)){
        if(!reviewing){
          if(text(args.goal,300)&&text(args.successCondition,300))next={version:3,goal:args.goal.trim(),status:'active',steps:[{task:args.successCondition.trim(),status:'pending'}],explanation:args.explanation.trim(),createdTurn:options.turn,reviewedTurn:options.turn,startedAtSecond:options.time,stalledReviews:0,inventoryBaseline:inventoryAmounts(options.observation?.self.inventory??null),reviewedEventId:options.actions.at(-1)?.eventId??0};
        }else if(reviewing&&outcomes.includes(args.outcome)){
          const status=args.outcome==='continue'?'active':args.outcome==='complete'?'completed':'abandoned';
          const references=free?referencedGoalEvidence(previous!,options.actions,args.evidenceEventIds):evidence;
          if(status!=='completed'||references?.length)next={...previous!,intention:undefined,status,reviewedTurn:options.turn,reviewedEventId:options.actions.at(-1)?.eventId??0,explanation:args.explanation.trim(),stalledReviews:status==='active'?(previous!.stalledReviews??0)+1:0,
            steps:previous!.steps.map(step=>step.status!=='pending'?step:status==='active'?step:{...step,status:status==='completed'?'completed':'abandoned',evidence:free?args.explanation.trim():status==='completed'?references!.map(item=>item.message).join(' ').slice(0,300):args.explanation.trim(),...(status==='completed'?{evidenceEventIds:references!.map(item=>item.eventId),...(free?{assessment:'agent' as const}:{})}:{})})};
        }
      }
      if(next){
        if(next.intention===undefined)delete next.intention;
        saving=true;options.save(next);saving=false;
        if(next.status==='active')return next;
        previous=next;correction='';continue;
      }
      correction=reviewing?`Choose only an allowed outcome: ${outcomes.join(', ')}. Invented evidence cannot complete a goal. For an agent-assessed completion, cite one or more IDs from availableEvidence.`:'Write goal, successCondition and explanation as nonempty strings of at most 300 characters each.';
      options.waiting('Waiting for a valid goal or review; world time is held.');
    }catch(error){
      if(saving||error instanceof InferenceAuditError)throw error;
      options.signal.throwIfAborted();options.waiting(error instanceof Error?error.message:'Waiting for planning inference.');
    }
    await delay(options.retryDelayMs??1000,undefined,{signal:options.signal});
  }
}
