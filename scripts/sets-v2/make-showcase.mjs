import fs from 'node:fs';
import path from 'node:path';
import {build} from 'esbuild';
const bundled=await build({stdin:{contents:"export {parsePackage} from './src/features/presentation/schema';export {moduleTemplate,moduleInstance} from './shared/set-runtime/templates';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false});
const {parsePackage,moduleTemplate,moduleInstance}=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'));
const manifest=JSON.parse(fs.readFileSync('docs/set-runtime/generated-asset-manifest.json','utf8'));
const get=get=>({get}),eq=(a,b)=>({op:'eq',args:[a,b]}),iff=(a,b,c)=>({op:'if',args:[a,b,c]});
const ink='#f5f1e8',muted='#bdc7d0';
const box=(id,x,y,w,h,children=[],styles={})=>({id,type:'box',styles:{position:'absolute',left:x,top:y,width:w,height:h,...styles},children});
const text=(id,value,x,y,w,h,size=32,color=ink,weight=400)=>({id,type:'text',text:value,styles:{position:'absolute',left:x,top:y,width:w,height:h,fontFamily:'Arial, sans-serif',fontSize:size,fontWeight:weight,color,lineHeight:1.2,overflow:'hidden'}});
const art=(id,assetId,x,y,w,h,fit='contain')=>({id,type:'media',assetId,fit,styles:{position:'absolute',left:x,top:y,width:w,height:h}});
const value=(s,maxLength=100)=>({type:'text',default:s,maxLength});
function rig(set,id,x,y,w,name){
 const info=manifest.find(a=>a.file===`docs/shows/media/${set}/camera-bezel.png`),scale=w/info.width,h=info.height*scale,o=info.openingPixels;
 return box(id+'-rig',x,y,w,h+50,[
  box(id+'-well',o.left*scale,o.top*scale,o.width*scale,o.height*scale,[],{background:'#0c151e',borderRadius:16}),
  {id:id+'-camera',type:'slot',slotId:id,framing:{mode:'fill',x:.5,y:.5},appearance:{cornerRadius:16},styles:{position:'absolute',left:o.left*scale,top:o.top*scale,width:o.width*scale,height:o.height*scale}},
  art(id+'-bezel','bezel',0,0,w,h),text(id+'-name',get('values.'+name),o.left*scale,h+2,w-o.left*scale,44,28,ink,700),
 ]);
}
const specs=[
 {id:'decision-room',name:'Decision Room',label:'THE ROOM HAS A VOICE',title:'A question. A room. A decision.',kind:'vote',accent:'#e7b588',views:['Conversation','Results'],slots:['host'],module:'decision'},
 {id:'open-floor',name:'Open Floor',label:'GOOD QUESTIONS MOVE THE ROOM',title:'The floor is yours.',kind:'submissions',accent:'#e7b494',views:['Conversation','Featured question'],slots:['host','guest'],module:'questions'},
 {id:'atmosphere',name:'Atmosphere',label:'LIVE CONDITIONS / REAL CONSEQUENCES',title:'A window into the world.',kind:'weather',accent:'#b8d8df',views:['Conditions'],slots:['host'],module:'sky'},
 {id:'just-facts',name:'Just Facts',label:'ASK IT. CHECK IT. SHOW THE EVIDENCE.',title:'What does the evidence say?',kind:'agent',accent:'#c5d4ec',views:['The question','The evidence','The conversation'],slots:['host','guest1','guest2'],module:'research'},
];
for(const s of specs.filter(s=>s.id!=='just-facts')){
 const runtime={schema:'producer.modules/1',definitions:{[s.module]:moduleTemplate(s.kind)},instances:[moduleInstance(s.module,s.module)]};
 if(['vote','submissions'].includes(s.kind))runtime.instances[0].audiencePolicy='whileRunning';
 if(s.kind!=='weather'){runtime.definitions[s.module].views=s.views.map((_,i)=>'view'+i);runtime.definitions[s.module].initialView='view0';runtime.definitions[s.module].behavior.showView='view1';}
 if(s.kind==='submissions'){runtime.definitions[s.module].behavior.sources=['submissions','chat'];runtime.definitions[s.module].capabilities.push('room.chat@1');}
 if(s.kind==='vote'){runtime.definitions[s.module].behavior.question='Does AI create more opportunity than it replaces?';runtime.definitions[s.module].behavior.options=[{id:'opportunity',label:'More opportunity'},{id:'disruption',label:'More disruption'},{id:'depends',label:'It depends'}];}
 const f=key=>get(`modules.${s.module}.${key}`),layouts=[];
 for(const [viewIndex,view]of s.views.entries())for(const p of [false,true]){
  const w=p?1080:1920,h=p?1920:1080,pad=p?64:90;
  const nodes=[art('studio',p?'portrait':'landscape',0,0,w,h,'cover'),box('legibility',0,0,w,h,[],{background:'#07101a77'}),text('identity',s.name.toUpperCase(),pad,52,w-pad*2,56,p?38:32,ink,800),text('promise',s.label,pad,115,w-pad*2,40,p?20:18,s.accent,700)];
  if(s.kind==='agent'){
   const answer=viewIndex===1;
   nodes.push(text('headline',iff({op:'eq',args:[f('questionDisplay'),'']},get('values.title'),f('questionDisplay')),pad,185,w-pad*2,p?150:130,p?38:42,ink,700));
   if(p&&viewIndex===2){nodes.push(rig(s.id,'host',80,350,920,'hostName'),rig(s.id,'guest1',30,1000,510,'guest1Name'),rig(s.id,'guest2',540,1000,510,'guest2Name'));}else if(p){s.slots.forEach((id,i)=>nodes.push(rig(s.id,id,30+i*350,350,320,id+'Name')));}
   else if(viewIndex===2){nodes.push(rig(s.id,'host',45,330,1050,'hostName'),rig(s.id,'guest1',1280,330,520,'guest1Name'),rig(s.id,'guest2',1280,675,520,'guest2Name'));}else if(answer){s.slots.forEach((id,i)=>nodes.push(rig(s.id,id,1450,300+i*245,350,id+'Name')));}
   else{s.slots.forEach((id,i)=>nodes.push(rig(s.id,id,48+i*620,340,590,id+'Name')));}
   const x=pad,y=p?(viewIndex===2?1410:660):answer?340:795,bw=p?952:answer?1210:1740,bh=p?(viewIndex===2?350:1100):answer?625:205;
   const size=p?(viewIndex===2?30:34):answer?31:25;
   if(p||viewIndex!==2)nodes.push(box('answer-board',x,y,bw,bh,[text('answer-kicker',iff(f('hasAnswer'),'EVIDENCE / RESPONSE','RESEARCH DESK'),32,26,bw-64,40,21,s.accent,700),text('answer',iff(f('hasAnswer'),answer||p&&viewIndex!==2?f('answer'):f('answerBrief'),'Ask a question in the controls. Review the response, then choose Show response.'),32,86,bw-64,bh-115,size,ink,400)],{background:'#0b1424f0',borderRadius:18,border:'1px solid #6e8094'}));
   nodes.push(text('sources',f('sources'),pad,p?1785:1010,w-pad*2,50,p?20:17,muted,400));
  }else if(s.kind==='vote'){
   nodes.push(text('question',f('questionDisplay'),pad,205,w-pad*2,p?160:120,p?40:42,ink,700));
   nodes.push(rig(s.id,'host',viewIndex===1?(p?260:1410):(p?35:45),viewIndex===1?(p?1350:500):(p?405:400),viewIndex===1?(p?560:420):(p?1010:880),'hostName'));
   const x=p?pad:viewIndex===1?90:1020,y=viewIndex===1?(p?430:350):(p?1070:410),bw=p?952:viewIndex===1?1200:800;
   nodes.push(text('vote-status',iff(f('revealed'),'THE ROOM HAS DECIDED',iff(f('accepting'),'THE VOTE IS OPEN','LISTEN. CONSIDER. DECIDE.')),x,y,bw,50,23,s.accent,700));
   for(let i=1;i<=3;i++){const by=y+90+(i-1)*(p?175:150);nodes.push(box('option-'+i,x,by,bw,p?145:125,[text('choice-'+i,f('choice'+i+'Label'),24,18,bw-48,48,p?32:28,ink,700),box('track-'+i,24,p?96:87,bw-48,7,[{...box('progress-'+i,0,0,f('choice'+i+'Width'),7,[],{background:s.accent}),when:iff(eq(f('choice'+i+'Percent'),0),false,true)}],{background:'#62748555'}),{...text('percent-'+i,{op:'concat',args:[f('choice'+i+'Percent'),'%']},bw-140,20,105,42,28,s.accent,700),when:f('revealed')}],{background:'#101b25ed',borderRadius:16}));}
   nodes.push(text('vote-foot',iff(f('revealed'),{op:'concat',args:[f('total'),' audience responses']},'One person. One voice.'),x,y+(p?650:565),bw,50,24,muted));
  }else if(s.kind==='submissions'){
   nodes.push(text('headline',get('values.title'),pad,210,w-pad*2,130,p?52:60,ink,700));
   if(p){nodes.push(rig(s.id,'host',30,viewIndex===1?1450:390,510,'hostName'),rig(s.id,'guest',540,viewIndex===1?1450:390,510,'guestName'));}
   else if(viewIndex===1){nodes.push(rig(s.id,'host',1380,340,460,'hostName'),rig(s.id,'guest',1380,660,460,'guestName'));}else{nodes.push(rig(s.id,'host',45,365,860,'hostName'),rig(s.id,'guest',1015,365,860,'guestName'));}
   const y=viewIndex===1?(p?440:350):(p?860:830),bh=viewIndex===1?(p?900:610):(p?850:190),boardWidth=!p&&viewIndex===1?1160:w-2*pad;
   nodes.push(box('question-board',pad,y,boardWidth,bh,[text('question-kicker','FROM THE ROOM',32,26,boardWidth-64,35,22,s.accent,700),text('featured-question',iff(eq(f('featuredText'),''),f('prompt'),viewIndex===1?f('featuredText'):f('featuredExcerpt')),32,85,boardWidth-64,bh-105,p?44:viewIndex===1?36:31,ink,500)],{background:'#241c1aef',borderRadius:18}));
   nodes.push(text('question-author',f('featuredName'),pad,viewIndex===1?(p?1360:1000):(p?1750:1030),w-2*pad,40,25,s.accent,700));
  }else{
   nodes.push(text('location',iff(eq(f('location'),''),'CONNECT A WEATHER LOCATION',f('location')),pad,210,w-2*pad,65,p?34:30,s.accent,700));
   nodes.push(text('temperature',f('temperatureLabel'),pad,p?320:320,p?950:1030,p?240:210,p?200:170,ink,800));
   nodes.push(text('condition',iff(eq(f('dataStatus'),'empty'),'Awaiting live conditions',f('condition')),pad,p?585:570,p?950:1030,100,p?58:52,ink,500));
   nodes.push(rig(s.id,'host',p?80:1120,p?790:300,p?920:720,'hostName'));
   nodes.splice(2,0,box('night-shade',0,0,w,h,[],{background:iff(f('isDay'),'#06111d00','#02081488')}));
   const y=p?1500:850;nodes.push(box('conditions-strip',pad,y,w-2*pad,p?260:150,[text('wind',{op:'concat',args:['WIND  ',f('wind'),' km/h']},32,30,w-2*pad-64,50,p?34:28,ink,700),text('precipitation',{op:'concat',args:['PRECIPITATION  ',f('precipitation'),' mm']},32,p?115:88,w-2*pad-64,50,p?34:28,s.accent,500)],{background:'#0c1c29e8',borderRadius:18}));
   for(const condition of ['rain','snow','cloudy'])nodes.splice(2,0,{id:'weather-'+condition,type:'shader',when:condition==='rain'?iff(eq(f('condition'),'rain'),true,eq(f('condition'),'storm')):condition==='cloudy'?iff(eq(f('condition'),'cloudy'),true,eq(f('condition'),'fog')):eq(f('condition'),condition),styles:{position:'absolute',left:0,top:0,width:w,height:h},shader:{effect:condition==='storm'?'rain':condition==='cloudy'||condition==='fog'?'clouds':condition,colors:['#07121e','#afc6db','#ffffff'],speed:condition==='storm'?1.4:.75,intensity:condition==='fog'?.65:1,scale:1,opacity:.45,radius:0,quality:'medium',clock:'show'}});
   nodes.push(text('data-status',{op:'concat',args:['DATA / ',f('dataStatus')]},pad,p?1810:1030,w-2*pad,30,19,muted));
  }
  layouts.push({id:'view'+viewIndex+(p?'-portrait':'-landscape'),label:view+' · '+(p?'Portrait':'Landscape'),width:w,height:h,root:{id:'stage',type:'box',styles:{position:'relative',width:w,height:h,overflow:'hidden'},children:nodes}});
 }
 const set={...(s.kind!=='weather'?{viewController:s.module}:{}),initialLayout:layouts[0].id,values:{title:value(s.title,120),...Object.fromEntries(s.slots.map((id,i)=>[id+'Name',value(i===0?'Host / Moderator':i===1?'Guest one':'Guest two',60)]))},feeds:{},slots:s.slots.map((id,i)=>({id,label:i===0?'Host / Moderator camera':i===1?'Guest one camera':'Guest two camera'})),components:{},assets:Object.fromEntries([['landscape','studio-landscape.png'],['portrait','studio-portrait.png'],['bezel','camera-bezel.png']].map(([id,file])=>[id,{name:file,mime:'image/png',data:'data:image/png;base64,'+fs.readFileSync(path.join('docs/shows/media',s.id,file)).toString('base64')}])),layouts,views:Object.fromEntries(s.views.map((label,i)=>['view'+i,{landscape:'view'+i+'-landscape',portrait:'view'+i+'-portrait'}])),initialView:'view0',controls:[]};
 set.controls=Object.entries(set.values).map(([key,v])=>({id:'edit-'+key,type:v.type,label:key==='title'?'Opening title':key.replace('Name',' name'),key}));
 const show=s.kind==='agent'?{id:'just-facts-show',version:'1.0.0',initialPhase:'question',choices:[],phases:s.views.map((label,i)=>({id:['question','evidence','conversation'][i],label,layoutId:'view'+i+'-landscape',...(i<2?{next:['question','evidence','conversation'][i+1]}:{})}))}:undefined;
 let doc;try{doc=parsePackage({schema:'producer.presentation/2',id:s.id,version:s.kind==='agent'?'1.0.1':'1.0.0',name:s.name,runtime,set,...(show?{show}:{})});}catch(e){console.error(s.id,e.message);process.exit(1);}
 fs.writeFileSync(`docs/shows/${s.id}.json`,JSON.stringify(doc));console.log('Authored',s.name,layouts.length,'layouts,',s.slots.length,'cameras,',Math.round(JSON.stringify(doc).length/1024),'KiB');
}

await import('./make-just-facts.mjs');
