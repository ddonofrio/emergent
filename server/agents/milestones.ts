import { distance, type MilestoneCriterion, type Observation, type AgentPlan } from '../../src/core/types';
import type { recentActions } from './context';

export interface MilestoneOption { id:string; task:string; criterion:MilestoneCriterion; }
export function milestoneOptions(observation:Observation):MilestoneOption[] {
  const options:MilestoneOption[]=[
    {id:'scan',task:'Inspect the surroundings with one scan.',criterion:{kind:'scan'}},
    {id:'move',task:'Reach a different spot at least two metres away in one movement.',criterion:{kind:'move'}},
  ];
  const visible=[...new Set([...observation.surfaces.map(surface=>surface.kind),...observation.items.map(item=>item.kind)])];
  for(const subject of visible){
    options.push({id:`collect_${subject}`,task:`Collect one ${subject} from the world.`,criterion:{kind:'collect',subject}});
    if(observation.surfaces.some(surface=>surface.kind===subject)){
      options.push({id:`locate_${subject}`,task:`Locate one ${subject} block with a scan.`,criterion:{kind:'locate',subject}});
      options.push({id:`strike_${subject}`,task:`Strike one ${subject} block and observe its response.`,criterion:{kind:'strike',subject}});
    }
  }
  for(const stack of observation.self.inventory?.stacks??[]){
    if(!stack.contents)options.push({id:`place_${stack.kind}`,task:`Place one ${stack.kind} from inventory.`,criterion:{kind:'place',subject:stack.kind}});
    if(stack.kind==='wood')options.push({id:'shape_wood',task:'Change the shape of one held wood block.',criterion:{kind:'shape',subject:'wood'}});
  }
  if(observation.interactions.speak.length)options.push({id:'communicate',task:'Say one idea to a nearby listener.',criterion:{kind:'communicate'}});
  return options;
}

// Completion is derived from recorded effects, never the model's explanation.
export function milestoneEvidence(plan:AgentPlan,actions:ReturnType<typeof recentActions>) {
  const criterion=plan.steps.find(step=>step.status==='pending')?.criterion;
  const started=plan.startedAtSecond;
  if(!criterion||started===undefined)return [];
  return actions.filter(entry=>{
    if(entry.atSecond<=started)return false;
    const result=entry.result,subject=criterion.subject;
    if(criterion.kind==='move')return ['walk','run','jump'].includes(entry.action)&&!!result.from&&!!result.to&&distance(result.from,result.to)>=2-.01;
    if(!result.ok||result.outcome!=='completed')return false;
    switch(criterion.kind){
      case 'scan':return ['find_material','find_entity'].includes(entry.action);
      case 'locate':return entry.action==='find_material'&&result.materials?.some((item:{material:string})=>item.material===subject);
      case 'collect':return ['hit','dig','pickup'].includes(entry.action)&&!!result.collected&&(result.collected===subject||result.material===subject);
      case 'place':return entry.action==='place'&&result.placed===subject;
      case 'strike':return ['hit','dig'].includes(entry.action)&&result.material===subject&&!!result.blockOutcome;
      case 'communicate':return entry.action==='say'&&!!result.heardBy?.length;
      case 'shape':return entry.action==='strike_held'&&!!result.shaped;
    }
  }).map(entry=>({eventId:entry.eventId,message:entry.result.message}));
}
