import FastNoiseLite from 'fastnoise-lite';
import type { NoiseField, NoiseTerrain, ProceduralTerrain, Vec3 } from './types';

interface TerrainNoise {
  hills:FastNoiseLite;mountains:FastNoiseLite;biome:FastNoiseLite;dunes:FastNoiseLite;rivers:FastNoiseLite;
  ores:FastNoiseLite[];
}

const cache=new WeakMap<NoiseTerrain,Map<number,TerrainNoise>>();
const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));
const smoothstep=(edge0:number,edge1:number,value:number)=>{
  const t=clamp((value-edge0)/Math.max(.000001,edge1-edge0),0,1);return t*t*(3-2*t);
};

function noise(seed:number,field:NoiseField,seedOffset:number){
  const result=new FastNoiseLite(seed+seedOffset);result.SetNoiseType(FastNoiseLite.NoiseType.OpenSimplex2);result.SetFrequency(field.frequency);
  const fractal=field.fractal==='ridged'?FastNoiseLite.FractalType.Ridged:field.fractal==='pingpong'?FastNoiseLite.FractalType.PingPong:FastNoiseLite.FractalType.FBm;
  result.SetFractalType(fractal);result.SetFractalOctaves(field.octaves??3);result.SetFractalGain(.5);result.SetFractalLacunarity(2);return result;
}

function generators(terrain:NoiseTerrain,seed:number){
  let seeds=cache.get(terrain);if(!seeds){seeds=new Map();cache.set(terrain,seeds);}const existing=seeds.get(seed);if(existing)return existing;
  const result:TerrainNoise={
    hills:noise(seed,terrain.hills,101),mountains:noise(seed,terrain.mountains,211),biome:noise(seed,terrain.biome,307),
    dunes:noise(seed,terrain.dunes,401),rivers:noise(seed,terrain.rivers,503),ores:terrain.ores.map(ore=>noise(seed,ore,ore.seedOffset)),
  };seeds.set(seed,result);return result;
}

export interface TerrainColumn { top:number; surface:string; arid:boolean; river:number; }

export function terrainColumn(terrain:ProceduralTerrain,seed:number,x:number,z:number):TerrainColumn{
  if(terrain.type==='layers')return{top:terrain.top,surface:terrain.layers.find(layer=>terrain.top>=layer.min)?.kind??'',arid:false,river:0};
  const fields=generators(terrain,seed),arid=fields.biome.GetNoise(x,z)>terrain.biome.aridThreshold;
  const hills=fields.hills.GetNoise(x,z)*terrain.hills.amplitude;
  const mountainValue=(fields.mountains.GetNoise(x,z)+1)/2,mountain=smoothstep(terrain.mountains.threshold,1,mountainValue)*terrain.mountains.amplitude;
  const dune=arid?Math.max(0,(fields.dunes.GetNoise(x,z)+1)/2)*terrain.dunes.amplitude:0;
  const riverDistance=Math.abs(fields.rivers.GetNoise(x,z)),river=1-smoothstep(terrain.rivers.width,terrain.rivers.width+terrain.rivers.bankWidth,riverDistance);
  let height=terrain.baseHeight+hills+mountain+dune;height=height*(1-river)+terrain.rivers.bedHeight*river;
  const spawnDistance=Math.hypot(x+.5,z+.5),outsideSpawn=smoothstep(terrain.spawn.radius,terrain.spawn.radius+terrain.spawn.blend,spawnDistance);
  height=terrain.spawn.height*(1-outsideSpawn)+height*outsideSpawn;
  const top=clamp(Math.round(height),terrain.floor.y+1,terrain.ceiling),sand=top<=terrain.waterLevel||arid&&outsideSpawn>.35;
  return{top,surface:sand?terrain.soil.aridSurface:terrain.soil.temperateSurface,arid:sand,river};
}

export function terrainSurfaceY(terrain:ProceduralTerrain,seed:number,x:number,z:number){return terrainColumn(terrain,seed,Math.floor(x),Math.floor(z)).top;}
export function terrainFloorY(terrain:ProceduralTerrain){return terrain.type==='layers'?terrain.layers.at(-1)!.min:terrain.floor.y;}

export function terrainKindAt(terrain:ProceduralTerrain|undefined,seed:number,p:Vec3){
  if(!terrain)return undefined;const [x,y,z]=p.map(Math.floor) as Vec3;
  if(terrain.type==='layers')return y>terrain.top?undefined:terrain.layers.find(layer=>y>=layer.min)?.kind;
  const column=terrainColumn(terrain,seed,x,z);if(y>column.top||y<terrain.floor.y)return undefined;if(y===terrain.floor.y)return terrain.floor.kind;
  if(y===column.top)return column.surface;
  if(y>column.top-terrain.soil.depth)return column.arid?terrain.soil.arid:terrain.soil.temperate;
  const fields=generators(terrain,seed);
  for(let index=0;index<terrain.ores.length;index++){
    const ore=terrain.ores[index];if(y>=ore.minY&&y<=ore.maxY&&fields.ores[index].GetNoise(x,y,z)>ore.threshold)return ore.kind;
  }
  return terrain.stone;
}
