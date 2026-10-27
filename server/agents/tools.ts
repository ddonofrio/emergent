import { assertSupportedJsonSchema, validateJsonSchemaValue, type JsonSchemaNode } from '../../vendor/deepseek-harness/json-schema';
import type { Engine } from '../../src/core/engine';
import type { Action, Vec3 } from '../../src/core/types';
import { knowledgeDescription } from '../../src/core/knowledge';
import { PRIVATE_NOTE_LIMIT } from '../../src/core/memory';
import { compactView } from './context';

export interface Memory { notes: string[]; }
export interface WorldTool {
  name: string; description: string; parameters: JsonSchemaNode;
  physical: boolean;
  output: { schema: JsonSchemaNode; render(args: unknown, value: unknown): { type: 'text'; text: string }[] };
  execute(args: unknown, exec?: { signal?: AbortSignal }): Promise<unknown>;
  invoke(args: unknown, exec?: { signal?: AbortSignal }): unknown;
}
export const impactPoints:Record<string,Vec3>={top_center:[.5,1,.5],bottom_center:[.5,0,.5],front_center:[.5,.5,1],side_center:[1,.5,.5],front_corner:[0,1,1],front_edge:[0,.5,1]};
export function worldTools(engine: Engine, id: string, memory: Memory, options: {reflection?:boolean;following?:boolean;viewAngle?:number;availableOnly?:boolean} = {}): WorldTool[] {
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
  const object=(properties:Record<string,JsonSchemaNode>={},required:string[]=[]):JsonSchemaNode=>({type:'object',properties,required,additionalProperties:false});
  const noArgs=object(),vector:JsonSchemaNode={type:'array',items:{type:'integer'},description:'Block coordinates [x,y,z].'};
  const target=object({target:vector},['target']);
  const availableOnly=options.availableOnly!==false;
  const choice=(values:(string|number)[],type:'string'|'integer'='string'):JsonSchemaNode=>({type,...(availableOnly?{enum:values}:{})});
  const remember=(note:string)=>{
    if(!note.trim()||note.length>300)return {ok:false,message:'Write 1..300 characters.'};
    const value=note.trim();
    if(memory.notes.includes(value))return {ok:true,message:'Already remembered.'};
    if([...(engine.discoveries.get(id)??[])].map(knowledgeDescription).includes(value))return {ok:true,message:'Already learned.'};
    memory.notes.push(value);memory.notes.splice(0,Math.max(0,memory.notes.length-PRIVATE_NOTE_LIMIT));
    return {ok:true,message:'Remembered.'};
  };
  if(options.reflection)return [tool('reflect','Save a private note, or choose remember=false.',object({remember:{type:'boolean'},note:{type:'string',description:'Optional note, 1..300 characters.'}},['remember']),false,({remember:save,note}:{remember:boolean;note?:string})=>save?note?remember(note):{ok:false,message:'Provide a note.'}:note?.trim()?{ok:false,message:'Choose remember=true to save the note.'}:{ok:true,message:'No note added.'})];
  const entity=engine.entity(id),held=engine.held(entity);
  if(options.following??!!entity.following)return [
    action('follow','Keep following, stopping one metre away.',noArgs,'follow'),
    tool('stop_follow','Stop following and choose another action immediately.',noArgs,false,()=>({ok:true,message:'Choose another action now.'})),
  ];
  const view=availableOnly?engine.observeAt(id,options.viewAngle??0):undefined;
  const targets=view?.interactions;
  const movement=(maximum:number)=>object({distance:{type:'number',description:`Metres: greater than 0, at most ${maximum}.`},angle:{type:'number',description:'Body-relative degrees (-180..180); negative left, positive right.'}},['distance']);
  const tools:WorldTool[]=[
    tool('look','Look without turning your body or spending time.',object({angle:{type:'number',description:'Body-relative viewing angle (-180..180 degrees).'}}),false,({angle=0}:{angle?:number})=>compactView(engine.observeAt(id,Math.max(-180,Math.min(180,angle))))),
    action('walk','Walk; stop before obstacles or unsafe terrain.',movement(16),'walk'),
    action('turn','Turn your body and forward view.',object({angle:{type:'number',description:'Degrees (-360..360); negative left, positive right.'}},['angle']),'turn'),
  ];
  const raw=held&&['dirt','grass','sand','stone','wood','leaves','plant'].includes(held.kind);
  if(!raw)tools.push(action('run','Run across clear terrain.',movement(24),'run'));
  tools.push(action('jump','Jump up one block or across a gap; unsafe landings are refused.',object({distance:{type:'number',description:'Metres from here: 0.75..2.5, default 2; use the checked jump when given.'},angle:{type:'number',description:'Body-relative degrees (-90..90).'}}),'jump'));
  if(!held){
    if(!availableOnly||targets!.hit.length)tools.push(action('hit','Strike a reachable block at target coordinates.',target,'hit'));
    if(!availableOnly||targets!.pickup.length)tools.push(action('pickup','Take a reachable loose item.',object({itemId:choice(targets?.pickup.map(item=>item.itemId)??[])},['itemId']),'pickup'));
  }else{
    if(!availableOnly||targets!.place.length)tools.push(action('place','Set one held item at an empty supported cell.',target,'place'));
    tools.push(action('throw','Throw one held item forward.',object({force:{type:'number',description:'Strength 1..12, default 7.'}}),'throw'));
    if(held.kind==='wood')tools.push(tool('strike_held','Strike a surface point on the wood in your hands.',object({point:{type:'string',enum:Object.keys(impactPoints)}},['point']),true,({point}:{point:string})=>engine.act(id,{action:'strike_held',impact:impactPoints[point]})));
    if(held.kind==='bucket'){
      if(held.contents){if(!availableOnly||targets!.empty.length)tools.push(action('empty','Empty the bucket at target coordinates.',target,'empty'));}
      else if(!availableOnly||targets!.fill.length)tools.push(action('fill','Fill the bucket from reachable water, dirt, or sand.',target,'fill'));
    }
    tools.push(action('store','Free your hands; inventory space stays unchanged.',noArgs,'store'));
  }
  const stacks=entity.inventory?.stacks.flatMap((_,index)=>index!==entity.inventory!.selected?[index]:[])??[];
  if(stacks.length||(!availableOnly&&entity.inventory?.stacks.length))tools.push(action('hold','Take an inventory stack into your hands.',object({stack:choice(stacks,'integer')},['stack']),'hold'));
  if(!availableOnly||targets!.follow.length)tools.push(tool('follow','Follow a visible creature within 20 metres; stop one metre away.',object({entityId:choice(targets?.follow.map(other=>other.id)??[])},['entityId']),true,({entityId}:{entityId:string})=>engine.act(id,{action:'follow',entityId,angle:options.viewAngle??0})));
  if(!availableOnly||targets!.speak.length)tools.push(action('say','Speak one word to everyone within clear hearing range (10 metres).',object({word:{type:'string',enum:engine.module.manifest.vocabulary}},['word']),'say'));
  tools.push(action('wait','Wait and watch.',noArgs,'wait'));
  tools.push(tool('journal',`Freely save a private note (1..300 characters); keep the latest ${PRIVATE_NOTE_LIMIT}. Takes no time.`,object({note:{type:'string'}},['note']),false,({note}:{note:string})=>remember(note)));
  if(targets?.hit.some(block=>block.cracks>0)){
    const index=tools.findIndex(tool=>tool.name==='hit');
    if(index>=0)tools.unshift(...tools.splice(index,1));
  }
  return tools;
}
