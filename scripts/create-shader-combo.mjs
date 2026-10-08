import fs from 'node:fs';
import {build} from 'esbuild';
const bundle=await build({stdin:{contents:"export {RehearsalSession} from './src/features/presentation/rehearsal';export {setOutputProjection} from './src/features/presentation/useSetOutput';",resolveDir:process.cwd()},bundle:true,platform:'browser',format:'esm',write:false});
const {RehearsalSession,setOutputProjection}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const scenes=[
 ['liquid','Liquid conversation','plasma','THINK IN\nFULL COLOR.','#111228','#6540a7','#fa83c5',2],
 ['silk','Silk studio','silk','SLOW DOWN.\nGO DEEPER.','#071d25','#277d8b','#a0f0d8',1],
 ['pulse','Pulse exchange','rings','TWO VOICES.\nONE FREQUENCY.','#17102c','#7256ba','#ffbcde',2],
 ['grid','Future grid','grid','BUILD WHAT\nCOMES NEXT.','#061922','#147684','#7aefdc',2],
 ['stars','Night shift','stars','BIG IDEAS.\nOPEN SKY.','#050b22','#4a62c2','#d2ddff',1],
 ['petals','Prismatic garden','petals','LET CURIOSITY\nUNFOLD.','#210f26','#a04483','#ffcb95',2],
 ['contours','Common ground','contours','MAP A NEW\nPERSPECTIVE.','#092321','#237b64','#cbf29b',2],
 ['prism','Color theory','prism','EVERY ANGLE\nADDS SOMETHING.','#15102b','#7241be','#ef98e2',1],
 ['aurora-duet','Northern duet','aurora','MEET IN\nTHE MIDDLE.','#071b2a','#197f9c','#9aeed9',2],
 ['copper-silk','Copper craft','silk','HANDS ON.\nMINDS OPEN.','#251609','#a06833','#ffd7a4',2],
 ['solar-pulse','Solar spotlight','rings','MAKE YOUR\nMOMENT COUNT.','#29101a','#bd3a55','#ffd099',1],
 ['blueprint','The blueprint','grid','FROM WHAT IF\nTO WHAT IS.','#07132c','#315caf','#a4d1ff',2],
 ['neon-liquid','Neon chemistry','plasma','A LITTLE\nCREATIVE FRICTION.','#200c31','#bd36a2','#ffaad5',2],
 ['orbit','In good company','stars','STORIES THAT\nTRAVEL FURTHER.','#0c102b','#756bbf','#ffddbc',2],
 ['paper-contour','Field notes','contours','NOTICE MORE.\nASK BETTER.','#202418','#758355','#e3ecc1',1],
 ['finale','The afterglow','petals','KEEP THE\nCONVERSATION GOING.','#1c0c24','#9e437e','#ffcba0',2]
].map(([id,label,effect,title,...v],i)=>({id,label,effect,title,colors:v.slice(0,3),hosts:v[3],i}));
const box=(id,x,y,w,h,styles={})=>({id,type:'box',children:[],styles:{position:'absolute',left:x,top:y,width:w,height:h,...styles}});
const text=(id,x,y,w,size,value,styles={})=>({id,type:'text',text:value,styles:{position:'absolute',left:x,top:y,width:w,fontSize:size,fontWeight:700,lineHeight:1.06,color:'#f4f4ff',...styles}});
const shader=(id,x,y,w,h,effect,colors,extra={})=>({id,type:'shader',styles:{position:'absolute',left:x,top:y,width:w,height:h},shader:{effect,colors,speed:.5,intensity:1,scale:1,opacity:1,radius:30,quality:'low',clock:'segment',...extra}});
const track=(target,property,from,to,ms=800,extra={})=>({target,property,easing:'easeInOut',keyframes:[{atMs:0,value:from},{atMs:ms,value:to}],...extra});
function layout(s,vertical){
 const width=vertical?720:1280,height=vertical?1280:720,two=s.hosts===2;
 // Portrait is composed at 720x1280: full-width stacked cards, short names
 // outside the camera image, and a compact title reserved above both faces.
 const cards=vertical?(two?[{x:44,y:324,w:632,h:356},{x:44,y:754,w:632,h:356}]:[{x:44,y:420,w:632,h:652}]):
   (two?[{x:48,y:248,w:576,h:324},{x:656,y:248,w:576,h:324}]:[{x:664,y:146,w:568,h:480}]);
 const tx=vertical?44:48,ty=vertical?124:two?110:202,tw=vertical?632:two?1140:566;
 const layers=[shader('field',0,0,width,height,s.effect,s.colors,{speed:s.effect==='stars'?.35:.4+s.i%4*.18,scale:s.effect==='stars'?1.2:.7+s.i%3*.25,intensity:s.effect==='grid'?.65:1.1})];
 cards.forEach((c,i)=>layers.push(shader('halo-'+i,c.x-10,c.y-10,c.w+20,c.h+20,'edgeGlow',s.colors,{speed:.7+i*.2,intensity:1.4,scale:1.2,quality:'medium',radius:34})));
 layers.push(shader('sweep',tx,ty-8,tw,vertical?150:two?114:172,'lightSweep',s.colors,{speed:.9,opacity:.32,intensity:.8}));
 const children=[...layers,
  // A translucent scrim under typography retains contrast across bright fields.
  box('title-scrim',tx-12,ty-18,tw+24,vertical?170:two?134:280,{background:'rgba(5,9,23,0.58)',borderRadius:22}),
  {id:'brand-mark',type:'media',assetId:'mark',fit:'contain',styles:{position:'absolute',left:44,top:44,width:24,height:24}},
  text('brand',80,47,width-150,15,'LOCAL / SIGNAL — COMBO STUDIO',{letterSpacing:2}),
  {...box('title',tx,ty,tw,vertical?118:two?102:140),children:s.title.split('\n').map((line,i)=>text('title-line-'+i,0,i*(vertical?56:two?50:68),tw,vertical?50:two?44:60,line))},
  text('edition',tx,vertical?264:two?220:362,tw,14,String(s.i+1).padStart(2,'0')+' / '+s.label.toUpperCase(),{color:s.colors[2],letterSpacing:2}),
  text('footer',44,height-66,width-88,14,'GOOD COMPANY. UNEXPECTED IDEAS.',{color:'#d5dcea',letterSpacing:2})];
 cards.forEach((c,i)=>{
  children.push({id:'camera-'+i,type:'slot',slotId:i?'cohost':'host',framing:{mode:'fill',x:.5,y:.5},appearance:{shape:'rectangle',cornerRadius:24,outlineWidth:1,outlineColor:s.colors[2],opacity:1,grayscale:0},styles:{position:'absolute',left:c.x,top:c.y,width:c.w,height:c.h}});
  children.push(box('name-card-'+i,c.x,c.y+c.h+12,c.w,42,{background:'rgba(5,9,23,0.85)',borderRadius:12}));
  children.push(text('name-'+i,c.x+16,c.y+c.h+22,c.w-32,18,{get:i?'values.cohostName':'values.hostName'}));
 });
 const tracks=[track('title','opacity',0,1,650),track('title',s.i%2?'x':'y',s.i%2?tx+20:ty+18,s.i%2?tx:ty,800),track('edition','opacity',0,1,700,{delayMs:250}),track('field','shader.scale',.85,1.2,6000,{loop:'pingpong'}),track('sweep','opacity',.2,1,2400,{loop:'pingpong'})];
 cards.forEach((c,i)=>{
  // Each native camera and its halo share a small entry movement; final
  // framing is stable and no face bobs during the conversation.
  const horizontal=s.i%3===1,axis=horizontal?'x':'y',base=horizontal?c.x:c.y,offset=horizontal?(i?-16:16):14;
  tracks.push(track('camera-'+i,axis,base+offset,base,750,{delayMs:i*180}),track('halo-'+i,axis,base-10+offset,base-10,750,{delayMs:i*180}),track('camera-'+i,'opacity',0,1,650,{delayMs:i*180}),track('halo-'+i,'shader.intensity',.55,1.45,3000+i*600,{loop:'pingpong'}),track('name-'+i,'opacity',0,1,550,{delayMs:350+i*180}));
 });
 return {id:s.id+'-'+(vertical?'portrait':'landscape'),label:s.label+' · '+(vertical?'Portrait':'Landscape'),width,height,root:{id:s.id+'-'+(vertical?'p':'l'),type:'box',styles:{position:'relative',width,height,background:s.colors[0],overflow:'hidden'},children},animation:{transition:{type:'crossfade',durationMs:650},tracks}};
}
const doc={schema:'producer.presentation/1',id:'shader-combo',version:'1.0.0',name:'Combo Studio — Shader Duets',set:{initialLayout:'liquid-landscape',values:{hostName:{type:'text',default:'Kleveland Bishop',maxLength:48},cohostName:{type:'text',default:'Co-host',maxLength:48}},feeds:{},slots:[{id:'host',label:'Host 1'},{id:'cohost',label:'Host 2'}],components:{},assets:{mark:{name:'Boomin mark',mime:'image/png',data:'data:image/png;base64,'+fs.readFileSync('docs/shows/assets/boomin-mark.png').toString('base64')}},layouts:scenes.flatMap(s=>[layout(s,false),layout(s,true)]),controls:[]},show:{id:'shader-combo-show',version:'1.0.0',initialPhase:'liquid',choices:[{id:'a',label:'A'},{id:'b',label:'B'}],phases:scenes.map((s,i)=>({id:s.id,label:s.label,layoutId:s.id+'-landscape',...(scenes[i+1]?{next:scenes[i+1].id}:{})}))}};
let session;try{session=new RehearsalSession(doc);}catch(e){console.error(e.message);process.exit(1);}
const file='/Users/klevelandbishop/Documents/boomin/docs/shows/shader-combo.show.json';fs.writeFileSync(file,JSON.stringify(session.package,null,2));
const dir=fs.mkdtempSync('/private/tmp/producer-combo-');
fs.writeFileSync(dir+'/combo-check','');fs.writeFileSync(dir+'/projections.json',JSON.stringify(scenes.map((s,i)=>setOutputProjection(session,i+1,s.id+'-landscape'))));fs.writeFileSync(dir+'/portraits.json',JSON.stringify(scenes.map((s,i)=>setOutputProjection(session,i+1,s.id+'-portrait'))));
console.log(JSON.stringify({file,nativeProbeDirectory:dir,segments:scenes.length,twoHostSegments:scenes.filter(s=>s.hosts===2).length}));
