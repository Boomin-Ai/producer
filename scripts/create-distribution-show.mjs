import fs from 'node:fs';
import {loadRuntime} from './presentation-proof/runtime.mjs';
const {RehearsalSession,outputProjection}=await loadRuntime();
const {webkit}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'playwright');
const dir='docs/shows/media/distribution-logos',manifest=JSON.parse(fs.readFileSync(dir+'/manifest.json'));
const browser=await webkit.launch();const assets={};
try{
 const page=await browser.newPage();
 for(const entry of manifest.assets){
  if(!entry.file)continue;
  const cached=dir+'/'+entry.file.replace('.svg','.png');
  const png=fs.existsSync(cached)?'data:image/png;base64,'+fs.readFileSync(cached).toString('base64'):await page.evaluate(async svg=>{const image=new Image();image.src='data:image/svg+xml;base64,'+btoa(unescape(encodeURIComponent(svg)));await image.decode();const canvas=document.createElement('canvas');canvas.width=512;canvas.height=512;const ctx=canvas.getContext('2d');const scale=Math.min(448/image.width,448/image.height);ctx.drawImage(image,(512-image.width*scale)/2,(512-image.height*scale)/2,image.width*scale,image.height*scale);return canvas.toDataURL('image/png');},fs.readFileSync(dir+'/'+entry.file,'utf8'));
  const file=entry.file.replace('.svg','.png');fs.writeFileSync(dir+'/'+file,Buffer.from(png.split(',')[1],'base64'));assets[entry.title]={name:entry.title+' · SVGL',mime:'image/png',data:png};
 }
}finally{await browser.close()}
const needed=['Twitch','Kick','YouTube','TikTok','Instagram','Facebook','X (formerly Twitter)','LinkedIn','GitHub','Stripe','PayPal'];
const ids=Object.fromEntries(needed.map((title,i)=>[title,'logo-'+i]));
const usedAssets=Object.fromEntries(needed.map(title=>[ids[title],assets[title]]));
usedAssets.brand={name:'Atlantium',mime:'image/png',data:'data:image/png;base64,'+fs.readFileSync('docs/shows/media/atlantium-logo.png').toString('base64')};
const box=(id,x,y,w,h,background='#0a1630',radius=24,extras={})=>({id,type:'box',styles:{position:'absolute',left:x,top:y,width:w,height:h,background,borderRadius:radius,...extras},children:[]});
const text=(id,x,y,w,size,copy,color='#edf5ff',extras={})=>({id,type:'text',text:copy,styles:{position:'absolute',left:x,top:y,width:w,fontSize:size,color,fontFamily:'Avenir Next, Helvetica Neue, sans-serif',fontWeight:700,lineHeight:1.12,whiteSpace:'pre-line',...extras}});
const logo=(id,title,x,y,size=100)=>({id,type:'media',assetId:ids[title],fit:'contain',styles:{position:'absolute',left:x,top:y,width:size,height:size}});
const shader=(id,x,y,w,h,effect,opacity,radius=0)=>({id,type:'shader',styles:{position:'absolute',left:x,top:y,width:w,height:h},shader:{effect,colors:['#03081e','#285bff','#e5f5ff'],speed:.65,intensity:1.5,scale:1,opacity,radius,quality:'medium',clock:'show'}});
const beats=[
 ['hook','The hook','YOUR AUDIENCE.\nYOUR BUSINESS.','Build something you can take with you.'],
 ['platforms','Platform dependency','THE PLATFORM\nIS THE GATEKEEPER.','A subscription there is a relationship there.'],
 ['audience','Direct audience','FOLLOWERS ≠\nDIRECT ACCESS.','Build an audience that can follow you anywhere.'],
 ['distribution','Many destinations','ONE SHOW.\nMANY DESTINATIONS.','Producer sends your show to multiple live platforms.'],
 ['checkout','Your business','YOUR PRODUCT.\nYOUR CHECKOUT.','Send people to a storefront you control.'],
 ['open','Open source','BUILD YOUR\nOWN CHANNEL.','I open-sourced the studio. Now build with me.'],
];
const layouts=beats.map(([mode,label,headline,sub],index)=>{
 const nodes=[shader('atmosphere',0,0,1080,1920,'aurora',.5),shader('camera-flare',61,1077,862,566,'borderFlare',1,35)];
 const add=(...n)=>nodes.push(...n);
 add(box('edition-chip',64,92,220,48,'#57baff',10),text('edition',80,103,190,24,'BUILDER / POV','#041027'),{id:'brand',type:'media',assetId:'brand',fit:'contain',styles:{position:'absolute',left:674,top:87,width:52,height:52}},text('brand-name',732,101,188,23,'ATLANTIUM.AI','#b5d7ff'));
 add(text('headline',64,176,856,mode==='hook'?88:mode==='distribution'?68:82,headline,'#f0f7ff',{fontWeight:900,letterSpacing:-2.8}),text('subhead',64,mode==='hook'?426:384,856,32,sub,'#adcae8'));
 if(mode!=='hook')add(box('editorial-board',64,474,856,590,'linear-gradient(145deg, rgba(19,41,84,.98), rgba(5,15,33,.98))',28,{border:'1px solid #294b79'}));
 const card=(id,title,x,y,w=376,h=260)=>{add(box(id+'-card',x,y,w,h,'#081326',24,{border:'1px solid #32537c'}),logo(id+'-logo',title,x+w/2-55,y+22,110),text(id+'-name',x+20,y+143,w-40,34,title,'#e6f2ff',{textAlign:'center'}));};
 if(mode==='hook'){
  add(box('intro-rule',64,502,74,4,'#65c7ff',2),text('question',64,544,856,46,'IF THE PLATFORM CHANGED,\nWHAT WOULD YOU KEEP?','#d9e9ff',{fontWeight:800,letterSpacing:-.8}));
  add(box('editorial-board',64,688,856,248,'linear-gradient(145deg, rgba(19,41,84,.85), rgba(5,15,33,.95))',28,{border:'1px solid #294b79'}));
  ['Twitch','Kick','YouTube'].forEach((title,i)=>{
   const x=84+i*278;
   add(box('channel-'+i,x,708,260,208,'rgba(6,15,35,.72)',20,{border:'1px solid #2b436a'}),logo('channel-logo-'+i,title,x+74,730,112),text('channel-name-'+i,x+20,856,220,28,title,'#bdd7f7',{textAlign:'center'}));
  });
  add(text('thesis',64,980,856,30,'REACH IS VALUABLE. OWNERSHIP LASTS.','#8ed4ff',{letterSpacing:.6,textAlign:'center'}));
 }else if(mode==='platforms'){
  card('twitch','Twitch',92,516);card('kick','Kick',516,516);
  add(text('twitch-subs',112,724,336,25,'SUBSCRIPTIONS ON TWITCH','#b9a4ff',{textAlign:'center'}),text('kick-subs',536,724,336,25,'SUBSCRIPTIONS ON KICK','#8ae547',{textAlign:'center'}));
  add(text('portability',108,826,768,46,'Switching platforms does not\nmove every subscriber.','#eef5ff',{textAlign:'center',fontWeight:800}),text('dependency',108,984,768,28,'Different app. Same dependency.','#89b8e9',{textAlign:'center'}));
 }else if(mode==='audience'){
  add(text('layers-label',108,515,768,28,'PLATFORM REACH','#90baff',{textAlign:'center'}));
  ['Twitch','Kick','YouTube','Instagram'].forEach((title,i)=>add(logo('reach-'+i,title,146+i*196,567,104)));
  add(text('arrow',108,690,768,55,'↓','#62caff',{textAlign:'center'}),box('owned-card',104,770,776,240,'#102853',24,{border:'1px solid #63baff'}),text('owned-title',136,804,712,46,'YOUR DIRECT AUDIENCE','#e7f7ff',{textAlign:'center',fontWeight:900}),text('owned-detail',136,880,712,32,'Your domain · Your opt-in list\nYour customer relationships','#b8ddff',{textAlign:'center',lineHeight:1.4}));
 }else if(mode==='distribution'){
  add(box('producer-hub',280,500,424,122,'#174aa0',22,{border:'1px solid #91caff'}),text('producer-label',304,525,376,45,'PRODUCER','#f4fbff',{textAlign:'center',fontWeight:900}),text('one-show',304,580,376,24,'ONE LIVE SHOW','#b3dcff',{textAlign:'center'}));
  add(box('fanout',180,665,624,2,'#4b94f8',0),box('stem',491,622,2,43,'#4b94f8',0));
  ['Twitch','Kick','YouTube'].forEach((title,i)=>{add(box('branch-'+i,208+i*280,665,2,39,'#4b94f8',0),logo('destination-'+i,title,158+i*280,718,104),text('destination-label-'+i,118+i*280,836,184,27,title,'#d8edff',{textAlign:'center'}));});
  ['TikTok','Instagram','Facebook'].forEach((title,i)=>add(logo('other-'+i,title,236+i*204,912,72)));
  add(text('eligibility',108,1008,768,24,'Compatible live destinations · account access required','#9dbfe8',{textAlign:'center'}));
 }else if(mode==='checkout'){
  add(text('relationship',108,518,768,35,'YOUR AUDIENCE → YOUR WEBSITE','#9fd7ff',{textAlign:'center'}),box('shop-card',112,606,752,180,'#102853',24,{border:'1px solid #4776b7'}),text('shop-title',144,638,688,48,'YOUR PRODUCTS','#f3f8ff',{textAlign:'center',fontWeight:900}),text('shop-detail',144,705,688,31,'Your storefront. Your customer relationship.','#b0cfff',{textAlign:'center'}),text('shop-arrow',108,798,768,47,'↓','#62caff',{textAlign:'center'}),text('payment-title',108,862,768,37,'YOUR PAYMENT ACCOUNT','#e9f4ff',{textAlign:'center'}),logo('stripe','Stripe',296,914,98),logo('paypal','PayPal',580,914,98),text('processor-note',108,1020,768,23,'Choose your processor · illustrative providers','#8eb4dd',{textAlign:'center'}));
 }else{
  add(logo('github','GitHub',426,508,132),text('opensource-title',108,662,768,58,'PRODUCER IS\nOPEN SOURCE.','#edf7ff',{fontWeight:900,textAlign:'center'}),text('source-proof',116,844,752,33,'Run the studio. Inspect the code.\nNext: Atlantium iOS.','#a8d4ff',{textAlign:'center',lineHeight:1.4}),text('cta',112,984,760,31,{get:'values.cta'},'#69c9ff',{textAlign:'center'}));
 }
 add({id:'host-camera',type:'slot',slotId:'host',framing:{mode:'fill',x:.5,y:.5},appearance:{shape:'rectangle',cornerRadius:32,outlineWidth:.5,outlineColor:'#477bbd',opacity:1,grayscale:0},styles:{position:'absolute',left:64,top:1080,width:856,height:560}});
 add(box('host-bed',64,1550,856,90,'linear-gradient(0deg, rgba(2,8,20,.95), rgba(2,8,20,0))',20),text('host-name',90,1585,690,32,{get:'values.hostName'}),text('captions',80,1644,824,32,{get:'values.caption'},'#f4f8ff',{textAlign:'center'}));
 return {id:'distribution-'+mode+'-portrait',label,width:1080,height:1920,root:{id:'distribution-root',type:'box',styles:{position:'relative',width:1080,height:1920,background:'#03091f',overflow:'hidden'},children:nodes},animation:{transition:{type:'crossfade',durationMs:420},tracks:[...(mode==='hook'?['question','channel-0','channel-logo-0','channel-name-0','channel-1','channel-logo-1','channel-name-1','channel-2','channel-logo-2','channel-name-2','thesis'].map((target,i)=>({target,property:'opacity',keyframes:[{atMs:0,value:0},{atMs:180+Math.floor(i/3)*80,value:0},{atMs:420+Math.floor(i/3)*70,value:1}],easing:'easeOut',clock:'segment'})):[]),{target:'headline',property:'opacity',keyframes:[{atMs:0,value:0},{atMs:520,value:1}],easing:'easeOut',clock:'segment'},{target:'camera-flare',property:'shader.intensity',keyframes:[{atMs:0,value:1.2},{atMs:4200,value:1.7}],easing:'easeInOut',loop:'pingpong',clock:'show'}]}};
});
const diagramStates=[['locked','1 · Platform owns it','WHAT IF\nYOU LEFT?','Your audience lives inside someone else’s platform.'],['leave','2 · Try to leave','YOU LEAVE.\nTHEY STAY.','Changing platforms does not move your subscribers.'],['owned','3 · Own the relationship','YOUR AUDIENCE.\nYOUR RULES.','Build a relationship your audience can take with them.'],['everywhere','4 · Stream everywhere','ONE SHOW.\nEVERYWHERE.','Use platforms for reach. Keep your direct relationships.']];
for(const [state,label,title,detail] of diagramStates){
 const base=structuredClone(layouts[0]);base.id='diagram-'+state+'-portrait';base.label=label;
 base.root.children=base.root.children.filter(n=>['atmosphere','camera-flare','edition-chip','edition','brand','brand-name','host-camera','host-bed','host-name','captions'].includes(n.id));
 const n=base.root.children,tracks=[];
 const animate=(target,property,frames,loop='none',easing='easeInOut')=>tracks.push({target,property,keyframes:frames.map(([atMs,value])=>({atMs,value})),clock:'segment',loop,easing});
 n.push(text('headline',64,176,856,84,title,'#f0f7ff',{fontWeight:900,letterSpacing:-2}),text('subhead',64,386,856,30,detail,'#adcae8'),box('diagram-board',64,474,856,590,'linear-gradient(145deg, rgba(14,35,80,.8), rgba(4,10,30,.94))',28,{border:'1px solid #345788'}));
 const hub=(id,x,y,w,name,color)=>{const node=box(id,x,y,w,100,color,24,{border:'1px solid #71aaff',boxShadow:'0 0 28px rgba(45,107,255,.18)'});node.children.push(text(id+'-label',12,32,w-24,30,name,'#eef7ff',{textAlign:'center'}));n.push(node);};
 const independent=state==='owned'||state==='everywhere',leaving=state==='leave';
 if(!independent)n.push(box('audience-enclosure',108,840,768,177,'rgba(89,48,145,.16)',24,{border:'2px solid #9a76ed'}));
 hub('builder',leaving?94:316,508,352,'YOU / YOUR SHOW','#163b70');
 hub('hub',248,680,488,state==='everywhere'?'PRODUCER':independent?'YOUR DIRECT AUDIENCE':'PLATFORM GATEKEEPER',independent?'#164d96':'#352257');
 n.push(box('uplink',490,608,4,72,independent?'#66d8ff':'#a38cf6',2));
 ['Twitch','Kick','YouTube'].forEach((t,i)=>{
  const x=158+i*280;
  n.push(box('branch-'+i,x+50,780,3,60,'#407bc0',2),logo('destination-'+i,t,x,854,100));
 });
 n.push(box('fanout',210,780,560,3,'#407bc0',2));
 // The same audience nodes remain on screen: trapped in the platform, then moving into a direct hub.
 for(let i=0;i<8;i++){
  const x=164+i*88,y=970;
  const person=box('person-'+i,x,y,40,40,independent?'#83deff':'#bba1ff',20,{boxShadow:'0 0 18px rgba(103,170,255,.35)'});
  person.children.push(box('person-core-'+i,14,14,12,12,'#edf9ff',6));n.push(person);
  if(independent){animate(person.id,'x',[[0,x],[320+i*70,x],[1100+i*70,302+(i%4)*110]]);animate(person.id,'y',[[0,y],[320+i*70,y],[1100+i*70,790+Math.floor(i/4)*32]]);}
  else if(!leaving)animate(person.id,'opacity',[[0,.35],[300+i*85,1],[1800,1]]);
 }
 n.push(text('diagram-note',100,1024,784,22,leaving?'THE SUBSCRIBERS DO NOT FOLLOW THE MOVE':independent?'DIRECT RELATIONSHIPS + PLATFORM REACH':'REACH IS RENTED. THE GATE IS NOT YOURS.','#9bdcff',{textAlign:'center',letterSpacing:.5}));
 if(leaving){n.push(box('break-flash',482,636,20,20,'#f4d5ff',10,{boxShadow:'0 0 45px #e4a5ff'}),text('break-label',550,532,310,26,'CONNECTION LOST','#d9bcff',{letterSpacing:1}));animate('break-flash','scale',[[0,.05],[650,.05],[780,3],[1100,.05]]);animate('break-flash','opacity',[[0,0],[650,0],[740,1],[1100,0]]);animate('break-label','opacity',[[0,0],[1000,0],[1300,1]]);animate('builder','x',[[0,316],[180,316],[1150,94]]);animate('uplink','height',[[0,72],[450,72],[800,28],[1050,1]]);animate('uplink','opacity',[[0,1],[700,1],[1050,0]]);}
 else{
  n.push(box('signal-up',485,614,14,20,'#e8faff',7,{boxShadow:'0 0 18px #58bfff'}));
  animate('signal-up','y',[[0,612],[1500,660]],'repeat','linear');animate('signal-up','opacity',[[0,0],[180,1],[1250,1],[1500,0]],'repeat');
 }
 if(state==='everywhere'){
  ['0','1','2'].forEach((i)=>{n.push(box('signal-'+i,203+Number(i)*280,784,16,18,'#dff9ff',8,{boxShadow:'0 0 24px #57baff'}));animate('signal-'+i,'y',[[0,782],[Number(i)*240+250,782],[Number(i)*240+1350,832],[2200,832]],'repeat','linear');animate('signal-'+i,'opacity',[[0,0],[Number(i)*240+250,1],[Number(i)*240+1350,1],[2200,0]],'repeat');});
 }
 animate('headline','opacity',[[0,0],[220,1]]);
 animate('headline','y',[[0,206],[360,176]],'none','easeOut');
 animate('hub','scale',[[0,.94],[650,1]]);
 base.animation={transition:{type:'morph',durationMs:650},tracks};layouts.push(base);
}
const doc={schema:'producer.presentation/1',id:'own-your-distribution',version:'1.4.0',name:'Own Your Distribution — Founder POV',set:{tokens:{},styles:{},values:{hostName:{type:'text',default:'Kleveland Bishop',maxLength:30},cta:{type:'text',default:'Follow the build · Atlantium iOS',maxLength:90},caption:{type:'text',default:'',maxLength:44}},feeds:{},slots:[{id:'host',label:'Host camera'}],components:{},assets:usedAssets,initialLayout:layouts[0].id,layouts,controls:[...beats.map(([mode,label])=>({id:'view-'+mode,type:'button',label,when:{op:'eq',args:[{get:'show.phase'},'distribution']},action:{type:'layout.select',layoutId:'distribution-'+mode+'-portrait'}})),...diagramStates.map(([state,label])=>({id:'diagram-'+state,type:'button',label,when:{op:'eq',args:[{get:'show.phase'},'diagram']},action:{type:'layout.select',layoutId:'diagram-'+state+'-portrait'}})),...['hostName','cta','caption'].map(key=>({id:'edit-'+key,type:'text',key,label:({hostName:'Host name',cta:'Closing call to action',caption:'Caption line (manual)'})[key]}))]},show:{id:'distribution-show',version:'1.0.0',initialPhase:'distribution',phases:[{id:'distribution',label:'Own your distribution',layoutId:layouts[0].id,next:'diagram'},{id:'diagram',label:'Own the network · Interactive diagram',layoutId:'diagram-locked-portrait'}],choices:[{id:'a',label:'A'},{id:'b',label:'B'}]}};
const session=new RehearsalSession(doc);session.send({type:'control',action:{type:'show.start'}});
for(const layout of layouts){session.send({type:'control',action:{type:'layout.select',layoutId:layout.id}});const p=outputProjection(session.package,session.snapshot());if(p.width!==1080||p.height!==1920||session.snapshot().show.phase!=='distribution')throw Error('Single-segment vertical contract failed');}
for(const path of ['docs/shows/own-your-distribution.show.json','/Users/klevelandbishop/Documents/boomin/docs/shows/own-your-distribution.show.json'])fs.writeFileSync(path,JSON.stringify(session.package,null,2));
console.log('Created two segments: founder POV and interactive distribution diagram.');
