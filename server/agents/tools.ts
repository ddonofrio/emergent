import { assertSupportedJsonSchema, validateJsonSchemaValue, type JsonSchemaNode } from '../../vendor/deepseek-harness/json-schema';
import type { Engine } from '../../src/core/engine';
import type { Action } from '../../src/core/types';
import { knowledgeDescription } from '../../src/core/knowledge';
import { PRIVATE_NOTE_LIMIT } from '../../src/core/memory';
import { compactView } from './context';
import { impactPoints } from '../../src/core/impact-points';
import { validCompactedNotes } from './journal-compaction';
export { impactPoints } from '../../src/core/impact-points';

export interface Memory { notes: string[]; }
export interface WorldTool {
  name: string; description: string; parameters: JsonSchemaNode;
  physical: boolean;
  validate?(args: unknown): string | undefined;
  output: { schema: JsonSchemaNode; render(args: unknown, value: unknown): { type: 'text'; text: string }[] };
  execute(args: unknown, exec?: { signal?: AbortSignal }): Promise<unknown>;
  invoke(args: unknown, exec?: { signal?: AbortSignal }): unknown;
}
export function worldTools(engine: Engine, id: string, memory: Memory, options: {following?:boolean;viewAngle?:number;availableOnly?:boolean;speechMenu?:boolean;compactJournal?:(notes:readonly string[],incoming:string)=>Promise<string[]>;onJournalEntry?:(note:string)=>void} = {}): WorldTool[] {
  const tool = (name: string, description: string, parameters: JsonSchemaNode, physical: boolean, run: (args: any) => unknown): WorldTool => {
    assertSupportedJsonSchema(parameters);
    return { name, description, parameters, physical, output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args, exec) { return this.invoke(args, exec); },
      invoke(args, exec) {
        exec?.signal?.throwIfAborted();
        const errors = validateJsonSchemaValue(parameters, args);
        if (errors.length) return { ok: false, message: errors.join('; ') };
        const problem=this.validate?.(args);if(problem)return {ok:false,message:problem};
        return run(args);
      } };
  };
  const action = (name:string,description:string,parameters:JsonSchemaNode,actionName:Action['action']) => tool(name,description,parameters,true,(args:Action)=>engine.act(id,{...args,action:actionName}));
  const object=(properties:Record<string,JsonSchemaNode>={},required:string[]=[]):JsonSchemaNode=>({type:'object',properties,required,additionalProperties:false});
  const noArgs=object(),vector:JsonSchemaNode={type:'array',items:{type:'integer'},description:'Block coordinates [x,y,z].'};
  const target=object({target:vector},['target']);
  const availableOnly=options.availableOnly!==false;
  const choice=(values:(string|number)[],type:'string'|'integer'='string'):JsonSchemaNode=>({type,...(availableOnly?{enum:values}:{})});
  const remember=async(note:string)=>{
    if(!note.trim()||note.length>300)return {ok:false,message:'Write 1..300 characters.'};
    const value=note.trim();
    if(memory.notes.includes(value))return {ok:true,message:'Already remembered.'};
    if([...(engine.discoveries.get(id)??[])].map(knowledgeDescription).includes(value))return {ok:true,message:'Already learned.'};
    let retained=memory.notes;
    if(retained.length>=PRIVATE_NOTE_LIMIT){
      if(!options.compactJournal)return {ok:false,message:'Journal compaction is unavailable; all existing notes were retained.'};
      retained=await options.compactJournal([...retained],value);
      if(!validCompactedNotes(retained)||retained.some(note=>note.trim()===value))return {ok:false,message:'Invalid journal compaction; all existing notes were retained.'};
      retained=retained.map(note=>note.trim());
    }
    memory.notes=[...retained,value];options.onJournalEntry?.(value);
    return {ok:true,message:'Saved for your future self. These are your current journal notes.',notes:memory.notes};
  };
  const entity=engine.entity(id),held=engine.held(entity);
  if(options.following??!!entity.following)return [
    action('follow','Keep following, stopping one metre away.',noArgs,'follow'),
    tool('stop_follow','Stop following and choose another action immediately.',noArgs,false,()=>({ok:true,message:'Choose another action now.'})),
  ];
  const view=availableOnly?engine.observeAt(id,options.viewAngle??0):undefined;
  const targets=view?.interactions;
  if(options.speechMenu)return [
    action('say','Communicate one selected idea to everyone within clear hearing range (10 metres).',object({word:{type:'string',enum:engine.module.manifest.vocabulary}},['word']),'say'),
    tool('do_not_reply','Choose not to reply. Close the communication menu without speaking or spending world time.',noArgs,false,()=>({ok:true,message:'You chose not to reply. Choose another action.'})),
  ];
  const movement=(maximum:number)=>object({distance:{type:'number',description:`Metres: greater than 0, at most ${maximum}.`},angle:{type:'number',description:'Body-relative degrees (-180..180); negative left, positive right.'}},['distance']);
  const tools:WorldTool[]=[
    tool('look','Look without turning your body or spending time.',object({angle:{type:'number',description:'Body-relative viewing angle (-180..180 degrees).'}}),false,({angle=0}:{angle?:number})=>compactView(engine.observeAt(id,Math.max(-180,Math.min(180,angle))))),
    action('walk','Walk; stop before obstacles or unsafe terrain.',movement(32),'walk'),
    action('turn','Turn your body and forward view.',object({angle:{type:'number',description:'Degrees (-360..360); negative left, positive right.'}},['angle']),'turn'),
  ];
  const raw=held&&['dirt','grass','sand','stone','wood','leaves','plant'].includes(held.kind);
  if(raw)tools.push(tool('run',`Disabled while you hold ${held!.kind}; store, place, or throw it before running.`,movement(24),false,()=>({ok:false,message:`Run is unavailable while you hold ${held!.kind}. Store, place, or throw it first.`})));
  else tools.push(action('run','Run across clear terrain at twice the speed of walking.',movement(24),'run'));
  tools.push(action('jump','Jump up one block or across a gap; unsafe landings are refused.',object({distance:{type:'number',description:'Metres from here: 0.75..2.5, default 2; use the checked jump when given.'},angle:{type:'number',description:'Body-relative degrees (-90..90).'}}),'jump'));
  if(!held){
    if(!availableOnly||targets!.hit.length)tools.push(action('hit','Strike a reachable block at target coordinates.',target,'hit'));
    if(!availableOnly||targets!.pickup.length)tools.push(action('pickup','Take a reachable loose item.',object({itemId:choice(targets?.pickup.map(item=>item.itemId)??[])},['itemId']),'pickup'));
  }else{
    const heldLabel=`${held.kind}${held.contents?` containing ${held.contents}`:''}`;
    const hitMessage=held.kind==='shovel'
      ?'Hit is unavailable while you hold the shovel. Use dig for reachable sand, dirt, or grass; store the shovel before striking other blocks.'
      :`Hit is unavailable while you hold ${heldLabel}. Store, place, or throw it before striking a world block.`;
    tools.push(tool('hit',`Disabled while you hold ${heldLabel}. ${hitMessage}`,target,false,()=>({ok:false,message:hitMessage})));
    const pickupMessage=`Pickup is unavailable while you hold ${heldLabel}. Store, place, or throw it to free your hands first.`;
    tools.push(tool('pickup',`Disabled while you hold ${heldLabel}. ${pickupMessage}`,object({itemId:{type:'string',description:'Loose item ID; unavailable until your hands are free.'}},['itemId']),false,()=>({ok:false,message:pickupMessage})));
    if(!availableOnly||targets!.place.length)tools.push(action('place','Set one held item at an empty supported cell.',target,'place'));
    tools.push(action('throw','Throw one held item forward.',object({force:{type:'number',description:'Strength 1..12, default 7.'}}),'throw'));
    if(held.kind==='wood'){
      const strike=tool('strike_held','Strike a surface point on the wood in your hands.',object({point:{type:'string',enum:Object.keys(impactPoints)},orientation:{type:'string',enum:['up','down'],description:'Required for front_edge; otherwise unused.'}},['point']),true,({point,orientation}:{point:string;orientation?:'up'|'down'})=>engine.act(id,{action:'strike_held',impact:impactPoints[point],...(orientation?{orientation}:{})}));
      strike.validate=args=>{const {point,orientation}=args as {point:string;orientation?:string};return point==='front_edge'&&!orientation?'For front_edge, choose orientation up or down.':undefined;};
      tools.push(strike);
    }
    if(held.kind==='bucket'){
      if(held.contents){if(!availableOnly||targets!.empty.length)tools.push(action('empty','Empty one held bucket at target coordinates; hold the empty bucket. Matching contents stack together.',target,'empty'));}
      else if(!availableOnly||targets!.fill.length)tools.push(action('fill','Fill one held bucket from reachable water, dirt, or sand; hold the filled bucket. Matching contents stack together.',target,'fill'));
    }
    tools.push(action('store','Free your hands; inventory space stays unchanged.',noArgs,'store'));
  }
  if(held?.kind==='shovel'&&(!availableOnly||targets!.hit.length))tools.push(action('dig','Remove reachable sand, dirt, or grass with one shovel strike; keep holding the shovel.',target,'dig'));
  if(entity.inventory?.stacks.some(stack=>stack.kind==='door_half_up'&&stack.count>0)&&entity.inventory.stacks.some(stack=>stack.kind==='door_half_down'&&stack.count>0))
    tools.push(action('join','Join one upper and one lower wooden half into a rustic door.',noArgs,'join'));
  const stacks=entity.inventory?.stacks.flatMap((_,index)=>index!==entity.inventory!.selected?[index]:[])??[];
  if(stacks.length||(!availableOnly&&entity.inventory?.stacks.length))tools.push(action('hold','Take an inventory stack into your hands.',object({stack:choice(stacks,'integer')},['stack']),'hold'));
  if(!availableOnly||targets!.follow.length)tools.push(tool('follow','Follow a visible creature within 20 metres; stop one metre away.',object({entityId:choice(targets?.follow.map(other=>other.id)??[])},['entityId']),true,({entityId}:{entityId:string})=>engine.act(id,{action:'follow',entityId,angle:options.viewAngle??0})));
  if(!availableOnly||targets!.speak.length)tools.push(tool('say','Open your available communication ideas. This takes no world time.',noArgs,false,()=>({ok:true,message:'Choose one idea to communicate, or use do_not_reply if you do not want to answer.',options:engine.module.manifest.vocabulary})));
  tools.push(action('wait','Wait and watch.',noArgs,'wait'));
  tools.push(tool('journal',`Leave your future self a meaningful goal or unfinished task and where to resume. Add updates when progress, blockers, or goals change; mark goals completed or abandoned. Skip immediate steps, repetition, and learned facts. ${PRIVATE_NOTE_LIMIT} notes, automatically condensed when full; takes no world time.`,object({note:{type:'string',description:'1..300 characters. Example: Shelter goal: gathered wood by the shore; next return there to build.'}},['note']),false,({note}:{note:string})=>remember(note)));
  if(targets?.hit.some(block=>block.cracks>0)){
    const index=tools.findIndex(tool=>tool.name==='hit');
    if(index>=0&&tools[index].physical)tools.unshift(...tools.splice(index,1));
  }
  return tools;
}
