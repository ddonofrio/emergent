import type { Block, Entity, Observation, Vec3 } from '../../src/core/types';

export type LocalView = Pick<Observation, 'description' | 'navigation' | 'interactions'> & {
  self?: Entity; blocks?: Block[]; viewAngle?: number; bodyYaw?: number;
};
export function directionLabel(angle: number) {
  const labels = ['ahead', 'ahead-right', 'right', 'behind-right', 'behind', 'behind-left', 'left', 'ahead-left'];
  return labels[((Math.round(angle / 45) % 8) + 8) % 8];
}
function relativePosition(self: Entity, target: Vec3) {
  const dx=target[0]+.5-self.position[0],dz=target[2]+.5-self.position[2];
  return directionLabel(Math.atan2(dx,dz)*180/Math.PI-self.yaw);
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
