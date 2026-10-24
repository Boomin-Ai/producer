import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'/private/tmp/producer-sets-v2-browser/node_modules/playwright-core/index.mjs');
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>console.error(e.message));await page.goto('http://127.0.0.1:1436/');
 await page.evaluate(async()=>{
  const R=await import('/node_modules/.vite/deps/react.js'),D=await import('/node_modules/.vite/deps/react-dom_client.js');
  const {SetControlsPanel}=await import('/src/features/presentation/SetControlsPanel.tsx');const {HEAD_TO_HEAD}=await import('/src/features/presentation/fixtures.ts');const componentSource=await (await fetch('/src/features/presentation/SetControlsPanel.tsx')).text();const runtimePath=componentSource.match(/from "([^"]*rehearsal\.ts[^"]*)"/)[1];const {RehearsalSession}=await import(runtimePath);
  window.__TAURI_INTERNALS__={transformCallback:()=>1,invoke:async()=>1};window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
  const host=document.createElement('div');host.style.cssText='height:900px;width:100%';document.body.replaceChildren(host);window.editorSession=new RehearsalSession(HEAD_TO_HEAD,undefined,'prepare');
  (D.createRoot??D.default.createRoot)(host).render((R.createElement??R.default.createElement)(SetControlsPanel,{session:window.editorSession,onChange:()=>{},output:{renderer:'native',active:false,busy:false,error:'',bindings:{},framing:{},sources:{items:[]},bind:()=>{},frame:()=>{},createSource:async()=>{},apply:async()=>{},returnToRoom:async()=>true}}));
 });
 await page.getByRole('button',{name:'Set edit',exact:true}).click();
 const dialog=page.locator('dialog[open]');const selector=dialog.getByRole('combobox',{name:'Edit segment',exact:true});
 const options=await selector.locator('option').evaluateAll(items=>items.map(i=>({value:i.value,text:i.textContent})));
 assert(options.length>=3);await selector.selectOption(options.at(-1).value);await page.waitForTimeout(100);
 assert.equal(await dialog.count(),1);assert.equal(await selector.inputValue(),options.at(-1).value);assert(await dialog.getByRole('button',{name:'Edit next segment',exact:true}).isDisabled());
 await dialog.getByRole('button',{name:'Edit previous segment',exact:true}).click();assert.equal(await selector.inputValue(),options.at(-2).value);
 await selector.selectOption(options[0].value);assert(await dialog.getByRole('button',{name:'Edit previous segment',exact:true}).isDisabled());
 assert.equal(await page.evaluate(()=>window.editorSession.snapshot().running),false);
 const geometry=await dialog.evaluate(el=>{const preview=el.querySelector('.set-preview').getBoundingClientRect(),details=el.querySelector('.set-editor-controls').getBoundingClientRect(),sources=el.querySelector('.set-editor-source-tray').getBoundingClientRect();return {sideBySide:preview.right<=details.left,bottom:sources.top>=Math.max(preview.bottom,details.bottom)-1,overflow:el.scrollWidth>el.clientWidth+1};});
 assert(geometry.sideBySide);assert(geometry.bottom);assert(!geometry.overflow);
 await page.screenshot({path:'/private/tmp/producer-set-editor-landscape.png'});
 await page.setViewportSize({width:720,height:900});await page.waitForTimeout(100);assert.equal(await dialog.evaluate(el=>el.scrollWidth>el.clientWidth+1),false);
 console.log('PASS: any segment is editable without closing the dialog or starting playback; previous/next and responsive preview/details/source structure');
}finally{await browser.close();}
