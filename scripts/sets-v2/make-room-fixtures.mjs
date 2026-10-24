import fs from 'node:fs';import path from 'node:path';
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'/private/tmp/producer-sets-v2-browser/node_modules/playwright-core/index.mjs');
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 const page=await browser.newPage();await page.goto('http://127.0.0.1:1436/');
 const files=['src/features/presentation/fixtures/head-to-head.json','src/features/presentation/fixtures/signal-desk.json','/Users/klevelandbishop/Documents/boomin/docs/shows/atlanta-culture.json'];
 const folder=process.env.PRODUCER_ROOM_FIXTURES??'/private/tmp/producer-sets-v2-room-fixtures';fs.mkdirSync(folder,{recursive:true});let count=0;
 for(const file of files){
  const doc=JSON.parse(fs.readFileSync(file,'utf8'));
  for(const layout of doc.set.layouts){
   const plan=await page.evaluate(async({doc,layout})=>{
    const {RehearsalSession}=await import('/src/features/presentation/rehearsal.ts');
    const {outputProjection}=await import('/src/features/presentation/projection.ts');
    const {compileRoomScene}=await import('/src/features/sets-v2/roomCompiler.ts');
    const session=new RehearsalSession(doc,undefined,'prepare');
    const snapshot={...session.snapshot(),layoutId:layout.id};
    const projection=outputProjection(doc,snapshot);projection.revision=1;
    return compileRoomScene(projection,{definitionId:doc.id,instanceId:'audited-room',canvasId:layout.id,target:{id:layout.height>layout.width?'portrait':'program',orientation:layout.height>layout.width?'portrait':'landscape',width:layout.height>layout.width?720:1280,height:layout.height>layout.width?1280:720,scaling:'contain'},bindings:Object.fromEntries(doc.set.slots.map(s=>[s.id,'synthetic-camera']))});
   },{doc,layout});
   fs.writeFileSync(path.join(folder,`${doc.id}-${layout.id}.json`),JSON.stringify(plan,null,2));count++;
   const zero=[];const visit=n=>{if(n.bounds.width===0||n.bounds.height===0)zero.push(n.id);n.children.forEach(visit);};visit(plan.root);
   console.log(doc.name,layout.id,'resources',plan.resources.length,'zero-sized',zero.length);
  }
 }
 console.log('Compiled',count,'real room layouts through the native graph compiler');
}finally{await browser.close();}
