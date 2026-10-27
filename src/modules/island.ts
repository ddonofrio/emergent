import type { Block, Entity, Vec3, WorldModule } from '../core/types';
import { WORLD_DAY_SECONDS } from '../core/time';

const waterLevel = 0;
export const island: WorldModule = {
  manifest: {
    id: 'first-shore', version: 1, name: 'First Shore', seed: 731,
    description: 'Two curious minds. One finite island. No assigned objective.',
    bounds: { min: [-64, -32, -64], max: [64, 64, 64] }, waterLevel, gravity: 9.81,
    daySeconds: WORLD_DAY_SECONDS, vocabulary: ['hey', 'look', 'come', 'yes', 'no', 'give', 'help'],
    perception: { range: 18, fieldOfView: 120, maxBlocks: 96 },
    materials: {
      grass: { color: '#74955a', solid: true, floats: false },
      dirt: { color: '#8e7555', solid: true, floats: false },
      sand: { color: '#d3c394', solid: true, floats: false },
      stone: { color: '#82928b', solid: true, floats: false },
      wood: { color: '#886147', solid: true, floats: true },
      leaves: { color: '#477b51', solid: true, floats: true },
      plant: { color: '#94ad61', solid: false, floats: true },
      bucket: { color: '#b98b58', solid: true, floats: true, stackLimit: 64, vessel: true },
      plank: { color: '#a17a55', solid: true, floats: true },
      spear: { color: '#9b714d', solid: true, floats: true },
      knife: { color: '#a77a52', solid: true, floats: true },
      // Older recordings can contain arrows; no current recipe produces them.
      arrow: { color: '#ad8057', solid: true, floats: true },
      shovel: { color: '#aa8055', solid: true, floats: true, stackLimit: 64 },
      door_half_up: { color: '#9b704b', solid: true, floats: true },
      door_half_down: { color: '#9b704b', solid: true, floats: true },
      door: { color: '#895e3c', solid: true, floats: true, stackLimit: 64 },
    },
    agentInstructions: 'You are {name}, a curious Troglodyte living on an island. Changes catch your attention: investigate what happens. Choose your own goal, such as building a bridge or exploring what wood can become. If you have no goal, explore and choose one. Take one available action toward it. You get bored when nothing new happens. Trust action results; failed actions did not happen.',
  },
  generate() {
    const cells = new Map<string, Block>();
    const put = (x: number, y: number, z: number, kind: string) => cells.set(`${x},${y},${z}`, [x, y, z, kind]);
    const surface = new Map<string, number>();
    for (let x = -50; x <= 50; x++) for (let z = -50; z <= 50; z++) {
      const radius = Math.hypot(x, z), edge = 48 + 1.3 * Math.sin(Math.atan2(z, x) * 5);
      if (radius > edge) continue;
      const top = Math.floor(Math.min(5, (edge - radius) * .28 - 2) + (radius < 34 ? Math.sin(x * .14) * Math.cos(z * .12) * 1.4 : 0));
      surface.set(`${x},${z}`, top + 1);
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
  transformHit(kind, impact, orientation) {
    if(kind!=='wood')return null;
    const [x,y,z]=impact,mid=(v:number)=>v>=.32&&v<=.68,edge=(v:number)=>v<=.18||v>=.82;
    if(edge(x)&&edge(y)&&edge(z))return 'shovel';
    if(edge(x)&&mid(y)&&edge(z))return orientation==='up'?'door_half_up':orientation==='down'?'door_half_down':null;
    if(y<=.18&&mid(x)&&mid(z))return 'plank';
    if(y>=.82&&mid(x)&&mid(z))return 'bucket';
    if(z>=.82&&mid(x)&&mid(y))return 'spear';
    if(edge(x)&&mid(y)&&mid(z))return 'knife';
    return null;
  },
  describeObstacle(issue) {
    if(issue.material==='wood'&&(issue.height??0)>1)return 'A tree trunk or tall wooden structure blocks your path.';
  },
  encounterMessage(observer,other,metres){
    if(observer.kind==='troglodyte')return `You see ${other.name}, ${other.kind==='troglodyte'?'another Troglodyte':`a ${other.kind}`}, ${metres.toFixed(1)} metres away. You can use say to speak to them if you wish.`;
  },
  agentHints(observation,learned){
    const inventory=observation.self.inventory,stack=inventory?.stacks.findIndex(item=>item.kind==='wood')??-1;
    if(stack<0||[...learned].some(knowledge=>knowledge.startsWith('wood-shape:')))return [];
    return [inventory!.selected===stack?'The wood in your hands looks shapeable; try strike_held.':`Your stored wood looks shapeable; use hold with stack=${stack} to examine it.`];
  },
  relevantKnowledge(observation,knowledge){
    const inventory=observation.self.inventory,held=inventory?.selected===null||!inventory?undefined:inventory.stacks[inventory.selected];
    const nearWater=observation.self.position[1]<=waterLevel+1||observation.navigation.paths.some(path=>path.issue?.kind==='water');
    if(knowledge==='blocks-break-after-three-hits')return !held&&observation.interactions.hit.length>0;
    if(knowledge==='deep-water-limit')return nearWater;
    if(knowledge==='thrown-blocks-settle')return !!held&&['dirt','grass','sand','stone','wood','leaves','plant'].includes(held.kind);
    if(knowledge==='nonfloating-objects-sink')return nearWater&&!!held;
    if(knowledge==='wood-shape:door')return !!inventory?.stacks.some(stack=>stack.kind==='door_half_up'||stack.kind==='door_half_down');
    if(knowledge.startsWith('wood-shape:'))return held?.kind==='wood';
    return false;
  },
  respondToSpeech(listener){
    if(listener.kind==='duck')return 'quack';
  },
  canEnter(entity, feet) {
    return waterLevel - feet[1] > entity.height / 2
      ? { ok: false, message: 'Refused: the water would rise above half my height.' }
      : { ok: true, message: 'Safe depth.' };
  },
  movementSpeed(entity,feet,speed){
    return waterLevel-feet[1]>=entity.height/2?speed/2:speed;
  },
};
