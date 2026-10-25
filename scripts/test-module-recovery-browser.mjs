import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'/private/tmp/producer-sets-v2-browser/node_modules/playwright-core/index.mjs');
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:1436/');
 await page.evaluate(async()=>{
  const imported=await import('/node_modules/.vite/deps/react.js'),R=imported.default??imported,D=await import('/node_modules/.vite/deps/react-dom_client.js');
  const {RehearsalSession}=await import('/src/features/presentation/rehearsal.ts'),{useSetModules}=await import('/src/features/presentation/useSetModules.ts'),{SetRuntime}=await import('/shared/set-runtime/runtime.ts'),{guests}=await import('/src/lib/ipc.ts'),{dataIntegrations}=await import('/src/lib/dataIntegrations.ts');
  window.__TAURI_INTERNALS__={transformCallback:()=>1,invoke:async()=>undefined};
  const doc=await(await fetch('/docs/shows/just-facts.json')).json(),session=window.session=new RehearsalSession(doc,undefined,'prepare');window.reads=0;window.offlineUntil=Date.now()+1800;window.lifecycle=[];window.connections=[];session.subscribe(()=>window.connections.push(session.snapshot().moduleConnection));let runtime,deployment;
  dataIntegrations.list=async()=>({connections:[],capabilities:[]});
  guests.request=async(_endpoint,method,path,body)=>{
   if(_endpoint!=='test-workspace')return {available:false};
   if(method==='GET'){window.reads++;if(Date.now()<window.offlineUntil)throw Error('Workspace temporarily unavailable');return {available:true,body:{deployment:deployment??null,snapshot:runtime?.snapshot()??null}};}
   if(path.endsWith('/orchestrate')){window.lifecycle.push(body.lifecycle);const result=runtime.orchestrate(body.lifecycle,{role:'show',id:'runner',modules:doc.runtime.instances.map(i=>i.id)},Date.now());return {available:true,body:{result,snapshot:runtime.snapshot()}};}
   runtime=new SetRuntime(body.definition,{epoch:1,domain:'live',capabilities:['data.agent@1']});deployment=body.deployment;return {available:true,body:{deployment,snapshot:runtime.snapshot()}};
  };
  function Harness(){const state=R.useSyncExternalStore(session.subscribe,session.snapshot);useSetModules(session,'test-workspace','test-room',true,state.workspaceMode,{});return R.createElement('div',null,state.moduleConnection+' '+state.moduleError);}
  const host=document.createElement('div');document.body.replaceChildren(host);(D.createRoot??D.default.createRoot)(host).render(R.createElement(Harness));
 });
 await page.waitForFunction(()=>window.session.snapshot().moduleConnection==='live'&&window.session.moduleSnapshot().modules.research.execution==='running');
 assert.equal(await page.evaluate(()=>window.reads>=2&&window.connections.includes('error')),true);
 assert.equal(await page.evaluate(()=>window.session.send({type:'control',action:{type:'show.start'}})),true);
 await page.waitForFunction(()=>window.lifecycle.some(l=>l.running));assert.deepEqual(errors,[]);
 console.log('PASS: failed initial module connection retries automatically, starts the set module and accepts Show start without reapplying the set');
}finally{await browser.close();}
