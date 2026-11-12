// Classic is authored through the canonical MCP compiler. Keep this source
// readable: it is also the reference for paired canvases and contextual controls.
const V=key=>({get:'values.'+key});
const eq=(a,b)=>({op:'eq',args:[a,b]});
const If=(a,b,c)=>({op:'if',args:[a,b,c]});
const cat=(...args)=>({op:'concat',args});
const light=eq(V('theme'),'light');
const color=(dark,day)=>If(light,day,dark);
const ink=color('#f2f4f5','#16232c'),muted=color('#9baebc','#536775');
const line=color('#36434e','#bcc9ca'),surface=color('#17222c','#ffffff');
const accent=If(eq(V('accent'),'silver'),color('#d8e4ed','#435a6b'),color('#9cdbc7','#1e6a58'));
const any=items=>items.length===1?items[0]:If(any(items.slice(0,Math.ceil(items.length/2))),true,any(items.slice(Math.ceil(items.length/2))));
const viewWhen=(...names)=>any(names.flatMap(name=>['landscape','portrait'].map(format=>eq({get:'show.layoutId'},name+'-'+format))));
const rect=(x,y,w,h)=>({position:'absolute',left:x,top:y,width:w,height:h});
const box=(id,bounds,children=[],styles={},when)=>({id,type:'box',styles:{...rect(...bounds),...styles},children,...(when===undefined?{}:{when})});
const text=(id,copy,bounds,size=24,styles={},when)=>({id,type:'text',text:copy,styles:{...rect(...bounds),fontFamily:'Arial, Helvetica, sans-serif',fontSize:size,fontWeight:400,lineHeight:1.18,color:ink,whiteSpace:'pre-wrap',...styles},...(when===undefined?{}:{when})});
const caps=(id,copy,bounds,size=17,styles={},when)=>text(id,copy,bounds,size,{fontWeight:700,letterSpacing:3.2,color:muted,...styles},when);
const names={opening:'Opening',solo:'Solo',demo:'Demo',conversation:'Conversation',roundtable:'Roundtable',spotlight:'Spotlight',break:'Break',closing:'Closing'};
const values={
 theme:{type:'text',default:'dark',maxLength:5},accent:{type:'text',default:'mint',maxLength:6},motion:{type:'boolean',default:true},
 showTitle:{type:'text',default:'THE CLASSIC STUDIO',maxLength:36},hostName:{type:'text',default:'Your name',maxLength:28},hostRole:{type:'text',default:'Host / Creator',maxLength:36},
 headline:{type:'text',default:'A good conversation\nstarts here.',maxLength:52},tagline:{type:'text',default:'One idea. A fresh perspective. A show that feels like you.',maxLength:112},
 topic:{type:'text',default:'MAKE SOMETHING WORTH SHARING',maxLength:48},noteTitle:{type:'text',default:'Make one thing\nworth sharing.',maxLength:58},noteBody:{type:'text',default:'Start with one clear idea.\nShow how it works.\nGive people a reason to come back.',maxLength:160},
 ctaTitle:{type:'text',default:'Keep the conversation going.',maxLength:56},ctaAddress:{type:'text',default:'your-site.com',maxLength:44},
 breakTitle:{type:'text',default:'Back in\na moment.',maxLength:42},breakBody:{type:'text',default:'A short pause. Stay curious.',maxLength:90},
 guest1Name:{type:'text',default:'Guest one',maxLength:28},guest2Name:{type:'text',default:'Guest two',maxLength:28},guest3Name:{type:'text',default:'Guest three',maxLength:28},
 guestCount:{type:'number',default:3,min:1,max:3},screenZoom:{type:'number',default:1,min:1,max:2},corners:{type:'number',default:12,min:0,max:24},
 hostVisible:{type:'boolean',default:true},chatVisible:{type:'boolean',default:false},demoLive:{type:'boolean',default:false},mediaLive:{type:'boolean',default:false},cue:{type:'text',default:'none',maxLength:5},
};
const doc={schema:'producer.presentation/2',id:'classic',version:'1.0.0',name:'Classic',set:{
 initialView:'solo',initialLayout:'solo-landscape',views:{},
 tokens:{design:'Classic / editorial studio',spacing:24,landscapeSafe:64,portraitSafe:64},values,feeds:{},
 slots:[['host','Host camera'],['screen','Screen share'],['guest1','Guest one'],['guest2','Guest two'],['guest3','Guest three'],['media','Featured image or clip'],['chat','Room chat']].map(([id,label])=>({id,label})),
 components:{},layouts:[],controls:[],controlArrangement:{sections:[],minimized:['set:cta','set:clear-cue','set:light','set:dark']},
}};

