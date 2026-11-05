export type Vec3 = [number, number, number];
export type Block = [number, number, number, string];
export interface Material { color: string; solid: boolean; floats: boolean; stackLimit?: number; vessel?: boolean; fluid?: boolean; breakable?: boolean; }
export interface LayeredTerrain {
  type: 'layers';
  top: number;
  layers: { min: number; kind: string }[];
}
export interface NoiseField { frequency:number; octaves?:number; fractal?:'fbm'|'ridged'|'pingpong'; }
export interface NoiseOre extends NoiseField { kind:string; minY:number; maxY:number; threshold:number; seedOffset:number; }
export interface NoiseTerrain {
  type:'noise';
  floor:{y:number;kind:string};
  stone:string;
  soil:{depth:number;temperate:string;temperateSurface:string;arid:string;aridSurface:string};
  baseHeight:number;
  ceiling:number;
  waterLevel:number;
  hills:NoiseField&{amplitude:number};
  mountains:NoiseField&{amplitude:number;threshold:number};
  biome:NoiseField&{aridThreshold:number};
  dunes:NoiseField&{amplitude:number};
  rivers:NoiseField&{width:number;bankWidth:number;bedHeight:number};
  spawn:{radius:number;blend:number;height:number};
  ores:NoiseOre[];
}
export type ProceduralTerrain = LayeredTerrain | NoiseTerrain;
export interface Stack { kind: string; count: number; contents?: string; water?: boolean; }
export interface Inventory { stacks: Stack[]; selected: number | null; capacity: number; }
export interface MovementIssue { kind: 'boundary' | 'rise' | 'wall' | 'overhang' | 'gap' | 'water' | 'entity' | 'obstructed'; message: string; target?: Vec3; material?: string; height?: number; entity?: string; entityId?: string; itemId?: string; }
export interface AgentIntent {
  identity?: string;
  goal: string;
  successCondition: string;
  assessment?: string;
  status: 'active' | 'completed' | 'abandoned' | 'blocked';
}
export interface Entity {
  id: string; name: string; kind: string; controller: 'agent' | 'wander' | 'static' | 'automaton'; position: Vec3; yaw: number;
  enabled?: boolean;
  height: number; hitbox?: { radius: number; height: number; terrainRadius?:number }; color: string; inventory: Inventory | null;
  status: string; speech?: { word: string; until: number }; speechResponseCooldownUntil?: number;
  speechBudget?: { turn: number; words: number };
  intent?: AgentIntent;
  following?: { entityId: string; blocked?: MovementIssue };
  motion?: { kind?: 'walk' | 'run' | 'reverse' | 'jump' | 'bounce' | 'scan' | 'showcase'; destination: Vec3; speed: number; currentSpeed?: number; inWater?: boolean; origin?: Vec3; progress?: number; duration?: number; startYaw?: number; stopIssue?: MovementIssue; requestedDistance?: number; scanType?: 'find_material' | 'find_entity'; result?: ActionResult };
  lastAction?: ActionResult;
  automation?: Record<string, unknown>;
  appearance?: { material?:string; widthScale?:number; metalness?:number; roughness?:number; powerModule?:'lithium-battery'|'nuclear-reactor' };
}
export interface DoorState { angle: 0 | 90; outsideYaw: number; }
export interface Body { id: string; kind: string; position: Vec3; velocity: Vec3; contents?: string; water?: boolean; resting: boolean; owner?: string; settleAfter?: number; impactTicks?:Record<string,number>; door?:DoorState; }
export interface WorldEvent { id: number; tick: number; time: number; day: number; actor: string; type: string; message: string; data?: unknown; }
export interface EncounterNotice { eventId:number; tick:number; otherId:string; otherName:string; message:string; }
export interface TerrainNotice { eventId:number; tick:number; target:Vec3; kind:string; message:string; }
export interface BlockImpactNotice { eventId:number; tick:number; itemId:string; kind:string; message:string; }
export interface HeardVoice { eventId: number; from: string; word: string; tick: number; speakerId?: string; direction?: string; distance?: number; }
export interface EntitySighting extends Pick<Entity,'id'|'name'|'kind'|'position'> { holding: Pick<Stack,'kind'|'contents'> | null; }
export interface DynamicState { tick: number; time: number; entities: Entity[]; bodies: Body[]; lost: number; inbox: Record<string, HeardVoice[]>; blockDamage: Record<string, number>; discoveries: Record<string, string[]>; contacts:Record<string,string[]>; encounterNotices:Record<string,EncounterNotice[]>; terrainNotices:Record<string,TerrainNotice[]>; impactNotices?:Record<string,BlockImpactNotice[]>; }
export interface WorldState extends DynamicState { blocks: Block[]; removedBlocks?: string[]; }
export interface Frame extends DynamicState { changes: [string, string | null][]; events: WorldEvent[]; }
export interface UniverseManifest {
  id: string; version: number; name: string; description: string; seed: number;
  bounds: { min: Vec3; max: Vec3 }; waterLevel: number; gravity: number;
  infiniteHorizontal?: boolean;
  terrain?: ProceduralTerrain;
  view?: { overviewPosition: Vec3; overviewTarget: Vec3; maxDistance?: number; fog?: { near: number; far: number } };
  daySeconds: number; materials: Record<string, Material>; vocabulary: string[];
  perception: { range: number; fieldOfView: number; maxBlocks: number };
  agentInstructions: string;
}
export interface Action { action: 'walk' | 'run' | 'reverse' | 'jump' | 'turn' | 'wait' | 'find_material' | 'find_entity' | 'place' | 'throw' | 'pickup' | 'hit' | 'dig' | 'strike_held' | 'join' | 'open' | 'close' | 'fill' | 'empty' | 'hold' | 'store' | 'say' | 'follow' | 'stop_follow'; distance?: number; angle?: number; x?: number; y?: number; z?: number; target?: Vec3; impact?: Vec3; orientation?: 'up' | 'down'; itemId?: string; entityId?: string; word?: string; force?: number; stack?: number; }
export interface NavigationPath { direction: 'forward-left' | 'forward' | 'forward-right'; turn: number; clearance: number; approach?: { distance:number; angle:number }; jump?: { distance:number; angle:number }; }
export interface NavigationReport { checkedDistance: number; paths: (NavigationPath & { issue?: MovementIssue; options?: string[] })[]; blockedAfter?: number; }
export interface ActionResult { ok: boolean; message: string; navigation?: NavigationReport; feedback?: Record<string, unknown>; }
export interface InteractionTargets {
  hit: { target: Vec3; kind: string; cracks: number }[];
  pickup: { itemId: string; kind: string; metres: number }[];
  speak: { id: string; name: string }[];
  follow: { id: string; name: string; metres: number }[];
  place: Vec3[];
  fill: Vec3[];
  empty: Vec3[];
  open: { itemId:string; kind:'door'; metres:number; angle:0; outsideYaw:number }[];
  close: { itemId:string; kind:'door'; metres:number; angle:90; outsideYaw:number }[];
}
export interface Observation {
  tick: number; time: number; self: Entity; blocks: Block[];
  entities: EntitySighting[];
  items: Body[]; heard: HeardVoice[];
  following?: { entityId: string; name: string; metres?: number; direction?: string; message: string };
  beingFollowed?: { id: string; name: string; message: string }[];
  encounters: (EncounterNotice & {canSpeakNow:boolean})[];
  terrainChanges: TerrainNotice[];
  impacts: BlockImpactNotice[];
  surfaces: { kind: string; count: number; nearest: Vec3 }[];
  navigation: NavigationReport;
  interactions: InteractionTargets;
  description: string; truncated: boolean;
}
export interface WorldStateMigration {
  state: WorldState;
  events: { actor: string; type: string; message: string; data?: unknown }[];
}
export interface WanderContext { tick: number; clearDistance(yaw: number, distance: number): number; }
export interface UniverseModule {
  manifest: UniverseManifest;
  generate(): { blocks: Block[]; entities: Entity[] };
  migrateState?(state: WorldState): WorldStateMigration | undefined;
  initializeAutomaton?(entity: Entity): void;
  automatonAction?(entity: Entity): Action | undefined;
  wanderAction?(entity: Entity, context: WanderContext): Action | undefined;
  transformHit?(kind: string, impact: Vec3, orientation?: 'up' | 'down'): string | null;
  canEnter?(entity: Entity, feet: Vec3, inWater?: boolean): ActionResult;
  waterSurfaceHeight?(entity: Entity, x: number, z: number): number | undefined;
  movementStepHeight?(entity: Entity): number;
  movementInertia?(entity: Entity): { acceleration: number; deceleration: number } | undefined;
  movementSpeed?(entity:Entity,feet:Vec3,speed:number,inWater?:boolean):number;
  describeObstacle?(issue: MovementIssue): string | undefined;
  encounterMessage?(observer:Entity,other:Entity,metres:number):string|undefined;
  relevantKnowledge?(observation:Observation,knowledge:string):boolean;
  respondToSpeech?(listener:Entity,speaker:Entity,word:string):string|{word:string;faceSpeaker?:boolean;cooldownSeconds?:number}|undefined;
}
export const key = (p: Vec3) => p.join(',');
export const unkey = (value: string): Vec3 => value.split(',').map(Number) as Vec3;
export const distance = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const clone = <T>(value: T): T => structuredClone(value);
