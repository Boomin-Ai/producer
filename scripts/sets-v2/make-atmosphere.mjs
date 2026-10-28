import fs from 'node:fs';
import {build} from 'esbuild';
import {atmosphereWorld} from '../scene3d/make-atmosphere.mjs';
process.on('uncaughtException',e=>{console.error(e.message);process.exit(1);});
const built=await build({stdin:{contents:"export {parsePackage} from './src/features/presentation/schema';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false});
const {parsePackage}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
const ink='#f6f8fa',muted='#c5d7e4',gold='#f2d3a5',ice='#bdeaf1';
const get=get=>({get}),eq=(a,b)=>({op:'eq',args:[a,b]}),iff=(a,b,c)=>({op:'if',args:[a,b,c]}),cat=(...args)=>({op:'concat',args});
const field=k=>get('modules.sky.'+k),view=field('view'),weekly=eq(view,'week'),hourly=eq(view,'hourly');
const rect=(left,top,width,height)=>({position:'absolute',left,top,width,height});
const text=(id,value,x,y,w,h,size=28,color=ink,weight=500,styles={})=>({id,type:'text',text:value,styles:{...rect(x,y,w,h),fontFamily:'Arial, sans-serif',fontSize:size,fontWeight:weight,color,lineHeight:1.15,overflow:'hidden',...styles}});
const box=(id,x,y,w,h,children=[],styles={})=>({id,type:'box',styles:{...rect(x,y,w,h),...styles},children});
const glass={background:'linear-gradient(125deg,#23374ee8,#101b2de8)',border:'1px solid #e9c783bb',borderRadius:26,boxShadow:'inset 0 1px 0 #fff5d54d,0 0 18px #eec47b33'};
// Keep moving panels as units. Descendants remain batchable graphics; native
// placement tracks move the panel without re-rasterizing or scaling camera video.
function graphicsSurface(nodes){
 const units=new Set(['forecast-panel','camera-caption','headline','forecast-navigation']);
 const flatten=node=>{
  if(node.type!=='box'||node.mask||node.backdrop||units.has(node.id))return {...node,...(node.children?{children:node.children.map(flatten)}:{})};
  const {children,...leaf}=node;return {...leaf,type:'text',text:node.text??''};
 };
 return nodes.map(flatten);
}
const sky={label:'Weather desk',state:{hourPage:{type:'number',default:0,min:0,max:3}},publicFields:['hourPage'],views:['now','today','hourly','week'],initialView:'now',actions:{},controls:[{id:'forecast',label:'Forecast',audience:'operator',controls:[]}],capabilities:['data.weather@1'],behavior:{type:'weather',integrationRole:'weather'}};
for(const [id,label]of [['now','Now'],['today','Today'],['hourly','Hourly'],['week','7 day']]){sky.actions[id]={roles:['operator'],steps:[{op:'view',view:id}]};sky.controls[0].controls.push({id,label,type:'button',action:id});}
for(const [id,label,next]of [['previousHours','Previous hours',{op:'if',args:[{op:'eq',args:[{read:'local.hourPage'},0]},3,{op:'add',args:[{read:'local.hourPage'},-1]}]}],['nextHours','Next hours',{op:'if',args:[{op:'eq',args:[{read:'local.hourPage'},3]},0,{op:'add',args:[{read:'local.hourPage'},1]}]}]]){sky.actions[id]={roles:['operator'],steps:[{op:'set',field:'hourPage',value:next}]};sky.controls[0].controls.push({id,label,type:'button',action:id});}
const studio={label:'Camera composition',state:{},publicFields:[],views:['hero','split','presenter'],initialView:'hero',actions:{},controls:[{id:'framing',label:'Choose a composition',audience:'operator',controls:[]}],capabilities:[]};
for(const [id,label]of [['hero','Hero'],['split','Split'],['presenter','Presenter']]){studio.actions[id]={roles:['operator'],steps:[{op:'view',view:id}]};studio.controls[0].controls.push({id,label,type:'button',action:id});}
const assets=Object.fromEntries(['day','night'].map(id=>[id,{name:'observatory-'+id+'.png',mime:'image/png',data:'data:image/png;base64,'+fs.readFileSync('docs/shows/media/atmosphere-observatory/observatory-'+id+'.png').toString('base64')}]));
const poses=['hero','split','presenter'],layouts=[];
const metricNow=[['FEELS LIKE','feelsLikeLabel','°'],['WIND','windLabel','≋'],['RAIN CHANCE','rainChanceLabel','☂'],['HUMIDITY','humidityLabel','%'],['UV INDEX','uvLabel','☀'],['SUNRISE','sunriseLabel','↗'],['SUNSET','sunsetLabel','↘']];
const metricToday=[['HIGH','highLabel','↗'],['LOW','lowLabel','↘'],['RAIN CHANCE','rainChanceLabel','☂'],['SUNRISE','sunriseLabel','☀'],['SUNSET','sunsetLabel','☾'],['UV INDEX','uvLabel','◌'],['WIND','windLabel','≋']];
const hour=(i,suffix)=>iff(eq(field('hourPage'),0),field('hour'+i+suffix),iff(eq(field('hourPage'),1),field('hour'+(i+6)+suffix),iff(eq(field('hourPage'),2),field('hour'+(i+12)+suffix),field('hour'+(i+18)+suffix))));
for(const pose of poses)for(const p of [false,true]){
 const w=p?1080:1920,h=p?1920:1080;
 const camera=p?{hero:[44,425,992,670],split:[44,155,992,670],presenter:[44,1110,992,670]}[pose]:{hero:[112,170,450,800],split:[1358,170,450,800],presenter:[912,170,960,800]}[pose];
 const headline=p?{hero:[48,142],split:[48,860],presenter:[48,142]}[pose]:[pose==='hero'?690:64,158];
 const panel=p?{hero:[44,1140,992,640],split:[44,1140,992,640],presenter:[44,425,992,640]}[pose]:{hero:[690,448,1166,494],split:[260,448,1000,494],presenter:[64,448,754,494]}[pose];
 const [cx,cy,cw,ch]=camera,[hx,hy]=headline,[px,py,pw,ph]=panel;
 const headlineWidth=p?920:pose==='presenter'?620:pw;
 const children=[{id:'environment-day',type:'media',assetId:'day',fit:'cover',styles:rect(0,0,w,h),when:field('isDay')},{id:'environment-night',type:'media',assetId:'night',fit:'cover',styles:rect(0,0,w,h),when:iff(field('isDay'),false,true)},box('readability',0,0,w,h,[],{background:'linear-gradient(180deg,#07101c33,#06101c08 45%,#07101c55)'}),{id:'architecture',type:'scene3d',styles:rect(0,0,w,h),scene3d:{id:'atmosphere',pass:'foreground',world:atmosphereWorld(p),cue:field('weatherCue'),view:get('modules.studio.view')}}];
 for(const condition of ['rain','snow','cloudy'])children.splice(3,0,{id:'weather-'+condition,type:'shader',when:condition==='rain'?iff(eq(field('condition'),'rain'),true,eq(field('condition'),'storm')):condition==='cloudy'?iff(eq(field('condition'),'cloudy'),true,eq(field('condition'),'fog')):eq(field('condition'),condition),styles:rect(0,0,w,h),shader:{effect:condition==='cloudy'?'clouds':condition,colors:['#24394a','#aacada','#f0f8fc'],speed:.24,intensity:.55,scale:1,opacity:condition==='cloudy'?.10:.24,radius:0,quality:'medium',clock:'show'}});
 children.push({...box('header-glass',40,28,w-80,p?120:108,[],{background:'linear-gradient(120deg,#0c1728c9,#21324a99)',border:'1px solid #e9c783bb',borderRadius:24,boxShadow:'inset 0 1px 0 #fff5d544,0 0 14px #eec47b33'}),mask:{kind:'rounded',radius:24},backdrop:{blur:12}});
 children.push(text('brand','A T M O S P H E R E',p?68:76,p?46:46,p?800:1000,54,p?33:29,ink,700),text('strapline','LIVE CONDITIONS / REAL CONSEQUENCES',p?70:78,p?104:92,p?850:1000,32,p?17:16,muted,500,{letterSpacing:3}));
 children.push(text('updated',cat(iff(eq(field('dataStatus'),'fresh'),'UPDATED ',iff(eq(field('dataStatus'),'stale'),'LAST UPDATE ','DATA / ')),iff(eq(field('dataStatus'),'empty'),'WAITING',field('updatedLabel'))),p?610:1430,p?54:64,p?360:390,30,p?17:16,muted,600,{textAlign:'right'}));
 children.push(box('headline',hx,hy,headlineWidth,288,[
  text('location',field('locationShort'),0,0,headlineWidth,58,p?40:37,ink,500),
  text('temperature',field('temperatureLabel'),-4,60,p?800:headlineWidth,158,p?142:140,ink,500,{letterSpacing:-5,textShadow:'0 2px 12px #07101c55'}),
  text('condition',field('conditionLabel'),0,222,headlineWidth,50,p?37:32,ink,500),
  text('weather-symbol',field('conditionSymbol'),p?810:headlineWidth-116,86,100,110,p?90:82,gold,400,{textAlign:'center'})]));
 children.push({id:'host-camera',type:'slot',slotId:'host',styles:rect(cx,cy,cw,ch),appearance:{cornerRadius:26,outlineWidth:3,outlineColor:'#e9c783'},framing:{mode:'fill',x:.5,y:.5}},box('camera-caption',cx+22,cy+20,p?360:Math.min(360,cw-44),44,[text('host-dot','●',15,12,22,26,16,gold,600),text('host-name',get('values.hostName'),43,9,p?294:Math.min(294,cw-104),30,p?22:19,ink,600)],{background:'linear-gradient(110deg,#172338e8,#263a4bbd)',border:'1px solid #e7d6b466',borderRadius:22}));
 const cardNodes=[text('panel-heading',iff(eq(view,'now'),'RIGHT NOW',iff(eq(view,'today'),"TODAY'S FORECAST",iff(hourly,'THE NEXT HOURS','YOUR WEEK AHEAD'))),26,22,pw-52,36,p?24:20,ink,700,{letterSpacing:2})];
 const gap=p?14:12,inner=pw-44,col=(inner-gap)/2,gridHeight=p?124:92,rowHeight=p?76:59,start=p?76:65;
 for(let i=0;i<7;i++){
  const label=iff(weekly,field('day'+i+'Day'),iff(hourly,i<6?hour(i,'Time'):'SUNSET',iff(eq(view,'today'),metricToday[i][0],metricNow[i][0])));
  const main=iff(weekly,cat(field('day'+i+'High'),'  /  ',field('day'+i+'Low')),iff(hourly,i<6?hour(i,'Temperature'):field('sunsetLabel'),iff(eq(view,'today'),field(metricToday[i][1]),field(metricNow[i][1]))));
  const sub=iff(weekly,cat(field('day'+i+'Condition'),'  ·  ',field('day'+i+'Rain'),' rain'),iff(hourly,i<6?cat(hour(i,'Rain'),' rain chance'):'Local time',i===0?iff(eq(view,'today'),'Daily maximum','Apparent temperature'):''));
  const symbol=iff(weekly,field('day'+i+'Symbol'),iff(hourly,i<6?hour(i,'Symbol'):'☾',iff(eq(view,'today'),metricToday[i][2],metricNow[i][2])));
  const left=iff(weekly,22,22+(i%2)*(col+gap)),top=iff(weekly,start+i*rowHeight,start+Math.floor(i/2)*(gridHeight+gap)),cardWidth=iff(weekly,inner,col),cardHeight=iff(weekly,rowHeight-7,gridHeight);
  // Text-backed panels batch as graphics and follow the one authored parent
  // morph, keeping camera changes below the native animation-track budget.
  cardNodes.push(text('card-bg-'+i,'',left,top,cardWidth,cardHeight,1,ink,400,{background:'linear-gradient(115deg,#728ba138,#17283b66)',border:'1px solid #cedbe83d',borderRadius:p?18:14}));
  const gridX=22+(i%2)*(col+gap),gridY=start+Math.floor(i/2)*(gridHeight+gap),weekY=start+i*rowHeight;
  cardNodes.push(text('card-label-'+i,label,iff(weekly,38,gridX+14),iff(weekly,weekY+(p?19:12),gridY+12),iff(weekly,p?140:90,col-50),p?30:25,p?21:16,muted,600));
  cardNodes.push(text('card-value-'+i,main,iff(weekly,p?305:178,gridX+14),iff(weekly,weekY+(p?15:10),gridY+(p?48:35)),iff(weekly,p?300:170,col-24),p?48:39,p?36:29,ink,600,{letterSpacing:-.7}));
  cardNodes.push(text('card-sub-'+i,sub,iff(weekly,p?610:357,gridX+14),iff(weekly,weekY+(p?20:13),gridY+(p?98:67)),iff(weekly,p?310:inner-357,col-24),p?28:22,p?18:13,muted,400));
  cardNodes.push(text('card-icon-'+i,symbol,iff(weekly,p?205:120,gridX+col-46),iff(weekly,weekY+(p?11:4),gridY+12),48,p?50:40,p?38:30,gold,400,{textAlign:'center'}));
 }
 for(const node of cardNodes)if(node.id.startsWith('card-'))node.when=iff(hourly,false,true);
 const chart=(id,kind,data,x,y,width,height,color,extra={})=>({id,type:'chart',when:hourly,styles:rect(x,y,width,height),chart:{id,kind,data:field(data),color,gridColor:'#b9cee222',durationMs:650,lineWidth:3,fillOpacity:.22,timeZone:field('timezoneLabel'),...extra}});
 cardNodes.push({...text('chart-range',field('chartRangeLabel'),pw-390,25,360,24,p?18:14,muted,500,{textAlign:'right'}),when:hourly},
 {...text('temperature-legend','TEMPERATURE',64,p?70:66,pw-100,26,p?20:15,gold,700,{letterSpacing:1.4}),when:hourly},
 chart('hourly-temperature','area','temperatureChart',10,p?104:92,pw-28,p?280:210,gold,{unit:field('temperatureUnit')}),
 {...text('rain-legend','RAIN PROBABILITY',64,p?400:326,pw-100,26,p?20:15,ice,700,{letterSpacing:1.4}),when:hourly},
 chart('hourly-rain','bar','rainChart',10,p?432:352,pw-28,p?154:114,ice,{unit:'%',yMin:0,yMax:100}));
 children.push(box('forecast-panel',px,py,pw,ph,cardNodes,glass));
 const verticalTabs=!p&&pose==='split';
 const tabY=verticalTabs?py:p?1812:990,tabW=verticalTabs?164:p?242:210,tabStart=p?48:64;
 const tabs=[];
 tabs.push(text('tabs-surface','',0,0,verticalTabs?164:p?984:888,verticalTabs?ph:p?62:54,1,ink,400,{background:'linear-gradient(100deg,#1b2c40e8,#101e32d9)',border:'1px solid #d8b87999',borderRadius:26,boxShadow:'inset 0 1px 0 #fff3cf44,0 0 10px #f0c68022'}));
 for(const [i,[id,label]]of [['now','NOW'],['today','TODAY'],['hourly','HOURLY'],['week','7 DAY']].entries())tabs.push(text('tab-'+id,label,verticalTabs?8:i*tabW+8,verticalTabs?20+i*112:8,verticalTabs?148:tabW-4,verticalTabs?94:p?46:38,p?20:17,iff(eq(view,id),ink,muted),600,{textAlign:'center',background:iff(eq(view,id),'linear-gradient(110deg,#cda864cc,#a98b5c66)','#00000000'),borderRadius:20,padding:verticalTabs?'36px 8px':p?10:8}));
 children.push(box('forecast-navigation',tabStart,tabY,verticalTabs?164:p?984:888,verticalTabs?ph:p?62:54,tabs));
 children.push(text('source-credit',field('sourceLabel'),48,p?1882:1048,p?984:1500,27,p?15:14,muted,400));
 layouts.push({id:pose+'-'+(p?'portrait':'landscape'),label:pose[0].toUpperCase()+pose.slice(1)+' · '+(p?'Portrait':'Landscape'),width:w,height:h,animation:{tracks:[],transition:{type:'morph',durationMs:760,contentDurationMs:260}},root:{id:'observatory',type:'box',styles:{position:'relative',width:w,height:h,overflow:'hidden',background:'#10263b'},children:graphicsSurface(children)}});
}
const runtime={schema:'producer.modules/1',definitions:{sky,studio},instances:['sky','studio'].map(id=>({id,definition:id,owner:'set',hidden:'continue',onExit:'continue',reenter:'resume'}))};
const raw={schema:'producer.presentation/2',requires:['mask@1','backdrop@1','chart@1'],id:'atmosphere',version:'2.2.0',name:'Atmosphere',runtime,set:{viewController:'studio',initialView:'hero',views:Object.fromEntries(poses.map(pose=>[pose,{landscape:pose+'-landscape',portrait:pose+'-portrait'}])),initialLayout:'hero-landscape',assets,values:{hostName:{type:'text',default:'Host',maxLength:60}},feeds:{},slots:[{id:'host',label:'Host camera'}],components:{},layouts,controls:[{id:'host-name',type:'text',label:'Host name',key:'hostName'}]}};
const doc=parsePackage(raw);fs.writeFileSync('docs/shows/atmosphere.json',JSON.stringify(doc));console.log('Authored Atmosphere observatory: six compositions, four forecast views, standalone modules.');
