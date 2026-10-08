import fs from 'node:fs';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

const bundle=await build({stdin:{contents:"export {RehearsalSession} from './src/features/presentation/rehearsal';export {outputProjection} from './src/features/presentation/projection';",resolveDir:process.cwd()},bundle:true,platform:'browser',format:'esm',write:false});
const {RehearsalSession,outputProjection}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const ink='#f2f5ef',mint='#b9e5ca',muted='#a8bec3';
const get=path=>({get:path}),v=key=>get(`values.${key}`),eq=(a,b)=>({op:'eq',args:[a,b]}),pick=(condition,a,b)=>({op:'if',args:[condition,a,b]}),concat=(...args)=>({op:'concat',args});
const box=(id,x,y,w,h,background,children=[])=>({id,type:'box',styles:{position:'absolute',left:x,top:y,width:w,height:h,background,borderRadius:16},children});
const text=(id,x,y,w,size,content,color=ink)=>({id,type:'text',text:content,styles:{position:'absolute',left:x,top:y,width:w,fontSize:size,fontWeight:700,lineHeight:1.12,color}});
const media=(id,x,y,w,h,assetId)=>({id,type:'media',assetId,fit:'contain',styles:{position:'absolute',left:x,top:y,width:w,height:h}});
const shader=(id,x,y,w,h,effect,colors,opacity=1)=>({id,type:'shader',styles:{position:'absolute',left:x,top:y,width:w,height:h},shader:{effect,colors,speed:.22,intensity:.8,scale:.3,opacity,radius:24,quality:'low',clock:'show'}});
const track=(target,property,a,b,ms=1200,loop='none',clock='segment')=>({target,property,keyframes:[{atMs:0,value:a},{atMs:ms,value:b}],easing:'easeInOut',loop,clock});
const asset=(name,mime,file,playback)=>({name,mime,data:`data:${mime};base64,${fs.readFileSync(file).toString('base64')}`,...(playback?{playback}:{})});
const fixed=k=>({a:0,k});
const transform={ty:'tr',p:fixed([0,0]),a:fixed([0,0]),s:fixed([100,100]),r:fixed(0),o:fixed(100),sk:fixed(0),sa:fixed(0)};
const lottie={v:'5.7.4',fr:30,ip:0,op:90,w:120,h:120,nm:'Orbit mark',ddd:0,assets:[],layers:[{
 ddd:0,ind:1,ty:4,nm:'Orbit',sr:1,
 ks:{o:fixed(100),r:{a:1,k:[{t:0,s:[0],e:[360],i:{x:[.67],y:[1]},o:{x:[.33],y:[0]}},{t:90,s:[360]}]},p:fixed([60,60,0]),a:fixed([0,0,0]),s:fixed([100,100,100])},
 shapes:[
  {ty:'gr',it:[{ty:'el',p:fixed([0,0]),s:fixed([72,72])},{ty:'st',c:fixed([.72,.9,.79,1]),o:fixed(100),w:fixed(3),lc:2,lj:2},transform]},
  {ty:'gr',it:[{ty:'el',p:fixed([36,0]),s:fixed([14,14])},{ty:'fl',c:fixed([.72,.9,.79,1]),o:fixed(100),r:1},transform]},
 ],ip:0,op:90,st:0,bm:0,
}]};

