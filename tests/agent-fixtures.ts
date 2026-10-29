// Model-authored fixture content, only for deterministic transport and persistence tests.
export const projectFields={
  direction:'Understand the place where I live.',
  project:{goal:'Learn how the surroundings change.',successCondition:'I can describe an observed change.',progress:'I am starting to compare observations.',openQuestions:['What changes between observations?']},
  suggestedActions:['Inspect the current surroundings using an available tool.','If the result contains a relevant new finding, call journal before the next physical action.'],
};
export function projectReply(name:string,args:unknown) {
  const value=args as Record<string,unknown>;
  return name==='set_plan'&&value.goal&&value.successCondition?{...structuredClone(projectFields),...value}:value;
}
