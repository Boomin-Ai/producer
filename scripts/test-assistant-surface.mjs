import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'playwright-core');
const browser=await chromium.launch({executablePath:process.env.PRODUCER_CHROME??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const origin=process.env.PRODUCER_TEST_URL??'http://127.0.0.1:1445/';
const screenshots=process.env.PRODUCER_PANEL_SCREENSHOTS;
if(screenshots)await fs.mkdir(screenshots,{recursive:true});
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route(origin,r=>r.fulfill({contentType:'text/html',body:'<!doctype html><html><body style="margin:24px;background:#050b12"></body></html>'}));
 await page.route(/\/src\/features\/assistant\/provider\.ts(?:\?.*)?$/,r=>r.fulfill({contentType:'application/javascript',body:`export const chatgpt={status:async()=>({accounts:[{id:'test',email:'test@example.invalid',planEnabled:true}],active:'test'}),models:async()=>[{slug:'test',display_name:'Test model'}],cancel:async()=>{},turn:(turn,event)=>window.respond(turn,event)};`}));
 await page.route('https://**',r=>r.abort());await page.goto(origin);
 await page.evaluate(async()=>{
  const refresh=await import('/@react-refresh');refresh.default.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;
  await import('/src/App.css');
  const {AUTHORING_CATALOG}=await import('/src/features/presentation/authoring/catalog.ts');
  window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
  window.__TAURI_INTERNALS__={invoke:async c=>c==='assistant_authoring_capabilities'?{schema:'producer.native-authoring/1',catalogRevision:2,features:[...AUTHORING_CATALOG.features],packageSchema:'producer.presentation/2',nativeAdmission:'separate-native-preparation-required'}:c==='set_library_list'?[]:null,transformCallback:()=>1,convertFileSrc:p=>p};
  const R=await import('/node_modules/.vite/deps/react.js'),D=await import('/node_modules/.vite/deps/react-dom_client.js'),{default:RoomAssistant}=await import('/src/features/assistant/RoomAssistant.tsx'),{RehearsalSession}=await import('/src/features/presentation/rehearsal.ts');
  const doc=await(await fetch('/src/features/presentation/fixtures/after-hours.json')).json();doc.name='Room Authoring Lab';
  window.session=new RehearsalSession(doc,undefined,'prepare');window.original=JSON.stringify(window.session.package);window.turnCount=0;
  const root=document.createElement('div'),target=document.createElement('section');target.id='surface';target.className='assistant-dock-mount';target.style.cssText='width:380px;height:720px';document.body.append(root,target);
  (D.createRoot??D.default.createRoot)(root).render((R.createElement??R.default.createElement)(RoomAssistant,{session:window.session,scope:'surface-test',target,compact:false,roomState:{setOnOutput:true,screenSharing:false,guestsConnected:false},onExpand:()=>{},onReview:async()=>{throw Error('A text response must not open review.');}}));
  window.respond=async(turn,event)=>{
   window.turnCount++;
   if(window.turnCount===1)return [{type:'function_call',name:'inspect_set',arguments:'{}',call_id:'read-only'}];
   await new Promise(resolve=>window.beginReply=resolve);
   event({type:'text',text:'We can plan the show together. No edits have been made.'});
   window.retry=()=>event({type:'transport',stage:'retry',kind:'test',attempt:1,maxAttempts:2});
   window.resumeReply=()=>event({type:'text',text:' What should the opening cover?'});
   await new Promise(resolve=>window.finishReply=resolve);
   return [{type:'message',role:'assistant',content:[{type:'output_text',text:'We can plan the show together. No edits have been made. What should the opening cover?'}]}];
  };
 });
 await page.getByText('Test model',{exact:true}).waitFor();
 await page.getByRole('textbox',{name:'Assistant prompt'}).fill('Talk through a show idea; do not edit.');await page.getByRole('button',{name:'Send ↗',exact:true}).click();
 await page.waitForFunction(()=>typeof window.beginReply==='function');
 assert.match(await page.locator('.assistant-progress').innerText(),/^Thinking/,'another inference round after a read-only tool is still thinking');
 await page.evaluate(()=>window.beginReply());await page.getByRole('status').filter({hasText:'Replying'}).waitFor();
 if(screenshots)await page.locator('#surface').screenshot({path:screenshots+'/replying.png'});
 await page.evaluate(()=>window.retry());await page.getByRole('status').filter({hasText:'Reconnecting'}).waitFor();
 await page.evaluate(()=>window.resumeReply());await page.getByRole('status').filter({hasText:'Replying'}).waitFor();
 await page.evaluate(()=>window.finishReply());await page.getByRole('button',{name:'Stop',exact:true}).waitFor({state:'detached'});
 assert.equal(await page.evaluate(()=>JSON.stringify(window.session.package)),await page.evaluate(()=>window.original));
 assert.equal(await page.locator('.assistant-draft-card').count(),0,'a text-only conversation does not create private edits');
 for(const width of [380,650,240,150]){
  await page.evaluate(width=>document.getElementById('surface').style.width=width+'px',width);
  const geometry=await page.locator('#surface').evaluate(target=>{
   const box=target.getBoundingClientRect(),header=target.querySelector('.assistant-dock-header'),settings=target.querySelector('.assistant-settings-trigger'),icon=settings.querySelector('svg'),context=target.querySelector('.assistant-context-trigger');
   const b=settings.getBoundingClientRect(),i=icon.getBoundingClientRect(),suggestions=target.querySelector(getComputedStyle(target.querySelector('.assistant-suggestions')).display==='none'?'.assistant-suggestions-compact':'.assistant-suggestions'),s=suggestions.getBoundingClientRect(),input=target.querySelector('textarea').getBoundingClientRect();
   return {header:header.getBoundingClientRect().height,inside:b.left>=box.left&&b.right<=box.right&&b.top>=box.top,centered:Math.abs((i.left+i.right-b.left-b.right)/2)<1&&Math.abs((i.top+i.bottom-b.top-b.bottom)/2)<1,contextWithin:context.getBoundingClientRect().right<=b.left,suggestionHeight:s.height,separated:input.top>=s.bottom+6,divider:getComputedStyle(suggestions).borderBottomWidth,tops:[...suggestions.querySelectorAll('button')].map(button=>button.getBoundingClientRect().top)};
  });
  assert(geometry.header<=66&&geometry.inside&&geometry.centered&&geometry.contextWithin,'header and settings geometry at '+width+': '+JSON.stringify(geometry));
  assert(geometry.suggestionHeight<=40&&geometry.separated&&geometry.divider==='1px'&&new Set(geometry.tops).size===1,'suggestions stay in a single slim row separated from input at '+width+': '+JSON.stringify(geometry));
  if(screenshots)await page.locator('#surface').screenshot({path:screenshots+'/surface-'+width+'.png'});
 }
 await page.getByRole('button',{name:'Assistant settings',exact:true}).click();await page.getByRole('region',{name:'Assistant connection and sharing'}).waitFor();
 await page.getByRole('button',{name:'Close Assistant settings',exact:true}).click();await page.getByRole('textbox',{name:'Assistant prompt'}).waitFor();
 assert.deepEqual(errors,[]);
 console.log('PASS Assistant surface: read-only follow-up thinking, streamed reply/reconnect status, no edits, centered settings and compact header, single-row suggestions separated from the prompt at 150/240/380/650px, settings open/close.');
}finally{await browser.close();}
