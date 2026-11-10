const rect=(left,top,width,height)=>({position:'absolute',left,top,width,height});
const text=(id,copy,left,top,width,height,fontSize,color='#eef0f1',extra={})=>({id,type:'text',text:copy,styles:{...rect(left,top,width,height),fontFamily:'Arial, Helvetica, sans-serif',fontSize,fontWeight:700,lineHeight:1.1,color,whiteSpace:'pre-wrap',...extra}});
const box=(id,bounds,children=[],extra={})=>({id,type:'box',styles:{...rect(...bounds),...extra},children});
const bind=key=>({get:'values.'+key});
const track=(target,property,a,b,ms=8000)=>({target,property,keyframes:[{atMs:0,value:a},{atMs:ms,value:b}],clock:'show',loop:'pingpong',easing:'easeInOut'});
const poses={
 portrait:{
  talk:{camera:[56,340,968,544.5],screen:[56,1010,700,393.75],card:[56,1480,968,270]},
  code:{camera:[596,1110,428,240.75],screen:[56,390,968,544.5],card:[56,1430,968,310]},
  teach:{camera:[56,1060,700,393.75],screen:[700,1500,324,182.25],card:[56,350,968,600]},
  focus:{camera:[56,420,968,544.5],screen:[56,1070,520,292.5],card:[56,1440,968,310]},
 },
 landscape:{
  talk:{camera:[72,260,1008,567],screen:[1136,260,712,400.5],card:[1136,710,712,290]},
  code:{camera:[1336,660,512,288],screen:[72,260,1200,675],card:[1336,260,512,340]},
  teach:{camera:[1136,260,712,400.5],screen:[1136,720,512,288],card:[72,260,1008,660]},
  focus:{camera:[72,260,1200,675],screen:[1336,730,512,288],card:[1336,260,512,410]},
 }
};
const names={talk:'Talk',code:'Show code',teach:'Teaching card',focus:'Emphasize'};
function world(p){return {schema:'producer.scene3d/1',fps:30,clearColor:'#0b0d0f',fog:{color:'#0b0d0f',near:12,far:34},environment:'studio',exposure:.85,environmentIntensity:.55,camera:{position:[0,1,14],target:[0,0,0],fov:p?54:40},slots:[],lights:[{id:'key',position:[-5,6,8],color:'#e7f0ff',intensity:34},{id:'rim',position:[6,2,-2],color:'#a9b5bd',intensity:24}],objects:[
 {id:'floor',kind:'box',args:[32,.16,20],position:[0,-5,-4],rotation:[0,0,0],color:'#15191d',metalness:.85,roughness:.28},
 {id:'arc',kind:'torus',args:[6.5,.07,8,64],position:[p?3:7,0,-5],rotation:[.3,.55,.4],color:'#a4adb4',metalness:1,roughness:.18,motion:{kind:'swayZ',speed:.12,amplitude:.14,phase:0}},
 {id:'echo',kind:'torus',args:[7.6,.035,8,64],position:[p?3:7,0,-6],rotation:[.3,.55,.4],color:'#59636b',metalness:.95,roughness:.23,motion:{kind:'swayZ',speed:.12,amplitude:.14,phase:1}},
 {id:'pillar-left',kind:'box',args:[.06,16,.18],position:[-7,0,-4],rotation:[0,.4,-.16],color:'#c3cbd1',metalness:.95,roughness:.2},
 {id:'pillar-right',kind:'box',args:[.04,16,.18],position:[7,0,-4],rotation:[0,.4,-.16],color:'#c3cbd1',metalness:.95,roughness:.2}
 ]};}
