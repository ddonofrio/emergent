import { Voxels } from './voxels';
import { TICKS_PER_SECOND } from './time';
import { clone, distance, key, type Action, type ActionResult, type Body, type Entity, type Frame, type NavigationPath, type NavigationReport, type Observation, type Vec3, type WorldEvent, type WorldModule, type WorldState } from './types';

const ok = (message: string): ActionResult => ({ ok: true, message });
const fail = (message: string, navigation?: NavigationReport): ActionResult => ({ ok: false, message, ...(navigation ? { navigation } : {}) });
const center = (p: Vec3): Vec3 => p.map(v => v + .5) as Vec3;
const faces: Vec3[] = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];

export class Engine {
  readonly voxels: Voxels;
  entities: Entity[];
  bodies: Body[] = [];
  tick = 0;
  lost = 0;
  nextEvent = 1;
  private nextBody = 1;
  private pendingEvents: WorldEvent[] = [];
  readonly recentEvents: WorldEvent[] = [];
  readonly inbox = new Map<string, { from: string; word: string; tick: number }[]>();
  constructor(readonly module: WorldModule, state?: WorldState) {
    const initial = state ?? module.generate();
    this.voxels = new Voxels(module.manifest.materials, initial.blocks);
    this.entities = clone(initial.entities).map(entity => ({ ...entity, enabled: entity.enabled !== false }));
    if (state) {
      this.tick = state.tick; this.bodies = clone(state.bodies); this.lost = state.lost;
      for (const [id, messages] of Object.entries(state.inbox ?? {})) this.inbox.set(id, clone(messages));
    }
  }
  get time() { return this.tick / TICKS_PER_SECOND; }
  get day() { return Math.floor(this.time / this.module.manifest.daySeconds) + 1; }
  entity(id: string) { const entity = this.entities.find(e => e.id === id); if (!entity) throw new Error('Unknown entity.'); return entity; }
  active(entity: Entity) { return entity.enabled !== false; }
  setEntityEnabled(id: string, enabled: boolean) {
    const entity = this.entity(id);
    if (this.active(entity) === enabled) return false;
    entity.enabled = enabled; delete entity.motion; delete entity.speech;
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
  state(): WorldState { return { ...this.dynamic(), blocks: this.voxels.serialize() }; }
  dynamic() { return clone({ tick: this.tick, time: this.time, entities: this.entities, bodies: this.bodies, lost: this.lost, inbox: Object.fromEntries(this.inbox) }); }
  frame(): Frame {
    const frame = { ...this.dynamic(), changes: [...this.voxels.changes], events: this.pendingEvents.splice(0) };
    this.voxels.changes.clear(); return frame;
  }
  inside(p: Vec3) { return p.every((v, i) => v >= this.module.manifest.bounds.min[i] && v < this.module.manifest.bounds.max[i]); }
  eye(e: Entity): Vec3 { return [e.position[0], e.position[1] + e.height * .85, e.position[2]]; }
  visible(e: Entity, point: Vec3, ignoreEnd = false) {
    const eye = this.eye(e), d = distance(eye, point);
    if (d > this.module.manifest.perception.range) return false;
    const angle = Math.atan2(point[0] - eye[0], point[2] - eye[2]);
    const difference = Math.atan2(Math.sin(angle - e.yaw * Math.PI / 180), Math.cos(angle - e.yaw * Math.PI / 180));
    return (d < 1.6 || Math.abs(difference) <= this.module.manifest.perception.fieldOfView * Math.PI / 360) && this.voxels.clearLine(eye, point, ignoreEnd);
  }
  observe(id: string): Observation {
    const e = this.entity(id), eye = this.eye(e), { range, maxBlocks } = this.module.manifest.perception;
    const blocks = this.voxels.nearby(eye, range).filter(b => {
      const p = b.slice(0,3) as Vec3;
      return faces.some(face => {
        if (this.voxels.solid(p.map((v,i) => v+face[i]) as Vec3)) return false;
        const surface = p.map((v,i) => v+.5+face[i]*.5001) as Vec3;
        if (face.reduce((sum,v,i) => sum+v*(eye[i]-surface[i]),0) <= 0) return false;
        return this.visible(e,surface);
      });
    })
      .sort((a, b) => distance(eye, center(a.slice(0, 3) as Vec3)) - distance(eye, center(b.slice(0, 3) as Vec3)));
    const surfaces = new Map<string,{kind:string;count:number;nearest:Vec3}>();
    for (const b of blocks) { const summary = surfaces.get(b[3]); if (summary) summary.count++; else surfaces.set(b[3],{kind:b[3],count:1,nearest:b.slice(0,3) as Vec3}); }
    // Preserve nearby reach targets and a representative of every visible material.
    const samples = new Map(blocks.slice(0,Math.max(0,maxBlocks-surfaces.size)).map(b => [key(b.slice(0,3) as Vec3),b]));
    for (const surface of surfaces.values()) { const b = blocks.find(b => b[3]===surface.kind)!; samples.set(key(surface.nearest),b); }
    const entities = this.entities.filter(other => other.id !== id && this.active(other) && this.visible(e, this.eye(other))).map(({ id, name, kind, position }) => ({ id, name, kind, position: clone(position) }));
    const navigation = this.navigationReport(e);
    return { tick: this.tick, time: this.time, self: clone(e), blocks: [...samples.values()].slice(0,maxBlocks), surfaces: [...surfaces.values()], entities,
      items: clone(this.bodies.filter(b => this.visible(e, b.position))), heard: clone((this.inbox.get(id) ?? []).filter(m => this.tick - m.tick < 1200)),
      navigation,
      description: `Facing ${Math.round(e.yaw)} degrees. ${blocks.length} visible blocks, ${entities.length} visible creatures. Water surface: Y=${this.module.manifest.waterLevel}. ${this.module.manifest.waterLevel > e.position[1] ? 'Your feet are in water.' : 'Your feet are dry.'} Navigation paths give collision-checked clearance through visible space; turn is relative to your current facing. Only visible surfaces are listed; occluded and distant space is unknown.`, truncated: blocks.length > maxBlocks };
  }
  private footAt(x: number, z: number, from: number, height: number): Vec3 | null {
    // Find the first reachable support, never teleport through a wall or a canopy.
    for (let y = Math.floor(from + 1.001); y >= Math.floor(from - 1.001); y--) {
      if (!this.voxels.solid([x, y - .01, z])) continue;
      let clear = true;
      for (const dx of [-.23, .23]) for (const dz of [-.23, .23]) for (let dy = .05; dy < height; dy += .3) {
        if (this.voxels.solid([x + dx, y + dy, z + dz])) clear = false;
      }
      if (clear) return [x, y, z];
    }
    return null;
  }
  private movementPoint(e: Entity, x: number, z: number, from: number): { point?: Vec3; reason?: string } {
    if (!this.inside([x, from, z])) return { reason: 'World boundary.' };
    const point = this.footAt(x, z, from, e.height);
    if (!point) return { reason: 'No reachable support, or the path is obstructed.' };
    const allowed = this.module.canEnter(e, point);
    if (!allowed.ok) return { reason: allowed.message };
    if (this.entities.some(other => other.id !== e.id && this.active(other) && Math.hypot(other.position[0] - x, other.position[2] - z) < .55 && Math.abs(other.position[1] - point[1]) < 1)) return { reason: 'Another creature is in the way.' };
    return { point };
  }
  private traceMovement(e: Entity, yaw: number, requestedDistance: number): { destination?: Vec3; clearance: number; reason?: string } {
    const angle = yaw * Math.PI / 180, count = Math.ceil(requestedDistance / .15);
    let destination = e.position;
    for (let i = 1; i <= count; i++) {
      const travelled = requestedDistance * i / count;
      const step = this.movementPoint(e, e.position[0] + Math.sin(angle) * travelled, e.position[2] + Math.cos(angle) * travelled, destination[1]);
      if (!step.point) return { clearance: requestedDistance * (i - 1) / count, reason: step.reason };
      destination = step.point;
    }
    return { destination, clearance: requestedDistance };
  }
  private navigationReport(e: Entity, checkedDistance = 3, blockedAfter?: number): NavigationReport {
    const headings: Pick<NavigationPath, 'direction' | 'turn'>[] = [
      { direction: 'forward-left', turn: -45 },
      { direction: 'forward', turn: 0 },
      { direction: 'forward-right', turn: 45 },
    ];
    const paths = headings.map(({ direction, turn }) => ({
      direction,
      turn,
      clearance: Math.floor(this.traceMovement(e, e.yaw + turn, checkedDistance).clearance * 10) / 10,
    }));
    return { checkedDistance, paths, ...(blockedAfter === undefined ? {} : { blockedAfter: Math.floor(blockedAfter * 10) / 10 }) };
  }
  act(id: string, action: Action): ActionResult {
    const e = this.entity(id);
    if (!this.active(e)) return fail('This entity is disabled.');
    let result: ActionResult;
    try { result = this.execute(e, action); }
    catch (error) { result = fail(error instanceof Error ? error.message : 'Invalid action.'); }
    this.event(id, result.ok ? 'action' : 'rejected', result.message, { action, result });
    return result;
  }
  private execute(e: Entity, a: Action): ActionResult {
    if (e.motion) return fail('Wait until your movement finishes.');
    if (a.action === 'wait') { e.status = 'idle'; return ok('Waiting and watching.'); }
    if (a.action === 'turn') {
      if (!Number.isFinite(a.angle) || Math.abs(a.angle!) > 360) return fail('Turn angle must be between -360 and 360 degrees.');
      e.yaw = ((e.yaw + a.angle!) % 360 + 360) % 360; return ok(`Turned to ${Math.round(e.yaw)} degrees.`);
    }
    if (a.action === 'move') {
      if (!Number.isFinite(a.distance) || a.distance! <= 0 || a.distance! > 8) return fail('Move distance must be greater than zero and at most 8 metres.');
      const route = this.traceMovement(e, e.yaw, a.distance!);
      if (!route.destination) {
        const navigation = this.navigationReport(e, Math.min(3, a.distance!), route.clearance);
        return fail(`${route.reason} You did not move; the attempted route stays clear for about ${navigation.blockedAfter!.toFixed(1)} metres.`, navigation);
      }
      e.motion = { destination: route.destination, speed: e.controller === 'wander' ? 1 : 2 }; e.status = 'walking';
      return ok(`Walking ${a.distance!.toFixed(1)} metres.`);
    }
    if (a.action === 'say') {
      if (!this.module.manifest.vocabulary.includes(a.word!)) return fail('That word is not in your vocabulary.');
      const recipients = this.entities.filter(other => other.id !== e.id && this.active(other) && other.controller === 'agent' && distance(this.eye(e), this.eye(other)) <= 10 && this.voxels.clearLine(this.eye(e), this.eye(other)));
      for (const other of recipients) {
        const inbox = this.inbox.get(other.id) ?? []; inbox.push({ from: e.name, word: a.word!, tick: this.tick });
        this.inbox.set(other.id, inbox.slice(-16));
      }
      e.speech = { word: a.word!, until: this.time + 4 };
      return ok(`Said "${a.word}". Heard by ${recipients.map(r => r.name).join(', ') || 'nobody'}.`);
    }
    if (a.action === 'pickup') {
      const body = this.bodies.find(b => b.id === a.itemId);
      if (!body || distance(this.eye(e), body.position) > 3 || !this.voxels.clearLine(this.eye(e), body.position)) return fail('The item is not within clear reach.');
      const result = this.canHold(e, body.kind);
      if (!result.ok) return result;
      this.addInventory(e, body.kind, body.water); this.bodies = this.bodies.filter(b => b !== body);
      return ok(`Picked up ${body.kind}.`);
    }
    if (a.action === 'throw') {
      if (!e.inventory) return fail('Your hands are empty.');
      const force = a.force ?? 7;
      if (!Number.isFinite(force) || force < 1 || force > 12) return fail('Throw force must be between 1 and 12.');
      const angle = e.yaw * Math.PI / 180;
      const start: Vec3 = [e.position[0] + Math.sin(angle) * .8, e.position[1] + 1.3, e.position[2] + Math.cos(angle) * .8];
      if (this.voxels.solid(start) || !this.voxels.clearLine(this.eye(e), start)) return fail('There is no room to throw.');
      const { kind, water } = e.inventory;
      this.bodies.push({ id: `item-${this.tick}-${this.nextBody++}`, kind, ...(water === undefined ? {} : { water }), position: start, velocity: [Math.sin(angle) * force, force * .6, Math.cos(angle) * force], resting: false });
      this.consume(e); return ok(`Threw one ${kind}.`);
    }
    const target = a.target;
    if (!Array.isArray(target) || target.length !== 3 || !target.every(Number.isInteger) || !this.inside(target)) return fail('Target must be an integer voxel coordinate inside the world.');
    const point = center(target);
    if (distance(this.eye(e), point) > 3 || !this.voxels.clearLine(this.eye(e), point, true)) return fail('Target is beyond clear arm reach (3 metres).');
    const kind = this.voxels.get(target);
    if (a.action === 'remove') {
      if (!kind) return fail('There is no block there.');
      if (this.entities.some(other => this.active(other) && Math.floor(other.position[0]) === target[0] && Math.floor(other.position[2]) === target[2] && Math.abs(other.position[1] - (target[1] + 1)) < .05)) return fail('A creature is standing on that block.');
      const result = this.canHold(e, kind); if (!result.ok) return result;
      this.voxels.set(target, null); this.addInventory(e, kind); this.wakeBodies(); return ok(`Removed one ${kind}.`);
    }
    if (a.action === 'place') {
      if (!e.inventory) return fail('Your hands are empty.');
      if (this.module.manifest.materials[e.inventory.kind]?.vessel) return fail('This is a vessel; throw it gently to set it down.');
      if (kind) return fail('That cell is occupied.');
      if (this.entities.some(other => this.active(other) && Math.abs(other.position[0] - point[0]) < .8 && Math.abs(other.position[2] - point[2]) < .8 && target[1] < other.position[1] + other.height && target[1] + 1 > other.position[1])) return fail('A creature occupies that cell.');
      if (![[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]].some(d => this.voxels.solid(target.map((v,i) => v + d[i]) as Vec3))) return fail('A placed block needs an adjacent solid block.');
      const material = e.inventory.kind; this.voxels.set(target, material); this.consume(e); return ok(`Placed one ${material}.`);
    }
    if (a.action === 'hit') {
      if (!kind) return fail('There is nothing to hit.');
      if (!a.impact || a.impact.length !== 3 || !a.impact.every(v => Number.isFinite(v) && v >= 0 && v <= 1)) return fail('Impact must be a local point in [0,1]^3.');
      const transformed = this.module.transformHit(kind, a.impact);
      if (!transformed) return ok(`Hit ${kind}. It did not change.`);
      const result = this.canHold(e, transformed); if (!result.ok) return result;
      if (this.entities.some(other => this.active(other) && Math.floor(other.position[0]) === target[0] && Math.floor(other.position[2]) === target[2] && Math.abs(other.position[1] - (target[1] + 1)) < .05)) return fail('A creature is standing on that block.');
      this.voxels.set(target, null); this.addInventory(e, transformed); this.wakeBodies();
      this.event(e.id, 'discovery', `${kind} became ${transformed} after a centred impact.`, { target, impact: a.impact });
      return ok(`Your strike hollowed the ${kind} into a ${transformed}.`);
    }
    if (a.action === 'fill') {
      if (!e.inventory || !this.module.manifest.materials[e.inventory.kind]?.vessel || e.inventory.water) return fail('You need an empty vessel.');
      if (kind || point[1] >= this.module.manifest.waterLevel) return fail('There is no water in that cell.');
      e.inventory.water = true; return ok('Filled the bucket with water.');
    }
    if (a.action === 'pour') {
      if (!e.inventory || !this.module.manifest.materials[e.inventory.kind]?.vessel || !e.inventory.water) return fail('You need a vessel of water.');
      e.inventory.water = false; this.event(e.id, 'splash', 'Poured water.', { position: point });
      return ok('Poured the water; it dispersed into the ground or sea.');
    }
    return fail('Unknown action.');
  }
  private canHold(e: Entity, kind: string) {
    if (e.inventory && (e.inventory.kind !== kind || e.inventory.count >= (this.module.manifest.materials[kind]?.stackLimit ?? 64))) return fail('Your inventory holds one type and must stay within its stack limit.');
    return ok('Space available.');
  }
  private addInventory(e: Entity, kind: string, water?: boolean) {
    if (e.inventory) e.inventory.count++; else e.inventory = { kind, count: 1, ...(water === undefined ? {} : { water }) };
  }
  private consume(e: Entity) { if (e.inventory && --e.inventory.count === 0) e.inventory = null; }
  private wakeBodies() { for (const body of this.bodies) body.resting = false; }
  step(beforePhysics?: () => void) {
    this.tick++;
    // Commands belong to this step, so a boundary snapshot cannot see future actions.
    beforePhysics?.();
    for (const e of this.entities) {
      if (!this.active(e)) continue;
      if (e.speech && e.speech.until < this.time) delete e.speech;
      if (e.controller === 'wander' && !e.motion && this.tick % 60 === 0) {
        e.yaw = (this.tick * 13.37) % 360;
        // The NPC uses the same collision and depth rules, without adding agent journal noise.
        this.execute(e, { action: 'move', distance: 1.5 });
      }
      if (!e.motion) continue;
      const [x, , z] = e.position, dest = e.motion.destination, d = Math.hypot(dest[0] - x, dest[2] - z), step = Math.min(d, e.motion.speed / 20);
      const next = this.movementPoint(e, x + (dest[0] - x) * step / Math.max(d, .0001), z + (dest[2] - z) * step / Math.max(d, .0001), e.position[1]);
      if (!next.point) { delete e.motion; e.status = 'idle'; this.event(e.id, 'blocked', next.reason!); continue; }
      e.position = next.point;
      if (d <= step + .001) { delete e.motion; e.status = 'idle'; if (e.controller === 'agent') this.event(e.id, 'arrived', 'Movement finished.', { position: e.position }); }
    }
    for (const body of this.bodies) {
      if (body.resting) continue;
      // Six conservative substeps keep the fastest allowed throw below one voxel per collision test.
      for (let sub = 0; sub < 6; sub++) {
        const dt = 1 / 120, water = this.module.manifest.waterLevel;
        const floats = this.module.manifest.materials[body.kind]?.floats && !body.water;
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
    this.bodies = this.bodies.filter(body => {
      if (this.inside(body.position)) return true;
      this.lost++; this.event('world', 'lost', `One ${body.kind} left the bounded world and was lost forever.`, { itemId: body.id, kind: body.kind }); return false;
    });
  }
}
