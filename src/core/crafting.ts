import { isRawBlock } from './materials';
import type { Inventory, Observation, Stack, Vec3 } from './types';

export interface Experiment {
  point: string;
  impact: Vec3;
  orientations?: ('up' | 'down')[];
  matches(impact: Vec3): boolean;
}
export interface ItemDefinition {
  experiments?: Experiment[];
  dig?: { materials: string[] };
  container?: { materials: string[] };
  uses?: string[];
}
export interface CraftRecipe {
  id: string;
  ingredients: Stack[];
  result: Stack;
  experiment?: { point: string; orientation?: 'up' | 'down' };
  knowledge: { id: string; description: string };
  message: string;
}
export interface CraftingRules {
  items: Record<string, ItemDefinition>;
  recipes: CraftRecipe[];
}
export interface ItemCapability {
  action: 'strike_held' | 'dig' | 'fill' | 'empty' | 'join';
  description: string;
  requires: string;
  available: boolean;
  stack?: number;
  recipeId?: string;
  experiments?: Pick<Experiment, 'point' | 'impact' | 'orientations'>[];
}

export const itemUseKnowledge = (kind: string) => `item-uses:${kind}`;

/** Describes methods available on an owned object, never undiscovered recipe products. */
export function itemUseDescription(kind: string, rules?: CraftingRules): string {
  const item = rules?.items[kind];
  const uses = [`While holding ${kind}, store frees my hands without losing it. World blocks require empty hands to hit; strike_held works only on the held item.`];
  if (item?.experiments?.length) uses.push(`I can experiment with strike_held at ${item.experiments.map(({ point, orientations }) => `${point}${orientations ? ` (orientation ${orientations.join(' or ')})` : ''}`).join(', ')}. Each point is a separate experiment; its result is unknown until tried.`);
  if (item?.dig) uses.push(`I can dig exposed ${item.dig.materials.join(', ')} in one strike while retaining this tool.`);
  if (item?.container) uses.push(`I can fill an empty ${kind} from reachable ${item.container.materials.join(', ')} and empty it at a valid destination, retaining the container.`);
  uses.push(...(item?.uses ?? []));
  uses.push(isRawBlock(kind) ? `Place fixes this ${kind} block to adjacent solid support.` : `Place sets this ${kind} on supporting ground.`);
  return uses.join(' ');
}

export function recipeRemovals(inventory: Inventory | null, recipe: CraftRecipe): { index: number; count: number }[] | undefined {
  if (!inventory) return;
  const remaining = inventory.stacks.map(stack => stack.count), removals: { index: number; count: number }[] = [];
  for (const ingredient of recipe.ingredients) {
    let needed = ingredient.count;
    for (const [index, stack] of inventory.stacks.entries()) {
      if (stack.kind !== ingredient.kind || stack.contents !== ingredient.contents) continue;
      const count = Math.min(needed, remaining[index]);
      if (count) { removals.push({ index, count }); remaining[index] -= count; needed -= count; }
      if (!needed) break;
    }
    if (needed) return;
  }
  return removals;
}

export function itemCapabilities(rules: CraftingRules | undefined, view: Observation): ItemCapability[] {
  const capabilities: ItemCapability[] = [], inventory = view.self.inventory;
  for (const [stack, held] of (inventory?.stacks ?? []).entries()) {
    const item = rules?.items[held.kind];
    if (!item) continue;
    const selected = stack === inventory!.selected;
    const requires = (condition: string) => `${selected ? 'Hold' : `Use hold on stack ${stack} to hold`} ${held.kind}; ${condition}`;
    if (item.experiments?.length) capabilities.push({ action: 'strike_held', stack, available: selected,
      description: `Experiment on the ${held.kind} in your hands. This consumes held material, not a world block.`, requires: requires('a free, stationary body'),
      experiments: item.experiments.map(({ point, impact, orientations }) => ({ point, impact, ...(orientations ? { orientations } : {}) })) });
    if (item.dig) capabilities.push({ action: 'dig', stack, available: selected && view.interactions.hit.length > 0,
      description: `Dig exposed ${item.dig.materials.join(', ')} in one strike and keep the tool.`, requires: requires('a compatible exposed block within reach') });
    if (item.container) capabilities.push({ action: held.contents ? 'empty' : 'fill', stack,
      available: selected && view.interactions[held.contents ? 'empty' : 'fill'].length > 0,
      description: held.contents ? `Empty the ${held.contents} and retain the container.` : `Fill from ${item.container.materials.join(', ')}.`,
      requires: requires(held.contents ? 'a valid destination within reach' : 'an empty container, a compatible visible source within reach, and inventory space') });
  }
  for (const recipe of rules?.recipes ?? []) {
    if (recipe.experiment || !recipeRemovals(inventory, recipe)) continue;
    capabilities.push({ action: 'join', recipeId: recipe.id, available: true,
      description: `Join ${recipe.ingredients.map(item => `${item.count} ${item.kind}`).join(' and ')}.`, requires: 'Own the ingredients and have a free, stationary body and inventory space.' });
  }
  return capabilities;
}
