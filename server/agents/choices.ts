import type { Action, Block, Entity, MilestoneCriterion, Observation, Vec3 } from '../../src/core/types';

export type LocalView = Pick<Observation, 'description' | 'navigation' | 'interactions'> & {
  self?: Entity; blocks?: Block[]; viewAngle?: number; bodyYaw?: number;
};
export interface ActionChoice { id: string; label: string; action: Action; }

export function directionLabel(angle: number) {
  const labels = ['ahead', 'ahead-right', 'right', 'behind-right', 'behind', 'behind-left', 'left', 'ahead-left'];
  return labels[((Math.round(angle / 45) % 8) + 8) % 8];
}
function relativePosition(self: Entity, target: Vec3) {
  const dx=target[0]+.5-self.position[0],dz=target[2]+.5-self.position[2];
  return directionLabel(Math.atan2(dx,dz)*180/Math.PI-self.yaw);
}

// Choices are observation-local references. Resolve them before persisting a decision.
export function actionChoices(view: LocalView, criterion?:MilestoneCriterion): ActionChoice[] {
  if(!view.self)return [];
  const self=view.self,inventory=self.inventory,held=inventory?.selected==null?undefined:inventory.stacks[inventory.selected];
  const choices:ActionChoice[]=[];
  if(criterion?.kind==='locate')choices.push({id:`scan_for_${criterion.subject}`,label:`Scan 360 degrees to locate ${criterion.subject}.`,action:{action:'find_material'}});
  else if(criterion?.kind==='scan')choices.push({id:'scan_surroundings',label:'Scan the surroundings for visible materials.',action:{action:'find_material'}});
  for(const path of view.navigation.paths){
    const direction=directionLabel(path.turn),suffix=String(path.turn).replace('-', 'left_');
    if(path.jump)choices.push({id:`jump_${suffix}`,label:`Jump ${direction}, ${path.jump.distance} m to a checked landing.`,action:{action:'jump',...path.jump}});
    const walk=path.approach??(!path.issue?{angle:path.turn,distance:Math.min(4,path.clearance)}:undefined);
    if(walk&&walk.distance>=.3)choices.push({id:`walk_${suffix}`,label:`Walk ${direction}, ${walk.distance} m${path.issue?' up to the obstacle':''}.`,action:{action:'walk',...walk}});
  }
  for(const [angle,label] of [[-90,'left'],[90,'right'],[180,'around']] as const)
    choices.push({id:`turn_${label}`,label:`Turn ${label} to inspect another direction.`,action:{action:'turn',angle}});
  const blockAction=held?.kind==='shovel'?'dig':'hit';
  for(const [index,block] of view.interactions.hit.entries())choices.push({id:`${blockAction}_${index+1}`,label:`${blockAction==='dig'?'Dig':'Strike'} ${block.kind} ${relativePosition(self,block.target)}${block.cracks?` (${block.cracks} cracks)`:''}.`,action:{action:blockAction,target:block.target}});
  for(const name of ['place','fill','empty'] as const)for(const [index,target] of view.interactions[name].entries())
    choices.push({id:`${name}_${index+1}`,label:`${name[0].toUpperCase()+name.slice(1)} ${held?.kind??'held object'} at the reachable cell ${relativePosition(self,target)}, height ${target[1]-Math.floor(self.position[1])} from your feet.`,action:{action:name,target}});
  for(const item of view.interactions.pickup)choices.push({id:`pickup_${item.itemId}`,label:`Pick up loose ${item.kind} (${item.metres} m away).`,action:{action:'pickup',itemId:item.itemId}});
  for(const [index,stack] of inventory?.stacks.entries()??[]){
    if(index===inventory?.selected)continue;
    choices.push({id:`hold_${stack.kind}${stack.contents?`_${stack.contents}`:''}`,label:`Hold ${stack.kind}${stack.contents?` containing ${stack.contents}`:''} already owned (${stack.count} in inventory). Collects nothing; quantity unchanged.`,action:{action:'hold',stack:index}});
  }
  if(held)choices.push({id:'free_hands',label:`Store ${held.kind} to free your hands. Collects nothing; quantity unchanged.`,action:{action:'store'}});
  for(const entity of view.interactions.follow)choices.push({id:`follow_${entity.id}`,label:`Follow ${entity.name} (${entity.metres} m away).`,action:{action:'follow',entityId:entity.id}});
  return choices;
}

export function localGeometry(view:LocalView) {
  if(!view.self||!view.blocks)return undefined;
  const self=view.self,nearest=new Map<string,{direction:string;level:string;material:string;target:Vec3;metres:number}>();
  for(const [x,y,z,material] of view.blocks){
    const target:Vec3=[x,y,z],metres=Math.hypot(x+.5-self.position[0],y+.5-self.position[1],z+.5-self.position[2]);
    if(metres>3.5)continue;
    const directlyAbove=Math.abs(x+.5-self.position[0])<.75&&Math.abs(z+.5-self.position[2])<.75&&y>=self.position[1]+self.height;
    const direction=directlyAbove?'overhead':relativePosition(self,target);
    const level=y+1<=self.position[1]+.05?'ground':y>=self.position[1]+self.height?'above-head':'body-height';
    const key=`${direction}:${level}`,old=nearest.get(key);
    if(!old||metres<old.metres)nearest.set(key,{direction,level,material,target,metres:Math.round(metres*10)/10});
  }
  return {visibleSurfaces:[...nearest.values()].sort((a,b)=>Number(a.level==='ground')-Number(b.level==='ground')||a.metres-b.metres).slice(0,12),unknown:'Unseen or omitted space is unknown, not an opening. Directions are relative to your body.'};
}
