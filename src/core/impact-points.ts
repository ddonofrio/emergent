import type { Vec3 } from './types';

export const impactPoints:Record<string,Vec3>={top_center:[.5,1,.5],bottom_center:[.5,0,.5],front_center:[.5,.5,1],side_center:[1,.5,.5],front_corner:[0,1,1],front_edge:[0,.5,1]};

export function impactPointName(impact:Vec3) {
  return Object.entries(impactPoints).find(([,point])=>point.every((value,index)=>value===impact[index]))?.[0];
}
