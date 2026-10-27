import { assertSupportedJsonSchema, validateJsonSchemaValue, type JsonSchemaNode } from '../../vendor/deepseek-harness/json-schema';
import type { Engine } from '../../src/core/engine';
import type { Action } from '../../src/core/types';
import { knowledgeDescription } from '../../src/core/knowledge';
import { PRIVATE_NOTE_LIMIT } from '../../src/core/memory';

export interface Memory { notes: string[]; }
export interface WorldTool {
  name: string; description: string; parameters: JsonSchemaNode;
  physical: boolean;
  output: { schema: JsonSchemaNode; render(args: unknown, value: unknown): { type: 'text'; text: string }[] };
  execute(args: unknown, exec?: { signal?: AbortSignal }): Promise<unknown>;
  invoke(args: unknown, exec?: { signal?: AbortSignal }): unknown;
}
const vector: JsonSchemaNode = { type: 'array', items: { type: 'number' }, description: 'Exactly three numbers: [x,y,z].' };
export function worldTools(engine: Engine, id: string, memory: Memory, options: {reflection?:boolean;following?:boolean;viewAngle?:number} = {}): WorldTool[] {
  const tool = (name: string, description: string, parameters: JsonSchemaNode, physical: boolean, run: (args: any) => unknown): WorldTool => {
    assertSupportedJsonSchema(parameters);
    return { name, description, parameters, physical, output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args, exec) { return this.invoke(args, exec); },
      invoke(args, exec) {
        exec?.signal?.throwIfAborted();
        const errors = validateJsonSchemaValue(parameters, args);
        if (errors.length) return { ok: false, message: errors.join('; ') };
        return run(args);
      } };
  };
  const action = (name:string,description:string,parameters:JsonSchemaNode,actionName:Action['action']) => tool(name,description,parameters,true,(args:Action)=>engine.act(id,{...args,action:actionName}));
  const noArgs:JsonSchemaNode={type:'object',properties:{},additionalProperties:false};
  const entity=engine.entity(id),held=engine.held(entity);
  if(options.following??!!entity.following)return [
    action('follow','Continue automatically following the current entity for this world second, stopping one metre away. Movement respects obstacles and safe water depth.',noArgs,'follow'),
    tool('stop_follow','Stop following and immediately choose another action at the same world instant. This does not spend your physical action.',noArgs,false,()=>({ok:true,message:'Stopping is staged. Choose another action now; the world has not advanced.'})),
  ];
  const movement=(maximum:number):JsonSchemaNode=>({type:'object',required:['distance'],additionalProperties:false,properties:{distance:{type:'number',description:`Travel distance in metres, greater than 0 and at most ${maximum}.`},angle:{type:'number',description:'Degrees relative to your body facing, from -180 to 180: negative is left, positive is right.'}}});
  const jumpParameters:JsonSchemaNode={type:'object',properties:{distance:{type:'number',description:'Jump length from your current position: 0.75 to 2.5 metres. Default 2. Never use a distant obstacle location as the jump length.'},angle:{type:'number',description:'Degrees relative to body facing, from -90 to 90.'}},additionalProperties:false};
  const jumpDescription='Jump 0.75 to 2.5 metres from where you stand, onto a one-block rise or across a one-block gap. Approach distant obstacles on foot first. Walls two blocks high and unsafe landings are refused. You can jump while holding a block.';
  const target:JsonSchemaNode={type:'object',required:['target'],additionalProperties:false,properties:{target:vector}};
  const tools:WorldTool[]=[
    tool('look','Look in a relative direction and receive a fresh, short embodied description. This does not turn your body or advance world time. Navigation turn, approach.angle and jump.angle remain relative to your body facing.',{type:'object',properties:{angle:{type:'number',description:'Relative viewing angle from -180 to 180 degrees.'}},additionalProperties:false},false,({angle=0}:{angle?:number})=>engine.observeAt(id,Math.max(-180,Math.min(180,angle)))),
    action('walk','Walk carefully toward a relative direction. Maximum 16 metres. You can step down one block; stepping up needs a jump. Navigation approach is a walking distance; navigation jump is a checked jump from here.',movement(16),'walk'),
    action('turn','Turn your body in place by relative degrees. Negative is left and positive is right; this also changes your forward view.',{type:'object',required:['angle'],properties:{angle:{type:'number',description:'Relative degrees from -360 to 360.'}},additionalProperties:false},'turn'),
  ];
  if(!held){
    tools.push(action('run','Run across visible clear terrain. Maximum 24 metres. Running stops before unsafe terrain or collisions.',movement(24),'run'));
    tools.push(action('jump',jumpDescription,jumpParameters,'jump'));
    tools.push(action('hit','Strike a visible block within 3 metres. Use the exact block coordinates in current interactions.hit targets. Every block cracks on the first two hits and breaks on the third. A supporting block under a creature cannot be struck.',target,'hit'));
    tools.push(action('pickup','Pick up a visible loose item within 3 metres. Use a current interactions.pickup itemId; a raw item that has settled into terrain must be hit as a block instead.',{type:'object',required:['itemId'],additionalProperties:false,properties:{itemId:{type:'string'}}},'pickup'));
  }else if(['dirt','grass','sand','stone','wood','leaves','plant'].includes(held.kind)){
    tools.push(action('jump',jumpDescription,jumpParameters,'jump'));
    tools.push(action('place','Place one held block into an empty supported voxel within 3 metres.',target,'place'));
    tools.push(action('throw','Throw one held block. It follows physics and fixes itself into terrain after settling on land.',{type:'object',properties:{force:{type:'number'}},additionalProperties:false},'throw'));
    if(held.kind==='wood')tools.push(action('strike_held','Strike a chosen surface point on the raw held block. Different points may reveal different forms. Impact uses local coordinates from 0 to 1 on each axis; a surface point has at least one coordinate equal to 0 or 1.',{type:'object',required:['impact'],additionalProperties:false,properties:{impact:vector}},'strike_held'));
    tools.push(action('store','Put the held stack into inventory, leaving your hands empty.',noArgs,'store'));
  }else{
    tools.push(action('run','Run across visible clear terrain. Maximum 24 metres.',movement(24),'run'));
    tools.push(action('jump',jumpDescription,jumpParameters,'jump'));
    tools.push(action('place','Set the held finished object down on solid ground within 3 metres. It remains a loose object that can be picked up.',target,'place'));
    tools.push(action('throw','Throw the held finished object.',{type:'object',properties:{force:{type:'number'}},additionalProperties:false},'throw'));
    if(held.kind==='bucket'){
      if(held.contents)tools.push(action('empty','Empty the held bucket at a target within 3 metres. Water disperses; dirt and sand become real blocks.',target,'empty'));
      else tools.push(action('fill','Fill the held bucket from visible water, dirt, or sand within 3 metres. Dirt and sand are removed from the world.',target,'fill'));
    }
    tools.push(action('store','Put the held object into inventory, leaving your hands empty.',noArgs,'store'));
  }
  if(entity.inventory?.stacks.length)tools.push(action('hold','Select an inventory stack to hold. Stack indexes are zero-based in the inventory description.',{type:'object',required:['stack'],additionalProperties:false,properties:{stack:{type:'number'}}},'hold'));
  if(engine.entities.some(other=>engine.canFollow(entity,other,options.viewAngle)))tools.push(tool('follow','Follow a visible living entity within 20 metres through clear space, using its ID from interactions.follow. Walk automatically and stop one metre away. Future turns ask only whether to follow or stop_follow; stopping immediately gives you another action.',{type:'object',required:['entityId'],additionalProperties:false,properties:{entityId:{type:'string'}}},true,({entityId}:{entityId:string})=>engine.act(id,{action:'follow',entityId,angle:options.viewAngle??0})));
  tools.push(action('say','Say one word from your small vocabulary. Every living entity within 10 metres through clear space hears your voice, direction, distance and word, including bystanders and animals.',{type:'object',required:['word'],additionalProperties:false,properties:{word:{type:'string',enum:engine.module.manifest.vocabulary}}},'say'));
  tools.push(action('wait','Deliberately spend this action waiting and watching.',noArgs,'wait'));
  const journal=tool('journal', `Freely write a private note of up to 300 characters about goals, plans, things you want to do, or observations worth remembering. Recent conversations fade, so notes help you resume an intention later. Optional example: "I want to return to the tree and investigate its wood." Writing takes no world time or physical action. Your latest ${PRIVATE_NOTE_LIMIT} notes are included in future decisions and survive server restarts; older notes are forgotten.`, { type: 'object', required: ['note'], additionalProperties: false, properties: { note: { type: 'string' } } },false, ({ note }: { note: string }) => {
      if (!note.trim() || note.length > 300) return { ok: false, message: 'A memory note must contain 1..300 characters.' };
      const value=note.trim();
      if(memory.notes.includes(value))return {ok:true,message:'That note is already in private memory.'};
      const learned=[...(engine.discoveries.get(id)??[])].map(knowledgeDescription);
      if(learned.includes(value))return {ok:true,message:'That fact is already retained as learned knowledge.'};
      memory.notes.push(value); memory.notes.splice(0, Math.max(0, memory.notes.length - PRIVATE_NOTE_LIMIT));
      return { ok: true, message: 'Remembered.' };
    });
  tools.push(journal);
  if(options.reflection)tools.push(tool('reflect','Answer the periodic private reflection. Use remember=false to decline without adding a note, or remember=true with a note of 1..300 characters to save a goal, plan, or intention. This takes no world time.',{type:'object',required:['remember'],additionalProperties:false,properties:{remember:{type:'boolean'},note:{type:'string'}}},false,({remember,note}:{remember:boolean;note?:string})=>{
    if(!remember)return note?.trim()?{ok:false,message:'To save a note, choose remember=true.'}:{ok:true,message:'Reflection complete. You chose not to add a private note.'};
    if(!note)return {ok:false,message:'Provide a note to remember, or choose remember=false.'};
    return journal.invoke({note});
  }));
  return tools;
}
