import fs from 'node:fs';
import {build} from 'esbuild';
const bundle=await build({stdin:{contents:"export {RehearsalSession} from './src/features/presentation/rehearsal';",resolveDir:process.cwd()},bundle:true,platform:'browser',format:'esm',write:false});
const {RehearsalSession}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const levels=[['APPLICATIONS','The experiences people use.','prism'],['AGENTS','Planning, tools, and purposeful action.','plasma'],['MODELS','Language, vision, and reasoning.','petals'],['DATA','Knowledge, context, and memory.','contours'],['COMPUTE','The engines behind intelligence.','grid']];
const colors=['#071526','#215e91','#8ee8dc'];
const text=(id,x,y,w,size,value,color='#f0f7ff')=>({id,type:'text',text:value,styles:{position:'absolute',left:x,top:y,width:w,fontSize:size,fontWeight:700,lineHeight:1.1,color}});
const box=(id,x,y,w,h,background,children=[])=>({id,type:'box',styles:{position:'absolute',left:x,top:y,width:w,height:h,background,borderRadius:16},children});
const shader=(id,x,y,w,h,effect,extra={})=>({id,type:'shader',styles:{position:'absolute',left:x,top:y,width:w,height:h},shader:{effect,colors,speed:.5,intensity:.8,scale:1,opacity:1,radius:22,quality:'low',clock:'show',...extra}});
const track=(target,property,a,b,ms=900,extra={})=>({target,property,keyframes:[{atMs:0,value:a},{atMs:ms,value:b}],easing:'easeInOut',...extra});
function layout(index,vertical){
 const width=vertical?720:1280,height=vertical?1280:720;
 const sx=vertical?44:72,sy=vertical?280:198,sw=vertical?632:664,row=vertical?110:82;
 const cy=vertical?872:170,cx=vertical?44:806,cw=vertical?632:410,ch=vertical?300:376;
 const children=[shader('field',0,0,width,height,levels[index][2]),shader('focus',sx-8,sy+index*row-8,sw+16,row-2,'edgeGlow',{quality:'medium',intensity:1.6}),shader('camera-glow',cx-8,cy-8,cw+16,ch+16,'edgeGlow',{quality:'medium'}),
  text('brand',44,40,width-88,16,'LOCAL / SIGNAL · THE AI STACK','#8ee8dc'),
  ...(vertical?[text('title',sx,98,sw,52,'FROM SILICON'),text('title-second',sx,154,sw,52,'TO IDEAS')]:[text('title',sx,94,width-sx*2,62,'FROM SILICON TO IDEAS')]),
  text('intro',sx,vertical?224:163,sw,18,'One stack. Five layers. Follow the connections.','#bdd4e6')];
 levels.forEach(([name,description],i)=>children.push(box('layer-'+i,sx,sy+i*row,sw,row-18,i===index?'rgba(7,23,39,0.88)':'rgba(7,23,39,0.67)',[text('number-'+i,16,14,40,18,String(5-i).padStart(2,'0'),i===index?'#8ee8dc':'#718ea9'),text('name-'+i,64,12,sw-88,vertical?23:21,name,i===index?'#ffffff':'#b6cadd'),text('description-'+i,64,vertical?50:40,sw-88,vertical?16:14,description,'#9bb7cc')])));
 children.push({id:'camera',type:'slot',slotId:'host',framing:{mode:'fill',x:.5,y:.5},appearance:{shape:'rectangle',cornerRadius:20,outlineWidth:1,outlineColor:'#8ee8dc',opacity:1,grayscale:0},styles:{position:'absolute',left:cx,top:cy,width:cw,height:ch}},text('host-name',cx,cy+ch+16,cw,18,{get:'values.hostName'}));
 if(!vertical){children.push(text('focus-label',cx,592,cw,14,'FOCUS / '+levels[index][0],'#8ee8dc'),text('focus-description',cx,623,cw,20,levels[index][1]));}
 const tracks=[track('focus','y',sy+(index?index-1:index)*row-8,sy+index*row-8),track('focus','shader.intensity',.7,1.8,2600,{loop:'pingpong'}),track('field','shader.scale',.8,1.2,6500,{loop:'pingpong'}),track('layer-'+index,'x',sx+12,sx,750),track('camera','opacity',.65,1,750)];
 return {id:'stack-'+index+(vertical?'-portrait':'-landscape'),label:levels[index][0]+' · '+(vertical?'Portrait':'Landscape'),width,height,root:{id:'root-'+index+(vertical?'p':'l'),type:'box',styles:{position:'relative',width,height,background:'#071526',overflow:'hidden'},children},animation:{transition:{type:'crossfade',durationMs:550},tracks}};
}
const controls=[];
for(let i=0;i<5;i++)for(const vertical of [false,true]){
 const when={op:'eq',args:[{get:'show.layoutId'},'stack-'+i+(vertical?'-portrait':'-landscape')]};
 for(const [label,next]of [['↑ Up the stack',Math.max(0,i-1)],['↓ Down the stack',Math.min(4,i+1)]])controls.push({id:'move-'+i+'-'+(vertical?'p':'l')+'-'+next,type:'button',label,when,enabled:next!==i,action:{type:'layout.select',layoutId:'stack-'+next+(vertical?'-portrait':'-landscape')}});
}
const doc={schema:'producer.presentation/1',id:'ai-stack',version:'1.0.0',name:'AI Stack — Connected Intelligence',set:{initialLayout:'stack-0-landscape',values:{hostName:{type:'text',default:'Kleveland Bishop',maxLength:48}},feeds:{},slots:[{id:'host',label:'Host camera'}],components:{},assets:{},layouts:levels.flatMap((_,i)=>[layout(i,false),layout(i,true)]),controls},show:{id:'ai-stack-show',version:'1.0.0',initialPhase:'stack',choices:[{id:'a',label:'A'},{id:'b',label:'B'}],phases:[{id:'stack',label:'Explore the AI stack',layoutId:'stack-0-landscape'}]}};
try{const session=new RehearsalSession(doc);fs.writeFileSync('/Users/klevelandbishop/Documents/boomin/docs/shows/ai-stack.show.json',JSON.stringify(session.package,null,2));console.log('Saved AI stack: one segment, five focus positions, both orientations');}catch(e){console.error(e.message);process.exit(1);}
