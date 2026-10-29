import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'/private/tmp/producer-arrangement-browser/node_modules/playwright-core/index.mjs');
const browser=await chromium.launch({executablePath:process.env.PRODUCER_CHROME??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const page=await browser.newPage({viewport:{width:1280,height:900}});
const errors=[];page.on('pageerror',error=>errors.push(error.message));
async function mount({room='arrangement-test',weather=false}={}) {
 await page.goto(process.env.PRODUCER_TEST_URL??'http://127.0.0.1:1436/');
 await page.evaluate(async({room,weather})=>{
  await import('/src/App.css');
  document.body.style.background='#0a0d13';
  const R=await import('/node_modules/.vite/deps/react.js'),D=await import('/node_modules/.vite/deps/react-dom_client.js');
  const {SetControlsPanel}=await import('/src/features/presentation/SetControlsPanel.tsx');
  const {RehearsalSession}=await import('/src/features/presentation/rehearsal.ts');
  const {parsePackage}=await import('/src/features/presentation/schema.ts');
  const raw=await(await fetch(weather?'/docs/shows/atmosphere.json':'/src/features/presentation/fixtures/after-hours.json')).json();
  if(!weather){
   delete raw.show;raw.set.controls=raw.set.controls.filter(c=>c.type!=='button'||!c.action.type.startsWith('show.'));
   delete raw.set.controlArrangement;
  }
  const doc=parsePackage(raw);window.panelSession=new RehearsalSession(doc,undefined,'rehearsal');
  if(weather){await window.panelSession.sendModule('sky','start');await window.panelSession.sendModule('studio','start');}
  const host=document.createElement('div');host.className='rm-dock-bottom';host.style.cssText='height:700px;width:1240px';
  host.innerHTML='<div class="rm-panel-setControls" style="container:panel / inline-size;height:100%;width:100%"><div class="rm-panel-body" style="height:100%;display:flex;flex-direction:column"></div></div>';document.body.replaceChildren(host);
  (D.createRoot??D.default.createRoot)(host.querySelector('.rm-panel-body')).render((R.createElement??R.default.createElement)(SetControlsPanel,{preferenceRoomId:room,session:window.panelSession,onChange:()=>{},output:{renderer:'native',active:true,busy:false,error:'',bindings:{},framing:{},sources:{items:[]},bind:()=>{},frame:()=>{},apply:async()=>{},returnToRoom:async()=>true}}));
 },{room,weather});
 await page.getByRole('button',{name:'Arrange controls',exact:true}).waitFor();
}
try {
 await mount();
 await page.evaluate(()=>{for(const key of Object.keys(localStorage))if(key.includes('arrangement'))localStorage.removeItem(key);});
 await mount();
 await page.getByRole('button',{name:'Arrange controls',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Arrange set controls'});
 await dialog.waitFor();
 const toggles=dialog.getByRole('checkbox',{name:/^Show .* in minimized bar$/});
 assert(await toggles.count()>1,'legacy sets expose explicit opt-in choices');
 assert.equal(await toggles.evaluateAll(nodes=>nodes.filter(n=>n.checked).length),0,'legacy sets have no guessed compact controls');
 const chosen=await toggles.nth(0).getAttribute('aria-label');
 await toggles.nth(0).check();
 await toggles.nth(1).check();
 const ordered=dialog.getByRole('list',{name:'Minimized control order'});
 const before=await ordered.locator('li > span:first-child').allTextContents();
 const expandedBefore=await dialog.getByRole('list',{name:'Expanded section order'}).innerText();
 await dialog.getByRole('button',{name:`Move ${before[1]} earlier in minimized bar`,exact:true}).click();
 assert.deepEqual(await ordered.locator('li > span:first-child').allTextContents(),[before[1],before[0]],'compact reordering works');
 assert.equal(await dialog.getByRole('list',{name:'Expanded section order'}).innerText(),expandedBefore,'compact reorder leaves expanded unchanged');
 const collapse=dialog.getByRole('checkbox',{name:/^Collapse /}).first();
 const collapseLabel=await collapse.getAttribute('aria-label');await collapse.check();
 await mount();await page.getByRole('button',{name:'Arrange controls',exact:true}).click();
 assert(await page.getByRole('checkbox',{name:chosen,exact:true}).isChecked(),'choice survives remount');
 assert(await page.getByRole('checkbox',{name:collapseLabel,exact:true}).isChecked(),'collapsed section survives remount');
 await mount({room:'different-arrangement-room'});await page.getByRole('button',{name:'Arrange controls',exact:true}).click();
 assert(!(await page.getByRole('checkbox',{name:chosen,exact:true}).isChecked()),'room preferences are isolated');
 await mount({weather:true});
 await page.getByRole('button',{name:'Arrange controls',exact:true}).click();
 assert(await toggles.evaluateAll(nodes=>nodes.some(n=>n.checked)),'Atmosphere explicitly authors minimized defaults');
 await page.keyboard.press('Escape');
 await page.screenshot({path:'/private/tmp/producer-control-arrangements-expanded.png'});
 await page.locator('.set-arranged-sections').getByRole('button',{name:'Today',exact:true}).click();
 assert.equal(await page.evaluate(()=>window.panelSession.moduleSnapshot().modules.sky.view),'today','expanded forecast controls call runtime');
 await page.evaluate(()=>{document.querySelector('.rm-dock-bottom').classList.add('slim');document.querySelector('.rm-dock-bottom').style.height='64px';});
 await page.locator('.set-compact-run').getByRole('button',{name:'Hourly',exact:true}).click();
 assert.equal(await page.evaluate(()=>window.panelSession.moduleSnapshot().modules.sky.view),'hourly','minimized forecast controls call same runtime');
 await page.locator('.set-compact-run').getByRole('button',{name:'City',exact:true}).click();
 await page.locator('.module-weather-popover:popover-open').getByPlaceholder('Search a city').waitFor();await page.keyboard.press('Escape');
 for(const width of [1240,700,420]){
  await page.setViewportSize({width:width+20,height:900});await page.evaluate(width=>document.querySelector('.rm-dock-bottom').style.width=width+'px',width);
  await page.getByRole('button',{name:'Arrange controls',exact:true}).click();await dialog.waitFor();await page.keyboard.press('Escape');
 }
 await page.screenshot({path:'/private/tmp/producer-control-arrangements-minimized.png'});
 assert.deepEqual(errors,[],'no React or runtime errors');
 console.log('PASS: explicit inclusion, saved host preferences, room isolation, Atmosphere defaults, narrow minimized access');
}finally{await browser.close();}