function layout(phase,p){
 const poll=phase==='audience',w=p?720:1280,h=p?1280:720;
 const cold=shader('cool-atmosphere',0,0,w,h,'aurora',['#071723','#254c65','#79a6ac']);cold.when=pick(v('warm'),false,true);
 const warm=shader('warm-atmosphere',0,0,w,h,'aurora',['#161922','#664e60','#b6a48b']);warm.when=v('warm');
 const cameras=p?(poll?[{x:40,y:382,w:308,h:280},{x:372,y:382,w:308,h:280}]:[{x:40,y:396,w:308,h:354},{x:372,y:396,w:308,h:354}]):(poll?[{x:40,y:118,w:264,h:222},{x:40,y:410,w:264,h:222}]:[{x:572,y:116,w:312,h:340},{x:916,y:116,w:324,h:340}]);
 const c=[cold,warm,shader('camera-glow',cameras[0].x-4,cameras[0].y-4,cameras[0].w+8,cameras[0].h+8,'edgeGlow',['#071723','#477f7f',mint],.7),shader('soft-light',0,70,w,h-120,'lightSweep',['#071723','#31535f','#78938a'],.12)];
 const add=(...nodes)=>c.push(...nodes);
 const label=(id,x,y,ww,content)=>{const n=text(id,x,y,ww,14,content,mint);n.styles.letterSpacing=1.5;if(id==='eyebrow')n.motion={durationMs:6000,property:'opacity',from:.7,to:1};add(n);};
 add(box('top-rule',40,72,w-80,1,'#6a898e'),text('masthead',40,28,w-80,18,'JSON / UI LAB',mint),text('segment',p?480:1000,30,p?200:240,14,poll?'02 / AUDIENCE LAB':'01 / MOTION STUDIO',muted));
 add(box('footer-rule',40,h-48,w-80,1,'#6a898e'),text('footer',40,h-30,w-80,13,'TWO SEGMENTS / EVERY LAYER IN JSON',muted));
 for(const [i,g]of cameras.entries()){
  add({id:i?'guest-camera':'host-camera',type:'slot',slotId:i?'guest':'host',framing:{mode:'fill',x:.5,y:.5},appearance:{shape:pick(v('roundCameras'),'circle','rectangle'),cornerRadius:24,outlineWidth:v('outlineWidth'),outlineColor:mint,opacity:v('cameraOpacity'),grayscale:v('grayscale')},styles:{position:'absolute',left:g.x,top:g.y,width:g.w,height:g.h}},
   {...text(`name-${i}`,g.x,g.y+g.h+16,g.w,p?22:21,v(i?'guestName':'hostName')),when:v('showNames')});
 }
 const tracks=[track('camera-glow','shader.intensity',.4,1,5000,'pingpong','show'),track('cool-atmosphere','shader.scale',.25,.45,12000,'pingpong','show'),track('warm-atmosphere','shader.intensity',.65,1,9000,'pingpong','show')];
 if(!poll){
  const x=40,titleY=p?120:130,titleW=p?640:480;
  label('eyebrow',x,p?98:106,titleW,'CAMERAS / GRAPHICS / MOTION / MEDIA');
  add(text('title',x,titleY,titleW,p?70:78,'MAKE IT.'),text('title-accent',x,titleY+(p?78:86),titleW,p?70:78,v('headline'),mint),text('subtitle',x,p?294:328,titleW,p?25:27,v('subtitle')));
  tracks.push(track('title','x',70,40,900),track('title-accent','opacity',.25,1,1100));
  const tileY=p?816:432,tileW=p?200:148;
  for(const [i,[assetId,caption]]of [['mark','PNG IMAGE'],['orbit','LOTTIE'],['mark','KEYFRAMES']].entries()){
   const tx=40+i*(tileW+20);add(box(`tile-${i}`,tx,tileY,tileW,p?124:116,'rgba(7,22,27,0.78)'),media(`tile-media-${i}`,tx+48,tileY+10,tileW-96,64,assetId));label(`tile-label-${i}`,tx+14,tileY+88,tileW-20,caption);
  }
  tracks.push(track('tile-media-2','rotation',0,360,6000,'repeat'),track('tile-media-2','scale',.85,1.1,1500,'pingpong'),track('tile-media-2','y',tileY+10,tileY+18,1500,'pingpong'));
  const host=cameras[0];tracks.push(track('host-camera','x',host.x+16,host.x,1400),track('host-camera','width',host.w-16,host.w,1400),track('host-camera','height',host.h-12,host.h,1400));
  const sy=p?996:550,sx=p?40:572,sw=p?308:312,sh=p?172:118,vx=p?372:916,vw=p?308:324;
  add({...box('screen-card',sx,sy,sw,sh,'#142f36',[text('screen-placeholder',20,28,sw-40,22,'PROJECT SCREEN'),text('screen-note',20,64,sw-40,16,'Assign a screen or camera.',muted)]),when:v('showScreen')},
   {id:'screen-source',type:'slot',slotId:'screen',when:v('showScreen'),framing:{mode:'fit',x:.5,y:.5},appearance:{cornerRadius:14,outlineWidth:1,outlineColor:mint},styles:{position:'absolute',left:sx,top:sy,width:sw,height:sh}},
   box('video-card',vx,sy,vw,sh,'#142f36'),media('embedded-video',vx,sy,vw,sh,'clip'));
  label('screen-caption',sx,sy-28,sw,'NATIVE SCREEN SOURCE');label('video-caption',vx,sy-28,vw,'EMBEDDED VIDEO');
  const fx=p?40:40,fy=p?1182:578,fw=p?640:488;
  add({id:'feed-card',type:'component',component:'feedBadge',props:{headline:get('feeds.headline'),level:v('level')},styles:{position:'absolute',left:fx,top:fy,width:fw,height:p?38:78}});
  tracks.push(track('subtitle','opacity',.65,1,2400,'pingpong'));
 }else{
  const x=p?40:344,ww=p?640:896;
  label('eyebrow',x,p?104:120,ww,'AUDIENCE / INPUT / STATE / REVEAL');
  add(text('title',x,p?148:164,ww,p?44:52,v('question')));
  const cy=p?748:320,cw=p?640:432,ch=p?106:132;
  for(const [i,name]of ['Creative tools','Guest rooms'].entries()){
   const xx=p?40:x+i*464,yy=p?cy+i*124:cy;
   add(box(`choice-${i}`,xx,yy,cw,ch,'rgba(7,22,27,0.78)',[text(`choice-number-${i}`,20,20,50,30,i?'B':'A',mint),text(`choice-name-${i}`,88,22,cw-108,p?28:32,name),text(`choice-detail-${i}`,88,66,cw-108,16,i?'Bring more people into the room.':'Make more expressive things.',muted)]));
  }
  const my=p?1020:508,mx=p?40:344,mw=p?308:400;
  add(box('vote-card',mx,my,mw,p?170:158,'rgba(7,22,27,0.78)',[text('votes-label',20,18,mw-40,14,'VOTES / ACCEPTED',mint),text('votes-total',20,52,mw-40,64,get('show.total')),text('timer',p?128:180,102,mw-148,14,concat(get('show.remainingMs'),' ms left'),muted)]));
  const rx=p?372:776,rw=p?308:464;
  add(box('result-card',rx,my,rw,p?170:158,'rgba(7,22,27,0.78)',[text('result-label',20,18,rw-40,14,pick(get('show.revealed'),'RESULT / REVEALED','RESULT / WAITING'),mint),text('result-text',20,56,rw-40,p?24:30,pick(get('show.revealed'),concat('Result: ',get('show.result'),' / ',get('show.winner')),'Vote, close, then reveal.')),text('reaction-label',20,p?132:124,rw-40,14,'REACTION HEAT',muted)]));
  add({...box('reaction-meter',rx+rw-72,my+(p?132:122),48,12,mint),styles:{...box('temp',0,0,1,1,mint).styles,left:rx+rw-72,top:my+(p?132:122),width:48,height:12,opacity:get('show.heat')}});
  tracks.push(track('reaction-meter','scale',.9,1.1,900,'pingpong'),track('title','opacity',.4,1,900));
 }
 return {id:`${phase}-${p?'portrait':'landscape'}`,label:`${poll?'Audience Lab':'Motion Studio'} · ${p?'Portrait':'Landscape'}`,width:w,height:h,root:{id:`${phase}-${p?'p':'l'}-root`,type:'box',styles:{position:'relative',width:w,height:h,background:'#071723',overflow:'hidden'},children:c},animation:{transition:{type:'crossfade',durationMs:700},tracks}};
}
const fields={hostName:['Kleveland Bishop',32],guestName:['Guest / co-host',32],headline:['MOVE.',12],subtitle:['A living broadcast, made with JSON.',64],question:['What should we build next?',60]};
const values=Object.fromEntries(Object.entries(fields).map(([key,[def,maxLength]])=>[key,{type:'text',default:def,maxLength}]));
Object.assign(values,{warm:{type:'boolean',default:false},roundCameras:{type:'boolean',default:false},showNames:{type:'boolean',default:true},showScreen:{type:'boolean',default:true},grayscale:{type:'number',default:0,min:0,max:1},cameraOpacity:{type:'number',default:1,min:.2,max:1},outlineWidth:{type:'number',default:2,min:0,max:8},level:{type:'number',default:7,min:0,max:10}});
const controls=Object.keys(fields).map(key=>({id:`edit-${key}`,type:'text',label:({hostName:'Host name',guestName:'Guest name',headline:'Accent headline',subtitle:'Studio description',question:'Audience question'})[key],key}));
for(const [key,label]of [['grayscale','Camera grayscale (0–1)'],['cameraOpacity','Camera opacity (0.2–1)'],['outlineWidth','Camera outline (0–8)'],['level','Demo level (0–10)']])controls.push({id:`edit-${key}`,type:'number',key,label});
for(const [key,a,b]of [['warm','Cool color wash','Warm color wash'],['roundCameras','Rectangle cameras','Circle cameras'],['showNames','Hide names','Show names'],['showScreen','Hide screen','Show screen']])for(const [value,label]of [[false,a],[true,b]])controls.push({id:`${key}-${value}`,type:'button',label,action:{type:'value.set',key,value}});
for(const phase of ['motion','audience'])for(const orientation of ['landscape','portrait'])controls.push({id:`view-${phase}-${orientation}`,type:'button',label:`${phase==='motion'?'Studio':'Audience'} · ${orientation}`,when:eq(get('show.phase'),phase),action:{type:'layout.select',layoutId:`${phase}-${orientation}`}});
controls.push({id:'reveal',type:'button',label:'Reveal result',action:{type:'show.reveal'}});
const doc={schema:'producer.presentation/1',id:'json-ui-test',version:'1.1.0',name:'JSON UI Test — Motion & Audience',set:{initialLayout:'motion-landscape',values,feeds:{headline:{type:'text',default:'LIVE DATA / SAMPLE FEED',maxLength:60}},slots:[{id:'host',label:'Host camera'},{id:'guest',label:'Guest / second host'},{id:'screen',label:'Project screen'}],components:{feedBadge:{props:{headline:'LIVE DATA',level:7},root:{id:'badge-root',type:'box',styles:{position:'relative',width:'100%',height:'100%',background:'rgba(7,22,27,0.78)',borderRadius:12},children:[text('badge-copy',14,10,450,15,concat(get('props.headline'),' / LEVEL ',get('props.level')),mint)]}}},assets:{mark:asset('Boomin mark / PNG','image/png','docs/shows/assets/boomin-mark.png'),orbit:{name:'Orbit mark / Lottie',mime:'application/lottie+json',data:'data:application/lottie+json;base64,'+Buffer.from(JSON.stringify(lottie)).toString('base64'),playback:{start:'entry',loop:true,exit:'pause',return:'resume',hostControls:false}},clip:asset('Motion clip / embedded video','video/webm','docs/shows/assets/ui-test-motion.webm',{start:'manual',loop:true,exit:'reset',return:'restart',hostControls:true})},layouts:['motion','audience'].flatMap(phase=>[layout(phase,false),layout(phase,true)]),controls},show:{id:'json-ui-test-show',version:'1.1.0',initialPhase:'motion',choices:[{id:'tools',label:'Creative tools'},{id:'rooms',label:'Guest rooms'}],phases:[{id:'motion',label:'Motion Studio',layoutId:'motion-landscape',next:'audience'},{id:'audience',label:'Audience Lab',layoutId:'audience-landscape',collectMs:30000}]}};
doc.set.tokens={ink:'#f2f5ef',mint:'#b9e5ca',muted:'#a4b5ad',displayFont:'Avenir Next, Avenir, Helvetica Neue, sans-serif',bodyFont:'Helvetica Neue, Arial, sans-serif'};
doc.set.styles={display:{fontFamily:{get:'tokens.displayFont'},fontWeight:800,letterSpacing:-1.5,textShadow:'0px 2px 18px rgba(0,0,0,0.18)'},body:{fontFamily:{get:'tokens.bodyFont'},fontWeight:500},eyebrow:{fontFamily:{get:'tokens.bodyFont'},fontWeight:700,letterSpacing:2,textTransform:'uppercase'}};
const design=n=>{if(n.type==='text'){n.styleId=n.styles.fontSize>=40?'display':n.styles.fontSize<=16?'eyebrow':'body';delete n.styles.fontWeight;for(const key of ['ink','mint','muted'])if(n.styles.color===doc.set.tokens[key])n.styles.color={get:`tokens.${key}`};}n.children?.forEach(design);};
doc.set.layouts.forEach(l=>{design(l.root);const glow=box('material-light',l.width-230,24,180,150,'linear-gradient(135deg, rgba(185,229,202,0.16), rgba(75,120,180,0.08))');glow.styles={...glow.styles,filter:'blur(16px)',mixBlendMode:'screen',clipPath:'ellipse(48% 42% at 50% 50%)'};l.root.children.splice(4,0,glow);});Object.values(doc.set.components).forEach(c=>design(c.root));
let session;try{session=new RehearsalSession(doc);}catch(e){console.error(e.message);process.exit(1);}
assert.equal(session.package.show.phases.length,2);
session.send({type:'control',action:{type:'show.start'}});
for(const control of controls.filter(c=>c.type==='button'&&c.action.type==='value.set'))assert.equal(session.send({type:'control',action:control.action}),true);
session.send({type:'control',action:{type:'show.next'}});
session.send({type:'vote',playerId:'first',choiceId:'tools'});session.send({type:'vote',playerId:'second',choiceId:'tools'});session.send({type:'vote',playerId:'third',choiceId:'rooms'});
session.send({type:'reaction',playerId:'first'});session.send({type:'tick',milliseconds:30000});session.send({type:'control',action:{type:'show.reveal'}});
assert.equal(session.snapshot().show.winner,'Creative tools');assert.equal(session.snapshot().show.total,3);
for(const l of doc.set.layouts){session.send({type:'control',action:{type:'layout.select',layoutId:l.id}});assert.equal(outputProjection(session.package,session.snapshot()).width,l.width);}
const file='docs/shows/json-ui-test.show.json';const encoded=JSON.stringify(session.package,null,2);
fs.writeFileSync(file,encoded);fs.writeFileSync('/Users/klevelandbishop/Documents/boomin/docs/shows/json-ui-test.show.json',encoded);
console.log(`Saved ${file}: two segments, four layouts, ${controls.length} controls, three embedded assets. PASS controls, voting, reactions, reveal and all output projections.`);