function frame(id,slot,bounds,label,{when=true,fit='fill',sample='CAMERA',name=true}={}){
 const [x,y,w,h]=bounds;
 return [
  box(id+'-well',bounds,[],{background:surface,border:cat('1px solid ',line),borderRadius:V('corners')},when),
  caps(id+'-empty',sample,[x,y+h/2-22,w,44],17,{display:'flex',alignItems:'center',justifyContent:'center',letterSpacing:3,color:muted},when),
  {id,type:'slot',slotId:slot,when,framing:{mode:fit,x:.5,y:.5},appearance:{cornerRadius:V('corners')},styles:rect(x,y,w,h)},
  ...(name?[box(id+'-name-plate',[x+18,y+h-66,Math.min(w-36,460),46],[],{background:color('#101922','#f2f5f3'),borderRadius:6,opacity:.96},when),
   text(id+'-name',label,[x+34,y+h-55,Math.min(w-68,428),30],22,{fontWeight:700},when)]:[]),
 ];
}
// For reflowing source geometry use the same literal bounds in every sibling.
// Binding-valued geometry is used only in the explicit adaptive helpers below.
function adaptiveFrame(id,slot,bounds,label,when=true,fit='fill'){
 const [x,y,w,h]=bounds;
 return [box(id+'-well',bounds,[],{background:surface,border:cat('1px solid ',line),borderRadius:V('corners')},when),
  {id,type:'slot',slotId:slot,when,framing:{mode:fit,x:.5,y:.5},appearance:{cornerRadius:V('corners')},styles:rect(x,y,w,h)},
  ];
}
function chat(bounds,when=V('chatVisible')){
 const [x,y,w,h]=bounds;
 const inset=h>=200?62:10;
 return [box('chat-well',bounds,[],{background:surface,border:cat('1px solid ',line),borderRadius:12},when),
  ...(h>=200?[caps('chat-label','THE CONVERSATION',[x+22,y+22,w-44,25],15,{},when)]:[]),
  {id:'chat',type:'slot',slotId:'chat',when,framing:{mode:'fit',x:.5,y:.5},styles:rect(x+16,y+inset,w-32,h-inset-16)}];
}
function sampleCard(id,bounds,kind,when){
 const [x,y,w,h]=bounds,p=w<1100;
 return box(id,bounds,[
  caps(id+'-label',kind==='demo'?'THE WALKTHROUGH':'ONE IDEA',[32,32,w-64,28],p?17:19,{color:accent}),
  text(id+'-title',V('noteTitle'),[32,p?110:135,w-64,p?210:250],p?62:82,{fontWeight:700,letterSpacing:-2}),
  box(id+'-rule',[32,p?350:420,w-64,2],[],{background:line}),
  text(id+'-body',V('noteBody'),[32,p?395:464,w-64,Math.max(160,h-(p?435:504))],p?27:32,{color:muted,lineHeight:1.5}),
 ],{background:surface,border:cat('1px solid ',line),borderRadius:12},when);
}
function cues(p){
 const bounds=p?[64,1300,952,420]:[72,584,1200,380];
 const [x,y,w,h]=bounds;
 return [box('cue-panel',bounds,[
  caps('cue-label',If(eq(V('cue'),'name'),'INTRODUCING',If(eq(V('cue'),'cta'),'NEXT / TAKE ACTION','TAKEAWAY')),[32,25,w-64,28],16,{color:accent}),
  text('cue-headline',If(eq(V('cue'),'name'),V('hostName'),If(eq(V('cue'),'cta'),V('ctaTitle'),V('noteTitle'))),[32,78,w-64,p?150:95],p?52:50,{fontWeight:700,letterSpacing:-1}),
  text('cue-detail',If(eq(V('cue'),'name'),V('hostRole'),If(eq(V('cue'),'cta'),V('ctaAddress'),V('noteBody'))),[32,p?242:192,w-64,p?150:150],p?23:25,{color:muted,lineHeight:1.35}),
 ],{background:color('#14212b','#ffffff'),border:cat('1px solid ',accent),borderRadius:14,boxShadow:color('0 16px 64px #0008','0 12px 45px #112a3524')},If(eq(V('cue'),'none'),false,true))];
}

