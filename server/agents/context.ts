import type { Engine } from '../../src/core/engine';
import { knowledgeDescription } from '../../src/core/knowledge';
import { distance, type Action, type ActionResult, type MilestoneCriterion, type Observation, type Vec3, type WorldEvent } from '../../src/core/types';
import { impactPointName } from '../../src/core/impact-points';
import { INVENTORY_STACKS, STACK_SIZE } from '../../src/core/inventory';
import { RECENT_ACTION_LIMIT } from '../../src/core/memory';
import { TICKS_PER_SECOND } from '../../src/core/time';
import { directionLabel, localGeometry, type LocalView } from './choices';

// These projections are only for inference. Recorded world state retains full precision.
export function rounded<T>(value:T):T {
  return JSON.parse(JSON.stringify(value,(_key,item)=>typeof item==='number'?Math.round(item*100)/100:item));
}
export function bodyContext(view:{self:Observation['self'];viewAngle?:number}) {
  const direction=(yaw:number)=>({x:Math.sin(yaw*Math.PI/180),z:Math.cos(yaw*Math.PI/180)});
  return rounded({position:view.self.position,yaw:view.self.yaw,forwardXZ:direction(view.self.yaw),viewForwardXZ:direction(view.self.yaw+(view.viewAngle??0)),
    coordinateFrame:'Coordinates are [x,y,z]; y is height. Yaw 0 faces +Z; yaw 90 faces +X. Movement angles are relative to your body, not your viewing direction. Looking does not turn your body.'});
}
export function compactView(view:LocalView,criterion?:MilestoneCriterion) {
  const inventory=view.self?.inventory,held=inventory&&inventory.selected!==null?inventory.stacks[inventory.selected]:undefined;
  const blockAction=held?.kind==='shovel'?'dig':'hit';
  const cracked=view.interactions.hit.find(block=>block.cracks>0);
  const attention=cracked?blockAction==='dig'?`The cracked ${cracked.kind} at [${cracked.target.join(',')}] is within reach of your shovel. Use dig only if clearing it advances your current goal.`:`The ${cracked.kind} block at [${cracked.target.join(',')}] ${cracked.cracks>=2?'has deep cracks and looks close to breaking':'has visible cracks; its surface is changing'}. Further hits on the same block can continue this interaction if it advances your current goal.`:undefined;
  const blocked=view.navigation.paths.every(path=>path.clearance<.5);
  const jumps=view.navigation.paths.filter(path=>path.jump);
  const navigationSummary=blocked?`Walking is blocked in the three checked directions.${jumps.length?` A checked jump is available ${jumps.map(path=>directionLabel(path.turn)).join(' or ')}.`:' Look or turn to inspect another direction, or clear a reachable obstruction.'}`:undefined;
  return rounded({...(navigationSummary?{navigationSummary}:{}),...(attention?{attention}:{}),geometry:localGeometry(view),perception:view.description,...(view.viewAngle===undefined?{}:{viewAngle:view.viewAngle}),
    paths:view.navigation.paths.map(path=>({angle:path.turn,clearMetres:path.clearance,...(path.issue?{obstacle:path.issue.message,...(path.issue.target?{target:path.issue.target}:{})}:{}),...(path.approach?{walk:path.approach}:{}),...(path.jump?{jump:path.jump}:{})})),
    interactions:Object.fromEntries(Object.entries(view.interactions).filter(([,targets])=>targets.length).map(([name,targets])=>[name==='hit'?blockAction:name,targets])),
  });
}

// One representation per reachable object; prose describes state, never proposes a task.
export function decisionView(view:Observation,criterion?:MilestoneCriterion) {
  const compact=compactView(view,criterion);
  const targets=new Set([
    ...view.interactions.hit.map(block=>block.target.join(',')),
    ...view.interactions.place.map(target=>target.join(',')),
    ...view.interactions.fill.map(target=>target.join(',')),
    ...view.interactions.empty.map(target=>target.join(',')),
  ]);
  const surfaces=(compact.geometry?.visibleSurfaces??[]).filter(surface=>!targets.has(surface.target.join(',')));
  for(const surface of surfaces)targets.add(surface.target.join(','));
  const distant=view.surfaces.filter(surface=>!targets.has(surface.nearest.join(',')))
    .map(({kind,nearest})=>({material:kind,target:nearest}));
  const held=inventoryContext(view).holding;
  return rounded({
    body:bodyContext(view),
    ...(compact.navigationSummary?{navigationSummary:compact.navigationSummary}:{}),
    ...(view.interactions.hit.some(block=>block.cracks>0)?{attention:'Cracks below are observed changes on those specific blocks.'}:{}),
    perception:held==='empty'?'Your hands are empty.':`You hold ${held}.`,
    ...(compact.viewAngle===undefined?{}:{viewAngle:compact.viewAngle}),paths:compact.paths,
    surfaces:[...surfaces,...distant],
    creatures:view.entities.map(entity=>({id:entity.id,name:entity.name,position:entity.position})),
    looseObjects:view.items.map(item=>({id:item.id,kind:item.kind,position:item.position,...(item.contents?{contents:item.contents}:{}),canPickUpNow:view.interactions.pickup.some(target=>target.itemId===item.id)})),
    interactions:{speak:view.interactions.speak,follow:view.interactions.follow},
    unknown:'Unseen space is unknown. Bearings are body-relative. Only current sightings give current locations.',
  });
}

