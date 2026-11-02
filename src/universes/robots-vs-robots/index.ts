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

const min01: Entity = {
  id: 'min-01',
  name: 'MIN-01',
  kind: 'miner-robot',
  controller: 'agent',
  enabled: true,
  position: [10.5, 1, .5],
  yaw: -90,
  height: 1.4,
  hitbox: { radius: .43, height: 1.4 },
  color: '#7b817b',
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
  generate: () => ({ blocks: [], entities: [duck, min01] }),
  migrateState(state) {
    if(state.entities.some(entity=>entity.id===min01.id))return;
    const pebble=state.entities.find(entity=>entity.id===duck.id),position=pebble
      ? [pebble.position[0]+10,pebble.position[1],pebble.position[2]] as [number,number,number]
      : min01.position;
    return {
      state:{...state,entities:[...state.entities,{...min01,position}]},
      events:[{
        actor:min01.id,
        type:'entity-arrival',
        message:`${min01.name} joined the world ten metres to ${duck.name}'s right.`,
        data:{position,relativeTo:duck.id},
      }],
    };
  },
};
