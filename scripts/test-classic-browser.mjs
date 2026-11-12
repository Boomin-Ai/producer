import assert from 'node:assert/strict';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??new URL('../tools/producer-mcp/node_modules/playwright-core/index.mjs',import.meta.url).href);
const folder=process.env.PRODUCER_CLASSIC_REVIEW??join(tmpdir(),'producer-classic-review');await mkdir(folder,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.PRODUCER_CHROME??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const origin=process.env.PRODUCER_TEST_URL??'http://127.0.0.1:1445/';
try{
 const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('Page error:',e.message);});
 await page.route(origin,r=>r.fulfill({contentType:'text/html',body:'<!doctype html><html><body style="margin:0;background:#070d14"></body></html>'}));await page.route('https://**',r=>r.abort());await page.goto(origin);
 await page.evaluate(async()=>{
  const refresh=await import('/@react-refresh');refresh.default.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;await import('/src/App.css');
  window.nativeActions=[];const track={id:'in-case',path:'/fixture/in-case.mp3',title:'IN CASE',artist:'Producer',duration_ms:187298,cover:null,bpm:null,analyzed:false,fingerprint:'fixture'},deck=()=>({track:null,position_ms:0,duration_ms:0,state:5,looping:false});window.djStatus={decks:[deck(),deck()],active:0,volume:.65,crossfader:0,fade:2,repeat:false,shuffle:false,duck:false,transitioning:false,error:null};
  window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
   if(command==='set_library_list')return [];
   if(command==='starter_audio_install')return {version:'fixture',assets:[{id:'waiting-in-case',kind:'music',name:'IN CASE',path:track.path}]};
   if(command==='dj_library')return {folder:'',tracks:[track],playlists:[]};
   if(command==='dj_control'){const a=args.action,s=window.djStatus;if(a.kind!=='status'){window.nativeActions.push(a);const d=s.decks[a.deck??s.active];if(a.kind==='load'){d.track=a.track;if(window.holdLoad){window.holdLoad=false;await new Promise(resolve=>window.finishLoad=resolve);}}if(a.kind==='play')d.state=1;if(a.kind==='pause')d.state=4;if(a.kind==='stop'){d.state=5;d.position_ms=0;}if(a.kind==='mix')Object.assign(s,a);}return structuredClone(s);}
   return null;
  },transformCallback:()=>1,convertFileSrc:p=>p};
  const R=await import('/node_modules/.vite/deps/react.js'),D=await import('/node_modules/.vite/deps/react-dom_client.js');
  const {SetControlsPanel}=await import('/src/features/presentation/SetControlsPanel.tsx'),panelSource=await(await fetch('/src/features/presentation/SetControlsPanel.tsx')).text(),{RehearsalSession}=await import(panelSource.match(/from "([^"]*rehearsal\.ts[^"]*)"/)[1]),{SetPreview}=await import('/src/features/presentation/SetPreview.tsx');
  window.doc=await(await fetch('/docs/shows/classic.json')).json();window.doc.set.controls.push({id:'pink',type:'button',label:'Pink accent',action:{type:'value.set',key:'glowColor',value:'#F4A6CD'}});window.doc.set.controlArrangement.sections.find(s=>s.id==='look').controls.push('set:pink');window.session=new RehearsalSession(window.doc,undefined,'prepare');window.testChanges=[];
  const shell=document.createElement('main');shell.innerHTML='<div id="dock" class="rm-dock-right"><section class="rm-panel rm-panel-setControls" data-in="right" style="height:100%;width:100%;container:panel / inline-size"><div class="rm-panel-body" style="height:100%;display:flex;flex-direction:column"></div></section></div><div id="visual" style="width:960px;position:relative"></div>';document.body.append(shell);
  window.panelRoot=(D.createRoot??D.default.createRoot)(shell.querySelector('.rm-panel-body'));window.visualRoot=(D.createRoot??D.default.createRoot)(document.getElementById('visual'));
  window.output={renderer:'native',requiredOrientations:['landscape','portrait'],layoutReadiness:Object.fromEntries(window.doc.set.layouts.map(l=>[l.id,{state:'ready'}])),active:true,busy:false,error:'',bindings:{host:'camera-test'},framing:{},sources:{items:[{id:'camera-test',kind:'camera'}]},cameraBackground:{read:async()=> 'framed',set:async(_slot,_source,mode)=>mode,subscribe:()=>()=>{}},bind:()=>{},frame:()=>{},apply:async()=>{},returnToRoom:async()=>true};
  window.render=()=>window.panelRoot.render((R.createElement??R.default.createElement)(SetControlsPanel,{session:window.session,onChange:d=>window.testChanges.push(d),output:window.output,preferenceRoomId:'classic-browser'}));
  window.draw=()=>window.visualRoot.render((R.createElement??R.default.createElement)(SetPreview,{doc:window.doc,state:window.session.snapshot()}));
  window.configure=(dock,width,height,slim=false)=>{const el=document.getElementById('dock');el.className='rm-dock-'+dock+(slim?' slim':dock==='top'?' expanded':'');el.style.cssText=`width:${width}px;height:${height}px`;el.firstElementChild.setAttribute('data-in',dock);};window.configure('right',360,1000);window.render();
 });
 await page.getByRole('button',{name:'Solo',exact:true}).waitFor();
 const cues=page.locator('[data-section-id="authored:cues"]');
 for(const label of ['Name card','Teaching card','Show CTA']){
  await cues.getByRole('button',{name:label,exact:true}).click();
  const clear=cues.getByRole('button',{name:'Clear overlay',exact:true}),position=await clear.boundingBox();
  await clear.dblclick();
  assert.equal(await page.evaluate(()=>window.session.snapshot().values.cue),'none','Repeated Clear must never hit a newly substituted CTA button');
  assert(await clear.isDisabled(),'Clear remains visible but unavailable when no overlay is active');
  assert.deepEqual(await clear.boundingBox(),position,'Clear keeps its position instead of being replaced by another cue');
  await page.mouse.click(position.x+position.width/2,position.y+position.height/2);assert.equal(await page.evaluate(()=>window.session.snapshot().values.cue),'none');
 }
 await page.getByRole('button',{name:'Opening',exact:true}).click();
 assert.equal(await page.locator('.set-arranged-section h4>button').first().getAttribute('aria-label'),'Collapse Layout controls section');
 await page.getByRole('button',{name:'Solo',exact:true}).click();
 assert.equal(await page.getByRole('group',{name:'Host camera background',exact:true}).count(),0,'Classic omits camera background controls');
 await page.evaluate(()=>{const doc=structuredClone(window.doc);delete doc.set.controlArrangement.cameraBackground;window.session=new window.session.constructor(doc,undefined,'prepare');window.render();});
 await page.getByRole('button',{name:'Host camera Framed',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Host camera Cutout',exact:true}).count(),1,'other Sets keep their existing camera controls by default');
 await page.evaluate(()=>{window.session=new window.session.constructor(window.doc,undefined,'prepare');window.render();});
 await page.getByRole('button',{name:'Host camera Framed',exact:true}).waitFor({state:'detached'});
 await page.getByRole('button',{name:'Expand Look & feel section',exact:true}).click();
 await page.getByRole('button',{name:'Pink accent',exact:true}).click();
 assert.equal(await page.evaluate(()=>window.session.snapshot().values.glowColor),'#F4A6CD');
 assert.equal(await page.getByRole('button',{name:'Mint accent',exact:true}).count(),1);assert.equal(await page.getByRole('button',{name:'Silver accent',exact:true}).count(),1);
 await page.getByRole('button',{name:'Mint accent',exact:true}).click();
 await page.getByRole('button',{name:'Collapse Look & feel section',exact:true}).click();
 // Registered music is explicit, shared with DJ and never starts on layout selection.
 await page.getByRole('button',{name:'Opening',exact:true}).click();
 await page.getByRole('button',{name:'Play music',exact:true}).waitFor();
 await page.waitForFunction(()=>document.querySelector('select[aria-label="Waiting music track"]')?.value==='in-case');
 // Accordion headers stay flush, including on hover; only expanded contents have a frame.
 const musicSection=page.locator('.set-arranged-section').filter({has:page.locator('.set-music')});
 const header=musicSection.locator('h4>button');await header.hover();
 const spacing=await musicSection.evaluate(el=>{const section=getComputedStyle(el),header=getComputedStyle(el.querySelector('h4>button')),body=getComputedStyle(el.querySelector('.set-arranged-section-controls'));return {padding:section.padding,border:section.borderTopWidth,headerPadding:header.padding,headerBackground:header.backgroundColor,bodyPadding:body.padding,bodyBorder:body.borderTopWidth};});
 assert.deepEqual(spacing,{padding:'0px',border:'0px',headerPadding:'0px',headerBackground:'rgba(0, 0, 0, 0)',bodyPadding:'8px',bodyBorder:'1px'});
 await header.click();assert(await musicSection.locator('.set-arranged-section-controls').isHidden());await header.click();
 assert((await page.locator('.set-music:visible').boundingBox()).height<200,'Music slider must size to its content in the column player');
 assert.deepEqual(await page.evaluate(()=>window.nativeActions),[],'Opening must not autoplay');
 await page.getByRole('button',{name:'Play music',exact:true}).click();
 await page.getByRole('button',{name:'Pause music',exact:true}).waitFor();
 assert.deepEqual(await page.evaluate(()=>window.nativeActions.map(a=>a.kind)),['load','play']);
 await page.evaluate(()=>window.djStatus.decks[0].state=2);await page.getByText('Starting…',{exact:true}).first().waitFor();
 await page.getByRole('button',{name:'Pause music',exact:true}).click();await page.getByRole('button',{name:'Play music',exact:true}).waitFor();
 const volume=page.getByRole('slider',{name:'Music volume',exact:true});await volume.focus();await page.keyboard.press('End');
 await page.waitForFunction(()=>window.nativeActions.some(a=>a.kind==='mix'&&a.volume===1));
 const mix=await page.evaluate(()=>window.nativeActions.findLast(a=>a.kind==='mix'));assert.equal(mix.fade,2);assert.equal(mix.crossfader,0);
 await page.getByRole('button',{name:'Stop music',exact:true}).click();await page.waitForFunction(()=>window.nativeActions.some(a=>a.kind==='stop'));
 await page.getByRole('button',{name:'Solo',exact:true}).click();assert.equal(await page.getByRole('slider',{name:'Music volume',exact:true}).count(),0);
 console.log('PASS registered music: no autoplay, load/play/pause/stop, mixer-preserving volume and layout visibility.');
 const report=[];
 for(const dock of ['left','right','top','bottom'])for(const [width,height] of (['left','right'].includes(dock)?[[240,900],[320,900],[420,900]]:[[800,180],[1100,300],[1400,440]])){
  await page.setViewportSize({width:Math.max(width+20,960),height:1100});await page.evaluate(args=>window.configure(...args),[dock,width,height]);
  await page.waitForTimeout(60);
  const fit=await page.locator('.set-controls--standalone').evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth,pickers:[...el.querySelectorAll('.set-primary-layout button')].filter(b=>b.getClientRects().length).map(b=>b.textContent)}));assert(fit.scroll<=fit.width+1,JSON.stringify({dock,width,...fit}));assert.equal(fit.pickers.length,8);
  const sections=await page.locator('.set-arranged-section').evaluateAll(items=>items.map(el=>({padding:getComputedStyle(el).padding,headerPadding:getComputedStyle(el.querySelector('h4>button')).padding})));assert(sections.every(s=>s.padding==='0px'&&s.headerPadding==='0px'),JSON.stringify({dock,width,sections}));
  for(const label of ['Opening','Solo','Demo','Conversation','Roundtable','Spotlight','Break','Closing']){await page.getByRole('button',{name:label,exact:true}).click();}
  await page.getByRole('button',{name:'Demo',exact:true}).click();await page.getByRole('button',{name:'Use screen',exact:true}).click();assert(await page.getByRole('slider',{name:'Screen zoom'}).count());
  await page.getByRole('button',{name:'Use example',exact:true}).click();assert.equal(await page.getByRole('slider',{name:'Screen zoom'}).count(),0);
  await page.locator('.rm-panel-setControls').screenshot({path:`${folder}/controls-${dock}-${width}.png`});report.push({dock,width,height,layouts:8,overflow:false});
 }
 for(const dock of ['top','bottom'])for(const width of [300,450,800,1400]){
  await page.setViewportSize({width:Math.max(width+20,960),height:1100});await page.evaluate(args=>window.configure(...args),[dock,width,56,true]);await page.waitForTimeout(80);
  const fit=await page.locator('.set-controls-toolbar').evaluate(el=>{const lane=el.querySelector('.set-compact-run');return {width:el.clientWidth,scroll:el.scrollWidth,lane:{width:lane.clientWidth,scroll:lane.scrollWidth,display:getComputedStyle(lane).display}};});assert(fit.scroll<=fit.width+1,JSON.stringify({dock,width,...fit}));assert(fit.lane.width>=70,JSON.stringify({dock,width,...fit}));
  const mini=page.locator('.set-compact-run');await mini.getByRole('button',{name:'Show CTA',exact:true}).click();assert.equal(await page.evaluate(()=>window.session.snapshot().values.cue),'cta');const clear=mini.getByRole('button',{name:'Clear overlay',exact:true});await clear.dblclick();assert.equal(await page.evaluate(()=>window.session.snapshot().values.cue),'none');assert(await clear.isDisabled());
  await mini.getByRole('button',{name:'Light mode',exact:true}).click();assert.equal(await page.evaluate(()=>window.session.snapshot().values.theme),'light');await mini.getByRole('button',{name:'Dark mode',exact:true}).click();
  await page.getByRole('button',{name:'Choose layout',exact:true}).click();const menu=page.getByRole('dialog',{name:'Choose Set layout'});assert.equal(await menu.getByRole('button').count(),8);await menu.getByRole('button',{name:'Opening',exact:true}).click();assert.equal(await page.evaluate(()=>window.session.snapshot().layoutId),'opening-landscape');
  await page.getByRole('button',{name:'Open waiting music',exact:true}).click();const music=page.locator('.set-music-popover:popover-open');await music.waitFor();assert(await music.getByRole('button',{name:'Play music',exact:true}).isEnabled());const rect=await music.boundingBox();assert(rect.x>=0&&rect.x+rect.width<=Math.max(width+20,960));await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Arrange controls',exact:true}).click();assert(await page.getByRole('dialog',{name:'Arrange set controls'}).evaluate(el=>el.matches(':popover-open')));await page.keyboard.press('Escape');
  await page.locator('.rm-panel-setControls').screenshot({path:`${folder}/controls-${dock}-mini-${width}.png`});report.push({dock,width,height:56,overflow:false});
 }
 // A Set replacement can retain the component ID; it must still fence old playback.
 await page.evaluate(async()=>{
  window.panelRoot.unmount();document.getElementById('dock').style.display='none';
  const R=await import('/node_modules/.vite/deps/react.js'),D=await import('/node_modules/.vite/deps/react-dom_client.js'),{SetMusicControls}=await import('/src/features/presentation/SetMusicControls.tsx');
  const node=document.createElement('div');node.id='music-owner-proof';document.body.append(node);window.musicRoot=(D.createRoot??D.default.createRoot)(node);
  window.paintMusic=definition=>window.musicRoot.render((R.createElement??R.default.createElement)(SetMusicControls,{definition}));window.nativeActions=[];window.djStatus.decks[0].track=null;window.djStatus.decks[0].state=5;window.paintMusic(window.doc.set.operatorComponents[0]);
 });
 await page.getByRole('button',{name:'Play music',exact:true}).waitFor();await page.waitForFunction(()=>document.querySelector('#music-owner-proof select')?.value==='in-case');
 await page.evaluate(()=>window.holdLoad=true);await page.getByRole('button',{name:'Play music',exact:true}).click();await page.waitForFunction(()=>!!window.finishLoad);
 await page.evaluate(()=>window.paintMusic(structuredClone(window.doc.set.operatorComponents[0])));await page.waitForTimeout(30);await page.evaluate(()=>window.finishLoad());await page.waitForTimeout(100);
 assert.deepEqual(await page.evaluate(()=>window.nativeActions.map(a=>a.kind)),['load'],'Replacement owner must not play an old asynchronous request');
 await page.evaluate(()=>{window.musicRoot.unmount();document.getElementById('music-owner-proof').remove();});
 console.log('PASS registered music: Set replacement with the same component ID fences an in-flight load before play.');
 // Actual renderer previews, independently authored in both orientations/themes.
 await page.evaluate(()=>document.getElementById('dock').style.display='none');await page.setViewportSize({width:1100,height:2100});
 for(const theme of ['dark','light'])for(const layout of await page.evaluate(()=>window.doc.set.layouts.map(l=>({id:l.id,width:l.width,height:l.height})))){
  await page.evaluate(({theme,layout})=>{window.session.send({type:'field',key:'theme',value:theme});window.session.send({type:'field',key:'cue',value:'none'});window.session.send({type:'control',action:{type:'layout.select',layoutId:layout.id}});document.getElementById('visual').style.width=(layout.width>layout.height?960:540)+'px';window.draw();},{theme,layout});
  await page.locator('.set-preview iframe').waitFor();await page.waitForTimeout(650);assert.equal(await page.locator('.set-preview [role=alert]').count(),0,`Renderer failed for ${theme} ${layout.id}`);await page.locator('.set-preview').screenshot({path:`${folder}/${theme}-${layout.id}.png`});
 }
 // Cue cards are centered, full-canvas overlays in both formats and palettes.
 for(const theme of ['dark','light'])for(const cue of ['name','note','cta']){
  const visual=await page.evaluate(async({theme,cue})=>{const {auditVisuals}=await import('/src/features/presentation/authoring/visualBrowser.ts');const doc=structuredClone(window.doc);doc.set.layouts=doc.set.layouts.filter(l=>l.id.startsWith('solo-'));doc.set.views={solo:doc.set.views.solo};doc.set.values.theme.default=theme;doc.set.values.cue.default=cue;return auditVisuals(doc);},{theme,cue});
  assert.equal(visual.issues.filter(i=>i.code==='text_fit'||i.code==='native_budget_estimate').length,0,JSON.stringify({theme,cue,issues:visual.issues}));
  for(const format of ['landscape','portrait']){
   await page.evaluate(({theme,cue,format})=>{window.session.send({type:'field',key:'theme',value:theme});window.session.send({type:'field',key:'cue',value:cue});window.session.send({type:'control',action:{type:'layout.select',layoutId:'solo-'+format}});document.getElementById('visual').style.width=(format==='landscape'?960:540)+'px';window.draw();},{theme,cue,format});
   await page.waitForTimeout(500);assert.equal(await page.locator('.set-preview [role=alert]').count(),0);await page.locator('.set-preview').screenshot({path:`${folder}/${theme}-cue-${cue}-${format}.png`});
  }
 }
 console.log('PASS Classic cues: 12 modal previews; measured typography and native batching estimates in both formats/themes; camera background opt-out preserves other Sets.');
 assert.deepEqual(errors,[]);await writeFile(`${folder}/report.json`,JSON.stringify(report,null,2));console.log(`PASS Classic browser: ${report.length} dock sizes, 8 view choices, screen controls, 32 renderer previews, no page errors.`);
}finally{await browser.close();}
