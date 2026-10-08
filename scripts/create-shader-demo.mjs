import fs from 'node:fs';
import {build} from 'esbuild';
const bundle=await build({stdin:{contents:"export {RehearsalSession} from './src/features/presentation/rehearsal';export {setOutputProjection} from './src/features/presentation/useSetOutput';",resolveDir:process.cwd()},bundle:true,platform:'browser',format:'esm',write:false});
const {RehearsalSession,setOutputProjection}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const box=(id,styles,children=[])=>({id,type:'box',styles,children});
const text=(id,x,y,w,size,value,color='#f0f5ff',extra={})=>({id,type:'text',text:value,styles:{position:'absolute',left:x,top:y,width:w,fontSize:size,fontWeight:700,lineHeight:1.04,color,...extra}});
const preset=(effect,colors,extra={})=>({effect,colors,speed:1,intensity:1,scale:1,opacity:1,radius:28,quality:'low',clock:'segment',...extra});
const layer=(id,x,y,w,h,shader)=>({id,type:'shader',styles:{position:'absolute',left:x,top:y,width:w,height:h},shader});
const scenes=[
 {id:'aurora',label:'The atmosphere',kicker:'01 / THE ATMOSPHERE',title:'Stay curious.\nBuild something.',subtitle:'Ideas worth putting into motion.',colors:['#071023','#236bad','#845ade']},
 {id:'glow',label:'The energy',kicker:'02 / THE ENERGY',title:'Bring the room\ninto the story.',subtitle:'One spark becomes a conversation.',colors:['#071c24','#128d8d','#5ee8c1']},
 {id:'sweep',label:'The reveal',title:'A new signal.\nA fresh perspective.',subtitle:'Make the next moment count.',colors:['#1a1024','#9a477d','#ffbb86']},
 {id:'after-hours',label:'After hours',title:'Midnight ideas.\nElectric company.',subtitle:'The best conversations ignore the clock.',colors:['#100725','#532aa8','#ff5cdb'],speed:.4,scale:2},
 {id:'solar-flare',label:'Solar flare',title:'Turn up\nthe possibility.',subtitle:'A little heat. A lot of momentum.',colors:['#280909','#c43c18','#ffd16b'],speed:1.4,scale:.7},
 {id:'deep-current',label:'Deep current',title:'Follow the\nundercurrent.',subtitle:'What is moving beneath the surface?',colors:['#021a28','#006b91','#62d8ff'],speed:.3,scale:2.8},
 {id:'velvet',label:'Velvet frequency',title:'Soft light.\nSharp thinking.',subtitle:'Give a bold idea room to breathe.',colors:['#1d0c24','#713d86','#ecc0ed'],speed:.25,scale:1.8},
 {id:'acid-lime',label:'Acid lime',title:'Break the\nexpected pattern.',subtitle:'Playful questions. Unexpected answers.',colors:['#101d06','#648c16','#dcff62'],speed:1.8,scale:.6},
 {id:'copper',label:'Copper signal',title:'Built by hand.\nSent with purpose.',subtitle:'The craft behind the next big thing.',colors:['#211109','#98582d','#efc28e'],speed:.55,scale:1.5},
 {id:'glacier',label:'Glacier transmission',title:'Clear the noise.\nFind the signal.',subtitle:'A quieter moment for a clearer view.',colors:['#071a25','#478ea4','#c4f3ff'],speed:.2,scale:3},
 {id:'redline',label:'Redline',title:'Meet the moment.\nMove it forward.',subtitle:'Where urgency becomes invention.',colors:['#230610','#a81b42','#ff697c'],speed:2,scale:.8},
 {id:'daybreak',label:'Daybreak',title:'Begin again.\nBegin brighter.',subtitle:'There is always another first light.',colors:['#1e172c','#ae6588','#ffe0ac'],speed:.45,scale:1.3},
 {id:'orbit',label:'Orbit',title:'Different worlds.\nShared curiosity.',subtitle:'Every perspective changes the view.',colors:['#070d2b','#324db6','#97a4ff'],speed:.85,scale:2.5},
 {id:'wild-garden',label:'Wild garden',title:'Let the\nideas grow wild.',subtitle:'Make space for a beautiful surprise.',colors:['#041d19','#2d8067','#bdeea2'],speed:.6,scale:.9},
 {id:'candy-static',label:'Candy static',title:'More color.\nMore character.',subtitle:'A bright little interruption.',colors:['#211034','#ab48aa','#ffb7de'],speed:1.6,scale:.55},
 {id:'last-light',label:'Last light',title:'Keep the spark.\nCarry it onward.',subtitle:'The conversation does not end here.',colors:['#131124','#744585','#fca978'],speed:.3,scale:1.6}
];
scenes.forEach((s,i)=>{s.kicker=String(i+1).padStart(2,'0')+' / '+s.label.toUpperCase();});
function layout(scene,portrait){
 const width=portrait?720:1280,height=portrait?1280:720;
 const reverse=!portrait && scenes.indexOf(scene)%2===1 && scenes.indexOf(scene)>2;
 const cam=portrait?{x:54,y:574,w:612,h:526}:{x:reverse?64:786,y:182,w:430,h:420};
 const tx=portrait?54:reverse?550:64,ty=portrait?188:236,tw=portrait?612:662;
 const children=[layer('atmosphere',0,0,width,height,preset('aurora',scene.colors,{speed:scene.speed??.65,intensity:1.4,scale:scene.scale??1.15})),
  layer('camera-glow',cam.x-14,cam.y-14,cam.w+28,cam.h+28,preset('edgeGlow',scene.colors,{speed:scene.speed??1.1,intensity:1.4,scale:scene.scale??1.4,radius:40,quality:'medium'})),
  layer('title-sweep',tx-8,ty-18,tw+16,portrait?220:196,preset('lightSweep',scene.colors,{speed:scene.speed??1.2,intensity:.85,scale:scene.scale??1.2,opacity:.65,radius:30})),
  {id:'mark',type:'media',assetId:'mark',fit:'contain',styles:{position:'absolute',left:tx,top:56,width:28,height:28}},
  text('brand',98,60,width-180,18,'LOCAL / SIGNAL','#d7e2f2',{letterSpacing:3}),
  box('header-rule',{position:'absolute',left:54,top:112,width:width-108,height:1,background:'#506283'}),
  text('kicker',tx,portrait?148:172,tw,16,scene.kicker,scene.colors[2],{letterSpacing:2}),
  text('title',tx,ty,tw,portrait?72:70,scene.title),
  text('subtitle',tx,portrait?430:416,tw,22,scene.subtitle,'#b9cde4',{fontWeight:400,lineHeight:1.3}),
  {id:'camera',type:'slot',slotId:'host',framing:{mode:'fill',x:.5,y:.5},appearance:{shape:'rectangle',cornerRadius:28,outlineWidth:1,outlineColor:'#91aabf',opacity:1,grayscale:0},styles:{position:'absolute',left:cam.x,top:cam.y,width:cam.w,height:cam.h}},
  text('host-name',cam.x,cam.y+cam.h+22,cam.w,20,{get:'values.hostName'},'#d7e2f2'),
  text('footer',54,height-64,width-108,14,'GOOD QUESTIONS. BOLD IDEAS. HUMAN CONNECTION.','#8eacca',{letterSpacing:1})];
 return {id:scene.id+'-'+(portrait?'portrait':'landscape'),label:scene.label+' · '+(portrait?'Portrait':'Landscape'),width,height,root:box(scene.id+'-'+(portrait?'p':'l')+'-root',{position:'relative',width,height,background:'#080d1a',overflow:'hidden'},children),animation:{transition:{type:'crossfade',durationMs:800},tracks:[
  {target:'camera-glow',property:'shader.intensity',clock:'segment',easing:'easeInOut',loop:'pingpong',keyframes:[{atMs:0,value:.65},{atMs:2400,value:1.7}]},
  {target:'title',property:'opacity',easing:'easeOut',keyframes:[{atMs:0,value:0},{atMs:900,value:1}]},
  {target:'title',property:'x',easing:'easeOut',keyframes:[{atMs:0,value:tx+32},{atMs:900,value:tx}]}
 ]}};
}
const doc={schema:'producer.presentation/1',id:'shader-lab',version:'1.0.0',name:'Shader Lab — Aurora, Glow & Sweep',set:{initialLayout:'aurora-landscape',values:{hostName:{type:'text',default:'Kleveland Bishop',maxLength:80}},feeds:{},slots:[{id:'host',label:'Host camera'}],components:{},assets:{mark:{name:'Boomin mark',mime:'image/png',data:'data:image/png;base64,'+fs.readFileSync('docs/shows/assets/boomin-mark.png').toString('base64')}},layouts:scenes.flatMap(s=>[layout(s,false),layout(s,true)]),controls:[]},show:{id:'shader-lab-show',version:'1.0.0',initialPhase:'aurora',choices:[{id:'a',label:'A'},{id:'b',label:'B'}],phases:scenes.map((s,i)=>({id:s.id,label:s.label,layoutId:s.id+'-landscape',...(scenes[i+1]?{next:scenes[i+1].id}:{})}))}};
let session;try{session=new RehearsalSession(doc);}catch(e){console.error(e.message);process.exit(1);}
const file='/Users/klevelandbishop/Documents/boomin/docs/shows/shader-lab.show.json';fs.writeFileSync(file,JSON.stringify(session.package,null,2));
const dir=fs.mkdtempSync('/private/tmp/producer-shaders-');fs.writeFileSync(dir+'/shader-check','');fs.writeFileSync(dir+'/projections.json',JSON.stringify(scenes.map((s,i)=>setOutputProjection(session,i+1,s.id+'-landscape'))));fs.writeFileSync(dir+'/portraits.json',JSON.stringify(scenes.map((s,i)=>setOutputProjection(session,i+1,s.id+'-portrait'))));console.log(JSON.stringify({file,nativeProbeDirectory:dir}));
