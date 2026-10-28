import { setTimeout as delay } from 'node:timers/promises';
import type { AgentPlan } from '../../src/core/types';
import type { CompletionRequest, CompletionResult } from './providers';
import { PLAN_REVIEW_INTERVAL } from '../../src/core/memory';
import { milestoneEvidence, type MilestoneOption } from './milestones';
import type { recentActions } from './context';

const text=(value:unknown,maximum:number):value is string=>typeof value==='string'&&value.trim().length>0&&value.length<=maximum;
export function unboundedMilestone(value:string) {
  return /\b(?:all|every|each)\b(?!\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\b)/i.test(value)
    || /\b(?:forever|indefinitely|as many as|keep (?:searching|exploring|collecting))\b/i.test(value)
    || /\b(?:until|when)\b.*\b(?:stops? (?:leading|moving)|reveals? (?:a |the )?destination)\b/i.test(value)
    || /\bdestination\s+(?:that\s+)?\w+\s+(?:indicates?|chooses?|reveals?)\b/i.test(value);
}
export function needsPlanReview(plan:AgentPlan|undefined,turn:number) {
  return !plan||plan.status!=='active'||!plan.steps.some(step=>step.status==='pending')||turn-plan.reviewedTurn>=PLAN_REVIEW_INTERVAL;
}

/** One goal and one observable milestone. Review cadence counts decisions, never tool calls. */
export async function planDecision(options:{
  name:string;turn:number;time:number;plan?:AgentPlan;context:unknown;
  milestones:MilestoneOption[];actions:ReturnType<typeof recentActions>;
  signal:AbortSignal;retryDelayMs?:number;
  complete(request:CompletionRequest,signal:AbortSignal):Promise<CompletionResult>;
  waiting(message:string):void;save(plan:AgentPlan):void;
}):Promise<AgentPlan> {
  let previous=options.plan,correction='';
  while(true){
    options.signal.throwIfAborted();
    const reviewing=previous?.status==='active'&&previous.steps.some(step=>step.status==='pending');
    const legacy=reviewing&&(previous!.steps.length!==1||!previous!.steps[0].criterion||previous!.startedAtSecond===undefined);
    const evidence=reviewing&&!legacy?milestoneEvidence(previous!,options.actions):[];
    const name=reviewing?'review_plan':'set_plan';
    const outcomes=legacy?['abandon']:evidence.length?['complete','abandon']:(previous?.stalledReviews??0)>=1?['abandon']:['continue','abandon'];
    const parameters=reviewing?{
      type:'object',properties:{outcome:{type:'string',enum:outcomes},explanation:{type:'string'}},required:['outcome','explanation'],additionalProperties:false,
    }:{
      type:'object',properties:{goal:{type:'string',description:'Short intent. One activity, without coordinates or tool arguments.'},milestone:{type:'string',enum:options.milestones.map(item=>item.id),description:'Choose one observable finish from milestoneOptions.'},explanation:{type:'string'}},required:['goal','milestone','explanation'],additionalProperties:false,
    };
    const instruction=reviewing
      ? 'Review your current milestone using verifiedProgress. Only recorded effects prove completion. Finding is not collecting; holding is not placing. A blocked or abandoned prerequisite cannot be skipped to continue later construction. Choose an allowed outcome. Legacy plans without verifiable criteria must be abandoned and replaced. Explain briefly what changed or prevented progress.'
      : 'Choose your own short goal and exactly one milestone from milestoneOptions. The milestone is the entire current scope, not the start of an expanding list. Use curiosity and the current situation. Consider recent blockage before choosing movement or construction again. A previous goal is history, not an instruction to repeat it.';
    let saving=false;
    try{
      const answer=await options.complete({messages:[
        {role:'system',content:`You are ${options.name}, planning your next activity in a physical world. ${instruction} Goal: at most 200 characters. Explanation: at most 300 characters. Call only ${name}. Planning consumes no world time. Reviews are every ${PLAN_REVIEW_INTERVAL} decisions.`},
        {role:'user',content:JSON.stringify({situation:options.context,...(reviewing?{previousPlan:previous,verifiedProgress:{complete:!!evidence.length,evidence,legacy},allowedOutcomes:outcomes}:{milestoneOptions:options.milestones.map(({id,task})=>({id,task})),...(previous?{previousPlan:previous}:{})}),...(correction?{correction}:{})})},
      ],tools:[{type:'function',function:{name,description:reviewing?'Review one milestone using recorded evidence.':'Choose one finite, observable milestone.',parameters}}],max_tokens:700,reasoning:'maximum'},options.signal);
      options.signal.throwIfAborted();
      let args:any;
      if(answer.calls.length===1&&answer.calls[0].function.name===name){try{args=JSON.parse(answer.calls[0].function.arguments);}catch{}}
      let next:AgentPlan|undefined;
      if(args&&text(args.explanation,300)){
        if(!reviewing&&text(args.goal,200)&&!unboundedMilestone(args.goal)){
          const milestone=options.milestones.find(item=>item.id===args.milestone);
          if(milestone)next={goal:args.goal.trim(),status:'active',steps:[{task:milestone.task,criterion:milestone.criterion,status:'pending'}],explanation:args.explanation.trim(),createdTurn:options.turn,reviewedTurn:options.turn,startedAtSecond:options.time,stalledReviews:0};
        }else if(reviewing&&outcomes.includes(args.outcome)){
          const status=args.outcome==='continue'?'active':args.outcome==='complete'?'completed':'abandoned';
          next={...previous!,status,reviewedTurn:options.turn,explanation:args.explanation.trim(),stalledReviews:status==='active'?(previous!.stalledReviews??0)+1:0,
            steps:previous!.steps.map(step=>step.status!=='pending'?step:status==='active'?step:{...step,status:status==='completed'?'completed':'abandoned',evidence:status==='completed'?evidence.map(item=>item.message).join(' ').slice(0,300):args.explanation.trim(),...(status==='completed'?{evidenceEventIds:evidence.map(item=>item.eventId)}:{})})};
        }
      }
      if(next){
        saving=true;options.save(next);saving=false;
        if(next.status==='active')return next;
        previous=next;correction='';continue;
      }
      correction=reviewing?`Choose only an allowed outcome: ${outcomes.join(', ')}. Invented evidence cannot complete a milestone.`:'Choose one milestone ID from milestoneOptions and a short, finite goal.';
      options.waiting('Waiting for a valid goal and milestone; world time is held.');
    }catch(error){
      if(saving)throw error;
      options.signal.throwIfAborted();options.waiting(error instanceof Error?error.message:'Waiting for planning inference.');
    }
    await delay(options.retryDelayMs??1000,undefined,{signal:options.signal});
  }
}
