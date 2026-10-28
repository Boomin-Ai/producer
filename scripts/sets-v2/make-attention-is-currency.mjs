import fs from 'node:fs';
import {build} from 'esbuild';
const built=await build({stdin:{contents:"export {parsePackage} from './src/features/presentation/schema';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false});
const {parsePackage}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
const cream='#fff4d9',red='#ff382e',ink='#000000';
const get=get=>({get}),value=k=>get('values.'+k);
const rect=(left,top,width,height)=>({position:'absolute',left,top,width,height});
const text=(id,content,x,y,w,h,size=30,extra={})=>({id,type:'text',text:content,styles:{...rect(x,y,w,h),fontFamily:'Arial, sans-serif',fontSize:size,fontWeight:700,lineHeight:1.02,color:ink,overflow:'hidden',...extra}});
const box=(id,x,y,w,h,styles={})=>text(id,'',x,y,w,h,1,styles);
const slot=(id,slotId,x,y,w,h)=>({id,type:'slot',slotId,framing:{mode:'fill',x:.5,y:.5},styles:rect(x,y,w,h)});
const assets=Object.fromEntries(['spotify','apple','youtube'].map(id=>[id,{name:id+'.png',mime:'image/png',data:'data:image/png;base64,'+fs.readFileSync('docs/shows/media/attention-is-currency/logos/'+id+'-black.png').toString('base64')}]));
const fields={hostName:['KLEVELAND',40],headline:['THE COST OF',40],headlineAccent:['ATTENTION',32],coverLine:['OWN YOUR ATTENTION',70],category:['MONEY / CULTURE / MUSIC',70],issue:['VOL. 01',24],referenceTitle:['THE CONVERSATION',80],referenceCaption:['Add your image or video source to the Reference slot.',120],growthDate:['TODAY / MANUAL SNAPSHOT',60]};
for(const id of ['threads','instagram','linkedin','youtube','tiktok','x'])fields[id]=['NOT CONNECTED',40];
const layouts=[];
for(const mode of ['cover','reference','growth'])for(const portrait of [true,false]){
 const w=portrait?1080:1920,h=portrait?1920:1080;
 const nodes=[box('base',0,0,w,h,{background:cream}),slot('host-camera','host',0,0,w,h)];
 if(mode!=='cover'){
  nodes[1]=slot('host-camera','host',portrait?48:1120,portrait?460:170,portrait?984:720,portrait?660:810);
 }
 nodes.push(box('readability',0,0,w,h,{background:'transparent'}));
 nodes.push(box('cover-border',20,20,w-40,h-40,{border:'3px solid '+ink}));
 // Identity and all cover typography stay independent from the native camera.
 nodes.push(text('masthead','ATTN',48,portrait?145:32,portrait?800:680,portrait?330:260,portrait?338:260,{fontFamily:'Impact, Arial Narrow, sans-serif',fontWeight:400,letterSpacing:-10}));
 nodes.push(text('subtitle','IS CURRENCY',48,portrait?470:285,portrait?650:520,90,portrait?83:65,{fontFamily:'Impact, Arial Narrow, sans-serif',fontWeight:400,letterSpacing:-1}));
 for(const [i,id]of ['spotify','apple','youtube'].entries())nodes.push({id:'logo-'+id,type:'media',assetId:id,fit:'contain',styles:rect((portrait?710:585)+i*76,portrait?479:290,64,64)});
 nodes.push(box('on-air-bg',portrait?48:1645,portrait?75:55,154,44,{background:red}),text('on-air','ON AIR',portrait?61:1658,portrait?83:63,130,32,28,{letterSpacing:3}),text('issue',value('issue'),portrait?680:1645,portrait?85:113,portrait?260:190,34,25,{letterSpacing:3,textAlign:'right'}));
 if(mode==='cover'){
  nodes.push(text('cover-line',value('coverLine'),48,portrait?650:428,portrait?290:440,portrait?270:190,portrait?68:65,{fontFamily:'Impact, Arial Narrow, sans-serif',fontWeight:400,color:red,lineHeight:1.03}));
  nodes.push(text('categories',value('category'),52,portrait?950:640,portrait?240:400,180,portrait?25:22,{letterSpacing:4,lineHeight:1.5}));
  nodes.push(text('headline',value('headline'),portrait?60:540,portrait?1400:760,portrait?870:1210,portrait?135:100,portrait?111:94,{fontFamily:'Georgia, Times New Roman, serif',fontStyle:'italic',letterSpacing:-3}));
  nodes.push(text('headline-accent',value('headlineAccent'),portrait?48:530,portrait?1525:858,portrait?890:1250,portrait?182:130,portrait?140:118,{fontFamily:'Georgia, Times New Roman, serif',fontStyle:'italic',letterSpacing:-5,color:red}));
 }else if(mode==='reference'){
  nodes.push(box('reference-well',48,portrait?1170:440,portrait?984:1010,portrait?440:500,{background:cream,border:'1px solid #00000066'}));
  nodes.push(slot('reference-source','reference',portrait?64:64,portrait?1186:456,portrait?952:978,portrait?408:468));
  nodes.push(text('reference-title',value('referenceTitle'),48,portrait?1640:365,portrait?880:1020,portrait?100:65,portrait?64:55,{fontFamily:'Impact, Arial Narrow, sans-serif',fontWeight:400}));
  nodes.push(text('reference-caption',value('referenceCaption'),48,portrait?1750:961,portrait?880:1010,portrait?65:50,portrait?26:23,{fontWeight:400,lineHeight:1.2}));
 }else{
  nodes.push(text('growth-title','BUILDING IN PUBLIC',48,portrait?1164:375,portrait?900:1020,80,portrait?64:60,{fontFamily:'Impact, Arial Narrow, sans-serif',fontWeight:400}));
  nodes.push(text('growth-date',value('growthDate'),48,portrait?1242:455,portrait?900:1000,40,24,{letterSpacing:3}));
  ['threads','instagram','linkedin','youtube','tiktok','x'].forEach((id,i)=>{
   const x=48+(i%2)*(portrait?490:510),y=(portrait?1310:520)+Math.floor(i/2)*(portrait?132:142);
   nodes.push(box('metric-bg-'+id,x,y,portrait?466:485,112,{background:'#f5e7c6',border:'1px solid #00000055'}));
   nodes.push(text('metric-name-'+id,id.toUpperCase(),x+18,y+14,420,28,22,{letterSpacing:3}));
   nodes.push(text('metric-value-'+id,value(id),x+18,y+52,420,48,32));
  });
 }
 nodes.push(text('host-credit',{op:'concat',args:['WITH ',value('hostName')]},48,portrait?1778:1010,portrait?880:1750,44,portrait?24:22,{textAlign:'center',letterSpacing:5}));
 // Reference captions occupy the lower safe area; the credit is redundant there.
 if(mode==='reference')nodes.pop();
 layouts.push({id:mode+'-'+(portrait?'portrait':'landscape'),label:(mode==='cover'?'Magazine cover':mode==='reference'?'Topic / reference':'Daily growth')+' · '+(portrait?'Portrait':'Landscape'),width:w,height:h,root:{id:'stage',type:'box',styles:{position:'relative',width:w,height:h,overflow:'hidden',background:cream},children:nodes},animation:{tracks:[],transition:{type:'morph',durationMs:650,contentDurationMs:180}}});
}
const doc=parsePackage({schema:'producer.presentation/2',id:'attention-is-currency',version:'1.0.1',name:'Attention Is Currency',set:{initialLayout:'cover-portrait',initialView:'cover',views:Object.fromEntries(['cover','reference','growth'].map(id=>[id,{portrait:id+'-portrait',landscape:id+'-landscape'}])),assets,values:Object.fromEntries(Object.entries(fields).map(([id,[v,maxLength]])=>[id,{type:'text',default:v,maxLength}])),feeds:{},slots:[{id:'host',label:'Host camera'},{id:'reference',label:'Topic image / video'}],components:{},layouts,controls:Object.keys(fields).map(key=>({id:key,type:'text',label:({hostName:'Host name',headline:'Topic headline',headlineAccent:'Topic headline / accent',coverLine:'Cover line',category:'Cover categories',issue:'Issue',referenceTitle:'Reference title',referenceCaption:'Reference caption / source',growthDate:'Growth snapshot / date'})[key]??key[0].toUpperCase()+key.slice(1)+' / followers and daily change',key}))}});
fs.writeFileSync('docs/shows/attention-is-currency.json',JSON.stringify(doc));
console.log('Authored Attention Is Currency: six layouts; native camera, reference source, editable cover and honest manual growth inputs.');
