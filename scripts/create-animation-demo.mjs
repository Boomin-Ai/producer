import fs from 'node:fs';
import {build} from 'esbuild';
const bundle=await build({stdin:{contents:"export {RehearsalSession} from './src/features/presentation/rehearsal';export {setOutputProjection} from './src/features/presentation/useSetOutput';",resolveDir:process.cwd()},bundle:true,platform:'browser',format:'esm',write:false});
const {RehearsalSession,setOutputProjection}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64')).catch(e=>{console.error(e.message);process.exit(1);});
const box=(id,styles,children=[])=>({id,type:'box',styles,children});
const text=(id,left,top,width,size,content,color='#f4f5fa')=>({id,type:'text',text:content,styles:{position:'absolute',left,top,width,fontSize:size,fontWeight:700,color,lineHeight:1.08}});
const track=(target,property,from,to,duration=1200,delayMs=0)=>({target,property,keyframes:[{atMs:0,value:from},{atMs:duration,value:to}],easing:'easeInOut',clock:'segment',delayMs,loop:'none'});
function layout(phase,portrait){
 const focus=phase==='focus',width=portrait?720:1280,height=portrait?1280:720;
 const camera=portrait?(focus?{x:42,y:300,w:636,h:848}:{x:42,y:360,w:636,h:357.75}):(focus?{x:72,y:200,w:720,h:405}:{x:760,y:240,w:420,h:236.25});
 const start=portrait?(focus?{x:150,y:400,w:420,h:560}:{x:84,y:360,w:552,h:310.5}):(focus?{x:760,y:240,w:420,h:236.25}:{x:900,y:240,w:340,h:191.25});
 const titleX=portrait?42:focus?840:64,titleY=portrait?150:focus?214:224,titleW=portrait?636:focus?360:620;
 const root=box(`${phase}-${portrait?'portrait':'landscape'}-root`,{position:'relative',width,height,background:focus?'#0a3a38':'#160f32',overflow:'hidden'},[
  {id:'mark',type:'media',assetId:'mark',fit:'contain',styles:{position:'absolute',left:portrait?42:64,top:40,width:36,height:36}},
  text('brand',portrait?94:116,44,width-180,22,'ANIMATION LAB','#c9c8f2'),
  text('title',titleX,titleY,titleW,portrait?58:focus?50:70,focus?'Move into focus.':'Make the room move.'),
  text('caption',titleX,titleY+(portrait?138:focus?150:180),titleW,22,focus?'One clock. Every canvas.':'Graphics, camera motion, and transitions — in JSON.','#b9c8da'),
  {id:'camera',type:'slot',slotId:'host',framing:{mode:'fill',x:.5,y:.5},appearance:{shape:'rectangle',cornerRadius:0,outlineWidth:3,outlineColor:'#b2a7fa',opacity:1,grayscale:0},styles:{position:'absolute',left:camera.x,top:camera.y,width:camera.w,height:camera.h}},
  text('host-name',camera.x,camera.y+camera.h+18,camera.w,20,{get:'values.hostName'},'#bcb7df'),
  text('footer',portrait?42:64,height-48,width-100,14,'PAUSE · SEEK · RESUME · RESET','#c7bfe4')
 ]);
 const delay=focus?350:0;
 return {id:`${phase}-${portrait?'portrait':'landscape'}`,label:`${focus?'02 Focus':'01 Opening'} · ${portrait?'Portrait':'Landscape'}`,width,height,root,
  animation:{transition:{type:'crossfade',durationMs:1000},tracks:[track('title','x',titleX+70,titleX,850,focus?250:0),track('title','opacity',0,1,850,focus?250:0),track('camera','x',start.x,camera.x,1200,delay),track('camera','y',start.y,camera.y,1200,delay),track('camera','width',start.w,camera.w,1200,delay),track('camera','height',start.h,camera.h,1200,delay)]}};
}
const doc={schema:'producer.presentation/1',id:'animation-foundation',version:'1.0.0',name:'Animation Lab — Native Motion',set:{initialLayout:'opening-landscape',values:{hostName:{type:'text',default:'Kleveland Bishop',maxLength:80}},feeds:{},slots:[{id:'host',label:'Host camera'}],components:{},assets:{mark:{name:'Boomin mark',mime:'image/png',data:'data:image/png;base64,'+fs.readFileSync('docs/shows/assets/boomin-mark.png').toString('base64')}},layouts:[layout('opening',false),layout('opening',true),layout('focus',false),layout('focus',true)],controls:[]},show:{id:'animation-foundation-show',version:'1.0.0',initialPhase:'opening',choices:[],phases:[{id:'opening',label:'Opening',layoutId:'opening-landscape',next:'focus'},{id:'focus',label:'Focus',layoutId:'focus-landscape'}]}};
doc.show.choices=[{id:'a',label:'A'},{id:'b',label:'B'}];
let session;try{session=new RehearsalSession(doc);}catch(e){console.error(e.message);process.exit(1);}
const file='/Users/klevelandbishop/Documents/boomin/docs/shows/animation-foundation.show.json';fs.writeFileSync(file,JSON.stringify(session.package,null,2));
const dir=fs.mkdtempSync('/private/tmp/producer-animation-');fs.writeFileSync(dir+'/animation-check','');
fs.writeFileSync(dir+'/projections.json',JSON.stringify([setOutputProjection(session,1,'opening-landscape'),setOutputProjection(session,2,'focus-landscape')]));
fs.writeFileSync(dir+'/portraits.json',JSON.stringify([setOutputProjection(session,1,'opening-portrait'),setOutputProjection(session,2,'focus-portrait')]));
console.log(JSON.stringify({file,nativeProbeDirectory:dir}));
