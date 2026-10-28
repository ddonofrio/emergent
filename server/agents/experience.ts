import type { AgentPlan, ActionResult, Entity, Vec3, WorldEvent } from '../../src/core/types';
import type { Store } from '../store';
import { compactResult, rounded } from './context';
import { impactPointName } from '../../src/core/impact-points';
import { TICKS_PER_SECOND } from '../../src/core/time';

interface Experiment {
  action: string; subject?: string; parameters: Record<string, unknown>;
  result: ReturnType<typeof compactResult>; attempts: number;
  firstEventId: number; lastEventId: number; firstAtSecond: number; lastAtSecond: number;
}
interface Place { region: Vec3; visits: number; emptyCreatureScans: number; lastAtSecond: number; lastEventId: number }
const experimentalActions = new Set(['hit','dig','strike_held','join','place','fill','empty','throw','pickup']);
const trim = <T>(map:Map<string,T>,limit:number) => { while(map.size>limit)map.delete(map.keys().next().value!); };
const remember = <T>(map:Map<string,T>,key:string,value:T,limit:number) => { map.delete(key);map.set(key,value);trim(map,limit); };

/** Bounded, rebuildable memory of one actor's own recorded experiences. No model or world reads. */
export class ExperienceMemory {
  private cursor=0;
  private untilTick=-1;
  private self?: Entity;
  private totalActions=0;
  private materials=new Map<string,{firstEventId:number;lastEventId:number;lastSeen:Vec3;lastAtSecond:number}>();
  private creatures=new Map<string,{name:string;kind:string;lastSeen?:Vec3;detectedFrom?:Vec3;lastAtSecond:number;eventId:number}>();
  private experiments=new Map<string,Experiment>();
  private discoveries=new Map<string,{eventId:number;atSecond:number;message:string;observed:unknown}>();
  private places=new Map<string,Place>();
  private tasks=new Map<string,{eventId:number;atSecond:number;plan:AgentPlan}>();
  private speech=new Map<string,{from:string;word:string;atSecond:number}>();
  constructor(private readonly store:Store,private readonly actor:string) {}

  experimentActions() {
    return [...this.experiments.values()].map(item=>({eventId:item.lastEventId,atSecond:item.lastAtSecond,action:item.action,args:item.parameters,result:item.result}));
  }

  read(tick:number,project?:AgentPlan) {
    if(tick<this.untilTick)throw new Error('Agent experience cannot be read ahead of its observation boundary.');
    while(true){
      const events=this.store.experienceEvents(tick,this.actor,this.cursor);
      for(const event of events){this.accept(event);this.cursor=event.id;}
      if(events.length<500)break;
    }
    this.untilTick=tick;
    const words=new Set(`${project?.direction??''} ${project?.project?.goal??''} ${project?.goal??''}`.toLowerCase().match(/[a-z]{4,}/g)??[]);
    const relevance=(experiment:Experiment)=>[...words].filter(word=>`${experiment.subject??''} ${experiment.action} ${experiment.result.message}`.toLowerCase().includes(word)).length;
    const experiments=[...this.experiments.values()].sort((a,b)=>relevance(b)-relevance(a)||b.lastEventId-a.lastEventId).slice(0,48).sort((a,b)=>a.lastEventId-b.lastEventId);
    return rounded({
      source:'Your own recorded observations and action results. Historical locations are last sightings, not current bearings. Missing experiments are untested, not impossible.',
      totalActions:this.totalActions,
      observedMaterials:[...this.materials].map(([material,fact])=>({material,...fact})),
      knownCreatures:[...this.creatures].map(([id,fact])=>({id,...fact})),
      discoveries:[...this.discoveries.values()],
      experiments,
      experimentCoverage:{retained:this.experiments.size,shown:experiments.length,note:'Distinct attempts are grouped by action, input conditions and result. These records do not establish outcomes for other inputs.'},
      visitedRegions:[...this.places.values()].slice(-32),
      taskHistory:[...this.tasks.values()].slice(-16).map(({eventId,atSecond,plan})=>({eventId,atSecond,goal:plan.goal,successCondition:plan.steps[0]?.task,status:plan.status,assessment:plan.explanation,evidenceEventIds:plan.steps[0]?.evidenceEventIds??[],project:plan.project?.goal,projectProgress:plan.project?.progress})),
      pastSpeech:[...this.speech.values()].slice(-12),
    });
  }

