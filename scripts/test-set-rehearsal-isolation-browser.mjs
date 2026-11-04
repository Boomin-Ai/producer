import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'/private/tmp/producer-sets-v2-browser/node_modules/playwright-core/index.mjs');
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:1436/');
 await page.evaluate(async()=>{
  const M=await import('/node_modules/.vite/deps/react.js'),R=M.default??M,D=await import('/node_modules/.vite/deps/react-dom_client.js');
  const {SetControlsPanel}=await import('/src/features/presentation/SetControlsPanel.tsx'),{HEAD_TO_HEAD}=await import('/src/features/presentation/fixtures.ts');
  const source=await(await fetch('/src/features/presentation/SetControlsPanel.tsx')).text(),{RehearsalSession}=await import(source.match(/from "([^"]*rehearsal\.ts[^"]*)"/)[1]);
  window.__TAURI_INTERNALS__={transformCallback:()=>1,invoke:async(cmd)=>cmd==='set_library_list'?[]:null};window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
  const fixture=structuredClone(HEAD_TO_HEAD);fixture.set.controls.push({id:'preview-spotlight',type:'button',label:'Preview spotlight',action:{type:'value.set',key:'hostName',value:'Private spotlight'}});window.roomSession=new RehearsalSession(fixture,undefined,'prepare');window.takes=0;window.takeRequests=0;window.fallbackTakes=0;window.bindCalls=[];
  function Harness(){
   const [session,setSession]=R.useState(window.roomSession),[bindings,setBindings]=R.useState({host:'camera-a'}),[framing,setFraming]=R.useState({}),[active,setActive]=R.useState(false);
   window.roomSession=session;
   const setAssignments=(nextBindings,nextFraming)=>{
    window.bindCalls.push(nextBindings);
    setBindings(nextBindings);
    setFraming(nextFraming);
   };
   const onChange=(doc,_moduleBindings,take)=>{
    const next=new RehearsalSession(doc,undefined,'prepare');
    if(take){
     if(take.phase)next.send({type:'segment.select',phaseId:take.phase});
     if(next.snapshot().layoutId!==take.layout)next.send({type:'control',action:{type:'layout.select',layoutId:take.layout}});
     setAssignments(take.bindings,take.framing);
    }
    setSession(next);
    return next;
   };
   const applyConfirmed=async()=>{
    window.takeRequests++;
    await new Promise((resolve,reject)=>{
     window.finishApply=accepted=>accepted ? resolve() : reject(new Error('The test renderer did not confirm output.'));
    });
    window.takes++;
    setActive(true);
   };
   return R.createElement(SetControlsPanel,{session,onChange,output:{renderer:'native',active,busy:false,error:'',bindings,framing,sources:{items:[{id:'camera-a',label:'Camera A',kind:'camera',visible:true,has_frame:true},{id:'camera-b',label:'Camera B',kind:'camera',visible:true,has_frame:true}]},bind:()=>{},frame:()=>{},setAssignments,apply:async()=>{window.fallbackTakes++;},applyConfirmed,returnToRoom:async()=>true}});
  }
  const host=document.createElement('div');host.style.cssText='height:900px';document.body.replaceChildren(host);(D.createRoot??D.default.createRoot)(host).render(R.createElement(Harness));
 });
 await page.getByRole('button',{name:'Set settings',exact:true}).click();const editor=page.locator('dialog[open]');
 assert(await editor.getByRole('toolbar',{name:'Set configuration'}).getByRole('button',{name:'Rehearse',exact:true}).isVisible());
 assert(await editor.getByRole('toolbar',{name:'Set configuration'}).getByRole('button',{name:'Show on output',exact:true}).isVisible());
 assert.equal(await editor.locator('.set-editor-apply-status').innerText(),'Changes not on output');
 const before=await page.evaluate(()=>JSON.stringify(window.roomSession.snapshot()));
 await editor.getByRole('region',{name:'Preview visual controls'}).getByRole('button',{name:'Preview spotlight',exact:true}).click();
 assert.equal(await editor.getByRole('textbox',{name:'Host name',exact:false}).inputValue(),'Private spotlight');
 assert.equal(await page.evaluate(()=>JSON.stringify(window.roomSession.snapshot())),before);
 assert.equal(await page.evaluate(()=>window.takes),0);
 await editor.getByRole('button',{name:'Rehearse',exact:true}).click();await page.waitForTimeout(250);
 assert.equal(await page.evaluate(()=>JSON.stringify(window.roomSession.snapshot())),before);
 await editor.getByRole('combobox',{name:'Edit segment',exact:true}).selectOption('round');
 await editor.getByRole('button',{name:'Resume',exact:true}).click();
 await editor.getByRole('button',{name:'Vote Contestant A',exact:true}).click();
 await editor.getByRole('textbox',{name:'Host name',exact:false}).fill('Practice name');
 assert(await editor.getByRole('button',{name:'Show on output',exact:true}).isDisabled());
 const row=await editor.locator('.set-editor-run-tools').evaluate(el=>{const r=el.getBoundingClientRect();return {height:r.height,width:r.width};});assert(row.height<60,JSON.stringify(row));
 await page.screenshot({path:'/private/tmp/producer-private-rehearsal.png'});
 assert.equal(await page.evaluate(()=>window.takes),0);assert.equal(await page.evaluate(()=>window.roomSession.snapshot().show.total),0);
 await editor.getByRole('button',{name:'Exit rehearsal',exact:true}).click();assert.notEqual(await editor.getByRole('textbox',{name:'Host name',exact:false}).inputValue(),'Practice name');
 await editor.getByRole('textbox',{name:'Host name',exact:false}).fill('Prepared draft');
 await editor.getByRole('combobox',{name:'Edit segment',exact:true}).selectOption('round');
 const firstSource=editor.locator('.set-source-picker select').first();await firstSource.selectOption('camera-b');assert.equal(await page.evaluate(()=>window.bindCalls.length),0);
 await editor.getByRole('button',{name:'Close editor',exact:true}).click();await page.getByRole('button',{name:'Set settings',exact:true}).click();
 assert.equal(await editor.getByRole('textbox',{name:'Host name',exact:false}).inputValue(),'Prepared draft');
 const apply=editor.getByRole('button',{name:'Show on output',exact:true});
 const close=editor.getByRole('button',{name:'Close editor',exact:true});
 await apply.click();await page.waitForFunction(()=>window.takeRequests===1);
 assert(await close.isDisabled());
 await page.keyboard.press('Escape');
 await editor.dispatchEvent('click');
 assert.equal(await editor.count(),1);
 assert.equal(await page.evaluate(()=>window.takes),0);
 await page.evaluate(()=>window.finishApply(false));
 await editor.getByRole('alert').filter({hasText:'The test renderer did not confirm output.'}).waitFor();
 assert(await close.isEnabled());
 assert(await apply.isEnabled());
 await apply.click();await page.waitForFunction(()=>window.takeRequests===2);
 await page.evaluate(()=>window.finishApply(true));
 await page.waitForFunction(()=>document.querySelector('.set-editor-apply-status')?.textContent==='✓ On output');
 assert(await apply.isDisabled());
 assert(await close.isEnabled());
 assert.deepEqual(await page.evaluate(()=>[window.takes,window.fallbackTakes]),[1,0]);
 assert.equal(await page.evaluate(()=>window.roomSession.snapshot().values.hostName),'Prepared draft');
 assert.equal(await page.evaluate(()=>window.roomSession.snapshot().show.phase),'round');
 assert.equal(await editor.getByRole('combobox',{name:'Edit segment',exact:true}).inputValue(),'round');
 await editor.getByRole('button',{name:'Close editor',exact:true}).click();await page.locator('.set-mode-action').click();
 assert.equal(await page.evaluate(()=>window.roomSession.snapshot().workspaceMode),'live');
 await page.waitForFunction(()=>window.roomSession.snapshot().elapsedMs>100);
 await page.getByRole('button',{name:'Set settings',exact:true}).click();const phase=await page.evaluate(()=>window.roomSession.snapshot().show.phase);
 await editor.getByRole('combobox',{name:'Edit segment',exact:true}).selectOption('round');assert.equal(await page.evaluate(()=>window.roomSession.snapshot().show.phase),phase);
 await editor.getByRole('button',{name:'Close editor',exact:true}).click();
 assert.equal(await page.getByRole('textbox',{name:'Simulated player'}).count(),0);
 assert.deepEqual(errors,[]);console.log('PASS: drafts stay private and survive close; a pending take blocks dismissal; renderer rejection can retry; confirmed output commits once; room starts its own show clock');
}finally{await browser.close();}