export function speechContext(observation:Observation,acknowledgedTick=-1) {
  const fresh=observation.heard.filter(voice=>voice.tick>acknowledgedTick);
  const past=observation.heard.filter(voice=>voice.tick<=acknowledgedTick);
  return rounded({
    ...(fresh.length?{newSpeech:fresh.map(({tick,direction,distance,...voice})=>({...voice,secondsAgo:(observation.tick-tick)/TICKS_PER_SECOND,directionWhenHeard:direction,distanceWhenHeard:distance}))}:{}),
    ...(past.length?{pastSpeech:past.slice(-3).map(({tick,from,word})=>({from,word,secondsAgo:(observation.tick-tick)/TICKS_PER_SECOND}))}:{}),
  });
}

export function actionFeedback<T extends {ok:boolean;outcome:string;inventoryDelta?:unknown;collected?:string}>(result:T) {
  const {ok,outcome,...effects}=result;
  return {actionAccepted:ok,actionStatus:outcome,...effects,inventoryDelta:result.inventoryDelta??[],collected:result.collected??null};
}

export function decisionCycle(actions:{eventId:number;action:string;args:Record<string,unknown>;result:{message:string;previousScanEventId?:unknown}}[]) {
  const window=actions.slice(-6);
  if(window.length<6)return undefined;
  const signature=(entry:typeof window[number])=>{
    const {previousScanEventId,...result}=entry.result;
    return JSON.stringify({action:entry.action,args:entry.args,result});
  };
  // Equal outcomes as well as equal calls: three strikes with growing cracks are progress.
  if(!window.every((entry,index)=>index<2||signature(entry)===signature(window[index%2])))return undefined;
  return {eventIds:window.map(entry=>entry.eventId),message:`The same action/result cycle occurred three times: ${window.slice(0,2).map(entry=>`${entry.action}: ${entry.result.message}`).join(' Then ')} Reconsider your method or goal using current facts.`};
}
export function inventoryContext(observation:Observation) {
  const inventory=observation.self.inventory;
  const held=inventory?.selected==null?undefined:inventory.stacks[inventory.selected];
  return {stackSlots:INVENTORY_STACKS,freeStackSlots:INVENTORY_STACKS-(inventory?.stacks.length??0),maxPerStack:STACK_SIZE,hand:inventory?.selected??null,holding:held?`${held.kind}${held.contents?` containing ${held.contents}`:''}`:'empty',...(inventory?.stacks.length?{stacks:inventory.stacks.map((stack,index)=>({index,...stack,ref:`hold_${stack.kind}${stack.contents?`_${stack.contents}`:''}`}))}:{})};
}
export function relevantKnowledge(engine:Engine,observation:Observation,allLearned=false) {
  return [...(engine.discoveries.get(observation.self.id)??[])].filter(fact=>allLearned||(engine.module.relevantKnowledge?.(observation,fact)??true)).map(knowledgeDescription);
}
export function compactResult(result:ActionResult,conciseScans=false) {
  const feedback=result.feedback??{};
  const from=feedback.from as Vec3|undefined,to=feedback.to as Vec3|undefined;
  let outcome=String(feedback.outcome??(result.ok?'completed':'rejected'));
  if(outcome==='arrived')outcome='completed';
  if(outcome==='blocked'&&from&&to&&distance(from,to)>.001)outcome='partial';
  return rounded({ok:result.ok,outcome,message:result.message,...(from?{from}:{}),...(to?{to}:{}),
    ...(outcome==='started'&&feedback.destination?{destination:feedback.destination}:{}),
    ...(feedback.unchanged===true?{unchanged:true,previousScanEventId:feedback.previousScanEventId}:{}),
    ...(!(conciseScans&&feedback.unchanged)&&Array.isArray(feedback.materials)?{materials:feedback.materials.map(({material,target,distance,bodyRelativeDegrees})=>({material,...(target?{target}:{}),distance,bodyRelativeDegrees}))}:{}),
    ...(!(conciseScans&&feedback.unchanged)&&Array.isArray(feedback.entities)?{entities:feedback.entities.map(({entityId,name,kind,distance,bodyRelativeDegrees})=>({...(entityId?{entityId}:{}),name,kind,distance,bodyRelativeDegrees}))}:{}),
    ...(typeof feedback.facing==='number'?{facing:feedback.facing}:{}),
    ...(Array.isArray(feedback.target)?{target:feedback.target}:{}),
    ...(typeof feedback.material==='string'?{material:feedback.material}:{}),
    ...(typeof feedback.blockOutcome==='string'?{blockOutcome:feedback.blockOutcome}:{}),
    ...(typeof feedback.cracks==='number'?{cracks:feedback.cracks}:{}),
    ...(typeof feedback.collected==='string'?{collected:feedback.collected}:{}),
    ...(typeof feedback.placed==='string'?{placed:feedback.placed}:{}),
    ...(typeof feedback.shaped==='string'?{shaped:feedback.shaped}:{}),
    ...(feedback.treeCollapsed===true?{treeCollapsed:true}:{}),
    ...(Array.isArray(feedback.recipientIds)?{heardBy:feedback.recipientIds as string[]}:{}),
    ...(Array.isArray(feedback.inventoryDelta)?{inventoryDelta:feedback.inventoryDelta as {kind:string;contents?:string;change:number}[]}:{}),
  });
}
export function recentActions(events:WorldEvent[],limit=RECENT_ACTION_LIMIT) {
  const recent:{eventId:number;atSecond:number;action:string;args:Record<string,unknown>;result:ReturnType<typeof compactResult>;reaction?:{choice:string;message:string}}[]=[];
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
    const entry={eventId:event.id,atSecond:event.time,action:name as string,args:args as Record<string,unknown>,result:compactResult(data.result??{ok:event.type==='action',message:event.message})};
    if(name==='strike_held'&&data.action.impact){
      const point=impactPointName(data.action.impact);
      if(point){delete entry.args.impact;entry.args.point=point;}
    }
    recent.push(entry);
    if(entry.result.ok){if(['walk','run','jump','follow','find_material','find_entity'].includes(name))moving.set(event.actor,entry);else moving.delete(event.actor);}
  }
  return rounded(recent.slice(-limit));
}

