import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'playwright-core');
const origin=process.env.PRODUCER_TEST_URL??'http://127.0.0.1:1436/';
const browser=await chromium.launch({executablePath:process.env.PRODUCER_CHROME??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
  const page=await browser.newPage({viewport:{width:1180,height:760}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route(origin,route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body style="margin:0;background:#080e16"><div id="root"></div><main style="padding:40px;color:white">ROOM CONTENT BEHIND THE DROPDOWN</main></body></html>'}));
  await page.route('https://**',route=>route.abort());
  await page.goto(origin);
  await page.evaluate(async()=>{
    const refresh=await import('/@react-refresh');refresh.default.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
    await import('/src/App.css');
    const R=await import('/node_modules/.vite/deps/react.js'),D=await import('/node_modules/.vite/deps/react-dom_client.js');
    const {RoomTransportControls,ToolbarButton}=await import('/src/components/RoomToolbar.tsx'),{NoticeHost}=await import('/src/components/Notice.tsx');
    const h=R.createElement??R.default.createElement;
    window.root=(D.createRoot??D.default.createRoot)(document.getElementById('root'));window.calls=[];
    window.props={visible:true,recording:false,recordingPath:null,recordingElapsed:'0:00',recordingBusy:false,recordDisabled:false,streaming:false,streamBusy:false,streamDisabled:false,destinations:[{id:'twitch',label:'Twitch · Creator',icon:'T'},{id:'youtube',label:'YouTube · Studio',icon:'Y'}],audienceLabel:'Boomin',program:'Current room Set',streamFormat:'1080p · 30 fps · Landscape',recordFormat:'1080p · 30 fps · Landscape + portrait · Two MP4 files',recordingFolder:'Movies / Producer',onOpen:()=>window.calls.push('review-open'),onRecord:async()=>{window.calls.push('record');if(window.failRecord)return false;return true;},onStream:async()=>{window.calls.push('start-stream');if(window.delayStream)await new Promise(resolve=>window.finishStream=resolve);return true;},onStopStream:async()=>{window.calls.push('stop-stream');return true;}};
    window.render=patch=>{window.props={...window.props,...patch};window.root.render(h('header',{className:'rm-top'},h(ToolbarButton,{label:'Edit layout',tooltip:'Edit layout · Keyboard shortcut',tooltipAlign:'start'},h('svg',{width:18,height:18},h('path',{d:'M4 4h10v10H4z'}))),h(NoticeHost,{compact:true}),h('div',{className:'rm-top-right'},h(RoomTransportControls,window.props))));};window.render({});
  });
  const actions=()=>page.evaluate(()=>window.calls.filter(call=>call!=='review-open'));
  const dialog=()=>page.getByRole('dialog');
  await page.getByRole('button',{name:'Go live',exact:true}).click();
  await page.getByRole('heading',{name:'Ready to go live?'}).waitFor();
  assert.equal(await dialog().getAttribute('aria-modal'),'false');
  assert.equal(await dialog().getByRole('listitem').count(),2);
  await dialog().getByText('Twitch · Creator',{exact:true}).waitFor();
  await dialog().getByText('Boomin audience access is already open, independently of this stream.',{exact:true}).waitFor();
  assert.deepEqual(await actions(),[],'opening a review never starts a stream');
  assert.equal(await dialog().evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(17, 25, 35)','confirmation is opaque over room panels');
  await dialog().getByRole('button',{name:'Cancel',exact:true}).click();assert.deepEqual(await actions(),[]);
  await page.getByRole('button',{name:'Go live',exact:true}).click();await page.keyboard.press('Escape');assert.equal(await dialog().count(),0);assert.deepEqual(await actions(),[]);
  assert.equal(await page.getByRole('button',{name:'Go live',exact:true}).evaluate(el=>el===document.activeElement),true,'Escape returns focus to the trigger');
  await page.getByRole('button',{name:'Go live',exact:true}).click();await page.locator('main').click();assert.equal(await dialog().count(),0);assert.deepEqual(await actions(),[]);
  await page.getByRole('button',{name:'Go live',exact:true}).click();
  await page.evaluate(()=>window.render({destinations:[{id:'kick',label:'Kick · Updated channel',icon:'K'}],program:'Updated Set'}));
  await dialog().getByText('Kick · Updated channel',{exact:true}).waitFor();assert.equal(await dialog().getByText('Twitch · Creator',{exact:true}).count(),0,'review tracks the current selection, not a snapshot of old channels');
  await dialog().getByText('Updated Set',{exact:true}).waitFor();
  await page.evaluate(()=>{window.delayStream=true;const button=document.querySelector('.rm-output-confirm');button.click();button.click();});
  await page.waitForFunction(()=>typeof window.finishStream==='function');assert.deepEqual(await actions(),['start-stream'],'one confirmation starts exactly one output request');
  assert.equal(await dialog().getByRole('button',{name:'Please wait…',exact:true}).isDisabled(),true);
  await page.evaluate(()=>window.finishStream());await page.waitForFunction(()=>!document.querySelector('.rm-output-confirmation'));
  await page.evaluate(()=>window.render({streaming:true}));await page.getByRole('button',{name:'End stream',exact:true}).click();
  await page.getByRole('heading',{name:'End this stream?'}).waitFor();assert.deepEqual(await actions(),['start-stream']);
  await dialog().getByRole('button',{name:'End stream',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.rm-output-confirmation'));assert.deepEqual(await actions(),['start-stream','stop-stream']);
  await page.evaluate(()=>window.render({streaming:false}));
  await page.getByRole('button',{name:'Record',exact:true}).click();await dialog().getByText('Movies / Producer',{exact:true}).waitFor();await dialog().getByText('1080p · 30 fps · Landscape + portrait · Two MP4 files',{exact:true}).waitFor();
  assert.deepEqual(await actions(),['start-stream','stop-stream'],'record click only opens review');
  await dialog().getByRole('button',{name:'Start recording',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.rm-output-confirmation'));assert.equal((await actions()).at(-1),'record');
  await page.evaluate(()=>window.render({recording:true,recordingPath:'/example/Movies/Producer/Test.mp4',recordingElapsed:'3:12'}));
  await page.getByRole('button',{name:'Stop recording',exact:true}).click();await dialog().getByText('Recorded 3:12',{exact:true}).waitFor();await dialog().getByText('Test.mp4',{exact:true}).waitFor();
  await dialog().getByRole('button',{name:'Cancel',exact:true}).click();assert.equal((await actions()).filter(call=>call==='record').length,1);
  await page.evaluate(()=>{window.failRecord=true;window.render({recording:false});});
  await page.getByRole('button',{name:'Record',exact:true}).click();await dialog().getByRole('button',{name:'Start recording',exact:true}).click();await dialog().getByRole('alert').waitFor();assert.equal(await dialog().count(),1,'failed output stays available for retry');
  await page.evaluate(()=>window.failRecord=false);await dialog().getByRole('button',{name:'Start recording',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.rm-output-confirmation'));
  await page.evaluate(()=>window.render({recordRequest:1}));await page.getByRole('heading',{name:'Record this room?'}).waitFor();await dialog().getByRole('button',{name:'Cancel',exact:true}).click();
  for(const width of [1180,640,360,320]){
    await page.setViewportSize({width,height:760});
    await page.getByRole('button',{name:'Record',exact:true}).click();
    const bounds=await dialog().boundingBox();assert(bounds.x>=7&&bounds.x+bounds.width<=width-7,`review fits ${width}px viewport`);
    await dialog().getByRole('button',{name:'Cancel',exact:true}).click();
    for(const name of ['Record','Go live','Edit layout']){
      const button=page.getByRole('button',{name,exact:true});await button.hover();const tooltip=page.getByRole('tooltip');await tooltip.waitFor();
      const b=await tooltip.boundingBox();assert(b.x>=7&&b.x+b.width<=width-7,`${name} tooltip stays inside ${width}px window`);
      assert.equal(await tooltip.evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(21, 30, 42)');
      assert.equal(await button.innerText(),'','toolbar buttons use symbols instead of visible text');
      await page.mouse.move(width/2,650);await page.waitForFunction(()=>!document.querySelector('[role=tooltip]'));
    }
  }
  await page.setViewportSize({width:1180,height:760});
  await page.evaluate(()=>window.render({streamDisabled:true,streamReason:'Choose a destination'}));assert.equal(await page.getByRole('button',{name:'Go live',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Record',exact:true}).click();await page.evaluate(()=>window.render({visible:false}));await page.waitForFunction(()=>!document.querySelector('.rm-output-confirmation'));
  assert.deepEqual(errors,[]);
  if(process.env.PRODUCER_TOOLBAR_SCREENSHOTS){await mkdir(process.env.PRODUCER_TOOLBAR_SCREENSHOTS,{recursive:true});await page.evaluate(()=>window.render({visible:true,streamDisabled:false}));await page.getByRole('button',{name:'Go live',exact:true}).click();await dialog().screenshot({path:process.env.PRODUCER_TOOLBAR_SCREENSHOTS+'/stream-review.png'});}
  console.log('PASS room toolbar: opaque non-modal review; current destinations; no output before confirmation; cancel/Escape/outside dismissal; focus return; one in-flight request; error retry; recording and streaming isolation; all tooltip and review bounds at 320–1180px.');
} finally {await browser.close();}
