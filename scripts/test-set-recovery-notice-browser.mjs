// Real Set panel/recovery component, controlled native-output receipts.
// This verifies UI/action routing, not physical camera recovery.
import assert from 'node:assert/strict';
const {chromium}=await import('../tools/producer-mcp/node_modules/playwright-core/index.mjs');
const origin=process.env.PRODUCER_TEST_URL??'http://127.0.0.1:1436/';
const browser=await chromium.launch({executablePath:process.env.PRODUCER_CHROME??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
  const page=await browser.newPage({viewport:{width:1100,height:1000}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route(origin,route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body style="margin:0;background:#080e15"></body></html>'}));
  await page.route('https://**',route=>route.abort());await page.goto(origin);
  await page.evaluate(async()=>{
    const refresh=await import('/@react-refresh');refresh.default.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
    window.__TAURI_INTERNALS__={transformCallback:()=>1,invoke:async command=>command==='set_library_list'?[]:null};
    await import('/src/App.css');
    const R=await import('/node_modules/.vite/deps/react.js'),D=await import('/node_modules/.vite/deps/react-dom_client.js');
    const {SetControlsPanel}=await import('/src/features/presentation/SetControlsPanel.tsx');
    const panelSource=await(await fetch('/src/features/presentation/SetControlsPanel.tsx')).text();
    const {RehearsalSession}=await import(panelSource.match(/from "([^"]*rehearsal\.ts[^"]*)"/)[1]);
    const {setRecovery}=await import('/src/features/presentation/setRecovery.ts');window.classify=()=>setRecovery(doc,doc.set.layouts[0].id,window.output,window.names);
    const doc=await(await fetch('/src/features/presentation/fixtures/after-hours.json')).json();
    window.slot=doc.set.slots[0].id;doc.set.slots.push({id:'shared-camera',label:'Host portrait'});
    const session=new RehearsalSession(doc,undefined,'prepare');
    const host=document.createElement('div');host.style.cssText='width:360px;height:950px;overflow:auto;container:panel / size';host.className='recovery-test';document.body.append(host);
    const root=(D.createRoot??D.default.createRoot)(host),h=R.createElement??R.default.createElement;
    window.captureError='Set first-frame timeout (capture camera-stalled: waiting for source dimensions); current output retained';
    window.ids=doc.set.layouts.map(l=>l.id);window.scenario=0;
    window.camera=(id,label='Other camera')=>({id,kind:'camera',label,visible:true,has_frame:true,src_w:1920,src_h:1080});
    window.reset=(patch={})=>{
      ++window.scenario;window.applies=[];window.retries=[];window.returns=0;window.names={'camera-stalled':'Studio camera'};
      window.output={renderer:'native',active:true,busy:false,error:window.captureError,
        bindings:{[window.slot]:'camera-stalled','shared-camera':'camera-stalled'},framing:{[window.slot]:{mode:'fit',x:.3,y:.7}},
        sources:{items:[{...window.camera('camera-stalled','Camera'),has_frame:false,src_w:0,src_h:0},window.camera('camera-new')]},
        layoutReadiness:Object.fromEntries(window.ids.map(id=>[id,{state:'error',error:window.captureError}])),
        bind:(slot,id)=>{window.output.bindings={...window.output.bindings,[slot]:id};window.render();},frame:()=>{},
        retryPreparation:ids=>{window.retries.push(ids);for(const id of ids??window.ids)window.output.layoutReadiness[id]={state:'queued'};window.render();},
        apply:()=>{window.applies.push(structuredClone(window.output.bindings));return new Promise(resolve=>{window.finishApply=resolve;});},
        returnToRoom:async()=>{window.returns++;return true;},...patch};
      window.render();
    };
    window.render=()=>root.render(h(SetControlsPanel,{key:window.scenario,session,onChange:()=>{},output:window.output,sourceNames:window.names}));
    window.settle=(success=true)=>{window.output.error=success?'':window.captureError;window.output.layoutReadiness=Object.fromEntries(window.ids.map(id=>[id,success?{state:'ready'}:{state:'error',error:window.captureError}]));window.render();window.finishApply?.();};
    window.reset();
  });
  const notice=page.getByRole('region',{name:'Set recovery',exact:true});
  try{await notice.waitFor({timeout:10000});}catch(error){console.error(await page.evaluate(()=>({errors:document.querySelector('.recovery-test')?.innerText,classified:window.classify?.()})),errors);throw error;}assert.equal(await notice.count(),1);
  assert.equal(await notice.getByRole('button',{name:'Retry',exact:true}).count(),1);
  assert((await notice.innerText()).includes('Waiting for a frame from Studio camera.'));
  assert(!(await notice.innerText()).includes('camera-stalled'),'technical source IDs stay behind Details');
  assert.equal(await notice.getAttribute('data-severity'),'warning');
  assert.equal(await notice.getByText('Previous output retained',{exact:true}).count(),1);
  assert.equal(await page.getByText('A layout needs attention.',{exact:true}).count(),0,'old duplicate warning removed');
  await notice.getByText('Details',{exact:true}).click();assert((await notice.innerText()).includes('camera-stalled'));
  await notice.getByText('Details',{exact:true}).click();
  await notice.getByRole('button',{name:'Retry',exact:true}).evaluate(button=>{button.click();button.click();});
  await page.waitForFunction(()=>window.applies.length===1);
  assert.deepEqual(await page.evaluate(()=>window.retries),[await page.evaluate(()=>window.ids)]);
  assert(await notice.getByRole('button',{name:'Retrying…',exact:true}).isDisabled());
  assert.equal(await page.evaluate(()=>window.returns),0);
  await page.evaluate(()=>window.settle());await notice.waitFor({state:'detached'});
  await page.evaluate(()=>{window.output.layoutReadiness[window.ids[0]]={state:'queued'};window.render();});
  assert.equal(await notice.count(),0,'a later healthy edit cannot resurrect the old error');

  await page.evaluate(()=>window.reset());await notice.waitFor();
  await notice.getByRole('button',{name:'Retry',exact:true}).click();
  await page.evaluate(()=>window.settle(false));
  await page.waitForFunction(()=>!document.querySelector('.set-recovery-notice [disabled]'));
  assert.equal(await notice.count(),1,'failed retry stays actionable');

  // Explicit room-scene intent is preserved: warming an unused layout is not a take.
  await page.evaluate(()=>window.reset({active:false,error:'',layoutReadiness:{[window.ids[0]]:{state:'error',error:window.captureError}}}));
  await notice.getByRole('button',{name:'Retry',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.retries),[[await page.evaluate(()=>window.ids[0])]]);
  assert.equal(await page.evaluate(()=>window.applies.length),0);
  await page.evaluate(()=>window.settle());await notice.waitFor({state:'detached'});

  await page.evaluate(()=>window.reset());await notice.waitFor();
  assert.equal(await page.evaluate(()=>window.applies.length),0);
  await notice.getByRole('button',{name:'Choose camera',exact:true}).click();
  const picker=notice.getByRole('region',{name:'Choose Set sources'});
  assert.equal(await picker.getByRole('combobox').inputValue(),'camera-new');
  assert.equal(await page.evaluate(()=>window.output.bindings[window.slot]),'camera-stalled','suggestion is not assignment');
  await picker.getByRole('button',{name:'Use Other camera',exact:true}).click();
  await page.waitForFunction(()=>window.applies.length===1);
  assert.equal(await page.evaluate(()=>window.applies[0]['shared-camera']),'camera-new');
  assert.deepEqual(await page.evaluate(()=>Object.values(window.output.framing)),[{mode:'fit',x:.3,y:.7}]);
  assert.equal(await page.evaluate(()=>window.returns),0);await page.evaluate(()=>window.settle());await notice.waitFor({state:'detached'});

  // An active flag alone does not prove which output was retained.
  await page.evaluate(()=>window.reset({error:'Renderer disconnected',layoutReadiness:{}}));await notice.waitFor();
  assert.equal(await notice.getByText('Previous output retained',{exact:true}).count(),0);
  await page.evaluate(()=>window.reset({active:false,error:'Renderer disconnected',layoutReadiness:{}}));
  await page.waitForFunction(()=>document.querySelector('.set-recovery-notice')?.dataset.severity==='error');
  // Mixed first-frame failures must not be misdiagnosed as only a camera problem.
  await page.evaluate(()=>window.reset({error:'Set first-frame timeout (capture camera-stalled: waiting for source dimensions; media bg: waiting for frame); current output retained',layoutReadiness:{}}));
  assert.equal(await notice.getByText('Set needs attention',{exact:true}).count(),1);
  await page.evaluate(()=>window.reset({sources:{items:[]}}));
  await page.getByRole('region',{name:'Reconnect Set sources'}).waitFor();
  assert.equal(await notice.count(),0,'removed-source recovery does not get a duplicate timeout card');

  for(const width of [240,320,600,1000]){
    await page.evaluate(width=>{document.querySelector('.recovery-test').style.width=width+'px';window.reset();},width);
    await notice.waitFor();
    assert(await notice.evaluate(el=>el.scrollWidth<=el.clientWidth+1),`notice fits ${width}px dock`);
    await notice.getByRole('button',{name:'Choose camera',exact:true}).click();
    assert(await notice.evaluate(el=>el.scrollWidth<=el.clientWidth+1),`source picker fits ${width}px dock`);
    if(process.env.PRODUCER_RECOVERY_SCREENSHOTS)await notice.screenshot({path:process.env.PRODUCER_RECOVERY_SCREENSHOTS+`/notice-${width}.png`});
  }
  assert.deepEqual(errors,[]);
  console.log('PASS Set recovery notice: one friendly error, explicit retention receipt, scoped/deduplicated Retry, in-flight/success/failure, no stale resurrection, warm-only intent, explicit source replacement and 4 dock widths.');
}finally{await browser.close();}
