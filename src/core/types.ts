export type Vec3 = [number, number, number];
export type Block = [number, number, number, string];
export interface Material { color: string; solid: boolean; floats: boolean; stackLimit?: number; vessel?: boolean; }
export interface Stack { kind: string; count: number; contents?: string; water?: boolean; }
export interface Inventory { stacks: Stack[]; selected: number | null; capacity: number; }
export interface MovementIssue { kind: 'boundary' | 'rise' | 'wall' | 'gap' | 'water' | 'entity' | 'obstructed'; message: string; target?: Vec3; material?: string; height?: number; entity?: string; }
export interface Entity {
  id: string; name: string; kind: string; controller: 'agent' | 'wander'; position: Vec3; yaw: number;
  enabled?: boolean;
  height: number; color: string; inventory: Inventory | null;
  status: string; speech?: { word: string; until: number };
  motion?: { kind?: 'walk' | 'run' | 'jump'; destination: Vec3; speed: number; origin?: Vec3; progress?: number; duration?: number; stopIssue?: MovementIssue; requestedDistance?: number };
  lastAction?: ActionResult;
}
export interface Body { id: string; kind: string; position: Vec3; velocity: Vec3; contents?: string; water?: boolean; resting: boolean; owner?: string; }
export interface WorldEvent { id: number; tick: number; time: number; day: number; actor: string; type: string; message: string; data?: unknown; }
export interface EncounterNotice { eventId:number; tick:number; otherId:string; otherName:string; message:string; }
export interface DynamicState { tick: number; time: number; entities: Entity[]; bodies: Body[]; lost: number; inbox: Record<string, { from: string; word: string; tick: number }[]>; blockDamage: Record<string, number>; discoveries: Record<string, string[]>; contacts:Record<string,string[]>; encounterNotices:Record<string,EncounterNotice[]>; }
export interface WorldState extends DynamicState { blocks: Block[]; }
export interface Frame extends DynamicState { changes: [string, string | null][]; events: WorldEvent[]; }
export interface ModuleManifest {
  id: string; version: number; name: string; description: string; seed: number;
  bounds: { min: Vec3; max: Vec3 }; waterLevel: number; gravity: number;
  daySeconds: number; materials: Record<string, Material>; vocabulary: string[];
  perception: { range: number; fieldOfView: number; maxBlocks: number };
  agentInstructions: string;
}
export interface Action { action: 'walk' | 'run' | 'jump' | 'turn' | 'wait' | 'place' | 'throw' | 'pickup' | 'hit' | 'strike_held' | 'fill' | 'empty' | 'hold' | 'store' | 'say'; distance?: number; angle?: number; target?: Vec3; impact?: Vec3; itemId?: string; word?: string; force?: number; stack?: number; }
export interface NavigationPath { direction: 'forward-left' | 'forward' | 'forward-right'; turn: number; clearance: number; approach?: { distance:number; angle:number }; jump?: { distance:number; angle:number }; }
export interface NavigationReport { checkedDistance: number; paths: (NavigationPath & { issue?: MovementIssue; options?: string[] })[]; blockedAfter?: number; }
export interface ActionResult { ok: boolean; message: string; navigation?: NavigationReport; feedback?: Record<string, unknown>; }
export interface Observation {
  tick: number; time: number; self: Entity; blocks: Block[];
  entities: Pick<Entity, 'id' | 'name' | 'kind' | 'position'>[];
  items: Body[]; heard: { from: string; word: string; tick: number }[];
  encounters: (EncounterNotice & {canSpeakNow:boolean})[];
  surfaces: { kind: string; count: number; nearest: Vec3 }[];
  navigation: NavigationReport;
  description: string; truncated: boolean;
}
export interface WorldModule {
  manifest: ModuleManifest;
  generate(): { blocks: Block[]; entities: Entity[] };
  transformHit(kind: string, impact: Vec3): string | null;
  canEnter(entity: Entity, feet: Vec3): ActionResult;
  describeObstacle?(issue: MovementIssue): string | undefined;
  encounterMessage?(observer:Entity,other:Entity,metres:number):string|undefined;
}
export const key = (p: Vec3) => p.join(',');
export const unkey = (value: string): Vec3 => value.split(',').map(Number) as Vec3;
export const distance = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const clone = <T>(value: T): T => structuredClone(value);
