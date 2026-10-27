import type { Engine } from '../../src/core/engine';
import { knowledgeDescription } from '../../src/core/knowledge';
import type { Action, ActionResult, Observation, WorldEvent } from '../../src/core/types';
import { impactPointName } from '../../src/core/impact-points';
import { INVENTORY_STACKS, STACK_SIZE } from '../../src/core/inventory';

// These projections are only for inference. Recorded world state retains full precision.
export function rounded<T>(value:T):T {
  return JSON.parse(JSON.stringify(value,(_key,item)=>typeof item==='number'?Math.round(item*100)/100:item));
}
export function compactView(view:Pick<Observation,'description'|'navigation'|'interactions'>&{self?:Observation['self'];viewAngle?:number;bodyYaw?:number}) {
  const inventory=view.self?.inventory,held=inventory&&inventory.selected!==null?inventory.stacks[inventory.selected]:undefined;
  const blockAction=held?.kind==='shovel'?'dig':'hit';
  const cracked=view.interactions.hit.find(block=>block.cracks>0);
  const attention=cracked?blockAction==='dig'?`The cracked ${cracked.kind} at [${cracked.target.join(',')}] is within reach of your shovel. Use dig to remove it.`:`The ${cracked.kind} block at [${cracked.target.join(',')}] ${cracked.cracks>=2?'has deep cracks and looks close to breaking':'has visible cracks; its surface is changing'}. Try hit on that same block again to see what happens.`:undefined;
  return rounded({...(attention?{attention}:{}),perception:view.description,...(view.viewAngle===undefined?{}:{viewAngle:view.viewAngle}),
    paths:view.navigation.paths.map(path=>({angle:path.turn,clearMetres:path.clearance,...(path.issue?{obstacle:path.issue.message}:{}),...(path.approach?{walk:path.approach}:{}),...(path.jump?{jump:path.jump}:{})})),
    interactions:Object.fromEntries(Object.entries(view.interactions).filter(([,targets])=>targets.length).map(([name,targets])=>[name==='hit'?blockAction:name,targets])),
  });
}
export function inventoryContext(observation:Observation) {
  const inventory=observation.self.inventory;
  return {stackSlots:INVENTORY_STACKS,freeStackSlots:INVENTORY_STACKS-(inventory?.stacks.length??0),maxPerStack:STACK_SIZE,hand:inventory?.selected??null,...(inventory?.stacks.length?{stacks:inventory.stacks.map((stack,index)=>({index,...stack}))}:{})};
}
export function relevantKnowledge(engine:Engine,observation:Observation) {
  return [...(engine.discoveries.get(observation.self.id)??[])].filter(fact=>engine.module.relevantKnowledge?.(observation,fact)??true).map(knowledgeDescription);
}
export function recentActions(events:WorldEvent[]) {
  const recent:{action:string;args:Record<string,unknown>;result:{ok:boolean;message:string}}[]=[];
  let moving:typeof recent[number]|undefined;
  for(const event of events){
    if(['arrived','blocked','collision','follow-ended','follow-blocked'].includes(event.type)){
      if(moving){moving.result={ok:event.type==='arrived',message:event.message};moving=undefined;}
      continue;
    }
    if(event.type!=='action'&&event.type!=='rejected')continue;
    const data=event.data as {action?:Action;result?:ActionResult}|undefined;
    if(!data?.action)continue;
    const {action:name,...args}=data.action;
    const entry={action:name as string,args:args as Record<string,unknown>,result:{ok:data.result?.ok??(event.type==='action'),message:data.result?.message??event.message}};
    if(name==='strike_held'&&data.action.impact){
      const point=impactPointName(data.action.impact);
      if(point){delete entry.args.impact;entry.args.point=point;}
    }
    recent.push(entry);
    if(entry.result.ok)moving=['walk','run','jump','follow'].includes(name)?entry:undefined;
  }
  return rounded(recent.slice(-4));
}
