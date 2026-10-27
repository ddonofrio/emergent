import { setTimeout as delay } from 'node:timers/promises';
import type { AgentPlan } from '../../src/core/types';
import type { CompletionRequest, CompletionResult } from './providers';
import { PLAN_REVIEW_INTERVAL } from '../../src/core/memory';

const MAX_STEPS = 5;
const text = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;

export function needsPlanReview(plan: AgentPlan | undefined, turn: number) {
  return !plan || plan.status !== 'active' || !plan.steps.some(step=>step.status==='pending') || turn-plan.reviewedTurn>=PLAN_REVIEW_INTERVAL;
}

/** Planning has its own single-tool request; it never acts on the world. */
export async function planDecision(options: {
  name: string; turn: number; plan?: AgentPlan; context: unknown; signal: AbortSignal; retryDelayMs?: number;
  complete(request: CompletionRequest, signal: AbortSignal): Promise<CompletionResult>;
  waiting(message: string): void;
  save(plan: AgentPlan): void;
}): Promise<AgentPlan> {
  let previous=options.plan;
  let correction='';
  while(true){
    options.signal.throwIfAborted();
    const reviewing=previous?.status==='active'&&previous.steps.some(step=>step.status==='pending');
    const name=reviewing?'review_plan':'set_plan';
    const parameters=reviewing?{
      type:'object',properties:{
        outcome:{type:'string',enum:['continue','complete','abandon']},
        steps:{type:'array',minItems:previous!.steps.length,maxItems:previous!.steps.length,items:{type:'object',properties:{status:{type:'string',enum:['pending','completed','abandoned']},evidence:{type:'string'}},required:['status','evidence'],additionalProperties:false}},
        explanation:{type:'string'},
      },required:['outcome','steps','explanation'],additionalProperties:false,
    }:{
      type:'object',properties:{goal:{type:'string'},steps:{type:'array',minItems:1,maxItems:MAX_STEPS,items:{type:'string'}},explanation:{type:'string'}},required:['goal','steps','explanation'],additionalProperties:false,
    };
    const instruction=reviewing
      ? 'Review your own plan using the recorded actions and current situation. Return every step in its original order. Keep unfinished steps pending; close completed steps with concrete observed evidence. Never invent success. Already closed steps stay closed. Continue while progress is possible. Complete the goal only when all steps are completed. To abandon it, close every remaining step as abandoned and explain why. Explain briefly what you have been doing and what remains.'
      : 'Choose your own concrete goal from your curiosity and current situation. Nobody assigns it to you. Give 1 to 5 short, observable steps with an identifiable finish, and a brief explanation of why you chose it. Use locations when useful. Do not merely say keep exploring forever: decide what you want to find out or accomplish. A closed previous plan is context, not an instruction to repeat it.';
    let saving=false;
    try{
      const answer=await options.complete({messages:[
        {role:'system',content:`You are ${options.name}, planning your next activity in a physical world. ${instruction} Goal: at most 200 characters. Each step or evidence: at most 160 characters. Explanation: at most 300 characters. Call only ${name}; no physical action happens here.`},
        {role:'user',content:JSON.stringify({situation:options.context,...(previous?{previousPlan:previous}:{}),...(correction?{correction}:{})})},
      ],tools:[{type:'function',function:{name,description:reviewing?'Review progress and close finished or abandoned work.':'Set your own goal and finite steps before acting.',parameters}}],max_tokens:1400},options.signal);
      options.signal.throwIfAborted();
      let args:any;
      if(answer.calls.length===1&&answer.calls[0].function.name===name){try{args=JSON.parse(answer.calls[0].function.arguments);}catch{}}
      let next:AgentPlan|undefined;
      if(args&&text(args.explanation,300)){
        if(!reviewing&&text(args.goal,200)&&Array.isArray(args.steps)&&args.steps.length>=1&&args.steps.length<=MAX_STEPS&&args.steps.every((step:unknown)=>text(step,160))&&new Set(args.steps.map((step:string)=>step.trim())).size===args.steps.length){
          next={goal:args.goal.trim(),status:'active',steps:args.steps.map((task:string)=>({task:task.trim(),status:'pending'})),explanation:args.explanation.trim(),createdTurn:options.turn,reviewedTurn:options.turn};
        }else if(reviewing&&['continue','complete','abandon'].includes(args.outcome)&&Array.isArray(args.steps)&&args.steps.length===previous!.steps.length&&args.steps.every((step:any,index:number)=>
          step&&['pending','completed','abandoned'].includes(step.status)&&typeof step.evidence==='string'&&step.evidence.length<=160&&(step.status==='pending'||step.evidence.trim().length>0)&&
          (previous!.steps[index].status==='pending'||previous!.steps[index].status===step.status))){
          const pending=args.steps.some((step:any)=>step.status==='pending');
          const valid=args.outcome==='continue'?pending:args.outcome==='complete'?args.steps.every((step:any)=>step.status==='completed'):!pending&&args.steps.some((step:any)=>step.status==='abandoned');
          if(valid)next={...previous!,status:args.outcome==='continue'?'active':args.outcome==='complete'?'completed':'abandoned',steps:args.steps.map((step:any,index:number)=>({task:previous!.steps[index].task,status:step.status,...(step.evidence.trim()?{evidence:step.evidence.trim()}:{})})),explanation:args.explanation.trim(),reviewedTurn:options.turn};
        }
      }
      if(next){
        saving=true;options.save(next);saving=false;
        if(next.status==='active')return next;
        previous=next;correction='';continue;
      }
      correction=reviewing?'Call review_plan with one status and evidence per original step. Continue needs unfinished steps; complete needs every step completed; abandon needs every step closed. Closed steps cannot reopen.':`Call set_plan with a nonempty goal, 1..${MAX_STEPS} distinct steps and a brief explanation.`;
      options.waiting('Waiting for a valid goal and steps; world time is held.');
    }catch(error){
      if(saving)throw error;
      options.signal.throwIfAborted();options.waiting(error instanceof Error?error.message:'Waiting for planning inference.');
    }
    await delay(options.retryDelayMs??1000,undefined,{signal:options.signal});
  }
}
