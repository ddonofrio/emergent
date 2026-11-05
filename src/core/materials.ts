import type { Material } from './types';

const rawBlocks = new Set(['grass', 'dirt', 'sand', 'stone', 'wood', 'leaves', 'iron_ore', 'copper_ore', 'quartz', 'coal', 'lithium_ore', 'titanium_ore']);
export const isRawBlock = (kind: string) => rawBlocks.has(kind);

export const standardMaterials: Readonly<Record<string, Material>> = {
  water: { color: '#4d86a8', solid: false, floats: false, fluid: true },
  grass: { color: '#74955a', solid: true, floats: false },
  dirt: { color: '#8e7555', solid: true, floats: false },
  sand: { color: '#d3c394', solid: true, floats: false },
  stone: { color: '#82928b', solid: true, floats: false },
  wood: { color: '#886147', solid: true, floats: true },
  leaves: { color: '#477b51', solid: true, floats: true },
  plant: { color: '#94ad61', solid: false, floats: true },
  stick: { color: '#795334', solid: true, floats: true },
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
};
