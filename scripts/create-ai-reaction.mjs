import fs from 'node:fs';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const bundled=await build({stdin:{contents:"export {RehearsalSession} from './src/features/presentation/rehearsal';export {outputProjection} from './src/features/presentation/projection';",resolveDir:process.cwd()},bundle:true,platform:'browser',format:'esm',write:false});
const {RehearsalSession,outputProjection}=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'));
// All coordinates are authored in the vertical master, never derived from a landscape layout.
const W=1080,H=1920;
const safe={left:Number(process.env.AI_SIGNAL_SAFE_LEFT??64),right:Number(process.env.AI_SIGNAL_SAFE_RIGHT??160),top:Number(process.env.AI_SIGNAL_SAFE_TOP??96),bottom:Number(process.env.AI_SIGNAL_SAFE_BOTTOM??240)};
assert(safe.left>=48&&safe.left<=96&&safe.right>=120&&safe.right<=200&&safe.top>=72&&safe.top<=120&&safe.bottom>=180&&safe.bottom<=300,'Safe areas exceed supported editorial bounds.');
const X=safe.left,CW=W-safe.left-safe.right,dy=safe.top-96,end=H-safe.bottom;
const t=k=>({get:`tokens.${k}`}),v=k=>({get:`values.${k}`});
const text=(id,x,y,w,size,copy,styleId='body',color='ink')=>({id,type:'text',styleId,text:copy,styles:{position:'absolute',left:x,top:y,width:w,fontSize:size,color:t(color)}});
const box=(id,x,y,w,h,background,r=0)=>({id,type:'box',styles:{position:'absolute',left:x,top:y,width:w,height:h,background,borderRadius:r},children:[]});
const shader=(id,x,y,w,h,effect,opacity,radius=0,scale=.25)=>({id,type:'shader',styles:{position:'absolute',left:x,top:y,width:w,height:h},shader:{effect,colors:(effect==='edgeGlow'||effect==='lightSweep'||effect==='borderFlare')?['#0b1dad','#3167ff','#e5f0ff']:['#030624','#101e80','#2947ff'],speed:.65,intensity:(effect==='edgeGlow'||effect==='lightSweep'||effect==='borderFlare')?1.1:.6,scale,opacity,radius,quality:'medium',clock:'show'}});
const slot=(id,x,y,w,h,slotId)=>({id,type:'slot',slotId,framing:{mode:slotId==='host'?'fill':'fit',x:.5,y:.5},appearance:{shape:'rectangle',cornerRadius:32,outlineWidth:.5,outlineColor:'#93b3ff',opacity:1,grayscale:0},styles:{position:'absolute',left:x,top:y,width:w,height:h}});
const modes={react:'REACT',take:'HOT TAKE',intro:'BREAKDOWN'};
function layout(mode){
 const c=[shader('atmosphere',0,0,W,H,'aurora',1)];const add=(...nodes)=>c.push(...nodes);
 // Camera and its GPU borders retain identical IDs and source bindings in every mode.
 const host=(x,y,w,h)=>add(box('host-id-bed',x+8,y+h-68,w-16,60,'linear-gradient(0deg, rgba(5,13,20,.85), rgba(5,13,20,0))',20),shader('camera-halo',x-16,y-16,w+32,h+32,'edgeGlow',.035,48,1),shader('camera-rim',x-3,y-3,w+6,h+6,'borderFlare',1,35,2),slot('host-camera',x,y,w,h,'host'));
 const content=(x,y,w,h)=>add(shader('media-rim',x-3,y-3,w+6,h+6,'borderFlare',1,35,2),{id:'reaction-content',type:'media',assetId:'reaction-media',fit:'contain',loop:false,autoplay:false,styles:{position:'absolute',left:x,top:y,width:w,height:h,background:'#071629',border:'0.5px solid #4369b4',borderRadius:32,overflow:'hidden'}});
 const label=(id,x,y,w,copy,color='muted',size=26)=>add(text(id,x,y,w,size,copy,'label',color));
 add(box('topic-chip',X,96+dy,222,54,'#55bdff',12));label('topic',X+18,108+dy,186,v('topic'),'night',26);
 add({id:'top-logo',type:'media',assetId:'brand-logo',fit:'contain',styles:{position:'absolute',left:X+254,top:90+dy,width:64,height:64}});
 label('brand',X+336,110+dy,CW-336,'ATLANTIUM / AI SIGNAL','ink',26);
 add(box('signal-dot',X+CW-14,100+dy,12,12,'#55bdff',6));
 if(mode==='react'){
  add(text('headline',X-3,180+dy,CW+3,80,v('headline'),'display'));
  content(X,392+dy,CW,650);label('source-name',X,1054+dy,CW,v('publisher'),'muted',24);
  const cameraY=1100+dy,cameraH=end-1180-dy;host(X,cameraY,CW,cameraH);
  label('host-name',X+24,cameraY+cameraH-56,CW-48,v('hostName'),'ink',30);
 }else if(mode==='take'){
  add(text('headline',X-3,180+dy,CW+3,80,v('takeaway'),'display'));
  content(X,500+dy,300,168);label('source-name',X+328,516+dy,CW-328,v('publisher'),'muted',28);
  label('mode-name',X+328,574+dy,CW-328,'THE HUMAN PERSPECTIVE','accent',24);
  const cameraY=712+dy,cameraH=end-792-dy;host(X,cameraY,CW,cameraH);
  label('host-name',X+24,cameraY+cameraH-56,CW-48,v('hostName'),'ink',32);
 }else{
  add(text('headline',X-3,180+dy,CW+3,70,v('headline'),'display'));
  content(X,370+dy,CW,end-850-dy);label('source-name',X,end-466,CW,v('publisher'),'muted',24);
  const cameraY=end-420;host(X,cameraY,480,340);
  label('mode-name',X+510,cameraY+36,CW-510,'BREAK\nIT DOWN.','accent',34);
  add(text('analysis-note',X+510,cameraY+140,CW-510,32,'Less hype.\nMore context.','body'));
  label('host-name',X+20,cameraY+284,440,v('hostName'),'ink',28);
 }
 // Reserved caption rail sits below both live sources, above the platform's bottom UI.
 add(box('caption-rail',X,end-64,CW,64,{op:'if',args:[{op:'eq',args:[v('caption'),'']},'transparent','rgba(5,13,20,.8)']},12));add(text('captions',X+16,end-54,CW-32,32,v('caption'),'caption'));
 return {id:`ai-${mode}-portrait`,label:modes[mode],width:W,height:H,root:{id:'reaction-root',type:'box',styles:{position:'relative',width:W,height:H,background:'#050d23',overflow:'hidden'},children:c},animation:{transition:{type:'morph',durationMs:1100},tracks:[
  {target:'media-rim',property:'shader.intensity',keyframes:[{atMs:0,value:1.25},{atMs:7400,value:1.65}],easing:'easeInOut',loop:'pingpong',clock:'show'},
  {target:'camera-rim',property:'shader.intensity',keyframes:[{atMs:0,value:1.25},{atMs:6000,value:1.65}],easing:'easeInOut',loop:'pingpong',clock:'show'},
  {target:'camera-halo',property:'shader.intensity',keyframes:[{atMs:0,value:.3},{atMs:8200,value:.35}],easing:'easeInOut',loop:'pingpong',clock:'show'},
  {target:'signal-dot',property:'opacity',keyframes:[{atMs:0,value:.35},{atMs:1500,value:1}],easing:'easeInOut',loop:'pingpong',clock:'show'},
  {target:'headline',property:'opacity',keyframes:[{atMs:0,value:0},{atMs:180,value:0},{atMs:680,value:1}],easing:'easeOut',clock:'segment'},
  {target:'topic',property:'opacity',keyframes:[{atMs:0,value:0},{atMs:360,value:1}],easing:'easeOut',clock:'segment'}
 ]}};
}
const doc={schema:'producer.presentation/1',id:'ai-signal',version:'2.5.0',name:'AI Signal — Vertical Reactions',set:{tokens:{ink:'#eef6ff',accent:'#709dff',muted:'#9bbbdc',night:'#050d23',safeLeft:safe.left,safeRight:safe.right,safeTop:safe.top,safeBottom:safe.bottom,displayFont:'Avenir Next, Avenir, Helvetica Neue, sans-serif',bodyFont:'Helvetica Neue, Arial, sans-serif'},styles:{display:{fontFamily:t('displayFont'),fontWeight:900,letterSpacing:-3,lineHeight:1.06,whiteSpace:'pre-line',textTransform:'uppercase'},body:{fontFamily:t('bodyFont'),fontWeight:500,lineHeight:1.3},label:{fontFamily:t('bodyFont'),fontWeight:700,letterSpacing:1,textShadow:'0 2px 4px rgba(0,0,0,.7)',lineHeight:1.2,whiteSpace:'pre-line'},caption:{fontFamily:t('bodyFont'),fontWeight:700,lineHeight:1.2,textAlign:'center',textShadow:'0 2px 5px #000'}},initialLayout:'ai-react-portrait',values:{hostName:{type:'text',default:'Kleveland Bishop',maxLength:30},topic:{type:'text',default:'AI / TECH',maxLength:12},headline:{type:'text',default:'THE NEXT AI SHIFT.\nWHO REALLY WINS?',maxLength:52},publisher:{type:'text',default:'SOURCE / ADD PUBLICATION',maxLength:32},takeaway:{type:'text',default:'SMARTER TOOLS.\nHUMAN JUDGMENT.',maxLength:44},caption:{type:'text',default:'',maxLength:44}},feeds:{},slots:[{id:'host',label:'Host camera'}],components:{},assets:{'brand-logo':{name:'Atlantium logo',mime:'image/png',data:'data:image/png;base64,'+fs.readFileSync('docs/shows/media/atlantium-logo.png').toString('base64')},'reaction-media':{name:'Reaction media — load a clip',mime:'image/png',data:'data:image/png;base64,'+fs.readFileSync('docs/shows/media/ai-reaction-placeholder.png').toString('base64'),playback:{start:'manual',loop:false,exit:'pause',return:'resume',hostControls:true}}},layouts:['react','take','intro'].map(layout),controls:[...['react','take','intro'].map(mode=>({id:`view-${mode}`,type:'button',label:modes[mode],action:{type:'layout.select',layoutId:`ai-${mode}-portrait`}})),...Object.entries({headline:'Headline (use deliberate line breaks)',takeaway:'Hot take statement',topic:'Topic identifier',publisher:'Source / publication',hostName:'Host name',caption:'Caption line (manual)'}).map(([key,label])=>({id:`edit-${key}`,type:'text',label,key}))]},show:{id:'ai-signal-show',version:'2.5.0',initialPhase:'reaction',phases:[{id:'reaction',label:'AI news reaction',layoutId:'ai-react-portrait'}],choices:[{id:'a',label:'A'},{id:'b',label:'B'}]}};
const session=new RehearsalSession(doc);assert.equal(session.package.set.slots.length,1);session.send({type:'control',action:{type:'show.start'}});
for(const l of doc.set.layouts){assert.equal(session.send({type:'control',action:{type:'layout.select',layoutId:l.id}}),true);const output=outputProjection(session.package,session.snapshot());assert.equal(output.width,W);assert.equal(output.height,H);assert(output.timeline.tracks.length<=32);for(const n of l.root.children){const s=n.styles;assert(s.left>=0&&s.top>=0&&s.left+s.width<=W&&(s.height===undefined||s.top+s.height<=H),`Out of canvas: ${l.id}/${n.id}`);}}
const encoded=JSON.stringify(session.package,null,2);for(const path of ['docs/shows/ai-signal.show.json','/Users/klevelandbishop/Documents/boomin/docs/shows/ai-signal.show.json'])fs.writeFileSync(path,encoded);console.log('Saved AI Signal 2.5: native 1080×1920, REACT / HOT TAKE / BREAKDOWN, one host, controllable reaction media, neon-blue GPU frames and embedded logo.');
