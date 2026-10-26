// Trusted declarative scene input; packages never supply renderer code or URLs.
const num=(v,a,b)=>typeof v==='number'&&Number.isFinite(v)&&v>=a&&v<=b;
const vec=(v,a=-200,b=200)=>Array.isArray(v)&&v.length===3&&v.every(n=>num(n,a,b));
const hex=v=>typeof v==='string'&&/^#[0-9a-f]{6}$/i.test(v);
const id=v=>typeof v==='string'&&!['constructor','prototype'].includes(v)&&/^[a-z][a-z0-9-]{0,63}$/.test(v);
function exact(o,keys){if(!o||typeof o!=='object'||Array.isArray(o)||Object.keys(o).some(k=>!keys.includes(k)))throw Error('Unknown 3D field');}
function camera(v){exact(v,['position','target','fov']);if(!vec(v.position)||!vec(v.target)||!num(v.fov,20,90)||v.position.every((n,i)=>n===v.target[i]))throw Error('Invalid 3D camera');}
export function parseWorld(raw){
 exact(raw,['schema','fps','clearColor','fog','camera','objects','slots','views','environment','exposure','cueDurationMs','lights','cues','environmentIntensity','frameStyles']);
 if(raw.schema!=='producer.scene3d/1'||![30,60].includes(raw.fps)||!hex(raw.clearColor))throw Error('Invalid 3D world');
 exact(raw.fog,['color','near','far']);if(!hex(raw.fog.color)||!num(raw.fog.near,1,100)||!num(raw.fog.far,raw.fog.near+1,200))throw Error('Invalid 3D fog');camera(raw.camera);
 if(raw.environment!==undefined&&!['none','studio'].includes(raw.environment))throw Error('Invalid environment');
 if(raw.environmentIntensity!==undefined&&!num(raw.environmentIntensity,0,2))throw Error('Invalid environment intensity');
 if(raw.exposure!==undefined&&!num(raw.exposure,.5,2))throw Error('Invalid exposure');
 if(raw.cueDurationMs!==undefined&&!num(raw.cueDurationMs,0,2000))throw Error('Invalid cue duration');
 if(raw.views!==undefined){if(!raw.views||typeof raw.views!=='object'||Array.isArray(raw.views)||Object.keys(raw.views).length>12)throw Error('Invalid views');for(const[k,v]of Object.entries(raw.views)){if(!id(k))throw Error('Invalid view identity');camera(v);}}
 if(!Array.isArray(raw.objects)||raw.objects.length>128)throw Error('3D object budget exceeded');
 const ids=new Set();
 for(const n of raw.objects){
  exact(n,['id','kind','args','position','rotation','color','metalness','roughness','emissive','emissiveIntensity','opacity','unlit','motion','castShadow','receiveShadow','pass','visible']);
  if(!id(n.id)||ids.has(n.id))throw Error('Invalid 3D object identity');ids.add(n.id);
  const counts={box:3,roundedBox:5,cylinder:4,torus:4,cone:3,plane:2,sphere:3};
  if(!Object.hasOwn(counts,n.kind)||!Array.isArray(n.args)||n.args.length!==counts[n.kind]||!n.args.every(v=>num(v,.001,64)))throw Error('Invalid 3D geometry');
  const segments=n.kind==='torus'?[2,3]:n.kind==='cylinder'||n.kind==='cone'?[n.args.length-1]:n.kind==='sphere'?[1,2]:n.kind==='roundedBox'?[3]:[];
  for(const index of segments)if(!Number.isInteger(n.args[index])||n.args[index]>(n.kind==='roundedBox'?5:64)||n.args[index]<3)throw Error('3D geometry subdivision budget exceeded');
  if(n.kind==='roundedBox'&&n.args[4]>Math.min(...n.args.slice(0,3))/2)throw Error('Invalid bevel radius');
  if(!vec(n.position)||!vec(n.rotation,-7,7)||!hex(n.color)||!num(n.metalness,0,1)||!num(n.roughness,0,1))throw Error('Invalid 3D transform/material');
  if(n.pass!==undefined&&!['background','foreground'].includes(n.pass))throw Error('Invalid mesh pass');
  for(const key of ['visible','unlit','castShadow','receiveShadow'])if(n[key]!==undefined&&typeof n[key]!=='boolean')throw Error('Invalid 3D material flag');
  if(n.emissive!==undefined&&!hex(n.emissive)||n.emissiveIntensity!==undefined&&!num(n.emissiveIntensity,0,5)||n.opacity!==undefined&&!num(n.opacity,0,1))throw Error('Invalid 3D material');
  if(n.motion){exact(n.motion,['kind','speed','amplitude','phase','clock']);if(!['rotateY','swayZ','moveY'].includes(n.motion.kind)||!num(n.motion.speed,-2,2)||!num(n.motion.amplitude,0,1)||!num(n.motion.phase,0,7))throw Error('Invalid 3D motion');if(n.motion.clock!==undefined&&!['set','cue'].includes(n.motion.clock))throw Error('Invalid motion clock');}
 }
 if(!Array.isArray(raw.slots)||raw.slots.length>8||raw.slots.some(s=>!Array.isArray(s)||s.length!==4||!s.every(n=>num(n,0,1))||s[2]<=0||s[3]<=0||s[0]+s[2]>1||s[1]+s[3]>1))throw Error('Invalid 3D slot bounds');
 if(raw.frameStyles!==undefined){if(!Array.isArray(raw.frameStyles)||raw.frameStyles.length>raw.slots.length)throw Error('Invalid frame styles');for(const f of raw.frameStyles){exact(f,['color','metalness','roughness','thickness','depth','radius']);if(f.color!==undefined&&!hex(f.color)||f.metalness!==undefined&&!num(f.metalness,0,1)||f.roughness!==undefined&&!num(f.roughness,0,1)||['thickness','depth','radius'].some(k=>f[k]!==undefined&&!num(f[k],.5,32)))throw Error('Invalid frame material');}}
 if(raw.lights!==undefined){if(!Array.isArray(raw.lights)||raw.lights.length>8)throw Error('Light budget exceeded');for(const l of raw.lights){exact(l,['id','position','color','intensity']);if(!id(l.id)||!vec(l.position)||!hex(l.color)||!num(l.intensity,0,400))throw Error('Invalid light');}}
 if(raw.lights&&new Set(raw.lights.map(l=>l.id)).size!==raw.lights.length)throw Error('Duplicate light');
 if(raw.cues!==undefined){if(!raw.cues||typeof raw.cues!=='object'||Array.isArray(raw.cues)||Object.keys(raw.cues).length>32||!Object.hasOwn(raw.cues,'neutral'))throw Error('Invalid cues');
  for(const [key,c]of Object.entries(raw.cues)){if(!id(key))throw Error('Invalid cue identity');exact(c,['lights','view','durationMs','visibility']);if(c.durationMs!==undefined&&!num(c.durationMs,0,2000))throw Error('Invalid cue duration');if(c.view!==undefined&&!Object.hasOwn(raw.views??{},c.view))throw Error('Unknown cue view');if(c.visibility!==undefined){if(!c.visibility||typeof c.visibility!=='object'||Array.isArray(c.visibility))throw Error('Invalid visibility targets');for(const[k,v]of Object.entries(c.visibility))if(!ids.has(k)||typeof v!=='boolean')throw Error('Unknown visibility target');}if(c.lights!==undefined){if(!c.lights||typeof c.lights!=='object'||Array.isArray(c.lights))throw Error('Invalid light targets');for(const[k,v]of Object.entries(c.lights))if(!raw.lights?.some(l=>l.id===k)||!num(v,0,400))throw Error('Invalid light target');}}
 }
 return structuredClone(raw);
}
export function parseControl(raw){
 exact(raw,['revision','anchor','paused','elapsed','cue','view','rendering','cueSequence']);
 if(raw.cueSequence!==undefined&&(!Number.isSafeInteger(raw.cueSequence)||raw.cueSequence<0))throw Error('Invalid cue sequence');
 if(raw.rendering!==undefined&&typeof raw.rendering!=='boolean')throw Error('Invalid render demand');
 if(!Number.isSafeInteger(raw.revision)||raw.revision<0||!num(raw.anchor,0,1e15)||typeof raw.paused!=='boolean'||!num(raw.elapsed,0,86400000)||!id(raw.cue)||(raw.view!==undefined&&!id(raw.view)))throw Error('Invalid 3D control');
 return structuredClone(raw);
}
const numeric=(minimum,maximum)=>({type:'number',minimum,maximum});
const exactObject=(properties,required=Object.keys(properties))=>({type:'object',additionalProperties:false,properties,required});
const vectorSchema=(a,b)=>({type:'array',minItems:3,maxItems:3,items:numeric(a,b)});
const colorSchema={type:'string',pattern:'^#[0-9a-fA-F]{6}$'},idSchema={type:'string',pattern:'^[a-z][a-z0-9-]{0,63}$'};
const cameraSchema=exactObject({position:vectorSchema(-200,200),target:vectorSchema(-200,200),fov:numeric(20,90)});
const meshProperties={pass:{enum:['background','foreground']},visible:{type:'boolean'},id:idSchema,kind:{enum:['box','roundedBox','cylinder','torus','cone','plane','sphere']},args:{type:'array',minItems:2,maxItems:5,items:numeric(.001,64)},position:vectorSchema(-200,200),rotation:vectorSchema(-7,7),color:colorSchema,metalness:numeric(0,1),roughness:numeric(0,1),emissive:colorSchema,emissiveIntensity:numeric(0,5),opacity:numeric(0,1),unlit:{type:'boolean'},castShadow:{type:'boolean'},receiveShadow:{type:'boolean'},motion:exactObject({kind:{enum:['rotateY','swayZ','moveY']},speed:numeric(-2,2),amplitude:numeric(0,1),phase:numeric(0,7),clock:{enum:['set','cue']}},['kind','speed','amplitude','phase'])};
const meshSchema=exactObject(meshProperties,['id','kind','args','position','rotation','color','metalness','roughness']);
meshSchema.allOf=Object.entries({box:3,roundedBox:5,cylinder:4,torus:4,cone:3,plane:2,sphere:3}).map(([kind,count])=>({if:{properties:{kind:{const:kind}}},then:{properties:{args:{minItems:count,maxItems:count}}}}));
export const WORLD_SCHEMA=exactObject({schema:{const:'producer.scene3d/1'},fps:{enum:[30,60]},clearColor:colorSchema,fog:exactObject({color:colorSchema,near:numeric(1,100),far:numeric(2,200)}),camera:cameraSchema,objects:{type:'array',maxItems:128,items:meshSchema},frameStyles:{type:'array',maxItems:8,items:exactObject({color:colorSchema,metalness:numeric(0,1),roughness:numeric(0,1),thickness:numeric(.5,32),depth:numeric(.5,32),radius:numeric(.5,32)},[])},slots:{type:'array',maxItems:8,items:{type:'array',minItems:4,maxItems:4,items:numeric(0,1)}},views:{type:'object',maxProperties:12,propertyNames:idSchema,additionalProperties:cameraSchema},environment:{enum:['none','studio']},exposure:numeric(.5,2),environmentIntensity:numeric(0,2),cueDurationMs:numeric(0,2000),lights:{type:'array',maxItems:8,items:exactObject({id:idSchema,position:vectorSchema(-200,200),color:colorSchema,intensity:numeric(0,400)})},cues:{type:'object',maxProperties:32,required:['neutral'],propertyNames:idSchema,additionalProperties:exactObject({visibility:{type:'object',maxProperties:128,propertyNames:idSchema,additionalProperties:{type:'boolean'}},lights:{type:'object',maxProperties:8,propertyNames:idSchema,additionalProperties:numeric(0,400)},view:idSchema,durationMs:numeric(0,2000)},[])}},['schema','fps','clearColor','fog','camera','objects','slots']);
