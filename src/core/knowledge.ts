import { itemUseDescription, type CraftingRules } from './crafting';

const OBSERVED_MATERIAL_PREFIX='observed-material:';

export function observedMaterialKnowledge(material:string) {
  return `${OBSERVED_MATERIAL_PREFIX}${material}`;
}

export function isObservedMaterialKnowledge(knowledge:unknown) {
  return typeof knowledge==='string'&&knowledge.startsWith(OBSERVED_MATERIAL_PREFIX);
}

export function knowledgeDescription(knowledge:string, crafting?:CraftingRules) {
  if(knowledge.startsWith('item-uses:'))return itemUseDescription(knowledge.slice('item-uses:'.length),crafting);
  const recipe=crafting?.recipes.find(recipe=>recipe.knowledge.id===knowledge);
  if(recipe)return recipe.knowledge.description;
  if(knowledge==='blocks-break-after-three-hits')return 'Repeated strikes break blocks after three hits.';
  if(knowledge==='deep-water-limit')return 'The island ends at deep water. I cannot leave it because the water would rise above half my height.';
  if(knowledge==='thrown-blocks-settle')return 'Thrown blocks settle and become part of the terrain.';
  if(knowledge==='nonfloating-objects-sink')return 'Non-floating objects thrown into deep water sink until they are lost.';
  if(knowledge.startsWith(OBSERVED_MATERIAL_PREFIX)){
    const material=knowledge.slice(OBSERVED_MATERIAL_PREFIX.length);
    return material==='water'?'I have directly observed water on this island.':`I have observed ${material} terrain on this island.`;
  }
  return knowledge;
}
