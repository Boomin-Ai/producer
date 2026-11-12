import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??new URL('../tools/producer-mcp/node_modules/playwright-core/index.mjs',import.meta.url).href);
const folder=process.env.PRODUCER_CLASSIC_REVIEW??'/private/tmp/producer-classic-review';await mkdir(folder,{recursive:true});
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const origin=process.env.PRODUCER_TEST_URL??'http://127.0.0.1:1445/';
try{
 const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route(origin,r=>r.fulfill({contentType:'text/html',body:'<!doctype html><html><body style="margin:0;background:#070d14"></body></html>'}));await page.route('https://**',r=>r.abort());await page.goto(origin);
 await page.evaluate(async()=>{
  const refresh=await import('/@react-refresh');refresh.default.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;await import('/src/App.css');
  window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};window.__TAURI_INTERNALS__={invoke:async command=>command==='set_library_list'?[]:null,transformCallback:()=>1,convertFileSrc:p=>p};
  const R=await import('/node_modules/.vite/deps/react.js'),D=await import('/node_modules/.vite/deps/react-dom_client.js');
  const {SetControlsPanel}=await import('/src/features/presentation/SetControlsPanel.tsx'),panelSource=await(await fetch('/src/features/presentation/SetControlsPanel.tsx')).text(),{RehearsalSession}=await import(panelSource.match(/from "([^"]*rehearsal\.ts[^"]*)"/)[1]),{SetPreview}=await import('/src/features/presentation/SetPreview.tsx');
  window.doc=await(await fetch('/docs/shows/classic.json')).json();window.session=new RehearsalSession(window.doc,undefined,'prepare');window.testChanges=[];
  const shell=document.createElement('main');shell.innerHTML='<div id="dock" class="rm-dock-right"><section class="rm-panel rm-panel-setControls" data-in="right" style="height:100%;width:100%;container:panel / inline-size"><div class="rm-panel-body" style="height:100%;display:flex;flex-direction:column"></div></section></div><div id="visual" style="width:960px;position:relative"></div>';document.body.append(shell);
  window.panelRoot=(D.createRoot??D.default.createRoot)(shell.querySelector('.rm-panel-body'));window.visualRoot=(D.createRoot??D.default.createRoot)(document.getElementById('visual'));
  window.output={renderer:'native',requiredOrientations:['landscape','portrait'],layoutReadiness:Object.fromEntries(window.doc.set.layouts.map(l=>[l.id,{state:'ready'}])),active:true,busy:false,error:'',bindings:{},framing:{},sources:{items:[]},bind:()=>{},frame:()=>{},apply:async()=>{},returnToRoom:async()=>true};
  window.render=()=>window.panelRoot.render((R.createElement??R.default.createElement)(SetControlsPanel,{session:window.session,onChange:d=>window.testChanges.push(d),output:window.output,preferenceRoomId:'classic-browser'}));
  window.draw=()=>window.visualRoot.render((R.createElement??R.default.createElement)(SetPreview,{doc:window.doc,state:window.session.snapshot()}));
  window.configure=(dock,width,height,slim=false)=>{const el=document.getElementById('dock');el.className='rm-dock-'+dock+(slim?' slim':dock==='top'?' expanded':'');el.style.cssText=`width:${width}px;height:${height}px`;el.firstElementChild.setAttribute('data-in',dock);};window.configure('right',360,1000);window.render();
 });
 await page.getByRole('button',{name:'Solo',exact:true}).waitFor();
 const report=[];
 for(const dock of ['left','right','top','bottom'])for(const [width,height] of (['left','right'].includes(dock)?[[240,900],[320,900],[420,900]]:[[800,180],[1100,300],[1400,440]])){
  await page.setViewportSize({width:Math.max(width+20,960),height:1100});await page.evaluate(args=>window.configure(...args),[dock,width,height]);
  await page.waitForTimeout(60);
  const fit=await page.locator('.set-controls--standalone').evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth,pickers:[...el.querySelectorAll('.set-primary-layout button')].filter(b=>b.getClientRects().length).map(b=>b.textContent)}));assert(fit.scroll<=fit.width+1,JSON.stringify({dock,width,...fit}));assert.equal(fit.pickers.length,8);
  for(const label of ['Opening','Solo','Demo','Conversation','Roundtable','Spotlight','Break','Closing']){await page.getByRole('button',{name:label,exact:true}).click();}
  await page.getByRole('button',{name:'Demo',exact:true}).click();await page.getByRole('button',{name:'Use screen',exact:true}).click();assert(await page.getByRole('slider',{name:'Screen zoom'}).count());
  await page.getByRole('button',{name:'Use example',exact:true}).click();assert.equal(await page.getByRole('slider',{name:'Screen zoom'}).count(),0);
  await page.locator('.rm-panel-setControls').screenshot({path:`${folder}/controls-${dock}-${width}.png`});report.push({dock,width,height,layouts:8,overflow:false});
 }
 for(const dock of ['top','bottom'])for(const width of [300,450,800,1400]){
  await page.setViewportSize({width:Math.max(width+20,960),height:1100});await page.evaluate(args=>window.configure(...args),[dock,width,56,true]);await page.waitForTimeout(80);
  const fit=await page.locator('.set-controls-toolbar').evaluate(el=>{const lane=el.querySelector('.set-compact-run');return {width:el.clientWidth,scroll:el.scrollWidth,lane:{width:lane.clientWidth,scroll:lane.scrollWidth,display:getComputedStyle(lane).display}};});assert(fit.scroll<=fit.width+1,JSON.stringify({dock,width,...fit}));assert(fit.lane.width>=70,JSON.stringify({dock,width,...fit}));
  const mini=page.locator('.set-compact-run');await mini.getByRole('button',{name:'Show CTA',exact:true}).click();assert.equal(await page.evaluate(()=>window.session.snapshot().values.cue),'cta');await mini.getByRole('button',{name:'Clear overlay',exact:true}).click();
  await mini.getByRole('button',{name:'Light mode',exact:true}).click();assert.equal(await page.evaluate(()=>window.session.snapshot().values.theme),'light');await mini.getByRole('button',{name:'Dark mode',exact:true}).click();
  await page.getByRole('button',{name:'Choose layout',exact:true}).click();const menu=page.getByRole('dialog',{name:'Choose Set layout'});assert.equal(await menu.getByRole('button').count(),8);await menu.getByRole('button',{name:'Opening',exact:true}).click();assert.equal(await page.evaluate(()=>window.session.snapshot().layoutId),'opening-landscape');
  await page.getByRole('button',{name:'Arrange controls',exact:true}).click();assert(await page.getByRole('dialog',{name:'Arrange set controls'}).evaluate(el=>el.matches(':popover-open')));await page.keyboard.press('Escape');
  await page.locator('.rm-panel-setControls').screenshot({path:`${folder}/controls-${dock}-mini-${width}.png`});report.push({dock,width,height:56,overflow:false});
 }
 // Actual renderer previews, independently authored in both orientations/themes.
 await page.evaluate(()=>document.getElementById('dock').style.display='none');await page.setViewportSize({width:1100,height:2100});
 for(const theme of ['dark','light'])for(const layout of await page.evaluate(()=>window.doc.set.layouts.map(l=>({id:l.id,width:l.width,height:l.height})))){
  await page.evaluate(({theme,layout})=>{window.session.send({type:'field',key:'theme',value:theme});window.session.send({type:'field',key:'cue',value:'none'});window.session.send({type:'control',action:{type:'layout.select',layoutId:layout.id}});document.getElementById('visual').style.width=(layout.width>layout.height?960:540)+'px';window.draw();},{theme,layout});
  await page.locator('.set-preview iframe').waitFor();await page.waitForTimeout(650);await page.locator('.set-preview').screenshot({path:`${folder}/${theme}-${layout.id}.png`});
 }
 assert.deepEqual(errors,[]);await writeFile(`${folder}/report.json`,JSON.stringify(report,null,2));console.log(`PASS Classic browser: ${report.length} dock sizes, 8 view choices, screen controls, 32 renderer previews, no page errors.`);
}finally{await browser.close();}
