// Reusable Atlantium episode shell. Tool-specific artwork can replace the demo stage.
const C={bg:'#08121f',panel:'#112137',ink:'#d5e5f1',muted:'#829eb4',mint:'#a9c9dd',blue:'#78a9d0',paper:'#112137'};
const R=(x,y,w,h)=>({position:'absolute',left:x,top:y,width:w,height:h}),V=k=>({get:'values.'+k});
const T=(id,x,y,w,h,text,size=32,color=C.ink,weight=700)=>({id,type:'text',text,styles:{...R(x,y,w,h),fontFamily:'Arial, sans-serif',fontSize:size,fontWeight:weight,lineHeight:1.08,letterSpacing:size>65?-2:0,whiteSpace:'pre-wrap',overflow:'hidden',color}});
const B=(id,x,y,w,h,color=C.panel,children=[],radius=0)=>({id,type:'box',styles:{...R(x,y,w,h),background:color,borderRadius:radius,overflow:'hidden'},children});
const G=(id,x,y,w,h,children)=>{const n=B(id,x,y,w,h,'#00000000',children);delete n.styles.background;return n;};
const M=(id,x,y,w,h,assetId)=>({id,type:'media',assetId,fit:'cover',styles:R(x,y,w,h)});
const values={},controls=[];
const field=(key,label,value,maxLength=180)=>{values[key]={type:'text',default:value,maxLength};controls.push({id:key,type:'text',label,key});};
field('toolName','Tool name','TOOL NAME',38);field('toolCategory','Tool category','YOUR NEXT AI ENGINEERING ADVANTAGE',80);field('toolMark','Tool mark / initials','{ }',8);field('hostName','Host name','KLEVELAND BISHOP',50);
const chapters=[['spotlight','01 · The tool','MEET YOUR\nNEXT ADVANTAGE.'],['why','02 · Why it matters','LESS FRICTION.\nMORE BUILDING.'],['workflow','03 · How it works','FROM INPUT\nTO IMPACT.'],['demo','04 · In action','SHOW IT.\nDON’T JUST SAY IT.'],['setup','05 · Get started','YOUR FIRST\nWORKING BUILD.'],['takeaway','06 · Take action','ONE TOOL.\nYOUR NEXT MOVE.']];
chapters.forEach(([id,label,title])=>field(id+'Title',label+' headline',title,90));
field('before','Before / pain','Manual steps.\nDisconnected tools.\nSlow feedback.',180);field('after','After / benefit','A clearer workflow.\nConnected inputs.\nFaster iteration.',180);
field('input','Workflow input','Start with your data, prompt or event.',120);field('transform','Workflow transformation','Show what this tool does differently.',120);field('output','Workflow output','End with a useful result you can ship.',120);
field('demoLabel','Demo window label','LIVE EXAMPLE / REPLACE FOR EACH TOOL',80);field('demoCode','Demo stage content','01  DEFINE THE INPUT\n02  RUN YOUR TOOL\n03  INSPECT THE RESULT',220);field('demoResult','Demo result','Your tool-specific animation or walkthrough goes here.',150);
field('step1','Setup step 1','Install or connect the tool.',100);field('step2','Setup step 2','Run the smallest useful example.',100);field('step3','Setup step 3','Connect it to a real workflow.',100);field('starterCode','Starter snippet','input → tool → useful output',160);
field('takeaway','Main takeaway','Learn the tool.\nBuild something useful.\nMake it repeatable.',180);field('ctaAction','CTA copy','SAVE THIS. BUILD WITH IT.',90);field('ctaSupport','CTA supporting line','AI Engineering Essentials\nTools worth knowing. Workflows worth building.',150);
values.useCamera={type:'boolean',default:false};values.useDemo={type:'boolean',default:false};
for(const [id,label,key,value]of [['host-photo','Use headshot','useCamera',false],['host-camera','Use Host source','useCamera',true],['demo-shell','Show animated shell','useDemo',false],['demo-source','Show demo source','useDemo',true]])controls.push({id,type:'button',label,action:{type:'value.set',key,value}});
const doc={schema:'producer.presentation/2',id:'ai-engineering-essentials',name:'AI Engineering Essentials',version:'1.0.0',requires:['mask@1'],set:{initialLayout:'spotlight-landscape',initialView:'spotlight',views:{},values,feeds:{},components:{},slots:[{id:'host',label:'Host · camera, image or video'},{id:'demo',label:'Demo · screen, image or video'}],layouts:[],controls,controlArrangement:{sections:[],minimized:['builtin:layout','set:toolName','set:demo-shell']}}};
for(const[index,[id,label]]of chapters.entries())for(const p of [false,true]){
 const w=p?1080:1920,h=p?1920:1080,light=false,ink=light?C.bg:C.ink,muted=light?'#4d6269':C.muted,accent=light?'#08756c':C.mint,n=[],tracks=[];
 const anim=(target,property,from,to,start=0,duration=650,loop='none')=>tracks.push({target,property,keyframes:[{atMs:0,value:from},{atMs:duration,value:to}],delayMs:start,clock:'segment',easing:'easeOut',loop});
 const enter=(node,delay=100)=>{n.push(node);anim(node.id,'opacity',0,1,delay,450);anim(node.id,'y',node.styles.top+30,node.styles.top,delay,650);};
 const reveal=(node,delay=100)=>{node.mask={kind:'wipe',direction:'right',progress:1};n.push(node);anim(node.id,'mask.progress',0,1,delay,850);};
 n.push({...M('engineering-backdrop',0,0,w,p?700:470,'engineeringBackdrop'),styles:{...R(0,0,w,p?700:470),opacity:.65}},B('backdrop-shade',0,0,w,p?700:470,'#08121f66'));
 n.push(B('header-rule',p?72:84,p?215:58,p?936:1752,2,light?'#b3c6c1':'#2b4855'),M('brand-logo',p?72:84,p?245:85,52,52,'atlantiumLogo'),T('brand',p?140:152,p?248:87,p?570:1200,40,'ATLANTIUM / AI ENGINEERING',p?24:26,ink,800),T('series',p?140:152,p?285:126,p?570:1200,35,'ESSENTIALS  /  '+String(index+1).padStart(2,'0'),20,muted));
 const cx=p?800:1680,cy=p?425:245,d=p?360:240,r=d/2;
 n.push({id:'voice-ring',type:'shader',styles:R(cx-r-96,cy-r-96,d+192,d+192),shader:{effect:'voiceRing',colors:[C.blue,C.mint,'#96b6d5'],speed:.25,intensity:.45,scale:1,opacity:.7,radius:r,glow:.12,variant:2,quality:'low',clock:'show'}});
 const photo=B('host-portrait',cx-r,cy-r,d,d,C.bg,[M('headshot',0,0,d,d,'headshot')],r);photo.when={op:'if',args:[V('useCamera'),false,true]};photo.mask={kind:'rounded',radius:r};n.push(photo,{id:'host-source',type:'slot',slotId:'host',when:V('useCamera'),styles:R(cx-r,cy-r,d,d),framing:{mode:'fill',x:.5,y:.5},appearance:{shape:'circle',outlineWidth:4,outlineColor:C.mint}});
 const name=T('host-name',cx-160,cy+r+20,320,35,V('hostName'),20,muted);name.styles.textAlign='center';n.push(name);
 enter(G('title',p?72:84,p?370:205,p?500:1320,p?300:235,[T('headline',0,0,p?500:1320,p?300:235,V(id+'Title'),p?64:94,ink,900)]),0);
 if(id==='spotlight'){
  enter(B('tool-hero',p?72:84,p?730:480,p?936:1160,p?365:400,C.mint,[T('tool-category',30,28,p?876:1100,85,V('toolCategory'),p?28:30,C.bg,700),T('tool-name',28,140,p?880:1100,195,V('toolName'),p?102:125,C.bg,900)],16),140);
  const card=B('tool-mark-panel',p?72:1320,p?1180:480,p?936:516,p?370:400,C.panel,[T('tool-symbol',p?450:45,p?70:60,p?410:430,260,V('toolMark'),p?180:195,C.mint,900),T('tool-mark-label',28,p?45:330,p?410:460,p?240:50,p?'01\nTOOL\nSPOTLIGHT':'TOOL SPOTLIGHT',p?46:27,C.ink,800)],16);reveal(card,300);
  n.push(B('hero-scan',p?102:1350,p?1505:850,p?120:110,4,C.blue));anim('hero-scan','x',p?102:1350,p?820:1680,500,2000,'pingpong');
 }
 if(id==='why'){
  enter(B('before-card',p?72:84,p?730:490,p?936:810,p?340:430,'#172b41',[T('before-label',30,28,p?876:750,50,'BEFORE',29,'#a9c9dd',800),T('before-copy',30,105,p?876:750,p?220:280,V('before'),p?43:49,C.ink,700)],16),100);
  enter(B('after-card',p?72:1026,p?1170:490,p?936:810,p?350:430,C.bg,[T('after-label',30,28,p?876:750,50,'AFTER',29,C.mint,800),T('after-copy',30,105,p?876:750,p?220:280,V('after'),p?43:49,C.ink,700)],16),400);
  n.push(T('change-arrow',p?480:930,p?1090:645,100,100,p?'↓':'→',76,'#08756c',900));anim('change-arrow','opacity',.3,1,600,900,'pingpong');
 }
 if(id==='workflow'){
  const keys=['input','transform','output'],labels=['INPUT','YOUR TOOL','OUTPUT'];
  for(let i=0;i<3;i++){const x=p?72:84+i*626,y=p?750+i*290:520,cw=p?936:500,ch=p?190:310;
   enter(B('flow-card-'+i,x,y,cw,ch,i===1?'#203b55':C.panel,[T('flow-label-'+i,26,24,cw-52,45,'0'+(i+1)+' / '+labels[i],p?27:28,i===1?C.mint:C.blue,800),T('flow-copy-'+i,26,p?84:110,cw-52,p?100:175,V(keys[i]),p?36:40,C.ink,700)],14),100+i*200);
   if(i<2){const link=B('flow-link-'+i,p?535:x+500,p?y+190:665,p?4:126,p?100:4,'#42627d');n.push(link);const dot=B('packet-'+i,p?526:x+505,p?y+195:656,22,22,C.mint,[],6);n.push(dot);anim(dot.id,p?'y':'x',p?y+195:x+505,p?y+270:x+595,500+i*260,1400,'repeat');}
  }
 }
 if(id==='demo'){
  const x=p?72:84,y=p?730:480,cw=p?936:1752,ch=p?850:475;
  n.push(B('demo-frame',x,y,cw,ch,C.panel,[],18),T('demo-window-label',x+30,y+25,cw-60,70,V('demoLabel'),p?25:28,C.muted,800));
  const placeholder=G('demo-placeholder',x+30,y+110,cw-60,ch-140,[T('demo-code',25,30,cw-110,p?280:175,V('demoCode'),p?42:49,C.ink,700),B('demo-result-panel',0,p?400:200,cw-60,p?255:120,C.bg,[T('demo-result',25,24,cw-110,p?210:80,V('demoResult'),p?35:33,C.mint,700)],12),B('demo-cursor',25,p?345:190,42,5,C.mint)]);placeholder.when={op:'if',args:[V('useDemo'),false,true]};reveal(placeholder,180);anim('demo-cursor','opacity',.15,1,850,550,'pingpong');
  n.push({id:'demo-source',type:'slot',slotId:'demo',when:V('useDemo'),styles:R(x+24,y+105,cw-48,ch-129),framing:{mode:'fit',x:.5,y:.5},appearance:{shape:'rectangle',cornerRadius:12,outlineWidth:0,outlineColor:C.blue}});
 }
 if(id==='setup'){
  const list=[];for(let i=0;i<3;i++)list.push(B('step-row-'+i,0,i*(p?190:125),p?936:960,p?165:105,C.panel,[T('step-number-'+i,20,20,95,80,'0'+(i+1),p?62:58,C.mint,900),T('step-copy-'+i,130,25,p?770:800,p?130:80,V('step'+(i+1)),p?36:36,C.ink,700)],12));enter(G('setup-steps',p?72:84,p?730:490,p?936:960,p?570:375,list),120);
  reveal(B('starter-terminal',p?72:1110,p?1370:490,p?936:726,p?235:375,'#142b43',[T('starter-label',25,24,p?886:676,48,'FIRST WORKING EXAMPLE',p?27:27,C.blue,800),T('starter-code',25,100,p?886:676,p?125:250,V('starterCode'),p?39:43,C.mint,700)],14),380);
 }
 if(id==='takeaway'){
  enter(G('takeaway-copy',p?72:84,p?720:480,p?936:1000,p?360:390,[T('takeaway-main',0,0,p?936:1000,p?360:390,V('takeaway'),p?66:76,C.ink,900)]),100);
  enter(B('cta-card',p?72:1160,p?1170:480,p?936:676,p?420:425,C.mint,[T('cta-support',30,25,p?876:616,p?180:190,V('ctaSupport'),p?37:38,C.bg,700),B('cta-action-box',24,p?250:260,p?888:628,p?140:140,C.bg,[T('cta-action',23,30,p?842:582,100,V('ctaAction'),p?44:40,C.mint,900)],12)],16),300);
 }
 n.push(T('footer-tool',p?72:680,p?1670:1010,p?936:1150,p?65:50,V('toolName'),p?26:24,muted,700),T('chapter-count',p?72:84,p?1760:1010,p?850:550,36,`${String(index+1).padStart(2,'0')} / 06  ·  AI ENGINEERING ESSENTIALS`,p?22:18,muted,700));
 const mw=p?936:1752;n.push(B('pacing-meter',p?72:84,p?1820:1060,mw,4,light?'#b4c4be':'#2c4b57',[B('pacing-fill',0,0,mw,4,accent)]));anim('pacing-fill','width',1,mw,0,6000);
 const layoutId=id+(p?'-portrait':'-landscape');doc.set.layouts.push({id:layoutId,label:label+(p?' · Portrait':' · Landscape'),width:w,height:h,root:{id:'root',type:'box',styles:{position:'relative',width:w,height:h,background:light?C.paper:C.bg,overflow:'hidden'},children:n},animation:{tracks,transition:{type:'crossfade',durationMs:360,contentDurationMs:220}}});doc.set.views[id]??={};doc.set.views[id][p?'portrait':'landscape']=layoutId;
}
const refs=ids=>ids.map(id=>'set:'+id);
doc.set.controlArrangement.sections=[{id:'navigation',label:'Six reusable chapters',controls:['builtin:layout']},{id:'episode',label:'Episode / tool',controls:refs(['toolName','toolCategory','toolMark','hostName'])},{id:'headlines',label:'Chapter headlines',controls:refs(chapters.map(([id])=>id+'Title'))},{id:'why',label:'Before / after',controls:refs(['before','after'])},{id:'workflow',label:'Workflow',controls:refs(['input','transform','output'])},{id:'demo',label:'Demo stage',controls:refs(['demoLabel','demoCode','demoResult','demo-shell','demo-source'])},{id:'setup',label:'Quick start',controls:refs(['step1','step2','step3','starterCode'])},{id:'cta',label:'Takeaway / CTA',controls:refs(['takeaway','ctaSupport','ctaAction'])},{id:'host',label:'Host appearance',controls:refs(['host-photo','host-camera']),collapsed:true}];
export default {schema:'producer.design-plan/2',package:doc,assetRefs:['atlantiumLogo','headshot','engineeringBackdrop']};