const doc={schema:'producer.presentation/2',id:'kleveland-flow-prototype',version:'0.1.0',name:'Kleveland Flow · Motion Prototype',set:{initialLayout:'talk-landscape',initialView:'talk',views:{},values:{hostName:{type:'text',default:'KLEVELAND',maxLength:26},series:{type:'text',default:'BUILD SOMETHING WORTH TEACHING',maxLength:50},cardTitle:{type:'text',default:'One idea.\nMake it click.',maxLength:70},cardBody:{type:'text',default:'Explain the idea. Show the code.\nBring it back to the takeaway.',maxLength:180},takeaway:{type:'text',default:'START WITH THE IDEA. THEN SHOW THE WORK.',maxLength:80}},feeds:{},slots:[{id:'host',label:'Presenter · Camera'},{id:'screen',label:'Live screen / code'}],components:{},layouts:[],controls:[],controlArrangement:{sections:[{id:'moves',label:'Live camera moves',controls:['builtin:layout']},{id:'cards',label:'Teaching card',controls:['set:cardTitle','set:cardBody','set:takeaway']},{id:'identity',label:'Your series',controls:['set:hostName','set:series'],collapsed:true}],minimized:['builtin:layout']}}};
for(const orientation of ['landscape','portrait'])for(const view of ['talk','code','teach','focus']){
 const p=orientation==='portrait',w=p?1080:1920,h=p?1920:1080,g=poses[orientation][view];
 doc.set.views[view]??={};doc.set.views[view][orientation]=view+'-'+orientation;
 const c=g.card;
 const small=!p&&c[2]<800;
 const card=box('teaching-card',c,[
  text('card-kicker','THE TAKEAWAY',32,26,c[2]-64,34,p?22:20,'#a4adb5',{letterSpacing:3}),
  text('card-title',bind('cardTitle'),32,p?76:70,c[2]-64,p?170:140,small?44:p?62:64),
  text('card-body',bind('cardBody'),32,p?260:238,c[2]-64,p?180:170,p?34:small?24:32,'#b5bec5',{}),
 ],{background:'linear-gradient(135deg, #23292f 0%, #12161a 75%)',border:'1px solid #48535c',borderRadius:18,boxShadow:'0 24px 48px #00000066',overflow:'hidden'});
 // Compact poses keep the editable title as a clean single text unit; full card
 // view reveals supporting copy. IDs remain stable for native morph matching.
 card.children[1].styles.height=c[3]>400?150:Math.min(150,c[3]-88);
 card.children[2].styles.top=c[3]>400?280:c[3]+30;
 card.children[2].styles.opacity=c[3]>400?1:0;
 const children=[
  {id:'chrome-studio',type:'scene3d',styles:rect(0,0,w,h),scene3d:{id:p?'flow-chrome-portrait':'flow-chrome-landscape',pass:'background',world:world(p)}},
  text('series',bind('series'),p?56:72,p?146:68,w-(p?112:144),34,p?23:22,'#9aa5ad',{letterSpacing:3,fontWeight:500}),
  text('host-name',bind('hostName'),p?50:66,p?190:100,w-(p?100:132),p?132:144,p?96:112,'#f0f2f3',{fontFamily:'Arial Black, Arial, sans-serif',letterSpacing:-5,fontWeight:900}),
  box('header-rule',[p?56:72,p?328:246,w-(p?112:144),2],[],{background:'linear-gradient(90deg, #d9e0e5, #59646d 42%, #1a1e22)'}),
  {id:'live-code',type:'slot',slotId:'screen',framing:{mode:'fit',x:.5,y:.5},appearance:{shape:'rectangle',cornerRadius:12,outlineWidth:1,outlineColor:'#626f79',opacity:1},styles:rect(...g.screen)},
  card,
  {id:'presenter',type:'slot',slotId:'host',framing:{mode:'fill',x:.5,y:.5},appearance:{shape:'rectangle',cornerRadius:16,outlineWidth:2,outlineColor:'#c0cbd3',opacity:1},styles:rect(...g.camera)},
  text('footer',bind('takeaway'),p?56:72,h-(p?100:45),w-(p?112:144),p?36:25,p?23:19,'#9da8b0',{fontWeight:500,letterSpacing:1}),
 ];
 doc.set.layouts.push({id:view+'-'+orientation,label:names[view]+' · '+(p?'Vertical':'Landscape'),width:w,height:h,root:box('root',[0,0,w,h],children,{position:'relative',background:'#0b0d0f',overflow:'hidden'}),animation:{transition:{type:'morph',durationMs:720},tracks:[track('presenter','scale',1,1.008,8500),track('live-code','rotation',-.16,.16,10000),track('teaching-card','rotation',.12,-.12,10000)]}});
}
for(const key of Object.keys(doc.set.values))doc.set.controls.push({id:key,type:'text',label:({hostName:'Host name',series:'Series title',cardTitle:'Card headline',cardBody:'Card explanation',takeaway:'Footer takeaway'})[key],key});
export default {schema:'producer.design-plan/2',package:doc};
