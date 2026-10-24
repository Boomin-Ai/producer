import assert from 'node:assert/strict';
const {chromium}=await import('/private/tmp/producer-sets-v2-browser/node_modules/playwright-core/index.mjs');
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 const page=await browser.newPage();page.on('pageerror',e=>console.log('ERROR',e.message));await page.goto('http://127.0.0.1:1436/');
 await page.evaluate(async()=>{
  const M=await import('/node_modules/.vite/deps/react.js'),R=M.default??M,D=await import('/node_modules/.vite/deps/react-dom_client.js');
  const {useRoomOutput}=await import('/src/features/sets-v2/useRoomOutput.ts'),{HEAD_TO_HEAD}=await import('/src/features/presentation/fixtures.ts');
  const source=await(await fetch('/src/features/sets-v2/useRoomOutput.ts')).text(),{RehearsalSession}=await import(source.match(/from "([^"]*rehearsal\.ts[^"]*)"/)[1]);
  const session=new RehearsalSession(HEAD_TO_HEAD,undefined,'prepare');const cache={program:new Set(),portrait:new Set()};let revision=0,rendered=0;
  window.calls=[];window.__TAURI_INTERNALS__={transformCallback:()=>1,invoke:async(cmd,args)=>{
   window.calls.push(cmd==='live_set_v2'?args.request.op:cmd);
   if(cmd==='live_set_status')return {generation:1};if(cmd==='live_engine_status')return {video_height:720};
   if(cmd==='live_set_v2'){const r=args.request,out=r.outputId??'program';if(r.op==='preload'){cache[out].add(r.key);revision=r.revision;}if(r.op==='take')rendered=r.revision;if(r.op==='retain')for(const k of cache[out])if(!r.keys.includes(k))cache[out].delete(k);return {generation:1,preparedRevision:revision,renderedRevision:rendered,renderSerial:1,queued:false,transitioning:false,ready:true,warmed:true,cachedKeys:[...cache[out]]};}
   return null;
  }};
  function Harness(){window.output=useRoomOutput(session,'test-room',{items:[]},true,{});return R.createElement('div',null,JSON.stringify(window.output.layoutReadiness));}
  const root=document.createElement('div');document.body.replaceChildren(root);(D.createRoot??D.default.createRoot)(root).render(R.createElement(Harness));
 });
 await page.waitForFunction(()=>Object.values(window.output?.layoutReadiness??{}).length>0&&Object.values(window.output.layoutReadiness).every(s=>s.state==='ready'),{},{timeout:15000});
 await page.evaluate(()=>window.output.apply());
 assert.equal(await page.evaluate(()=>window.output.error),'');console.log('PASS: real room adapter prepares every layout and applies a cached scene',await page.evaluate(()=>window.calls));
}finally{await browser.close();}
