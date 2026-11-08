/** Actual guarded UI driver in an isolated headless DOM with mocked IPC.
 * Uses the existing tools/producer-mcp browser dependency; an alternative can
 * be supplied via PRODUCER_PLAYWRIGHT_MODULE and PRODUCER_TEST_CHROME.
 * No running app, invitations, device access, emitted tone or recording. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import ts from 'typescript';
const module=process.env.PRODUCER_PLAYWRIGHT_MODULE;
const {chromium}=await import(module?(module.startsWith('file:')?module:pathToFileURL(resolve(module)).href):new URL('../tools/producer-mcp/node_modules/playwright-core/index.mjs',import.meta.url).href);
const source=readFileSync(new URL('../src/features/network/nativePairProof.ts',import.meta.url),'utf8').replaceAll('import.meta.env','__env').replaceAll('import.meta.hot','__hot');
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const browser=await chromium.launch({headless:true,...(process.env.PRODUCER_TEST_CHROME?{executablePath:process.env.PRODUCER_TEST_CHROME}:{channel:process.env.PRODUCER_BROWSER_CHANNEL??'chrome'}),args:['--disable-background-timer-throttling']});
try{
 const context=await browser.newContext({viewport:{width:1280,height:1000},permissions:[]});
 const networkAttempts=[];await context.route('**/*',route=>{networkAttempts.push(route.request().url());return route.abort();});
 await context.addInitScript(()=>{
  const denied={media:0,recording:0,network:0};window.__nativePairTestDenied=denied;
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{
   getUserMedia(){denied.media++;throw Error('Device capture forbidden in fixture');},
   getDisplayMedia(){denied.media++;throw Error('Display capture forbidden in fixture');},
  }});
  window.MediaRecorder=class {constructor(){denied.recording++;throw Error('Recording forbidden in fixture');}};
  window.WebSocket=class {constructor(){denied.network++;throw Error('Provider connection forbidden in fixture');}};
  window.fetch=()=>{denied.network++;throw Error('Provider request forbidden in fixture');};
 });
 const page=await context.newPage(),pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));
 const results=await page.evaluate(async compiled=>{
  const results=[],check=(value,message)=>{if(!value)throw Error(message);},flush=async()=>{for(let n=0;n<80;n++)await Promise.resolve();};
  const endpointId='11111111-1111-4111-8111-111111111111',localRoomId='22222222-2222-4222-8222-222222222222',remoteRoomId='33333333-3333-4333-8333-333333333333';
  const manifest={version:1,workspace:{endpointId,brandSlug:'kleveland'},localRoomId,remoteRoomId};
  function fixture(options={}){
   let now=0,sequence=0,identifierCalls=0,reads=0,knocks=0,joins=0,diagnosticCalls=0,cancels=0,active=endpointId,session=null,capture=false,state='idle',recordOther=false,disposeModule;
   let observed=options.busyDiagnostics?'running':'idle',resolveDiagnostics,diagnosticTimer,holdEndpoints=false,resolveEndpoints,holdIdentifier=false,resolveIdentifier,submittedRoom=null,submittedProgram=false,visible=true;
   Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>visible?'visible':'hidden'});
   const timers=new Map(),logs=[];
   const timer=(fn,ms)=>{const id=++sequence;timers.set(id,{fn,at:now+ms});return id;};
   const endpoint={id:endpointId,name:'irrelevant display',kind:options.endpointKind??'connected',endpoint_kind:options.endpointType??'boomin',brand_slug:options.brandSlug??'kleveland',base_url:options.baseUrl??'https://api.boomin.ai/v1/app'};
   const extraEndpoint={...endpoint,id:'44444444-4444-4444-8444-444444444444'};
   const engines=()=>({session_state:state,destinations:options.destinations??[]});
   const observer={status:()=>({state:observed}),run(){diagnosticCalls++;observed='running';return new Promise(resolve=>{resolveDiagnostics=resolve;diagnosticTimer=timer(()=>{observed='idle';resolve({reason:'completed',sampleCount:60,measurementMs:60000,samples:[]});},60000);});},cancel(){cancels++;timers.delete(diagnosticTimer);observed='idle';resolveDiagnostics?.({reason:'cancelled',sampleCount:0});}};
   if(options.existingSession)session={current:()=>true};
   const deps={document,window,now:()=>now,setTimer:timer,clearTimer:id=>timers.delete(id),activeEndpoint:()=>active,
    endpoints:async()=>{reads++;if(holdEndpoints)return new Promise(resolve=>{resolveEndpoints=resolve;});return [endpoint,extraEndpoint];},
    rooms:async id=>{reads++;check(id===endpointId,'room list must remain explicitly scoped');return [{id:localRoomId,endpoint_id:options.legacyRoom?null:endpointId}];},
    engine:async()=>{reads++;return engines();},recordings:async id=>{reads++;return (capture||recordOther&&id===extraEndpoint.id)?[{status:'recording'}]:[];},
    getSession:()=>session,diagnostics:()=>options.noDiagnostics?undefined:observer,log:line=>logs.push(line)};
   document.body.innerHTML='<style>body{margin:0;padding:30px}button,input,select{margin:10px;min-height:24px}.join-sheet{position:fixed;inset:20px;overflow:auto;background:white}label{display:block}</style><section id="sec-livenow"></section>';
   const section=document.querySelector('#sec-livenow');
   const button=document.createElement('button');button.textContent='Enter';button.dataset.producerNetworkRoomId=remoteRoomId;button.dataset.producerEndpointId=endpointId;section.append(button);
   function renderSheet(){
    const aside=document.createElement('aside');aside.className='producer-network-sheet join-sheet';aside.dataset.producerNetworkRoomId=options.wrongSheet?localRoomId:remoteRoomId;aside.dataset.producerEndpointId=endpointId;
    aside.innerHTML='<section class="producer-join" aria-label="Join a Producer room"><form><label><input type="radio" name="producer-video"><strong>My room and Set</strong></label><label><input type="radio" name="producer-video" checked><strong>Webcam and microphone</strong></label><select aria-label="Room to send"><option value="other-local-room">Other saved room</option><option value="'+localRoomId+'">Local room</option></select><button type="submit">Join room</button></form></section>';
    aside.querySelector('form').addEventListener('submit',e=>{e.preventDefault();joins++;submittedRoom=aside.querySelector('select').value;submittedProgram=aside.querySelectorAll('input[type="radio"]')[0].checked;if(options.reject){aside.insertAdjacentHTML('beforeend','<p role="alert">PRIVATE INVITATION SECRET</p>');return;}aside.remove();if(options.recordAfterJoin)capture=true;if(!options.noAdmission)session={current:()=>true};});
    document.body.append(aside);if(options.raceRecording)capture=true;if(options.busyAfterKnock)observed='running';
   }
   button.onclick=()=>{knocks++;if(options.cancelOnKnock)driver.cancel();if(options.switchOnKnock){active=extraEndpoint.id;window.dispatchEvent(new Event('producer:workspace'));}if(!options.noSheet)renderSheet();};
   if(options.ambiguous)section.append(button.cloneNode(true));
   if(options.missing)button.removeAttribute('data-producer-network-room-id');
   if(options.blocker){const block=document.createElement('div');block.style.cssText='position:fixed;inset:0;background:black;z-index:999';document.body.append(block);}
   if(options.existingSheet)renderSheet();
   const exports={};if(options.native===false)delete window.__TAURI_INTERNALS__;else window.__TAURI_INTERNALS__={};delete window.__producerNativePairProof;
   const require=name=>{
    if(name==='@tauri-apps/api/app')return {async getIdentifier(){identifierCalls++;if(holdIdentifier)return new Promise(resolve=>{resolveIdentifier=resolve;});return options.appId??'ai.boomin.producer.sets-v2-dev';}};
    if(name.endsWith('/ipc'))return {ipc:{listEndpoints:deps.endpoints,liveListRooms:deps.rooms,liveEngineStatus:deps.engine},recording:{list:deps.recordings},uiLog:deps.log};
    if(name.endsWith('/workspace'))return {activeEndpointId:deps.activeEndpoint,isBoomin:ep=>ep.endpoint_kind==='boomin',WORKSPACE_EVENT:'producer:workspace'};
    if(name.endsWith('/guestSeat'))return {activeGuestSeatDiagnosticSession:deps.getSession};
    throw Error('Unexpected runtime dependency '+name);
   };
   Function('exports','require','__env','__hot',compiled)(exports,require,options.env??{DEV:true,VITE_PRODUCER_NATIVE_PAIR_PROOF:'1'},{dispose(fn){disposeModule=fn;}});
   const driver=exports.createNativePairProof(deps);
   return {driver,exports,observer,logs,timers,button,
    counts:()=>({identifierCalls,reads,knocks,joins,diagnosticCalls,cancels}),state(next){state=next;},recordOther(){recordOther=true;},active(next){active=next;},submitted:()=>({room:submittedRoom,program:submittedProgram}),
    holdEndpoints(){holdEndpoints=true;},releaseEndpoints(){resolveEndpoints?.([endpoint,extraEndpoint]);},holdIdentifier(){holdIdentifier=true;},releaseIdentifier(){resolveIdentifier?.('ai.boomin.producer.sets-v2-dev');},
    hide(){visible=false;document.dispatchEvent(new Event('visibilitychange'));},
    async advance(ms){await flush();const end=now+ms;for(;;){const next=[...timers.entries()].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;timers.delete(next[0]);now=next[1].at;next[1].fn();await flush();}now=end;await flush();},
    async finish(input=manifest,ms=100000){const p=driver.run(input);await this.advance(ms);return await p;},disposeModule,
   };
  }
  async function test(name,fn){await fn();results.push({name,pass:true});}
  await test('installation is inert: no native reads, timers or clicks',async()=>{const h=fixture();await h.exports.installNativePairProof();check(!!window.__producerNativePairProof,'API missing');check(h.counts().identifierCalls===1&&h.counts().reads===0&&h.timers.size===0,'installation performed work');});
  for(const options of [{env:{DEV:false,VITE_PRODUCER_NATIVE_PAIR_PROOF:'1'}},{env:{DEV:true,VITE_PRODUCER_NATIVE_PAIR_PROOF:'0'}},{native:false},{appId:'ai.boomin.producer'},{appId:'ai.boomin.producer.sets-v2-dev.evil'},{appId:'ai.boomin.producer.windows-network-dev'}])await test('installation refuses '+JSON.stringify(options),async()=>{const h=fixture(options);await h.exports.installNativePairProof();check(!window.__producerNativePairProof&&h.counts().reads===0,'unexpected installation');});
  await test('malformed fixture rejected before any native read or click',async()=>{const h=fixture();const r=await h.finish({...manifest,remoteRoomId:'https://wrong.invalid/secret'});check(r.reason==='invalid_fixture'&&h.counts().reads===0&&h.counts().knocks===0,'invalid fixture accepted');});
  await test('wrong workspace never clicks',async()=>{const h=fixture();h.active('wrong');check((await h.finish()).reason==='workspace_mismatch'&&h.counts().knocks===0,'workspace accepted');});
  await test('legacy unowned local room is rejected',async()=>{const h=fixture({legacyRoom:true});check((await h.finish()).reason==='room_mismatch'&&h.counts().knocks===0,'unowned room accepted');});
  for(const state of ['starting','streaming','stopping'])await test('output state '+state+' rejected',async()=>{const h=fixture();h.state(state);check((await h.finish()).reason==='output_active'&&h.counts().knocks===0,'active output accepted');});
  await test('recording on a different workspace rejected',async()=>{const h=fixture();h.recordOther();check((await h.finish()).reason==='output_active'&&h.counts().knocks===0,'recording accepted');});
  for(const [options,reason] of [[{ambiguous:true},'ui_ambiguous'],[{missing:true},'target_unavailable'],[{blocker:true},'app_not_ready'],[{existingSheet:true},'app_not_ready'],[{noDiagnostics:true},'diagnostics_unavailable']])await test('DOM safety '+JSON.stringify(options),async()=>{const h=fixture(options);check((await h.finish()).reason===reason&&h.counts().knocks===0,'unsafe DOM click');});
  await test('one normal UI knock and explicit program/local-room submit, one60s diagnostic run, duplicate coalesces and replay refused',async()=>{const h=fixture(),p=h.driver.run(manifest);check(h.driver.run(manifest)===p,'duplicate operation');await h.advance(62000);const r=await p,c=h.counts();check(r.reason==='completed'&&c.knocks===1&&c.joins===1&&c.diagnosticCalls===1,'happy path failed '+JSON.stringify({r,c}));check(h.submitted().room===localRoomId&&h.submitted().program,'wrong media or local room submitted');check(r.diagnostics.measurementMs===60000&&r.milestones.length===5&&h.timers.size===0,'measurement/timer error');check(!h.logs.join('').includes(endpointId)&&!h.logs.join('').includes('SECRET'),'private context in receipt');check((await h.driver.run(manifest)).reason==='already_attempted'&&h.counts().knocks===1,'second knock allowed');});
  for(const [options,reason] of [[{wrongSheet:true},'context_changed'],[{raceRecording:true},'output_active'],[{switchOnKnock:true},'workspace_mismatch'],[{cancelOnKnock:true},'cancelled'],[{noSheet:true},'join_timeout']])await test('after-knock guard '+JSON.stringify(options),async()=>{const h=fixture(options);const r=await h.finish();check(r.reason===reason&&h.counts().knocks===1&&h.counts().joins===0&&h.counts().diagnosticCalls===0,'post-knock guard failed '+JSON.stringify(r));check(h.timers.size===0,'timer leak');});
  for(const [options,reason] of [[{reject:true},'join_rejected'],[{noAdmission:true},'admission_timeout']])await test('admission remains host-controlled '+JSON.stringify(options),async()=>{const h=fixture(options);const r=await h.finish();check(r.reason===reason&&h.counts().joins===1&&h.counts().diagnosticCalls===0,'admission guard failed');check(!h.logs.join('').includes('SECRET')&&h.timers.size===0,'error leaked or timer retained');});
  await test('cancelled measurement leaves seat intact and cancels only observer',async()=>{const h=fixture(),p=h.driver.run(manifest);await h.advance(2000);check(h.counts().diagnosticCalls===1,'not measuring');h.driver.cancel();await h.advance(0);const r=await p;check(r.reason==='cancelled'&&h.counts().joins===1&&h.counts().cancels>=1&&h.timers.size===0,'cancel failed');});
  await test('HMR removes installed API without new work',async()=>{const h=fixture();await h.exports.installNativePairProof();h.disposeModule();check(!window.__producerNativePairProof&&h.counts().reads===0,'HMR failed');});
  for(const options of [{baseUrl:'https://api.boomin.ai.evil.invalid/v1/app'},{baseUrl:'https://user:password@api.boomin.ai/v1/app'},{brandSlug:'different'},{endpointKind:'independent'},{endpointType:'standalone'}])await test('workspace authority context rejected '+JSON.stringify(options),async()=>{const h=fixture(options);check((await h.finish()).reason==='workspace_mismatch'&&h.counts().knocks===0,'untrusted context accepted');});
  for(const destination of [{active:true,phase:'stopped'},{active:false,phase:'connecting'},{active:false,phase:'live'},{active:false,phase:'reconnecting'}])await test('active destination blocks proof '+JSON.stringify(destination),async()=>{const h=fixture({destinations:[destination]});check((await h.finish()).reason==='output_active'&&h.counts().knocks===0,'destination output accepted');});
  for(const options of [{existingSession:true},{busyDiagnostics:true}])await test('an existing seat or busy observer is preserved '+JSON.stringify(options),async()=>{const h=fixture(options),result=await h.finish();check(['app_not_ready','diagnostics_unavailable'].includes(result.reason)&&h.counts().knocks===0&&h.counts().diagnosticCalls===0&&h.counts().cancels===0,'existing ownership disturbed');});
  await test('hung endpoint read has bounded timeout and cannot click after late success',async()=>{const h=fixture();h.holdEndpoints();const running=h.driver.run(manifest);await h.advance(9000);const result=await running;check(result.reason==='app_not_ready'&&h.counts().knocks===0&&h.timers.size===0,'read did not time out');h.releaseEndpoints();await flush();check(h.counts().knocks===0,'late read clicked a target');});
  await test('cancellation during native read clears deadline and fences late success',async()=>{const h=fixture();h.holdEndpoints();const running=h.driver.run(manifest);await flush();h.driver.cancel();await h.advance(0);check((await running).reason==='cancelled'&&h.timers.size===0,'read cancellation failed');h.releaseEndpoints();await flush();check(h.counts().knocks===0&&h.counts().joins===0,'late work resumed after cancellation');});
  await test('a hidden app cancels pending context validation before any UI action',async()=>{const h=fixture();h.holdEndpoints();const running=h.driver.run(manifest);await flush();h.hide();await h.advance(0);check((await running).reason==='context_changed'&&h.timers.size===0,'hidden context remained active');h.releaseEndpoints();await flush();check(h.counts().knocks===0&&h.counts().joins===0,'hidden app was clicked');});
  await test('an observer started by another operation after knock is left untouched',async()=>{const h=fixture({busyAfterKnock:true}),result=await h.finish();check(result.reason==='context_changed'&&h.counts().knocks===1&&h.counts().joins===0&&h.counts().diagnosticCalls===0&&h.counts().cancels===0,'another observer was disturbed');});
  await test('recording begun after admission blocks measurement without stopping that output',async()=>{const h=fixture({recordAfterJoin:true}),result=await h.finish();check(result.reason==='output_active'&&h.counts().joins===1&&h.counts().diagnosticCalls===0&&h.counts().cancels===0,'active recording reached measurement');});
  await test('HMR during bundle-ID lookup cannot install a stale API',async()=>{const h=fixture();h.holdIdentifier();const pending=h.exports.installNativePairProof();await flush();h.disposeModule();h.releaseIdentifier();await pending;check(!window.__producerNativePairProof&&h.counts().reads===0,'late install escaped HMR');});
  check(Object.values(window.__nativePairTestDenied).every(value=>value===0),'fixture attempted media, recording or provider network work');
  return {results,denied:window.__nativePairTestDenied};
 },compiled);
 assert.ok(results.results.every(r=>r.pass));assert.deepEqual(pageErrors,[]);assert.deepEqual(networkAttempts,[]);
 console.log(JSON.stringify({scope:'Headless DOM plus mocked native reads only; not paired native media qualification',tests:results.results.length,deniedAttempts:results.denied,results:results.results},null,2));
}finally{await browser.close();}
