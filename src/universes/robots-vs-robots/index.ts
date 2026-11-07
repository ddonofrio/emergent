import { standardMaterials } from '../../core/materials';
import { terrainSurfaceY } from '../../core/procedural-terrain';
import { WORLD_DAY_SECONDS } from '../../core/time';
import type { Action, Entity, NoiseTerrain, UniverseModule, Vec3 } from '../../core/types';

const terrain:NoiseTerrain={
  type:'noise',floor:{y:-32,kind:'bedrock'},stone:'stone',
  soil:{depth:3,temperate:'dirt',temperateSurface:'grass',arid:'sand',aridSurface:'sand'},
  baseHeight:5,ceiling:42,waterLevel:2,
  hills:{frequency:.012,octaves:4,fractal:'fbm',amplitude:5},
  mountains:{frequency:.0035,octaves:4,fractal:'ridged',amplitude:24,threshold:.57},
  biome:{frequency:.0028,octaves:3,fractal:'fbm',aridThreshold:.08},
  dunes:{frequency:.028,octaves:3,fractal:'ridged',amplitude:4},
  rivers:{frequency:.0045,octaves:4,fractal:'fbm',width:.045,bankWidth:.04,bedHeight:0},
  spawn:{radius:24,blend:18,height:4},
  ores:[
    {kind:'titanium_ore',minY:-29,maxY:-8,frequency:.075,octaves:3,fractal:'fbm',threshold:.68,seedOffset:1601},
    {kind:'lithium_ore',minY:-24,maxY:2,frequency:.08,octaves:3,fractal:'fbm',threshold:.65,seedOffset:1409},
    {kind:'quartz',minY:-28,maxY:8,frequency:.105,octaves:3,fractal:'fbm',threshold:.46,seedOffset:1201},
    {kind:'coal',minY:-28,maxY:10,frequency:.11,octaves:3,fractal:'fbm',threshold:.44,seedOffset:1009},
    {kind:'copper_ore',minY:-25,maxY:8,frequency:.105,octaves:3,fractal:'fbm',threshold:.45,seedOffset:809},
    {kind:'iron_ore',minY:-29,maxY:10,frequency:.115,octaves:3,fractal:'fbm',threshold:.42,seedOffset:607},
  ],
};

const materials={
  ...standardMaterials,
  bedrock:{color:'#252b30',solid:true,floats:false,breakable:false},
  iron_ore:{color:'#9a745d',solid:true,floats:false},
  copper_ore:{color:'#b8734f',solid:true,floats:false},
  lithium_ore:{color:'#c8bed8',solid:true,floats:false},
  coal:{color:'#303536',solid:true,floats:false},
  quartz:{color:'#e3e0d4',solid:true,floats:false},
  titanium_ore:{color:'#718a9b',solid:true,floats:false},
};
const worldSeed=1701;
const frontZ=.5,batteryZ=-2.22,reactorZ=-4.94,fullRadius=.86,slimRadius=.7;
const formationX={min01:-2.22,min02:.5,min03:3.06};
const spawn=(x:number,z:number):Vec3=>[x,terrainSurfaceY(terrain,worldSeed,x,z)+1,z];

interface SquareAutomation {
  routine:'square';origin:Vec3;forward:[number,number];right:[number,number];startYaw:number;
  corner:0|1|2|3;phase:'patrol'|'showcase'|'reverse'|'return';lastCommand:'path'|'detour'|'showcase';avoidSide:-1|1;cycles:number;
}

function initializeSquare(entity:Entity){
  const startYaw=((Math.round(entity.yaw/90)*90)%360+360)%360,angle=startYaw*Math.PI/180,forward:[number,number]=[Math.sin(angle),Math.cos(angle)],right:[number,number]=[Math.cos(angle),-Math.sin(angle)];
  entity.yaw=startYaw;entity.automation={routine:'square',origin:[...entity.position],forward,right,startYaw,corner:0,phase:'patrol',lastCommand:'path',avoidSide:1,cycles:0} satisfies SquareAutomation;
}

function squareAutomationAction(entity:Entity):Action|undefined{
  if(entity.kind!=='miner-robot')return;
  if(entity.automation?.routine!=='square')initializeSquare(entity);
  const state=entity.automation as unknown as SquareAutomation;
  if(state.phase==='showcase'){state.phase='reverse';state.lastCommand='showcase';return{action:'reverse',distance:1.5};}
  if(state.phase==='reverse'){state.phase='return';return{action:'walk',target:[...state.origin]};}
  if(state.phase==='return'){
    if(Math.hypot(entity.position[0]-state.origin[0],entity.position[2]-state.origin[2])>.12)return{action:'walk',target:[...state.origin]};
    state.phase='patrol';entity.yaw=state.startYaw;delete entity.lastAction;
  }
  const f=state.forward,r=state.right,o=state.origin,corners:Vec3[]=[
    [o[0]+f[0]*10,o[1],o[2]+f[1]*10],
    [o[0]+f[0]*10+r[0]*10,o[1],o[2]+f[1]*10+r[1]*10],
    [o[0]+r[0]*10,o[1],o[2]+r[1]*10],
    [...o],
  ];
  let target=corners[state.corner];
  if(Math.hypot(entity.position[0]-target[0],entity.position[2]-target[2])<=.12){
    if(state.corner===3){
      state.corner=0;state.phase='showcase';state.lastCommand='showcase';state.cycles++;entity.yaw=state.startYaw;delete entity.lastAction;
      entity.motion={kind:'showcase',destination:[...entity.position],origin:[...entity.position],speed:0,progress:0,duration:3,startYaw:state.startYaw};entity.status='showcasing';return;
    }
    state.corner=(state.corner+1) as 0|1|2|3;target=corners[state.corner];delete entity.lastAction;
  }
  if(entity.lastAction?.ok===false){
    if(state.lastCommand==='detour')state.avoidSide=state.avoidSide===1?-1:1;
    const dx=target[0]-entity.position[0],dz=target[2]-entity.position[2],length=Math.max(.001,Math.hypot(dx,dz)),ahead:[number,number]=[dx/length,dz/length],side:[number,number]=[ahead[1]*state.avoidSide,-ahead[0]*state.avoidSide];
    state.lastCommand='detour';delete entity.lastAction;
    return{action:'walk',target:[entity.position[0]+side[0]*2.25,entity.position[1],entity.position[2]+side[1]*2.25]};
  }
  state.lastCommand='path';return{action:'walk',target};
}

