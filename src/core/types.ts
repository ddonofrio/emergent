export type Vec3 = [number, number, number];
export type Block = [number, number, number, string];
export interface Material { color: string; solid: boolean; floats: boolean; stackLimit?: number; vessel?: boolean; }
export interface Stack { kind: string; count: number; water?: boolean; }
export interface Entity {
  id: string; name: string; kind: string; controller: 'agent' | 'wander'; position: Vec3; yaw: number;
  enabled?: boolean;
  height: number; color: string; inventory: Stack | null;
  status: string; speech?: { word: string; until: number };
  motion?: { destination: Vec3; speed: number };
}
export interface Body { id: string; kind: string; position: Vec3; velocity: Vec3; water?: boolean; resting: boolean; }
export interface WorldEvent { id: number; tick: number; time: number; day: number; actor: string; type: string; message: string; data?: unknown; }
export interface DynamicState { tick: number; time: number; entities: Entity[]; bodies: Body[]; lost: number; inbox: Record<string, { from: string; word: string; tick: number }[]>; }
export interface WorldState extends DynamicState { blocks: Block[]; }
export interface Frame extends DynamicState { changes: [string, string | null][]; events: WorldEvent[]; }
export interface ModuleManifest {
  id: string; version: number; name: string; description: string; seed: number;
  bounds: { min: Vec3; max: Vec3 }; waterLevel: number; gravity: number;
  daySeconds: number; materials: Record<string, Material>; vocabulary: string[];
  perception: { range: number; fieldOfView: number; maxBlocks: number };
  agentInstructions: string;
}
export interface Action { action: 'move' | 'turn' | 'wait' | 'remove' | 'place' | 'throw' | 'pickup' | 'hit' | 'fill' | 'pour' | 'say'; distance?: number; angle?: number; target?: Vec3; impact?: Vec3; itemId?: string; word?: string; force?: number; }
export interface NavigationPath { direction: 'forward-left' | 'forward' | 'forward-right'; turn: -45 | 0 | 45; clearance: number; }
export interface NavigationReport { checkedDistance: number; paths: NavigationPath[]; blockedAfter?: number; }
export interface ActionResult { ok: boolean; message: string; navigation?: NavigationReport; }
export interface Observation {
  tick: number; time: number; self: Entity; blocks: Block[];
  entities: Pick<Entity, 'id' | 'name' | 'kind' | 'position'>[];
  items: Body[]; heard: { from: string; word: string; tick: number }[];
  surfaces: { kind: string; count: number; nearest: Vec3 }[];
  navigation: NavigationReport;
  description: string; truncated: boolean;
}
export interface WorldModule {
  manifest: ModuleManifest;
  generate(): { blocks: Block[]; entities: Entity[] };
  transformHit(kind: string, impact: Vec3): string | null;
  canEnter(entity: Entity, feet: Vec3): ActionResult;
}
export const key = (p: Vec3) => p.join(',');
export const unkey = (value: string): Vec3 => value.split(',').map(Number) as Vec3;
export const distance = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const clone = <T>(value: T): T => structuredClone(value);
