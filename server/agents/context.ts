import type { Engine } from '../../src/core/engine';
import { knowledgeDescription } from '../../src/core/knowledge';
import { distance, type Action, type ActionResult, type Observation, type Vec3, type WorldEvent } from '../../src/core/types';
import { impactPointName } from '../../src/core/impact-points';
import { INVENTORY_STACKS, STACK_SIZE } from '../../src/core/inventory';
import { RECENT_ACTION_LIMIT } from '../../src/core/memory';

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
export function compactResult(result:ActionResult) {
  const feedback=result.feedback??{};
  const from=feedback.from as Vec3|undefined,to=feedback.to as Vec3|undefined;
  let outcome=String(feedback.outcome??(result.ok?'completed':'rejected'));
  if(outcome==='arrived')outcome='completed';
  if(outcome==='blocked'&&from&&to&&distance(from,to)>.001)outcome='partial';
  return rounded({ok:result.ok,outcome,message:result.message,...(from?{from}:{}),...(to?{to}:{}),
    ...(outcome==='started'&&feedback.destination?{destination:feedback.destination}:{}),
    ...(typeof feedback.facing==='number'?{facing:feedback.facing}:{}),
  });
}
export function recentActions(events:WorldEvent[]) {
  const recent:{atSecond:number;action:string;args:Record<string,unknown>;result:ReturnType<typeof compactResult>;reaction?:{choice:string;message:string}}[]=[];
  const moving=new Map<string,typeof recent[number]>();
  for(const event of events){
    const movement=moving.get(event.actor);
    if(event.type==='movement-response'){
      const data=event.data as {choice:string;from?:Vec3;to?:Vec3;facing?:number};
      if(movement){
        movement.reaction={choice:data.choice,message:event.message};
        if(data.choice==='stop_moving'){
          movement.result=compactResult({ok:true,message:event.message,feedback:{from:movement.result.from,...data,outcome:'stopped'}});
          moving.delete(event.actor);
        }
      }
      continue;
    }
    if(['arrived','blocked','collision','rebound-ended','follow-ended','follow-blocked'].includes(event.type)){
      if(movement){
        const outcome=event.type==='arrived'?'completed':event.type==='rebound-ended'?'collision':event.type==='follow-ended'?'stopped':event.type==='follow-blocked'?'blocked':event.type;
        movement.result=compactResult({ok:event.type==='arrived',message:event.message,feedback:{from:movement.result.from,facing:movement.result.facing,...(event.data as Record<string,unknown>??{}),outcome}});
        if(event.type!=='collision')moving.delete(event.actor);
      }
      continue;
    }
    if(event.type!=='action'&&event.type!=='rejected')continue;
    const data=event.data as {action?:Action;result?:ActionResult}|undefined;
    if(!data?.action)continue;
    const {action:name,...args}=data.action;
    if(name==='stop_follow'&&movement){
      movement.result=compactResult({ok:true,message:'You stopped following.',feedback:{from:movement.result.from,to:data.result?.feedback?.to,outcome:'stopped'}});
    }
    const entry={atSecond:event.time,action:name as string,args:args as Record<string,unknown>,result:compactResult(data.result??{ok:event.type==='action',message:event.message})};
    if(name==='strike_held'&&data.action.impact){
      const point=impactPointName(data.action.impact);
      if(point){delete entry.args.impact;entry.args.point=point;}
    }
    recent.push(entry);
    if(entry.result.ok){if(['walk','run','jump','follow'].includes(name))moving.set(event.actor,entry);else moving.delete(event.actor);}
  }
  return rounded(recent.slice(-RECENT_ACTION_LIMIT));
}
