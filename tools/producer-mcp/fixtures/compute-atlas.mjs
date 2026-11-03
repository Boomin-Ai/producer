// Authored canonical plan only. Assets are resolved by the MCP compiler.
const C={bg:'#080e13',panel:'#101e27',ink:'#eef8f5',muted:'#a7bec5',dim:'#31505e',mint:'#69efce',blue:'#428eff',amber:'#ffce7a'};
const R=(x,y,w,h)=>({position:'absolute',left:x,top:y,width:w,height:h});
const V=k=>({get:'values.'+k}),eq=(a,b)=>({op:'eq',args:[a,b]}),iff=(c,a,b)=>({op:'if',args:[c,a,b]}),choose=(key,items,fallback)=>items.reduceRight((acc,[value,out])=>iff(eq(V(key),value),out,acc),fallback);
const T=(id,x,y,w,h,text,size=32,color=C.ink,weight=600)=>({id,type:'text',text,styles:{...R(x,y,w,h),fontFamily:'Arial, sans-serif',fontSize:size,fontWeight:weight,lineHeight:1.08,whiteSpace:'pre-wrap',overflow:'hidden',color}});
const B=(id,x,y,w,h,fill=C.panel,radius=20,children=[])=>({id,type:'box',styles:{...R(x,y,w,h),background:fill,borderRadius:radius,overflow:'hidden'},children});
const M=(id,x,y,w,h,assetId,fit='contain')=>({id,type:'media',assetId,fit,styles:R(x,y,w,h)});
const S=(id,effect,x,y,w,h,extra={})=>({id,type:'shader',styles:R(x,y,w,h),shader:{effect,colors:[C.blue,C.mint,'#96b6d5'],speed:.25,intensity:1.1,scale:1,opacity:.9,radius:0,quality:'low',clock:'show',...extra}});
const markets=[{"id":"nova","rank":1,"name":"Northern Virginia","short":"N. VIRGINIA","mw":4496.5,"point":[-77.4874,39.0438],"xy":[1210.4829105819651,335.16777405033827]},{"id":"atlanta","rank":2,"name":"Atlanta","short":"ATLANTA","mw":1803.2,"point":[-84.388,33.749],"xy":[1080.6705350174961,508.8621076932069]},{"id":"dfw","rank":3,"name":"Dallas\u2013Fort Worth","short":"DALLAS\u2013FORT WORTH","mw":1432.8,"point":[-97.0403,32.8998],"xy":[785.6695865957219,549.4508928665338]},{"id":"phoenix","rank":4,"name":"Phoenix","short":"PHOENIX","mw":1069.2,"point":[-112.074,33.4484],"xy":[435.26644625262026,502.18392506508803]}];
const values={};const controls=[];const field=(key,label,value,maxLength=180)=>{values[key]={type:'text',default:value,maxLength};controls.push({id:key,type:'text',label,key});};
field('atlasTitle','Atlas headline','ATLANTA\nON THE MAP',70);field('compareTitle','Comparison headline','A NEW\nWEIGHT CLASS.',70);field('pipelineTitle','Construction headline','THE NEXT\nWAVE.',80);field('scarcityTitle','Availability headline','BIG DOESN’T\nMEAN AVAILABLE.',80);field('operatorsTitle','Operator headline','THE PEOPLE\nBEHIND THE POWER.',80);field('ctaTitle','CTA headline','BUILD WITH\nATLANTA’S ECONOMY.',80);field('ctaSupport','CTA supporting line','Real-time Atlanta economic intelligence.\nBuild with the Atlanta API.',160);field('ctaAction','CTA action','COMMENT “API” BELOW',80);field('hostName','Host name','KLEVELAND BISHOP',60);field('seriesName','Series name','ATLANTIUM / COMPUTE ATLAS',70);
values.focus={type:'text',default:'atlanta',maxLength:30};values.lens={type:'text',default:'inventory',maxLength:30};values.operator={type:'text',default:'edged',maxLength:30};values.useCamera={type:'boolean',default:false};values.studioView={type:'text',default:'wide',maxLength:30};values.studioCue={type:'text',default:'neutral',maxLength:30};values.voiceIntensity={type:'number',default:.7,min:0,max:2};values.showSources={type:'boolean',default:true};
controls.push({id:'voiceIntensity',type:'number',label:'Voice ring intensity',key:'voiceIntensity'});
const action=(id,label,key,value)=>controls.push({id,type:'button',label,action:{type:'value.set',key,value}});
for(const m of markets)action('focus-'+m.id,m.name,'focus',m.id);
for(const [id,label]of [['inventory','Existing inventory'],['available','Available inventory']])action('lens-'+id,label,'lens',id);
for(const [id,label]of [['edged','Edged'],['qts','QTS'],['databank','DataBank']])action('operator-'+id,label,'operator',id);
action('host-photo','Use headshot','useCamera',false);action('host-camera','Use Host source','useCamera',true);action('wide','Wide studio','studioView','wide');action('close','Rack close-up','studioView','close');action('neutral','Cool studio','studioCue','neutral');action('signal','Power surge','studioCue','signal');action('sources-show','Show source notes','showSources',true);action('sources-hide','Hide source notes','showSources',false);
const objects=[];const mesh=(id,kind,args,position,color,extra={})=>({id,kind,args,position,rotation:[0,0,0],color,metalness:.65,roughness:.28,...extra});
objects.push(mesh('floor','box',[26,.15,20],[0,-2.6,-2],'#0e1b26',{roughness:1,metalness:0}),mesh('backdrop','box',[25,10,.2],[0,1,-9],'#08131f'));
for(let i=0;i<5;i++){const x=(i-2)*1.85;objects.push(mesh('rack-'+i,'roundedBox',[1.08,4.2,1.25,3,.09],[x,-.35,-3.7],'#14293a'),mesh('face-'+i,'box',[.91,3.8,.05],[x,-.32,-3.03],'#070f18'));for(let j=0;j<3;j++)objects.push(mesh('sled-'+i+'-'+j,'box',[.82,.36,.08],[x,-1.35+j*1.05,-2.98],'#1b3547'),mesh('led-'+i+'-'+j,'box',[.12,.045,.10],[x+.27,-1.35+j*1.05,-2.91],C.mint,{unlit:true,emissive:C.mint,emissiveIntensity:1.4}));}
objects.push(mesh('signal-beacon','sphere',[.06,12,8],[0,1.8,-3],C.mint,{unlit:true,motion:{kind:'moveY',speed:.3,amplitude:.15,phase:0}}));
const world={schema:'producer.scene3d/1',fps:30,clearColor:C.bg,fog:{color:C.bg,near:12,far:38},camera:{position:[8,4.5,13],target:[0,-.3,-3],fov:45},views:{wide:{position:[8,4.5,13],target:[0,-.3,-3],fov:45},close:{position:[4,1.5,6],target:[.7,-.1,-3],fov:48}},environment:'studio',environmentIntensity:.5,exposure:1.05,cueDurationMs:650,slots:[],objects,lights:[{id:'key',position:[-5,6,5],color:C.mint,intensity:85},{id:'rim',position:[7,4,-2],color:C.blue,intensity:90}],cues:{neutral:{lights:{key:85,rim:90}},signal:{lights:{key:170,rim:200}}}};
const doc={schema:'producer.presentation/2',id:'atlantium-compute-atlas',name:'Atlantium · Compute Atlas',version:'1.0.0',requires:['chart@1','mask@1','backdrop@1'],set:{initialLayout:'atlas-landscape',initialView:'atlas',views:{},values,feeds:{},slots:[{id:'host',label:'Host · camera, image or video'}],components:{},layouts:[],controls,controlArrangement:{sections:[],minimized:['builtin:layout','set:focus-atlanta','set:signal','set:neutral']}}};
const chapters=[['atlas','01 · On the map · 4s'],['comparison','02 · Market explorer · 6s'],['pipeline','03 · The next wave · 6s'],['scarcity','04 · What is available · 6s'],['operators','05 · Operator explorer · 6s'],['cta','06 · Atlanta API · 7s']];
function base(p,index){const w=p?1080:1920,h=p?1920:1080;const n=[{id:'world',type:'scene3d',scene3d:{id:p?'compute-world-portrait':'compute-world-landscape',pass:'background',world,cue:V('studioCue'),view:V('studioView')},styles:R(0,0,w,h)}];
 // Opaque panels keep the editorial content clean while the studio remains visible.
 n.push(B('masthead-rule',p?72:84,p?215:58,p?936:1752,2,'#37525f',0),M('brand-mark',p?72:84,p?245:85,52,52,'atlantiumLogo'),T('brand',p?140:152,p?248:87,p?530:1100,40,V('seriesName'),p?25:25,C.ink,800),T('edition',p?140:152,p?285:124,p?530:1000,35,`GEORGIA / ${String(index+1).padStart(2,'0')}   •   H1 2026`,p?20:20,C.muted,500));
 const center=p?[850,425]:[1670,235],d=p?240:260,r=d/2,pad=96;
 const ring=S('voice-surround','voiceRing',center[0]-r-pad,center[1]-r-pad,d+pad*2,d+pad*2,{radius:r,variant:2,intensity:.7,opacity:.7,glow:.2,bindings:{intensity:V('voiceIntensity')}});n.push(ring);
 const photo=B('host-portrait',center[0]-r,center[1]-r,d,d,C.bg,r,[M('headshot',0,0,d,d,'headshot','cover')]);photo.mask={kind:'rounded',radius:r};photo.when=iff(V('useCamera'),false,true);n.push(photo);
 n.push({id:'host-source',type:'slot',slotId:'host',when:V('useCamera'),styles:R(center[0]-r,center[1]-r,d,d),framing:{mode:'fill',x:.5,y:.5},appearance:{shape:'circle',outlineWidth:4,outlineColor:C.mint}});
 n.push(T('host-name',center[0]-160,center[1]+r+20,320,36,V('hostName'),p?21:20,C.muted,700));n.at(-1).styles.textAlign='center';
 n.push(T('chapter-count',p?72:84,p?1760:1013,p?400:550,35,`${String(index+1).padStart(2,'0')} / 06   •   ATLANTIUM`,p?22:18,C.muted,700));
 const note=T('source-note',p?72:680,p?1656:1012,p?930:1150,p?88:48,index===4?'Operator sites + Atlantium entity register · 28 Oct 2026\nCampus stages and power bases remain separate.':index===5?'ATLANTIUM / ATLANTA API\nInfrastructure visuals are illustrative.':'CBRE · H1 2026 · Four largest by existing inventory\nWithin eight primary markets. MW is capacity, not power use.',p?21:18,C.muted,500);note.when=V('showSources');n.push(note);
 for(let i=0;i<6;i++)n.push(B('progress-'+i,p?72+i*156:1320+i*83,p?1820:1060,p?136:63,4,i<=index?C.mint:'#253b48',2));
 return n;}
