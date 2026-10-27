export function knowledgeDescription(knowledge:string) {
  if(knowledge==='blocks-break-after-three-hits')return 'Repeated strikes break blocks after three hits.';
  if(knowledge==='deep-water-limit')return 'The island ends at deep water. I cannot leave it because the water would rise above half my height.';
  if(knowledge==='thrown-blocks-settle')return 'Thrown blocks settle and become part of the terrain.';
  if(knowledge==='nonfloating-objects-sink')return 'Non-floating objects thrown into deep water sink until they are lost.';
  if(knowledge.startsWith('wood-shape:'))return `Wood can be shaped into a ${knowledge.slice('wood-shape:'.length)}.`;
  return knowledge;
}
