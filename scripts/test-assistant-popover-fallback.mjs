import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'playwright-core');
const browser=await chromium.launch({executablePath:process.env.PRODUCER_CHROME??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const origin=process.env.PRODUCER_TEST_URL??'http://127.0.0.1:1447/';
try{
 const page=await browser.newPage({viewport:{width:500,height:600}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route(origin,route=>route.fulfill({contentType:'text/html',body:'<!doctype html><body style="margin:0;background:#080e16"><main style="height:400px">Outside the Assistant</main><div id="root"></div></body>'}));await page.route('https://**',route=>route.abort());await page.goto(origin);
 await page.evaluate(async()=>{
  const refresh=await import('/@react-refresh');refresh.default.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
  for(const name of ['showPopover','hidePopover'])Object.defineProperty(HTMLElement.prototype,name,{value:undefined,configurable:true});
  await import('/src/App.css');await import('/src/features/assistant/assistant.css');
  const R=await import('/node_modules/.vite/deps/react.js'),D=await import('/node_modules/.vite/deps/react-dom_client.js'),{AssistantSuggestions}=await import('/src/features/assistant/AssistantSuggestions.tsx');
  window.choices=[];const root=(D.createRoot??D.default.createRoot)(document.getElementById('root'));
  root.render((R.createElement??R.default.createElement)('section',{className:'assistant-workspace assistant-docked',style:{width:150,height:180,containerType:'inline-size',containerName:'assistant-dock'}},(R.createElement??R.default.createElement)('div',{className:'assistant-composer'},(R.createElement??R.default.createElement)(AssistantSuggestions,{items:[{id:'a',label:'Rainbow Club',prompt:'Explore this theme, no edits.'},{id:'b',label:'Cozy Castle',prompt:'Describe the castle.'},{id:'c',label:'Disabled idea'}],disabled:item=>item.id==='c',onChoose:item=>window.choices.push(item)}))));
 });
 const trigger=page.getByRole('button',{name:'Assistant suggestions',exact:true}),menu=page.locator('.assistant-suggestion-popover[data-fallback=true]');
 await trigger.click();await menu.waitFor({state:'visible'});
 const bounds=await menu.boundingBox();assert(bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=500&&bounds.y+bounds.height<=600);
 assert.equal(await menu.getByRole('button',{name:'Disabled idea'}).isDisabled(),true);
 await page.keyboard.press('Escape');assert.equal(await menu.isVisible(),false);assert.equal(await trigger.evaluate(element=>element===document.activeElement),true);
 await trigger.click();await menu.getByRole('button',{name:'Rainbow Club'}).click();assert.equal(await menu.isVisible(),false);
 assert.deepEqual(await page.evaluate(()=>window.choices),[{id:'a',label:'Rainbow Club',prompt:'Explore this theme, no edits.'}]);
 await trigger.click();await page.locator('main').click();assert.equal(await menu.isVisible(),false);
 await trigger.click();await trigger.click();assert.equal(await menu.isVisible(),false,'repeated trigger clicks close cleanly');
 assert.deepEqual(errors,[]);console.log('PASS Assistant suggestions without Popover API: viewport fit, keyboard focus, Escape, outside dismissal, repeated toggles and prompt-only selection.');
}finally{await browser.close();}
