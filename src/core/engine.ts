import { Voxels } from './voxels';
import { TICKS_PER_SECOND } from './time';
import { exchangeInventory, normalizeInventory } from './inventory';
import { knowledgeDescription } from './knowledge';
import { clone, distance, key, type Action, type ActionResult, type Body, type EncounterNotice, type Entity, type Frame, type HeardVoice, type MovementIssue, type NavigationPath, type NavigationReport, type Observation, type Stack, type Vec3, type WorldEvent, type WorldModule, type WorldState } from './types';

const ok = (message: string): ActionResult => ({ ok: true, message });
const fail = (message: string, navigation?: NavigationReport): ActionResult => ({ ok: false, message, ...(navigation ? { navigation } : {}) });
const center = (p: Vec3): Vec3 => p.map(v => v + .5) as Vec3;
const faces: Vec3[] = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
const rawBlock = (kind: string) => ['grass','dirt','sand','stone','wood','leaves'].includes(kind);

export class Engine {
  readonly voxels: Voxels;
  entities: Entity[];
  bodies: Body[] = [];
  tick = 0;
  lost = 0;
  nextEvent = 1;
  readonly blockDamage = new Map<string, number>();
  readonly discoveries = new Map<string, Set<string>>();
  private nextBody = 1;
  private pendingEvents: WorldEvent[] = [];
  readonly recentEvents: WorldEvent[] = [];
  readonly inbox = new Map<string, HeardVoice[]>();
  private contacts=new Map<string,Set<string>>();
  private encounterNotices=new Map<string,EncounterNotice[]>();
  constructor(readonly module: WorldModule, state?: WorldState) {
    const initial = state ?? module.generate();
    this.voxels = new Voxels(module.manifest.materials, initial.blocks);
    this.entities = clone(initial.entities).map(entity => ({ ...entity, enabled: entity.enabled !== false, hitbox: entity.hitbox ?? { radius: entity.kind === 'duck' ? .24 : .36, height: entity.height }, inventory: normalizeInventory(entity.inventory) }));
    for (const [voxel, damage] of Object.entries((state as WorldState | undefined)?.blockDamage ?? {})) this.blockDamage.set(voxel, damage);
    for (const [actor, learned] of Object.entries((state as WorldState | undefined)?.discoveries ?? {})) this.discoveries.set(actor,new Set(learned));
    if (state) {
      this.tick = state.tick; this.bodies = clone(state.bodies).map(body=>body.kind==='plant'?{...body,kind:'stick'}:body); this.lost = state.lost;
      for (const [id, messages] of Object.entries(state.inbox ?? {})) this.inbox.set(id, clone(messages));
      for(const [id,contacts] of Object.entries(state.contacts??{}))this.contacts.set(id,new Set(contacts));
      for(const [id,notices] of Object.entries(state.encounterNotices??{}))this.encounterNotices.set(id,clone(notices));
    }
    // Old recordings may contain follow chains. Repair them without creating a new replay event during load.
    for(const entity of [...this.entities].sort((a,b)=>a.id.localeCompare(b.id)))if(entity.following&&this.followersOf(entity).length){
      const followers=this.followersOf(entity),names=followers.map(follower=>follower.name).join(', ');
      delete entity.following;delete entity.motion;entity.status='idle';entity.lastAction={ok:false,message:`${names} ${followers.length===1?'is':'are'} following you, so you stop following and choose your own actions.`};
    }
  }
  get time() { return this.tick / TICKS_PER_SECOND; }
  get day() { return Math.floor(this.time / this.module.manifest.daySeconds) + 1; }
  entity(id: string) { const entity = this.entities.find(e => e.id === id); if (!entity) throw new Error('Unknown entity.'); return entity; }
  active(entity: Entity) { return entity.enabled !== false; }
  followersOf(entity:Entity){return this.entities.filter(other=>this.active(other)&&other.id!==entity.id&&other.following?.entityId===entity.id);}
  setEntityEnabled(id: string, enabled: boolean) {
    const entity = this.entity(id);
    if (this.active(entity) === enabled) return false;
    entity.enabled = enabled; delete entity.motion; delete entity.speech; delete entity.following; delete entity.movementPrompt; delete entity.followInvitation;
    if(!enabled)for(const follower of this.entities)if(follower.following?.entityId===id)this.endFollowing(follower,`${entity.name} is no longer available to follow.`);
    if(!enabled){this.contacts.delete(id);this.encounterNotices.delete(id);for(const contacts of this.contacts.values())contacts.delete(id);for(const [actor,notices] of this.encounterNotices)this.encounterNotices.set(actor,notices.filter(notice=>notice.otherId!==id));}
    entity.status = enabled ? 'idle' : 'disabled';
    this.event('world', 'entity-control', `${entity.name} was ${enabled ? 'enabled' : 'disabled'}.`, { entityId: id, enabled });
    return true;
  }
  event(actor: string, type: string, message: string, data?: unknown) {
    const event: WorldEvent = { id: this.nextEvent++, tick: this.tick, time: this.time, day: this.day, actor, type, message, ...(data === undefined ? {} : { data: clone(data) }) };
    this.pendingEvents.push(event); this.recentEvents.push(event);
    if (this.recentEvents.length > 200) this.recentEvents.shift();
    return event;
  }
  discover(actor:string,knowledge:string,message:string,data?:unknown) {
    const learned=this.discoveries.get(actor)??new Set<string>();
    if(learned.has(knowledge))return false;
    learned.add(knowledge);this.discoveries.set(actor,learned);this.event(actor,'discovery',message,{knowledge,...(data===undefined?{}:{detail:clone(data)})});return true;
  }
  state(): WorldState { return { ...this.dynamic(), blocks: this.voxels.serialize() }; }
  dynamic() { return clone({ tick: this.tick, time: this.time, entities: this.entities, bodies: this.bodies, lost: this.lost, inbox: Object.fromEntries(this.inbox), blockDamage: Object.fromEntries(this.blockDamage), discoveries:Object.fromEntries([...this.discoveries].map(([actor,learned])=>[actor,[...learned]])),contacts:Object.fromEntries([...this.contacts].map(([actor,contacts])=>[actor,[...contacts]])),encounterNotices:Object.fromEntries(this.encounterNotices) }); }
  frame(): Frame {
    const frame = { ...this.dynamic(), changes: [...this.voxels.changes], events: this.pendingEvents.splice(0) };
    this.voxels.changes.clear(); return frame;
  }
  inside(p: Vec3) { return p.every((v, i) => v >= this.module.manifest.bounds.min[i] && v < this.module.manifest.bounds.max[i]); }
  eye(e: Entity): Vec3 { return [e.position[0], e.position[1] + e.height * .85, e.position[2]]; }
  visible(e: Entity, point: Vec3, ignoreEnd = false, range = this.module.manifest.perception.range) {
    const eye = this.eye(e), d = distance(eye, point);
    if (d > range) return false;
    const angle = Math.atan2(point[0] - eye[0], point[2] - eye[2]);
    const difference = Math.atan2(Math.sin(angle - e.yaw * Math.PI / 180), Math.cos(angle - e.yaw * Math.PI / 180));
    return (d < 1.6 || Math.abs(difference) <= this.module.manifest.perception.fieldOfView * Math.PI / 360) && this.voxels.clearLine(eye, point, ignoreEnd);
  }
  private blockSurfaces(target:Vec3,eye:Vec3) {
    return faces.flatMap(face=>{
      if(this.voxels.solid(target.map((v,i)=>v+face[i]) as Vec3))return [];
      const surface=target.map((v,i)=>v+.5+face[i]*.5001) as Vec3;
      return face.reduce((sum,v,i)=>sum+v*(eye[i]-surface[i]),0)>0?[surface]:[];
    });
  }
  private blockInReach(e:Entity,target:Vec3) {
    const eye=this.eye(e);
    return this.blockSurfaces(target,eye).some(point=>distance(eye,point)<=3&&this.voxels.clearLine(eye,point));
  }
  private cellOccupied(target:Vec3) {
    const point=center(target);
    return this.entities.some(other=>this.active(other)&&Math.abs(other.position[0]-point[0])<.8&&Math.abs(other.position[2]-point[2])<.8&&target[1]<other.position[1]+other.height&&target[1]+1>other.position[1]);
  }
  private hasSupport(target:Vec3,finished=false) {
    return finished?this.voxels.solid([target[0]+.5,target[1]-.01,target[2]+.5]):faces.some(d=>this.voxels.solid(target.map((v,i)=>v+d[i]) as Vec3));
  }
  private containerTargets(e:Entity) {
    const place:Vec3[]=[],fill:Vec3[]=[],empty:Vec3[]=[],held=this.held(e),eye=this.eye(e);
    if(!held)return {place,fill,empty};
    for(let x=Math.floor(eye[0])-3;x<=Math.floor(eye[0])+3;x++)for(let y=Math.floor(eye[1])-3;y<=Math.floor(eye[1])+3;y++)for(let z=Math.floor(eye[2])-3;z<=Math.floor(eye[2])+3;z++){
      const target:Vec3=[x,y,z],point=center(target),kind=this.voxels.get(target);
      if(!this.inside(target))continue;
      const clear=!kind&&distance(eye,point)<=3&&this.visible(e,point);
      if(clear&&!held.contents&&!this.cellOccupied(target)&&this.hasSupport(target,!rawBlock(held.kind)))place.push(target);
      if(held.kind!=='bucket')continue;
      const canChangeContents=(contents?:string)=>!!exchangeInventory(e.inventory,[{index:e.inventory!.selected!,count:1}],[{kind:'bucket',count:1,...(contents?{contents}:{})}],true);
      if(!held.contents&&((clear&&point[1]<this.module.manifest.waterLevel)||((kind==='sand'||kind==='dirt')&&!this.standingOn(target)&&this.blockInReach(e,target)&&this.blockSurfaces(target,eye).some(p=>this.visible(e,p))))&&canChangeContents(kind??'water'))fill.push(target);
      if(held.contents&&clear&&(held.contents==='water'||(!this.cellOccupied(target)&&this.hasSupport(target)))&&canChangeContents())empty.push(target);
    }
    const nearest=(targets:Vec3[])=>targets.sort((a,b)=>distance(eye,center(a))-distance(eye,center(b))).slice(0,3);
    return {place:nearest(place),fill:nearest(fill),empty:nearest(empty)};
  }
  observe(id: string): Observation {
    const e = this.entity(id), eye = this.eye(e), { range, maxBlocks } = this.module.manifest.perception;
    const blocks = this.voxels.nearby(eye, range).filter(b => {
      const p = b.slice(0,3) as Vec3;
      return this.blockSurfaces(p,eye).some(surface=>this.visible(e,surface));
    })
      .sort((a, b) => distance(eye, center(a.slice(0, 3) as Vec3)) - distance(eye, center(b.slice(0, 3) as Vec3)));
    const surfaces = new Map<string,{kind:string;count:number;nearest:Vec3}>();
    for (const b of blocks) { const summary = surfaces.get(b[3]); if (summary) summary.count++; else surfaces.set(b[3],{kind:b[3],count:1,nearest:b.slice(0,3) as Vec3}); }
    // Preserve nearby reach targets and a representative of every visible material.
    const samples = new Map(blocks.slice(0,Math.max(0,maxBlocks-surfaces.size)).map(b => [key(b.slice(0,3) as Vec3),b]));
    for (const surface of surfaces.values()) { const b = blocks.find(b => b[3]===surface.kind)!; samples.set(key(surface.nearest),b); }
    const entities = this.entities.filter(other => other.id !== id && this.active(other) && this.visible(e, this.eye(other),false,Math.max(20,this.module.manifest.perception.range))).map(({ id, name, kind, position }) => ({ id, name, kind, position: clone(position) }));
    const navigation = this.navigationReport(e);
    const items = clone(this.bodies.filter(b => this.visible(e, b.position)).sort((a,b)=>distance(eye,a.position)-distance(eye,b.position)));
    const description = this.describe(e,[...surfaces.values()],entities,items,navigation);
    const held=this.held(e),emptyHands=!held,hasShovel=held?.kind==='shovel';
    const followCandidates=[...entities];
    const invited=e.followInvitation&&e.followInvitation.untilTick>=this.tick?this.entities.find(other=>other.id===e.followInvitation!.speakerId&&this.active(other)):undefined;
    if(invited&&!followCandidates.some(other=>other.id===invited.id))followCandidates.push({id:invited.id,name:invited.name,kind:invited.kind,position:clone(invited.position)});
    const interactions = {
      hit: emptyHands||hasShovel ? blocks.filter(block=>{
        const target=block.slice(0,3) as Vec3;
        return this.blockInReach(e,target)&&!this.standingOn(target)&&(!hasShovel||['sand','dirt','grass'].includes(block[3]));
      }).sort((a,b)=>(this.blockDamage.get(key(b.slice(0,3) as Vec3))??0)-(this.blockDamage.get(key(a.slice(0,3) as Vec3))??0)||Number(b[3]==='wood')-Number(a[3]==='wood'))
        .slice(0,2).map(block=>({target:block.slice(0,3) as Vec3,kind:block[3],cracks:this.blockDamage.get(key(block.slice(0,3) as Vec3))??0})) : [],
      pickup: emptyHands ? items.filter(item=>distance(eye,item.position)<=3&&this.voxels.clearLine(eye,item.position)&&this.canHold(e,item.kind,item.contents??(item.water?'water':undefined)).ok)
        .sort((a,b)=>distance(eye,a.position)-distance(eye,b.position)).slice(0,3).map(item=>({itemId:item.id,kind:item.kind,metres:Math.round(distance(eye,item.position)*10)/10})) : [],
      speak: entities.filter(other=>this.canSpeakTo(e,this.entity(other.id))).map(({id,name})=>({id,name})),
      follow: followCandidates.filter(other=>this.canFollow(e,this.entity(other.id))).map(({id,name,position})=>({id,name,metres:Math.round(distance(e.position,position)*10)/10})),
      ...this.containerTargets(e),
    };
    const followed=e.following&&this.entities.find(other=>other.id===e.following!.entityId);
    const tracking=followed&&this.active(followed)&&distance(e.position,followed.position)<=20&&this.voxels.clearLine(eye,this.eye(followed));
    const following=followed?{entityId:followed.id,name:followed.name,...(tracking?{metres:Math.round(distance(e.position,followed.position)*10)/10,direction:this.direction(e,followed.position)}:{}),message:!tracking?'Direct contact has been lost. Stop following to choose another action.':e.following!.blocked?`${e.following!.blocked.message} Stop following to choose another action.`:'Automatically following, stopping one metre away. Choose follow to continue or stop_follow to stop and act immediately.'}:undefined;
    const beingFollowed=this.followersOf(e).map(follower=>({id:follower.id,name:follower.name,message:`${follower.name} is following you. You cannot follow another creature while they follow you; continue choosing your own actions.`}));
    return { tick: this.tick, time: this.time, self: clone(e), blocks: [...samples.values()].slice(0,maxBlocks), surfaces: [...surfaces.values()], entities,
      items, heard: clone((this.inbox.get(id) ?? []).filter(m => this.tick - m.tick < 1200)),
      encounters:clone((this.encounterNotices.get(id)??[]).map(notice=>({...notice,canSpeakNow:this.canSpeakTo(e,this.entity(notice.otherId))}))),
      navigation,
      interactions,
      ...(following?{following}:{}),
      ...(beingFollowed.length?{beingFollowed}:{}),
      description, truncated: blocks.length > maxBlocks };
  }
  acknowledgeEncounters(id:string,notices:EncounterNotice[]){
    const seen=new Set(notices.map(notice=>notice.eventId));
    if(seen.size)this.encounterNotices.set(id,(this.encounterNotices.get(id)??[]).filter(notice=>!seen.has(notice.eventId)));
  }
  private canSpeakTo(speaker:Entity,listener:Entity){return speaker.id!==listener.id&&this.active(speaker)&&this.active(listener)&&distance(this.eye(speaker),this.eye(listener))<=10&&this.voxels.clearLine(this.eye(speaker),this.eye(listener));}
  canFollow(follower:Entity,target:Entity,viewAngle=0){
    const invited=follower.followInvitation?.speakerId===target.id&&follower.followInvitation.untilTick>=this.tick&&this.voxels.clearLine(this.eye(follower),this.eye(target));
    return follower.id!==target.id&&this.active(follower)&&this.active(target)&&!this.followersOf(follower).length&&distance(follower.position,target.position)<=20&&(invited||this.visible({...follower,yaw:follower.yaw+viewAngle},this.eye(target),false,20));
  }
  private speak(speaker:Entity,word:string,respond=true):Entity[]{
    const recipients=this.entities.filter(other=>this.canSpeakTo(speaker,other));
    speaker.speech={word,until:this.time+4};
    for(const listener of recipients){
      const inbox=this.inbox.get(listener.id)??[];
      inbox.push({from:speaker.name,speakerId:speaker.id,word,tick:this.tick,direction:this.direction(listener,speaker.position),distance:Math.round(distance(this.eye(listener),this.eye(speaker))*10)/10});
      this.inbox.set(listener.id,inbox.slice(-16));
      if(word==='Follow me'&&listener.controller==='agent')listener.followInvitation={speakerId:speaker.id,speakerName:speaker.name,tick:this.tick,untilTick:this.tick+1200};
    }
    this.event(speaker.id,'speech',`${speaker.name} says "${word}".`,{word,recipientIds:recipients.map(other=>other.id)});
    if(respond)for(const listener of recipients){const reply=this.module.respondToSpeech?.(listener,speaker,word);if(reply)this.speak(listener,reply,false);}
    return recipients;
  }
  wakeMovingListenersFromSpeech(){
    for(const speech of this.recentEvents.filter(event=>event.tick===this.tick&&event.type==='speech')){
      const data=speech.data as {word:string;recipientIds:string[]};
      for(const id of data.recipientIds){
        const listener=this.entities.find(entity=>entity.id===id),motion=listener?.motion;
        if(!listener||listener.controller!=='agent'||!this.active(listener)||listener.following||!motion||!['walk','run'].includes(motion.kind??'walk'))continue;
        const speaker=this.entity(speech.actor);
        const messages=listener.movementPrompt?.messages??[];
        if(messages.some(message=>message.tick===speech.tick&&message.speakerId===speech.actor&&message.word===data.word))continue;
        messages.push({speakerId:speaker.id,speakerName:speaker.name,word:data.word,tick:speech.tick,direction:this.direction(listener,speaker.position),distance:Math.round(distance(this.eye(listener),this.eye(speaker))*10)/10});listener.movementPrompt={messages};
        this.event(listener.id,'movement-prompt',`${speaker.name} said "${data.word}" while you were moving. Decide whether to continue or stop.`,{speakerId:speaker.id,word:data.word});
      }
    }
  }
  movementPrompts(){
    for(const entity of this.entities)if(entity.movementPrompt&&(!entity.motion||entity.following||!['walk','run'].includes(entity.motion.kind??'walk')))delete entity.movementPrompt;
    return this.entities.filter(entity=>this.active(entity)&&!!entity.movementPrompt&&!!entity.motion&&!entity.following);
  }
  resolveMovementPrompt(id:string,choice:'continue_moving'|'stop_moving'){
    const entity=this.entity(id),prompt=entity.movementPrompt;
    if(!prompt)return fail('There is no movement decision to resolve.');
    delete entity.movementPrompt;
    const speech=prompt.messages.map(message=>`${message.speakerName} saying "${message.word}"`).join(' and ');
    if(choice==='stop_moving'){
      delete entity.motion;entity.status='idle';
      entity.lastAction=ok(`You stop moving after hearing ${speech}. Choose your next action on the next turn.`);
      this.event(id,'movement-response',entity.lastAction.message,{choice,messages:prompt.messages});return entity.lastAction;
    }
    const result=ok(`You continue your current movement after hearing ${speech}.`);
    this.event(id,'movement-response',result.message,{choice,messages:prompt.messages});return result;
  }
  private updateEncounters(){
    for(const observer of this.entities.filter(entity=>entity.controller==='agent'&&this.active(entity))){
      const previous=this.contacts.get(observer.id)??new Set<string>(),current=new Set<string>();
      for(const other of this.entities){
        if(!this.canSpeakTo(observer,other)||!this.visible(observer,this.eye(other)))continue;
        const metres=distance(observer.position,other.position),message=this.module.encounterMessage?.(observer,other,metres);
        if(!message)continue;
        current.add(other.id);
        if(previous.has(other.id))continue;
        const event=this.event(observer.id,'encounter',message,{otherId:other.id,distance:metres});
        const notices=this.encounterNotices.get(observer.id)??[];
        notices.push({eventId:event.id,tick:this.tick,otherId:other.id,otherName:other.name,message});this.encounterNotices.set(observer.id,notices);
      }
      this.contacts.set(observer.id,current);
    }
  }
  observeAt(id: string, angle = 0) {
    const entity = this.entity(id), yaw = entity.yaw;
    entity.yaw = ((yaw + angle) % 360 + 360) % 360;
    try {
      const observation=this.observe(id);
      const paths=observation.navigation.paths.map(path=>{
        const turn=((angle+path.turn+540)%360)-180;
        const jump=path.jump&&Math.abs(turn)<=90?{...path.jump,angle:turn}:undefined;
        return {...path,turn,options:path.options?.filter(option=>option!=='jump'||!!jump),approach:path.approach?{...path.approach,angle:turn}:undefined,jump};
      });
      return {description:observation.description,viewAngle:angle,bodyYaw:yaw,navigation:{...observation.navigation,paths},interactions:observation.interactions};
    }
    finally { entity.yaw = yaw; }
  }
  private direction(e: Entity, point: Vec3) {
    const angle = Math.atan2(point[0]-e.position[0],point[2]-e.position[2]) * 180 / Math.PI;
    const relative = ((angle-e.yaw+540)%360)-180;
    if (Math.abs(relative) < 25) return 'ahead';
    if (relative >= 25 && relative < 75) return 'ahead-right';
    if (relative <= -25 && relative > -75) return 'ahead-left';
    if (relative >= 75 && relative < 135) return 'right';
    if (relative <= -75 && relative > -135) return 'left';
    return 'behind';
  }
  held(e: Entity) { return e.inventory?.selected === null || !e.inventory ? undefined : e.inventory.stacks[e.inventory.selected]; }
  private describe(e: Entity, surfaces: {kind:string;count:number;nearest:Vec3}[], entities: Pick<Entity,'id'|'name'|'kind'|'position'>[], items: Body[], navigation: NavigationReport) {
    const parts: string[] = [];
    const held = this.held(e);
    parts.push(held ? `You hold ${held.count > 1 ? `${held.count} x ` : ''}${held.kind}${held.contents ? ` containing ${held.contents}` : ''}.` : 'Your hands are empty.');
    const forward = navigation.paths.find(path => path.turn === 0)!;
    if (forward.issue) {
      parts.push(`${forward.issue.message} It is about ${forward.clearance.toFixed(1)} m ahead.`);
    }
    else parts.push(`The ground ahead is traversable for at least ${navigation.checkedDistance} m.`);
    for (const surface of surfaces.filter(surface => ['wood','plant','leaves','stone','sand'].includes(surface.kind)).slice(0,4)) {
      const metres = distance(e.position,center(surface.nearest));
      const label = surface.kind === 'wood' ? surfaces.some(other => other.kind === 'leaves') ? 'tree trunk' : 'wood block or exposed trunk' : surface.kind === 'plant' ? 'plant or shrub' : `${surface.kind} terrain`;
      parts.push(`A ${label} is ${metres.toFixed(1)} m ${this.direction(e,center(surface.nearest))} at block [${surface.nearest.join(',')}].`);
    }
    for (const other of entities.slice(0,4)) parts.push(`${other.name}, a ${other.kind}, is ${distance(e.position,other.position).toFixed(1)} m ${this.direction(e,other.position)}.`);
    for (const item of items.slice(0,3)) parts.push(`A loose ${item.kind} is ${distance(e.position,item.position).toFixed(1)} m ${this.direction(e,item.position)} (item ${item.id}).`);
    return parts.join(' ');
  }
  private footAt(x: number, z: number, from: number, height: number, maxRise = 0, maxDrop = 1, edgeSupport = false): Vec3 | null {
    for (let y = Math.floor(from + maxRise + .001); y >= Math.floor(from - maxDrop + .001); y--) {
      const supported=this.voxels.solid([x,y-.01,z])||(edgeSupport&&[-.23,.23].some(dx=>[-.23,.23].some(dz=>this.voxels.solid([x+dx,y-.01,z+dz]))));
      if (!supported) continue;
      let clear = true;
      for (const dx of [-.23, .23]) for (const dz of [-.23, .23]) for (let dy = .05; dy < height; dy += .3) {
        if (this.voxels.solid([x + dx, y + dy, z + dz])) clear = false;
      }
      if (clear) return [x, y, z];
    }
    return null;
  }
  private blockingVoxel(e: Entity, x: number, z: number, feet: number): Vec3 | undefined {
    for (const dx of [-.23,.23]) for (const dz of [-.23,.23]) for (let dy=.05;dy<e.height;dy+=.25) {
      if (this.voxels.solid([x+dx,feet+dy,z+dz])) return [Math.floor(x+dx),Math.floor(feet+dy),Math.floor(z+dz)];
    }
  }
  private collidingEntity(e:Entity,point:Vec3){
    const hitbox=e.hitbox??{radius:.36,height:e.height};
    return this.entities.find(other=>{
      if(other.id===e.id||!this.active(other))return false;
      const otherHitbox=other.hitbox??{radius:other.kind==='duck'?.24:.36,height:other.height};
      const vertical=point[1]<other.position[1]+otherHitbox.height-.01&&point[1]+hitbox.height>other.position[1]+.01;
      return vertical&&Math.hypot(other.position[0]-point[0],other.position[2]-point[2])<hitbox.radius+otherHitbox.radius;
    });
  }
  private movementPoint(e: Entity, x: number, z: number, from: number, maxRise = 0): { point?: Vec3; issue?: MovementIssue } {
    if (!this.inside([x, from, z])) return { issue: { kind:'boundary',message:'The boundary of the world blocks that direction.' } };
    const point = this.footAt(x, z, from, e.height, maxRise,1,true);
    if (!point) {
      const target = this.blockingVoxel(e,x,z,from);
      if (target) {
        let height=0; for(let y=Math.floor(from);this.voxels.get([target[0],y,target[2]]);y++) height++;
        const material=this.voxels.get(target);
        const issue:MovementIssue={kind:height<=1?'rise':'wall',target,material,height:Math.max(1,height),message:height<=1?`A one-block ${material??'solid'} rise blocks your path.`:`A ${Math.max(2,height)}-block ${material??'solid'} wall blocks your path.`};
        issue.message=this.module.describeObstacle?.(issue)??issue.message;
        return {issue};
      }
      // An underwater shore can lose its seabed before a walkable step is found.
      const lower=this.footAt(x,z,from,e.height,maxRise,Math.max(1,from-this.module.manifest.bounds.min[1]));
      if(lower||from<=this.module.manifest.waterLevel){
        const feet:Vec3=lower??[x,this.module.manifest.bounds.min[1],z],allowed=this.module.canEnter(e,feet);
        if(!allowed.ok)return {issue:{kind:'water',target:[Math.floor(x),Math.floor(feet[1]),Math.floor(z)],message:allowed.message}};
      }
      return { issue: { kind:'gap',target:[Math.floor(x),Math.floor(from-1),Math.floor(z)],message:'There is no safe ground ahead; the terrain drops away.' } };
    }
    const allowed = this.module.canEnter(e, point);
    if (!allowed.ok) return { issue: { kind:'water',target:[Math.floor(x),Math.floor(point[1]),Math.floor(z)],message:allowed.message } };
    const other = this.collidingEntity(e,point);
    if (other) return { issue: { kind:'entity',entity:other.name,entityId:other.id,message:`${other.name}'s body blocks your path.` } };
    return { point };
  }
  private traceMovement(e: Entity, yaw: number, requestedDistance: number): { destination?: Vec3; clearance: number; issue?: MovementIssue } {
    const angle = yaw * Math.PI / 180, count = Math.ceil(requestedDistance / .15);
    let destination = e.position;
    for (let i = 1; i <= count; i++) {
      const travelled = requestedDistance * i / count;
      const step = this.movementPoint(e, e.position[0] + Math.sin(angle) * travelled, e.position[2] + Math.cos(angle) * travelled, destination[1]);
      if (!step.point) return { clearance: requestedDistance * (i - 1) / count, issue: step.issue };
      destination = step.point;
    }
    return { destination, clearance: requestedDistance };
  }
  private planJump(e:Entity,yaw:number,jumpDistance:number):{landing?:Vec3;issue?:MovementIssue;message?:string}{
    const obstacle=this.traceMovement(e,yaw,jumpDistance),issue=obstacle.issue;
    if(issue&&(issue.kind==='wall'||(issue.height??0)>1))return {issue,message:`${issue.message} It is too high to jump.`};
    if(issue&&!['rise','gap'].includes(issue.kind))return {issue,message:issue.message};
    const angle=yaw*Math.PI/180,x=e.position[0]+Math.sin(angle)*jumpDistance,z=e.position[2]+Math.cos(angle)*jumpDistance;
    const landing=this.footAt(x,z,e.position[1],e.height,1,1);
    if(!landing)return {issue,message:'There is no safe landing within one block of your current height.'};
    const allowed=this.module.canEnter(e,landing);
    if(!allowed.ok)return {issue:{kind:'water',target:[Math.floor(x),Math.floor(landing[1]),Math.floor(z)],message:allowed.message},message:'The landing would put you in dangerously deep water.'};
    const other=this.collidingEntity(e,landing);
    if(other)return {issue:{kind:'entity',entity:other.name,entityId:other.id,message:`${other.name} occupies the landing point.`},message:`${other.name} occupies the landing point.`};
    return {landing};
  }
  private movementResponses(e:Entity,issue?:MovementIssue,clearance=0,yaw=e.yaw){
    const options:string[]=[],angle=((yaw-e.yaw+540)%360)-180;
    const approach=clearance>.45?{distance:Math.floor((clearance-.15)*10)/10,angle}:undefined;
    if(approach)options.push('walk');
    let jump:{distance:number;angle:number}|undefined;
    if(issue&&['rise','gap'].includes(issue.kind)&&clearance<2.25&&Math.abs(angle)<=90){
      const candidate=[1,1.5,2,2.5].find(d=>d>clearance+.25&&this.planJump(e,yaw,d).landing);
      if(candidate){jump={distance:candidate,angle};options.push('jump');}
    }
    if(issue?.target&&['rise','wall'].includes(issue.kind)){
      const held=this.held(e),reachable=!this.standingOn(issue.target)&&this.blockInReach(e,issue.target)&&this.blockSurfaces(issue.target,this.eye(e)).some(point=>this.visible(e,point));
      if(held?.kind==='shovel'&&reachable&&['sand','dirt','grass'].includes(this.voxels.get(issue.target)!))options.push('dig');
      else if(held)options.push('store');
      else if(reachable)options.push('hit');
    }
    if(issue?.kind==='entity')options.push('wait','say');
    options.push('turn');
    return {options,approach,jump};
  }
  private options(e:Entity,issue?:MovementIssue){return this.movementResponses(e,issue).options;}
  private navigationReport(e: Entity, checkedDistance = 8, blockedAfter?: number): NavigationReport {
    const headings: Pick<NavigationPath, 'direction' | 'turn'>[] = [
      { direction: 'forward-left', turn: -45 },
      { direction: 'forward', turn: 0 },
      { direction: 'forward-right', turn: 45 },
    ];
    const paths = headings.map(({ direction, turn }) => {
      const trace=this.traceMovement(e,e.yaw+turn,checkedDistance);
      return { direction,turn,clearance:Math.floor(trace.clearance*10)/10,...(trace.issue?{issue:trace.issue,...this.movementResponses(e,trace.issue,trace.clearance,e.yaw+turn)}:{}) };
    });
    return { checkedDistance, paths, ...(blockedAfter === undefined ? {} : { blockedAfter: Math.floor(blockedAfter * 10) / 10 }) };
  }
  act(id: string, action: Action): ActionResult {
    const e = this.entity(id);
    if (!this.active(e)) return fail('This entity is disabled.');
    let result: ActionResult;
    try { result = this.execute(e, action); }
    catch (error) { result = fail(error instanceof Error ? error.message : 'Invalid action.'); }
    e.lastAction = clone(result);
    this.event(id, result.ok ? 'action' : 'rejected', result.message, { action, result });
    return result;
  }
  private standingOn(target:Vec3) {
    return this.entities.find(other=>this.active(other)&&Math.floor(other.position[0])===target[0]&&Math.floor(other.position[2])===target[2]&&Math.abs(other.position[1]-(target[1]+1))<.05);
  }
  private execute(e: Entity, a: Action): ActionResult {
    if(a.action==='stop_follow'){
      if(e.following){delete e.following;delete e.motion;e.status='idle';}
      return ok('You stop following. You can choose another action immediately.');
    }
    if(a.action==='follow'){
      const id=a.entityId??e.following?.entityId,target=this.entities.find(other=>other.id===id);
      if(this.followersOf(e).length){const followers=this.followersOf(e);return fail(`${followers.map(follower=>follower.name).join(', ')} ${followers.length===1?'is':'are'} following you. You cannot follow another creature while you are being followed.`);}
      if(!target||!this.canFollow(e,target,a.angle??0))return fail('Follow requires another visible living entity within 20 metres, with a clear line of sight.');
      if(e.motion&&!e.following)return fail('Wait until your movement finishes before following.');
      if(target.following)this.endFollowing(target,`${e.name} started following you. You stop following and continue with your own actions.`);
      e.following={entityId:target.id};delete e.motion;delete e.followInvitation;e.status='following';e.yaw=((Math.atan2(target.position[0]-e.position[0],target.position[2]-e.position[2])*180/Math.PI)%360+360)%360;
      return ok(`You follow ${target.name}, stopping one metre away. Each turn choose follow to continue or stop_follow to stop and take another action immediately.`);
    }
    if(e.following)return fail('While following, choose follow or stop_follow. Stopping lets you act immediately.');
    if (e.motion) return fail('Wait until your movement finishes.');
    if (a.action === 'wait') { e.status = 'idle'; return ok('Waiting and watching.'); }
    if (a.action === 'turn') {
      if (!Number.isFinite(a.angle) || Math.abs(a.angle!) > 360) return fail('Turn angle must be between -360 and 360 degrees.');
      e.yaw = ((e.yaw + a.angle!) % 360 + 360) % 360; return ok(`Turned to ${Math.round(e.yaw)} degrees.`);
    }
    if (a.action === 'hold') {
      if (!e.inventory || !Number.isInteger(a.stack) || a.stack! < 0 || a.stack! >= e.inventory.stacks.length) return fail('Choose an existing inventory stack.');
      e.inventory.selected = a.stack!; return ok(`You now hold ${e.inventory.stacks[a.stack!].kind}.`);
    }
    if (a.action === 'store') {
      if (!this.held(e)) return fail('Your hands are already empty.');
      e.inventory!.selected = null; return ok('Your hands are empty. Inventory space is unchanged.');
    }
    if (a.action === 'walk' || a.action === 'run') {
      const held=this.held(e), running=a.action==='run', maximum=running?24:32;
      if (running && held && rawBlock(held.kind)) return fail('You cannot run while carrying a raw block.');
      if (!Number.isFinite(a.distance) || a.distance! <= 0 || a.distance! > maximum) return fail(`${running?'Run':'Walk'} distance must be greater than zero and at most ${maximum} metres.`);
      if (a.angle !== undefined) {
        if (!Number.isFinite(a.angle) || Math.abs(a.angle) > 180) return fail('Movement angle must be between -180 and 180 degrees.');
        e.yaw=((e.yaw+a.angle)%360+360)%360;
      }
      const route = this.traceMovement(e, e.yaw, a.distance!);
      if (!route.destination) {
        const navigation = this.navigationReport(e, Math.min(8, a.distance!), route.clearance);
        if(route.clearance<.15){this.learnMovementIssue(e,route.issue!);return fail(`${route.issue!.message} You cannot move forward. Available responses: ${this.options(e,route.issue).join(', ')}.`,navigation);}
        const safe=this.traceMovement(e,e.yaw,route.clearance).destination;
        if(!safe)return fail(`${route.issue!.message} You cannot find a safe step toward it.`,navigation);
        e.motion={kind:running?'run':'walk',destination:safe,speed:running?4:e.controller==='wander'?1:2,origin:clone(e.position),stopIssue:route.issue,requestedDistance:a.distance};e.status=running?'running':'walking';
        return {ok:true,message:`You start ${running?'running':'walking'}, with an obstacle about ${route.clearance.toFixed(1)} metres ahead.`,navigation,feedback:{outcome:'started',from:clone(e.position),destination:clone(safe),expectedStop:route.issue}};
      }
      e.motion = { kind:running?'run':'walk',destination:route.destination,speed:running?4:e.controller==='wander'?1:2,origin:clone(e.position),requestedDistance:a.distance }; e.status = running?'running':'walking';
      return { ok:true,message:`You start ${running?'running':'walking'} toward a point ${a.distance!.toFixed(1)} metres ahead.`,feedback:{outcome:'started',from:clone(e.position),destination:clone(route.destination),requestedDistance:a.distance} };
    }
    if (a.action === 'jump') {
      const jumpDistance=a.distance??2;
      if (!Number.isFinite(jumpDistance) || jumpDistance<.75 || jumpDistance>2.5) return fail('Jump distance must be between 0.75 and 2.5 metres.');
      if (a.angle !== undefined) {
        if (!Number.isFinite(a.angle) || Math.abs(a.angle)>90) return fail('Jump angle must be between -90 and 90 degrees.');
        e.yaw=((e.yaw+a.angle)%360+360)%360;
      }
      const plan=this.planJump(e,e.yaw,jumpDistance),landing=plan.landing;
      if(!landing){if(plan.issue)this.learnMovementIssue(e,plan.issue);return fail(plan.message!);}
      e.motion={kind:'jump',origin:clone(e.position),destination:landing,speed:3,progress:0,duration:Math.max(.35,jumpDistance/3)};e.status='jumping';
      return {ok:true,message:`You jump ${jumpDistance.toFixed(1)} metres toward a safe landing.`,feedback:{outcome:'started',from:clone(e.position),destination:clone(landing)}};
    }
    if (a.action === 'say') {
      if (!this.module.manifest.vocabulary.includes(a.word!)) return fail('That idea is not in your communication vocabulary.');
      const recipients = this.speak(e,a.word!);
      return {ok:true,message:`Said "${a.word}". Heard by ${recipients.map(r => r.name).join(', ') || 'nobody'}.`,feedback:{recipientIds:recipients.map(recipient=>recipient.id)}};
    }
    if (a.action === 'pickup') {
      const body = this.bodies.find(b => b.id === a.itemId);
      if(!body){
        const settled=this.recentEvents.findLast(event=>event.type==='settled'&&(event.data as {itemId?:string})?.itemId===a.itemId);
        const target=(settled?.data as {target?:Vec3}|undefined)?.target;
        const kind=target&&this.voxels.get(target);
        if(target&&kind&&this.visible(e,center(target),true))return fail(`That item has settled into ${kind} terrain at block [${target.join(',')}]. It is no longer loose; you can hit the block when it is within reach and your hands are empty.`);
        return fail('That item is no longer loose here. Use look and the current interactions.pickup item IDs; raw loose blocks can settle into terrain.');
      }
      if (distance(this.eye(e), body.position) > 3 || !this.voxels.clearLine(this.eye(e), body.position)) return fail('The loose item is not within clear arm reach (3 metres). Use look for current interactions.pickup targets.');
      const result = this.canHold(e, body.kind,body.contents??(body.water?'water':undefined));
      if (!result.ok) return result;
      this.addInventory(e, body.kind, body.contents??(body.water?'water':undefined),true); this.bodies = this.bodies.filter(b => b !== body);
      return ok(`Picked up ${body.kind}.`);
    }
    if (a.action === 'throw') {
      const held=this.held(e);if(!held)return fail('Your hands are empty.');
      const force = a.force ?? 7;
      if (!Number.isFinite(force) || force < 1 || force > 12) return fail('Throw force must be between 1 and 12.');
      const angle = e.yaw * Math.PI / 180;
      const start: Vec3 = [e.position[0] + Math.sin(angle) * .8, e.position[1] + 1.3, e.position[2] + Math.cos(angle) * .8];
      if (this.voxels.solid(start) || !this.voxels.clearLine(this.eye(e), start)) return fail('There is no room to throw.');
      this.bodies.push({ id: `item-${this.tick}-${this.nextBody++}`, kind:held.kind,...(held.contents?{contents:held.contents}:{}), position: start, velocity: [Math.sin(angle) * force, force * .6, Math.cos(angle) * force], resting: false,owner:e.id });
      this.consume(e); return ok(`Threw one ${held.kind}.`);
    }
    if(a.action==='strike_held'){
      const held=this.held(e);if(!held||held.kind!=='wood')return fail('Only a raw wood block can be worked this way.');
      if(!a.impact||a.impact.length!==3||!a.impact.every(v=>Number.isFinite(v)&&v>=0&&v<=1))return fail('Impact must be a local surface point in [0,1]^3.');
      if(a.impact[0]<=.18&&a.impact[1]>=.32&&a.impact[1]<=.68&&a.impact[2]>=.82&&!a.orientation)return fail('Choose orientation up or down for this strike.');
      const made=this.module.transformHit(held.kind,a.impact,a.orientation);
      if(!made)return ok('The strike leaves a notch in the wood, but its form does not change.');
      const count=made==='plank'?5:1;
      if(!this.replaceHeld(e,{kind:made,count}))return fail('No space for the result: at most 10 different stacks, 64 identical items each. Put something down first.');
      const discovery=made==='plank'?'Discovered that a centered strike on the bottom of wood makes five planks, each 0.20 metres thick.':made==='shovel'?'Discovered a wooden shovel that removes sand, dirt, and grass with one strike.':`Discovered how to shape wood into a ${made.replaceAll('_',' ')}.`;
      this.discover(e.id,`wood-shape:${made}`,discovery,{source:'wood',product:made,impact:a.impact,...(a.orientation?{orientation:a.orientation}:{})});
      if(made==='plank')return ok('The wood splits into five wooden planks, each 0.20 metres thick.');
      if(made==='door_half_up'||made==='door_half_down')return ok(`The wood changes shape. You now hold the ${made==='door_half_up'?'upper':'lower'} half of a rustic wooden door.`);
      return ok(`The wood changes shape under the strike. You now hold a wooden ${made.replaceAll('_',' ')}.`);
    }
    if(a.action==='join'){
      const inventory=e.inventory;if(!inventory)return fail('You have no wooden door halves to join.');
      const upper=inventory.stacks.findIndex(stack=>stack.kind==='door_half_up'&&stack.count>0),lower=inventory.stacks.findIndex(stack=>stack.kind==='door_half_down'&&stack.count>0);
      if(upper<0||lower<0)return fail('You need one upper and one lower wooden door half to join them.');
      const joined=exchangeInventory(inventory,[{index:upper,count:1},{index:lower,count:1}],[{kind:'door',count:1}],true);
      if(!joined)return fail('No inventory space for the joined door. Put something down first.');
      e.inventory=joined;this.discover(e.id,'wood-shape:door','Discovered that an upper and lower wooden door half join into a rustic door.',{source:'wood',product:'door'});
      return ok('You join the upper and lower wooden halves into a rustic plank door.');
    }
    const target = a.target;
    if (!Array.isArray(target) || target.length !== 3 || !target.every(Number.isInteger) || !this.inside(target)) return fail('Target must be an integer voxel coordinate inside the world.');
    const point = center(target);
    const kind = this.voxels.get(target);
    const surfaceAction=!!kind&&(a.action==='hit'||a.action==='dig'||a.action==='fill');
    if(surfaceAction){
      if(!this.blockInReach(e,target)){
        const nearest=target.map((v,i)=>Math.max(v,Math.min(v+1,this.eye(e)[i]))) as Vec3;
        return fail(distance(this.eye(e),nearest)>3?'That block is farther than 3 metres from your hands.':'Another block hides the reachable surface. Move or look for an exposed face.');
      }
    }else{
      if(distance(this.eye(e),point)>3)return fail('That cell is farther than 3 metres from your hands.');
      if(!this.voxels.clearLine(this.eye(e),point,true))return fail('Another block obstructs that cell.');
    }
    if (a.action === 'place') {
      const held=this.held(e);if(!held)return fail('Your hands are empty.');
      if(held.contents)return fail('Empty this object before placing it as a fixed object.');
      if (kind) return fail('That cell is occupied.');
      if (this.cellOccupied(target)) return fail('A creature occupies that cell.');
      if(!rawBlock(held.kind)){
        if(!this.voxels.solid([target[0]+.5,target[1]-.01,target[2]+.5]))return fail('A placed object needs solid ground directly beneath it.');
        const placed=held.kind,placedY=placed==='door_half_down'?target[1]+.45:placed==='door_half_up'?target[1]+1.35:placed==='door'?target[1]+.95:target[1]+.09;this.bodies.push({id:`item-${this.tick}-${this.nextBody++}`,kind:placed,position:[point[0],placedY,point[2]],velocity:[0,0,0],resting:true});this.consume(e);
        return ok(`You set the ${placed} down on the ground. It remains a loose object that can be picked up.`);
      }
      if (![[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]].some(d => this.voxels.solid(target.map((v,i) => v + d[i]) as Vec3))) return fail('A placed block needs an adjacent solid block.');
      const material = held.kind; this.voxels.set(target, material); this.consume(e); return ok(`Placed one ${material}.`);
    }
    if (a.action === 'hit'||a.action==='dig') {
      const held=this.held(e),usingShovel=held?.kind==='shovel';
      if(a.action==='dig'&&!usingShovel)return fail('Hold a shovel before digging.');
      if(held&&!usingShovel)return fail('You cannot strike the world while holding an object. Store, place, or throw it first.');
      if (!kind) return fail('There is nothing to hit.');
      if(usingShovel&&!['sand','dirt','grass'].includes(kind))return fail('The wooden shovel can remove only sand, dirt, or grass in one strike.');
      const supported=this.standingOn(target);
      if(supported)return fail(`You cannot strike that block because ${supported.name} is standing on it.`);
      e.yaw=((Math.atan2(point[0]-e.position[0],point[2]-e.position[2])*180/Math.PI)%360+360)%360;
      const voxel=key(target),damage=(this.blockDamage.get(voxel)??0)+1;
      if(!usingShovel&&damage<3){this.blockDamage.set(voxel,damage);this.event(e.id,'damage',`${kind} cracked (${damage}/3).`,{target,damage});return ok(damage===1?`You strike the ${kind}. Thin cracks appear, but the block remains intact. Another strike on the same block could deepen them.`:`You strike the ${kind} again. The cracks spread; one more solid hit should break it.`);}
      this.blockDamage.delete(voxel);this.voxels.set(target,null);const sawCollapse=this.collapseUnsupportedTree(target,e);this.wakeBodies();if(!usingShovel)this.discover(e.id,'blocks-break-after-three-hits',`Discovered that repeated strikes break blocks after three hits.`,{material:kind,target,hits:3});
      const collected=kind==='plant'?'stick':kind,heldResult=this.canHold(e,collected);
      if(heldResult.ok)this.addInventory(e,collected,undefined,!usingShovel);
      else this.bodies.push({id:`item-${this.tick}-${this.nextBody++}`,kind:collected,position:center(target),velocity:[0,0,0],resting:false});
      const result=usingShovel
        ?heldResult.ok?`The wooden shovel removes the ${kind} block in one strike. You pick it up.`:`The wooden shovel removes the ${kind}, but it falls loose because your inventory is full.`
        :kind==='plant'
          ?heldResult.ok?'The plant breaks. You pick up a stick.':'The plant breaks, but the stick falls loose because your inventory is full.'
          :heldResult.ok?`The ${kind} block breaks. You pick it up.`:`The ${kind} block breaks and falls loose because your inventory is full.`;
      return ok(result+(sawCollapse?' The unsupported part of the tree falls into loose blocks.':''));
    }
    if (a.action === 'fill') {
      const held=this.held(e);if(!held||held.kind!=='bucket'||held.contents)return fail('You need to hold an empty bucket.');
      if(!kind&&point[1]<this.module.manifest.waterLevel){
        if(!this.replaceHeld(e,{kind:'bucket',count:1,contents:'water'}))return fail('No stack space for a water-filled bucket. Put something down first.');
        return ok('You fill one bucket with water and hold it. The other buckets keep their contents.');
      }
      if(kind!=='dirt'&&kind!=='sand')return fail('The bucket can currently be filled from water, dirt, or sand.');
      const supported=this.standingOn(target);
      if(supported)return fail(`You cannot take that ${kind}; ${supported.name} is standing on it.`);
      if(!this.replaceHeld(e,{kind:'bucket',count:1,contents:kind}))return fail(`No stack space for a ${kind}-filled bucket. Put something down first.`);
      this.voxels.set(target,null);this.blockDamage.delete(key(target));return ok(`You fill one bucket with one block of ${kind} and hold it. The other buckets keep their contents.`);
    }
    if (a.action === 'empty') {
      const held=this.held(e);if(!held||held.kind!=='bucket'||!held.contents)return fail('You need to hold a non-empty bucket.');
      if(held.contents==='water'){
        if(!this.replaceHeld(e,{kind:'bucket',count:1}))return fail('No stack space for an empty bucket. Put something down first.');
        this.event(e.id,'splash','Emptied a bucket of water.',{position:point});return ok('You empty one bucket and hold it. The water splashes and disperses.');
      }
      if(kind)return fail('That cell is occupied.');
      if(this.cellOccupied(target))return fail('A creature occupies that cell.');
      if(!faces.some(d=>this.voxels.solid(target.map((v,i)=>v+d[i]) as Vec3)))return fail('The emptied material needs adjacent support.');
      const contents=held.contents;
      if(!this.replaceHeld(e,{kind:'bucket',count:1}))return fail('No stack space for an empty bucket. Put something down first.');
      this.voxels.set(target,contents);return ok(`You empty one bucket, placing one ${contents} block, and hold the empty bucket.`);
    }
    return fail('Unknown action.');
  }
  private canHold(e: Entity, kind: string, contents?: string) {
    if(!exchangeInventory(e.inventory,[],[{kind,count:1,...(contents?{contents}:{})}]))return fail('No room for this item: at most 10 different stacks, 64 identical items each. Buckets stack only with matching contents.');
    return ok('Space available.');
  }
  private addInventory(e: Entity, kind: string, contents?: string, select=false) {
    const inventory=exchangeInventory(e.inventory,[],[{kind,count:1,...(contents?{contents}:{})}],select);
    if(!inventory)throw new Error('Inventory capacity must be checked before adding resources.');
    e.inventory=inventory;
  }
  private replaceHeld(e:Entity,product:Stack) {
    if(!e.inventory||e.inventory.selected===null)return false;
    const inventory=exchangeInventory(e.inventory,[{index:e.inventory.selected,count:1}],[product],true);
    if(!inventory)return false;
    e.inventory=inventory;return true;
  }
  private consume(e: Entity) {
    if(!e.inventory||e.inventory.selected===null)return;
    const index=e.inventory.selected,stack=e.inventory.stacks[index];
    if(--stack.count===0){e.inventory.stacks.splice(index,1);e.inventory.selected=e.inventory.stacks.length?Math.min(index,e.inventory.stacks.length-1):null;}
    if(!e.inventory.stacks.length)e.inventory=null;
  }
  private wakeBodies() { for (const body of this.bodies) body.resting = false; }
  private learnMovementIssue(e:Entity,issue:MovementIssue){
    if(e.controller!=='agent')return;
    if(issue.kind==='water')this.discover(e.id,'deep-water-limit',knowledgeDescription('deep-water-limit'),{issue});
  }
  private collapseUnsupportedTree(removed:Vec3,observer:Entity){
    const treeKinds=new Set(['wood','leaves']),visited=new Set<string>();
    let sawCollapse=false;
    for(const offset of faces){
      const seed=removed.map((value,index)=>value+offset[index]) as Vec3,seedKind=this.voxels.get(seed);if(!seedKind||!treeKinds.has(seedKind)||visited.has(key(seed)))continue;
      const component:Vec3[]=[],queue=[seed];visited.add(key(seed));
      while(queue.length&&component.length<512){const point=queue.shift()!;component.push(point);for(const face of faces){const next=point.map((value,index)=>value+face[index]) as Vec3,nextKey=key(next),kind=this.voxels.get(next);if(kind&&treeKinds.has(kind)&&!visited.has(nextKey)){visited.add(nextKey);queue.push(next);}}}
      const componentKeys=new Set(component.map(key));
      const supported=component.some(point=>{const below:[number,number,number]=[point[0],point[1]-1,point[2]];return this.voxels.solid(below)&&!componentKeys.has(key(below));});
      if(supported)continue;
      if(component.some(point=>this.visible(observer,center(point),true)))sawCollapse=true;
      for(const point of component){const kind=this.voxels.get(point)!;this.voxels.set(point,null);this.blockDamage.delete(key(point));this.bodies.push({id:`item-${this.tick}-${this.nextBody++}`,kind,position:center(point),velocity:[0,0,0],resting:false});}
      if(component.length)this.event('world','collapse',`An unsupported tree section collapsed into ${component.length} loose blocks.`,{origin:removed,count:component.length});
    }
    return sawCollapse;
  }
  private endFollowing(e:Entity,message:string){
    delete e.following;delete e.motion;e.status='idle';e.lastAction={ok:false,message};
    this.event(e.id,'follow-ended',message);
  }
  private bounceEntity(e:Entity,other:Entity,actionOrigin:Vec3){
    const dx=e.position[0]-other.position[0],dz=e.position[2]-other.position[2],separation=Math.hypot(dx,dz);
    const base=separation>.001?Math.atan2(dx,dz):((e.yaw+180)*Math.PI/180);
    const own=e.hitbox?.radius??.36,theirs=other.hitbox?.radius??.36;
    const push=Math.max(.16,own+theirs+.08-separation);
    let destination:Vec3|undefined;
    // Every candidate passes the normal terrain, water, bounds, body and support checks.
    for(const scale of [1,.65,.35]){
      for(const offset of [0,-35,35,-70,70]){
        const angle=base+offset*Math.PI/180;
        const candidate=this.movementPoint(e,e.position[0]+Math.sin(angle)*push*scale,e.position[2]+Math.cos(angle)*push*scale,e.position[1]);
        if(candidate.point){destination=candidate.point;break;}
      }
      if(destination)break;
    }
    const issue:MovementIssue={kind:'entity',entity:other.name,entityId:other.id,message:`You collide with ${other.name}.`};
    if(e.following)e.following.blocked=issue;
    if(destination)e.motion={kind:'bounce',origin:clone(e.position),destination,speed:2.4};
    else delete e.motion;
    e.status=destination?'bouncing':e.following?'following':'idle';
    e.lastAction={ok:false,message:destination?`You collide with ${other.name} and bounce back safely.`:`You collide with ${other.name} and stop; there is no safe place to rebound.`,feedback:{outcome:'collision',from:actionOrigin,to:clone(e.position),otherId:other.id,other:other.name,rebound:destination??null,distanceTravelled:distance(actionOrigin,e.position)}};
    this.event(e.id,'collision',e.lastAction.message,e.lastAction.feedback);
  }
  private collide(e:Entity,issue:MovementIssue){
    const other=issue.entityId?this.entities.find(candidate=>candidate.id===issue.entityId):undefined;
    if(!other){delete e.motion;e.status=e.following?'following':'idle';return;}
    const origin=e.motion?.origin??clone(e.position),otherOrigin=other.motion?.origin??clone(other.position);
    this.bounceEntity(e,other,origin);
    if(other.motion?.kind!=='bounce')this.bounceEntity(other,e,otherOrigin);
  }
  private advanceBounce(e:Entity){
    const motion=e.motion!,dx=motion.destination[0]-e.position[0],dz=motion.destination[2]-e.position[2],metres=Math.hypot(dx,dz);
    const step=Math.min(metres,motion.speed/TICKS_PER_SECOND);
    if(metres>.001){
      const next=this.movementPoint(e,e.position[0]+dx/metres*step,e.position[2]+dz/metres*step,e.position[1]);
      if(next.point)e.position=next.point;
      else{delete e.motion;e.status=e.following?'following':'idle';return;}
    }
    if(metres<=step+.001){e.position=clone(motion.destination);delete e.motion;e.status=e.following?'following':'idle';}
  }
  private advanceFollowing(e:Entity){
    const following=e.following!,target=this.entities.find(other=>other.id===following.entityId);
    if(!target||!this.active(target)||distance(e.position,target.position)>20||!this.voxels.clearLine(this.eye(e),this.eye(target))){this.endFollowing(e,'You lose direct contact with the entity you were following. Choose another action.');return;}
    const dx=target.position[0]-e.position[0],dz=target.position[2]-e.position[2],metres=Math.hypot(dx,dz);
    e.yaw=((Math.atan2(dx,dz)*180/Math.PI)%360+360)%360;
    if(metres<=1.0001||following.blocked){delete e.motion;e.status='following';return;}
    const speed=this.module.movementSpeed?.(e,e.position,2)??2;
    const step=Math.min(speed/TICKS_PER_SECOND,metres-1),next=this.movementPoint(e,e.position[0]+dx/metres*step,e.position[2]+dz/metres*step,e.position[1]);
    if(!next.point){
      following.blocked=next.issue;if(next.issue?.kind==='entity'){this.collide(e,next.issue);return;}delete e.motion;this.learnMovementIssue(e,next.issue!);
      e.lastAction={ok:false,message:`You stop following the path. ${next.issue!.message} Use stop_follow to choose another action.`,feedback:{issue:next.issue}};
      this.event(e.id,'follow-blocked',e.lastAction.message,e.lastAction.feedback);return;
    }
    const origin=clone(e.position);e.position=next.point;e.status='following';
    e.motion={kind:'walk',origin,destination:clone(next.point),speed};
  }
  step(beforePhysics?: () => void) {
    this.tick++;
    // Commands belong to this step, so a boundary snapshot cannot see future actions.
    beforePhysics?.();
    for (const e of this.entities) {
      if (!this.active(e)) continue;
      if (e.speech && e.speech.until < this.time) delete e.speech;
      if(e.motion?.kind==='bounce'){this.advanceBounce(e);continue;}
      if(e.following){this.advanceFollowing(e);continue;}
      if (e.controller === 'wander' && !e.motion && this.tick % 60 === 0) {
        e.yaw = (this.tick * 13.37) % 360;
        // The NPC uses the same collision and depth rules, without adding agent journal noise.
        this.execute(e, { action: 'walk', distance: 1.5 });
      }
      if (!e.motion) continue;
      if(e.motion.kind==='jump'){
        const motion=e.motion,origin=motion.origin!,duration=motion.duration!,progress=Math.min(1,(motion.progress??0)+1/20/duration);motion.progress=progress;
        const candidate=[origin[0]+(motion.destination[0]-origin[0])*progress,origin[1]+(motion.destination[1]-origin[1])*progress+Math.sin(progress*Math.PI)*1.15,origin[2]+(motion.destination[2]-origin[2])*progress] as Vec3;
        const other=this.collidingEntity(e,candidate);
        if(other){this.collide(e,{kind:'entity',entity:other.name,entityId:other.id,message:`You collide with ${other.name}.`});continue;}
        e.position=candidate;
        if(progress>=1){e.position=clone(motion.destination);delete e.motion;e.status='idle';e.lastAction={ok:true,message:`You land safely after jumping ${distance(origin,e.position).toFixed(1)} metres.`,feedback:{outcome:'arrived',from:origin,to:clone(e.position),distanceTravelled:distance(origin,e.position)}};this.event(e.id,'arrived',e.lastAction.message,e.lastAction.feedback);}
        continue;
      }
      const [x, , z] = e.position, dest = e.motion.destination, d = Math.hypot(dest[0] - x, dest[2] - z), speed=this.module.movementSpeed?.(e,e.position,e.motion.speed)??e.motion.speed, step = Math.min(d, speed / 20);
      const next = this.movementPoint(e, x + (dest[0] - x) * step / Math.max(d, .0001), z + (dest[2] - z) * step / Math.max(d, .0001), e.position[1]);
      if (!next.point) { const origin=e.motion.origin??clone(e.position),issue=next.issue!;if(issue.kind==='entity'){this.collide(e,issue);continue;}delete e.motion;e.status='idle';this.learnMovementIssue(e,issue);e.lastAction={ok:false,message:`You stop after ${distance(origin,e.position).toFixed(1)} metres. ${issue.message}`,feedback:{outcome:'blocked',from:origin,to:clone(e.position),distanceTravelled:distance(origin,e.position),issue,availableResponses:this.options(e,issue)}};this.event(e.id,'blocked',e.lastAction.message,e.lastAction.feedback);continue; }
      e.position = next.point;
      if (d <= step + .001) { const origin=e.motion.origin??clone(e.position),kind=e.motion.kind??'walk',issue=e.motion.stopIssue;if(issue?.kind==='entity'){this.collide(e,issue);continue;}delete e.motion;e.status='idle';if(issue)this.learnMovementIssue(e,issue);e.lastAction=issue?{ok:false,message:`You stop after travelling ${distance(origin,e.position).toFixed(1)} metres. ${issue.message}`,feedback:{outcome:'blocked',from:origin,to:clone(e.position),distanceTravelled:distance(origin,e.position),issue,availableResponses:this.options(e,issue)}}:{ok:true,message:`You finish ${kind==='run'?'running':'walking'} after travelling ${distance(origin,e.position).toFixed(1)} metres.`,feedback:{outcome:'arrived',from:origin,to:clone(e.position),distanceTravelled:distance(origin,e.position)}};if(e.controller==='agent')this.event(e.id,issue?'blocked':'arrived',e.lastAction.message,e.lastAction.feedback); }
    }
    for (const body of this.bodies) {
      if (body.resting) continue;
      // Six conservative substeps keep the fastest allowed throw below one voxel per collision test.
      for (let sub = 0; sub < 6; sub++) {
        const dt = 1 / 120, water = this.module.manifest.waterLevel;
        const floats = this.module.manifest.materials[body.kind]?.floats && !body.water && body.contents!=='water';
        body.velocity[1] -= this.module.manifest.gravity * dt;
        if (body.position[1] < water && floats) { body.velocity[1] += (water - body.position[1]) * 35 * dt; body.velocity = body.velocity.map(v => v * .96) as Vec3; }
        for (const axis of [0,1,2]) {
          const next = [...body.position] as Vec3; next[axis] += body.velocity[axis] * dt;
          const collision = [-.28,.28].some(dx => [-.28,.28].some(dy => [-.28,.28].some(dz => this.voxels.solid([next[0]+dx,next[1]+dy,next[2]+dz]))));
          if (collision) { body.velocity[axis] *= -.25; if (axis === 1) { body.velocity[0] *= .8; body.velocity[2] *= .8; } }
          else body.position = next;
        }
        if (Math.hypot(...body.velocity) < .15 && this.voxels.solid([body.position[0],body.position[1]-.32,body.position[2]])) { body.resting = true; body.velocity = [0,0,0]; break; }
      }
    }
    const fixed=new Set<string>();
    for(const body of this.bodies){
      if(!body.resting||!rawBlock(body.kind)||body.contents)continue;
      const target:[number,number,number]=[Math.floor(body.position[0]),Math.floor(body.position[1]),Math.floor(body.position[2])];
      if(this.inside(target)&&!this.voxels.get(target)){this.voxels.set(target,body.kind);fixed.add(body.id);this.event('world','settled',`A ${body.owner?'thrown':'loose'} ${body.kind} settled into the terrain.`,{itemId:body.id,target,kind:body.kind});if(body.owner)this.discover(body.owner,'thrown-blocks-settle','Discovered that thrown blocks settle and become part of the terrain.',{material:body.kind,target});}
    }
    if(fixed.size)this.bodies=this.bodies.filter(body=>!fixed.has(body.id));
    this.bodies = this.bodies.filter(body => {
      if (this.inside(body.position)) return true;
      if(body.owner&&body.position[1]<this.module.manifest.bounds.min[1]&&!this.module.manifest.materials[body.kind]?.floats)this.discover(body.owner,'nonfloating-objects-sink','Discovered that non-floating objects thrown into deep water sink until they are lost.',{material:body.kind,itemId:body.id});
      this.lost++; this.event('world', 'lost', `One ${body.kind} left the bounded world and was lost forever.`, { itemId: body.id, kind: body.kind }); return false;
    });
    this.updateEncounters();
  }
}
