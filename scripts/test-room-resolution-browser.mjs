import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'/private/tmp/producer-sets-v2-browser/node_modules/playwright-core/index.mjs');
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 const page=await browser.newPage();page.on('pageerror',e=>console.log('ERROR',e.message));await page.goto('http://127.0.0.1:1436/');
 const setup=async()=>{
  // Drive only the hook's lifecycle polling explicitly. A real 1.5s interval
  // racing the repeat-Apply assertion would obscure whether the take reads it.
  const originalInterval=window.setInterval.bind(window),originalClear=window.clearInterval.bind(window),lifecycle=new Map();let intervalId=0;
  window.setInterval=(run,ms,...args)=>{if(ms!==1500)return originalInterval(run,ms,...args);const id=--intervalId;lifecycle.set(id,()=>run(...args));return id;};
  window.clearInterval=id=>{if(!lifecycle.delete(id))originalClear(id);};
  window.pollRoomLifecycle=()=>{for(const run of lifecycle.values())run();};
  const M=await import('/node_modules/.vite/deps/react.js'),R=M.default??M,D=await import('/node_modules/.vite/deps/react-dom_client.js');
  const {useRoomOutput}=await import('/src/features/sets-v2/useRoomOutput.ts'),{HEAD_TO_HEAD}=await import('/src/features/presentation/fixtures.ts');
  const source=await(await fetch('/src/features/sets-v2/useRoomOutput.ts')).text(),{RehearsalSession}=await import(source.match(/from "([^"]*rehearsal\.ts[^"]*)"/)[1]);
  if(!/transport\.current\??\.?ensureGeneration\(\)/.test(source))throw Error('The served room hook is missing the cached-generation take path');
  const session=new RehearsalSession(HEAD_TO_HEAD,undefined,'prepare');const cache={program:new Set(),portrait:new Set()};let revision=0,rendered=0;
  window.nativeRequests=[];window.nativeRejections=[];
  window.height=1080;window.engineReleased=false;window.generation=1;window.handlers=new Map();window.resize=(height,notify=true)=>{window.height=height;window.generation++;cache.program.clear();cache.portrait.clear();rendered=0;if(notify)window.handlers.get(window.eventHandler)?.({event:'live://event',id:1,payload:{type:'video_changed',height,fps:30}});};window.calls=[];window.__TAURI_INTERNALS__={transformCallback:callback=>{const id=window.handlers.size+1;window.handlers.set(id,callback);return id;},invoke:async(cmd,args)=>{
   window.calls.push(cmd==='live_set_v2'?args.request.op:cmd);if(cmd==='plugin:event|listen'){window.eventHandler=args.handler;return 1;}
   if(cmd==='live_set_status')return {generation:window.generation};if(cmd==='live_engine_status'){while(!window.engineReleased)await new Promise(r=>setTimeout(r,10));return {engine_ready:true,video_height:window.height};}
   if(cmd==='live_set_v2'){const r=args.request,out=r.outputId??'program';window.nativeRequests.push({op:r.op,generation:r.generation,nativeGeneration:window.generation,width:r.plan?.target.width,height:r.plan?.target.height});if(r.generation!==window.generation){window.nativeRejections.push(r.op);throw Error('Room changed; prepare this v2 set again');}if(r.op==='preload'||r.op==='activate'){const expected=out==='portrait'?{width:window.height,height:Math.round(window.height*16/9)}:{width:Math.round(window.height*16/9),height:window.height};if(r.plan.target.width!==expected.width||r.plan.target.height!==expected.height)throw Error('V2 revision/output must match the current room canvas');}if(r.op==='preload'){cache[out].add(r.key);revision=r.revision;}if(r.op==='take')rendered=r.revision;if(r.op==='retain')for(const k of cache[out])if(!r.keys.includes(k))cache[out].delete(k);return {generation:window.generation,preparedRevision:revision,renderedRevision:rendered,renderSerial:1,queued:false,transitioning:false,ready:true,warmed:true,cachedKeys:[...cache[out]]};}
   return null;
  }};
  function Harness(){window.output=useRoomOutput(session,'test-room',{items:[]},true,{});return R.createElement('div',null,JSON.stringify(window.output.layoutReadiness));}
  const root=document.createElement('div');document.body.replaceChildren(root);(D.createRoot??D.default.createRoot)(root).render(R.createElement(Harness));
 };
 await page.evaluate(setup);
 await page.waitForFunction(()=>!!window.output);
 // An editor publish can retain an apply callback from before canvas discovery.
 // No default-720p work may reach a saved-1080p native room during that window.
 await page.evaluate(()=>{window.earlyApply=window.output.apply();});
 await page.waitForTimeout(200);
 assert.equal(await page.evaluate(()=>window.calls.filter(c=>c==='preload').length),0);
 await page.evaluate(()=>{window.engineReleased=true;});
 await page.evaluate(()=>window.earlyApply);
 assert.equal(await page.evaluate(()=>window.output.error),'');
 assert.equal(await page.evaluate(()=>window.output.active),true);
 console.log('PASS: early apply waits for saved 1080p canvas discovery; no stale 720p preload');
 await page.waitForFunction(()=>Object.values(window.output?.layoutReadiness??{}).length>0&&Object.values(window.output.layoutReadiness).every(s=>s.state==='ready'),{},{timeout:15000});
 const warm=await page.evaluate(async()=>{
  const reads=window.calls.filter(c=>c==='live_set_status').length,preloads=window.calls.filter(c=>c==='preload').length;
  for(let i=0;i<4;i++){
   const takes=window.calls.filter(c=>c==='take').length;
   await window.output.apply();
   if(window.calls.filter(c=>c==='take').length!==takes+1)throw Error('Warm repeat Apply did not execute its native take');
   if(window.output.error)throw Error(window.output.error);
  }
  return {reads,afterReads:window.calls.filter(c=>c==='live_set_status').length,preloads,afterPreloads:window.calls.filter(c=>c==='preload').length};
 });
 assert.equal(warm.afterReads,warm.reads,'Warm repeat Apply must reuse discovered generation without a legacy status RPC');
 assert.equal(warm.afterPreloads,warm.preloads,'Warm repeat Apply must reuse prepared native scenes');
 console.log('PASS: four warm repeat Applies reuse generation and ready native scenes without legacy status reads');
 for(const height of [1080,720,1080]){
  const before=await page.evaluate(()=>({reads:window.calls.filter(c=>c==='live_set_status').length,generation:window.generation,requests:window.nativeRequests.length}));
  await page.evaluate(height=>window.resize(height,height!==720),height);
  if(height===720)await page.evaluate(()=>window.pollRoomLifecycle());
  await page.waitForFunction(reads=>window.calls.filter(c=>c==='live_set_status').length>reads,before.reads);
  await page.waitForFunction(generation=>window.nativeRequests.some(r=>r.generation===generation&&r.op==='preload'),before.generation+1);
  await page.waitForFunction(()=>Object.values(window.output.layoutReadiness).every(s=>s.state==='ready')&&!window.output.busy,{},{timeout:10000});
  const takes=await page.evaluate(()=>window.calls.filter(c=>c==='take').length);
  await page.evaluate(()=>window.output.apply());
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c==='take').length),takes+1);
  assert.equal(await page.evaluate(()=>window.output.error),'');
  await page.waitForFunction(()=>Object.values(window.output.layoutReadiness).every(s=>s.state==='ready'),{},{timeout:10000});
  const changed=await page.evaluate(offset=>window.nativeRequests.slice(offset).filter(r=>r.op==='preload'||r.op==='activate'),before.requests);
  assert.ok(changed.length>0);
  assert.ok(changed.every(r=>r.generation===before.generation+1),'Resize must discover the new generation before native mutations');
  assert.ok(changed.every(r=>r.height===height||r.width===height),'Both output orientations must use the resized room canvas');
  console.log('PASS: '+(height===720?'explicit lifecycle poll':'video change event')+' refreshes generation and applies matching '+height+'p native plans');
 }

 // Keeping an Apply through initial discovery must not resurrect it after an
 // explicit return while that discovery is still waiting on the native room.
 await page.reload();await page.evaluate(setup);await page.waitForFunction(()=>!!window.output);
 await page.evaluate(()=>{window.cancelledApply=window.output.apply();});
 await page.waitForTimeout(150);await page.evaluate(()=>window.output.returnToRoom());
 await page.evaluate(()=>{window.engineReleased=true;});await page.evaluate(()=>window.cancelledApply);
 assert.equal(await page.evaluate(()=>window.output.active),false);
 assert.equal(await page.evaluate(()=>window.calls.some(c=>c==='activate'||c==='take')),false);
 console.log('PASS: explicit Return during initial canvas wait cancels the pending Apply');

}finally{await browser.close();}
