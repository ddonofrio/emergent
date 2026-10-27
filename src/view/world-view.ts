import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { key, unkey, type Body, type Entity, type Frame, type ModuleManifest, type Vec3, type WorldState } from '../core/types';

const neighbors: Vec3[] = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
export class WorldView {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(45, 1, .1, 900);
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;
  private cells = new Map<string, string>();
  private damage = new Map<string, number>();
  private chunks = new Map<string, Set<string>>();
  private meshes = new Map<string, THREE.InstancedMesh>();
  private creatures = new Map<string, THREE.Group>();
  private objects = new Map<string, THREE.Object3D>();
  private held = new Map<string, THREE.Group>();
  private punches = new Map<string, { start: number; until: number }>();
  private effects: { mesh: THREE.Mesh; until: number; start: number }[] = [];
  private sea: THREE.Mesh;
  private seabed: THREE.Mesh;
  private labels = new Map<string, HTMLButtonElement>();
  private cube = new THREE.BoxGeometry(1,1,1);
  private blockMaterial = new THREE.MeshStandardMaterial({ roughness: .94, metalness: 0 });
  private ring = new THREE.Mesh(new THREE.RingGeometry(.65,.73,48), new THREE.MeshBasicMaterial({ color: '#e0f7ad', side: THREE.DoubleSide, depthWrite: false }));
  private manifest?: ModuleManifest;
  private current?: Pick<WorldState,'entities'|'bodies'|'time'>;
  private prior?: Pick<WorldState,'entities'|'bodies'|'time'>;
  private received = 0;
  private interpolationMs = 100;
  private selected = 't1';
  private following = false;
  private keys = new Set<string>();
  private last = performance.now();
  private target = new THREE.Vector3();
  private frameId = 0;
  private observer: ResizeObserver;
  readonly onSelect: (id: string) => void;
  constructor(readonly container: HTMLElement, onSelect: (id: string) => void) {
    this.onSelect = onSelect;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor('#b2ccc1'); this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.2;
    container.prepend(this.renderer.domElement);
    this.renderer.domElement.setAttribute('aria-label', 'Interactive 3D world. Drag to orbit, right-drag to pan, scroll to zoom. WASD and Q/E move the camera.');
    this.renderer.domElement.tabIndex = 0;
    this.scene.fog = new THREE.Fog('#b2ccc1', 150, 420);
    this.scene.add(new THREE.HemisphereLight('#e6f3e8', '#667b57', 2.1));
    const sun = new THREE.DirectionalLight('#fff1cd', 3.3); sun.position.set(-45,80,35); sun.castShadow = true;
    sun.shadow.mapSize.set(2048,2048); Object.assign(sun.shadow.camera, { left: -65, right: 65, top: 65, bottom: -65, near: .5, far: 200 }); sun.shadow.bias = -.0003; sun.shadow.normalBias = .04;
    this.scene.add(sun);
    const sea = this.sea = new THREE.Mesh(new THREE.PlaneGeometry(800,800), new THREE.MeshStandardMaterial({ color: '#588c8a', transparent: true, opacity: .84, roughness: .38, metalness: .12 }));
    sea.rotation.x = -Math.PI / 2; sea.position.y = .015; sea.receiveShadow = true; this.scene.add(sea);
    const seabed = this.seabed = new THREE.Mesh(new THREE.PlaneGeometry(800,800), new THREE.MeshBasicMaterial({ color: '#345f66' })); seabed.rotation.x = -Math.PI / 2; seabed.position.y = -32; this.scene.add(seabed);
    this.ring.rotation.x = -Math.PI / 2; this.scene.add(this.ring);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true; this.controls.dampingFactor = .08; this.controls.minDistance = 2; this.controls.maxDistance = 260; this.controls.maxPolarAngle = Math.PI * .92;
    this.overview();
    this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(container); this.resize();
    this.renderer.domElement.addEventListener('pointerdown', () => this.renderer.domElement.focus());
    this.renderer.domElement.addEventListener('keydown', event => { if (['w','a','s','d','q','e','shift'].includes(event.key.toLowerCase())) { event.preventDefault(); this.keys.add(event.key.toLowerCase()); this.following = false; } });
    this.renderer.domElement.addEventListener('keyup', event => this.keys.delete(event.key.toLowerCase()));
    this.renderer.domElement.addEventListener('blur', () => this.keys.clear());
    this.renderer.domElement.addEventListener('dblclick', event => {
      const rect = this.renderer.domElement.getBoundingClientRect(), ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2((event.clientX-rect.left)/rect.width*2-1, -(event.clientY-rect.top)/rect.height*2+1), this.camera);
      const hits = ray.intersectObjects([...this.creatures.values()], true);
      if (hits.length) { let object: THREE.Object3D = hits[0].object; while (object.parent && !object.userData.entity) object = object.parent; if (object.userData.entity) onSelect(object.userData.entity); }
    });
    this.animate();
  }
  private resize() { const w = this.container.clientWidth, h = this.container.clientHeight; this.camera.aspect = w/Math.max(1,h); this.camera.updateProjectionMatrix(); this.renderer.setSize(w,h); }
  private chunk(p: Vec3) { return p.map(v => Math.floor(v/16)).join(','); }
  private setCell(k: string, kind: string | null) {
    const chunk = this.chunk(unkey(k));
    if (kind) { this.cells.set(k,kind); if (!this.chunks.has(chunk)) this.chunks.set(chunk,new Set()); this.chunks.get(chunk)!.add(k); }
    else { this.cells.delete(k); this.chunks.get(chunk)?.delete(k); }
  }
  load(state: WorldState, manifest: ModuleManifest) {
    this.manifest = manifest; this.cells.clear(); this.chunks.clear(); this.punches.clear(); this.damage=new Map(Object.entries(state.blockDamage??{}));
    this.sea.position.y = manifest.waterLevel + .015; this.seabed.position.y = manifest.bounds.min[1];
    for (const effect of this.effects) { this.scene.remove(effect.mesh); effect.mesh.geometry.dispose(); (effect.mesh.material as THREE.Material).dispose(); } this.effects = [];
    for (const mesh of this.meshes.values()) { this.scene.remove(mesh); mesh.dispose(); } this.meshes.clear();
    for (const [x,y,z,kind] of state.blocks) this.setCell(key([x,y,z]),kind);
    for (const chunk of this.chunks.keys()) this.buildChunk(chunk);
    this.current = state; this.prior = state; this.received = performance.now(); this.syncEntities(state.entities);
  }
  hold() { this.prior = this.current; }
  update(frame: Frame, snap = false, speed = 1) {
    const dirty = new Set<string>();
    for (const [k,kind] of frame.changes) {
      this.setCell(k,kind); const p = unkey(k); dirty.add(this.chunk(p));
      for (const offset of neighbors) dirty.add(this.chunk(p.map((v,i) => v+offset[i]) as Vec3));
    }
    const nextDamage=new Map(Object.entries(frame.blockDamage??{}));
    for(const voxel of new Set([...this.damage.keys(),...nextDamage.keys()]))if(this.damage.get(voxel)!==nextDamage.get(voxel))dirty.add(this.chunk(unkey(voxel)));
    this.damage=nextDamage;
    for (const chunk of dirty) this.buildChunk(chunk);
    this.prior = snap ? frame : this.current;
    this.interpolationMs = Math.max(1, (frame.time - (this.prior?.time ?? frame.time)) * 1000 / speed);
    this.current = frame; this.received = performance.now(); this.syncEntities(frame.entities);
    for (const event of frame.events) {
      const action=(event.data as {action?:{action?:string}}|undefined)?.action?.action;
      if(event.type==='action'&&action==='hit')this.punches.set(event.actor,{start:event.time,until:event.time+.55});
      if (event.type !== 'splash' && event.type !== 'discovery') continue;
      const data = event.data as { position?: Vec3; target?: Vec3 };
      const position = data.position ?? data.target; if (!position) continue;
      const mesh = new THREE.Mesh(new THREE.RingGeometry(.15,.22,32),new THREE.MeshBasicMaterial({color:event.type === 'splash' ? '#b0e4ee' : '#f6e2a0',transparent:true,side:THREE.DoubleSide,depthWrite:false}));
      mesh.rotation.x=-Math.PI/2; mesh.position.set(position[0]+.5,position[1]+.8,position[2]+.5); this.scene.add(mesh); this.effects.push({mesh,until:frame.time+1.3,start:frame.time});
    }
  }
  private buildChunk(chunk: string) {
    const old = this.meshes.get(chunk); if (old) { this.scene.remove(old); old.dispose(); this.meshes.delete(chunk); }
    const visible = [...(this.chunks.get(chunk) ?? [])].filter(k => {
      const p = unkey(k);
      return neighbors.some(d => { const kind = this.cells.get(key(p.map((v,i) => v+d[i]) as Vec3)); return !kind || !this.manifest!.materials[kind]?.solid; });
    });
    if (!visible.length) return;
    const mesh = new THREE.InstancedMesh(this.cube,this.blockMaterial,visible.length), dummy = new THREE.Object3D();
    visible.forEach((k,index) => {
      const p = unkey(k), kind = this.cells.get(k)!;
      dummy.position.set(p[0]+.5,p[1]+.5,p[2]+.5); dummy.rotation.set(0,0,0); dummy.scale.set(1,1,1);
      if (kind === 'plant') { dummy.scale.set(.18,.55,.18); dummy.position.y = p[1]+.27; dummy.rotation.z = Math.sin(p[0])* .2; }
      dummy.updateMatrix(); mesh.setMatrixAt(index,dummy.matrix);
      const color = new THREE.Color(this.manifest!.materials[kind]?.color ?? '#ffffff'); color.multiplyScalar((.94 + .1 * (Math.sin(p[0]*12.98 + p[2]*78.23 + p[1]*37.7)*.5+.5))*(1-(this.damage.get(k)??0)*.22)); mesh.setColorAt(index,color);
    });
    mesh.castShadow = true; mesh.receiveShadow = true; mesh.computeBoundingSphere(); this.meshes.set(chunk,mesh); this.scene.add(mesh);
  }
  private box(group: THREE.Group, size: Vec3, position: Vec3, color: string) {
    const mesh = new THREE.Mesh(this.cube, new THREE.MeshStandardMaterial({ color, roughness: .9 }));
    mesh.material.userData.activeColor = color;
    mesh.scale.set(...size); mesh.position.set(...position); mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh); return mesh;
  }
  private triangle(group:THREE.Group,vertices:[Vec3,Vec3,Vec3],color:string){
    const geometry=new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.Float32BufferAttribute(vertices.flat(),3));geometry.computeVertexNormals();
    const material=new THREE.MeshStandardMaterial({color,roughness:.94,side:THREE.DoubleSide});material.userData.activeColor=color;
    const mesh=new THREE.Mesh(geometry,material);mesh.castShadow=true;mesh.receiveShadow=true;group.add(mesh);return mesh;
  }
  private arm(group:THREE.Group,name:string,side:-1|1,skinColor:string){
    const arm=new THREE.Group();arm.name=name;arm.position.set(side*.39,1.25,0);
    this.box(arm,[.16,.46,.20],[0,-.23,0],skinColor);
    this.box(arm,[.075,.05,.10],[0,-.465,0],skinColor);
    // Resting palms face the thighs: thickness along X, fingers spread along Z.
    this.box(arm,[.065,.12,.148],[0,-.54,0],skinColor);
    const fingerLengths=[.078,.09,.084,.062],palmBottom=-.60;
    for(let finger=0;finger<fingerLengths.length;finger++){
      const length=fingerLengths[finger];
      this.box(arm,[.055,length,.032],[0,palmBottom-length/2+.002,.054-finger*.036],skinColor);
    }
    const thumb=new THREE.Group();thumb.position.set(-side*.014,-.515,.067);thumb.rotation.x=-.18;
    this.box(thumb,[.045,.072,.045],[0,-.03,0],skinColor);arm.add(thumb);
    group.add(arm);return arm;
  }
  private styleEntity(group: THREE.Group, enabled: boolean) {
    if (group.userData.enabled === enabled) return;
    group.userData.enabled = enabled;
    group.traverse(object => {
      if (!(object instanceof THREE.Mesh) || !(object.material instanceof THREE.MeshStandardMaterial)) return;
      const material = object.material;
      material.color.set(enabled ? material.userData.activeColor ?? '#ffffff' : '#777f7b');
      material.transparent = !enabled; material.opacity = enabled ? 1 : .22; material.depthWrite = enabled;
    });
  }
  private heldVisual(kind: string, color: string, inHand=true) {
    const visual=new THREE.Group();visual.userData.kind=kind;
    if(inHand){if(kind==='spear')visual.position.set(0,-.54,.4);else visual.position.set(.36,1,.38);}
    const material=(value:string)=>{const result=new THREE.MeshStandardMaterial({color:value,roughness:.86});result.userData.activeColor=value;return result;};
    if(kind==='arrow'||kind==='spear'){
      const length=kind==='spear' ? .85 : .9,radius=kind==='spear' ? .045 : .025;
      const shaft=new THREE.Mesh(new THREE.CylinderGeometry(radius,radius,length,8),material(color));shaft.rotation.x=Math.PI/2;shaft.castShadow=true;visual.add(shaft);
      const tip=new THREE.Mesh(new THREE.ConeGeometry(kind==='spear' ? .09 : .075,kind==='spear' ? .27 : .18,8),material(color));tip.rotation.x=Math.PI/2;tip.position.z=kind==='spear' ? .52 : .53;tip.castShadow=true;visual.add(tip);
      if(kind==='arrow'){
      const fletching=this.box(visual,[.16,.035,.18],[0,0,-.42],'#d8c7a0');fletching.rotation.z=Math.PI/4;
      }
    }else if(kind==='shovel'){
      const handle=new THREE.Mesh(new THREE.CylinderGeometry(.035,.045,.62,7),material(color));handle.rotation.x=.35;handle.position.set(0,.02,0);handle.castShadow=true;visual.add(handle);
      this.box(visual,[.28,.32,.07],[0,-.3,.12],color);
    }else if(kind==='plank'){
      const board=new THREE.Mesh(this.cube,material(color));board.scale.set(inHand ? .46 : 1,inHand ? .09 : .2,inHand ? .46 : 1);board.castShadow=true;visual.add(board);
    }else if(kind==='door_half_up'||kind==='door_half_down'||kind==='door'){
      const full=kind==='door',height=full ? 1.9 : .9,width=full ? .86 : .8,base=-height/2;
      this.box(visual,[.07,height,.07],[-width/2+.04,base+height/2,0],color);this.box(visual,[.07,height,.07],[width/2-.04,base+height/2,0],color);
      this.box(visual,[width,.07,.07],[0,base+height-.04,0],color);this.box(visual,[width,.07,.07],[0,base+.04,0],color);
      for(let y=base+.16;y<base+height-.1;y+=.2)this.box(visual,[width-.12,.09,.045],[0,y,0],color);
    }else{
      const item=new THREE.Mesh(this.cube,material(color));item.scale.setScalar(.42);item.castShadow=true;visual.add(item);
    }
    return visual;
  }
  private disposeItemVisual(visual: THREE.Object3D) {
    visual.parent?.remove(visual);
    visual.traverse(object=>{if(!(object instanceof THREE.Mesh))return;if(object.geometry!==this.cube)object.geometry.dispose();const materials=Array.isArray(object.material)?object.material:[object.material];for(const material of materials)material.dispose();});
  }
  private syncEntities(entities: Entity[]) {
    for (const entity of entities) {
      if (this.creatures.has(entity.id)) continue;
      const group = new THREE.Group(); group.userData.entity = entity.id;
      if (entity.kind === 'duck') {
        this.box(group,[.55,.4,.8],[0,.3,0],'#eee5c5'); this.box(group,[.35,.4,.35],[0,.55,.35],'#f7efd3');
        this.box(group,[.28,.12,.3],[0,.48,.6],'#d59a43'); this.box(group,[.07,.07,.08],[-.18,.63,.48],'#263a31'); this.box(group,[.07,.07,.08],[.18,.63,.48],'#263a31');
      } else {
        const hairColor='#514d3e',invertedHide=entity.id==='t2',hideColor=invertedHide?'#493326':'#b8874d',spotColor=invertedHide?'#b8874d':'#493326',skinColor='#d9b98d';
        this.box(group,[.58,.66,.35],[0,.93,0],skinColor);
        const head=new THREE.Mesh(new RoundedBoxGeometry(.44,.45,.42,3,.025),new THREE.MeshStandardMaterial({color:skinColor,roughness:.9}));
        head.material.userData.activeColor=skinColor;head.position.set(0,1.52,0);head.castShadow=true;head.receiveShadow=true;group.add(head);
        this.box(group,[.47,.16,.44],[0,1.76,-.02],hairColor);
        this.box(group,[.07,.07,.03],[-.11,1.55,.22],'#25392d'); this.box(group,[.07,.07,.03],[.11,1.55,.22],'#25392d');
        this.box(group,[.36,.22,.055],[0,1.38,.235],hairColor);
        this.box(group,[.25,.13,.07],[0,1.235,.22],hairColor);
        const left = this.box(group,[.2,.57,.24],[-.17,.29,0],skinColor); left.name = 'leg-left';
        const right = this.box(group,[.2,.57,.24],[.17,.29,0],skinColor); right.name = 'leg-right';
        this.arm(group,'arm-left',-1,skinColor);
        this.arm(group,'arm-right',1,skinColor);
        const shoulder=entity.id==='t2'?-1:1;
        this.triangle(group,[[shoulder*.32,1.3,.19],[-shoulder*.3,.59,.19],[shoulder*.3,.59,.19]],hideColor);
        this.triangle(group,[[shoulder*.22,1.16,.197],[shoulder*.1,1.03,.197],[shoulder*.25,.98,.197]],spotColor);
        this.triangle(group,[[-shoulder*.04,.9,.197],[-shoulder*.13,.76,.197],[shoulder*.05,.75,.197]],spotColor);
        this.triangle(group,[[shoulder*.32,1.3,-.19],[shoulder*.3,.59,-.19],[-shoulder*.3,.59,-.19]],hideColor);
        this.triangle(group,[[shoulder*.22,1.16,-.197],[shoulder*.25,.98,-.197],[shoulder*.1,1.03,-.197]],spotColor);
        this.triangle(group,[[-shoulder*.04,.9,-.197],[shoulder*.05,.75,-.197],[-shoulder*.13,.76,-.197]],spotColor);
        this.box(group,[.18,.12,.42],[shoulder*.25,1.23,0],hideColor);
        const skirtHeight=.46,skirtWidth=.63,skirtDepth=.4,skirtY=.5,skirtX=skirtWidth/2-.02,skirtZ=skirtDepth/2-.02;
        this.box(group,[skirtWidth,skirtHeight,.04],[0,skirtY,skirtZ],hideColor);
        this.box(group,[skirtWidth,skirtHeight,.04],[0,skirtY,-skirtZ],hideColor);
        this.box(group,[.04,skirtHeight,skirtDepth],[skirtX,skirtY,0],hideColor);
        this.box(group,[.04,skirtHeight,skirtDepth],[-skirtX,skirtY,0],hideColor);
        this.triangle(group,[[-.18,.55,.202],[-.08,.55,.202],[-.13,.48,.202]],spotColor);
        this.triangle(group,[[.06,.45,.202],[.16,.46,.202],[.11,.38,.202]],spotColor);
        this.triangle(group,[[-.05,.34,.202],[.05,.34,.202],[0,.285,.202]],spotColor);
        this.triangle(group,[[.18,.55,-.202],[.13,.48,-.202],[.08,.55,-.202]],spotColor);
        this.triangle(group,[[-.06,.45,-.202],[-.11,.38,-.202],[-.16,.46,-.202]],spotColor);
        this.triangle(group,[[.05,.34,-.202],[0,.285,-.202],[-.05,.34,-.202]],spotColor);
      }
      this.creatures.set(entity.id,group); this.scene.add(group);
      const label = document.createElement('button'); label.className = 'entity-label'; label.textContent = entity.name; label.addEventListener('click', () => this.onSelect(entity.id)); this.container.append(label); this.labels.set(entity.id,label);
    }
  }
  select(id: string) { this.selected = id; }
  focus(id = this.selected) {
    const e = this.current?.entities.find(e => e.id === id); if (!e) return;
    this.selected = id; this.following = true; this.target.set(...e.position); this.controls.target.copy(this.target).add(new THREE.Vector3(0,1,0)); this.camera.position.copy(this.target).add(new THREE.Vector3(11,9,14)); this.controls.update();
  }
  overview() { this.following = false; this.camera.position.set(86,79,103); this.controls.target.set(0,2,0); this.controls.update(); }
  topDown() { this.following = false; this.camera.position.set(0,145,.01); this.controls.target.set(0,0,0); this.controls.update(); }
  private animate = () => {
    this.frameId = requestAnimationFrame(this.animate);
    const now = performance.now(), dt = Math.min((now-this.last)/1000,.1); this.last = now;
    const alpha = Math.min(1,(now-this.received)/this.interpolationMs);
    if (this.current) {
      const visualTime = (this.prior?.time ?? this.current.time) + (this.current.time - (this.prior?.time ?? this.current.time)) * alpha;
      this.ring.visible = false;
      for (const e of this.current.entities) {
        const group = this.creatures.get(e.id)!; const previous = this.prior?.entities.find(p => p.id === e.id) ?? e;
        const enabled = e.enabled !== false;
        let held = this.held.get(e.id);
        const carried=e.inventory?.selected===null||!e.inventory?undefined:e.inventory.stacks[e.inventory.selected];
        if (carried) {
          const color=this.manifest!.materials[carried.kind]?.color??'#ffffff';
          if (!held || held.userData.kind!==carried.kind) { if(held)this.disposeItemVisual(held);held=this.heldVisual(carried.kind,color);const hand=carried.kind==='spear'?group.getObjectByName('arm-right'):undefined;(hand??group).add(held);this.held.set(e.id,held);group.userData.enabled=undefined; }
          held.visible = true;
        } else if (held) held.visible = false;
        this.styleEntity(group,enabled);
        group.position.set(...previous.position).lerp(new THREE.Vector3(...e.position),alpha);
        const turn = Math.atan2(Math.sin((e.yaw-previous.yaw)*Math.PI/180),Math.cos((e.yaw-previous.yaw)*Math.PI/180)); group.rotation.y = previous.yaw*Math.PI/180+turn*alpha;
        const walking = e.motion && distanceSquared(e.position,previous.position) > .00001;
        const gait=Math.sin(visualTime*9);
        for (const name of ['leg-left','leg-right']) { const leg = group.getObjectByName(name); if (leg) leg.rotation.x = walking ? gait*(name === 'leg-left' ? .32 : -.32) : 0; }
        const leftArm=group.getObjectByName('arm-left'),rightArm=group.getObjectByName('arm-right'),punch=this.punches.get(e.id);
        if(leftArm)leftArm.rotation.x=walking?-gait*.3:0;
        if(rightArm){if(punch&&visualTime<=punch.until){const phase=Math.max(0,Math.min(1,(visualTime-punch.start)/(punch.until-punch.start)));rightArm.rotation.x=-Math.sin(Math.PI*phase)*1.8;}else{rightArm.rotation.x=walking?gait*.3:0;if(punch)this.punches.delete(e.id);}}
        const label = this.labels.get(e.id)!; const projected = group.position.clone().add(new THREE.Vector3(0,e.height+.7,0)).project(this.camera);
        label.style.display = Math.abs(projected.x)>1 || Math.abs(projected.y)>1 || projected.z>1 ? 'none' : 'block';
        label.style.left = `${(projected.x*.5+.5)*this.container.clientWidth}px`; label.style.top = `${(-projected.y*.5+.5)*this.container.clientHeight}px`;
        label.classList.toggle('selected',e.id === this.selected); label.classList.toggle('disabled',!enabled); label.textContent = !enabled ? `${e.name} · disabled` : e.speech ? `${e.name} · ${e.speech.word}` : e.name;
        if (e.id === this.selected && enabled) {
          this.ring.visible = true;
          this.ring.position.copy(group.position).add(new THREE.Vector3(0,.06,0));
          if (this.following) { const next = group.position.clone().add(new THREE.Vector3(0,1,0)); const delta = next.clone().sub(this.controls.target); this.camera.position.add(delta); this.controls.target.copy(next); }
        }
      }
      const ids = new Set(this.current.bodies.map(b => b.id));
      for (const [id,object] of this.objects) if (!ids.has(id)) { this.disposeItemVisual(object); this.objects.delete(id); }
      for (const b of this.current.bodies) {
        let object = this.objects.get(b.id);
        if (!object) {
          const color=this.manifest!.materials[b.kind]?.color??'#ffffff';
          if(['arrow','spear','shovel','plank','door_half_up','door_half_down','door'].includes(b.kind))object=this.heldVisual(b.kind,color,false);else{const mesh=new THREE.Mesh(this.cube,new THREE.MeshStandardMaterial({color}));mesh.scale.setScalar(.56);mesh.castShadow=true;object=mesh;}
          this.scene.add(object);this.objects.set(b.id,object);
        }
        const previous = this.prior?.bodies.find(p => p.id === b.id) ?? b; object.position.set(...previous.position).lerp(new THREE.Vector3(...b.position),alpha);
        if (!b.resting) object.rotation.set(visualTime*2,visualTime*.8,0);
      }
      this.effects = this.effects.filter(effect => {
        if (this.current!.time >= effect.until) { this.scene.remove(effect.mesh); effect.mesh.geometry.dispose(); (effect.mesh.material as THREE.Material).dispose(); return false; }
        const phase = Math.max(0,(visualTime-effect.start)/1.3); effect.mesh.scale.setScalar(1+phase*5); (effect.mesh.material as THREE.MeshBasicMaterial).opacity = 1-phase; return true;
      });
    }
    if (this.keys.size) {
      const direction = new THREE.Vector3(); this.camera.getWorldDirection(direction); direction.y = 0; direction.normalize(); const right = direction.clone().cross(new THREE.Vector3(0,1,0));
      const movement = new THREE.Vector3(); if (this.keys.has('w')) movement.add(direction); if (this.keys.has('s')) movement.sub(direction); if (this.keys.has('d')) movement.add(right); if (this.keys.has('a')) movement.sub(right); if (this.keys.has('e')) movement.y++; if (this.keys.has('q')) movement.y--;
      movement.normalize().multiplyScalar(dt*(this.keys.has('shift')?35:12)); this.camera.position.add(movement); this.controls.target.add(movement);
    }
    this.controls.update(); this.renderer.render(this.scene,this.camera);
  };
  dispose() { cancelAnimationFrame(this.frameId); this.observer.disconnect(); this.controls.dispose(); this.renderer.dispose(); }
}
const distanceSquared = (a: Vec3,b: Vec3) => a.reduce((sum,v,i) => sum+(v-b[i])**2,0);
