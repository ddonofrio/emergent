import type {AgentPlan,Observation} from '../../src/core/types';
import {distance} from '../../src/core/types';

export function suggestionBasis(observation:Observation,turn:number,following=!!observation.self.following):NonNullable<AgentPlan['suggestionBasis']> {
  const inventory=observation.self.inventory,held=inventory?.selected==null?undefined:inventory.stacks[inventory.selected];
  return {turn,tick:observation.tick,position:[...observation.self.position],yaw:observation.self.yaw,holding:held?`${held.kind}:${held.contents??''}`:'empty',following};
}

export function applicableSuggestions(plan:AgentPlan,observation:Observation|undefined,turn:number,following?:boolean):{suggestedActions?:string[];suggestionStatus?:string} {
  const basis=plan.suggestionBasis;
  const stale=(reason:string)=>({suggestionStatus:`Historical suggestions withheld: ${reason}. Choose from the current observation; your task and learned methods remain available.`});
  if(!plan.suggestedActions?.length)return {};
  if(!basis||!observation)return stale('the originating situation was not recorded');
  if(basis.invalidated)return stale('their originating situation was already invalidated');
  const now=suggestionBasis(observation,turn,following);
  if(turn-basis.turn>=8)return stale('eight decisions have passed');
  if(distance(now.position,basis.position)>.05||Math.abs(((now.yaw-basis.yaw+540)%360)-180)>1)return stale('your position or body direction changed');
  if(now.holding!==basis.holding||now.following!==basis.following)return stale('your hands or following state changed');
  if(observation.tick>basis.tick&&(observation.self.lastAction?.ok===false||observation.terrainChanges.length||observation.impacts.length))return stale('a failed action or a physical change invalidated the original situation');
  return {suggestedActions:plan.suggestedActions,suggestionStatus:'Conditional suggestions for this pose and hand state; verify the current target before acting.'};
}

export function previousPlanContext(plan:AgentPlan,observation:Observation|undefined,turn:number,following?:boolean) {
  const {suggestedActions:_,suggestionBasis:__,...history}=plan;
  return {...history,...applicableSuggestions(plan,observation,turn,following)};
}