const min01: Entity = {
  id: 'min-01',
  name: 'MIN-01',
  kind: 'miner-robot',
  controller: 'static',
  enabled: true,
  position: spawn(formationX.min01,frontZ),
  yaw: 0,
  height: 2.86,
  hitbox: { radius: .86, height: 2.86, terrainRadius:.86 },
  color: '#7b817b',
  inventory: null,
  status: 'idle',
  appearance:{material:'iron'},
};

const min02: Entity = {
  ...min01,
  id: 'min-02',
  name: 'MIN-02',
  position: spawn(formationX.min02,frontZ),
  color: '#c4cbcd',
  hitbox: { ...min01.hitbox! },
  appearance:{material:'steel'},
};

const min03: Entity = {
  ...min01,
  id:'min-03',
  name:'MIN-03',
  position:spawn(formationX.min03,frontZ),
  color:'#e6eef1',
  hitbox:{radius:slimRadius,height:2.86,terrainRadius:slimRadius},
  appearance:{material:'titanium',widthScale:.82,metalness:.99,roughness:.16},
};

const poweredVariant=(base:Entity,id:string,name:string,z:number,powerModule:'lithium-battery'|'nuclear-reactor'):Entity=>({
  ...base,id,name,position:spawn(base.position[0],z),hitbox:{...base.hitbox!},appearance:{...base.appearance,powerModule},
});
const baseMiners=[min01,min02,min03];
const batteryMiners=[
  poweredVariant(min01,'min-01bt','MIN-01BT',batteryZ,'lithium-battery'),
  poweredVariant(min02,'min-02bt','MIN-02BT',batteryZ,'lithium-battery'),
  poweredVariant(min03,'min-03bt','MIN-03BT',batteryZ,'lithium-battery'),
];
const reactorMiners=[
  poweredVariant(min01,'min-01nr','MIN-01NR',reactorZ,'nuclear-reactor'),
  poweredVariant(min02,'min-02nr','MIN-02NR',reactorZ,'nuclear-reactor'),
  poweredVariant(min03,'min-03nr','MIN-03NR',reactorZ,'nuclear-reactor'),
];
const miners=[...baseMiners,...batteryMiners,...reactorMiners];

export const robotsVsRobots: UniverseModule = {
  manifest: {
    id: 'robots-vs-robots',
    version: 2,
    name: 'Robots vs Robots',
    seed: worldSeed,
    description: 'An unbounded mineral world of mountains, dunes and rivers above permanent bedrock.',
    bounds: { min: [-1_000_000_000, -32, -1_000_000_000], max: [1_000_000_000, 64, 1_000_000_000] },
    infiniteHorizontal: true,
    terrain,
    view: { overviewPosition: [18, 18, 26], overviewTarget: [.5, 4, .5], maxDistance: 120, fog: { near: 75, far: 150 } },
    waterLevel: terrain.waterLevel,
    gravity: 9.81,
    daySeconds: WORLD_DAY_SECONDS,
    vocabulary: [],
    perception: { range: 18, fieldOfView: 120, maxBlocks: 96 },
    materials,
    agentInstructions: 'You are {name}, an embodied robot in an unbounded physical world. Choose your own goals and success conditions. Keep your goals and memory in this continuing conversation. Use tools to act and learn only from local observations and their results. Unseen space is unknown. You decide whether observed results satisfy your goals.',
  },
  generate: () => ({ blocks: [], entities: miners }),
  initializeAutomaton:initializeSquare,
  automatonAction:squareAutomationAction,
  migrateState(state) {
    const exact=!state.entities.some(entity=>entity.id==='duck')&&miners.every(template=>{
      const existing=state.entities.find(entity=>entity.id===template.id);
      return existing&&JSON.stringify(existing.hitbox)===JSON.stringify(template.hitbox)&&JSON.stringify(existing.appearance)===JSON.stringify(template.appearance);
    });
    if(exact)return;
    const migrated=miners.map(template=>{
      const existing=state.entities.find(entity=>entity.id===template.id),robot:Entity={...existing,...template,enabled:existing?.enabled!==false,controller:'static',status:'idle',inventory:null};
      delete robot.intent;delete robot.motion;delete robot.following;delete robot.lastAction;delete robot.automation;
      delete robot.speech;delete robot.speechBudget;return robot;
    });
    const ids=new Set(['duck',...miners.map(robot=>robot.id)]);
    return {
      state:{...state,entities:[...state.entities.filter(entity=>!ids.has(entity.id)),...migrated]},
      events:[{
        actor:'world',type:'entity-formation',message:'The base miners formed the front row, their lithium-battery variants formed behind them, and their compact nuclear-reactor variants formed the rear row. All nine robots face forward with at least one metre of clearance.',
        data:{removed:['duck'],robots:migrated.map(robot=>({id:robot.id,position:robot.position,material:robot.appearance?.material}))},
      }],
    };
  },
};
