import fs from 'node:fs';
import path from 'node:path';
import {build} from 'esbuild';
const root=process.cwd(),folder=path.join(root,'docs/shows/media/grand-arena');
const get=key=>({get:key}),eq=(a,b)=>({op:'eq',args:[a,b]}),iff=(condition,a,b)=>({op:'if',args:[condition,a,b]}),cat=(...args)=>({op:'concat',args});
const blue='#76c6ff',gold='#f2c574',white='#f4f1e9',muted='#adbac9';
const box=(id,x,y,w,h,children=[],extra={})=>({id,type:'box',styles:{position:'absolute',left:x,top:y,width:w,height:h,...extra},children});
const text=(id,value,x,y,w,h,size=28,color=white,weight=400,align='left')=>({id,type:'text',text:value,styles:{position:'absolute',left:x,top:y,width:w,height:h,fontFamily:'Arial, sans-serif',fontSize:size,fontWeight:weight,color,textAlign:align,lineHeight:1.12,overflow:'hidden'}});
const media=(id,assetId,x,y,w,h)=>({id,type:'media',assetId,fit:'fill',styles:{position:'absolute',left:x,top:y,width:w,height:h}});
// Media fit is intentionally contain/cover only in the strict package codec.
const art=(id,assetId,x,y,w,h,fit='contain')=>({...media(id,assetId,x,y,w,h),fit});
const flare=(id,x,y,w,h,color)=>({id,type:'shader',styles:{position:'absolute',left:x,top:y,width:w,height:h},shader:{effect:'borderFlare',colors:['#101924',color,'#ffffff'],speed:.32,intensity:1.2,scale:1,opacity:.75,radius:38,quality:'low',clock:'show'}});
function rig(side,g){
 const [x,y,w]=g,h=w*2/3,accent=side==='host'?blue:gold;
 const font=Math.round(w*.038);
 return box(side+'-rig',x,y,w,h,[
  box(side+'-well','5%','10.5%','90%','76%',[],{background:'#101a25',borderRadius:Math.round(w*.024)}),
  {id:side+'-camera',type:'slot',slotId:side,framing:{mode:'fill',x:.5,y:.5},appearance:{cornerRadius:Math.round(w*.024),outlineWidth:2,outlineColor:accent},styles:{position:'absolute',left:'5%',top:'10.5%',width:'90%',height:'76%'}},
  art(side+'-bezel','bezel',0,0,'100%','100%'),
  box(side+'-nameplate','6%','86.2%','88%','6.5%',[],{background:'#09111de8',borderRadius:6}),
  text(side+'-name',get('values.'+side+'Name'),'7.6%','86.6%','72%','6.5%',font,accent,700),
 ]);
}
const phases=[['faceoff','01 / Face-off','Two voices. One room. Your call.'],['host-case','02 / Blue side','Make the case. Back it up.'],['guest-case','03 / Amber side','A different perspective deserves the floor.'],['receipts','04 / Receipts','Bring the evidence into the conversation.'],['crowd-call','05 / The crowd','You heard both sides. Now make the call.'],['verdict','06 / The verdict','The room has the final word.']];
function geometry(phase,portrait){
 if(portrait){
  if(phase==='host-case')return [[45,320,990],[200,1120,680]];
  if(phase==='guest-case')return [[200,320,680],[45,970,990]];
  if(phase==='receipts'||phase==='verdict')return [[35,335,460],[585,335,460]];
  return [[75,320,930],[75,1025,930]];
 }
 if(phase==='host-case')return [[70,255,1190],[1390,500,430]];
 if(phase==='guest-case')return [[100,500,430],[660,255,1190]];
 if(phase==='receipts'||phase==='verdict')return [[70,405,500],[1350,405,500]];
 return [[100,300,760],[1060,300,760]];
}