function heading(n,p,key){n.push(T('headline',p?72:84,p?370:205,p?570:1320,p?265:210,V(key),p?76:88,C.ink,900));}
const metric=(n,id,x,y,w,value,label,p,color=C.mint)=>{n.push(T(id+'-value',x,y,w,p?152:170,value,p?120:142,color,900),T(id+'-label',x,y+(p?155:176),w,p?78:64,label,p?29:27,C.muted,600));};
const focusName=choose('focus',markets.map(m=>[m.id,m.name]),'Atlanta');
const avail={nova:10.8,atlanta:29.5,dfw:39.6,phoenix:12.1};
const focusMW=choose('focus',markets.map(m=>[m.id,m.mw.toLocaleString('en-US')+' MW']),'1,803.2 MW');
for(const [index,[id,label]]of chapters.entries())for(const p of [false,true]){const w=p?1080:1920,h=p?1920:1080,n=base(p,index);heading(n,p,['atlasTitle','compareTitle','pipelineTitle','scarcityTitle','operatorsTitle','ctaTitle'][index]);
 if(id==='atlas'){
  n.push(B('map-panel',p?48:60,p?690:420,p?984:1230,p?525:570,'#0c1820ed',24));
  const map={x:p?60:120,y:p?700:425,w:p?960:1080,h:p?499.2:561.6};n.push(M('us-map',map.x,map.y,map.w,map.h,'usMarketsMap'));
  for(const m of markets){const x=map.x+m.xy[0]/1500*map.w,y=map.y+m.xy[1]/780*map.h,selected=eq(V('focus'),m.id),radius=p?19:23;
   const halo=B('halo-'+m.id,x-radius-9,y-radius-9,(radius+9)*2,(radius+9)*2,'#267369',40);halo.when=selected;n.push(halo,B('dot-'+m.id,x-radius,y-radius,radius*2,radius*2,iff(selected,C.mint,'#c8dadd'),40),T('dot-number-'+m.id,x-radius,y-radius+4,radius*2,radius*2,String(m.rank),p?25:29,C.bg,900));n.at(-1).styles.textAlign='center';
   if(m.id==='atlanta')n.push(T('map-atlanta-label',x+27,y+25,p?220:310,55,'ATLANTA',p?30:35,C.mint,900));
  }
  const x=p?72:1360,y=p?1240:470,ww=p?936:470,row=p?83:96;
  n.push(T('ranking-label',x,y-45,ww,35,'EXISTING INVENTORY / MW',p?24:23,C.muted,700));
  for(const [i,m]of markets.entries()){const selected=eq(V('focus'),m.id);n.push(B('rank-row-'+m.id,x-10,y+i*row-7,ww+20,row-10,iff(selected,'#124a48','#101e27e8'),10),T('rank-name-'+m.id,x+12,y+i*row+6,p?555:440,42,`${m.rank}  ${m.name}`,p?32:27,iff(selected,C.mint,C.ink),700),T('rank-mw-'+m.id,p?x+615:x+42,p?y+i*row+6:y+i*row+46,p?300:390,45,m.mw.toLocaleString('en-US'),p?34:27,iff(selected,C.mint,C.muted),700));}
 }
 if(id==='comparison'){
  const card=B('focus-card',p?72:84,p?690:470,p?936:540,p?275:400,'#102b34e8',24);card.backdrop={blur:5};card.children=[T('focus-label',28,25,p?850:480,45,focusName,p?39:35,C.ink,800),T('focus-number',28,p?93:125,p?850:485,p?120:150,iff(eq(V('lens'),'available'),choose('focus',markets.map(m=>[m.id,avail[m.id]+' MW']),'29.5 MW'),focusMW),p?91:85,C.mint,900),T('focus-basis',28,p?220:300,p?850:480,80,iff(eq(V('lens'),'available'),'AVAILABLE INVENTORY','EXISTING INVENTORY'),p?25:25,C.muted,600)];n.push(card);
  const x=p?100:720,y=p?1080:465,cw=p?880:1090,ch=p?420:405;
  const inventory=JSON.stringify({scope:'cbre-h1-2026-four-markets-inventory',points:[{x:.5,y:null},...markets.map((m,i)=>({x:i+1,y:m.mw})),{x:4.5,y:null}]}),available=JSON.stringify({scope:'cbre-h1-2026-four-markets-available',points:[{x:.5,y:null},...markets.map((m,i)=>({x:i+1,y:avail[m.id]})),{x:4.5,y:null}]});
  n.push(T('chart-caption',x,y-45,cw,36,iff(eq(V('lens'),'available'),'AVAILABLE CAPACITY / MW','OPERATING INVENTORY / MW'),p?27:27,C.muted,700),(()=>{const plot=B('chart-window',x,y,cw,ch,'#00000000',0,['inventory','available'].map(lens=>({id:'market-chart-'+lens,type:'chart',when:eq(V('lens'),lens),styles:R(-52,-12,cw+64,ch+42),chart:{id:'market-comparison-'+lens,kind:'bar',data:lens==='available'?available:inventory,color:C.mint,gridColor:'#5c809033',yMin:0,yMax:lens==='available'?45:4500,durationMs:700,fillOpacity:.35,lineWidth:3}})));delete plot.styles.background;return plot;})());
  for(const[i,label]of ['N. VA','ATLANTA','DFW','PHOENIX'].entries()){const a=T('chart-label-'+i,x+i*cw/4,y+ch+10,cw/4,42,label,p?25:25,i===1?C.mint:C.muted,700);a.styles.textAlign='center';n.push(a);}
  for(let tick=0;tick<3;tick++){const label=T('plot-y-'+tick,x-64,y+(ch-24)*tick/2,52,28,iff(eq(V('lens'),'available'),['45','22.5','0'][tick],['4500','2250','0'][tick]),p?22:20,C.muted,500);label.styles.textAlign='right';n.push(label);}
  n.push(T('lens-note',p?72:720,p?1590:935,p?936:1090,55,iff(eq(V('lens'),'available'),'Lens: available capacity · vertical scale 0–45 MW','Lens: existing inventory · vertical scale 0–4,500 MW'),p?24:23,C.muted));
 }
 if(id==='pipeline'){
  const card=B('pipeline-glass',p?72:84,p?720:465,p?936:720,p?480:435,'#0b1c28d9',28);card.backdrop={blur:7};n.push(card);
  metric(n,'construction',p?106:120,p?760:500,p?850:650,'≈2.9 GW','UNDER CONSTRUCTION',p,C.mint);
  n.push(T('pipeline-note',p?106:120,p?1030:770,p?850:650,p?155:115,'Atlanta leads the construction pipeline\nin CBRE’s primary-market comparison.',p?36:31,C.ink,700));
  n.push(B('existing-panel',p?72:1090,p?1280:615,p?936:660,p?245:275,'#0c1b25d9',24));metric(n,'existing',p?106:1124,p?1305:637,p?850:590,'1.8 GW','EXISTING INVENTORY · ROUNDED',p,C.amber);
  n.push(T('pipeline-stage-note',p?72:1090,p?1575:925,p?936:700,72,'Future capacity ≠ operating capacity.',p?29:27,C.muted));
 }
 if(id==='scarcity'){
  metric(n,'available',p?72:84,p?710:445,p?920:820,'1.6%','AVAILABLE INVENTORY · ROUNDED',p,C.amber);
  n.push(T('available-exact',p?72:90,p?980:745,p?936:810,92,'29.5 MW available\nout of 1,803.2 MW inventory.',p?40:41,C.ink,700));
  const panel=B('scarcity-grid-panel',p?60:1000,p?1160:455,p?960:815,p?470:510,'#0c1a23e8',24);n.push(panel,M('availability-grid',p?85:1030,p?1180:485,p?910:755,p?406:472,'availabilityGrid'));
  n.push(T('grid-key',p?90:1028,p?1600:920,p?900:780,40,'16 OF 1,000 CELLS / ROUNDED ILLUSTRATION',p?22:22,C.amber,700));
 }
 if(id==='operators'){
  const company=choose('operator',[['edged','EDGED'],['qts','QTS'],['databank','DATABANK']],'EDGED');
  const place=choose('operator',[['edged','Atlanta campus / Thomas Street'],['qts','Atlanta 1 / West Midtown'],['databank','ATL2 / Atlanta']],'Atlanta campus');
  const capacity=choose('operator',[['edged','169 MW'],['qts','278 MW+'],['databank','ATL2']],'169 MW');
  const basis=choose('operator',[['edged','CAMPUS SPECIFICATION'],['qts','CRITICAL CAMPUS CAPACITY'],['databank','COLOCATION / CLOUD']],'CAMPUS SPECIFICATION');
  const note=choose('operator',[['edged','27 MW + 100 MW + 42 MW buildings.\nThe register keeps operating and construction stages separate.'],['qts','An operator-reported campus figure.\nPlanned substations and campus phases are not a live power reading.'],['databank','Linked operator and facility records.\nNo GPU model, count or inference access is inferred.']],'');
  const card=B('operator-card',p?72:84,p?710:465,p?936:1150,p?820:470,'#102936e8',28);card.backdrop={blur:7};card.children=[T('company',35,32,p?860:1050,150,company,p?120:120,C.mint,900),T('facility',38,195,p?850:1050,90,place,p?38:38,C.ink,700),T('capacity',38,p?310:302,p?850:510,150,capacity,p?105:97,C.ink,900),T('basis',p?38:620,p?475:320,p?850:490,85,basis,p?29:26,C.amber,700),T('stage-note',38,p?605:402,p?850:1050,p?160:68,note,p?32:25,C.muted,500)];n.push(card);
  if(!p)n.push(T('operator-side-note',1320,570,490,270,'COMPANY\n→ CAMPUS\n→ FACILITY',50,C.ink,800));
  n.push(T('operator-disclaimer',p?72:84,p?1570:955,p?936:1720,p?75:40,'Linked entity records. Campus figures are not added to metro inventory.',p?24:24,C.muted));
 }
 if(id==='cta'){
  const panel=B('cta-glass',p?72:84,p?720:470,p?936:1200,p?620:435,'#102936e8',28);panel.backdrop={blur:6};panel.children=[T('cta-support',38,40,p?850:1110,p?240:160,V('ctaSupport'),p?55:51,C.ink,700),B('cta-action-panel',30,p?360:250,p?876:1140,p?175:135,'#68efce',20,[T('cta-action',28,p?52:40,p?820:1080,90,V('ctaAction'),p?52:52,C.bg,900)])];n.push(panel);
  n.push(T('cta-bottom',p?72:1340,p?1450:630,p?936:450,p?165:250,'DATA →\nDECISIONS.',p?70:60,C.mint,900));
 }
 if(id==='atlas'){const common=new Set(['world','masthead-rule','brand-mark','brand','edition','voice-surround','host-portrait','host-source','host-name','chapter-count','source-note','headline',...Array.from({length:6},(_,i)=>'progress-'+i)]);const rename=node=>{if(!common.has(node.id))node.id+='-'+(p?'p':'l');node.children?.forEach(rename);};n.forEach(rename);const at=n.findIndex(node=>node.id==='map-panel-'+(p?'p':'l'));const artwork=B('atlas-art-'+(p?'p':'l'),0,0,w,h,'#00000000',0,n.splice(at));delete artwork.styles.background;n.push(artwork);}
 const roots={id:'root',type:'box',styles:{position:'relative',width:w,height:h,background:C.bg,overflow:'hidden'},children:n};
 const tracks=[{target:'headline',property:'opacity',keyframes:[{atMs:0,value:.3},{atMs:380,value:1}],clock:'segment',easing:'easeOut',loop:'none'},{target:'brand-mark',property:'opacity',keyframes:[{atMs:0,value:.75},{atMs:4500,value:1}],clock:'show',easing:'easeInOut',loop:'pingpong'}];
 if(id==='atlas')tracks.push({target:'halo-atlanta-'+(p?'p':'l'),property:'scale',keyframes:[{atMs:0,value:1},{atMs:1700,value:1.25}],clock:'show',loop:'pingpong',easing:'easeInOut'});
 doc.set.layouts.push({id:id+(p?'-portrait':'-landscape'),label:label+(p?' · Portrait':' · Landscape'),width:w,height:h,root:roots,animation:{tracks,transition:{type:'crossfade',durationMs:280}}});doc.set.views[id]??={};doc.set.views[id][p?'portrait':'landscape']=id+(p?'-portrait':'-landscape');
}
const refs=ids=>ids.map(id=>'set:'+id);
doc.set.controlArrangement.sections=[{id:'navigation',label:'Chapters · 35 second suggested pace',controls:['builtin:layout']},{id:'content',label:'Content',controls:refs(['atlasTitle','compareTitle','pipelineTitle','scarcityTitle','operatorsTitle','ctaTitle','ctaSupport','ctaAction','hostName','seriesName'])},{id:'market',label:'Market explorer',controls:refs(markets.map(m=>'focus-'+m.id))},{id:'lens',label:'Comparison lens',controls:refs(['lens-inventory','lens-available'])},{id:'operator',label:'Operator explorer',controls:refs(['operator-edged','operator-qts','operator-databank'])},{id:'studio',label:'Studio / Host',controls:refs(['host-photo','host-camera','wide','close','neutral','signal','voiceIntensity'])},{id:'sources',label:'Source notes',controls:refs(['sources-show','sources-hide']),collapsed:true}];
export default {schema:'producer.design-plan/2',package:doc,assetRefs:['atlantiumLogo','headshot','usMarketsMap','availabilityGrid']};
