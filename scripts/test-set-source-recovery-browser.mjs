import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'playwright-core');
const origin=process.env.PRODUCER_TEST_URL??'http://127.0.0.1:1436/';
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
  const page=await browser.newPage({viewport:{width:1000,height:1000}}),errors=[];
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
    const {RehearsalSession}=await import('/src/features/presentation/rehearsal.ts');
    const doc=await(await fetch('/src/features/presentation/fixtures/after-hours.json')).json();
    window.slot=doc.set.slots[0].id;doc.set.slots.push({id:'shared-screen',label:'Screen share · portrait'});
    const session=new RehearsalSession(doc,undefined,'prepare');
    const host=document.createElement('div');host.style.cssText='width:360px;height:900px;overflow:auto';host.className='set-recovery-fixture';document.body.append(host);
    const root=(D.createRoot??D.default.createRoot)(host),h=R.createElement??R.default.createElement;
    window.candidate=(id,kind='screen',label='Screen 2')=>({id,kind,label,visible:true,has_frame:true,src_w:1920,src_h:1080});
    const originalFraming={mode:'fit',x:.3,y:.7};window.scenario=0;
    window.reset=(patch={})=>{
      ++window.scenario;window.applies=[];window.persisted=[];window.retries=0;window.returns=0;
      window.output={renderer:'native',active:true,busy:false,error:'Error: Room source screen-old is unavailable for Set output',
        bindings:{[window.slot]:'screen-old','shared-screen':'screen-old',unrelated:'camera-live'},framing:{[window.slot]:originalFraming},
        sources:{items:[window.candidate('screen-new'),window.candidate('camera-live','camera','Webcam')]},
        layoutReadiness:Object.fromEntries(doc.set.layouts.map(layout=>[layout.id,{state:'error',error:'Room source screen-old is unavailable for Set output'}])),
        bind:(slot,id)=>{window.output.bindings={...window.output.bindings,[slot]:id};window.persisted.push(structuredClone(window.output.bindings));window.render();},
        frame:()=>{},retryPreparation:()=>window.retries++,
        apply:async()=>{window.applies.push(structuredClone(window.output.bindings));window.output.error='';window.output.layoutReadiness={};window.render();},
        returnToRoom:async()=>{window.returns++;return true;},...patch};
      window.render();
    };
    window.render=()=>root.render(h(SetControlsPanel,{key:window.scenario,session,onChange:()=>{},output:window.output}));
    window.reset();
  });
  const recovery=page.getByRole('region',{name:'Reconnect Set sources'});
  await recovery.waitFor();
  assert.equal(await recovery.getByRole('combobox').inputValue(),'screen-new','one compatible screen is suggested without rebinding');
  assert.equal(await page.evaluate(()=>window.applies.length),0);
  assert.equal(await page.getByText('Some layouts could not load.',{exact:false}).count(),0);
  assert.equal(await page.getByRole('button',{name:/Retry loading|Retry update/}).count(),0);
  assert(!(await recovery.innerText()).includes('screen-old'),'internal IDs are not presented as recovery instructions');
  if(process.env.PRODUCER_RECOVERY_SCREENSHOTS)await recovery.screenshot({path:process.env.PRODUCER_RECOVERY_SCREENSHOTS+'/reconnect.png'});
  await recovery.getByRole('button',{name:'Use Screen 2',exact:true}).click();
  await page.waitForFunction(()=>window.applies.length===1);
  const repaired=await page.evaluate(()=>({bindings:window.output.bindings,framing:window.output.framing,persisted:window.persisted.at(-1),returns:window.returns,retries:window.retries}));
  assert.equal(repaired.bindings['shared-screen'],'screen-new');
  assert.equal(repaired.bindings.unrelated,'camera-live');
  assert.equal(repaired.persisted['shared-screen'],'screen-new');
  assert.deepEqual(Object.values(repaired.framing),[{mode:'fit',x:.3,y:.7}]);
  assert.equal(repaired.returns,0,'source repair never drops the on-air Set');assert.equal(repaired.retries,1);
  assert.equal(await recovery.count(),0);

  await page.evaluate(()=>window.reset({sources:{items:[]}}));await recovery.waitFor();
  assert(await recovery.getByRole('button',{name:'Reconnect',exact:true}).isDisabled());
  await page.evaluate(()=>{window.output.sources={items:[window.candidate('screen-readded')]};window.render();});
  await recovery.getByRole('button',{name:'Use Screen 2',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.applies.length),0,'adding a source does not silently change its role');
  await recovery.getByRole('button',{name:'Use Screen 2',exact:true}).click();await page.waitForFunction(()=>window.applies.length===1);
  assert.equal(await page.evaluate(()=>window.output.bindings['shared-screen']),'screen-readded');

  await page.evaluate(()=>window.reset({sources:{items:[window.candidate('screen-a','screen','Display A'),window.candidate('screen-b','screen','Display B')]}}));
  await recovery.waitFor();assert.equal(await recovery.getByRole('combobox').inputValue(),'','multiple screens require a choice');
  await recovery.getByRole('combobox').selectOption('screen-b');await recovery.getByRole('button',{name:'Use Display B',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.applies[0]['shared-screen']),'screen-b');

  await page.evaluate(()=>window.reset({active:false,error:''}));await recovery.waitFor();
  await recovery.getByRole('button',{name:'Use Screen 2',exact:true}).click();await page.waitForFunction(()=>window.persisted.length===2);
  assert.equal(await page.evaluate(()=>window.applies.length),0,'an intentional room-scene selection is preserved');
  await page.evaluate(()=>window.reset({sources:{}}));assert.equal(await recovery.count(),0,'an inventory still loading is not evidence of removal');
  await page.evaluate(()=>window.reset({bindings:{[window.slot]:'guest-old'},sources:{items:[window.candidate('screen-new')]}}));await recovery.waitFor();
  assert.equal(await recovery.getByRole('combobox').inputValue(),'','a screen must not be silently proposed for a removed guest');
  await page.evaluate(()=>{document.querySelector('.set-recovery-fixture').style.width='240px';window.reset();});await recovery.waitFor();
  assert(await recovery.evaluate(element=>element.scrollWidth<=element.clientWidth+1),'recovery fits a narrow dock');
  assert.deepEqual(errors,[]);
  console.log('PASS Set source recovery: explicit replacement, recreated IDs, shared slots, persistence/framing, ambiguous choices, room-scene retention and narrow UI.');
} finally {await browser.close();}
