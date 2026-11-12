import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'/private/tmp/producer-sets-v2-browser/node_modules/playwright-core/index.mjs');
const browser=await chromium.launch({executablePath:process.env.PRODUCER_CHROME??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
let page;const errors=[];
try{
 page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));await page.route('**/__chat-source-test',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'}));await page.goto(new URL('__chat-source-test',process.env.PRODUCER_TEST_URL??'http://127.0.0.1:1436/').href);
 await page.evaluate(async()=>{
  const refresh=(await import('/@react-refresh')).default;refresh.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
  const R=await import('/node_modules/.vite/deps/react.js'),D=await import('/node_modules/.vite/deps/react-dom_client.js');const React=R.default??R;
  const {SetSourceCreator}=await import('/src/features/presentation/SetSourceCreator.tsx');
  window.chatSourceCalls=[];window.chatSourceFailure=false;
  window.__TAURI_INTERNALS__={invoke:async(command,args)=>{window.chatSourceCalls.push({command,args});if(command==='chat_overlay_start'){if(window.chatSourceFailure)throw Error('Chat bridge unavailable');return 'http://127.0.0.1:47119/chat';}if(command==='live_source_devices')return [];return null;}};
  const host=document.createElement('div');document.body.replaceChildren(host);const root=(D.createRoot??D.default.createRoot)(host);
  window.renderChatSource=(slot='chat',label='All-platform chat')=>root.render(React.createElement(SetSourceCreator,{key:slot,slot,label,create:async(slot,spec,label)=>{window.chatSourceCalls.push({command:'assigned',slot,spec,label})}}));window.renderChatSource();
 });
 await page.getByRole('button',{name:'Add source here'}).click();assert.equal(await page.getByLabel('All-platform chat new source type').inputValue({timeout:6000}),'chat');
 assert.equal(await page.getByLabel('All-platform chat new source device').count(),0);
 await page.getByRole('button',{name:'Add and assign'}).click();await page.getByRole('button',{name:'Add source here'}).waitFor();
 const calls=await page.evaluate(()=>window.chatSourceCalls);assert.deepEqual(calls,[{command:'chat_overlay_start',args:{}},{command:'assigned',slot:'chat',spec:{kind:'overlay',url:'http://127.0.0.1:47119/chat'},label:'Chat'}]);
 await page.evaluate(()=>window.chatSourceFailure=true);await page.getByRole('button',{name:'Add source here'}).click();await page.getByRole('button',{name:'Add and assign'}).click();await page.getByRole('alert').filter({hasText:'Chat bridge unavailable'}).waitFor();assert.equal(await page.evaluate(()=>window.chatSourceCalls.filter(c=>c.command==='assigned').length),1);
 await page.evaluate(()=>window.renderChatSource('host','Host camera'));await page.getByRole('button',{name:'Add source here'}).click();assert.equal(await page.getByLabel('Host camera new source type').inputValue(),'camera');
 assert.deepEqual(errors,[]);console.log('PASS: chat slots default to merged Chat; Add and assign starts the native bridge and binds its overlay; bridge failures surface without assignment; camera slots retain their default.');
}finally{await browser.close()}
