import { setTimeout as delay } from 'node:timers/promises';
import type { AgentPlan } from '../../src/core/types';
import type { CompletionRequest, CompletionResult } from './providers';
import { PLAN_REVIEW_INTERVAL } from '../../src/core/memory';

const MAX_STEPS = 3;
const text = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
const tacticalLocation = (value: string) => /\[\s*-?\d|\b\d+(?:\.\d+)?\s*(?:m|metres?|meters?|degrees?)\b|\xB0/i.test(value);

export function unboundedMilestone(value:string) {
  return /\b(?:all|every|each)\b(?!\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\b)/i.test(value)
    || /\b(?:forever|indefinitely|as many as|keep (?:searching|exploring|collecting))\b/i.test(value)
    || /\b(?:until|when)\b.*\b(?:stops? (?:leading|moving)|reveals? (?:a |the )?destination)\b/i.test(value)
    || /\bdestination\s+(?:that\s+)?\w+\s+(?:indicates?|chooses?|reveals?)\b/i.test(value);
}
const unboundedPlan=(plan:AgentPlan)=>plan.steps.some(step=>step.status==='pending'&&unboundedMilestone(step.task));

export function needsPlanReview(plan: AgentPlan | undefined, turn: number) {
  return !plan || plan.status !== 'active' || !plan.steps.some(step=>step.status==='pending') || unboundedPlan(plan) || turn-plan.reviewedTurn>=PLAN_REVIEW_INTERVAL;
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
      ? 'Review your own goal against current surroundings and actionsSinceLastReview, in time order. Block targets identify the same cell across scans and actions; different targets are different blocks. Finding means seeing or locating, not breaking or collecting. Use observed targets to close finding milestones and successful action results to close interaction milestones. New successes belong to this review interval: do not credit them again to an already completed earlier step. Include the target and result in evidence when relevant. Return every milestone in order; close all consecutive milestones already proved done. Never reopen or rewrite closed work. Intentions and unrelated movement prove nothing. You may continue once without closing the current milestone if there is meaningful progress; if stalledReviews is 1, close it or abandon the remaining work. Complete only when all milestones are completed. Abandon remaining work if the plan has an unbounded finish or depends on another creature choosing a destination. Explain briefly the lesson and next milestone.'
      : `Choose your own abstract goal from curiosity: investigate, play, explore, build, or communicate. Define exactly ${MAX_STEPS} ordered high-level milestones with observable finishes. Keep the scope fixed: one chosen block or creature, or an explicit number. Finding a block is done once it is located; later steps can interact with that same block. Do not expand the goal whenever more objects appear. Never use "all discovered", "every nearby", endless exploration, or a finish dependent on another creature stopping or choosing a destination. Use only visible kinds, reported facts and plausible capabilities; never assume hidden effects. No coordinates, positions, IDs, angles, directions, distances, conditional milestones or detailed tool arguments in the goal or steps; object references belong only in review evidence. A closed previous plan is context, not an instruction to repeat it.`;
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
        if(!reviewing&&text(args.goal,200)&&!tacticalLocation(args.goal)&&Array.isArray(args.steps)&&args.steps.length===MAX_STEPS&&args.steps.every((step:unknown)=>text(step,160)&&!tacticalLocation(step)&&!unboundedMilestone(step))&&new Set(args.steps.map((step:string)=>step.trim())).size===args.steps.length){
          next={goal:args.goal.trim(),status:'active',steps:args.steps.map((task:string)=>({task:task.trim(),status:'pending'})),explanation:args.explanation.trim(),createdTurn:options.turn,reviewedTurn:options.turn,stalledReviews:0};
        }else if(reviewing&&['continue','complete','abandon'].includes(args.outcome)&&Array.isArray(args.steps)&&args.steps.length===previous!.steps.length&&args.steps.every((step:any,index:number)=>
          step&&['pending','completed','abandoned'].includes(step.status)&&typeof step.evidence==='string'&&step.evidence.length<=160&&(step.status==='pending'||step.evidence.trim().length>0)&&
          (previous!.steps[index].status==='pending'||previous!.steps[index].status===step.status))){
          const pending=args.steps.some((step:any)=>step.status==='pending');
          const current=previous!.steps.findIndex(step=>step.status==='pending');
          const currentClosed=current>=0&&args.steps[current].status!=='pending';
          const closedOutOfOrder=current>=0&&args.steps.some((step:any,index:number)=>index>current&&step.status!=='pending')&&!currentClosed;
          const mayContinue=currentClosed||(previous!.stalledReviews??0)<1;
          const valid=(!unboundedPlan(previous!)||args.outcome==='abandon')&&!closedOutOfOrder&&(args.outcome==='continue'?pending&&mayContinue:args.outcome==='complete'?args.steps.every((step:any)=>step.status==='completed'):!pending&&args.steps.some((step:any)=>step.status==='abandoned'));
          if(valid)next={...previous!,status:args.outcome==='continue'?'active':args.outcome==='complete'?'completed':'abandoned',steps:args.steps.map((step:any,index:number)=>previous!.steps[index].status!=='pending'?previous!.steps[index]:({task:previous!.steps[index].task,status:step.status,...(step.evidence.trim()?{evidence:step.evidence.trim()}:{})})),explanation:args.explanation.trim(),reviewedTurn:options.turn,stalledReviews:args.outcome==='continue'&&!currentClosed?(previous!.stalledReviews??0)+1:0};
        }
      }
      if(next){
        saving=true;options.save(next);saving=false;
        if(next.status==='active')return next;
        previous=next;correction='';continue;
      }
      correction=reviewing?'Call review_plan with one status and evidence per original milestone. Close milestones in order. Continue may leave the current milestone pending only once; when stalledReviews is 1, close it or abandon the remaining work. An unbounded plan must be abandoned. Complete needs every milestone completed. Closed milestones cannot reopen.':`Call set_plan with an abstract finite goal and exactly ${MAX_STEPS} distinct high-level milestones. Choose a fixed scope: one object, one encounter, or an explicit number. No all/every/each expanding collections or destination chosen by someone else. Remove coordinates, IDs, angles, distances and navigation details.`;
      options.waiting('Waiting for a valid goal and steps; world time is held.');
    }catch(error){
      if(saving)throw error;
      options.signal.throwIfAborted();options.waiting(error instanceof Error?error.message:'Waiting for planning inference.');
    }
    await delay(options.retryDelayMs??1000,undefined,{signal:options.signal});
  }
}
