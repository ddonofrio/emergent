import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { terrainFloorY, terrainKindAt, terrainSurfaceY } from '../core/procedural-terrain';
import { key, unkey, type Body, type Entity, type Frame, type UniverseManifest, type Vec3, type WorldState } from '../core/types';
import { entityLabelText } from './entity-label';

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
  private proceduralGround?: THREE.InstancedMesh;
  private proceduralGroundOrigin = '';
  private removedTerrain = new Set<string>();
  private labels = new Map<string, HTMLButtonElement>();
  private cube = new THREE.BoxGeometry(1,1,1);
  private blockMaterial = new THREE.MeshStandardMaterial({ roughness: .94, metalness: 0 });
  private manifest?: UniverseManifest;
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
  private loaded = false;
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
  private kindAt(p:Vec3){
    const k=key(p),explicit=this.cells.get(k);if(explicit)return explicit;if(this.removedTerrain.has(k))return undefined;
    return terrainKindAt(this.manifest?.terrain,this.manifest?.seed??0,p);
  }
  load(state: WorldState, manifest: UniverseManifest) {
    this.manifest = manifest; this.cells.clear(); this.chunks.clear(); this.punches.clear(); this.damage=new Map(Object.entries(state.blockDamage??{}));this.removedTerrain=new Set(state.removedBlocks??[]);
    const fog=manifest.view?.fog??{near:150,far:420};this.scene.fog=new THREE.Fog('#b2ccc1',fog.near,fog.far);this.controls.maxDistance=manifest.view?.maxDistance??260;
    this.sea.position.y = manifest.waterLevel + .015; this.seabed.position.y = manifest.bounds.min[1];
    for (const effect of this.effects) { this.scene.remove(effect.mesh); effect.mesh.geometry.dispose(); (effect.mesh.material as THREE.Material).dispose(); } this.effects = [];
    for (const mesh of this.meshes.values()) { this.scene.remove(mesh); mesh.dispose(); } this.meshes.clear();
    for (const [x,y,z,kind] of state.blocks) this.setCell(key([x,y,z]),kind);
    for (const chunk of this.chunks.keys()) this.buildChunk(chunk);
    this.proceduralGroundOrigin='';this.buildProceduralGround();
    this.current = state; this.prior = state; this.received = performance.now(); this.syncEntities(state.entities);
    if(!this.loaded){this.loaded=true;this.overview();}
  }
  hold() { this.prior = this.current; }
  update(frame: Frame, snap = false, speed = 1) {
    const dirty = new Set<string>();
    for (const [k,kind] of frame.changes) {
      if(kind)this.removedTerrain.delete(k);else if(terrainKindAt(this.manifest?.terrain,this.manifest?.seed??0,unkey(k)))this.removedTerrain.add(k);
      this.setCell(k,kind); const p = unkey(k); dirty.add(this.chunk(p));
      for (const offset of neighbors) dirty.add(this.chunk(p.map((v,i) => v+offset[i]) as Vec3));
    }
    const nextDamage=new Map(Object.entries(frame.blockDamage??{}));
    for(const voxel of new Set([...this.damage.keys(),...nextDamage.keys()]))if(this.damage.get(voxel)!==nextDamage.get(voxel))dirty.add(this.chunk(unkey(voxel)));
    this.damage=nextDamage;
    for (const chunk of dirty) this.buildChunk(chunk);
    if(frame.changes.length){this.proceduralGroundOrigin='';this.buildProceduralGround();}
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
      return neighbors.some(d => { const kind = this.kindAt(p.map((v,i) => v+d[i]) as Vec3); return !kind || !this.manifest!.materials[kind]?.solid; });
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
  private buildProceduralGround() {
    const terrain=this.manifest?.terrain;
    if(!terrain){
      if(this.proceduralGround){this.scene.remove(this.proceduralGround);this.proceduralGround.dispose();delete this.proceduralGround;}
      return;
    }
    const seed=this.manifest!.seed,centerX=Math.floor(this.controls.target.x/16)*16,centerZ=Math.floor(this.controls.target.z/16)*16,origin=`${centerX},${centerZ}`;
    if(origin===this.proceduralGroundOrigin)return;
    this.proceduralGroundOrigin=origin;
    if(this.proceduralGround){this.scene.remove(this.proceduralGround);this.proceduralGround.dispose();}
    this.sea.position.x=this.seabed.position.x=centerX;this.sea.position.z=this.seabed.position.z=centerZ;
    const radius=96,floor=terrainFloorY(terrain),tops=new Map<string,number>(),visible=new Map<string,{position:Vec3;kind:string}>();
    for(let x=centerX-radius-1;x<=centerX+radius;x++)for(let z=centerZ-radius-1;z<=centerZ+radius;z++){
      let y=terrainSurfaceY(terrain,seed,x,z);while(y>=floor&&!this.kindAt([x,y,z]))y--;tops.set(`${x},${z}`,y);
    }
    for(let x=centerX-radius;x<centerX+radius;x++)for(let z=centerZ-radius;z<centerZ+radius;z++){
      const top=tops.get(`${x},${z}`)!;if(top<floor)continue;
      const expose=(y:number)=>{const position:[number,number,number]=[x,y,z],k=key(position),kind=this.kindAt(position);if(kind&&!this.cells.has(k))visible.set(k,{position,kind});};
      expose(top);
      for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]]){
        const adjacent=tops.get(`${x+dx},${z+dz}`)??floor-1;
        for(let y=top-1;y>adjacent&&y>=floor;y--)expose(y);
      }
    }
    const positions=[...visible.values()],mesh=this.proceduralGround=new THREE.InstancedMesh(this.cube,this.blockMaterial,positions.length),dummy=new THREE.Object3D();
    positions.forEach(({position,kind},index)=>{
      dummy.position.set(position[0]+.5,position[1]+.5,position[2]+.5);dummy.updateMatrix();mesh.setMatrixAt(index,dummy.matrix);
      const color=new THREE.Color(this.manifest!.materials[kind]?.color??'#ffffff').multiplyScalar(.94+.1*(Math.sin(position[0]*12.98+position[2]*78.23+position[1]*37.7)*.5+.5));mesh.setColorAt(index,color);
    });
    mesh.castShadow=true;mesh.receiveShadow=true;mesh.computeBoundingSphere();this.scene.add(mesh);
  }
  private box(group: THREE.Group, size: Vec3, position: Vec3, color: string, metalness=0, roughness=metalness ? .68 : .9) {
    const mesh = new THREE.Mesh(this.cube, new THREE.MeshStandardMaterial({ color, roughness, metalness }));
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
    const hand=new THREE.Group();hand.position.y=-.49;hand.scale.setScalar(1.5);
    this.box(hand,[.065,.12,.148],[0,-.05,0],skinColor);
    const fingerLengths=[.078,.09,.084,.062],palmBottom=-.11;
    for(let finger=0;finger<fingerLengths.length;finger++){
      const length=fingerLengths[finger];
      this.box(hand,[.055,length,.032],[0,palmBottom-length/2+.002,.054-finger*.036],skinColor);
    }
    const thumb=new THREE.Group();thumb.position.set(-side*.014,-.025,.067);thumb.rotation.x=-.18;
    this.box(thumb,[.045,.072,.045],[0,-.03,0],skinColor);hand.add(thumb);arm.add(hand);
    group.add(arm);return arm;
  }
  private styleEntity(group: THREE.Group, enabled: boolean) {
    if (group.userData.enabled === enabled) return;
    group.userData.enabled = enabled;
    group.traverse(object => {
      if (!(object instanceof THREE.Mesh) || !(object.material instanceof THREE.MeshStandardMaterial)) return;
      const material = object.material;
      material.color.set(enabled ? material.userData.activeColor ?? '#ffffff' : '#777f7b');
      material.transparent = enabled ? material.userData.activeTransparent ?? false : true;
      material.opacity = enabled ? material.userData.activeOpacity ?? 1 : .22;
      material.depthWrite = enabled ? material.userData.activeDepthWrite ?? true : false;
    });
  }
  private heldVisual(kind: string, color: string, inHand=true, contents?: string) {
    const visual=new THREE.Group();visual.userData.kind=kind;visual.userData.contents=contents;
    if(inHand){if(kind==='knife'||kind==='shovel')visual.position.set(0,-.565,.23);else if(kind==='spear'||kind==='stick')visual.position.set(0,-.565,.4);else visual.position.set(.36,1,.38);}
    const material=(value:string)=>{const result=new THREE.MeshStandardMaterial({color:value,roughness:.86});result.userData.activeColor=value;return result;};
    if(kind==='stick'){
      const shaft=new THREE.Mesh(new THREE.CylinderGeometry(.035,.05,.68,7),material(color));shaft.rotation.x=Math.PI/2;shaft.rotation.z=.08;shaft.castShadow=true;visual.add(shaft);
    }else if(kind==='arrow'||kind==='spear'){
      const length=kind==='spear' ? .85 : .9,radius=kind==='spear' ? .045 : .025;
      const shaft=new THREE.Mesh(new THREE.CylinderGeometry(radius,radius,length,8),material(color));shaft.rotation.x=Math.PI/2;shaft.castShadow=true;visual.add(shaft);
      const tip=new THREE.Mesh(new THREE.ConeGeometry(kind==='spear' ? .09 : .075,kind==='spear' ? .27 : .18,8),material(color));tip.rotation.x=Math.PI/2;tip.position.z=kind==='spear' ? .52 : .53;tip.castShadow=true;visual.add(tip);
      if(kind==='arrow'){
      const fletching=this.box(visual,[.16,.035,.18],[0,0,-.42],'#d8c7a0');fletching.rotation.z=Math.PI/4;
      }
    }else if(kind==='shovel'){
      const handle=new THREE.Mesh(new THREE.CylinderGeometry(.035,.045,.62,8),material('#6d482d'));handle.rotation.x=Math.PI/2;handle.position.z=.14;handle.castShadow=true;visual.add(handle);
      const outline=new THREE.Shape();
      outline.moveTo(-.055,0);outline.lineTo(.055,0);outline.lineTo(.14,.08);outline.lineTo(.13,.25);outline.lineTo(0,.35);outline.lineTo(-.13,.25);outline.lineTo(-.14,.08);outline.closePath();
      const geometry=new THREE.ExtrudeGeometry(outline,{depth:.05,steps:1,bevelEnabled:true,bevelSegments:1,bevelSize:.008,bevelThickness:.006});geometry.rotateX(Math.PI/2);geometry.translate(0,.025,.43);
      const blade=new THREE.Mesh(geometry,material(color));blade.castShadow=true;blade.receiveShadow=true;visual.add(blade);
    }else if(kind==='knife'){
      const handle=new THREE.Mesh(new THREE.CylinderGeometry(.055,.065,.3,8),material('#5c3a24'));handle.rotation.x=Math.PI/2;handle.position.z=-.2;handle.castShadow=true;visual.add(handle);
      this.box(visual,[.19,.055,.055],[0,0,-.035],'#6d482d');
      const outline=new THREE.Shape();
      outline.moveTo(-.075,0);outline.lineTo(.075,0);outline.lineTo(.065,.25);outline.lineTo(.02,.44);outline.lineTo(0,.5);outline.lineTo(-.065,.3);outline.closePath();
      const geometry=new THREE.ExtrudeGeometry(outline,{depth:.035,steps:1,bevelEnabled:true,bevelSegments:1,bevelSize:.008,bevelThickness:.006});geometry.rotateX(Math.PI/2);geometry.translate(0,.018,0);
      const blade=new THREE.Mesh(geometry,material(color));blade.castShadow=true;blade.receiveShadow=true;visual.add(blade);
    }else if(kind==='bucket'){
      const size=inHand ? .46 : .56,wall=size*.11,inside=size-wall*2;
      this.box(visual,[size,wall,size],[0,-size/2+wall/2,0],color);
      this.box(visual,[wall,size,size],[size/2-wall/2,0,0],color);
      this.box(visual,[wall,size,size],[-size/2+wall/2,0,0],color);
      this.box(visual,[inside,size,wall],[0,0,size/2-wall/2],color);
      this.box(visual,[inside,size,wall],[0,0,-size/2+wall/2],color);
      if(contents){
        const contentColor=this.manifest?.materials[contents]?.color??'#ffffff',water=contents==='water';
        const contentMaterial=new THREE.MeshStandardMaterial({color:contentColor,roughness:water?.32:.96,metalness:water?.08:0,transparent:water,opacity:water?.82:1,side:THREE.DoubleSide});
        contentMaterial.userData.activeColor=contentColor;contentMaterial.userData.activeTransparent=water;contentMaterial.userData.activeOpacity=water?.82:1;contentMaterial.userData.activeDepthWrite=!water;
        const surface=new THREE.Mesh(this.cube,contentMaterial);surface.scale.set(inside*.92,wall*.22,inside*.92);surface.position.y=size/2-wall*.72;surface.castShadow=!water;surface.receiveShadow=true;visual.add(surface);
      }
    }else if(kind==='plank'){
      const board=new THREE.Mesh(this.cube,material(color));board.scale.set(inHand ? .46 : 1,inHand ? .09 : .2,inHand ? .46 : 1);board.castShadow=true;visual.add(board);
    }else if(kind==='door_half_up'||kind==='door_half_down'||kind==='door'){
      const full=kind==='door',height=full ? 1.9 : .9,width=full ? .86 : .8,base=-height/2;
      const leaf=full&&!inHand?new THREE.Group():visual,offset=full&&!inHand?width/2:0;
      if(leaf!==visual){leaf.name='door-hinge';leaf.position.x=-width/2;visual.add(leaf);}
      this.box(leaf,[.07,height,.07],[offset-width/2+.04,base+height/2,0],color);this.box(leaf,[.07,height,.07],[offset+width/2-.04,base+height/2,0],color);
      this.box(leaf,[width,.07,.07],[offset,base+height-.04,0],color);this.box(leaf,[width,.07,.07],[offset,base+.04,0],color);
      for(let y=base+.16;y<base+height-.1;y+=.2)this.box(leaf,[width-.12,.09,.045],[offset,y,0],color);
      if(full){
        const brace=this.box(leaf,[width*.72,.065,.035],[offset,base+height*.52,.065],'#70492f');brace.rotation.z=-.92;
        const outsideKnob=new THREE.Mesh(new THREE.SphereGeometry(.045,10,7),material('#c7a36c'));outsideKnob.position.set(offset+width*.3,base+height*.52,.085);outsideKnob.castShadow=true;leaf.add(outsideKnob);
        const insideKnob=new THREE.Mesh(new THREE.SphereGeometry(.04,10,7),material('#6a4630'));insideKnob.position.set(offset+width*.3,base+height*.52,-.085);insideKnob.castShadow=true;leaf.add(insideKnob);
      }
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
        const legColor='#c98535';
        this.box(group,[.55,.4,.8],[0,.43,0],'#eee5c5'); this.box(group,[.35,.4,.35],[0,.69,.35],'#f7efd3');
        this.box(group,[.28,.12,.3],[0,.62,.6],'#d59a43'); this.box(group,[.07,.07,.08],[-.18,.77,.48],'#263a31'); this.box(group,[.07,.07,.08],[.18,.77,.48],'#263a31');
        for(const [name,x] of [['leg-left',-.16],['leg-right',.16]] as const){
          const leg=new THREE.Group();leg.name=name;leg.position.set(x,.25,0);
          this.box(leg,[.07,.22,.07],[0,-.11,0],legColor);
          this.box(leg,[.16,.07,.26],[0,-.215,.08],legColor);
          group.add(leg);
        }
      } else if (entity.kind === 'miner-robot') {
        const materialType=entity.appearance?.material??(new THREE.Color(entity.color).getHSL({h:0,s:0,l:0}).l>.6?'steel':'iron'),titanium=materialType==='titanium',steel=materialType==='steel';
        const metal=entity.color,brushedMetal=titanium?'#f1f6f7':steel?'#d8dfe1':'#8c928e',darkMetal=titanium?'#91a2a9':steel?'#768084':'#454b48',blackMetal=titanium?'#59676d':steel?'#414a4d':'#252a28',polishedMetal=titanium?'#ffffff':steel?'#f0f5f6':'#aeb3ae',lamp='#f0d994';
        const metalness=entity.appearance?.metalness??(titanium?.99:steel?.94:.72),roughness=entity.appearance?.roughness??(titanium?.16:steel?.3:.68),widthScale=entity.appearance?.widthScale??1;
        const robotBox=(target:THREE.Group,size:Vec3,position:Vec3,color=metal)=>this.box(target,size,position,color,metalness,roughness);
        const metalBox=(size:Vec3,position:Vec3,color=metal)=>robotBox(group,size,position,color);
        metalBox([.18,.25,.58],[-.34,.13,0],darkMetal);
        metalBox([.18,.25,.58],[.34,.13,0],darkMetal);
        metalBox([.035,.19,.52],[-.445,.13,0],blackMetal);
        metalBox([.035,.19,.52],[.445,.13,0],blackMetal);
        const wheelGeometry=new THREE.CylinderGeometry(.085,.085,.045,8),hubGeometry=new THREE.CylinderGeometry(.033,.033,.058,8);
        const trackMaterial=(color:string)=>{const material=new THREE.MeshStandardMaterial({color,roughness:titanium?.2:steel?.34:.58,metalness:titanium?.99:steel?.96:.82});material.userData.activeColor=color;return material;};
        for(const side of [-1,1] as const){
          for(const z of [-.18,0,.18]){
            const wheel=new THREE.Mesh(wheelGeometry,trackMaterial(darkMetal));wheel.rotation.z=Math.PI/2;wheel.position.set(side*.465,.13,z);wheel.castShadow=true;wheel.receiveShadow=true;group.add(wheel);
            const hub=new THREE.Mesh(hubGeometry,trackMaterial(polishedMetal));hub.rotation.z=Math.PI/2;hub.position.set(side*.49,.13,z);hub.castShadow=true;group.add(hub);
          }
          for(const z of [-.24,-.12,0,.12,.24]){
            metalBox([.045,.045,.09],[side*.47,.025,z],blackMetal);
            metalBox([.045,.045,.09],[side*.47,.235,z],blackMetal);
          }
          for(const y of [.075,.14,.205]){
            metalBox([.045,.06,.045],[side*.47,y,-.275],blackMetal);
            metalBox([.045,.06,.045],[side*.47,y,.275],blackMetal);
          }
        }
        if(entity.appearance?.powerModule==='lithium-battery'){
          const lithium='#c8bed8',lithiumDark='#81778f';
          metalBox([.56,.46,.06],[0,.67,-.28],darkMetal);
          this.box(group,[.5,.38,.14],[0,.67,-.35],blackMetal,.9,.3);
          for(const x of [-.17,-.055,.055,.17])this.box(group,[.085,.27,.016],[x,.67,-.428],lithium,.55,.28);
          this.box(group,[.44,.045,.02],[0,.835,-.43],lithiumDark,.65,.25);
          this.box(group,[.44,.045,.02],[0,.505,-.43],lithiumDark,.65,.25);
          this.box(group,[.12,.055,.025],[0,.88,-.4],polishedMetal,.92,.2);
          this.box(group,[.06,.04,.028],[0,.88,-.43],lamp,.15,.24);
        }else if(entity.appearance?.powerModule==='nuclear-reactor'){
          metalBox([.56,.46,.06],[0,.67,-.28],darkMetal);
          this.box(group,[.5,.38,.14],[0,.67,-.35],blackMetal,.94,.26);
          for(const y of [.515,.825])this.box(group,[.48,.045,.02],[0,y,-.43],polishedMetal,.96,.18);
          for(const x of [-.205,.205])for(const y of [.59,.67,.75])this.box(group,[.055,.045,.035],[x,y,-.435],darkMetal,.96,.22);
          const reactorShell=new THREE.Mesh(new THREE.CylinderGeometry(.145,.145,.07,10),trackMaterial(polishedMetal));
          reactorShell.rotation.x=Math.PI/2;reactorShell.position.set(0,.67,-.43);reactorShell.castShadow=true;reactorShell.receiveShadow=true;group.add(reactorShell);
          const coreColor='#d7eea3',coreMaterial=new THREE.MeshStandardMaterial({color:coreColor,emissive:'#526b31',emissiveIntensity:1.1,metalness:.3,roughness:.22});
          coreMaterial.userData.activeColor=coreColor;
          const reactorCore=new THREE.Mesh(new THREE.CylinderGeometry(.075,.075,.078,10),coreMaterial);
          reactorCore.rotation.x=Math.PI/2;reactorCore.position.set(0,.67,-.47);reactorCore.castShadow=true;group.add(reactorCore);
          this.box(group,[.1,.045,.025],[0,.88,-.4],polishedMetal,.92,.2);
          this.box(group,[.045,.03,.028],[0,.88,-.43],lamp,.15,.24);
        }
        metalBox([.62,.18,.5],[0,.35,0],brushedMetal);
        metalBox([.68,.43,.48],[0,.61,0]);
        metalBox([.34,.22,.035],[0,.62,.258],darkMetal);
        this.box(group,[.08,.08,.04],[-.1,.63,.278],lamp);
        this.box(group,[.08,.08,.04],[.1,.63,.278],lamp);
        metalBox([.17,.12,.17],[0,.88,0],darkMetal);
        metalBox([.72,.35,.43],[0,1.08,0]);
        metalBox([.52,.18,.035],[0,1.08,.233],darkMetal);
        this.box(group,[.15,.11,.04],[-.14,1.09,.255],lamp);
        this.box(group,[.15,.11,.04],[.14,1.09,.255],lamp);
        metalBox([.05,.035,.045],[-.14,1.087,.282],blackMetal);
        metalBox([.05,.035,.045],[.14,1.087,.282],blackMetal);
        metalBox([.2,.14,.18],[0,1.325,.01],darkMetal);
        this.box(group,[.11,.075,.035],[0,1.325,.118],lamp);
        for(const [name,side] of [['arm-left',-1],['arm-right',1]] as const){
          const arm=new THREE.Group();arm.name=name;arm.position.set(side*.43,.8,0);
          robotBox(arm,[.13,.36,.16],[0,-.18,0]);
          robotBox(arm,[.18,.13,.2],[0,-.4,.03],darkMetal);
          robotBox(arm,[.06,.12,.08],[-side*.07,-.5,.08],blackMetal);
          robotBox(arm,[.06,.12,.08],[side*.07,-.5,.08],blackMetal);
          group.add(arm);
        }
        group.scale.set(2*widthScale,2.043,2);
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
      const label=document.createElement('button');label.className='entity-label';label.textContent=entity.name;label.addEventListener('click',()=>this.onSelect(entity.id));this.container.append(label);this.labels.set(entity.id,label);
    }
  }
  select(id: string) { this.selected = id; }
  focus(id = this.selected) {
    const e = this.current?.entities.find(e => e.id === id); if (!e) return;
    this.selected = id; this.following = true; this.target.set(...e.position); this.controls.target.copy(this.target).add(new THREE.Vector3(0,1,0)); this.camera.position.copy(this.target).add(new THREE.Vector3(11,9,14)); this.controls.update();
  }
  overview() {
    this.following=false;
    const position=this.manifest?.view?.overviewPosition??[86,79,103],target=this.manifest?.view?.overviewTarget??[0,2,0];
    this.camera.position.set(...position);this.controls.target.set(...target);this.controls.update();this.buildProceduralGround();
  }
  topDown() { this.following = false; this.camera.position.set(0,145,.01); this.controls.target.set(0,0,0); this.controls.update(); }
  private animate = () => {
    this.frameId = requestAnimationFrame(this.animate);
    const now = performance.now(), dt = Math.min((now-this.last)/1000,.1); this.last = now;
    const alpha = Math.min(1,(now-this.received)/this.interpolationMs);
    if (this.current) {
      const visualTime = (this.prior?.time ?? this.current.time) + (this.current.time - (this.prior?.time ?? this.current.time)) * alpha;
      for (const e of this.current.entities) {
        const group = this.creatures.get(e.id)!; const previous = this.prior?.entities.find(p => p.id === e.id) ?? e;
        const enabled = e.enabled !== false;
        let held = this.held.get(e.id);
        const carried=e.inventory?.selected===null||!e.inventory?undefined:e.inventory.stacks[e.inventory.selected];
        if (carried) {
          const color=this.manifest!.materials[carried.kind]?.color??'#ffffff';
          const contents=carried.contents??(carried.water?'water':undefined);
          if (!held || held.userData.kind!==carried.kind || held.userData.contents!==contents) { if(held)this.disposeItemVisual(held);held=this.heldVisual(carried.kind,color,true,contents);const hand=carried.kind==='spear'||carried.kind==='stick'||carried.kind==='knife'||carried.kind==='shovel'?group.getObjectByName('arm-right'):undefined;(hand??group).add(held);this.held.set(e.id,held);group.userData.enabled=undefined; }
          held.visible = true;
        } else if (held) held.visible = false;
        this.styleEntity(group,enabled);
        group.position.set(...previous.position).lerp(new THREE.Vector3(...e.position),alpha);
        const turn = Math.atan2(Math.sin((e.yaw-previous.yaw)*Math.PI/180),Math.cos((e.yaw-previous.yaw)*Math.PI/180)); group.rotation.y = previous.yaw*Math.PI/180+turn*alpha;
        const walking = e.motion && distanceSquared(e.position,previous.position) > .00001;
        const gait=Math.sin(visualTime*9);
        for (const name of ['leg-left','leg-right']) { const leg = group.getObjectByName(name); if (leg) leg.rotation.x = walking ? gait*(name === 'leg-left' ? .32 : -.32) : 0; }
        const leftArm=group.getObjectByName('arm-left'),rightArm=group.getObjectByName('arm-right'),punch=this.punches.get(e.id),miner=e.kind==='miner-robot',showcase=e.motion?.kind==='showcase';
        if(miner){
          const progress=showcase?e.motion?.progress??0:0,extension=showcase?(progress<.2?progress/.2:progress>.8?(1-progress)/.2:1):0,pitch=e.motion?.kind==='reverse'?Math.PI/4:walking?-Math.PI/4:0;
          if(leftArm){leftArm.rotation.x=pitch;leftArm.rotation.z=-extension*Math.PI/2;}
          if(rightArm){rightArm.rotation.x=pitch;rightArm.rotation.z=extension*Math.PI/2;}
        }else{
          if(leftArm)leftArm.rotation.x=walking?-gait*.3:0;
          if(rightArm){if(punch&&visualTime<=punch.until){const phase=Math.max(0,Math.min(1,(visualTime-punch.start)/(punch.until-punch.start)));rightArm.rotation.x=-Math.sin(Math.PI*phase)*1.8;}else{rightArm.rotation.x=walking?gait*.3:0;if(punch)this.punches.delete(e.id);}}
        }
        const label=this.labels.get(e.id)!;const projected=group.position.clone().add(new THREE.Vector3(0,e.height+.7,0)).project(this.camera);
        label.style.display=Math.abs(projected.x)>1||Math.abs(projected.y)>1||projected.z>1?'none':'block';
        label.style.left=`${(projected.x*.5+.5)*this.container.clientWidth}px`;label.style.top=`${(-projected.y*.5+.5)*this.container.clientHeight}px`;
        label.classList.toggle('selected',e.id===this.selected);label.classList.toggle('disabled',!enabled);label.textContent=entityLabelText(e);
        if (e.id === this.selected && enabled && this.following) { const next = group.position.clone().add(new THREE.Vector3(0,1,0)); const delta = next.clone().sub(this.controls.target); this.camera.position.add(delta); this.controls.target.copy(next); }
      }
      const ids = new Set(this.current.bodies.map(b => b.id));
      for (const [id,object] of this.objects) if (!ids.has(id)) { this.disposeItemVisual(object); this.objects.delete(id); }
      for (const b of this.current.bodies) {
        let object = this.objects.get(b.id);
        if (!object) {
          const color=this.manifest!.materials[b.kind]?.color??'#ffffff';
          if(['stick','arrow','spear','shovel','knife','bucket','plank','door_half_up','door_half_down','door'].includes(b.kind))object=this.heldVisual(b.kind,color,false,b.contents??(b.water?'water':undefined));else{const mesh=new THREE.Mesh(this.cube,new THREE.MeshStandardMaterial({color}));mesh.scale.setScalar(.56);mesh.castShadow=true;object=mesh;}
          this.scene.add(object);this.objects.set(b.id,object);
        }
        const previous = this.prior?.bodies.find(p => p.id === b.id) ?? b; object.position.set(...previous.position).lerp(new THREE.Vector3(...b.position),alpha);
        if(b.door){
          object.rotation.set(0,b.door.outsideYaw*Math.PI/180,0);
          const hinge=object.getObjectByName('door-hinge'),previousAngle=previous.door?.angle??b.door.angle;
          if(hinge)hinge.rotation.y=(previousAngle+(b.door.angle-previousAngle)*alpha)*Math.PI/180;
        }else if (!b.resting) object.rotation.set(visualTime*2,visualTime*.8,0);
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
    this.buildProceduralGround();
    this.controls.update(); this.renderer.render(this.scene,this.camera);
  };
  dispose() { cancelAnimationFrame(this.frameId); this.observer.disconnect(); this.controls.dispose();for(const label of this.labels.values())label.remove();this.labels.clear();if(this.proceduralGround){this.scene.remove(this.proceduralGround);this.proceduralGround.dispose();}this.renderer.dispose(); }
}
const distanceSquared = (a: Vec3,b: Vec3) => a.reduce((sum,v,i) => sum+(v-b[i])**2,0);
