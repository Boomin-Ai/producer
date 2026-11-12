const rect=(left,top,width,height)=>({position:'absolute',left,top,width,height});
const text=(id,copy,left,top,width,height,fontSize,color='#eef0f1',extra={})=>({id,type:'text',text:copy,styles:{...rect(left,top,width,height),fontFamily:'Arial, Helvetica, sans-serif',fontSize,fontWeight:700,lineHeight:1.1,color,whiteSpace:'pre-wrap',...extra}});
const box=(id,bounds,children=[],extra={})=>({id,type:'box',styles:{...rect(...bounds),...extra},children});
const bind=key=>({get:'values.'+key});
const eq=(key,value)=>({op:'eq',args:[bind(key),value]});
const track=(target,property,a,b,ms=18000,clock='show',loop='pingpong')=>({target,property,keyframes:[{atMs:0,value:a},{atMs:ms,value:b}],clock,loop,easing:'easeInOut'});
// Every camera and screen pose is exactly 16:9. Media identities and ancestry stay
// stable so native layout morphs move one camera rather than reacquiring it.
const poses={
 portrait:{
  talk:{camera:[16,224,1048,589.5],screen:[16,829.5,1048,589.5],card:[24,270,1032,680]},
  code:{camera:[500,1070.5,556,312.75],screen:[24,470,1032,580.5],card:[24,270,1032,680]},
  teach:{camera:[24,994,1032,580.5],screen:[724,1594.5,332,186.75],card:[24,264,1032,710]},
  focus:{camera:[24,580,1032,580.5],screen:[632,1180.5,424,238.5],card:[24,270,1032,680]},
 },
 landscape:{
  talk:{camera:[24,210,928,522],screen:[968,210,928,522],card:[32,220,1148,784]},
  code:{camera:[1420,439.125,468,263.25],screen:[32,186,1368,769.5],card:[32,220,1148,784]},
  teach:{camera:[1200,210,688,387],screen:[1200,617,688,387],card:[32,210,1148,794]},
  focus:{camera:[32,186,1368,769.5],screen:[1420,439.125,468,263.25],card:[32,220,1148,784]},
 }
};
const names={talk:'Talk',code:'Show code',teach:'Teaching card',focus:'Emphasize'};
// CTA cards stay clear of the presenter in every pose. The dedicated teaching
// view uses the note area; the landscape Emphasize view uses the screen column.
const ctaBounds={portrait:{talk:[44,1434,992,350],code:[44,1434,992,350],teach:[44,590,992,350],focus:[44,1434,992,350]},landscape:{talk:[970,812,918,232],code:[400,770,1120,264],teach:[56,720,1100,300],focus:[1420,734,468,300]}};
function world(p){return {schema:'producer.scene3d/1',fps:30,clearColor:'#0b0d0f',fog:{color:'#0b0d0f',near:12,far:34},environment:'studio',exposure:.85,environmentIntensity:.55,camera:{position:[0,1,14],target:[0,0,0],fov:p?54:40},slots:[],lights:[{id:'key',position:[-5,6,8],color:'#e7f0ff',intensity:34},{id:'rim',position:[6,2,-2],color:'#a9b5bd',intensity:24}],objects:[
 {id:'arc',kind:'torus',args:[6.5,.07,8,64],position:[p?3:7,0,-5],rotation:[.3,.55,.4],color:'#a4adb4',metalness:1,roughness:.18,motion:{kind:'rotateY',speed:.035,amplitude:.14,phase:0}},
 {id:'echo',kind:'torus',args:[7.6,.035,8,64],position:[p?3:7,0,-6],rotation:[.3,.55,.4],color:'#59636b',metalness:.95,roughness:.23,motion:{kind:'swayZ',speed:.08,amplitude:.12,phase:1}},
 {id:'pillar-left',kind:'box',args:[.06,16,.18],position:[-7,0,-4],rotation:[0,.4,-.16],color:'#c3cbd1',metalness:.95,roughness:.2},
 {id:'pillar-right',kind:'box',args:[.04,16,.18],position:[7,0,-4],rotation:[0,.4,-.16],color:'#c3cbd1',metalness:.95,roughness:.2}
 ]};}
