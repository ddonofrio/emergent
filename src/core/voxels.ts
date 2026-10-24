import { key, unkey, type Block, type Vec3, type Material } from './types';

export class Voxels {
  readonly cells = new Map<string, string>();
  readonly chunks = new Map<string, Set<string>>();
  changes = new Map<string, string | null>();
  constructor(readonly materials: Record<string, Material>, blocks: Block[] = []) {
    for (const [x, y, z, kind] of blocks) this.set([x, y, z], kind);
    this.changes.clear();
  }
  chunk(p: Vec3) { return p.map(v => Math.floor(v / 16)).join(','); }
  get(p: Vec3) { return this.cells.get(key(p.map(Math.floor) as Vec3)); }
  solid(p: Vec3) { const kind = this.get(p); return !!kind && this.materials[kind]?.solid; }
  set(p: Vec3, kind: string | null) {
    const k = key(p), c = this.chunk(p);
    if (kind) {
      this.cells.set(k, kind);
      if (!this.chunks.has(c)) this.chunks.set(c, new Set());
      this.chunks.get(c)!.add(k);
    } else {
      this.cells.delete(k); this.chunks.get(c)?.delete(k);
      if (!this.chunks.get(c)?.size) this.chunks.delete(c);
    }
    this.changes.set(k, kind);
  }
  nearby(center: Vec3, radius: number): Block[] {
    const blocks: Block[] = [];
    const min = center.map(v => Math.floor((v - radius) / 16));
    const max = center.map(v => Math.floor((v + radius) / 16));
    for (let x = min[0]; x <= max[0]; x++) for (let y = min[1]; y <= max[1]; y++) for (let z = min[2]; z <= max[2]; z++) {
      for (const k of this.chunks.get(`${x},${y},${z}`) ?? []) {
        const p = unkey(k);
        if (Math.hypot(p[0] + .5 - center[0], p[1] + .5 - center[1], p[2] + .5 - center[2]) <= radius) blocks.push([...p, this.cells.get(k)!]);
      }
    }
    return blocks;
  }
  serialize(): Block[] { return [...this.cells].map(([k, kind]) => [...unkey(k), kind]); }
  clearLine(a: Vec3, b: Vec3, ignoreEnd = false): boolean {
    // Amanatides-Woo grid traversal: visit crossed voxels, not arbitrary ray samples.
    const cell = a.map(Math.floor) as Vec3;
    const delta = b.map((v,i) => v-a[i]);
    const step = delta.map(Math.sign);
    const stride = delta.map(v => v === 0 ? Infinity : Math.abs(1/v));
    const next = delta.map((v,i) => v === 0 ? Infinity : (cell[i] + (v > 0 ? 1 : 0) - a[i]) / v);
    const limit = Math.ceil(delta.reduce((sum,v) => sum+Math.abs(v),0))+3;
    const endKey = key(b.map(Math.floor) as Vec3);
    for (let i=0;i<limit;i++) {
      const t = Math.min(...next); if (t >= 1-1e-9) break;
      for (let axis=0;axis<3;axis++) if (next[axis] <= t+1e-9) { cell[axis] += step[axis]; next[axis] += stride[axis]; }
      if (ignoreEnd && key(cell) === endKey) continue;
      if (this.solid(cell)) return false;
    }
    return true;
  }
}
