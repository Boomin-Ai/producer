import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'../tools/producer-mcp/node_modules/playwright-core/index.mjs');
const browser=await chromium.launch({executablePath:process.env.PRODUCER_CHROME??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const origin=process.env.PRODUCER_TEST_URL??'http://127.0.0.1:1445/';
const screenshots=process.env.PRODUCER_PANEL_SCREENSHOTS;if(screenshots)await mkdir(screenshots,{recursive:true});
try{
 const page=await browser.newPage({viewport:{width:1000,height:700},reducedMotion:'reduce'}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route(origin,r=>r.fulfill({contentType:'text/html',body:'<!doctype html><body style="margin:20px;background:#080e16"><div id="root"></div></body>'}));await page.route('https://**',r=>r.abort());await page.goto(origin);
 await page.evaluate(async()=>{
  const refresh=await import('/@react-refresh');refresh.default.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
  // Navigation must work in both native WebViews and browsers without Popover.
  for(const name of ['showPopover','hidePopover'])Object.defineProperty(HTMLElement.prototype,name,{value:undefined,configurable:true});
  await import('/src/App.css');await import('/src/features/assistant/assistant.css');
  const R=await import('/node_modules/.vite/deps/react.js'),D=await import('/node_modules/.vite/deps/react-dom_client.js'),{AssistantSuggestions}=await import('/src/features/assistant/AssistantSuggestions.tsx');
  const root=(D.createRoot??D.default.createRoot)(document.getElementById('root')),h=R.createElement??R.default.createElement;
  window.choices=[];window.props={width:360,items:[{id:'a',label:'Build a teaching layout',prompt:'Build a teaching layout.'},{id:'b',label:'Frame my screen',prompt:'Frame my screen.'},{id:'c',label:'Plan a walkthrough',prompt:'Plan a walkthrough.'}]};
  window.render=patch=>{Object.assign(window.props,patch);root.render(h('section',{className:'assistant-workspace assistant-docked assistant-panel',style:{width:window.props.width,height:180,containerType:'inline-size',containerName:'assistant-dock'}},h('form',{className:'assistant-compose assistant-composer',onSubmit:e=>e.preventDefault()},h(AssistantSuggestions,{items:window.props.items,disabled:item=>item.disabled,onChoose:item=>window.choices.push(item)}),h('textarea',{'aria-label':'Assistant prompt',placeholder:'Ask Producer…'}),h('div',{className:'assistant-compose-actions'},h('button',{className:'assistant-send',type:'button','aria-label':'Send',disabled:true},'↑')))));};window.render({});
 });
 const row=page.getByRole('group',{name:'Suggested actions'}),track=page.locator('.assistant-suggestions-track');await row.waitFor();
 for(const width of [150,240,360,800]){
  await page.evaluate(width=>window.render({width}),width);
  await page.waitForFunction(width=>document.querySelector('.assistant-workspace').clientWidth===width,width);
  const geometry=await row.evaluate(el=>{const buttons=[...el.querySelectorAll('.assistant-suggestions-track>button')],tops=buttons.map(b=>b.getBoundingClientRect().top);return {fits:el.scrollWidth<=el.clientWidth+1&&el.getBoundingClientRect().right<=el.closest('.assistant-workspace').getBoundingClientRect().right+1,height:el.clientHeight,tops,wrap:buttons.map(b=>getComputedStyle(b).whiteSpace)};});
  assert(geometry.fits&&geometry.height<=40&&new Set(geometry.tops).size===1&&geometry.wrap.every(v=>v==='nowrap'),`one compact row at ${width}px: `+JSON.stringify(geometry));
  if(width===150){
   const next=page.getByRole('button',{name:'Next suggestions',exact:true}),previous=page.getByRole('button',{name:'Previous suggestions',exact:true});
   await next.waitFor();assert(await previous.isDisabled());
   const ends=await row.evaluate(el=>{const p=el.querySelector('[aria-label="Previous suggestions"]').getBoundingClientRect(),n=el.querySelector('[aria-label="Next suggestions"]').getBoundingClientRect(),t=el.querySelector('.assistant-suggestions-track').getBoundingClientRect(),r=el.getBoundingClientRect(),s=getComputedStyle(el);return {left:p.left-r.left,right:r.right-n.right,paddingLeft:parseFloat(s.paddingLeft),paddingRight:parseFloat(s.paddingRight),separate:p.right<=t.left&&n.left>=t.right};});
   assert(ends.separate&&Math.abs(ends.left-ends.paddingLeft)<=1&&Math.abs(ends.right-ends.paddingRight)<=1,'arrows sit at opposite ends of the section: '+JSON.stringify(ends));
   const hit=await next.boundingBox();assert.equal(await next.locator('svg').evaluate(el=>el.getBoundingClientRect().width),6,'resting arrow is very small');
   await next.hover();assert.equal(await next.locator('svg').evaluate(el=>el.getBoundingClientRect().width),12,'hover restores the previous arrow size');assert.deepEqual(await next.boundingBox(),hit,'hover never changes the row layout or click area');
   await page.mouse.move(0,0);
   await next.click();await page.waitForFunction(()=>document.querySelector('.assistant-suggestions-track').scrollLeft>0);assert(await previous.isEnabled());
   const last=track.getByRole('button',{name:'Plan a walkthrough'});await last.focus();
   assert(await last.evaluate(button=>{const b=button.getBoundingClientRect(),t=button.parentElement.getBoundingClientRect();return b.left>=t.left-1&&b.right<=t.right+1;}),'keyboard focus reveals the entire button');
   await last.press('Home');assert.equal(await track.getByRole('button').first().evaluate(el=>el===document.activeElement),true);
   await track.getByRole('button').first().press('ArrowRight');assert.equal(await track.getByRole('button').nth(1).evaluate(el=>el===document.activeElement),true);
  }
  if(width===800)await page.getByRole('button',{name:'Next suggestions',exact:true}).waitFor({state:'detached'});
  if(screenshots){await page.getByRole('textbox',{name:'Assistant prompt'}).focus();await track.evaluate(el=>el.scrollLeft=0);await row.screenshot({path:screenshots+`/carousel-${width}.png`});}
 }
 await track.getByRole('button',{name:'Frame my screen'}).click();assert.equal(await page.evaluate(()=>window.choices.length),1);assert.equal((await page.evaluate(()=>window.choices[0])).id,'b');
 await page.evaluate(()=>window.render({width:240,items:[{id:'one',label:'Explore chrome lighting',prompt:'Explore chrome lighting.'},{id:'two',label:'Design a guest layout',prompt:'Design a guest layout.'},{id:'three',label:'Unavailable action',disabled:true}]}));
 await track.getByRole('button',{name:'Explore chrome lighting'}).waitFor();await page.waitForFunction(()=>document.querySelector('.assistant-suggestions-track').scrollLeft===0);
 assert.deepEqual(await track.getByRole('button').allTextContents(),['Explore chrome lighting','Design a guest layout','Unavailable action']);
 assert(await track.getByRole('button',{name:'Unavailable action'}).isDisabled());
 assert.equal(await page.locator('.assistant-suggestion-popover').count(),0);assert.equal(await page.getByRole('button',{name:'Assistant suggestions',exact:true}).count(),0);
 await page.evaluate(()=>window.render({items:[]}));await row.waitFor({state:'detached'});
 assert.deepEqual(errors,[]);console.log('PASS Assistant suggestion carousel: 150/240/360/800px, opposite-end arrows, 6px → 12px hover without reflow, focus/keyboard navigation, resizing, contextual actions, disabled actions and no popup.');
}finally{await browser.close();}
