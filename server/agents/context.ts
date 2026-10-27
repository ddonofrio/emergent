import type { Engine } from '../../src/core/engine';
import { knowledgeDescription } from '../../src/core/knowledge';
import type { Observation } from '../../src/core/types';
import type { ToolCall } from './providers';

// These projections are only for inference. Recorded world state retains full precision.
export function rounded<T>(value:T):T {
  return JSON.parse(JSON.stringify(value,(_key,item)=>typeof item==='number'?Math.round(item*100)/100:item));
}
export function compactView(view:Pick<Observation,'description'|'navigation'|'interactions'>&{viewAngle?:number;bodyYaw?:number}) {
  const cracked=view.interactions.hit.find(block=>block.cracks>0);
  const attention=cracked?`The ${cracked.kind} block at [${cracked.target.join(',')}] ${cracked.cracks>=2?'has deep cracks and looks close to breaking':'has visible cracks; its surface is changing'}. Try hit on that same block again to see what happens.`:undefined;
  return rounded({...(attention?{attention}:{}),perception:view.description,...(view.viewAngle===undefined?{}:{viewAngle:view.viewAngle}),
    paths:view.navigation.paths.map(path=>({angle:path.turn,clearMetres:path.clearance,...(path.issue?{obstacle:path.issue.message}:{}),...(path.approach?{walk:path.approach}:{}),...(path.jump?{jump:path.jump}:{})})),
    interactions:Object.fromEntries(Object.entries(view.interactions).filter(([,targets])=>targets.length)),
  });
}
export function inventoryContext(observation:Observation) {
  const inventory=observation.self.inventory,used=inventory?.stacks.reduce((sum,stack)=>sum+stack.count,0)??0,capacity=inventory?.capacity??64;
  return {used,capacity,free:capacity-used,hand:inventory?.selected??null,...(inventory?.stacks.length?{stacks:inventory.stacks.map((stack,index)=>({index,...stack}))}:{})};
}
export function relevantKnowledge(engine:Engine,observation:Observation) {
  return [...(engine.discoveries.get(observation.self.id)??[])].filter(fact=>engine.module.relevantKnowledge?.(observation,fact)??true).map(knowledgeDescription);
}
interface HistoryMessage {role:string;content:string|null;tool_calls?:ToolCall[];tool_call_id?:string;}
export function recentActions(cycles:HistoryMessage[][]) {
  const recent:{action:string;args:unknown;result:unknown}[]=[];
  for(const cycle of cycles){
    const calls=new Map<string,ToolCall>();
    for(const message of cycle){
      if(message.role==='user'&&message.content){try{const data=JSON.parse(message.content);if(Array.isArray(data.recent))recent.push(...data.recent);}catch{}}
      for(const call of message.tool_calls??[])calls.set(call.id,call);
      if(message.role!=='tool'||!message.tool_call_id)continue;
      const call=calls.get(message.tool_call_id);
      if(!call||['look','journal','reflect','stop_follow'].includes(call.function.name))continue;
      try{const result=JSON.parse(message.content??'null');recent.push({action:call.function.name,args:JSON.parse(call.function.arguments),result:result?.message??result});}catch{}
    }
  }
  return rounded(recent.slice(-4));
}
