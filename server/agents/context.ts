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
    paths:view.navigation.paths.map(path=>({angle:path.turn,clearMetres:path.clearance,...(path.issue?{obstacle:path.issue.message,...(path.issue.target?{target:path.issue.target}:{})}:{}),...(path.approach?{walk:path.approach}:{}),...(path.jump?{jump:path.jump}:{})})),
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
    ...(Array.isArray(feedback.materials)?{materials:feedback.materials.map(({material,target,distance,bodyRelativeDegrees})=>({material,...(target?{target}:{}),distance,bodyRelativeDegrees}))}:{}),
    ...(Array.isArray(feedback.entities)?{entities:feedback.entities.map(({entityId,name,kind,distance,bodyRelativeDegrees})=>({...(entityId?{entityId}:{}),name,kind,distance,bodyRelativeDegrees}))}:{}),
    ...(typeof feedback.facing==='number'?{facing:feedback.facing}:{}),
    ...(Array.isArray(feedback.target)?{target:feedback.target}:{}),
    ...(typeof feedback.material==='string'?{material:feedback.material}:{}),
    ...(typeof feedback.blockOutcome==='string'?{blockOutcome:feedback.blockOutcome}:{}),
    ...(typeof feedback.cracks==='number'?{cracks:feedback.cracks}:{}),
    ...(typeof feedback.collected==='string'?{collected:feedback.collected}:{}),
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
    if(['arrived','blocked','collision','rebound-ended','follow-ended','follow-blocked','scanned'].includes(event.type)){
      if(movement){
        const outcome=['arrived','scanned'].includes(event.type)?'completed':event.type==='rebound-ended'?'collision':event.type==='follow-ended'?'stopped':event.type==='follow-blocked'?'blocked':event.type;
        movement.result=compactResult({ok:['arrived','scanned'].includes(event.type),message:event.message,feedback:{from:movement.result.from,facing:movement.result.facing,...(event.data as Record<string,unknown>??{}),outcome}});
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
    if(entry.result.ok){if(['walk','run','jump','follow','find_material','find_entity'].includes(name))moving.set(event.actor,entry);else moving.delete(event.actor);}
  }
  return rounded(recent.slice(-RECENT_ACTION_LIMIT));
}

// A past bearing describes a past pose, not a direction to follow now.
export function historicalActions(actions:ReturnType<typeof recentActions>) {
  return actions.map(entry=>{
    const {facing,materials,entities,...result}=entry.result;
    return {...entry,result:{...result,
      ...(materials?{materials:materials.map(({material,target}: {material:string;target?:Vec3})=>({material,...(target?{target}:{})}))}:{}),
      ...(entities?{entities:entities.map(({entityId,name,kind}: {entityId?:string;name:string;kind:string})=>({...(entityId?{entityId}:{}),name,kind}))}:{}),
    }};
  });
}

export function planningActions(actions:ReturnType<typeof recentActions>) {
  return historicalActions(actions).map(({atSecond,action,args,result,reaction})=>({
    atSecond,action,
    ...(['target','itemId','entityId','point','stack'].some(key=>args[key]!==undefined)?{object:Object.fromEntries(['target','itemId','entityId','point','stack'].filter(key=>args[key]!==undefined).map(key=>[key,args[key]]))}:{}),
    result:{ok:result.ok,outcome:result.outcome,message:result.message,
      ...(result.material?{material:result.material}:{}),...(result.blockOutcome?{blockOutcome:result.blockOutcome}:{}),
      ...(result.materials?{materials:result.materials}:{}),...(result.entities?{entities:result.entities}:{}),
    },...(reaction?{reaction}:{}),
  }));
}
