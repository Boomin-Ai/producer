// Reusable SIGNAL / V1 art direction. All UI remains canonical editable nodes.
export const SIGNAL={canvas:'#030B16',surface:'#0B1D30',raised:'#152F49',signal:'#36DFFF',accent:'#FF8A24',text:'#EAF4FF'};
const R=(x,y,w,h)=>({position:'absolute',left:x,top:y,width:w,height:h}),V=k=>({get:'values.'+k});
const T=(id,x,y,w,h,text,size=32,color=SIGNAL.text,weight=700)=>({id,type:'text',text,styles:{...R(x,y,w,h),fontFamily:'Arial, sans-serif',fontSize:size,fontWeight:weight,lineHeight:1.08,whiteSpace:'pre-wrap',overflow:'hidden',color}});
const B=(id,x,y,w,h,children=[])=>({id,type:'box',styles:{...R(x,y,w,h),background:'linear-gradient(135deg,#152F49eb,#0B1D30f5 65%,#030B16fa)',border:'1px solid #36DFFF55',boxShadow:'inset 0 1px 0 #EAF4FF18',borderRadius:18,overflow:'hidden'},children});
const M=(id,x,y,w,h,assetId)=>({id,type:'media',assetId,fit:'contain',styles:R(x,y,w,h)});
export function signalDesign(input,branding={}){
 const plan=structuredClone(input),doc=plan.package;
 const logoAsset=branding.logoAsset??'atlantiumLogo',caption=branding.cliCaption??'ONE TOOL.\nYOUR NEXT ADVANTAGE.';
 plan.assetRefs=plan.assetRefs.filter(id=>id!=='engineeringBackdrop');
 for(const id of ['signalBackdrop','signalCode','signalCpu','signalDatabase','signalCloud','signalSpark','signalShield','signalLayers','signalBox','signalTerminal'])if(!plan.assetRefs.includes(id))plan.assetRefs.push(id);
 const ink=new Set(['#d5e5f1','#eff8f5','#eef5fa','#eef8f5']),muted=new Set(['#829eb4','#9db8c2','#a9c9dd','#96b6d5']),surfaces=new Set(['#112137','#142b43','#172b41','#203b55']);
 for(const l of doc.set.layouts){
  const p=l.height>l.width,w=l.width,h=l.height,chapter=l.id.replace(/-(landscape|portrait)$/,''),n=l.root.children;
  const walk=(node,fn)=>{fn(node);node.children?.forEach(c=>walk(c,fn));};
  const find=id=>{let out;walk(l.root,node=>{if(node.id===id)out=node;});return out;};
  const replace=(id,node)=>{const i=n.findIndex(item=>item.id===id);if(i>=0)n[i]=node;};
  walk(l.root,node=>{
   const s=node.styles??{};
   if(node.type==='text'){
    if(ink.has(s.color))s.color=SIGNAL.text;else if(muted.has(s.color))s.color='#EAF4FF99';else if(['#78a9d0','#08756c'].includes(s.color))s.color=SIGNAL.signal;
    if(s.color==='#08121f')s.color=SIGNAL.text;
    if(Number(s.fontSize)<=28){s.letterSpacing=1.1;s.fontWeight=700;}
   }
   if(s.background==='#08121f')s.background=SIGNAL.canvas;
   if(node.type==='box'&&(surfaces.has(s.background)||s.background==='#a9c9dd')&&!['host-portrait','root'].includes(node.id)&&Number(s.width)>240&&Number(s.height)>60)Object.assign(s,{background:'linear-gradient(135deg,#152F49eb,#0B1D30f5 65%,#030B16fa)',border:'1px solid #36DFFF55',boxShadow:'inset 0 1px 0 #EAF4FF18',borderRadius:18});
   if(s.background==='#f6821f')s.background=SIGNAL.accent;
   if(node.type==='shader'){node.shader.colors=[SIGNAL.signal,'#5589AD',SIGNAL.text];node.shader.intensity=.22;node.shader.opacity=.65;}
   if(node.type==='slot'&&node.appearance)node.appearance.outlineColor=SIGNAL.signal;
  });
  l.root.styles.background=SIGNAL.canvas;
  const art=find('engineering-backdrop');art.assetId='signalBackdrop';art.styles={...R(p?-2050:0,0,p?3412:w,h),opacity:.72};
  const shade=find('backdrop-shade');shade.styles={...R(0,0,w,h),background:'linear-gradient(180deg,#030B1610,#030B1633 42%,#030B16d9 76%,#030B16f5)'};
  const header=find('header-rule');header.styles.background='#36DFFF33';
  const headline=find('headline');headline.styles.fontWeight=800;headline.styles.letterSpacing=p?-1.6:-2.5;
  find('pacing-fill').styles.background=SIGNAL.signal;find('pacing-meter').styles.background='#36DFFF26';
  const remove=new Set(['hero-scan']);l.root.children=n.filter(node=>!remove.has(node.id));l.animation.tracks=l.animation.tracks.filter(t=>!remove.has(t.target));
  const nodes=l.root.children;
  if(chapter==='spotlight'){
   const hero=B('tool-hero',p?72:84,p?730:480,p?936:1752,p?280:250,[T('tool-category',30,25,p?876:1692,45,V('toolCategory'),p?25:27,'#EAF4FF99'),M('tool-hero-logo',30,p?108:90,p?210:300,p?105:130,logoAsset),T('tool-name',p?275:380,p?98:90,p?625:1300,140,V('toolName'),p?74:112,SIGNAL.text,900)]);
   hero.styles.border='1px solid #FF8A2480';hero.styles.boxShadow='inset 2px 0 0 #FF8A24,inset 0 1px 0 #EAF4FF1f';
   const hi=nodes.findIndex(node=>node.id==='tool-hero');nodes[hi]=hero;
   const cli=B('tool-mark-panel',p?72:84,p?1080:780,p?936:1752,p?240:150,[T('cf-cli-caption',32,p?40:45,p?560:1230,p?145:90,p?caption:caption.replaceAll('\n',' '),p?45:43),B('cli-badge',p?650:1430,p?45:20,p?230:260,p?150:110,[M('terminal-badge-icon',p?12:15,p?52:28,45,45,'signalTerminal'),T('cf-badge',p?68:88,p?23:10,145,120,V('toolMark'),p?93:84,SIGNAL.accent,800)])]);
   cli.mask={kind:'wipe',direction:'right',progress:1};nodes[nodes.findIndex(node=>node.id==='tool-mark-panel')]=cli;
  }
  if(chapter==='why'){
   const icons=['signalCode','signalCpu','signalDatabase','signalCloud','signalSpark','signalShield'];
   for(let i=0;i<6;i++){
    const card=find('stack-'+i);if(!card)continue;const cw=Number(card.styles.width);card.children.push(M('stack-icon-'+i,24,p?35:77,p?56:64,p?56:64,icons[i]));
    const label=find('stack-label-'+i),product=find('stack-product-'+i);label.styles.left=116;label.styles.width=cw-150;product.styles.left=116;product.styles.width=cw-145;product.styles.fontSize=p?37:38;
    if(i===1){card.styles.background='linear-gradient(115deg,#152F49,#17415f 62%,#0B1D30)';card.styles.border='2px solid #36DFFF';card.styles.boxShadow='inset 0 0 24px #36DFFF20';product.styles.color=SIGNAL.text;}
   }
  }
  if(chapter==='workflow'){
   for(let i=0;i<3;i++){
    const card=find('flow-card-'+i),cw=Number(card.styles.width);card.children.push(M('flow-icon-'+i,28,p?80:128,p?52:60,p?52:60,['signalCode','signalLayers','signalBox'][i]));
    const label=find('flow-label-'+i),body=find('flow-copy-'+i);label.styles.left=116;label.styles.width=cw-145;label.styles.fontSize=p?25:22;body.styles.left=116;body.styles.width=cw-145;body.styles.fontSize=p?34:36;
    if(i===1){card.styles.background='linear-gradient(115deg,#152F49,#17415f 62%,#0B1D30)';card.styles.border='2px solid #36DFFF';card.styles.boxShadow='inset 0 0 24px #36DFFF22';}
    if(i<2){
     const line=find('flow-link-'+i),packet=find('packet-'+i),axis=p?'y':'x',start=Number(line.styles[p?'top':'left'])+6,end=Number(line.styles[p?'top':'left'])+Number(line.styles[p?'height':'width'])-16;
     line.styles.background='#36DFFF44';packet.styles.width=10;packet.styles.height=10;packet.styles.borderRadius=5;packet.styles.background=SIGNAL.signal;packet.styles.opacity=0;
     if(p)packet.styles.left=Number(line.styles.left)-3;else packet.styles.top=Number(line.styles.top)-3;
     l.animation.tracks=l.animation.tracks.filter(t=>t.target!==packet.id);
     const delay=600+i*250;
     l.animation.tracks.push({target:packet.id,property:axis,keyframes:[{atMs:0,value:start},{atMs:2400,value:end}],delayMs:delay,clock:'segment',easing:'linear',loop:'repeat'},{target:packet.id,property:'opacity',keyframes:[{atMs:0,value:0},{atMs:250,value:1},{atMs:1900,value:1},{atMs:2250,value:0},{atMs:2400,value:0}],delayMs:delay,clock:'segment',easing:'linear',loop:'repeat'});
    }
   }
  }
  if(chapter==='demo'){
   const frame=find('demo-frame');frame.styles.border='1px solid #36DFFFaa';frame.styles.boxShadow='inset 0 0 30px #36DFFF0c';
   const x=Number(frame.styles.left),y=Number(frame.styles.top),cw=Number(frame.styles.width);
   for(let i=0;i<3;i++)nodes.push({id:'terminal-dot-'+i,type:'box',styles:{...R(x+28+i*26,y+30,12,12),borderRadius:6,background:[SIGNAL.accent,SIGNAL.signal,'#EAF4FF66'][i]},children:[]});
   const label=find('demo-window-label');label.styles.left=x+140;label.styles.width=cw-170;label.styles.fontSize=p?21:25;
   const placeholder=find('demo-placeholder'),old=find('demo-code'),lines=String(doc.set.values.demoCode.default).split('\n').slice(0,3);placeholder.children=placeholder.children.filter(node=>node.id!==old.id);
   for(let i=0;i<3;i++){
    const key='demoLine'+(i+1);if(!doc.set.values[key]){doc.set.values[key]={type:'text',default:lines[i]??'',maxLength:100};doc.set.controls.push({id:key,type:'text',label:'CLI line '+(i+1),key});}
    const top=(p?30:20)+i*(p?75:55),line=T('command-line-'+i,20,top,cw-105,p?65:55,{op:'concat',args:[String(i+1)+'  ',V(key)]},p?32:38);line.styles.fontFamily='Menlo, Consolas, monospace';
    placeholder.children.push(line);
    l.animation.tracks.push({target:line.id,property:'opacity',keyframes:[{atMs:0,value:0},{atMs:350,value:1}],delayMs:300+i*420,clock:'segment',easing:'easeOut',loop:'none'});
   }
   const cursor=find('demo-cursor');cursor.styles.left=65;cursor.styles.background=SIGNAL.signal;
   const result=find('demo-result-panel');result.styles.background='#030B16cc';result.styles.border='1px solid #36DFFF33';
  }
  if(chapter==='takeaway'){
   const card=find('cta-card');card.styles.border='1px solid #36DFFF99';
   find('cta-support').styles.color=SIGNAL.text;const action=find('cta-action-box');action.styles.background='#030B16';action.styles.border='1px solid #FF8A24aa';action.styles.boxShadow='inset 0 0 20px #FF8A2410';find('cta-action').styles.color=SIGNAL.accent;
  }
  // Geometry entrances use the revised panel locations; no spring or overshoot.
  for(const track of l.animation.tracks)if(track.property==='y'&&track.loop!=='repeat'){
   const target=find(track.target);if(target&&typeof target.styles.top==='number')track.keyframes=[{atMs:0,value:target.styles.top+24},{atMs:600,value:target.styles.top}];
  }
  l.animation.transition={type:'crossfade',durationMs:300,contentDurationMs:180};
 }
 doc.set.controls=doc.set.controls.filter(c=>c.id!=='demoCode');
 for(const section of doc.set.controlArrangement.sections)section.controls=section.controls.flatMap(ref=>ref==='set:demoCode'?['set:demoLine1','set:demoLine2','set:demoLine3']:ref);
 return plan;
}
