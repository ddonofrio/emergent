import type { WorldTool } from './tools';

export interface PlanningCapabilityScenario {
  when?:string;
  tools:WorldTool[];
}

export interface ConditionalPlanningCapability {
  when:string;
  capability:string;
}

export interface PlanningLimitation {
  capability:string;
  blockedBy:string;
}

const itemLabels:Record<string,string>={
  door_half_up:'upper wooden door half',
  door_half_down:'lower wooden door half',
};

export function planningItemLabel(kind:string,contents?:string) {
  const item=itemLabels[kind]??kind.replaceAll('_',' ');
  return `${item}${contents?` containing ${contents.replaceAll('_',' ')}`:''}`;
}

export function describePlanningCapability(tool:WorldTool) {
  return tool.planning.expose===false?undefined:tool.planning.ability;
}

export function describePlanningCapabilities(tools:WorldTool[]) {
  return [...new Set(tools.map(describePlanningCapability).filter((value):value is string=>!!value))];
}

export function describePlanningLimitations(tools:WorldTool[]) {
  const seen=new Set<string>(),result:PlanningLimitation[]=[];
  for(const tool of tools){
    const capability=describePlanningCapability(tool);
    if(!capability||!tool.unavailable)continue;
    const blockedBy=tool.planning.requires??tool.unavailable;
    const key=`${capability}\n${blockedBy}`;
    if(seen.has(key))continue;
    seen.add(key);result.push({capability,blockedBy});
  }
  return result;
}

export function describeConditionalPlanningCapabilities(currentCapabilities:string[],scenarios:PlanningCapabilityScenario[]) {
  const current=new Set(currentCapabilities);
  const grouped=new Map<string,{capability:string;requires?:string;conditions:Set<string>;unconditional:boolean}>();
  for(const scenario of scenarios)for(const tool of scenario.tools){
    const capability=describePlanningCapability(tool);
    if(!capability||current.has(capability))continue;
    const key=`${capability}\n${tool.planning.requires??''}`;
    const entry=grouped.get(key)??{capability,requires:tool.planning.requires,conditions:new Set<string>(),unconditional:false};
    if(scenario.when)entry.conditions.add(scenario.when);else entry.unconditional=true;
    grouped.set(key,entry);
  }
  return [...grouped.values()].map(entry=>{
    const conditions=[...entry.conditions].sort((a,b)=>a.length-b.length).filter((condition,index,all)=>
      !all.slice(0,index).some(shorter=>condition===shorter||condition.startsWith(`${shorter} and `)),
    );
    const handCondition=entry.unconditional?undefined:conditions.length===1?conditions[0]:conditions.length?`(${conditions.join(' or ')})`:undefined;
    const when=[handCondition,entry.requires].filter(Boolean).join(' and ')||'its physical prerequisites are locally available';
    return {when,capability:entry.capability};
  });
}

export function planningHandCondition(holding:string,contents:string|undefined,following:boolean,currentHand:boolean) {
  const conditions:string[]=[];
  if(following)conditions.push('after stopping following');
  if(!currentHand)conditions.push(holding==='empty'?'with empty hands':`while holding ${planningItemLabel(holding,contents)}`);
  return conditions.join(' and ')||undefined;
}
