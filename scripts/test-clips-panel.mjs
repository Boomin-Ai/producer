import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
const {chromium}=await import('../tools/producer-mcp/node_modules/playwright-core/index.mjs');
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const origin=process.env.PRODUCER_TEST_URL??'http://127.0.0.1:1445/';
const shots=process.env.PRODUCER_CLIPS_SCREENSHOTS;
if(shots)await mkdir(shots,{recursive:true});
try{
 const page=await browser.newPage({viewport:{width:1100,height:850}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route(origin,r=>r.fulfill({contentType:'text/html',body:'<!doctype html><body style="margin:20px;background:#030a12"><div id="root"></div></body>'}));await page.route('https://**',r=>r.abort());await page.goto(origin);
 await page.evaluate(async()=>{
  const refresh=await import('/@react-refresh');refresh.default.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
  await import('/src/App.css');
  const R=await import('/node_modules/.vite/deps/react.js'),D=await import('/node_modules/.vite/deps/react-dom_client.js'),{ClipsPanel}=await import('/src/features/clips/ClipsPanel.tsx'),{useClips}=await import('/src/features/clips/useClips.ts');
  const h=R.createElement??R.default.createElement;window.calls=[];window.saved=[];
  window.capture={enabled:false,saving:false,room_id:null,settings:{seconds:60,memory_mb:256,output:'landscape'},elapsed_seconds:0,video_frames:0,error:null};
  window.__TAURI_INTERNALS__={convertFileSrc:path=>path,invoke:async(command,args={})=>{window.calls.push({command,args});
   if(command==='pref_get')return null;if(command==='pref_set')return;
   if(command==='clips_status')return {capture:window.capture,directory:'/Volumes/CanonA002/Producer Recordings'};
   if(command==='clips_list')return window.saved;
   if(command==='clips_enable'){window.capture={...window.capture,enabled:true,room_id:args.roomId,settings:args.settings,elapsed_seconds:5,video_frames:150};return window.capture;}
   if(command==='clips_disable'){window.capture={...window.capture,enabled:false,saving:false,room_id:null};return window.capture;}
   if(command==='clips_save'){window.capture={...window.capture,saving:true};await new Promise(resolve=>setTimeout(resolve,400));window.capture={...window.capture,saving:false};const files=[{path:'/Volumes/CanonA002/Producer Recordings/clip.mp4',output:'landscape',duration_ms:12450}];window.saved=[{id:'clip1',created_ms:Date.now(),status:'ready',requested_seconds:window.capture.settings.seconds,files,error:null}];return {id:'clip1',files};}
   if(command==='clips_pick_directory')return null;
   if(command==='live_reveal_file')return;
   throw Error('Unexpected command: '+command);
  }};
  window.props={width:360,height:800,compact:false,visible:true,show:true};
  function Harness(){const p=window.props,c=useClips('clip-test-room',true,p.visible,p.show);window.controller=c;return h('div',{style:{width:p.width,height:p.height,background:'#0a121c',border:'1px solid #20303b',borderRadius:14,overflow:'hidden'}},p.show?h(ClipsPanel,{controller:c,compact:p.compact}):null);}
  const root=(D.createRoot??D.default.createRoot)(document.getElementById('root'));window.render=patch=>{Object.assign(window.props,patch);root.render(h(Harness));};window.render({});
 });
 await page.getByRole('switch',{name:'Rolling capture'}).waitFor();
 assert.equal(await page.getByRole('switch').getAttribute('aria-checked'),'false');assert(await page.getByRole('button',{name:'Save last 1m',exact:true}).isDisabled());
 assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='clips_enable').length),0,'mount never starts capture');
 await page.getByRole('button',{name:'30s',exact:true}).click();await page.getByRole('button',{name:'Both',exact:true}).click();
 await page.getByRole('switch').click();await page.waitForFunction(()=>window.capture.enabled);
 assert.deepEqual(await page.evaluate(()=>window.calls.find(c=>c.command==='clips_enable').args.settings),{seconds:30,memory_mb:256,output:'both'});
 assert(await page.getByRole('button',{name:'15s',exact:true}).isDisabled(),'settings locked during rolling capture');
 await page.getByRole('button',{name:'Save last 30s',exact:true}).click();await page.getByRole('button',{name:'Saving…',exact:true}).waitFor();assert(await page.getByRole('button',{name:'Saving…',exact:true}).isDisabled());await page.getByRole('button',{name:'Preview landscape clip',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='clips_save').length),1,'one explicit save');
 assert(await page.getByText('Landscape · 0:12',{exact:true}).isVisible(),'actual container duration, not requested window');
 await page.evaluate(()=>window.render({show:false}));await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>window.capture.enabled),true,'hiding panel preserves buffer');assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='clips_disable').length),0);
 await page.evaluate(()=>window.render({show:true}));await page.getByRole('switch').waitFor();
 for(const width of [200,240,360,800]){
  await page.evaluate(width=>window.render({width,compact:false,height:780}),width);await page.waitForTimeout(100);
  const geo=await page.locator('.clips-body').evaluate(el=>({client:el.clientWidth,scroll:el.scrollWidth}));assert(geo.scroll<=geo.client+1,`expanded fits ${width}px: `+JSON.stringify(geo));
  if(shots&&[240,360,800].includes(width))await page.locator('#root').screenshot({path:`${shots}/clips-${width}.png`});
 }
 for(const width of [140,200,360,800]){
  await page.evaluate(width=>window.render({width,compact:true,height:56}),width);await page.waitForTimeout(100);
  const geo=await page.locator('.clips-console').evaluate(el=>({w:el.clientWidth,sw:el.scrollWidth,h:el.clientHeight}));assert(geo.sw<=geo.w+1&&geo.h<=56,`console fits ${width}px: `+JSON.stringify(geo));
  assert(await page.getByRole('button',{name:'Save last 30s',exact:true}).isEnabled());
  if(shots)await page.locator('#root').screenshot({path:`${shots}/clips-mini-${width}.png`});
 }
 await page.getByRole('button',{name:'Open Clips settings and saved clips'}).click();await page.getByRole('dialog').waitFor();await page.getByRole('button',{name:'Close Clips',exact:true}).click();assert.equal(await page.getByRole('dialog').count(),0);
 assert.equal(await page.evaluate(()=>window.capture.enabled),true,'closing expanded settings preserves buffer');
 await page.evaluate(()=>window.render({visible:false}));await page.waitForFunction(()=>!window.capture.enabled);assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='clips_disable').length),1,'leaving room stops capture');
 await page.evaluate(()=>window.render({visible:true,compact:false,width:360,height:780}));await page.getByRole('switch').waitFor();assert.equal(await page.getByRole('switch').getAttribute('aria-checked'),'false');assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='clips_enable').length),1,'reopen never silently restarts');
 assert.deepEqual(errors,[]);console.log('Clips panel: explicit capture, save receipts, local duration, dock lifecycle, compact/expanded sizes and settings dialog passed.');
}finally{await browser.close();}