  private place(event:WorldEvent,position=this.self?.position) {
    if(!position)return;
    const region=position.map((value,index)=>Math.floor(value/(index===1?4:8))*(index===1?4:8)) as Vec3;
    const key=region.join(','),old=this.places.get(key);
    const place={region,visits:old?.visits??0,emptyCreatureScans:old?.emptyCreatureScans??0,lastAtSecond:event.time,lastEventId:event.id};
    remember(this.places,key,place,128);return place;
  }

  private accept(event:WorldEvent) {
    const data=event.data as any;
    if(event.type==='observation'){
      this.self=data?.self;
      for(const surface of data?.surfaces??[]){
        const previous=this.materials.get(surface.kind);
        remember(this.materials,surface.kind,{firstEventId:previous?.firstEventId??event.id,lastEventId:event.id,lastSeen:surface.nearest,lastAtSecond:event.time},128);
      }
      for(const other of data?.entities??[])remember(this.creatures,other.id,{name:other.name,kind:other.kind,lastSeen:other.position,lastAtSecond:event.time,eventId:event.id},64);
      for(const voice of data?.heard??[])remember(this.speech,`${voice.tick}:${voice.from}:${voice.word}`,{from:voice.from,word:voice.word,atSecond:voice.tick/TICKS_PER_SECOND},32);
      return;
    }
    if(event.type==='discovery'){
      remember(this.discoveries,data?.knowledge??event.message,{eventId:event.id,atSecond:event.time,message:event.message,observed:data?.detail??{}},128);return;
    }
    if(event.type==='plan'&&data?.plan){
      const plan=data.plan as AgentPlan;
      remember(this.tasks,`${plan.createdTurn}:${plan.startedAtSecond}:${plan.goal}`,{eventId:event.id,atSecond:event.time,plan},40);return;
    }
    if(event.type==='arrived'||event.type==='blocked'){
      const place=this.place(event,data?.to);if(place)place.visits++;return;
    }
    if(event.type==='scanned'){
      for(const other of data?.entities??[])remember(this.creatures,other.entityId??other.name,{name:other.name,kind:other.kind,detectedFrom:this.self?.position,lastAtSecond:event.time,eventId:event.id},64);
      for(const material of data?.materials??[]){
        if(!material.target)continue;
        const previous=this.materials.get(material.material);
        remember(this.materials,material.material,{firstEventId:previous?.firstEventId??event.id,lastEventId:event.id,lastSeen:material.target,lastAtSecond:event.time},128);
      }
      if(Array.isArray(data?.entities)&&!data.entities.length){const place=this.place(event);if(place)place.emptyCreatureScans++;}
      return;
    }
    if(!['action','rejected'].includes(event.type)||!data?.action)return;
    this.totalActions++;
    const {action,...args}=data.action;
    if(!experimentalActions.has(action))return;
    const feedback=data.result?.feedback??{};
    const inventory=this.self?.inventory,held=inventory?.selected==null?undefined:inventory.stacks[inventory.selected];
    const subject=feedback.material??(['hit','dig','pickup'].includes(action)?feedback.collected:held?.kind);
    const parameters:Record<string,unknown>={...args};
    if(action==='strike_held'&&args.impact){parameters.point=impactPointName(args.impact)??args.impact;delete parameters.impact;}
    if(held?.contents)parameters.contents=held.contents;
    const result=compactResult(data.result as ActionResult??{ok:event.type==='action',message:event.message});
    // Coordinates remain in the examples; repeated identical effects do not consume more memory.
    const {target:_,itemId:__,...conditions}=parameters;
    const signature=JSON.stringify({action,subject,conditions,outcome:result.outcome,message:result.message,shaped:result.shaped,collected:result.collected});
    const previous=this.experiments.get(signature);
    remember(this.experiments,signature,{action,subject,parameters,result,attempts:(previous?.attempts??0)+1,firstEventId:previous?.firstEventId??event.id,lastEventId:event.id,firstAtSecond:previous?.firstAtSecond??event.time,lastAtSecond:event.time},256);
  }
}