for(const orientation of ['landscape','portrait'])for(const [index,[view,label]]of Object.entries(names).entries()){
 const p=orientation==='portrait',w=p?1080:1920,h=p?1920:1080;
 const children=[
  box('stage-light',[0,0,w,h],[],{background:color('radial-gradient(ellipse at 80% 0%,#26323c 0%,#10171e 48%,#0b1117 100%)','radial-gradient(ellipse at 80% 0%,#ffffff 0%,#f1f3ef 52%,#e5ebe8 100%)')}),
  box('brand-line',[64,50,5,26],[],{background:accent}),
  caps('series',V('showTitle'),[84,50,p?690:1300,30],19,{color:ink}),
  caps('edition',String(index+1).padStart(2,'0')+' / '+label.toUpperCase(),[64,p?110:103,p?952:1792,28],16),
  box('footer-rule',[64,h-(p?116:71),w-128,1],[],{background:line}),
  caps('footer','CLASSIC / PRODUCER',[64,h-(p?82:46),w-128,23],p?14:13,{letterSpacing:2.5}),
 ];
 if(view==='opening'){
  children.push(caps('intro','WELCOME TO YOUR NEXT CHAPTER',[72,p?216:211,p?936:1036,40],20,{color:accent}),
   text('headline',V('headline'),[72,p?294:293,p?936:1068,p?360:340],p?100:112,{fontWeight:700,letterSpacing:-4,lineHeight:1.02}),
   text('tagline',V('tagline'),[76,p?691:691,p?920:910,p?130:115],p?31:30,{color:muted,lineHeight:1.45}),
   ...frame('host','host',p?[64,904,952,650]:[1224,195,632,720],V('hostName'),{when:V('hostVisible')}),
   box('opening-accent',p?[64,1640,952,4]:[76,879,910,4],[],{background:accent}),
   caps('opening-signoff','YOUR VOICE. YOUR SPACE.',p?[64,1690,952,32]:[76,920,910,32],18));
 }else if(view==='solo'){
  const b=p?[64,190,952,If(V('chatVisible'),1000,1470)]:[64,154,If(V('chatVisible'),1240,1792),800];
  children.push(...adaptiveFrame('host','host',b),
   ...chat(p?[64,1220,952,440]:[1328,154,528,800]),
   box('solo-name',p?[88,If(V('chatVisible'),1100,1570),720,68]:[88,858,720,68],[],{background:color('#111d27','#edf2f0'),borderRadius:8}),
   text('host-name',V('hostName'),p?[110,If(V('chatVisible'),1116,1586),670,38]:[110,874,670,38],31,{fontWeight:700}));
 }else if(view==='demo'||view==='spotlight'){
  const live=V(view==='demo'?'demoLive':'mediaLive'),slot=view==='demo'?'screen':'media';
  const content=p?[64,200,952,If(V('hostVisible'),900,1430)]:[64,164,If(V('hostVisible'),1280,1792),790];
  // Fixed sample composition; source geometry independently expands when host is hidden.
  const sampleBounds=p?[64,200,952,900]:[64,164,1280,790];
  children.push(sampleCard('example',sampleBounds,view,If(live,false,V('hostVisible'))),
   sampleCard('example-full',p?[64,200,952,1430]:[64,164,1792,790],view,If(live,false,If(V('hostVisible'),false,true))),
   box('content-well',content,[],{background:surface,border:cat('1px solid ',line),borderRadius:12},live),
   box('content-clip',content,[box('content-framing',[0,0,'100%','100%'],[{id:'content',type:'slot',slotId:slot,when:live,framing:{mode:'fit',x:.5,y:.5},styles:{position:'absolute',left:0,top:0,width:'100%',height:'100%'}}],view==='demo'?{transform:cat('scale(',V('screenZoom'),')')}:{})],{overflow:'hidden',borderRadius:12},live),
   ...adaptiveFrame('host','host',p?[64,1130,view==='demo'?If(V('chatVisible'),464,952):952,530]:[1368,164,488,view==='demo'?If(V('chatVisible'),488,790):790],undefined,V('hostVisible')),
   text('host-name',V('hostName'),p?[88,1152,view==='demo'?If(V('chatVisible'),420,900):900,34]:[1392,186,440,34],24,{fontWeight:700,background:surface,padding:5},V('hostVisible')));
  if(view==='demo')children.push(...chat(p?[552,1130,464,530]:[1368,676,488,278],If(V('hostVisible'),V('chatVisible'),false)),caps('topic',V('topic'),p?[64,1720,952,30]:[64,975,1792,24],p?17:14,{color:accent}));
 }else if(view==='conversation'){
  const ch=V('chatVisible');
  const bh=p?If(ch,565,700):If(ch,610,800);
  children.push(...adaptiveFrame('host','host',[64,p?196:154,p?952:884,bh]),
   ...adaptiveFrame('guest1','guest1',[p?64:972,p?If(ch,785,920):154,p?952:884,bh]),
   ...chat(p?[64,1380,952,280]:[64,790,1792,164]),
   text('host-name',V('hostName'),[88,p?217:176,p?760:760,38],27,{fontWeight:700,background:surface,padding:7,borderRadius:6}),
   text('guest-name',V('guest1Name'),[p?88:996,p?If(ch,806,941):176,p?760:760,38],27,{fontWeight:700,background:surface,padding:7,borderRadius:6}));
 }else if(view==='roundtable'){
  const one=eq(V('guestCount'),1),two=eq(V('guestCount'),2),ch=V('chatVisible');
  const top=p?196:154,smallH=p?If(ch,620,700):If(ch,346,388),largeH=p?If(ch,620,700):If(ch,716,800);
  const first=p?[64,top,If(one,952,If(two,952,464)),smallH]:[64,top,If(two,984,884),If(one,largeH,If(two,largeH,smallH))];
  const second=p?[If(one,64,If(two,64,552)),If(one,If(ch,840,920),If(two,If(ch,840,920),top)),If(one,952,464),smallH]:[If(two,1072,972),top,If(two,784,884),If(one,largeH,smallH)];
  const third=p?[If(two,552,64),If(ch,840,920),464,smallH]:[If(two,1072,64),If(ch,524,566),If(two,784,884),smallH];
  const fourth=p?[552,If(ch,840,920),464,smallH]:[972,If(ch,524,566),884,smallH];
  children.push(...adaptiveFrame('host','host',first),...adaptiveFrame('guest1','guest1',second),
   ...adaptiveFrame('guest2','guest2',third,undefined,If(one,false,true)),...adaptiveFrame('guest3','guest3',fourth,undefined,eq(V('guestCount'),3)),
   text('host-name',V('hostName'),[84,p?216:174,p?420:760,34],24,{fontWeight:700,background:surface,padding:5}),
   text('guest1-name',V('guest1Name'),[p?If(one,84,If(two,84,572)):If(two,1092,992),p?If(one,If(ch,860,940),If(two,If(ch,860,940),216)):174,p?420:700,34],24,{fontWeight:700,background:surface,padding:5}),
   text('guest2-name',V('guest2Name'),[p?If(two,572,84):If(two,1092,84),p?If(ch,860,940):If(ch,544,586),p?420:700,34],24,{fontWeight:700,background:surface,padding:5},If(one,false,true)),
   text('guest3-name',V('guest3Name'),[p?572:992,p?If(ch,860,940):If(ch,544,586),p?420:700,34],24,{fontWeight:700,background:surface,padding:5},eq(V('guestCount'),3)),
   ...chat(p?[64,1500,952,180]:[64,890,1792,64]));
 }else if(view==='break'){
  children.push(caps('break-kicker','A LITTLE BREATHING ROOM',[72,p?270:232,p?936:1150,36],21,{color:accent}),
   text('break-title',V('breakTitle'),[72,p?382:341,p?936:1250,p?540:400],p?148:160,{fontWeight:700,letterSpacing:-6,lineHeight:1.02}),
   text('break-body',V('breakBody'),[80,p?1000:815,p?920:1120,130],p?34:30,{color:muted}),
   ...[0,1,2].map((i)=>box('orbit-'+i,p?[290+i*52,1230+i*52,500-i*104,500-i*104]:[1430+i*36,375+i*36,360-i*72,360-i*72],[],{border:cat(i===1?'2px solid ':'1px solid ',i===1?accent:line),borderRadius:500})),
  );
 }else if(view==='closing'){
  children.push(...frame('host','host',p?[230,190,620,620]:[80,195,650,720],V('hostName'),{when:V('hostVisible')}),
   caps('closing-kicker','THANKS FOR BEING HERE',p?[64,910,952,35]:[830,244,1000,35],20,{color:accent}),
   text('closing-headline',V('ctaTitle'),p?[64,1012,952,300]:[830,335,1000,310],p?94:100,{fontWeight:700,letterSpacing:-3,lineHeight:1.05}),
   box('address-plate',p?[64,1410,952,120]:[830,721,1000,112],[],{background:accent,borderRadius:12}),
   text('closing-address',V('ctaAddress'),p?[100,1446,850,54]:[866,751,900,54],p?42:40,{fontWeight:700,color:color('#10251f','#ffffff')}),
   text('closing-role',V('hostRole'),p?[64,1620,952,55]:[834,880,960,50],26,{color:muted}));
 }
 // Quiet motion runs on a graphics-only layer. Source parents remain stationary.
 children.push(box('light-travel',[64,p?1765:971,p?180:260,2],[],{background:accent,opacity:.45},V('motion')),...cues(p));
 const layout={id:view+'-'+orientation,label:label+' · '+(p?'Portrait':'Landscape'),width:w,height:h,
  root:box('stage',[0,0,w,h],children,{position:'relative',background:color('#0b1117','#f1f3ef'),overflow:'hidden'}),
  animation:{transition:{type:'morph',durationMs:420,contentDurationMs:180},tracks:[{target:'light-travel',property:'x',keyframes:[{atMs:0,value:64},{atMs:16000,value:p?836:1596}],easing:'easeInOut',clock:'show',loop:'pingpong'}]},
 };
 doc.set.layouts.push(layout);(doc.set.views[view]??={})[orientation]=layout.id;
}