function layout(phase,label,strap,portrait){
 const w=portrait?1080:1920,h=portrait?1920:1080,[a,b]=geometry(phase,portrait),nodes=[];
 nodes.push(art('arena-plate',portrait?'portrait':'landscape',0,0,w,h,'cover'));
 nodes.push(text('brand','HEAD TO HEAD',portrait?70:100,portrait?64:62,portrait?650:900,64,portrait?46:40,white,800));
 nodes.push(text('edition','THE GRAND ARENA',portrait?72:102,portrait?124:112,portrait?650:900,30,portrait?20:16,muted,700));
 nodes.push(text('stage-label',label,portrait?72:1320,portrait?172:76,portrait?936:500,32,portrait?19:18,gold,700,portrait?'left':'right'));
 nodes.push(text('topic',get('values.topic'),portrait?72:260,portrait?225:168,portrait?936:1400,portrait?88:104,portrait?36:44,white,700,'center'));
 nodes.push({...flare('blue-floor-light',portrait?60:100,portrait?1838:982,portrait?420:760,10,blue),shader:{...flare('x',0,0,1,1,blue).shader,effect:'lightSweep',opacity:.34,intensity:.4,speed:.12,radius:4}});
 nodes.push({...flare('amber-floor-light',portrait?600:1060,portrait?1838:982,portrait?420:760,10,gold),shader:{...flare('x',0,0,1,1,gold).shader,effect:'lightSweep',opacity:.34,intensity:.4,speed:.12,radius:4}});
 nodes.push(rig('host',a),rig('guest',b));
 if(phase==='faceoff'||phase==='crowd-call'){
  if(!portrait)nodes.push(text('versus','VS',886,487,148,86,66,gold,800,'center'));
 }
 if(phase==='host-case'||phase==='guest-case'){
  const side=phase==='host-case'?'host':'guest';
  const x=portrait?80:side==='host'?1380:100,y=portrait?1635:820,tw=portrait?920:440;
  nodes.push(text('case-kicker','THE '+(side==='host'?'BLUE':'AMBER')+' SIDE',x,y,tw,38,portrait?24:18,side==='host'?blue:gold,700));
  nodes.push(text('case-line',get('values.'+side+'Position'),x,y+(portrait?54:40),tw,portrait?125:130,portrait?40:28,white,600));
 }
 if(phase==='receipts'){
  const x=portrait?80:610,y=portrait?760:315,bw=portrait?920:700,bh=portrait?900:610;
  const board=box('receipt-board',x,y,bw,bh,[
   text('receipt-kicker','THE RECEIPTS',28,24,bw-56,36,20,gold,700),
   text('receipt-title',get('values.receiptTitle'),28,77,bw-56,portrait?110:80,portrait?38:30,white,700),
   box('evidence-well',28,portrait?220:185,bw-56,portrait?480:290,[text('receipt-empty','ADD YOUR EVIDENCE',20,portrait?205:120,bw-96,50,22,muted,700,'center')],{background:'#172738',borderRadius:16}),
   {id:'evidence-source',type:'slot',slotId:'evidence',framing:{mode:'fit',x:.5,y:.5},appearance:{cornerRadius:16},styles:{position:'absolute',left:28,top:portrait?220:185,width:bw-56,height:portrait?480:290}},
   text('receipt-source',get('values.sourceLabel'),28,portrait?735:505,bw-56,60,portrait?26:20,muted,400),
  ],{background:'#0b1422ee',borderRadius:24,border:'1px solid #65738b'});
  nodes.push(board);
 }
 if(phase==='crowd-call'||phase==='verdict'){
  const x=portrait?80:300,y=portrait?1730:858,bw=portrait?920:1320;
  nodes.push(box('audience-console',x,y,bw,portrait?126:134,[
   text('ballot-kicker',phase==='crowd-call'?'THE ROOM DECIDES':'AUDIENCE VERDICT',28,18,bw-56,32,18,gold,700),
   box('blue-vote-lane',28,63,(bw-68)/2,5,[],{background:blue}),box('amber-vote-lane',bw/2+6,63,(bw-68)/2,5,[],{background:gold}),
   text('ballot-caption',iff(get('show.revealed'),cat(get('show.total'),' CONFIRMED VOTES'),phase==='crowd-call'?'ONE PERSON. ONE VOTE.':'REVEAL WHEN YOU ARE READY.'),28,84,bw-56,32,portrait?18:17,muted,600),
  ],{background:'#0c1623ed',borderRadius:18}));
 }
 if(phase==='verdict'){
  const x=portrait?80:610,y=portrait?820:335,bw=portrait?920:700;
  nodes.push(box('verdict-board',x,y,bw,portrait?670:435,[
   text('verdict-kicker',iff(get('show.revealed'),'THE AUDIENCE HAS SPOKEN','THE VERDICT'),32,40,bw-64,45,portrait?26:19,gold,700,'center'),
   ...[['host',get('values.hostName'),eq(get('show.winner'),'Blue side')],['guest',get('values.guestName'),eq(get('show.winner'),'Amber side')],['draw','A DRAW.',eq(get('show.result'),'draw')],['pending','VERDICT PENDING',eq(get('show.revealed'),false)]].map(([id,label,when])=>({...text('winner-'+id,label,32,portrait?140:114,bw-64,portrait?310:190,portrait?82:62,white,800,'center'),when})),
   text('verdict-note',iff(get('show.revealed'),get('values.closingLine'),'Collect votes, then reveal the result.'),32,portrait?505:334,bw-64,100,portrait?32:25,muted,400,'center'),
  ],{background:'#0b1422ed',borderRadius:28,border:'1px solid #65738b'}));
 }
 if(phase==='faceoff')nodes.push(text('opening-note',strap,portrait?100:400,portrait?1740:890,portrait?880:1120,portrait?110:72,portrait?32:27,muted,400,'center'));
 const footy=portrait?1878:1028;
 nodes.push(text('show-footer',cat('BLUE ',get('values.hostScore'),'   /   AMBER ',get('values.guestScore')),portrait?80:100,footy,portrait?650:1000,32,portrait?18:17,muted,700));
 nodes.push(text('round-footer','YOUR TAKE. YOUR RECEIPTS. YOUR CALL.',portrait?80:1120,footy,portrait?920:700,30,14,muted,700,portrait?'right':'right'));
 // Stable rig IDs let native morph tracks move camera, bezel and nameplate together.
 return {id:phase+(portrait?'-portrait':'-landscape'),label:label.replace(/^\d+ \/ /,'')+' / '+(portrait?'Vertical':'Landscape'),width:w,height:h,root:{id:'stage',type:'box',styles:{position:'relative',width:w,height:h,overflow:'hidden'},children:nodes},animation:{tracks:[],transition:{type:'morph',durationMs:650}}};
}
const value=(text,maxLength=100)=>({type:'text',default:text,maxLength});
const set={initialLayout:'faceoff-landscape',values:{hostName:value('Kleveland',40),guestName:value('Challenger',40),topic:value('Does AI create more opportunity than it replaces?',120),hostPosition:value('More access. More people building.',100),guestPosition:value('Better tools. Fewer entry-level paths.',100),receiptTitle:value('Show the work. Check the source.',90),sourceLabel:value('SOURCE / Add your reference',100),closingLine:value('Different takes. A better conversation.',100),hostScore:{type:'number',default:0,min:0,max:99},guestScore:{type:'number',default:0,min:0,max:99}},feeds:{},slots:[{id:'host',label:'Blue side / Host camera'},{id:'guest',label:'Amber side / Challenger camera'},{id:'evidence',label:'Receipts / Image, video or screen'}],components:{},assets:Object.fromEntries([['landscape','arena-landscape.png'],['portrait','arena-portrait.png'],['bezel','camera-bezel.png']].map(([id,file])=>[id,{name:file,mime:'image/png',data:'data:image/png;base64,'+fs.readFileSync(path.join(folder,file)).toString('base64')}])),layouts:phases.flatMap(p=>[layout(...p,false),layout(...p,true)]),controls:[]};
set.controls=[...set.layouts.map((l,i)=>({id:'layout-'+i,type:'button',label:l.label,action:{type:'layout.select',layoutId:l.id}})),...Object.entries(set.values).map(([key,v])=>({id:'edit-'+key,type:v.type,label:key.replace(/([A-Z])/g,' $1').replace(/^./,c=>c.toUpperCase()),key})),{id:'reveal',type:'button',label:'Reveal verdict',action:{type:'show.reveal'}},{id:'reopen',type:'button',label:'Reopen ballot',action:{type:'show.reopen'}},{id:'draw',type:'button',label:'Call a draw',action:{type:'show.draw'}}];
const doc={schema:'producer.presentation/1',id:'head-to-head-grand-arena',version:'1.0.0',name:'Head to Head — The Grand Arena',set,show:{id:'grand-arena-show',version:'1.0.0',initialPhase:'faceoff',choices:[{id:'blue',label:'Blue side'},{id:'amber',label:'Amber side'}],phases:phases.map(([id,label],i)=>({id,label,layoutId:id+'-landscape',...(phases[i+1]?{next:phases[i+1][0]}:{}),...(id==='crowd-call'?{collectMs:45000}:{})}))}};
const built=await build({stdin:{contents:"export {parsePackage} from './src/features/presentation/schema'",resolveDir:root},bundle:true,platform:'node',format:'esm',write:false});
const {parsePackage}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
let parsed;try{parsed=parsePackage(doc);}catch(e){console.error(e.message);process.exit(1);}const output=path.join(root,'docs/shows/head-to-head-grand-arena.json');fs.writeFileSync(output,JSON.stringify(parsed));
console.log('Authored',parsed.name,parsed.set.layouts.length,'layouts;',Math.round(fs.statSync(output).size/1024),'KiB');
