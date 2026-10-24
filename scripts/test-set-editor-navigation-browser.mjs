import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'/private/tmp/producer-sets-v2-browser/node_modules/playwright-core/index.mjs');
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>console.error(e.message));await page.goto('http://127.0.0.1:1436/');
 await page.evaluate(async()=>{
  const R=await import('/node_modules/.vite/deps/react.js'),D=await import('/node_modules/.vite/deps/react-dom_client.js');
  const {SetControlsPanel}=await import('/src/features/presentation/SetControlsPanel.tsx');const {HEAD_TO_HEAD}=await import('/src/features/presentation/fixtures.ts');const componentSource=await (await fetch('/src/features/presentation/SetControlsPanel.tsx')).text();const runtimePath=componentSource.match(/from "([^"]*rehearsal\.ts[^"]*)"/)[1];const {RehearsalSession}=await import(runtimePath);
  window.__TAURI_INTERNALS__={transformCallback:()=>1,invoke:async(cmd)=>cmd==='set_library_list'?[]:1};window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
  const host=document.createElement('div');host.style.cssText='height:900px;width:100%';document.body.replaceChildren(host);const fixture=structuredClone(HEAD_TO_HEAD);fixture.set.layouts.push({...structuredClone(fixture.set.layouts[0]),id:'portrait-fit',label:'Portrait fit',width:1080,height:1920});window.editorSession=new RehearsalSession(fixture,undefined,'prepare');
  (D.createRoot??D.default.createRoot)(host).render((R.createElement??R.default.createElement)(SetControlsPanel,{session:window.editorSession,onChange:()=>{},output:{renderer:'native',active:false,busy:false,error:'',bindings:{},framing:{},sources:{items:[]},bind:()=>{},frame:()=>{},createSource:async()=>{},apply:async()=>{},returnToRoom:async()=>true}}));
 });
 await page.getByRole('button',{name:'Set settings',exact:true}).click();
 const dialog=page.locator('dialog[open]');const selector=dialog.getByRole('combobox',{name:'Edit segment',exact:true});
 const options=await selector.locator('option').evaluateAll(items=>items.map(i=>({value:i.value,text:i.textContent})));
 assert(options.length>=3);await selector.selectOption(options.at(-1).value);await page.waitForTimeout(100);
 assert.equal(await dialog.count(),1);assert.equal(await selector.inputValue(),options.at(-1).value);assert(await dialog.getByRole('button',{name:'Edit next segment',exact:true}).isDisabled());
 await dialog.getByRole('button',{name:'Edit previous segment',exact:true}).click();assert.equal(await selector.inputValue(),options.at(-2).value);
 await selector.selectOption(options[0].value);assert(await dialog.getByRole('button',{name:'Edit previous segment',exact:true}).isDisabled());
 assert.equal(await page.evaluate(()=>window.editorSession.snapshot().running),false);
 const geometry=await dialog.evaluate(el=>{const preview=el.querySelector('.set-preview').getBoundingClientRect(),details=el.querySelector('.set-editor-controls').getBoundingClientRect(),sources=el.querySelector('.set-editor-source-tray').getBoundingClientRect();return {sideBySide:preview.right<=details.left,bottom:sources.top>=Math.max(preview.bottom,details.bottom)-1,overflow:el.scrollWidth>el.clientWidth+1};});
 assert(geometry.sideBySide);assert(geometry.bottom);assert(!geometry.overflow);
 const assertCanvasFits=async()=>{
  const fit=await dialog.evaluate(el=>{
   const preview=el.querySelector('.set-preview').getBoundingClientRect(),viewport=el.querySelector('.set-editor-preview-viewport').getBoundingClientRect(),main=el.querySelector('.set-editor-layout').getBoundingClientRect();
   const ratio=parseFloat(getComputedStyle(el.querySelector('.set-editor-layout')).getPropertyValue('--set-preview-aspect'));
   return {fits:preview.left>=viewport.left-1&&preview.top>=viewport.top-1&&preview.right<=viewport.right+1&&preview.bottom<=viewport.bottom+1,mainFits:preview.bottom<=main.bottom+1,aspect:Math.abs(preview.width/preview.height-ratio)<.01,width:preview.width,height:preview.height};
  });assert(fit.fits&&fit.mainFits&&fit.aspect,JSON.stringify(fit));return fit;
 };
 for(const size of [{width:1440,height:1000},{width:1200,height:720},{width:1024,height:620}]){
  await page.setViewportSize(size);
  for(const layout of ['conversation','portrait-fit']){
   await dialog.getByRole('combobox',{name:'Edit layout',exact:true}).selectOption(layout);await page.waitForTimeout(80);
   const details=dialog.locator('.set-source-slots');await details.evaluate(el=>el.open=true);await page.waitForTimeout(80);const expanded=await assertCanvasFits();
   await details.evaluate(el=>el.open=false);await page.waitForTimeout(80);const collapsed=await assertCanvasFits();assert(collapsed.height>=expanded.height-1);
  }
 }
 await page.setViewportSize({width:1440,height:1000});await dialog.getByRole('combobox',{name:'Edit layout',exact:true}).selectOption('conversation');await dialog.locator('.set-source-slots').evaluate(el=>el.open=true);await page.waitForTimeout(80);
 await page.screenshot({path:'/private/tmp/producer-set-editor-landscape.png'});
 await page.setViewportSize({width:720,height:900});await page.waitForTimeout(100);assert.equal(await dialog.evaluate(el=>el.scrollWidth>el.clientWidth+1),false);
 console.log('PASS: any segment is editable without closing the dialog or starting playback; previous/next and responsive preview/details/source structure');
}finally{await browser.close();}