const doc={schema:'producer.presentation/2',id:'kleveland-flow-prototype',version:'0.2.1',name:'Kleveland Flow · Motion Prototype',set:{initialLayout:'talk-landscape',initialView:'talk',views:{},values:{
 hostName:{type:'text',default:'KLEVELAND',maxLength:26},series:{type:'text',default:'BUILD SOMETHING WORTH TEACHING',maxLength:50},
 cardTitle:{type:'text',default:'One idea.\nMake it click.',maxLength:70},cardBody:{type:'text',default:'Explain the idea. Show the code.\nMake the next step clear.',maxLength:180},showTeachingCard:{type:'boolean',default:true},
 cta:{type:'text',default:'none',maxLength:9},producerTitle:{type:'text',default:'producer.dev',maxLength:40},producerBody:{type:'text',default:'Stop posting.\nStart producing.',maxLength:100},atlantiumTitle:{type:'text',default:'ATLANTIUM',maxLength:40},atlantiumBody:{type:'text',default:'Your path to the frontier.',maxLength:100}
},feeds:{},slots:[{id:'host',label:'Presenter · Camera'},{id:'screen',label:'Live screen / code'}],components:{},layouts:[],controls:[],controlArrangement:{sections:[
 {id:'moves',label:'Live camera moves',controls:['builtin:layout']},
 {id:'cta',label:'CTA popups',controls:['set:showProducer','set:showAtlantium','set:hideCTA']},
 {id:'cards',label:'Teaching card',controls:['set:showCard','set:hideCard','set:cardTitle','set:cardBody'],collapsed:true},
 {id:'cta-copy',label:'Edit CTA copy',controls:['set:producerTitle','set:producerBody','set:atlantiumTitle','set:atlantiumBody'],collapsed:true},
 {id:'identity',label:'Your series',controls:['set:hostName','set:series'],collapsed:true}
],minimized:['builtin:layout','set:showProducer','set:showAtlantium','set:hideCTA']}}};
for(const orientation of ['landscape','portrait'])for(const view of ['talk','code','teach','focus']){
 const p=orientation==='portrait',w=p?1080:1920,h=p?1920:1080,g=poses[orientation][view];
 doc.set.views[view]??={};doc.set.views[view][orientation]=view+'-'+orientation;
 const c=g.card;
 const card=box('teaching-card',c,[
  text('card-kicker','TEACHING NOTE',28,26,c[2]-56,30,p?22:20,'#a4adb5',{letterSpacing:3}),
  text('card-title',bind('cardTitle'),28,80,c[2]-56,190,p?70:76),
  text('card-body',bind('cardBody'),28,300,c[2]-56,c[3]-340,p?36:38,'#b5bec5'),
 ],{background:'linear-gradient(135deg, #23292f 0%, #12161a 75%)',border:'1px solid #48535c',borderRadius:14,boxShadow:'0 18px 36px #00000055',overflow:'hidden'});
 card.when=view==='teach'?bind('showTeachingCard'):false;
 const children=[
  {id:'chrome-studio',type:'scene3d',styles:rect(0,0,w,h),scene3d:{id:p?'flow-chrome-portrait':'flow-chrome-landscape',pass:'background',world:world(p)}},
  text('series',bind('series'),p?24:32,p?42:28,w-(p?48:64),28,p?20:19,'#9aa5ad',{letterSpacing:2,fontWeight:500}),
  text('host-name',bind('hostName'),p?20:28,p?82:61,w-(p?40:56),p?98:92,p?76:72,'#f0f2f3',{fontFamily:'Arial Black, Arial, sans-serif',letterSpacing:-3,fontWeight:900}),
  box('header-rule',[p?24:32,p?184:157,w-(p?48:64),1],[],{background:'linear-gradient(90deg, #d9e0e5, #59646d 42%, #1a1e22)'}),
  {id:'live-code',type:'slot',slotId:'screen',framing:{mode:'fit',x:.5,y:.5},appearance:{shape:'rectangle',cornerRadius:10,outlineWidth:1,outlineColor:'#626f79',opacity:1},styles:rect(...g.screen)},
  card,
  {id:'presenter',type:'slot',slotId:'host',framing:{mode:'fill',x:.5,y:.5},appearance:{shape:'rectangle',cornerRadius:12,outlineWidth:2,outlineColor:'#c0cbd3',opacity:1},styles:rect(...g.camera)},
 ];
 const tracks=[];
 // Two mutually exclusive, native-rendered overlays; logos are supplied by
 // the normal authoring asset carrier under these portable asset IDs.
 for(const brand of ['producer','atlantium']){
  const bounds=ctaBounds[orientation][view],bw=bounds[2],bh=bounds[3],mint=brand==='producer',narrow=!p&&bw<600;
  const background={id:'cta-'+brand+'-background',type:'shader',when:eq('cta',brand),styles:rect(...bounds),shader:{effect:mint?'silk':'contours',colors:mint?['#102a28','#23766a','#8acfc0']:['#111b2e','#315a88','#92b6d8'],speed:mint?.16:.12,intensity:.36,scale:mint?1.3:1.8,opacity:.9,radius:16,glow:.08,quality:'low',clock:'show'}};
  const popup=box('cta-'+brand,bounds,[
   {id:'cta-'+brand+'-logo',type:'media',assetId:brand+'Logo',fit:'contain',styles:rect(26,narrow?20:p?32:28,narrow?84:p?104:108,narrow?84:p?104:108)},
   text('cta-'+brand+'-title',bind(brand+'Title'),narrow?26:p?154:158,narrow?112:28,narrow?bw-52:bw-(p?184:188),narrow?48:56,narrow?38:p?46:44,'#eff4f5',{letterSpacing:mint?-1:3}),
   text('cta-'+brand+'-body',bind(brand+'Body'),narrow?26:p?154:158,narrow?168:p?104:94,narrow?bw-52:bw-(p?184:188),narrow?112:bh-120,narrow?38:p?49:44,mint?'#cefff0':'#d3e8ff'),
  ],{background:'#10161b33',border:'1px solid '+(mint?'#6ba99b':'#718fab'),borderRadius:18,boxShadow:'0 18px 42px #00000088',overflow:'hidden'});
  popup.when=eq('cta',brand);children.push(background,popup);
  for(const layer of [popup,background]){
   tracks.push(track(layer.id,'opacity',0,1,360,'segment','none'),
    {...track(layer.id,'scale',.9,1,620,'segment','none'),keyframes:[{atMs:0,value:.9},{atMs:420,value:1.02},{atMs:620,value:1}]},
    {...track(layer.id,'y',bounds[1]+28,bounds[1],620,'segment','none'),keyframes:[{atMs:0,value:bounds[1]+28},{atMs:420,value:bounds[1]-5},{atMs:620,value:bounds[1]}]});
  }
  tracks.push(track(popup.id,'rotation',mint?-.22:.22,mint?.22:-.22,18000),track(background.id,'shader.intensity',.33,.38,18000));
 }
 doc.set.layouts.push({id:view+'-'+orientation,label:names[view]+' · '+(p?'Vertical':'Landscape'),width:w,height:h,root:{id:'root',type:'box',styles:{position:'relative',width:w,height:h,background:'#0b0d0f',overflow:'hidden'},children},animation:{cue:bind('cta'),transition:{type:'morph',durationMs:720},tracks}});
}
for(const key of ['hostName','series','cardTitle','cardBody','producerTitle','producerBody','atlantiumTitle','atlantiumBody'])doc.set.controls.push({id:key,type:'text',label:({hostName:'Host name',series:'Series title',cardTitle:'Card headline',cardBody:'Card explanation',producerTitle:'Producer CTA title',producerBody:'Producer CTA message',atlantiumTitle:'Atlantium CTA title',atlantiumBody:'Atlantium CTA message'})[key],key});
for(const [id,label,key,value]of [['showProducer','Show Producer','cta','producer'],['showAtlantium','Show Atlantium','cta','atlantium'],['hideCTA','Hide CTA','cta','none'],['showCard','Show card','showTeachingCard',true],['hideCard','Hide card','showTeachingCard',false]])doc.set.controls.push({id,type:'button',label,action:{type:'value.set',key,value}});
export default {schema:'producer.design-plan/2',package:doc,assetRefs:['producerLogo','atlantiumLogo']};
