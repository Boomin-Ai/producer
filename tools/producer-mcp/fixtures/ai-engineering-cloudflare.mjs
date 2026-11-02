import shell from './ai-engineering-essentials.mjs';
import {signalDesign} from '../signal-design.mjs';
import {stackWalkthrough} from '../stack-walkthrough.mjs';
const plan=structuredClone(shell),doc=plan.package;plan.assetRefs.push('cloudflareLogo');
const defaults={toolName:'CLOUDFLARE',toolCategory:'COMPUTE / DATA / AI / SECURITY',toolMark:'cf',spotlightTitle:'BUILD YOUR\nAI STACK.',whyTitle:'THE FULL STACK.\nONE PLATFORM.',workflowTitle:'ONE APP.\nCONNECTED LAYERS.',demoTitle:'MEET THE\nNEW cf CLI.',setupTitle:'FROM TERMINAL\nTO YOUR APP.',takeawayTitle:'GET THE\nFULL LIST.',before:'Frontend. APIs. Data.\nAI inference. Security.\nEvery app needs a stack.',after:'Cloudflare brings these\nbuilding blocks onto\none developer platform.',input:'Your frontend sends a request to a Worker.',transform:'Workers connect your logic to D1, R2 and Workers AI.',output:'Your app returns a useful answer to the user.',demoLabel:'cf / CLOUDFLARE CLI · BETA · COMMAND WALKTHROUGH',demoCode:'$ cf cli search "list my zones"\n$ cf dev\n$ cf build',demoResult:'2,900+ API commands. Typed project config. Agent-friendly search.\nIllustrative commands — cf is in beta.',step1:'Install: npm install --global cf',step2:'Sign in: cf auth login',step3:'New project: cf init',starterCode:'cf dev\ncf build\ncf deploy',takeaway:'GET THE FULL LIST\nIN MY BIO.\n\nOr comment below.',ctaSupport:'AI Engineering Essentials\nYour next tools. One complete list.',ctaAction:'COMMENT ESSENTIALS'};
for(const[key,value]of Object.entries(defaults))doc.set.values[key].default=value;
const R=(x,y,w,h)=>({position:'absolute',left:x,top:y,width:w,height:h}),V=k=>({get:'values.'+k});
const T=(id,x,y,w,h,text,size=32,color='#d5e5f1',weight=700)=>({id,type:'text',text,styles:{...R(x,y,w,h),fontFamily:'Arial, sans-serif',fontSize:size,fontWeight:weight,lineHeight:1.08,whiteSpace:'pre-wrap',overflow:'hidden',color}});
const B=(id,x,y,w,h,color,children=[],radius=16)=>({id,type:'box',styles:{...R(x,y,w,h),background:color,borderRadius:radius,overflow:'hidden'},children});
const titles={spotlight:'01 · Cloudflare',why:'02 · The full stack',workflow:'03 · An AI app',demo:'04 · The new cf CLI',setup:'05 · Get started',takeaway:'06 · Full-list CTA'};
for(const l of doc.set.layouts){
 const p=l.height>l.width,id=l.id.replace(/-(portrait|landscape)$/,''),n=l.root.children;l.label=titles[id]+(p?' · Portrait':' · Landscape');
 const find=id=>{let result;const visit=node=>{if(node.id===id)result=node;node.children?.forEach(visit);};visit(l.root);return result;};
 const replace=(id,node)=>{const i=n.findIndex(n=>n.id===id);if(i>=0)n[i]=node;};
 if(id==='spotlight'){
  replace('tool-hero',B('tool-hero',p?72:84,p?730:480,p?936:1160,p?365:400,'#112137',[B('cf-stripe',0,0,8,p?365:400,'#f6821f',[],0),T('tool-category',30,28,p?876:1100,85,V('toolCategory'),p?28:30,'#a9c9dd'),T('tool-name',28,140,p?880:1100,195,V('toolName'),p?102:125,'#eef5fa',900)]));
  const card=B('tool-mark-panel',p?72:1320,p?1180:480,p?936:516,p?370:400,'#142b43',[{id:'cloudflare-logo',type:'media',assetId:'cloudflareLogo',fit:'contain',styles:R(p?480:40,p?70:35,p?410:430,p?220:200)},T('cf-cli-caption',30,p?65:285,p?450:450,p?240:100,p?'ONE CLI.\nTHE\nPLATFORM.':'ONE CLI.\nTHE PLATFORM.',p?45:36,'#d5e5f1',800)]);card.mask={kind:'wipe',direction:'right',progress:1};replace('tool-mark-panel',card);
 }
 if(id==='why'){
  const remove=new Set(['before-card','after-card','change-arrow']);l.root.children=n.filter(node=>!remove.has(node.id));l.animation.tracks=l.animation.tracks.filter(t=>!remove.has(t.target));
  const layers=[['FRONTEND','Workers Static Assets'],['COMPUTE','Workers'],['DATABASE','D1'],['OBJECT STORAGE','R2'],['AI INFERENCE','Workers AI'],['SECURITY','Access / WAF']];
  layers.forEach(([label,product],i)=>{const x=p?72:84+(i%3)*594,y=p?730+i*142:490+Math.floor(i/3)*220,cw=p?936:564,ch=p?124:195;const card=B('stack-'+i,x,y,cw,ch,'#112137',[T('stack-label-'+i,24,18,cw-48,35,label,p?23:24,'#829eb4',800),T('stack-product-'+i,24,p?62:85,cw-48,p?55:90,product,p?39:43,i===1?'#f6a55d':'#d5e5f1',800)]);l.root.children.push(card);for(const[property,from,to]of [['opacity',0,1],['y',y+24,y]])l.animation.tracks.push({target:card.id,property,keyframes:[{atMs:0,value:from},{atMs:550,value:to}],delayMs:100+i*110,clock:'segment',easing:'easeOut',loop:'none'});});
 }
 if(id==='workflow')for(const[i,label]of ['FRONTEND','WORKER + BINDINGS','RESPONSE'].entries())find('flow-label-'+i).text='0'+(i+1)+' / '+label;
 if(id==='demo'){
  const code=find('demo-code');code.styles.fontFamily='Menlo, Consolas, monospace';code.styles.fontSize=p?35:43;
  const result=find('demo-result');result.styles.fontSize=p?32:29;
 }
 if(id==='setup'){
  find('starter-label').text='PROJECT COMMANDS / NEW cf PROJECT';find('starter-code').styles.fontFamily='Menlo, Consolas, monospace';find('starter-code').styles.fontSize=p?36:43;
  l.root.children.push(T('cli-note',p?72:84,p?1620:940,p?936:1752,50,'cf is in beta. Existing Wrangler projects: migrate first.',p?23:25,'#829eb4',500));
 }
 if(id==='takeaway'){
  const main=find('takeaway-main');main.styles.fontSize=p?57:66;
  find('cta-action').styles.fontSize=p?44:39;
 }
}
export default stackWalkthrough(signalDesign(plan,{logoAsset:'cloudflareLogo',cliCaption:'ONE CLI.\nTHE PLATFORM.'}));
