import { assertSupportedJsonSchema, validateJsonSchemaValue, type JsonSchemaNode } from '../../vendor/deepseek-harness/json-schema';
import type { Engine } from '../../src/core/engine';
import type { Action, ActionResult, MilestoneCriterion } from '../../src/core/types';
import { knowledgeDescription } from '../../src/core/knowledge';
import { PRIVATE_NOTE_LIMIT, SHORT_TEXT_LIMIT } from '../../src/core/memory';
import { speechProblem } from '../../src/core/speech';
import { compactResult, compactView, decisionView } from './context';
import { impactPoints } from '../../src/core/impact-points';
import { validCompactedNotes } from './journal-compaction';
import { journalEntries, setJournalNotes, type Memory } from './journal';
export type { Memory } from './journal';
export { impactPoints } from '../../src/core/impact-points';

export interface WorldTool {
  name: string; description: string; parameters: JsonSchemaNode;
  physical: boolean;
  validate?(args: unknown): string | undefined;
  output: { schema: JsonSchemaNode; render(args: unknown, value: unknown): { type: 'text'; text: string }[] };
  execute(args: unknown, exec?: { signal?: AbortSignal }): Promise<unknown>;
  invoke(args: unknown, exec?: { signal?: AbortSignal }): unknown;
}
export function worldTools(engine: Engine, id: string, memory: Memory, options: {following?:boolean;viewAngle?:number;availableOnly?:boolean;concise?:boolean;previewHand?:number|null;goalCriterion?:MilestoneCriterion;compactJournal?:(notes:readonly string[],incoming:string)=>Promise<string[]>;onJournalEntry?:(note:string)=>void;onFinishGoal?:(outcome:'completed'|'abandoned'|'blocked',reason:string,evidenceEventIds?:number[])=>unknown} = {}): WorldTool[] {
  const tool = (name: string, description: string, parameters: JsonSchemaNode, physical: boolean, run: (args: any) => unknown): WorldTool => {
    assertSupportedJsonSchema(parameters);
    return { name, description, parameters, physical, output: { schema: {}, render: (_args, value) => {
      const result=value as ActionResult;
      const concise=['find_material','find_entity'].includes(name)&&result?.feedback?.unchanged===true;
      return [{type:'text',text:JSON.stringify(concise?compactResult(result,true):value)}];
    } },
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
  const noArgs=object();
  const availableOnly=options.availableOnly!==false;
  const choice=(values:(string|number)[],type:'string'|'integer'='string'):JsonSchemaNode=>({type,...(availableOnly&&values.length?{enum:values}:{})});
  const shortSentence:JsonSchemaNode={type:'string',minLength:1,maxLength:SHORT_TEXT_LIMIT,description:'Write one short sentence, at most 500 characters.'};
  const remember=async(note:string,replaceNoteIds:string[]=[] )=>{
    if(!note.trim()||[...note].length>SHORT_TEXT_LIMIT)return {ok:false,message:'Write one short sentence of 1..500 characters.'};
    const value=note.trim();
    const entries=journalEntries(memory);
    if(replaceNoteIds.some(id=>!entries.some(entry=>entry.id===id)))return {ok:false,message:'Use existing note IDs from notes, not array indices.',notes:entries};
    if(replaceNoteIds.length){
      const retained=entries.filter(entry=>!replaceNoteIds.includes(entry.id)).map(entry=>entry.text);
      const notes=setJournalNotes(memory,retained.includes(value)?retained:[...retained,value]);options.onJournalEntry?.(value);
      return {ok:true,message:'Replaced the specified claims. Other notes retain their IDs.',replacedNoteIds:replaceNoteIds,notes};
    }
    if([...(engine.discoveries.get(id)??[])].map(knowledgeDescription).includes(value))return {ok:true,message:'Already learned.'};
    if(memory.notes.includes(value))return {ok:true,message:'Already remembered.'};
    let retained=memory.notes;
    if(retained.length>=PRIVATE_NOTE_LIMIT){
      if(!options.compactJournal)return {ok:false,message:'Journal compaction is unavailable; all existing notes were retained.'};
      retained=await options.compactJournal([...retained],value);
      if(!validCompactedNotes(retained)||retained.some(note=>note.trim()===value))return {ok:false,message:'Invalid journal compaction; all existing notes were retained.'};
      retained=retained.map(note=>note.trim());
    }
    const notes=setJournalNotes(memory,[...retained,value]);options.onJournalEntry?.(value);
    return {ok:true,message:'Saved for your future self. These are your current journal notes.',notes};
  };
  const entity=engine.entity(id),held=options.previewHand===undefined?engine.held(entity):options.previewHand===null?undefined:entity.inventory?.stacks[options.previewHand];
  const say=action('say',`Say any phrase of one to three words this turn. Only creatures within clear hearing range (${engine.module.manifest.perception.range} metres, the same range as perception) hear it. If nobody hears you, the result says so. Speaking while following keeps you following.`,object({word:{type:'string',description:'One to three words of your choice, with optional punctuation.'}},['word']),'say');
  say.validate=args=>speechProblem((args as {word?:unknown}).word);
  if(options.following??!!entity.following)return [
    action('follow','Keep following, stopping one metre away.',noArgs,'follow'),
    tool('stop_follow','Stop following and choose another action immediately.',noArgs,false,()=>({ok:true,message:'Choose another action now.'})),
    say,
  ];
  const view=availableOnly?engine.observeAt(id,options.viewAngle??0):undefined;
  const targets=view?.interactions;
  const target=(values:readonly number[][]=[],details:readonly string[]=[])=>object({target:{type:'array',items:{type:'integer'},description:values.length?`Use one currently reachable [x,y,z] target: ${details.length?details.join('; '):values.map(value=>`[${value.join(',')}]`).join('; ')}.`:'Block coordinates [x,y,z].',...(values.length?{examples:values.map(value=>[...value])}:{})}},['target']);
  const doorTarget=(values:{itemId:string;metres:number;outsideYaw:number}[])=>object({itemId:{...choice(values.map(value=>value.itemId)),description:values.length?`Current reachable doors: ${values.map(value=>`${value.itemId}, ${value.metres} m away, outside yaw ${value.outsideYaw}, inside yaw ${(value.outsideYaw+180)%360}, left hinge viewed from outside, opens inward`).join('; ')}.`:'Installed door item ID.'}},['itemId']);
  const hitTargets=targets?.hit.map(block=>block.target)??[];
  const hitDetails=targets?.hit.map(block=>`${block.kind} at [${block.target.join(',')}]${block.cracks?` (${block.cracks} cracks)`:''}`)??[];
  const movement=(maximum:number)=>object({distance:{type:'number',description:`Metres: greater than 0, at most ${maximum}.`},angle:{type:'number',description:'Body-relative degrees (-180..180); negative left, positive right.'}},['distance']);
  const walkMovement=object({distance:{type:'number',description:'Relative travel distance in metres: greater than 0, at most 32. Use with optional angle, or omit when using target.'},angle:{type:'number',description:'Body-relative degrees (-180..180); negative left, positive right. Use only with distance.'},target:{type:'array',items:{type:'number'},description:'Absolute observed position [x,y,z], using the same axes as observations: y is height, x and z are horizontal. Walk toward x,z; actual foot height follows terrain, so arrival does not guarantee reaching the requested height.'}});
  const tools:WorldTool[]=[
    tool('look','Look without turning your body or spending time.',object({angle:{type:'number',description:'Body-relative viewing angle (-180..180 degrees).'}}),false,({angle=0}:{angle?:number})=>(options.concise?decisionView:compactView)(engine.observeAt(id,Math.max(-180,Math.min(180,angle))),options.goalCriterion)),
    action('find_material','Scan 360 degrees for visible materials. Returns the nearest block target, distance to its centre and body-relative angle per material; one world second.',noArgs,'find_material'),
    action('find_entity','Scan 360 degrees for visible living beings within 18 metres. Returns each ID, name, kind, distance and body-relative angle; one world second.',noArgs,'find_entity'),
    action('walk','Walk using either distance and angle or target [x,y,z]. Y is always height. Walking follows terrain toward target x,z and stops before obstacles or unsafe terrain; it does not climb to target y automatically.',walkMovement,'walk'),
    action('turn','Turn your body and forward view.',object({angle:{type:'number',description:'Degrees (-360..360); negative left, positive right.'}},['angle']),'turn'),
  ];
  if(options.onFinishGoal)tools.push(tool('finish_goal','Return this task to your planner. completed: observed results satisfy its condition; cite availableEvidence. blocked: the required test or action is unavailable, or your method needs reconsideration. abandoned: you no longer want this task. A task ending does not complete its parent project. Call alone before acting.',object({outcome:{type:'string',enum:['completed','abandoned','blocked']},reason:shortSentence,evidenceEventIds:{type:'array',items:{type:'integer'},description:'For completed, cite 1..10 recorded event IDs from plan.availableEvidence.'}},['outcome','reason']),false,({outcome,reason,evidenceEventIds})=>{
    if(!reason.trim())return {ok:false,message:'Give a reason in one short sentence of 1..500 characters.'};
    return options.onFinishGoal!(outcome,reason.trim(),evidenceEventIds);
  }));
  const raw=held&&['dirt','grass','sand','stone','wood','leaves'].includes(held.kind);
  if(raw)tools.push(tool('run',`Disabled while you hold ${held!.kind}; store, place, or throw it before running.`,movement(24),false,()=>({ok:false,message:`Run is unavailable while you hold ${held!.kind}. Store, place, or throw it first.`})));
  else tools.push(action('run','Run across clear terrain at twice the speed of walking.',movement(24),'run'));
  tools.push(action('jump','Jump up one block or across a gap; unsafe landings are refused.',object({distance:{type:'number',description:'Metres from here: 0.75..2.5, default 2; use the checked jump when given.'},angle:{type:'number',description:'Body-relative degrees (-90..90).'}}),'jump'));
  const openDoors=targets?.open??[],closeDoors=targets?.close??[];
  if(!availableOnly||openDoors.length)tools.push(action('open',`Open one reachable closed door inward by exactly 90 degrees.${availableOnly&&!openDoors.length?' No closed door is currently within reach.':''}`,doorTarget(openDoors),'open'));
  if(!availableOnly||closeDoors.length)tools.push(action('close',`Close one reachable open door to 0 degrees.${availableOnly&&!closeDoors.length?' No open door is currently within reach.':''}`,doorTarget(closeDoors),'close'));
  if(!held){
    tools.push(action('hit',`Strike one currently reachable block using its exact target coordinates.${availableOnly&&!hitTargets.length?' No reachable block is visible now; inspect another direction or approach one.':''}`,target(hitTargets,hitDetails),'hit'));
    {
      const items=targets?.pickup??[];
      const details=items.map(item=>{const body=view?.items.find(candidate=>candidate.id===item.itemId);return `${item.itemId}: ${item.kind}${body?` at [${body.position.map(value=>Math.round(value*100)/100).join(',')}]`:''}, ${item.metres} m away`;});
      tools.push(action('pickup',`Take one currently reachable loose item using its exact ID.${availableOnly&&!items.length?' No usable pickup target now; approach a visible loose item with free hands and enough inventory space.':''}`,object({itemId:{...choice(items.map(item=>item.itemId)),description:details.length?`Current reachable items: ${details.join('; ')}.`:'Loose item ID.'}},['itemId']),'pickup'));
    }
  }else{
    const heldLabel=`${held.kind}${held.contents?` containing ${held.contents}`:''}`;
    const hitMessage=held.kind==='shovel'
      ?'Hit is unavailable while you hold the shovel. Use dig for reachable sand, dirt, or grass; store the shovel before striking other blocks.'
      :`Hit is unavailable while you hold ${heldLabel}. Store, place, or throw it before striking a world block.`;
    tools.push(tool('hit',`Disabled while you hold ${heldLabel}. ${hitMessage}`,target(hitTargets,hitDetails),false,()=>({ok:false,message:hitMessage})));
    const pickupMessage=`Pickup is unavailable while you hold ${heldLabel}. Store, place, or throw it to free your hands first.`;
    tools.push(tool('pickup',`Disabled while you hold ${heldLabel}. ${pickupMessage}`,object({itemId:{type:'string',description:'Loose item ID; unavailable until your hands are free.'}},['itemId']),false,()=>({ok:false,message:pickupMessage})));
    tools.push(action('place','Set one held item at one currently reachable empty supported cell; if none is in reach, inspect another direction or move.',target(targets?.place),'place'));
    tools.push(action('throw','Throw one held item forward.',object({force:{type:'number',description:'Strength 1..12, default 7.'}}),'throw'));
    if(held.kind==='wood'){
      const strike=tool('strike_held','Strike a surface point on the wood in your hands.',object({point:{type:'string',enum:Object.keys(impactPoints)},orientation:{type:'string',enum:['up','down'],description:'Required for front_edge; otherwise unused.'}},['point']),true,({point,orientation}:{point:string;orientation?:'up'|'down'})=>engine.act(id,{action:'strike_held',impact:impactPoints[point],...(orientation?{orientation}:{})}));
      strike.validate=args=>{const {point,orientation}=args as {point:string;orientation?:string};return point==='front_edge'&&!orientation?'For front_edge, choose orientation up or down.':undefined;};
      tools.push(strike);
    }
    if(held.kind==='bucket'){
      if(held.contents){tools.push(action('empty','Empty one held bucket at one currently reachable target; hold the empty bucket. Matching contents stack together. If no target is available, inspect another direction or move.',target(targets?.empty),'empty'));}
      else tools.push(action('fill','Fill one held bucket from a currently reachable source. If no fill target is available, inspect another direction or move.',target(targets?.fill),'fill'));
    }
    tools.push(action('store','Free your hands. Item quantities stay unchanged; this does not collect anything.',noArgs,'store'));
  }
  if(held?.kind==='shovel')tools.push(action('dig','Dig one currently reachable block with the shovel. If no target is available, inspect another direction or move.',target(hitTargets,hitDetails),'dig'));
  if(entity.inventory?.stacks.some(stack=>stack.kind==='door_half_up'&&stack.count>0)&&entity.inventory.stacks.some(stack=>stack.kind==='door_half_down'&&stack.count>0))
    tools.push(action('join','Join one upper and one lower wooden half and observe the result.',noArgs,'join'));
  const stacks=entity.inventory?.stacks.flatMap((_,index)=>index!==entity.inventory!.selected?[index]:[])??[];
  if(stacks.length||(!availableOnly&&entity.inventory?.stacks.length)){
    const details=stacks.map(index=>{const stack=entity.inventory!.stacks[index];return `${index}: ${stack.kind}${stack.contents?` containing ${stack.contents}`:''} (${stack.count})`;});
    tools.push(action('hold','Take one already owned inventory stack into your hands. This does not collect anything.',object({stack:{...choice(stacks,'integer'),description:details.length?`Available inventory stacks: ${details.join('; ')}.`:'Inventory stack index.'}},['stack']),'hold'));
  }
  if(!engine.followersOf(entity).length){
    const followers=targets?.follow??[],details=followers.map(other=>`${other.id}: ${other.name}, ${other.metres} m away`);
    tools.push(tool('follow',`Start following one currently visible creature within 20 metres and stay one metre away. You can speak while following; stop_follow lets you choose other actions.${availableOnly&&!followers.length?' No eligible creature is visible now; look around or approach a known sighting.':''}`,object({entityId:{...choice(followers.map(other=>other.id)),description:details.length?`Current visible creatures: ${details.join('; ')}.`:'Creature ID.'}},['entityId']),true,({entityId}:{entityId:string})=>engine.act(id,{action:'follow',entityId,angle:options.viewAngle??0})));
  }
  tools.push(say);
  tools.push(action('wait','Wait and watch.',noArgs,'wait'));
  tools.push(tool('journal',`Preserve an important insight, uncertainty, commitment, useful location or unfinished work for your future self in one short sentence (at most 500 characters). Your actions and discoveries are recorded automatically; your personal interpretation is not. Include the conditions of a memorable fact learned about the world. Label hypotheses and never generalize one unsuccessful test to every possible method. Use replaceNoteIds to name every old claim this note corrects, contradicts or supersedes. IDs are stable, not array indices; keep unrelated notes. Omit replaceNoteIds to append new information. ${PRIVATE_NOTE_LIMIT} notes; faithful compaction when full; no world time.`,object({note:shortSentence,replaceNoteIds:{type:'array',items:{type:'string'},description:'Optional stable IDs from notes for the specific claims this note corrects or supersedes. Never remove unrelated notes.'}},['note']),false,({note,replaceNoteIds}:{note:string;replaceNoteIds?:string[]})=>remember(note,replaceNoteIds)));
  for(const movement of tools.filter(tool=>tool.physical&&['walk','run','jump','turn'].includes(tool.name))){
    movement.validate=(args:unknown)=>{
      const {distance,angle,target} = args as {distance?:number;angle?:number;target?:number[]};
      if(movement.name==='walk'&&target!==undefined){
        if(distance!==undefined||angle!==undefined)return 'Walk accepts either distance with an optional relative angle, or target [x,y,z], not both forms.';
        if(target.length!==3||!target.every(Number.isFinite))return 'Target must contain exactly three finite coordinates [x,y,z]; y is height.';
        return undefined;
      }
      const limit=movement.name==='jump'?90:movement.name==='turn'?360:180;
      if(angle!==undefined&&(!Number.isFinite(angle)||Math.abs(angle)>limit))return `Angle must be between -${limit} and ${limit} degrees.${movement.name==='jump'?' Turn first to face a target behind you, then use a checked jump.':''}`;
      if(movement.name==='turn')return undefined;
      const metres=distance??(movement.name==='jump'?2:NaN),maximum=movement.name==='jump'?2.5:movement.name==='run'?24:32;
      if(!Number.isFinite(metres)||metres>maximum||(movement.name==='jump'?metres<.75:metres<=0))return movement.name==='jump'?'Jump distance must be between 0.75 and 2.5 metres.':`Distance must be greater than zero and at most ${maximum} metres.`;
      return undefined;
    };
  }
  return tools;
}
