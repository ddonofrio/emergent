import { setTimeout as delay } from 'node:timers/promises';
import type { AgentPlan, Observation } from '../../src/core/types';
import { validateJsonSchemaValue, type JsonSchemaNode } from '../../vendor/deepseek-harness/json-schema';
import type { CompletionRequest, CompletionResult } from './providers';
import { PLAN_REVIEW_INTERVAL } from '../../src/core/memory';
import { inventoryAmounts, milestoneEvidence, type MilestoneOption } from './milestones';
import { decisionCycle, type recentActions } from './context';
import { InferenceAuditError } from './audit';

const text=(value:unknown,maximum:number):value is string=>typeof value==='string'&&value.trim().length>0&&value.length<=maximum;
export function needsPlanReview(plan:AgentPlan|undefined,turn:number,actions:ReturnType<typeof recentActions>=[]) {
  return !plan||plan.version!==2||plan.steps.length!==1||!plan.steps[0].criterion||plan.status!=='active'||!plan.steps.some(step=>step.status==='pending')||turn-plan.reviewedTurn>=PLAN_REVIEW_INTERVAL
    || !!decisionCycle(actions.filter(entry=>entry.atSecond>(plan.startedAtSecond??0)&&entry.eventId>(plan.reviewedEventId??0)));
}

/** One goal and one observable milestone. Review cadence counts decisions, never tool calls. */
export async function planDecision(options:{
  name:string;turn:number;time:number;plan?:AgentPlan;context:unknown;planningInstructions?:string;
  milestones:MilestoneOption[];actions:ReturnType<typeof recentActions>;observation?:Observation;
  signal:AbortSignal;retryDelayMs?:number;
  complete(request:CompletionRequest,signal:AbortSignal):Promise<CompletionResult>;
  waiting(message:string):void;save(plan:AgentPlan):void;
}):Promise<AgentPlan> {
  let previous=options.plan,correction='';
  while(true){
    options.signal.throwIfAborted();
    const reviewing=previous?.status==='active'&&previous.steps.some(step=>step.status==='pending');
    const legacy=reviewing&&(previous!.version!==2||previous!.steps.length!==1||!previous!.steps[0].criterion||previous!.startedAtSecond===undefined);
    const evidence=reviewing&&!legacy?milestoneEvidence(previous!,options.actions,options.observation):[];
    const name=reviewing?'review_plan':'set_plan';
    const outcomes=legacy?['abandon']:evidence.length?['complete','abandon']:(previous?.stalledReviews??0)>=1?['abandon']:['continue','abandon'];
    const parameters:JsonSchemaNode=reviewing?{
      type:'object',properties:{outcome:{type:'string',enum:outcomes},explanation:{type:'string'}},required:['outcome','explanation'],additionalProperties:false,
    }:{
      type:'object',properties:{milestone:{type:'string',enum:options.milestones.map(item=>item.id),description:'This selects the entire goal and its exact success condition.'},explanation:{type:'string',description:'Your motivation, not extra tasks for the executor.'}},required:['milestone','explanation'],additionalProperties:false,
    };
    const instruction=reviewing
      ? 'Review verifiedProgress and any repeated cycle. Only recorded effects prove success. Moving inventory between hands and storage does not collect anything. Choose an allowed outcome. Older plans use a different contract and must be abandoned before selecting a new goal. Explain what changed or prevented progress.'
      : 'Choose exactly one milestone from milestoneOptions as your entire goal. Explain your motivation briefly; it adds no tasks or success conditions. Use curiosity and observed facts. Past speech is a memory, not a fresh instruction or a current location. Consider recent unsuccessful cycles before repeating an activity.';
    let saving=false;
    try{
      const answer=await options.complete({messages:[
        {role:'system',content:`${options.planningInstructions?.replaceAll('{name}',options.name)??`You are ${options.name}, a curious agent planning your next activity in a physical world.`} ${instruction} Explanation: at most 300 characters. Call only ${name}. Planning consumes no world time. Reviews occur after ${PLAN_REVIEW_INTERVAL} decisions or a repeated cycle.`},
        {role:'user',content:JSON.stringify({...(reviewing?{requiredResult:previous!.steps.find(step=>step.status==='pending')?.task,verifiedProgress:{complete:!!evidence.length,evidence,legacy},allowedOutcomes:outcomes,previousPlan:previous}:{milestoneOptions:options.milestones.map(({id,task})=>({id,task})),...(previous?{previousPlan:previous}:{})}),situation:options.context,...(correction?{correction}:{})})},
      ],tools:[{type:'function',function:{name,description:reviewing?'Review one milestone using recorded evidence.':'Choose one finite, observable milestone.',parameters}}],max_tokens:700,reasoning:'maximum'},options.signal);
      options.signal.throwIfAborted();
      let args:any;
      if(answer.calls.length===1&&answer.calls[0].function.name===name){try{args=JSON.parse(answer.calls[0].function.arguments);}catch{}}
      let next:AgentPlan|undefined;
      if(args&&!validateJsonSchemaValue(parameters,args).length&&text(args.explanation,300)){
        if(!reviewing){
          const milestone=options.milestones.find(item=>item.id===args.milestone);
          if(milestone)next={version:2,goal:milestone.task,status:'active',steps:[{task:milestone.task,criterion:milestone.criterion,status:'pending'}],explanation:args.explanation.trim(),createdTurn:options.turn,reviewedTurn:options.turn,startedAtSecond:options.time,stalledReviews:0,inventoryBaseline:inventoryAmounts(options.observation?.self.inventory??null),reviewedEventId:options.actions.at(-1)?.eventId??0};
        }else if(reviewing&&outcomes.includes(args.outcome)){
          const status=args.outcome==='continue'?'active':args.outcome==='complete'?'completed':'abandoned';
          next={...previous!,intention:undefined,status,reviewedTurn:options.turn,reviewedEventId:options.actions.at(-1)?.eventId??0,explanation:args.explanation.trim(),stalledReviews:status==='active'?(previous!.stalledReviews??0)+1:0,
            steps:previous!.steps.map(step=>step.status!=='pending'?step:status==='active'?step:{...step,status:status==='completed'?'completed':'abandoned',evidence:status==='completed'?evidence.map(item=>item.message).join(' ').slice(0,300):args.explanation.trim(),...(status==='completed'?{evidenceEventIds:evidence.map(item=>item.eventId)}:{})})};
        }
      }
      if(next){
        if(next.intention===undefined)delete next.intention;
        saving=true;options.save(next);saving=false;
        if(next.status==='active')return next;
        previous=next;correction='';continue;
      }
      correction=reviewing?`Choose only an allowed outcome: ${outcomes.join(', ')}. Invented evidence cannot complete a milestone.`:'Supply only a milestone ID from milestoneOptions and a brief explanation. The selected milestone defines the goal.';
      options.waiting('Waiting for a valid goal and milestone; world time is held.');
    }catch(error){
      if(saving||error instanceof InferenceAuditError)throw error;
      options.signal.throwIfAborted();options.waiting(error instanceof Error?error.message:'Waiting for planning inference.');
    }
    await delay(options.retryDelayMs??1000,undefined,{signal:options.signal});
  }
}
