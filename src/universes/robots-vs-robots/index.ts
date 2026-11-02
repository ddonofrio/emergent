import { standardMaterials } from '../../core/materials';
import { WORLD_DAY_SECONDS } from '../../core/time';
import type { Entity, UniverseModule } from '../../core/types';

const duck: Entity = {
  id: 'duck',
  name: 'Pebble',
  kind: 'duck',
  controller: 'wander',
  enabled: true,
  position: [.5, 1, .5],
  yaw: 0,
  height: .65,
  hitbox: { radius: .24, height: .65 },
  color: '#f3e6bb',
  inventory: null,
  status: 'idle',
};

export const robotsVsRobots: UniverseModule = {
  manifest: {
    id: 'robots-vs-robots',
    version: 1,
    name: 'Robots vs Robots',
    seed: 1701,
    description: 'An unbounded universe waiting for its first robots.',
    bounds: { min: [-1_000_000_000, -32, -1_000_000_000], max: [1_000_000_000, 64, 1_000_000_000] },
    infiniteHorizontal: true,
    terrain: {
      type: 'layers',
      top: 0,
      layers: [
        { min: 0, kind: 'grass' },
        { min: -3, kind: 'dirt' },
        { min: -32, kind: 'stone' },
      ],
    },
    view: { overviewPosition: [14, 11, 18], overviewTarget: [.5, 1, .5], maxDistance: 70, fog: { near: 55, far: 95 } },
    waterLevel: -32,
    gravity: 9.81,
    daySeconds: WORLD_DAY_SECONDS,
    vocabulary: [],
    perception: { range: 18, fieldOfView: 120, maxBlocks: 96 },
    materials: standardMaterials,
    agentInstructions: 'You are {name}, an embodied robot in an unbounded physical world. Choose your own goals and success conditions from what you can perceive and remember.',
    planningInstructions: 'Choose and maintain your own direction, project, immediate task, and success conditions from your local experience.',
  },
  generate: () => ({ blocks: [], entities: [duck] }),
};
