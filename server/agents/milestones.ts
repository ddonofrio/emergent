import { distance, type Observation, type AgentPlan, type Inventory } from '../../src/core/types';
import { historicalActions, type recentActions } from './context';

export function inventoryAmounts(inventory:Inventory|null) {
  const amounts:Record<string,number>={};
  for(const stack of inventory?.stacks??[]){
    const key=JSON.stringify([stack.kind,stack.contents??null]);
    amounts[key]=(amounts[key]??0)+stack.count;
  }
  return amounts;
}
// These are references to observed outcomes, not a judgment that a free-form goal succeeded.
export function goalEvidence(plan:AgentPlan,actions:ReturnType<typeof recentActions>) {
  return historicalActions(actions).filter(entry=>entry.atSecond>(plan.startedAtSecond??Infinity))
    .map(entry=>({eventId:entry.eventId,atSecond:entry.atSecond,action:entry.action,args:entry.args,message:entry.result.message,result:entry.result}));
}
export function taskEvidenceView(plan:AgentPlan,actions:ReturnType<typeof recentActions>) {
  const evidence=goalEvidence(plan,actions);
  const changes=evidence.filter(item=>item.result.collected||item.result.shaped||item.result.placed||item.result.heardBy?.length||item.result.inventoryDelta?.length).slice(-8);
  return [...new Map([...changes,...evidence.slice(-6)].map(item=>[item.eventId,item])).values()].sort((a,b)=>a.eventId-b.eventId);
}
export function referencedGoalEvidence(plan:AgentPlan,actions:ReturnType<typeof recentActions>,ids:unknown) {
  if(!Array.isArray(ids)||!ids.length||ids.length>10||ids.some(id=>!Number.isInteger(id)))return undefined;
  const available=goalEvidence(plan,actions),unique=[...new Set(ids)];
  if(unique.some(id=>!available.some(entry=>entry.eventId===id)))return undefined;
  return unique.map(id=>available.find(entry=>entry.eventId===id)!);
}

// Compatibility for saved version-2 plans only. New goals have no programmed criterion.
export function milestoneEvidence(plan:AgentPlan,actions:ReturnType<typeof recentActions>,observation?:Observation) {
  const criterion=plan.steps.find(step=>step.status==='pending')?.criterion;
  const started=plan.startedAtSecond;
  if(!criterion||started===undefined)return [];
  const matches=actions.filter(entry=>{
    if(entry.atSecond<=started)return false;
    const result=entry.result,subject=criterion.subject;
    if(criterion.kind==='approach'){
      const target=observation?.entities.find(entity=>entity.id===criterion.entityId);
      return !!target&&!!observation&&distance(observation.self.position,target.position)<=2
        && ['walk','run','jump','follow'].includes(entry.action)&&result.ok;
    }
    if(criterion.kind==='move')return ['walk','run','jump'].includes(entry.action)&&!!result.from&&!!result.to&&distance(result.from,result.to)>=2-.01;
    if(!result.ok||result.outcome!=='completed')return false;
    switch(criterion.kind){
      case 'scan':return ['find_material','find_entity'].includes(entry.action);
      case 'locate':return entry.action==='find_material'&&result.materials?.some((item:{material:string})=>item.material===subject);
      case 'collect':{
        if(!['hit','dig','pickup'].includes(entry.action)||!result.collected||!(result.collected===subject||result.material===subject))return false;
        // Version 2 collection means a net additional unit, including an observed transformation.
        // The product is taken from the recorded result, never predicted in a tool description.
        if(plan.version!==2)return true;
        if(!observation||!plan.inventoryBaseline)return false;
        const amounts=inventoryAmounts(observation.self.inventory);
        return (result.inventoryDelta??[]).some(change=>change.change>0&&change.kind===result.collected
          && (amounts[JSON.stringify([change.kind,change.contents??null])]??0)>(plan.inventoryBaseline![JSON.stringify([change.kind,change.contents??null])]??0));
      }
      case 'place':return entry.action==='place'&&result.placed===subject;
      case 'strike':return ['hit','dig'].includes(entry.action)&&result.material===subject&&!!result.blockOutcome;
      case 'communicate':return entry.action==='say'&&!!result.heardBy?.length;
      case 'shape':return entry.action==='strike_held'&&!!result.shaped;
    }
  });
  return (criterion.kind==='collect'?matches.slice(-1):matches).map(entry=>({eventId:entry.eventId,message:criterion.kind==='approach'
    ?`${entry.result.message} Current local sighting confirms the named creature is within two metres.`
    :entry.result.message}));
}
