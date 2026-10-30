const OBSERVED_MATERIAL_PREFIX='observed-material:';

export function observedMaterialKnowledge(material:string) {
  return `${OBSERVED_MATERIAL_PREFIX}${material}`;
}

export function isObservedMaterialKnowledge(knowledge:unknown) {
  return typeof knowledge==='string'&&knowledge.startsWith(OBSERVED_MATERIAL_PREFIX);
}

export function knowledgeDescription(knowledge:string) {
  if(knowledge==='blocks-break-after-three-hits')return 'Repeated strikes break blocks after three hits.';
  if(knowledge==='deep-water-limit')return 'The island ends at deep water. I cannot leave it because the water would rise above half my height.';
  if(knowledge==='thrown-blocks-settle')return 'Thrown blocks settle and become part of the terrain.';
  if(knowledge==='nonfloating-objects-sink')return 'Non-floating objects thrown into deep water sink until they are lost.';
  if(knowledge==='wood-shape:plank')return 'Strike wood at bottom_center to make five planks, each 0.20 metres thick.';
  if(knowledge==='wood-shape:bucket')return 'Strike wood at top_center to make a bucket.';
  if(knowledge==='wood-shape:spear')return 'Strike wood at front_center to make a spear.';
  if(knowledge==='wood-shape:knife')return 'Strike wood at side_center to make a knife.';
  if(knowledge==='wood-shape:shovel')return 'Strike wood at front_corner to make a shovel; it removes sand, dirt, or grass in one strike.';
  if(knowledge==='wood-shape:door_half_up')return 'Strike wood at front_edge with orientation up to make an upper door half.';
  if(knowledge==='wood-shape:door_half_down')return 'Strike wood at front_edge with orientation down to make a lower door half.';
  if(knowledge==='wood-shape:door')return 'Join one upper and one lower wooden door half to make a rustic door.';
  if(knowledge.startsWith('wood-shape:'))return `Wood can be shaped into a ${knowledge.slice('wood-shape:'.length)}.`;
  if(knowledge.startsWith(OBSERVED_MATERIAL_PREFIX)){
    const material=knowledge.slice(OBSERVED_MATERIAL_PREFIX.length);
    return material==='water'?'I have directly observed water on this island.':`I have observed ${material} terrain on this island.`;
  }
  return knowledge;
}
