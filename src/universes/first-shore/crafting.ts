import type { CraftingRules, CraftRecipe, Experiment } from '../../core/crafting';
import { impactPoints } from '../../core/impact-points';

const mid = (value: number) => value >= .32 && value <= .68;
const edge = (value: number) => value <= .18 || value >= .82;
const experiment = (point: string, matches: Experiment['matches'], orientations?: Experiment['orientations']): Experiment =>
  ({ point, impact: impactPoints[point], matches, ...(orientations ? { orientations } : {}) });
const shape = (kind: string, point: string, description: string, message: string, orientation?: 'up' | 'down', count = 1): CraftRecipe => ({
  id: `shape-${kind}`, ingredients: [{ kind: 'wood', count: 1 }], result: { kind, count },
  experiment: { point, ...(orientation ? { orientation } : {}) }, knowledge: { id: `wood-shape:${kind}`, description }, message,
});

export const firstShoreCrafting: CraftingRules = {
  items: {
    wood: { experiments: [
      experiment('top_center', ([x, y, z]) => y >= .82 && mid(x) && mid(z)),
      experiment('bottom_center', ([x, y, z]) => y <= .18 && mid(x) && mid(z)),
      experiment('front_center', ([x, y, z]) => z >= .82 && mid(x) && mid(y)),
      experiment('side_center', ([x, y, z]) => edge(x) && mid(y) && mid(z)),
      experiment('front_corner', ([x, y, z]) => edge(x) && edge(y) && edge(z)),
      experiment('front_edge', ([x, y, z]) => edge(x) && mid(y) && edge(z), ['up', 'down']),
    ] },
    bucket: { container: { materials: ['water', 'dirt', 'sand'] }, uses: ['A filled bucket must be emptied before placing it.'] },
    shovel: { dig: { materials: ['sand', 'dirt', 'grass'] } },
    door_half_up: { uses: ['I can join this upper half with an owned lower wooden door half.'] },
    door_half_down: { uses: ['I can join this lower half with an owned upper wooden door half.'] },
    door: { uses: ['I can install this door above solid ground in two clear vertical cells, then open and close it within reach.'] },
    plank: { uses: ['This plank can be set down as a loose object.'] },
    spear: { uses: ['Its available interactions are store, place and throw.'] },
    knife: { uses: ['Its available interactions are store, place and throw.'] },
  },
  recipes: [
    shape('bucket', 'top_center', 'Strike wood at top_center to make a bucket.', 'The wood changes shape under the strike. You now hold a wooden bucket.'),
    shape('plank', 'bottom_center', 'Strike wood at bottom_center to make five planks, each 0.20 metres thick.', 'The wood splits into five wooden planks, each 0.20 metres thick.', undefined, 5),
    shape('spear', 'front_center', 'Strike wood at front_center to make a spear.', 'The wood changes shape under the strike. You now hold a wooden spear.'),
    shape('knife', 'side_center', 'Strike wood at side_center to make a knife.', 'The wood changes shape under the strike. You now hold a wooden knife.'),
    shape('shovel', 'front_corner', 'Strike wood at front_corner to make a shovel; it removes sand, dirt, or grass in one strike.', 'The wood changes shape under the strike. You now hold a wooden shovel.'),
    shape('door_half_up', 'front_edge', 'Strike wood at front_edge with orientation up to make an upper door half.', 'You now hold the upper half of a rustic wooden door.', 'up'),
    shape('door_half_down', 'front_edge', 'Strike wood at front_edge with orientation down to make a lower door half.', 'You now hold the lower half of a rustic wooden door.', 'down'),
    { id: 'join-door-halves', ingredients: [{ kind: 'door_half_up', count: 1 }, { kind: 'door_half_down', count: 1 }], result: { kind: 'door', count: 1 },
      knowledge: { id: 'wood-shape:door', description: 'Join one upper and one lower wooden door half to make a rustic door.' }, message: 'You join the upper and lower wooden halves into a rustic plank door.' },
  ],
};
