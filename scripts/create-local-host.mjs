import fs from 'node:fs';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const bundle=await build({stdin:{contents:"export {RehearsalSession} from './src/features/presentation/rehearsal';export {outputProjection} from './src/features/presentation/projection';",resolveDir:process.cwd()},bundle:true,platform:'browser',format:'esm',write:false});
const {RehearsalSession,outputProjection}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const names=['Opening','The project','The workflow','Open floor'];
const token=k=>({get:`tokens.${k}`}),value=k=>({get:`values.${k}`});
const box=(id,x,y,w,h,background,r=0)=>({id,type:'box',styles:{position:'absolute',left:x,top:y,width:w,height:h,background,borderRadius:r},children:[]});
const text=(id,x,y,w,size,copy,styleId='body',color='ink')=>({id,type:'text',styleId,text:copy,styles:{position:'absolute',left:x,top:y,width:w,fontSize:size,color:token(color)}});
const shader=(id,x,y,w,h,effect,colors,opacity,radius=0,scale=.25)=>({id,type:'shader',styles:{position:'absolute',left:x,top:y,width:w,height:h},shader:{effect,colors,opacity,radius,scale,speed:.18,intensity:.8,quality:'medium',clock:'show'}});
const slot=(id,x,y,w,h,slotId='host')=>({id,type:'slot',slotId,framing:{mode:slotId==='host'?'fill':'fit',x:.5,y:.5},appearance:{shape:'rectangle',cornerRadius:24,outlineWidth:1,outlineColor:'#dcc5a2',opacity:1,grayscale:0},styles:{position:'absolute',left:x,top:y,width:w,height:h}});
function layout(i,p){
 const w=p?720:1280,h=p?1280:720;
 const palettes=[['#111019','#302433','#735547'],['#10141b','#20363b','#66584b'],['#14121b','#383047','#60534b'],['#10191a','#263d3b','#71604d']];
 const c=[shader('atmosphere',0,0,w,h,'aurora',palettes[i],1),box('veil',0,0,w,h,'linear-gradient(180deg, rgba(14,14,21,0.25), rgba(14,14,21,0.8))')];
 const add=(...n)=>c.push(...n);
 const label=(id,x,y,ww,copy,color='muted')=>add(text(id,x,y,ww,13,copy,'label',color));
 const rule=(id,x,y,ww)=>add(box(id,x,y,ww,1,'rgba(244,222,187,0.22)'));
 const host=(x,y,ww,hh)=>{
  add(shader('host-halo',x-20,y-20,ww+40,hh+40,'edgeGlow',['#211825','#b97860','#eacba0'],.7,44,3),shader('host-rim',x-5,y-5,ww+10,hh+10,'edgeGlow',['#282337','#b7a4d9','#f1d5a6'],1,29,1.15),slot('host-camera',x,y,ww,hh));
 };
 const byline=(x,y,ww)=>{add(text('host-name',x,y,ww,23,value('hostName'),'name'));label('host-role',x,y+36,ww,'HOST / BUILDER / OPEN SOURCE');};
 const demo=(x,y,ww,hh)=>{add(box('screen-bed',x,y,ww,hh,'linear-gradient(145deg, #293138, #161922)',24),text('screen-placeholder',x+30,y+hh*.35,ww-60,p?44:58,value('projectName'),'display','accent'));label('screen-hint',x+30,y+hh*.65,ww-60,'PROJECT SCREEN / LIVE DEMO');add(slot('project-screen',x,y,ww,hh,'demo'));};
 label('network',40,30,p?400:640,'ATLANTIUM ORIGINAL / OPEN SOURCE');
 label('edition',p?520:1070,30,p?160:170,`${String(i+1).padStart(2,'0')} / LOCAL HOST`,'accent');
 rule('masthead-rule',40,66,w-80);
 rule('footer-rule',40,h-54,w-80);
 label('footer',40,h-33,p?400:750,'GOOD IDEAS DESERVE A CONVERSATION.');label('domain',p?520:1080,h-33,160,'ATLANTIUM.AI','accent');
 if(i===0){
  if(p){
   add(text('title',36,94,648,80,'LOCAL HOST','display'));label('opening-deck',40,198,640,'THE PEOPLE. THE PROJECTS. THE POSSIBILITY.','accent');
   host(40,262,640,692);byline(40,984,640);rule('intro-rule',40,1068,640);label('topic-label',40,1090,640,'IN THE ROOM TODAY');add(text('topic',40,1122,640,40,value('projectName'),'display','accent'));
  }else{
   host(40,112,738,472);byline(40,614,738);
   label('opening-kicker',832,124,404,'BUILT IN THE OPEN.','accent');add(text('title',826,176,414,96,'LOCAL','display'),text('title-accent',826,270,414,96,'HOST.','display','accent'),text('opening-deck',832,396,360,28,'Meet the people making what comes next.'));
   rule('topic-rule',832,524,408);label('topic-label',832,548,408,'IN THE ROOM TODAY');add(text('topic',832,580,408,38,value('projectName'),'display','accent'));
  }
 }else if(i===1){
  if(p){
   label('spotlight-kicker',40,96,640,'01 / PROJECT SPOTLIGHT','accent');add(text('title',36,132,648,76,value('projectName'),'display'),text('deck',40,232,640,27,'A studio for the way we create now.'));
   demo(40,314,640,360);label('demo-label',40,695,640,'THE PRODUCT / INSIDE THE ROOM');host(40,756,286,328);byline(40,1108,640);
   add(text('project-note',364,776,312,39,'ONE ROOM.\nEVERY PART OF THE SHOW.','display','accent'));label('project-detail',364,1020,312,'CREATE / CONNECT / BROADCAST');
  }else{
   label('spotlight-kicker',40,96,790,'01 / PROJECT SPOTLIGHT','accent');add(text('title',36,130,810,76,value('projectName'),'display'));label('project-deck',900,108,340,'THE PRODUCT / THE PEOPLE');
   demo(40,244,812,400);host(896,180,344,390);byline(896,602,344);
   add(text('deck',40,210,810,20,'A studio for the way we create now.','body','muted'));
  }
 }else if(i===2){
  if(p){
   label('workflow-kicker',40,96,640,'02 / FROM IDEA TO ON AIR','accent');add(text('title',36,130,648,62,'MAKE SOMETHING.','display'),text('title-accent',36,198,648,62,'SHOW EVERYONE.','display','accent'));
   demo(40,300,640,360);host(40,720,254,352);byline(40,1104,640);
   [['PREPARE','Give the idea a room.'],['CONNECT','Bring people into it.'],['GO LIVE','Share the work.']].forEach(([title,copy],j)=>{const y=730+j*135;label(`step-number-${j}`,334,y,60,`0${j+1}`,'accent');add(text(`step-title-${j}`,396,y-4,284,23,title,'name'),text(`step-copy-${j}`,334,y+38,346,24,copy));rule(`step-rule-${j}`,334,y+100,346);});
  }else{
   host(40,112,518,480);byline(40,614,518);label('workflow-kicker',620,112,620,'02 / FROM IDEA TO ON AIR','accent');add(text('title',614,148,626,55,'MAKE IT. SHOW IT.','display'));
   demo(620,240,620,260);
   [['PREPARE','A room for the idea.'],['CONNECT','People make it real.'],['GO LIVE','Let the world in.']].forEach(([title,copy],j)=>{const x=620+j*210;label(`step-number-${j}`,x,528,190,`0${j+1}`,'accent');add(text(`step-title-${j}`,x,562,190,22,title,'name'),text(`step-copy-${j}`,x,601,188,20,copy));});
  }
 }else{
  if(p){
   label('floor-kicker',40,98,640,'03 / OPEN FLOOR','accent');host(40,168,640,688);byline(40,888,640);rule('question-rule',40,970,640);label('question-kicker',40,994,640,'YOUR IDEAS BELONG HERE.','accent');add(text('question',36,1040,648,44,value('question'),'display'));
  }else{
   host(40,112,648,480);byline(40,614,648);label('floor-kicker',746,124,494,'03 / OPEN FLOOR','accent');add(text('quote',734,166,170,120,'“','display','accent'),text('question',740,282,494,58,value('question'),'display'));rule('question-rule',746,546,494);add(text('floor-deck',746,576,470,25,'Ideas. Contributions. The next release.','body','accent'));
  }
 }
 const tracks=[{target:'host-rim',property:'shader.intensity',keyframes:[{atMs:0,value:.85},{atMs:5200,value:1.35}],easing:'easeInOut',loop:'pingpong'},{target:'host-halo',property:'shader.intensity',keyframes:[{atMs:0,value:.65},{atMs:7400,value:1.1}],easing:'easeInOut',loop:'pingpong'},{target:i===3?'question':'title',property:'x',keyframes:[{atMs:0,value:c.find(n=>n.id===(i===3?'question':'title')).styles.left-12},{atMs:750,value:c.find(n=>n.id===(i===3?'question':'title')).styles.left}],easing:'easeOut'}];

 return {id:`local-${i}-${p?'portrait':'landscape'}`,label:`${names[i]} · ${p?'Portrait':'Landscape'}`,width:w,height:h,root:{id:`root-${i}-${p?'p':'l'}`,type:'box',styles:{position:'relative',width:w,height:h,background:'#111019',overflow:'hidden'},children:c},animation:{transition:{type:'crossfade',durationMs:700},tracks}};
}
const doc={schema:'producer.presentation/1',id:'local-host',version:'3.0.0',name:'Local Host — Atlantium',set:{tokens:{ink:'#f6f0e8',accent:'#edd0a6',muted:'#b4aab6',displayFont:'Avenir Next, Avenir, Helvetica Neue, sans-serif',bodyFont:'Helvetica Neue, Arial, sans-serif'},styles:{display:{fontFamily:token('displayFont'),fontWeight:800,letterSpacing:-2,lineHeight:1.03,textShadow:'0px 2px 24px rgba(0,0,0,0.2)'},body:{fontFamily:token('bodyFont'),fontWeight:400,lineHeight:1.4},name:{fontFamily:token('displayFont'),fontWeight:600,lineHeight:1.2},label:{fontFamily:token('bodyFont'),fontWeight:600,letterSpacing:1.2,lineHeight:1.2,textTransform:'uppercase'}},initialLayout:'local-0-landscape',values:{hostName:{type:'text',default:'Kleveland Bishop',maxLength:48},projectName:{type:'text',default:'Producer',maxLength:24},question:{type:'text',default:'What should we build next?',maxLength:60}},feeds:{},slots:[{id:'host',label:'Host camera'},{id:'demo',label:'Project screen / demo'}],components:{},assets:{},layouts:names.flatMap((_,i)=>[layout(i,false),layout(i,true)]),controls:[{id:'edit-project',type:'text',label:'Project name',key:'projectName'},{id:'edit-question',type:'text',label:'Discussion question',key:'question'}]},show:{id:'local-host-show',version:'3.0.0',initialPhase:'segment-0',choices:[{id:'a',label:'A'},{id:'b',label:'B'}],phases:names.map((label,i)=>({id:`segment-${i}`,label,layoutId:`local-${i}-landscape`,...(i<3?{next:`segment-${i+1}`}:{})}))}};
let session;try{session=new RehearsalSession(doc);}catch(e){console.error(e.message);process.exit(1);}
session.send({type:'control',action:{type:'show.start'}});
for(let i=0;i<4;i++){assert.equal(session.snapshot().show.phase,`segment-${i}`);if(i<3)session.send({type:'control',action:{type:'show.next'}});}
for(let i=2;i>=0;i--){session.send({type:'control',action:{type:'show.previous'}});assert.equal(session.snapshot().show.phase,`segment-${i}`);}
for(const l of doc.set.layouts){session.send({type:'control',action:{type:'layout.select',layoutId:l.id}});assert.equal(outputProjection(session.package,session.snapshot()).width,l.width);for(const n of l.root.children){const s=n.styles;assert(s.left>=0&&s.top>=0&&s.left+s.width<=l.width&&(s.height===undefined||s.top+s.height<=l.height),`Out of canvas: ${l.id}/${n.id}`);}}
const encoded=JSON.stringify(session.package,null,2);fs.writeFileSync('/Users/klevelandbishop/Documents/boomin/docs/shows/local-host.show.json',encoded);fs.writeFileSync('docs/shows/local-host.show.json',encoded);
console.log('Saved Local Host 3.0: eight art-directed layouts, amber/lilac camera shaders, shared typography. PASS navigation, projections and canvas bounds.');