export function progressContext(actions:ReturnType<typeof historicalActions>) {
  const window=actions.slice(-10),moves=window.filter(entry=>['walk','run','jump'].includes(entry.action));
  const blocked=moves.filter(entry=>['rejected','partial','blocked','collision'].includes(entry.result.outcome));
  const from=moves.find(entry=>entry.result.from)?.result.from,to=moves.findLast(entry=>entry.result.to)?.result.to;
  const noMovement=blocked.length>=3&&(from&&to?distance(from,to)<1:moves.every(entry=>['rejected','blocked'].includes(entry.result.outcome)));
  const repeatedScans=window.filter(entry=>entry.action==='find_material'||entry.action==='find_entity').length>=3;
  const cycle=decisionCycle(actions);
  return {actionsReviewed:window.length,...(cycle?{cycle}:{}),
    collected:window.filter(entry=>entry.result.collected).map(entry=>({eventId:entry.eventId,kind:entry.result.collected})),
    placed:window.filter(entry=>entry.result.ok&&entry.result.placed).map(entry=>({eventId:entry.eventId,kind:entry.result.placed,target:entry.args.target})),
    inventoryChanges:window.flatMap(entry=>(entry.result.inventoryDelta??[]).map(change=>({eventId:entry.eventId,...change}))),
    ...(noMovement?{blockage:'At least three movement attempts failed or stopped early, with less than one metre of net progress. Use a checked jump, inspect another direction, or clear a reachable obstruction. You can use finish_goal to abandon an unhelpful goal before its scheduled review.'}:{}),
    ...(repeatedScans?{scanReminder:'Repeated scans only locate things. They do not collect or place anything.'}:{}),
  };
}

// A past bearing describes a past pose, not a direction to follow now.
export function historicalActions(actions:ReturnType<typeof recentActions>) {
  return actions.map(entry=>{
    const {facing,materials,entities,...result}=entry.result;
    return {...entry,result:{...result,
      ...(!result.unchanged&&materials?{materials:materials.map(({material,target}: {material:string;target?:Vec3})=>({material,...(target?{target}:{})}))}:{}),
      ...(!result.unchanged&&entities?{entities:entities.map(({entityId,name,kind}: {entityId?:string;name:string;kind:string})=>({...(entityId?{entityId}:{}),name,kind}))}:{}),
    }};
  });
}

export function planningActions(actions:ReturnType<typeof recentActions>) {
  return historicalActions(actions).map(({eventId,atSecond,action,args,result,reaction})=>({
    eventId,atSecond,action,args,
    ...(['target','itemId','entityId','point','stack'].some(key=>args[key]!==undefined)?{object:Object.fromEntries(['target','itemId','entityId','point','stack'].filter(key=>args[key]!==undefined).map(key=>[key,args[key]]))}:{}),
    result:{actionAccepted:result.ok,actionStatus:result.outcome,message:result.message,
      ...(result.unchanged?{unchanged:true,previousScanEventId:result.previousScanEventId}:{}),
      ...(result.material?{material:result.material}:{}),...(result.blockOutcome?{blockOutcome:result.blockOutcome}:{}),
      ...(result.materials?{materials:result.materials}:{}),...(result.entities?{entities:result.entities}:{}),
      ...(result.shaped?{shaped:result.shaped}:{}),...(result.inventoryDelta?{inventoryDelta:result.inventoryDelta}:{}),
    },...(reaction?{reaction}:{}),
  }));
}
