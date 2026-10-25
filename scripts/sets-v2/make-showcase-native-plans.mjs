import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const out=process.argv[2]??'/private/tmp/producer-showcase-v2-native-plans';fs.mkdirSync(out,{recursive:true});for(const file of fs.readdirSync(out))if(/^(head-to-head-grand-arena|decision-room|open-floor|atmosphere|just-facts)-.*\.json$/.test(file))fs.unlinkSync(path.join(out,file));
const {chromium}=await import('/private/tmp/producer-sets-v2-browser/node_modules/playwright-core/index.mjs');
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 const page=await browser.newPage();await page.goto('http://127.0.0.1:1436/');
 await page.evaluate(async()=>{window.Session=(await import('/src/features/presentation/rehearsal.ts')).RehearsalSession;window.project=(await import('/src/features/presentation/projection.ts')).outputProjection;window.compile=(await import('/src/features/sets-v2/roomCompiler.ts')).compileRoomScene;});
 const answer=JSON.parse(fs.readFileSync('/private/tmp/producer-just-facts-managed-answer.json','utf8')).result;
 for(const id of ['head-to-head-grand-arena','decision-room','open-floor','atmosphere','just-facts']){
  const layouts=await page.evaluate(async({id,answer})=>{
   window.doc=await(await fetch('/docs/shows/'+id+'.json')).json();window.s=new window.Session(window.doc);
   if(id==='just-facts'){await window.s.sendModule('research','start');await window.s.sendModule('research','agent.embed',{question:answer.question,response:answer.response,citations:JSON.stringify(answer.citations)});await window.s.sendModule('research','agent.show');}
   if(id==='atmosphere'){const m=window.s.moduleSnapshot();window.s.receiveModuleData({id:'native-weather',setEpoch:m.setEpoch,module:'sky',epoch:m.modules.sky.epoch,op:'weather.update',input:{observedAt:Date.now(),temperature:13,condition:'rain',isDay:false,wind:19,precipitation:4,provider:'Native visual test',location:'Atlanta',units:'celsius'}});}
   return window.doc.set.layouts.map(l=>l.id);
  },{id,answer});
  for(const layout of layouts){
   const result=await page.evaluate(async layout=>{
    const p=window.project(window.doc,{...window.s.snapshot(),layoutId:layout});const result=await window.compile(p,{definitionId:window.doc.id,instanceId:'showcase-v2-proof',canvasId:layout,target:{id:p.width>p.height?'program':'portrait',orientation:p.width>p.height?'landscape':'portrait',width:p.width,height:p.height,scaling:'contain'},bindings:{host:'synthetic-camera',guest:'synthetic-camera',guest1:'synthetic-camera',guest2:'synthetic-camera',evidence:'synthetic-camera'}});
    const issues=[];let count=0;const walk=n=>{count++;if(n.bounds.width<=0||n.bounds.height<=0)issues.push(n.id);n.children.forEach(walk);};walk(result.root);return {plan:result,issues,count};
   },layout);
   assert.deepEqual(result.issues,[],id+'/'+layout);fs.writeFileSync(path.join(out,id+'-'+layout+'.json'),JSON.stringify(result.plan));
  }
  const variants=id==='atmosphere'?['snow','cloudy']:id==='decision-room'?['revealed']:id==='open-floor'?['featured']:[];
  for(const variant of variants){
   await page.evaluate(async({id,variant})=>{
    const s=window.s;
    if(id==='atmosphere'){const m=s.moduleSnapshot();s.receiveModuleData({id:'weather-'+variant,setEpoch:m.setEpoch,module:'sky',epoch:m.modules.sky.epoch,op:'weather.update',input:{observedAt:Date.now(),temperature:variant==='snow'?-4:14,condition:variant,isDay:true,wind:12,precipitation:2,provider:'Native visual test',location:'Atlanta',units:'celsius'}});}
    if(id==='decision-room'){for(const op of ['start','publish','open'])await s.sendModule('decision',op);for(const [name,choice]of [['one','opportunity'],['two','opportunity'],['three','depends']])await s.sendModule('decision','vote',{choice,round:1},name);for(const op of ['close','reveal'])await s.sendModule('decision',op);}
    if(id==='open-floor'){for(const op of ['start','publish','open'])await s.sendModule('questions',op);await s.sendModule('questions','submit',{round:1,name:'Audience contributor',text:('What changes when the audience can ask a better question, compare the evidence, and challenge the assumptions? ').repeat(5).slice(0,500)},'viewer');await s.sendModule('questions','approve',{item:'item-1-r1'});await s.sendModule('questions','feature',{item:'item-1-r1'});}
   },{id,variant});
   for(const portrait of [false,true]){
    const result=await page.evaluate(async({id,portrait})=>{const layout=(id==='atmosphere'?'view0':'view1')+(portrait?'-portrait':'-landscape'),p=window.project(window.doc,{...window.s.snapshot(),layoutId:layout});return window.compile(p,{definitionId:window.doc.id,instanceId:'showcase-module-state',canvasId:layout,target:{id:portrait?'portrait':'program',orientation:portrait?'portrait':'landscape',width:p.width,height:p.height,scaling:'contain'},bindings:{host:'synthetic-camera',guest:'synthetic-camera'}});},{id,portrait});
    fs.writeFileSync(path.join(out,id+'-'+variant+(portrait?'-portrait':'-landscape')+'.json'),JSON.stringify(result));
   }
  }
  console.log('PASS native compilation',id,layouts.length,'layouts');
 }
}finally{await browser.close();}
