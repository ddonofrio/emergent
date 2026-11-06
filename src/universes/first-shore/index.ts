import type { Action, Block, Entity, UniverseModule, Vec3, WanderContext } from '../../core/types';
import { WORLD_DAY_SECONDS } from '../../core/time';
import { standardMaterials } from '../../core/materials';
import { isObservedMaterialKnowledge } from '../../core/knowledge';
import { firstShoreCrafting } from './crafting';

const waterLevel = 0;
function islandSurfaceAt(x:number,z:number){
  x=Math.floor(x);z=Math.floor(z);
  const radius=Math.hypot(x,z),edge=48+1.3*Math.sin(Math.atan2(z,x)*5);
  if(radius>edge)return;
  const top=Math.floor(Math.min(5,(edge-radius)*.28-2)+(radius<34?Math.sin(x*.14)*Math.cos(z*.12)*1.4:0));
  return top+1;
}
function isLandColumn(x:number,z:number){const surface=islandSurfaceAt(x+.5,z+.5);return surface!==undefined&&surface>=waterLevel;}
const shoreline:(readonly [number,number])[]=[];
for(let x=-50;x<=50;x++)for(let z=-50;z<=50;z++)if(isLandColumn(x,z)&&[
  [-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1],
].some(([dx,dz])=>!isLandColumn(x+dx,z+dz)))shoreline.push([x+.5,z+.5]);
function distanceToShore(x:number,z:number){
  let nearest=Infinity;
  for(const [shoreX,shoreZ] of shoreline){
    const dx=Math.max(0,Math.abs(x-shoreX)-.5),dz=Math.max(0,Math.abs(z-shoreZ)-.5);
    nearest=Math.min(nearest,Math.hypot(dx,dz));
  }
  return nearest;
}
interface DuckWanderState extends Record<string,unknown> { routine:'duck-wander'; seed:number; heading:number; }
function duckWanderState(entity:Entity){
  let state=entity.automation as unknown as DuckWanderState|undefined;
  if(state?.routine==='duck-wander')return state;
  const seed=[...entity.id].reduce((value,character)=>(Math.imul(value,31)+character.charCodeAt(0))>>>0,0x9e3779b9);
  state={routine:'duck-wander',seed,heading:entity.yaw};entity.automation=state;return state;
}
function nextDuckRandom(state:DuckWanderState){state.seed=(Math.imul(state.seed,1664525)+1013904223)>>>0;return state.seed/0x100000000;}
function duckWanderAction(entity:Entity,context:WanderContext):Action|undefined{
  if(entity.kind!=='duck')return;
  const state=duckWanderState(entity),spread=entity.lastAction?.ok===false?125:65;
  const preferred=state.heading+(nextDuckRandom(state)*2-1)*spread,distance=2.2+nextDuckRandom(state)*3.2;
  const offsets=[0,25,-25,50,-50,80,-80,115,-115,155,-155,180];
  for(let index=offsets.length-1;index>0;index--){const other=Math.floor(nextDuckRandom(state)*(index+1));[offsets[index],offsets[other]]=[offsets[other],offsets[index]];}
  let bestYaw=preferred,bestDistance=0;
  for(const offset of offsets){
    const yaw=(preferred+offset+720)%360,clearance=context.clearDistance(yaw,distance),travel=clearance<distance?Math.max(0,clearance-.15):distance;
    if(travel>bestDistance){bestYaw=yaw;bestDistance=travel;}
  }
  state.heading=bestYaw;
  const angle=((bestYaw-entity.yaw+540)%360)-180;
  return bestDistance>=.45?{action:'walk',distance:bestDistance,angle}:{action:'turn',angle};
}
export const island: UniverseModule = {
  manifest: {
    id: 'first-shore', version: 1, name: 'First Shore', seed: 731,
    description: 'Curious creatures on a finite island, choosing their own goals.',
    bounds: { min: [-64, -32, -64], max: [64, 64, 64] }, waterLevel, gravity: 9.81,
    daySeconds: WORLD_DAY_SECONDS, vocabulary: [],
    perception: { range: 18, fieldOfView: 120, maxBlocks: 96 },
    materials: standardMaterials,
    agentInstructions: 'You are {name}, a curious and social embodied Troglodyte living on a finite island. Choose your own interests, goals, and success conditions. You are one continuing individual: keep your goals and memory in this conversation and use tools to act. You know only what you perceive, discover, remember, or hear. Communication matters: listen carefully to what others say and share useful information when appropriate. Sharing knowledge with others is another way to preserve it beyond your own memory. Unseen space is unknown. Tool results report what happened; you decide whether that satisfies your goals. Hold and store change your hands without changing quantities. Negative angles mean left; positive angles mean right.',
  },
  generate() {
    const cells = new Map<string, Block>();
    const put = (x: number, y: number, z: number, kind: string) => cells.set(`${x},${y},${z}`, [x, y, z, kind]);
    const surface = new Map<string, number>();
    for (let x = -50; x <= 50; x++) for (let z = -50; z <= 50; z++) {
      const surfaceY=islandSurfaceAt(x,z);
      if(surfaceY===undefined)continue;
      const radius=Math.hypot(x,z),top=surfaceY-1;
      surface.set(`${x},${z}`, surfaceY);
      const bottom = -5 - Math.floor((1 - radius / 50) * 3);
      for (let y = bottom; y <= top; y++) put(x, y, z, y === top ? (top <= 1 ? 'sand' : 'grass') : y >= top - 2 ? 'dirt' : 'stone');
    }
    for (const [x, z] of [[-10, -8], [13, 8], [-19, 15], [21, -16], [-6, 26], [29, 7], [-29, -12], [5, -25], [-23, 28]]) {
      const y = surface.get(`${x},${z}`)!;
      for (let dy = 0; dy < 5; dy++) put(x, y + dy, z, 'wood');
      for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = 3; dy <= 6; dy++) {
        if (Math.abs(dx) + Math.abs(dz) + Math.abs(dy - 4) < 5 && !(dx === 0 && dz === 0 && dy < 5)) put(x + dx, y + dy, z + dz, 'leaves');
      }
    }
    for (let x = -35; x <= 35; x += 4) for (let z = -35; z <= 35; z += 5) {
      const y=surface.get(`${x},${z}`)!;
      if (Math.sin(x * 17 + z * 31) > .4 && Math.hypot(x, z) > 6 && Math.hypot(x, z) < 35 && !cells.has(`${x},${y},${z}`)) put(x, y, z, 'plant');
    }
    for (const [x,z] of [[2,2], [-3,-2], [4,1]]) put(x, surface.get(`${x},${z}`)!, z, 'wood');
    const entity = (id: string, name: string, kind: string, x: number, z: number, color: string, yaw: number): Entity => ({
      id, name, kind, controller: kind === 'troglodyte' ? 'agent' : 'wander', enabled: true, position: [x + .5, surface.get(`${x},${z}`)!, z + .5], yaw,
      height: kind === 'troglodyte' ? 2 : .65, hitbox: { radius: kind === 'troglodyte' ? .36 : .24, height: kind === 'troglodyte' ? 2 : .65 }, color, inventory: null, status: 'idle',
    });
    return { blocks: [...cells.values()], entities: [entity('t1', 'Moss', 'troglodyte', -1, 0, '#e8b36d', 0), entity('t2', 'Flint', 'troglodyte', 2, -2, '#a5bff0', 180), entity('duck', 'Pebble', 'duck', -4, 4, '#f3e6bb', 90)] };
  },
  wanderAction:duckWanderAction,
  waterSurfaceHeight(entity,x,z){
    if(entity.kind!=='duck')return;
    const surface=islandSurfaceAt(x,z);
    return surface===undefined||surface<waterLevel?waterLevel:undefined;
  },
  movementStepHeight(entity){return entity.kind==='duck'?1:0;},
  movementInertia(entity){return entity.kind==='duck'?{acceleration:3,deceleration:3}:undefined;},
  crafting: firstShoreCrafting,
  describeObstacle(issue) {
    if(issue.material==='wood'&&(issue.height??0)>1)return 'A tree trunk or tall wooden structure blocks your path.';
  },
  encounterMessage(observer,other,metres){
    if(observer.kind==='troglodyte')return `You see ${other.name}, ${other.kind==='troglodyte'?'another Troglodyte':`a ${other.kind}`}, ${metres.toFixed(1)} metres away. You can use say to speak to them if you wish.`;
  },
  relevantKnowledge(observation,knowledge){
    const inventory=observation.self.inventory,held=inventory?.selected===null||!inventory?undefined:inventory.stacks[inventory.selected];
    if(isObservedMaterialKnowledge(knowledge))return true;
    if(knowledge.startsWith('item-uses:'))return !!inventory?.stacks.some(stack=>stack.kind===knowledge.slice('item-uses:'.length));
    const recipe=this.crafting?.recipes.find(recipe=>recipe.knowledge.id===knowledge);
    if(recipe)return recipe.ingredients.some(ingredient=>inventory?.stacks.some(stack=>stack.kind===ingredient.kind));
    const nearWater=observation.self.position[1]<=waterLevel+1||observation.navigation.paths.some(path=>path.issue?.kind==='water');
    if(knowledge==='blocks-break-after-three-hits')return !held&&observation.interactions.hit.length>0;
    if(knowledge==='deep-water-limit')return nearWater;
    if(knowledge==='thrown-blocks-settle')return !!held&&['dirt','grass','sand','stone','wood','leaves'].includes(held.kind);
    if(knowledge==='nonfloating-objects-sink')return nearWater&&!!held;
    return false;
  },
  respondToSpeech(listener){
    if(listener.kind==='duck')return {word:'quack',faceSpeaker:true,cooldownSeconds:20};
  },
  canEnter(entity, feet, inWater=false) {
    if(entity.kind==='duck'&&inWater){
      return distanceToShore(feet[0],feet[2])<=5?{ok:true,message:'Safe water close to shore.'}:{ok:false,message:'Pebble stays within five metres of the shore.'};
    }
    return waterLevel - feet[1] > entity.height / 2
      ? { ok: false, message: 'Refused: the water would rise above half my height.' }
      : { ok: true, message: 'Safe depth.' };
  },
  movementSpeed(entity,feet,speed,inWater=false){
    if(entity.kind==='duck')return speed*(inWater?.625:1.25);
    return waterLevel-feet[1]>=entity.height/2?speed/2:speed;
  },
};
