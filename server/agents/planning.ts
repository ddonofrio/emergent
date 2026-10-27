import { setTimeout as delay } from 'node:timers/promises';
import type { AgentPlan } from '../../src/core/types';
import type { CompletionRequest, CompletionResult } from './providers';
import { PLAN_REVIEW_INTERVAL } from '../../src/core/memory';

const MAX_STEPS = 3;
const text = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
const tacticalLocation = (value: string) => /\[\s*-?\d|\b\d+(?:\.\d+)?\s*(?:m|metres?|meters?|degrees?)\b|\xB0/i.test(value);

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
      type:'object',properties:{goal:{type:'string',description:'Abstract intent such as investigate wood, play with a creature, explore the island edge, build, or communicate.'},steps:{type:'array',minItems:MAX_STEPS,maxItems:MAX_STEPS,items:{type:'string',description:'Ordered, high-level observable milestone without positions, coordinates, angles, distances, IDs, or navigation details.'}},explanation:{type:'string'}},required:['goal','steps','explanation'],additionalProperties:false,
    };
    const instruction=reviewing
      ? 'Review your own abstract goal using only explicit results in actionsSinceLastReview. Return every milestone in its original order. Work is sequential: do not close a later milestone while the earliest pending one remains open. Mark the current milestone completed only when a recorded result directly demonstrates its high-level finish; an intention, assumption, nearby object, or unrelated movement is not evidence. Already closed milestones stay closed. You may continue once without closing the current milestone when the results show meaningful progress; stalledReviews tells you whether that allowance was already used. If stalledReviews is 1 and the current milestone does not close now, abandon every remaining milestone and choose a better goal. Complete the goal only when every milestone is completed. If an older plan contains tactical positions or an unbounded finish, abandon it. Explain briefly what was learned and which milestone comes next.'
      : `Choose your own abstract goal from curiosity and the current situation, such as investigating, playing, exploring, building, or communicating. Nobody assigns it to you. Then define exactly ${MAX_STEPS} concrete high-level milestones that give the executor room to solve navigation and tool details from each live observation. Milestones may say find wood, strike a wood block, reach the island edge, or play with a creature. Never include coordinates, positions, entity IDs, angles, directions, distances, or detailed tool arguments. Use only visible kinds, reported facts and plausible capabilities; never assume hidden contents or effects. The goal must have a finite finish you can cause or verify, not depend on another creature eventually stopping or revealing an unknown destination. Do not use conditional milestones. A closed previous plan is context, not an instruction to repeat it.`;
    let saving=false;
    try{
      const answer=await options.complete({messages:[
        {role:'system',content:`You are ${options.name}, planning your next activity in a physical world. ${instruction} Goal: at most 200 characters. Each step or evidence: at most 160 characters. Explanation: at most 300 characters. Call only ${name}; no physical action happens here.`},
        {role:'user',content:JSON.stringify({situation:options.context,...(previous?{previousPlan:previous}:{}),...(correction?{correction}:{})})},
      ],tools:[{type:'function',function:{name,description:reviewing?'Review progress and close finished or abandoned work.':'Set your own goal and finite steps before acting.',parameters}}],max_tokens:1400,reasoning:'maximum'},options.signal);
      options.signal.throwIfAborted();
      let args:any;
      if(answer.calls.length===1&&answer.calls[0].function.name===name){try{args=JSON.parse(answer.calls[0].function.arguments);}catch{}}
      let next:AgentPlan|undefined;
      if(args&&text(args.explanation,300)){
        if(!reviewing&&text(args.goal,200)&&!tacticalLocation(args.goal)&&Array.isArray(args.steps)&&args.steps.length===MAX_STEPS&&args.steps.every((step:unknown)=>text(step,160)&&!tacticalLocation(step))&&new Set(args.steps.map((step:string)=>step.trim())).size===args.steps.length){
          next={goal:args.goal.trim(),status:'active',steps:args.steps.map((task:string)=>({task:task.trim(),status:'pending'})),explanation:args.explanation.trim(),createdTurn:options.turn,reviewedTurn:options.turn,stalledReviews:0};
        }else if(reviewing&&['continue','complete','abandon'].includes(args.outcome)&&Array.isArray(args.steps)&&args.steps.length===previous!.steps.length&&args.steps.every((step:any,index:number)=>
          step&&['pending','completed','abandoned'].includes(step.status)&&typeof step.evidence==='string'&&step.evidence.length<=160&&(step.status==='pending'||step.evidence.trim().length>0)&&
          (previous!.steps[index].status==='pending'||previous!.steps[index].status===step.status))){
          const pending=args.steps.some((step:any)=>step.status==='pending');
          const current=previous!.steps.findIndex(step=>step.status==='pending');
          const currentClosed=current>=0&&args.steps[current].status!=='pending';
          const closedOutOfOrder=current>=0&&args.steps.some((step:any,index:number)=>index>current&&step.status!=='pending')&&!currentClosed;
          const mayContinue=currentClosed||(previous!.stalledReviews??0)<1;
          const valid=!closedOutOfOrder&&(args.outcome==='continue'?pending&&mayContinue:args.outcome==='complete'?args.steps.every((step:any)=>step.status==='completed'):!pending&&args.steps.some((step:any)=>step.status==='abandoned'));
          if(valid)next={...previous!,status:args.outcome==='continue'?'active':args.outcome==='complete'?'completed':'abandoned',steps:args.steps.map((step:any,index:number)=>({task:previous!.steps[index].task,status:step.status,...(step.evidence.trim()?{evidence:step.evidence.trim()}:{})})),explanation:args.explanation.trim(),reviewedTurn:options.turn,stalledReviews:args.outcome==='continue'&&!currentClosed?(previous!.stalledReviews??0)+1:0};
        }
      }
      if(next){
        saving=true;options.save(next);saving=false;
        if(next.status==='active')return next;
        previous=next;correction='';continue;
      }
      correction=reviewing?'Call review_plan with one status and evidence per original milestone. Close milestones in order. Continue needs pending work and may leave the current milestone pending only once; when stalledReviews is 1, close it or abandon all remaining work. Complete needs every milestone completed. Closed milestones cannot reopen.':`Call set_plan with an abstract finite goal and exactly ${MAX_STEPS} distinct high-level milestones. Remove coordinates, positions, IDs, angles, directions, distances and navigation details.`;
      options.waiting('Waiting for a valid goal and steps; world time is held.');
    }catch(error){
      if(saving)throw error;
      options.signal.throwIfAborted();options.waiting(error instanceof Error?error.message:'Waiting for planning inference.');
    }
    await delay(options.retryDelayMs??1000,undefined,{signal:options.signal});
  }
}
