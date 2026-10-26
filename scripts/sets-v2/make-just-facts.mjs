process.on('uncaughtException',error=>{console.error(error.message);process.exit(1);});
import fs from 'node:fs';
import {build} from 'esbuild';
const built=await build({stdin:{contents:"export {parsePackage} from './src/features/presentation/schema';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false});
const {parsePackage}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
const questions=[
 'A four-day workweek is always more productive than five days.',
 'Humans use only 10% of their brains.',
 'Lightning never strikes the same place twice.',
 'Electric vehicles produce no emissions over their entire lifetime.',
 'The Moon is moving farther away from Earth.',
 'Antibiotics can treat a common cold.',
 'Water always boils at 100°C.',
 'A day on Venus lasts longer than a year on Venus.',
 'More megapixels always mean a better camera.',
 'AI-generated answers are always backed by verifiable sources.',
 'Sound travels faster through water than through air.',
];
const ink='#f5f7f7',muted='#9aa6ac',mint='#72ebc5',red='#ef727d',night='#070d10';
const get=get=>({get}),eq=(a,b)=>({op:'eq',args:[a,b]}),iff=(a,b,c)=>({op:'if',args:[a,b,c]}),concat=(...args)=>({op:'concat',args});
const read=read=>({read}),test=(field,value)=>({op:'eq',args:[read('local.'+field),value]}),choose=(c,a,b)=>({op:'if',args:[c,a,b]});
const textField=(value,maxLength=120)=>({type:'text',default:value,maxLength}),numberField=()=>({type:'number',default:0,min:0,max:11});
const box=(id,x,y,w,h,styles={})=>({id,type:'box',styles:{position:'absolute',left:x,top:y,width:w,height:h,...styles},children:[]});
const text=(id,content,x,y,w,h,size=30,color=ink,weight=500,style={})=>({id,type:'text',text:content,styles:{position:'absolute',left:x,top:y,width:w,height:h,fontFamily:'Arial, sans-serif',fontSize:size,fontWeight:weight,color,lineHeight:1.16,overflow:'hidden',...style}});
const panel=(id,x,y,w,h)=>box(id,x,y,w,h,{background:'linear-gradient(135deg,#151e21,#090e11)',border:'1px solid #344247',borderRadius:24});
const phase=i=>i===0?'question':i===10?'tiebreaker':'question'+String(i+1).padStart(2,'0');
const moduleId=i=>i===0?'research':'research'+String(i+1).padStart(2,'0');
const score={label:'Host / round decisions',state:{scoreA:numberField(),scoreB:numberField(),champion:textField('pending',12)},publicFields:[],actions:{},controls:[{id:'match-score',label:'Match score',audience:'operator',controls:[{id:'scoreA',type:'readout',label:'Guest A points',field:'scoreA'},{id:'scoreB',type:'readout',label:'Guest B points',field:'scoreB'}]}],capabilities:[]};
const runtime={schema:'producer.modules/1',definitions:{scoreboard:score},instances:[{id:'scoreboard',definition:'scoreboard',owner:'set',hidden:'continue',onExit:'continue',reenter:'resume'}]};
for(let i=0;i<questions.length;i++){
 const tag='q'+(i+1),a=tag+'A',b=tag+'B',award=tag+'Winner',truth=tag+'Truth',segment=phase(i);
 Object.assign(score.state,{[a]:textField('unanswered',12),[b]:textField('unanswered',12),[award]:textField('none',12),[truth]:textField('pending',12)});
 const button=(id,label,action)=>({id,label,type:'button',action,segment});
 const options=[{id:'unanswered',label:'Not answered'},{id:'true',label:'TRUE'},{id:'false',label:'FALSE'}];
 const controls=[{id:tag+'answerA',label:'Guest A says',type:'choice',field:a,options,segment},{id:tag+'answerB',label:'Guest B says',type:'choice',field:b,options,segment},{id:tag+'truth',label:'Host verdict',type:'choice',field:truth,options:[{id:'pending',label:'Pending / not decided'},{id:'true',label:'TRUE'},{id:'false',label:'FALSE'},{id:'uncertain',label:'Inconclusive'}],segment}];
 for(const side of ['A','B','none']){
  const action='award'+tag+side;
  score.actions[action]={roles:['operator'],steps:[{op:'add',field:'scoreA',value:side==='A'?choose(test(award,'A'),0,1):choose(test(award,'A'),-1,0)},{op:'add',field:'scoreB',value:side==='B'?choose(test(award,'B'),0,1):choose(test(award,'B'),-1,0)},{op:'set',field:award,value:side},{op:'set',field:'champion',value:'pending'}]};
  controls.push(button(action,side==='none'?'Clear round award':'Award point to Guest '+side,action));
 }
 if(i>=9)for(const side of ['A','B','draw']){
  const action='champion'+side;score.actions[action]={roles:['operator'],steps:[{op:'set',field:'champion',value:side}]};controls.push(button(tag+action,side==='draw'?'Declare a draw':'Declare Guest '+side+' champion',action));
 }
 score.controls.push({id:tag,label:i===10?'Optional tie-breaker':i===9?'Question 10 / final question':'Question '+(i+1),audience:'operator',controls});
 const id=moduleId(i),definition='factCheck'+String(i+1).padStart(2,'0');
 runtime.definitions[definition]={label:i===10?'Tie-breaker / fact-check':'Question '+String(i+1).padStart(2,'0')+' / fact-check',state:{},publicFields:[],views:['question','evidence'],initialView:'question',actions:{questionView:{roles:['operator'],steps:[{op:'view',view:'question'}]},evidenceView:{roles:['operator'],steps:[{op:'view',view:'evidence'}]}},controls:[{id:'presentation',label:'Presentation',audience:'operator',controls:[{id:'questionView',type:'button',label:'Question view',action:'questionView'},{id:'evidenceView',type:'button',label:'Fact-check view',action:'evidenceView'}]}],capabilities:['data.agent@1'],behavior:{type:'agent',integrationRole:'research',initialQuestion:questions[i],prompt:'Fact-check this statement with primary sources. Give a short assessment, evidence, uncertainty and citations. The host decides the round winner; do not award points or invent a verdict.',mode:'factCheck',maxLength:16000,researchView:'evidence',showView:'evidence'}};
 runtime.instances.push({id,definition,owner:'segment',segment,hidden:'continue',onExit:'pause',reenter:'resume'});
}
score.publicFields=Object.keys(score.state);
const assets=Object.fromEntries(['landscape','portrait'].map(o=>[o,{name:'studio-'+o+'.png',mime:'image/png',data:'data:image/png;base64,'+fs.readFileSync('docs/shows/media/just-facts/studio-'+o+'.png').toString('base64')}]));
const layouts=[];
const pick=fn=>{
 const member=indices=>indices.length===1?eq(get('show.phase'),phase(indices[0])):iff(member(indices.slice(0,Math.ceil(indices.length/2))),true,member(indices.slice(Math.ceil(indices.length/2))));
 const branch=indices=>indices.length===1?fn(indices[0]):iff(member(indices.slice(0,Math.ceil(indices.length/2))),branch(indices.slice(0,Math.ceil(indices.length/2))),branch(indices.slice(Math.ceil(indices.length/2))));
 return branch(questions.map((_,i)=>i));
};
for(const portrait of [false,true]){
 const i=0;
 const w=portrait?1080:1920,h=portrait?1920:1080,id=moduleId(i),f=field=>pick(n=>get('modules.'+moduleId(n)+'.'+field)),s=field=>field.startsWith('q1')?pick(n=>get('modules.scoreboard.q'+(n+1)+field.slice(2))):get('modules.scoreboard.'+field),compact=eq(f('view'),'evidence'),v=(a,b)=>iff(compact,b,a),tag='q'+(i+1);
 const nodes=[box('base',0,0,w,h,{background:night}),{id:'warm-studio',type:'media',assetId:portrait?'portrait':'landscape',fit:'cover',styles:{position:'absolute',left:0,top:0,width:w,height:h,opacity:.13}},box('shade',0,0,w,h,{background:'linear-gradient(180deg,#050b0d44,#050a0df5)'}),text('brand','JUST FACTS',portrait?210:44,portrait?38:28,portrait?660:640,portrait?80:70,portrait?68:57,ink,900,{textAlign:portrait?'center':'left',letterSpacing:-3}),box('live-dot',portrait?48:1550,portrait?69:52,12,12,{background:red,borderRadius:6}),text('live-label','HOST-LED',portrait?76:1576,portrait?58:40,230,38,portrait?22:20,muted,700),text('round-label',pick(n=>n===10?'TIE-BREAKER':String(n+1).padStart(2,'0')+' / 10'),portrait?840:1760,portrait?58:40,portrait?190:120,42,portrait?24:22,ink,700,{textAlign:'right'})];
 function camera(slot,label,x,y,cw,ch,accent){
  nodes.push(box(slot+'-well',x,y,cw,ch,{background:'#10191d',borderRadius:22}),{id:slot+'-camera',type:'slot',slotId:slot,framing:{mode:'fill',x:.5,y:.5},appearance:{cornerRadius:22,outlineWidth:1,outlineColor:accent},styles:{position:'absolute',left:x,top:y,width:cw,height:ch}},box(slot+'-badge',typeof x==='number'?x+18:x,typeof y==='number'?y+18:iff(compact,y.args[1]+18,y.args[2]+18),portrait?170:150,44,{background:'#080f12dd',border:'1px solid '+accent,borderRadius:14}),text(slot+'-name',get('values.'+slot+'Name'),typeof x==='number'?x+34:x,typeof y==='number'?y+27:iff(compact,y.args[1]+27,y.args[2]+27),portrait?240:250,36,portrait?23:20,ink,700));
 }
 if(portrait){camera('host','HOST',32,140,1016,v(590,360),'#4b595e');camera('guest1','GUEST A',32,v(746,516),500,v(420,260),mint);camera('guest2','GUEST B',548,v(746,516),500,v(420,260),red);}
 else{camera('host','HOST',40,128,940,454,'#4b595e');camera('guest1','GUEST A',40,598,462,268,mint);camera('guest2','GUEST B',518,598,462,268,red);}
 const sx=portrait?32:40,sy=portrait?v(1182,792):884,sw=portrait?1016:940,sh=portrait?164:156;
 nodes.push(panel('score-strip',sx,sy,sw,sh),text('score-kicker',iff(eq(s('champion'),'pending'),'HOST AWARDS THE POINTS','FINAL RESULT'),sx+28,portrait?v(1202,812):904,sw-56,30,portrait?21:18,muted,700));
 // The score ribbon reports host-awarded points, never fabricated audience percentages.
 const ribbonY=portrait?v(1237,847):936;
 nodes.push(text('score-a',concat(get('values.guest1Name'),'  ',s('scoreA')),sx+28,ribbonY,sw/2-42,70,portrait?42:36,mint,800),text('score-b',concat(s('scoreB'),'  ',get('values.guest2Name')),sx+sw/2,ribbonY,sw/2-28,70,portrait?42:36,red,800,{textAlign:'right'}),text('champion',iff(eq(s('champion'),'A'),concat(get('values.guest1Name'),' WINS'),iff(eq(s('champion'),'B'),concat(get('values.guest2Name'),' WINS'),iff(eq(s('champion'),'draw'),'DRAW',pick(n=>n===10?'OPTIONAL / PLAY IF SCORES ARE TIED':'ONE POINT PER QUESTION')))),sx+28,portrait?v(1310,920):1002,sw-56,28,portrait?19:17,muted,600,{textAlign:'center'}));
 const qx=portrait?32:1012,qy=portrait?v(1362,972):128,qw=portrait?1016:868,qh=portrait?v(526,916):908;
 nodes.push(panel('question-panel',qx,qy,qw,qh),text('question-kicker',pick(n=>n===10?'TIE-BREAKER / TRUE OR FALSE':'QUESTION '+String(n+1).padStart(2,'0')+' / TRUE OR FALSE'),qx+28,portrait?v(1394,994):160,qw-56,34,portrait?22:20,muted,700),text('headline',f('questionDisplay'),qx+28,portrait?v(1446,1044):v(225,213),qw-56,portrait?v(245,138):v(370,116),portrait?v(62,38):v(58,34),ink,800,{lineHeight:1.08,letterSpacing:-1}));
 const ey=portrait?1200:363,eh=portrait?506:456;
 nodes.push({...box('evidence-board',qx+28,ey,qw-56,eh,{background:'#0b1418',border:'1px solid #34464c',borderRadius:16}),when:compact},{...text('evidence-kicker',iff(f('hasAnswer'),'EVIDENCE / RESPONSE','FACT-CHECK / PRIVATE UNTIL REVEALED'),qx+48,ey+18,qw-96,30,portrait?20:18,mint,700),when:compact},{...text('evidence',iff(f('hasAnswer'),f('answer'),'Research the claim, review the evidence, then choose Show response. The host decides the verdict.'),qx+48,ey+66,qw-96,eh-86,portrait?28:25,ink,500,{lineHeight:1.25}),when:compact},{...text('citations',f('sources'),qx+28,portrait?1718:829,qw-56,30,portrait?18:16,muted,400),when:compact});
 const cy=portrait?v(1732,1770):876,cw=(qw-72)/2,ch=portrait?v(128,90):130;
 for(const [choice,index,accent]of [['true',0,mint],['false',1,red]]){
  const x=qx+28+index*(cw+16),verdict=s(tag+'Truth'),names=pick(n=>{const a=get('modules.scoreboard.q'+(n+1)+'A'),b=get('modules.scoreboard.q'+(n+1)+'B');return concat(iff(eq(a,choice),get('values.guest1Name'),''),iff(eq(a,choice),iff(eq(b,choice),' + ',''),''),iff(eq(b,choice),get('values.guest2Name'),''));});
  nodes.push(box('answer-'+choice,x,cy,cw,ch,{background:choice==='true'?'linear-gradient(135deg,#103b30,#0b1717)':'linear-gradient(135deg,#3b1b24,#191014)',border:concat('1px solid ',accent),borderRadius:22}),text('answer-'+choice+'-label',choice==='true'?'✓  TRUE':'×  FALSE',x+18,portrait?v(1750,1785):894,cw-36,50,portrait?v(39,30):36,accent,800,{textAlign:'center'}),text('answer-'+choice+'-guests',names,x+14,portrait?v(1810,1826):952,cw-28,36,portrait?22:20,ink,600,{textAlign:'center'}));
 }
 nodes.push(box('verdict-pill',qx+qw/2-(portrait?158:140),portrait?v(1702,1746):852,portrait?316:280,44,{background:'#202b31',border:'1px solid #627179',borderRadius:18}),text('verdict-label',pick(n=>{const truth=get('modules.scoreboard.q'+(n+1)+'Truth');return iff(eq(truth,'pending'),'AWAITING HOST VERDICT',iff(eq(truth,'true'),'VERDICT / TRUE',iff(eq(truth,'false'),'VERDICT / FALSE','INCONCLUSIVE')));}),qx+qw/2-(portrait?150:132),portrait?v(1715,1759):865,portrait?300:264,28,portrait?17:15,ink,700,{textAlign:'center'}));
 layouts.push({id:'view'+i+(portrait?'-portrait':'-landscape'),label:'Show studio · '+(portrait?'Portrait':'Landscape'),width:w,height:h,root:{id:'stage',type:'box',styles:{position:'relative',width:w,height:h,overflow:'hidden',background:night},children:nodes}});
}
const raw={schema:'producer.presentation/2',id:'just-facts',version:'2.0.0',name:'Just Facts',runtime,set:{initialLayout:'view0-landscape',assets,values:{title:textField('Real questions. Evidence. Your verdict.',120),hostName:textField('HOST',40),guest1Name:textField('GUEST A',40),guest2Name:textField('GUEST B',40)},feeds:{},slots:[{id:'host',label:'Host / Moderator camera'},{id:'guest1',label:'Guest A camera'},{id:'guest2',label:'Guest B camera'}],components:{},layouts,controls:[{id:'host-name',type:'text',label:'Host name',key:'hostName'},{id:'guest-a-name',type:'text',label:'Guest A name',key:'guest1Name'},{id:'guest-b-name',type:'text',label:'Guest B name',key:'guest2Name'}]},show:{id:'just-facts-show',version:'2.0.0',initialPhase:phase(0),choices:[],phases:questions.map((q,i)=>({id:phase(i),label:i===10?'TB / Tie-breaker (optional)':String(i+1).padStart(2,'0')+' / '+(i===9?'Final question':'Question'),layoutId:'view0-landscape',...(i<10?{next:phase(i+1)}:{})}))}};
let doc;try{doc=parsePackage(raw);}catch(error){for(const layout of raw.set.layouts)for(const node of layout.root.children){try{parsePackage({...raw,set:{...raw.set,layouts:raw.set.layouts.map(l=>({...l,root:{...l.root,children:l===layout?[node]:[]}}))}});}catch(e){console.error('Invalid node',node.id,e.message);}}throw error;}
fs.writeFileSync('docs/shows/just-facts.json',JSON.stringify(doc));
console.log('Authored Just Facts 2.0:',doc.show.phases.length,'segments,',doc.set.layouts.length,'layouts; host-awarded scores and isolated fact-checks');
