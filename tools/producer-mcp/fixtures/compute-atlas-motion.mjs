// Art direction and motion use the existing canonical renderer contract.
import original from './compute-atlas.mjs';
const plan=structuredClone(original),doc=plan.package;
doc.version='1.1.0';doc.set.layouts=[];
doc.set.values.voiceIntensity.default=.45;
const C={bg:'#071219',panel:'#0e2530',ink:'#eef8f5',muted:'#9bb5bf',mint:'#69efce',blue:'#428eff',amber:'#ffce7a',paper:'#f1ecdf'};
const R=(x,y,w,h)=>({position:'absolute',left:x,top:y,width:w,height:h});
const V=k=>({get:'values.'+k}),eq=(a,b)=>({op:'eq',args:[a,b]}),iff=(a,b,c)=>({op:'if',args:[a,b,c]});
const select=(key,items,fallback)=>items.reduceRight((rest,[value,result])=>iff(eq(V(key),value),result,rest),fallback);
const T=(id,x,y,w,h,text,size=32,color=C.ink,weight=700)=>({id,type:'text',text,styles:{...R(x,y,w,h),fontFamily:'Arial, sans-serif',fontSize:size,fontWeight:weight,lineHeight:1.04,letterSpacing:size>65?-2:0,whiteSpace:'pre-wrap',overflow:'hidden',color}});
const B=(id,x,y,w,h,color=C.panel,children=[],radius=0)=>({id,type:'box',styles:{...R(x,y,w,h),background:color,overflow:'hidden',borderRadius:radius},children});
const G=(id,x,y,w,h,children)=>{const n=B(id,x,y,w,h,'#00000000',children);delete n.styles.background;return n;};
const M=(id,x,y,w,h,assetId,fit='contain')=>({id,type:'media',assetId,fit,styles:R(x,y,w,h)});
const markets=[['nova','Northern Virginia','N. VA',4496.5,10.8,1210.4829,335.1678],['atlanta','Atlanta','ATLANTA',1803.2,29.5,1080.6705,508.8621],['dfw','Dallas–Fort Worth','DFW',1432.8,39.6,785.6696,549.4509],['phoenix','Phoenix','PHOENIX',1069.2,12.1,435.2664,502.1839]];
const headings=['atlasTitle','compareTitle','pipelineTitle','scarcityTitle','operatorsTitle','ctaTitle'];
const templates=original.package.set.layouts;
for(const [index,id]of ['atlas','comparison','pipeline','scarcity','operators','cta'].entries())for(const p of [false,true]){
 const w=p?1080:1920,h=p?1920:1080,paper=id==='comparison',ink=paper?C.bg:C.ink,muted=paper?'#455f69':C.muted,accent=id==='scarcity'?C.amber:paper?'#08756c':C.mint;
 const template=templates.find(l=>l.id===id+(p?'-portrait':'-landscape'));
 const nodes=[],tracks=[];
 const anim=(target,property,from,to,start=0,duration=650,loop='none')=>tracks.push({target,property,keyframes:[{atMs:0,value:from},{atMs:duration,value:to}],delayMs:start,clock:'segment',easing:'easeOut',loop});
 const enter=(node,delay=100,distance=28)=>{nodes.push(node);anim(node.id,'opacity',0,1,delay,420);anim(node.id,'y',node.styles.top+distance,node.styles.top,delay,600);};
 const reveal=(node,delay=100,duration=800)=>{node.mask={kind:'wipe',direction:'right',progress:1};nodes.push(node);anim(node.id,'mask.progress',0,1,delay,duration);};
 if(id==='pipeline')nodes.push(structuredClone(template.root.children.find(n=>n.id==='world')));
 if(id==='atlas')nodes.push(B('map-stage',p?0:560,p?640:0,p?w:1360,p?1000:h,'#0a2029'));
 if(id==='scarcity')nodes.push(B('scarcity-side',p?0:1080,p?1080:0,p?w:840,p?640:h,'#152b31'));
 nodes.push(B('masthead-rule',p?72:84,p?215:58,p?936:1752,2,paper?'#b5c3bf':'#2d4a55'),M('brand-mark',p?72:84,p?245:85,52,52,'atlantiumLogo'),T('brand',p?140:152,p?248:87,p?530:1100,40,V('seriesName'),25,ink,800),T('edition',p?140:152,p?286:126,p?530:1100,34,`GEORGIA / ${String(index+1).padStart(2,'0')}  ·  H1 2026`,20,muted,500));
 const center=p?[850,425]:[1670,235],d=p?240:260,r=d/2;
 nodes.push({id:'voice-surround',type:'shader',styles:R(center[0]-r-96,center[1]-r-96,d+192,d+192),shader:{effect:'voiceRing',colors:[C.blue,C.mint,'#96b6d5'],speed:.25,intensity:.45,scale:1,opacity:.65,radius:r,glow:.12,variant:2,bindings:{intensity:V('voiceIntensity')},quality:'low',clock:'show'}});
 const photo=B('host-portrait',center[0]-r,center[1]-r,d,d,C.bg,[M('headshot',0,0,d,d,'headshot','cover')],r);photo.mask={kind:'rounded',radius:r};photo.when=iff(V('useCamera'),false,true);nodes.push(photo,{id:'host-source',type:'slot',slotId:'host',when:V('useCamera'),styles:R(center[0]-r,center[1]-r,d,d),framing:{mode:'fill',x:.5,y:.5},appearance:{shape:'circle',outlineWidth:4,outlineColor:C.mint}});
 const name=T('host-name',center[0]-160,center[1]+r+20,320,36,V('hostName'),p?21:20,muted);name.styles.textAlign='center';nodes.push(name);
 const title=G('title',p?72:84,p?370:205,p?570:1320,p?265:230,[T('headline',0,0,p?570:1320,p?265:230,V(headings[index]),p?76:100,ink,900)]);enter(title,0,32);
 if(id==='atlas'){
  const map={x:p?60:630,y:p?690:360,w:p?960:1200,h:p?499.2:624};
  const art=[M('us-map',0,0,map.w,map.h,'usMarketsMap')];
  markets.forEach((m,i)=>{const x=m[5]/1500*map.w,y=m[6]/780*map.h,selected=eq(V('focus'),m[0]),rr=p?20:25;const halo=B('halo-'+m[0],x-rr-10,y-rr-10,(rr+10)*2,(rr+10)*2,'#267369',[],48);halo.when=selected;art.push(halo,B('dot-'+m[0],x-rr,y-rr,rr*2,rr*2,iff(selected,C.mint,'#d7e5e5'),[],40));const label=T('dot-number-'+m[0],x-rr,y-rr+4,rr*2,rr*2,String(i+1),p?26:31,C.bg,900);label.styles.textAlign='center';art.push(label);if(i===1)art.push(T('map-atlanta-label',x+28,y+26,260,52,'ATLANTA',p?31:37,C.mint,900));});
  reveal(G('map-reveal',map.x,map.y,map.w,map.h,art),90,850);
  if(!p)enter(G('rank-hook',84,420,440,132,[T('rank-hook-number',0,0,200,132,'#2',124,C.mint,900),T('rank-hook-caption',205,35,235,88,'EXISTING\nINVENTORY',30,C.muted,800)]),250,18);
  const rw=p?936:440,row=p?84:82,contents=[T('ranking-label',0,0,rw,40,'FOUR LARGEST / EXISTING MW',p?24:22,C.muted,700)];
  markets.forEach((m,i)=>{const selected=eq(V('focus'),m[0]);contents.push(B('rank-row-'+m[0],0,48+i*row,rw,row-8,iff(selected,'#124a48','#10252e'),[],8),T('rank-name-'+m[0],16,60+i*row,p?550:rw-32,36,`${i+1}  ${m[1]}`,p?31:24,iff(selected,C.mint,C.ink)),T('rank-mw-'+m[0],p?630:42,p?60+i*row:93+i*row,p?290:rw-50,35,m[3].toLocaleString('en-US'),p?32:25,iff(selected,C.mint,C.muted)));});
  enter(G('rankings',p?72:84,p?1230:565,rw,48+row*4,contents),400,24);
 }
 if(id==='comparison'){
  const focusName=select('focus',markets.map(m=>[m[0],m[1]]),'Atlanta'),focusValue=select('focus',markets.map(m=>[m[0],iff(eq(V('lens'),'available'),m[4]+' MW',m[3].toLocaleString('en-US')+' MW')]),'1,803.2 MW');
  enter(B('focus-card',p?72:84,p?690:485,p?936:510,p?280:450,C.bg,[T('focus-label',28,24,p?850:455,50,focusName,p?39:34,C.ink,800),T('focus-number',28,p?105:130,p?850:455,135,focusValue,p?91:80,C.mint,900),T('focus-basis',28,p?230:320,p?850:455,80,iff(eq(V('lens'),'available'),'AVAILABLE INVENTORY','EXISTING INVENTORY'),25,C.muted)],16),140);
  const x=p?105:730,y=p?1110:490,cw=p?870:1080,ch=p?400:400;
  const chartNodes=['inventory','available'].map(lens=>({id:'market-chart-'+lens,type:'chart',when:eq(V('lens'),lens),styles:R(-52,-12,cw+64,ch+42),chart:{id:'market-comparison-'+lens,kind:'bar',data:JSON.stringify({scope:'cbre-h1-2026-four-markets-'+lens,points:[{x:.5,y:null},...markets.map((m,i)=>({x:i+1,y:m[lens==='available'?4:3]})),{x:4.5,y:null}]}),color:'#08756c',gridColor:'#385b6b22',yMin:0,yMax:lens==='available'?45:4500,durationMs:1000,fillOpacity:.5,lineWidth:3}}));
  const chart=G('chart-window',x,y,cw,ch,chartNodes);reveal(chart,180,900);
  nodes.push(T('chart-caption',x,y-60,cw,45,iff(eq(V('lens'),'available'),'WHAT IS STILL AVAILABLE?','HOW ATLANTA STACKS UP'),p?30:32,ink,800));
  markets.forEach((m,i)=>{const text=T('chart-label-'+i,x+i*cw/4,y+ch+18,cw/4,45,m[2],p?25:26,i===1?'#08756c':'#455f69');text.styles.textAlign='center';nodes.push(text);});
  for(let i=0;i<3;i++){const t=T('plot-y-'+i,x-70,y+(ch-24)*i/2,60,30,iff(eq(V('lens'),'available'),['45','22.5','0'][i],['4500','2250','0'][i]),22,'#455f69',500);t.styles.textAlign='right';nodes.push(t);}
  nodes.push(T('lens-note',p?72:730,p?1590:950,p?936:1080,45,iff(eq(V('lens'),'available'),'AVAILABLE / 0–45 MW','EXISTING INVENTORY / 0–4,500 MW'),24,muted));
 }
 if(id==='pipeline'){
  // The server studio gets its own cinematic chapter, with a large editorial foreground.
  const yy=p?720:465,ww=p?936:1040;
  enter(G('construction-stat',p?72:84,yy,ww,p?440:450,[T('construction',0,0,ww,p?220:230,'≈2.9 GW',p?190:200,C.mint,900),T('construction-label',4,p?240:250,ww,65,'UNDER CONSTRUCTION',p?38:40,C.ink,800),T('construction-context',4,p?325:330,ww,100,'Atlanta leads CBRE’s primary-market pipeline.',p?34:30,C.muted,600)]),120,45);
  const bars=[];for(let i=0;i<5;i++)bars.push(B('build-bar-'+i,i*(p?170:105),100-(10+i*17),p?135:78,10+i*17,i===4?C.mint:'#28617a',[],4));
  nodes.push(T('build-illustration',p?72:1260,p?1420:815,p?936:560,36,'ILLUSTRATIVE BUILDOUT',22,C.muted,600));
  const pulse=G('build-progress',p?72:1260,p?1300:690,p?936:560,110,bars);reveal(pulse,400,900);
  enter(G('existing-summary',p?72:84,p?1470:850,p?936:1150,135,[T('existing',0,0,p?936:1150,78,'1.8 GW',p?69:72,C.amber,900),T('existing-label',0,85,p?936:1150,48,'EXISTING INVENTORY · FUTURE ≠ OPERATING',p?26:27,C.muted,700)]),440,20);
 }
 if(id==='scarcity'){
  const x=p?72:84,y=p?700:465,ww=p?936:950;
  enter(G('scarcity-stat',x,y,ww,p?450:500,[T('available',0,0,ww,p?265:300,'1.6%',p?235:265,C.amber,900),T('available-label',6,p?285:310,ww,70,'AVAILABLE INVENTORY',p?39:42,C.ink,800),T('available-exact',6,p?365:400,ww,80,'29.5 MW of 1,803.2 MW',p?36:38,C.muted,600)]),130,42);
  const gx=p?72:1120,gy=p?1170:465,gw=p?936:700,gh=p?430:438;
  reveal(G('grid-reveal',gx,gy,gw,gh,[M('availability-grid',0,0,gw,gh,'availabilityGrid')]),200,1100);
  nodes.push(T('grid-key',gx,p?1605:930,gw,p?52:60,'16 / 1,000 CELLS\nROUNDED ILLUSTRATION',p?25:26,C.amber,800));
 }
 if(id==='operators'){
  const company=select('operator',[['edged','EDGED'],['qts','QTS'],['databank','DATABANK']],'EDGED'),place=select('operator',[['edged','ATLANTA / THOMAS STREET'],['qts','ATLANTA 1 / WEST MIDTOWN'],['databank','ATL2 / ATLANTA']],'ATLANTA'),capacity=select('operator',[['edged','169 MW'],['qts','278 MW+'],['databank','ATL2']],'169 MW');
  const basis=select('operator',[['edged','CAMPUS SPECIFICATION'],['qts','CRITICAL CAMPUS CAPACITY'],['databank','COLOCATION / CLOUD']],'');
  const note=select('operator',[['edged','27 + 100 + 42 MW buildings.\nOperating and construction stages stay separate.'],['qts','Operator-reported campus capacity.\nCampus plans are not a live power reading.'],['databank','Linked operator and facility records.\nNo GPU count or inference access is inferred.']],'');
  const xx=p?72:84,yy=p?715:480,ww=p?936:1100;
  reveal(B('operator-card',xx,yy,ww,p?805:465,'#0c2638',[B('operator-stripe',0,0,9,p?805:465,C.blue),T('company',35,30,ww-70,150,company,p?118:135,C.ink,900),T('facility',38,195,ww-76,90,place,p?32:33,C.muted,700),T('capacity',35,p?320:300,p?850:550,140,capacity,p?113:108,C.mint,900),T('basis',p?38:620,p?475:320,p?850:440,85,basis,p?29:27,C.blue,800),T('stage-note',38,p?610:405,ww-76,p?150:70,note,p?32:25,C.muted,500)]),120,700);
  const chain=G('entity-chain',p?72:1290,p?1570:520,p?936:520,p?55:400,[T('entity-chain-text',0,0,p?936:520,p?55:400,p?'COMPANY  →  CAMPUS  →  FACILITY':'COMPANY\n↓\nCAMPUS\n↓\nFACILITY',p?28:47,C.mint,800)]);enter(chain,350,20);
 }
 if(id==='cta'){
  // A decisive mint field gives the closing action a different visual rhythm.
  const xx=p?72:84,yy=p?735:490,ww=p?936:1260,hh=p?650:425;
  const card=B('cta-panel',xx,yy,ww,hh,C.mint,[T('cta-support',38,35,ww-76,p?240:165,V('ctaSupport'),p?54:53,C.bg,800),B('cta-action-panel',30,p?370:245,ww-60,p?210:145,C.bg,[T('cta-action',26,p?58:43,ww-112,110,V('ctaAction'),p?55:57,C.mint,900)],12)],20);enter(card,150,42);
  reveal(G('cta-close',p?72:1400,p?1480:565,p?936:440,p?130:330,[T('cta-bottom',0,0,p?936:440,p?130:330,p?'DATA → DECISIONS.':'DATA\n↓\nDECISIONS.',p?65:61,C.ink,900)]),420,650);
 }
 const note=T('source-note',p?72:680,p?1662:1010,p?930:1150,p?82:50,index===4?'Operator sites + Atlantium register · 28 Oct 2026\nMixed-stage campus figures are not summed into metro inventory.':index===5?'ATLANTIUM / ATLANTA API\nInfrastructure visuals are illustrative.':'CBRE · H1 2026 · Four largest of eight primary markets\nInventory is capacity, not electricity consumption.',p?21:18,muted,500);note.when=V('showSources');nodes.push(note,T('chapter-count',p?72:84,p?1760:1010,p?800:550,35,`${String(index+1).padStart(2,'0')} / 06   ·   ATLANTIUM`,p?22:18,muted));
 const mw=p?936:1752;nodes.push(B('chapter-meter',p?72:84,p?1820:1060,mw,4,paper?'#b8c6c1':'#26424d',[B('meter-fill',0,0,mw,4,accent)]));anim('meter-fill','width',1,mw,0,(index===0?4:index===5?7:6)*1000);
 doc.set.layouts.push({...template,root:{id:'root',type:'box',styles:{position:'relative',width:w,height:h,overflow:'hidden',background:paper?C.paper:C.bg},children:nodes},animation:{tracks,transition:{type:'crossfade',durationMs:180,contentDurationMs:120}}});
}
export default plan;
