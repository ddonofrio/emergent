import type { TaskAssessment } from '../../src/core/types';
import type { JsonSchemaNode } from '../../vendor/deepseek-harness/json-schema';

export const taskAssessmentProperties:Record<string,JsonSchemaNode>={
  conditionMet:{type:'boolean',description:'Your assessment: have recorded results satisfied every part of this immediate task condition? Ignore whether the parent project is finished.'},
  remaining:{type:'string',maxLength:500,description:'What remains to satisfy this task, not the parent project; empty only when conditionMet is true.'},
};

// Check internal consistency, never decide whether a free-text goal succeeded.
export function taskAssessmentProblem(outcome:string,assessment:Partial<TaskAssessment>) {
  const {conditionMet,remaining}=assessment;
  if(typeof conditionMet!=='boolean'||typeof remaining!=='string'||remaining.length>500)return 'Supply conditionMet and remaining (at most 500 characters) for this task only.';
  if(conditionMet!==!remaining.trim())return 'Use an empty remaining only when every part of the task condition is met; otherwise describe what remains.';
  const completed=outcome==='complete'||outcome==='completed';
  if(completed!==conditionMet)return conditionMet?'The task condition is met: complete this task even if its project continues.':'Completion requires every part of the task condition; continue, block or abandon while work remains.';
}
