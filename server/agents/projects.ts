import type { AgentPlan, AgentProject } from '../../src/core/types';
import type { JsonSchemaNode } from '../../vendor/deepseek-harness/json-schema';

export interface ProjectOutcome {
  status:'completed'|'suspended'|'abandoned';
  reason:string;
  evidenceEventIds?:number[];
}

export const projectOutcomeSchema:JsonSchemaNode={
  type:'object',properties:{
    status:{type:'string',enum:['completed','suspended','abandoned']},
    reason:{type:'string',minLength:1,maxLength:1000,description:'Your assessment of this project, in one concise sentence. Completion is your judgment, not an engine verdict.'},
    evidenceEventIds:{type:'array',items:{type:'integer'},description:'For completed, cite 1..10 IDs from projectEvidence spanning this project.'},
  },required:['status','reason'],additionalProperties:false,
  description:'Close the previous project independently of this task. Required before replacing its goal or success condition. Omit to keep the project active.',
};

export function activeProject(plan?:AgentPlan) { return !!plan?.project&&(!plan.project.status||plan.project.status==='active'); }

export function projectTransitionProblem(previous:AgentPlan|undefined,args:Record<string,any>,reviewing:boolean,evidenceIds:number[]) {
  const outcome=args.projectOutcome as ProjectOutcome|undefined;
  const changed=previous?.project&&['goal','successCondition'].some(key=>args.project?.[key]!==undefined&&args.project[key]!==previous.project![key as 'goal'|'successCondition']);
  if(outcome){
    if(!activeProject(previous))return 'There is no active previous project to close. Choose a new project instead.';
    if(!outcome.reason.trim())return 'Explain your project assessment in one concise sentence.';
    if(reviewing&&args.outcome==='continue')return 'Close or return the immediate task when closing its parent project; do not continue a task under a closed project.';
    if(reviewing&&changed)return 'Close the old project in this review; choose its replacement with the next set_plan.';
    if(outcome.status==='completed'&&(!Array.isArray(outcome.evidenceEventIds)||!outcome.evidenceEventIds.length||outcome.evidenceEventIds.length>10||outcome.evidenceEventIds.some(id=>!Number.isInteger(id)||!evidenceIds.includes(id))))return 'Project completion requires 1..10 recorded IDs from projectEvidence. Explain why those results meet your project condition.';
    if(!reviewing&&!changed)return 'After closing a project, supply a new project goal and success condition for your next task.';
  }
  if(changed&&activeProject(previous)&&!outcome)return 'Before replacing project.goal or project.successCondition, supply projectOutcome for the previous project. Progress and open questions can be updated without replacing the project.';
  if(!reviewing&&(!activeProject(previous)||outcome)&&previous?.project){
    if(!args.project||!['goal','successCondition','progress','openQuestions'].every(key=>Object.hasOwn(args.project,key)))return 'A new project needs its own goal, successCondition, progress and openQuestions; do not inherit fields from the closed project.';
  }
}

export function projectTransition(previous:AgentPlan|undefined,args:Record<string,any>,reviewing:boolean):{project:AgentProject;projectHistory?:AgentProject[]} {
  const outcome=args.projectOutcome as ProjectOutcome|undefined;
  const history=[...(previous?.projectHistory??[])];
  if(outcome&&previous?.project){
    const closed:AgentProject={...previous.project,...(reviewing?args.project:{}),status:outcome.status,assessment:outcome.reason.trim(),evidenceEventIds:outcome.status==='completed'?[...new Set(outcome.evidenceEventIds)]:[]};
    history.push(closed);
    if(reviewing)return {project:closed,projectHistory:history.slice(-8)};
  }
  const inherit=activeProject(previous)&&!outcome;
  const project={...(inherit?previous?.project:{}),...args.project};
  return {project,...(history.length?{projectHistory:history.slice(-8)}:{})};
}
