import type { Block, Entity, Vec3, WorldModule } from '../core/types';

const waterLevel = 0;
export const island: WorldModule = {
  manifest: {
    id: 'first-shore', version: 1, name: 'First Shore', seed: 731,
    description: 'Two curious minds. One finite island. No assigned objective.',
    bounds: { min: [-64, -32, -64], max: [64, 64, 64] }, waterLevel, gravity: 9.81,
    daySeconds: 600, vocabulary: ['hey', 'look', 'come', 'yes', 'no', 'give', 'help'],
    perception: { range: 18, fieldOfView: 120, maxBlocks: 96 },
    materials: {
      grass: { color: '#74955a', solid: true, floats: false },
      dirt: { color: '#8e7555', solid: true, floats: false },
      sand: { color: '#d3c394', solid: true, floats: false },
      stone: { color: '#82928b', solid: true, floats: false },
      wood: { color: '#886147', solid: true, floats: true },
      leaves: { color: '#477b51', solid: true, floats: true },
      plant: { color: '#94ad61', solid: false, floats: true },
      bucket: { color: '#b98b58', solid: true, floats: true, stackLimit: 1, vessel: true },
    },
    agentInstructions: 'You are a Troglodyte living on a small island surrounded by deep water. You are embodied here, curious, and quick to tire of repetition. You have no assigned goal. Explore, experiment with what you encounter, notice consequences, and follow whatever becomes interesting. You know only what you perceive, hear, remember, or discover through action. Other creatures may have intentions of their own. Use your small spoken vocabulary when communication seems useful. Tool results are reality: if an action fails, adapt rather than pretending it happened.',
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
      if (Math.sin(x * 17 + z * 31) > .4 && Math.hypot(x, z) > 6 && Math.hypot(x, z) < 35) put(x, surface.get(`${x},${z}`)!, z, 'plant');
    }
    for (const [x,z] of [[2,2], [-3,-2], [4,1]]) put(x, surface.get(`${x},${z}`)!, z, 'wood');
    const entity = (id: string, name: string, kind: string, x: number, z: number, color: string, yaw: number): Entity => ({
      id, name, kind, controller: kind === 'troglodyte' ? 'agent' : 'wander', enabled: true, position: [x + .5, surface.get(`${x},${z}`)!, z + .5], yaw,
      height: kind === 'troglodyte' ? 2 : .65, color, inventory: null, status: 'idle',
    });
    return { blocks: [...cells.values()], entities: [entity('t1', 'Moss', 'troglodyte', -1, 0, '#e8b36d', 0), entity('t2', 'Flint', 'troglodyte', 2, -2, '#a5bff0', 180), entity('duck', 'Pebble', 'duck', -4, 4, '#f3e6bb', 90)] };
  },
  transformHit(kind, impact) {
    return kind === 'wood' && impact.every(v => Math.abs(v - .5) <= .16) ? 'bucket' : null;
  },
  canEnter(entity, feet) {
    return waterLevel - feet[1] > entity.height / 2
      ? { ok: false, message: 'Refused: the water would rise above half my height.' }
      : { ok: true, message: 'Safe depth.' };
  },
};