function button(id,label,key,value,when){doc.set.controls.push({id,type:'button',label,action:{type:'value.set',key,value},...(when===undefined?{}:{when})});}
function toggle(id,label,key,when){button(id+'-on','Show '+label,key,true,If(when??true,If(V(key),false,true),false));button(id+'-off','Hide '+label,key,false,If(when??true,V(key),false));}
for(const [id,label,value]of [['name','Name card','name'],['note','Teaching card','note'],['cta','Show CTA','cta'],['clear-cue','Clear overlay','none']])button(id,label,'cue',value,If(eq(V('cue'),value),false,value==='none'?If(eq(V('cue'),'none'),false,true):true));
button('light','Light mode','theme','light',eq(V('theme'),'dark'));button('dark','Dark mode','theme','dark',eq(V('theme'),'light'));
button('mint','Mint accent','accent','mint');button('silver','Silver accent','accent','silver');
button('motion-on','Enable motion','motion',true,If(V('motion'),false,true));button('motion-off','Pause motion','motion',false,V('motion'));
toggle('host','host','hostVisible',viewWhen('opening','demo','spotlight','closing'));
toggle('chat','chat','chatVisible',viewWhen('solo','demo','conversation','roundtable'));
button('demo-live','Use screen','demoLive',true,viewWhen('demo'));button('demo-example','Use example','demoLive',false,viewWhen('demo'));
button('media-live','Use media','mediaLive',true,viewWhen('spotlight'));button('media-example','Use teaching card','mediaLive',false,viewWhen('spotlight'));
button('reset-zoom','Reset zoom','screenZoom',1,viewWhen('demo'));
const labels={showTitle:'Show name',hostName:'Host name',hostRole:'Host description',headline:'Opening headline',tagline:'Opening introduction',topic:'Demo topic',noteTitle:'Teaching headline',noteBody:'Teaching points',ctaTitle:'CTA headline',ctaAddress:'CTA address',breakTitle:'Break headline',breakBody:'Return message',guest1Name:'Guest one',guest2Name:'Guest two',guest3Name:'Guest three'};
const either=(a,b)=>If(a,true,b);
const fieldWhen={hostName:either(viewWhen('opening','solo','demo','conversation','roundtable','spotlight','closing'),eq(V('cue'),'name')),hostRole:either(viewWhen('closing'),eq(V('cue'),'name')),headline:viewWhen('opening'),tagline:viewWhen('opening'),topic:viewWhen('demo'),noteTitle:either(viewWhen('demo','spotlight'),eq(V('cue'),'note')),noteBody:either(viewWhen('demo','spotlight'),eq(V('cue'),'note')),ctaTitle:either(viewWhen('closing'),eq(V('cue'),'cta')),ctaAddress:either(viewWhen('closing'),eq(V('cue'),'cta')),breakTitle:viewWhen('break'),breakBody:viewWhen('break'),guest1Name:viewWhen('conversation','roundtable'),guest2Name:If(viewWhen('roundtable'),If(eq(V('guestCount'),1),false,true),false),guest3Name:If(viewWhen('roundtable'),eq(V('guestCount'),3),false)};
for(const [key,label]of Object.entries(labels))doc.set.controls.push({id:key,type:'text',label,key,...(fieldWhen[key]?{when:fieldWhen[key]}:{})});
for(const [key,label,step,when]of [['guestCount','Guests',1,viewWhen('roundtable')],['screenZoom','Screen zoom',.05,If(viewWhen('demo'),V('demoLive'),false)],['corners','Camera corners',1]])doc.set.controls.push({id:key,type:'number',label,key,presentation:'slider',step,...(when?{when}:{})});
const section=(id,label,ids,collapsed=false)=>({id,label,controls:ids.map(id=>id==='builtin:layout'?id:'set:'+id),collapsed});
doc.set.controlArrangement.sections=[
 section('views','Layouts',['builtin:layout']),
 section('cues','Live cues',['name','note','cta','clear-cue']),
 section('view','This view',['host-on','host-off','chat-on','chat-off','demo-live','demo-example','media-live','media-example','guestCount','screenZoom','reset-zoom']),
 section('copy','Your content',Object.keys(labels)),
 section('look','Look & feel',['light','dark','mint','silver','motion-on','motion-off','corners'],true),
];
export const classicGuide={
 schema:'producer.reference-guide/1',setId:'classic',version:'1.0.0',purpose:'A complete, neutral studio with eight independently composed landscape/portrait views.',
 views:names,sourceRoles:doc.set.slots,defaultView:'solo',themes:['dark','light'],
 principles:['Large source regions, restrained chrome and deliberate type hierarchy.','Optional chat reflows the camera.','Current-layout controls use the existing show.layoutId binding; this Set has no Show.','Device identity and account connections remain outside the package.','Motion animates only a graphics-only layer; native source ancestry stays static.'],
 qualification:'Requires canonical/default-state checks, both-theme visual review, every dock size and separate native preparation/recording evidence.',
};
export default {schema:'producer.design-plan/2',package:doc,assetRefs:[]};
