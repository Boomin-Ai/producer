import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const {chromium}=await import('../tools/producer-mcp/node_modules/playwright-core/index.mjs');
const browser=await chromium.launch({executablePath:process.env.PRODUCER_CHROME??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const origin=process.env.PRODUCER_TEST_URL??'http://127.0.0.1:1445/';
const shots=process.env.PRODUCER_CLIPS_SCREENSHOTS;
if(shots)await mkdir(shots,{recursive:true});
try{
 const page=await browser.newPage({viewport:{width:1100,height:850}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route(origin,r=>r.fulfill({contentType:'text/html',body:'<!doctype html><body style="margin:20px;background:#030a12"><div id="root"></div></body>'}));await page.route('https://**',r=>r.abort());await page.goto(origin);
 await page.route('**/clip-test-media/*.mp4',r=>r.fulfill({path:fileURLToPath(new URL('../docs/sets-v2/native/media/clip.mp4',import.meta.url)),contentType:'video/mp4'}));
 await page.evaluate(async()=>{
  const refresh=await import('/@react-refresh');refresh.default.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
  await import('/src/App.css');
  const R=await import('/node_modules/.vite/deps/react.js'),D=await import('/node_modules/.vite/deps/react-dom_client.js'),{ClipsPanel}=await import('/src/features/clips/ClipsPanel.tsx'),{useClips}=await import('/src/features/clips/useClips.ts');
  const h=R.createElement??R.default.createElement;window.calls=[];window.saved=[];window.prefs={};
  window.capture={enabled:false,saving:false,room_id:null,settings:{seconds:60,memory_mb:256,output:'landscape'},elapsed_seconds:0,video_frames:0,error:null};
  window.__TAURI_INTERNALS__={convertFileSrc:path=>'/clip-test-media/'+path.split('/').pop(),invoke:async(command,args={})=>{window.calls.push({command,args});
   if(command==='pref_get')return window.prefs[args.key]??null;if(command==='pref_set'){window.prefs[args.key]=args.value;return;}
   if(command==='clips_status'){const status=structuredClone({capture:window.capture,directory:'/Volumes/CanonA002/Producer Recordings'});if(window.holdStatus){window.holdStatus=false;await new Promise(resolve=>window.releaseStatus=resolve);}return status;}
   if(command==='clips_list')return window.saved;
   if(command==='clips_enable'){if(window.failEnable)throw Error('The recording folder is unavailable.');window.capture={...window.capture,enabled:true,room_id:args.roomId,settings:args.settings,elapsed_seconds:window.startEmpty?0:5,video_frames:window.startEmpty?0:150};return window.capture;}
   if(command==='clips_disable'){window.capture={...window.capture,enabled:false,saving:false,room_id:null};return window.capture;}
   if(command==='clips_save'){if(window.failSave)throw Error('The recording folder is unavailable.');window.capture={...window.capture,saving:true};await new Promise(resolve=>setTimeout(resolve,400));window.capture={...window.capture,saving:false};const files=[{path:'/Volumes/CanonA002/Producer Recordings/clip.mp4',output:'landscape',duration_ms:12450},{path:'/Volumes/CanonA002/Producer Recordings/clip-vertical.mp4',output:'portrait',duration_ms:11040}];window.saved=[{id:'clip1',created_ms:Date.now(),status:'ready',requested_seconds:window.capture.settings.seconds,files,error:null}];return {id:'clip1',files};}
   if(command==='clips_pick_directory')return null;
   if(command==='plugin:opener|reveal_item_in_dir')return;
   throw Error('Unexpected command: '+command);
  }};
  window.props={width:360,height:800,compact:false,visible:true,show:true};
  function Harness(){const p=window.props,c=useClips('clip-test-room',true,p.visible,p.show);window.controller=c;return h('div',{style:{width:p.width,height:p.height,background:'#0a121c',border:'1px solid #20303b',borderRadius:14,overflow:'hidden'}},p.show?h(ClipsPanel,{controller:c,compact:p.compact,horizontal:p.horizontal}):null);}
  const root=(D.createRoot??D.default.createRoot)(document.getElementById('root'));window.render=patch=>{Object.assign(window.props,patch);root.render(h(Harness));};window.render({});
 });
 await page.getByRole('switch',{name:'Rolling capture'}).waitFor();
 assert.equal(await page.getByRole('switch').getAttribute('aria-checked'),'false');assert(await page.getByRole('button',{name:'Save last 1m',exact:true}).isDisabled());
 assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='clips_enable').length),0,'mount never starts capture');
 await page.getByLabel('Capture window').selectOption('30');await page.getByRole('button',{name:'Clip settings',exact:true}).click();await page.getByLabel('Output',{exact:true}).selectOption('both');await page.getByRole('button',{name:'Clip settings',exact:true}).click();
 await page.getByRole('switch').click();await page.waitForFunction(()=>window.capture.enabled);
 assert.deepEqual(await page.evaluate(()=>window.calls.find(c=>c.command==='clips_enable').args.settings),{seconds:30,memory_mb:256,output:'both'});
 assert(await page.getByLabel('Capture window').isDisabled(),'settings locked during rolling capture');
 await page.getByRole('button',{name:'Save last 30s',exact:true}).click();await page.getByRole('button',{name:'Saving…',exact:true}).waitFor();assert(await page.getByRole('button',{name:'Saving…',exact:true}).isDisabled());await page.getByRole('button',{name:/^Preview Clip/}).click();
 const preview=page.getByRole('dialog');
 await preview.getByRole('button',{name:'Vertical',exact:true}).click();
 assert(await preview.getByText('0:11',{exact:true}).isVisible());
 await page.waitForFunction(()=>document.querySelector('.clips-preview video')?.readyState>=2);
 assert.match(await preview.locator('video').getAttribute('src'),/clip-vertical\.mp4$/);
 await preview.getByRole('button',{name:'Close clip preview'}).click();
 await page.locator('.clips-thumbnail video[data-loaded=true]').waitFor();
 await page.getByRole('button',{name:/^Actions for Clip/}).click();
 await page.getByRole('button',{name:'Reveal landscape in folder',exact:true}).click();assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='plugin:opener|reveal_item_in_dir').length),1,'cross-platform reveal uses the native opener');
 assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='clips_save').length),1,'one explicit save');
 assert(await page.getByText('Both formats · 0:12',{exact:true}).isVisible(),'one result with actual duration for both files');
 await page.getByRole('button',{name:/^Actions for Clip/}).click();
 await page.getByRole('button',{name:'Rename clip',exact:true}).click();
 await page.getByRole('textbox',{name:'Clip name'}).fill('Opening moment');
 await page.getByRole('button',{name:'Save name',exact:true}).click();
 await page.getByRole('button',{name:'Preview Opening moment',exact:true}).waitFor();
 assert.deepEqual(await page.evaluate(()=>JSON.parse(window.prefs['clips.names.clip-test-room'])),{clip1:'Opening moment'});
 await page.evaluate(()=>window.render({show:false}));await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>window.capture.enabled),true,'hiding panel preserves buffer');assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='clips_disable').length),0);
 await page.evaluate(()=>window.render({show:true}));await page.getByRole('switch').waitFor();
 for(const width of [200,240,360,800]){
  await page.evaluate(width=>window.render({width,compact:false,height:780}),width);await page.waitForTimeout(100);
  const geo=await page.locator('.clips-body').evaluate(el=>({client:el.clientWidth,scroll:el.scrollWidth}));assert(geo.scroll<=geo.client+1,`expanded fits ${width}px: `+JSON.stringify(geo));
  if(shots&&[240,360,800].includes(width))await page.locator('#root > div').screenshot({path:`${shots}/clips-${width}.png`});
 }
 for(const width of [340,760]){
  await page.evaluate(width=>window.render({width,horizontal:true,height:150}),width);
  await page.locator('.clips-body--horizontal').waitFor();
  const controls=await page.getByRole('button',{name:'Save last 30s',exact:true}).boundingBox();
  const list=await page.getByRole('region',{name:'Saved clips'}).boundingBox();
  const footer=await page.locator('.clips-location').boundingBox();
  assert(controls.x+controls.width<list.x&&list.y<controls.y,`clips sit alongside capture at ${width}px`);
  assert(controls.y+controls.height<footer.y,`capture action fits above the folder at ${width}px`);
  await page.getByRole('button',{name:'Clip settings',exact:true}).click();
  await page.getByLabel('Output',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Clip settings',exact:true}).click();
  if(shots)await page.locator('#root > div').screenshot({path:`${shots}/clips-expanded-${width}.png`});
 }
 for(const width of [140,200,245,246,345,346,360,390,392,800]){
  await page.evaluate(width=>window.render({width,compact:true,horizontal:false,height:56}),width);await page.waitForTimeout(100);
  const geo=await page.locator('.clips-console').evaluate(el=>({w:el.clientWidth,sw:el.scrollWidth,h:el.clientHeight}));assert(geo.sw<=geo.w+1&&geo.h<=56,`console fits ${width}px: `+JSON.stringify(geo));
  assert(await page.getByRole('button',{name:'Save last 30s',exact:true}).isEnabled());
  assert(await page.getByRole('switch',{name:'Rolling capture'}).isVisible());
  assert.equal(await page.getByLabel('Capture window').inputValue(),'30');
  assert(await page.getByLabel('Capture window').isDisabled(),'the active buffer keeps its configured window');
  assert(await page.getByRole('button',{name:'Preview last clip: Opening moment'}).isVisible());
  if(shots)await page.locator('#root > div').screenshot({path:`${shots}/clips-mini-${width}.png`});
 }
 await page.getByRole('button',{name:'Preview last clip: Opening moment'}).click();
 const lastPreview=page.getByRole('dialog',{name:'Opening moment'});
 await lastPreview.waitFor();
 assert.equal(await lastPreview.evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(16, 24, 35)');
 await page.getByRole('button',{name:'Close clip preview'}).click();
 await page.getByRole('button',{name:'Open Clips settings and saved clips, 1 saved'}).click();
 const library=page.getByRole('dialog',{name:'Clips',exact:true});
 await library.waitFor();
 assert.equal(await library.evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(16, 24, 35)');
 await page.getByRole('button',{name:'Close Clips',exact:true}).click();assert.equal(await page.getByRole('dialog').count(),0);
 assert.equal(await page.evaluate(()=>window.capture.enabled),true,'closing expanded settings preserves buffer');
 await page.evaluate(()=>window.render({visible:false}));await page.waitForFunction(()=>!window.capture.enabled);assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='clips_disable').length),1,'leaving room stops capture');
 await page.evaluate(()=>window.render({visible:true,compact:false,width:360,height:780}));await page.getByRole('switch').waitFor();assert.equal(await page.getByRole('switch').getAttribute('aria-checked'),'false');assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='clips_enable').length),1,'reopen never silently restarts');
 await page.evaluate(()=>window.failEnable=true);await page.getByRole('switch').click();await page.getByRole('button',{name:'Try capture again',exact:true}).waitFor();
 await page.evaluate(()=>window.controller.refresh());assert(await page.getByRole('button',{name:'Try capture again',exact:true}).isVisible(),'status polling preserves a failed action until retry');
 await page.evaluate(()=>window.failEnable=false);await page.getByRole('button',{name:'Try capture again',exact:true}).click();await page.waitForFunction(()=>window.capture.enabled);
 await page.evaluate(()=>window.failSave=true);await page.getByRole('button',{name:'Save last 30s',exact:true}).click();await page.getByRole('button',{name:'Try saving again',exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.capture.enabled),true,'a destination error does not silently stop an otherwise healthy buffer');
 await page.evaluate(()=>window.failSave=false);await page.getByRole('button',{name:'Try saving again',exact:true}).click();await page.waitForFunction(()=>window.controller.pending===null&&window.controller.error==='');
 await page.getByRole('switch').click();await page.waitForFunction(()=>!window.capture.enabled);
 await page.evaluate(()=>window.startEmpty=true);await page.getByRole('switch').click();
 await page.getByText('Waiting for video…',{exact:true}).waitFor();assert(await page.getByRole('button',{name:'Save last 30s',exact:true}).isDisabled());
 assert.equal(await page.locator('.clips-status i').getAttribute('data-on'),'false','no green ready light before encoded frames');
 await page.evaluate(async()=>{window.capture={...window.capture,elapsed_seconds:48,video_frames:0};await window.controller.refresh();});
 await page.getByRole('button',{name:'Restart capture',exact:true}).waitFor();
 assert(await page.locator('.clips-error').evaluate(el=>el.getBoundingClientRect().top<document.querySelector('.clips-recent').getBoundingClientRect().top),'startup problem is above saved clips');
 await page.evaluate(()=>window.startEmpty=false);await page.getByRole('button',{name:'Restart capture',exact:true}).click();
 await page.waitForFunction(()=>window.controller.pending===null&&window.controller.capture.video_frames>0);assert(await page.getByRole('button',{name:'Save last 30s',exact:true}).isEnabled());
 await page.evaluate(async()=>{window.capture={...window.capture,enabled:false,error:'Vertical capture did not receive frames.'};await window.controller.refresh();});
 await page.getByRole('button',{name:'Try capture again',exact:true}).waitFor();assert(await page.getByRole('alert').isVisible(),'native startup failure stays visible');
 await page.getByRole('button',{name:'Try capture again',exact:true}).click();await page.waitForFunction(()=>window.controller.pending===null&&window.controller.capture.enabled);
 await page.getByRole('switch').click();await page.waitForFunction(()=>!window.capture.enabled);
 // A slow status response must not undo a newer capture action.
 await page.getByRole('switch').click();await page.waitForFunction(()=>window.controller.capture.enabled);
 await page.evaluate(()=>{window.holdStatus=true;window.staleRefresh=window.controller.refresh();});await page.waitForFunction(()=>!!window.releaseStatus);
 await page.getByRole('switch').click();await page.waitForFunction(()=>!window.controller.capture.enabled);
 await page.evaluate(async()=>{window.releaseStatus();await window.staleRefresh;});
 assert.equal(await page.evaluate(()=>window.controller.capture.enabled),false,'late status must not resurrect a stopped buffer');
 await page.evaluate(()=>window.render({compact:true,width:140,height:56}));
 await page.getByLabel('Capture window').selectOption('60');
 await page.getByRole('switch',{name:'Rolling capture'}).click();
 await page.waitForFunction(()=>window.controller.capture.enabled);
 assert.equal(await page.evaluate(()=>window.capture.settings.seconds),60);
 await page.getByRole('button',{name:'Save last 1m',exact:true}).click();
 await page.waitForFunction(()=>window.controller.pending===null);
 await page.getByRole('switch',{name:'Rolling capture'}).click();
 await page.waitForFunction(()=>!window.controller.capture.enabled);
 assert.deepEqual(errors,[]);console.log('Clips panel: explicit capture, save receipts, local duration, dock lifecycle, compact/expanded sizes, settings dialog and real retry actions passed.');
}finally{await browser.close();}
