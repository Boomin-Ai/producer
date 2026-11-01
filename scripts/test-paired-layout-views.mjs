import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'playwright-core');
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1400,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:1436/');
 const doc=process.env.PRODUCER_PAIR_TEST_SET?JSON.parse(await readFile(process.env.PRODUCER_PAIR_TEST_SET,'utf8')):null;
 await page.evaluate(async doc=>{
  const R=(await import('/node_modules/.vite/deps/react.js')).default,D=await import('/node_modules/.vite/deps/react-dom_client.js');
  const panelURL='/src/features/presentation/SetControlsPanel.tsx';
  const source=await(await fetch(panelURL)).text();
  const {RehearsalSession}=await import(source.match(/from "([^"]*rehearsal\.ts[^"]*)"/)[1]);
  const {OutputSettings}=await import('/src/features/presentation/OutputSettings.tsx');
  const {SetControlsPanel}=await import(panelURL),{useRoomOutput}=await import('/src/features/sets-v2/useRoomOutput.ts');
  const {ipc}=await import('/src/lib/ipc.ts');
  const {layoutViews,outputLayout}=await import('/src/features/presentation/layoutViews.ts');
  if(!doc){
   const {AFTER_HOURS}=await import('/src/features/presentation/fixtures.ts');doc=structuredClone(AFTER_HOURS);delete doc.show;
   doc.set.values={moneyTitle:{type:'text',default:'Make money with AI',maxLength:120},moneySupport:{type:'text',default:'Useful services for real clients',maxLength:120}};doc.set.controls=[];doc.set.slots=[];doc.set.assets={};
   doc.set.layouts=['money','steps'].flatMap((offer)=>['landscape','portrait'].map(orientation=>{
    const width=orientation==='landscape'?1920:1080,height=orientation==='landscape'?1080:1920;
    return {id:offer+'-'+orientation,label:offer+' · '+(orientation==='landscape'?'Landscape':'Portrait'),width,height,root:{id:offer+'-'+orientation+'-root',type:'box',styles:{position:'relative',width,height,background:'#101b20'},children:[{id:'cta-headline',type:'text',text:{get:'values.moneyTitle'},styles:{position:'absolute',left:80,top:350,width:850,height:200,color:'#ffffff',fontSize:50}},{id:'cta-support',type:'text',text:{get:'values.moneySupport'},styles:{position:'absolute',left:80,top:80,width:850,height:200,color:'#ffffff',fontSize:50}}]}};
   }));
  }
  const ids=['wide-one','screen-nine','wide-two','screen-four'];const original=doc.set.layouts.slice(0,4).map(l=>l.id);
  doc.set.layouts=doc.set.layouts.slice(0,4).map((l,i)=>({...l,id:ids[i]}));
  const fixedSupport=n=>{if(n.id==='cta-support')n.text='Fixed landscape support';n.children?.forEach(fixedSupport);};doc.set.layouts.filter(l=>l.width>l.height).forEach(l=>fixedSupport(l.root));
  doc.set.views={money:{landscape:ids[0],portrait:ids[1]},steps:{landscape:ids[2],portrait:ids[3]}};doc.set.initialLayout=ids[1];doc.set.initialView='money';delete doc.set.controlArrangement;doc.set.controls=doc.set.controls.filter(c=>c.type!=='button'||c.action.type!=='layout.select');
  if(outputLayout(doc.set,ids[1],'landscape')!==ids[0])throw Error('Explicit mapping not resolved');
  const legacy=structuredClone(doc.set);delete legacy.views;legacy.layouts=legacy.layouts.map((l,i)=>({...l,id:['old-landscape','old-portrait','extra','single'][i]}));
  if(layoutViews(legacy).length!==3)throw Error('Legacy pairs or standalone layouts lost');
  const proof=window.pairProof={calls:[],taken:[],failPortrait:false,serial:0};const outputs={};
  const native=id=>outputs[id]??={preparedRevision:0,renderedRevision:0,ready:true,warmed:true,queued:false,transitioning:false,renderSerial:0,keys:new Set()};
  const status=id=>{const s=native(id);return {...s,keys:undefined,cachedKeys:[...s.keys],generation:1};};
  ipc.liveSelectOutput=async()=>{};ipc.livePortraitRoom=async()=>({items:[]});ipc.livePortraitState=async()=>({items:[]});ipc.livePortraitStop=async()=>{};
  ipc.liveSetStatus=async()=>({generation:1});ipc.liveEngineStatus=async()=>({engine_ready:true,video_height:720,sources:{items:[]}});
  window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
  window.__TAURI_INTERNALS__={transformCallback:()=>1,invoke:async(cmd,args)=>{
   if(cmd==='plugin:event|listen')return 1;if(cmd==='set_library_list')return [];if(cmd!=='live_set_v2')return null;
   const r=args.request,id=r.outputId??'program',s=native(id);proof.calls.push({op:r.op,id,canvas:r.plan?.canvasId});
   if(r.op==='preload'){if(id==='portrait'&&proof.failPortrait)throw Error('Portrait fixture unavailable');s.keys.add(r.key);s.preparedRevision=r.revision;}
   if(r.op==='activate'){if(!s.keys.has(r.key))throw Error('Unprepared activation');s.preparedRevision=r.revision;s.canvas=r.plan.canvasId;}
   if(r.op==='take'){s.renderedRevision=r.revision;proof.taken.push({program:s.canvas});}
   if(r.op==='takePair'){
    const a=native('program'),b=native('portrait');if(a.preparedRevision!==r.programRevision||b.preparedRevision!==r.portraitRevision)throw Error('Pair not staged');
    a.renderedRevision=r.programRevision;b.renderedRevision=r.portraitRevision;proof.taken.push({program:a.canvas,portrait:b.canvas});
   }
   return status(id);
  }};
  const session=new RehearsalSession(doc,undefined,'prepare');window.pairSession=session;
  function Harness(){const [view,setView]=R.useState('landscape');const output=useRoomOutput(session,'pair-test',{items:[]},true,{});window.pairOutput=output;return R.createElement(R.Fragment,null,R.createElement(OutputSettings,{icon:'Output',session,output,sourceNames:{},view,onViewChange:setView}),R.createElement(SetControlsPanel,{session,output,onChange:()=>{}}));}
  const host=document.createElement('div');document.body.replaceChildren(host);(D.createRoot??D.default.createRoot)(host).render(R.createElement(Harness));
 },doc);
 await page.waitForFunction(()=>window.pairOutput?.configurePortrait);
 assert.equal(await page.locator('.set-layout-list button').count(),2,'one button per offer');
 assert.equal(await page.locator('.set-layout-list button[aria-pressed="true"]').count(),1,'one selected offer even when initial layout is portrait');
 await page.getByRole('button',{name:'Output settings',exact:true}).click();
 await page.getByRole('button',{name:'Both',exact:true}).click();
 await page.keyboard.press('Escape');
 await page.waitForFunction(()=>window.pairOutput.requiredOrientations.length===2);
 await page.evaluate(()=>window.pairOutput.apply());
 await page.waitForFunction(()=>window.pairProof.taken.length>0);
 assert.deepEqual(await page.evaluate(()=>window.pairProof.taken.at(-1)),{program:'wide-one',portrait:'screen-nine'});
 const contentBefore=await page.evaluate(()=>window.pairProof.taken.length);
 await page.evaluate(()=>window.pairSession.send({type:'control',action:{type:'value.set',key:'moneySupport',value:'Portrait-only content changed'}}));
 await page.waitForFunction(count=>window.pairProof.taken.length>count,contentBefore);
 await page.locator('.set-layout-list button').nth(1).click();
 await page.waitForFunction(()=>window.pairProof.taken.at(-1)?.portrait==='screen-four');
 assert.deepEqual(await page.evaluate(()=>window.pairProof.taken.at(-1)),{program:'wide-two',portrait:'screen-four'});
 // New content requires fresh preparation. A portrait failure must prevent both takes.
 const before=await page.evaluate(()=>{window.pairProof.failPortrait=true;return window.pairProof.taken.length;});
 await page.evaluate(()=>window.pairSession.send({type:'control',action:{type:'value.set',key:'moneyTitle',value:'A changed offer'}}));
 await page.locator('.set-layout-list button').first().click();
 await page.waitForFunction(()=>window.pairOutput.error.includes('Portrait fixture unavailable'));
 assert.equal(await page.evaluate(()=>window.pairProof.taken.length),before,'failed portrait retains both previous outputs');
 assert.deepEqual(await page.evaluate(()=>window.pairProof.taken.at(-1)),{program:'wide-two',portrait:'screen-four'});
 await page.evaluate(()=>{window.pairProof.failPortrait=false;window.pairOutput.retryPreparation();});
 await page.evaluate(()=>window.pairOutput.apply());
 await page.waitForFunction(()=>window.pairProof.taken.at(-1)?.portrait==='screen-nine');
 // Landscape-only mode must not issue a pair take.
 await page.getByRole('button',{name:'Output settings',exact:true}).click();
 await page.getByRole('button',{name:'Landscape',exact:true}).click();
 await page.keyboard.press('Escape');
 await page.waitForFunction(()=>window.pairOutput.requiredOrientations.length===1);
 await page.locator('.set-layout-list button').nth(1).click();
 await page.waitForFunction(()=>window.pairProof.taken.at(-1)?.program==='wide-two'&&!window.pairProof.taken.at(-1)?.portrait);
 assert.deepEqual(errors,[]);
 console.log('PASS: consolidated controls; explicit IDs; legacy and unpaired layouts; correct dual-output routing; failed portrait retains both; retry; landscape-only mode');
}finally{await browser.close();}
