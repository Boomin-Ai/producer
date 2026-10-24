import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'/private/tmp/producer-sets-v2-browser/node_modules/playwright-core/index.mjs');
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
 const page=await browser.newPage({viewport:{width:1440,height:960}});page.on('pageerror',e=>console.error(e.message));await page.goto('http://127.0.0.1:1436/');
 await page.evaluate(async()=>{
  const R=await import('/node_modules/.vite/deps/react.js'),D=await import('/node_modules/.vite/deps/react-dom_client.js');
  const {SetControlsPanel}=await import('/src/features/presentation/SetControlsPanel.tsx');const {HEAD_TO_HEAD}=await import('/src/features/presentation/fixtures.ts');const source=await(await fetch('/src/features/presentation/SetControlsPanel.tsx')).text();const {RehearsalSession}=await import(source.match(/from "([^"]*rehearsal\.ts[^"]*)"/)[1]);
  const doc=structuredClone(HEAD_TO_HEAD);
  for(let i=0;i<20;i++){const layout={...structuredClone(doc.set.layouts[0]),root:{id:'root-'+i,type:'box',styles:{width:1280,height:720},children:[]},id:'extra-'+i,label:'An intentionally long segment layout number '+i};doc.set.layouts.push(layout);doc.set.controls.push({id:'layout-'+i,type:'button',label:layout.label,action:{type:'layout.select',layoutId:layout.id}});}
  doc.set.controls.push({id:'reset-topic',type:'button',label:'Reset topic',action:{type:'value.set',key:'topic',value:'Who takes the round?'}});
  let last=doc.show.phases.at(-1);
  for(let i=0;i<4;i++){const phase={id:'extra-phase-'+i,label:['Counterpoint','Receipts','Crowd call','Final verdict'][i],layoutId:doc.set.layouts[0].id};last.next=phase.id;doc.show.phases.push(phase);last=phase;}
  window.panelSession=new RehearsalSession(doc,undefined,'prepare');const host=document.createElement('div');host.className='rm-dock-bottom';host.style.cssText='height:600px;width:1400px';host.innerHTML='<div class="rm-panel-setControls" style="container:panel / inline-size;height:100%;width:100%"><div class="rm-panel-body" style="height:100%;display:flex;flex-direction:column"></div></div>';document.body.replaceChildren(host);
  (D.createRoot??D.default.createRoot)(host.querySelector('.rm-panel-body')).render((R.createElement??R.default.createElement)(SetControlsPanel,{session:window.panelSession,onChange:()=>{},output:{renderer:'native',layoutReadiness:Object.fromEntries(doc.set.layouts.map((l,i)=>[l.id,{state:i===0?'loading':'ready'}])),active:true,busy:false,error:'',bindings:{},framing:{},sources:{items:[]},bind:()=>{},frame:()=>{},apply:async()=>{},returnToRoom:async()=>true}}));
 });
 const startFits=await page.locator('.set-mode-action').evaluate(el=>el.scrollWidth<=el.clientWidth);assert(startFits,'Start show text fits inside its button');
 const readiness=await page.locator('.set-segments li').first().getAttribute('data-readiness');assert.equal(readiness,'loading');
 const bounds=()=>page.evaluate(()=>['.set-fixed-playback','.set-run','.set-participation','.set-reference'].map(s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};}));
 await page.locator('.set-mode-action').click();await page.waitForTimeout(100);const running=await bounds();
 await page.getByRole('button',{name:'Stop run',exact:true}).click();await page.waitForTimeout(100);const prepared=await bounds();assert.deepEqual(prepared,running,'Start and Stop preserve every column and transport rectangle');
 assert.equal(await page.locator('.set-run-current-label').innerText(),await page.evaluate(()=>window.panelSession.package.show.phases.find(p=>p.id===window.panelSession.snapshot().show.phase).label));
 const sections=page.locator('.set-sections > *');assert.equal(await sections.count(),3);const columns=await bounds();assert(columns[1].x<columns[2].x&&columns[2].x<columns[3].x);assert.equal(columns[1].y,columns[2].y);assert.equal(columns[2].y,columns[3].y);
 for(const height of [600,460,360,300]){
  await page.evaluate(h=>document.querySelector('.rm-dock-bottom').style.height=h+'px',height);await page.waitForTimeout(100);
  const list=await page.evaluate(()=>{const list=document.querySelector('.set-segments-scroll');list.scrollTop=0;const viewport=list.getBoundingClientRect(),card=document.querySelector('.set-run').getBoundingClientRect();return {fraction:viewport.height/card.height,visible:[...list.querySelectorAll('li')].filter(el=>{const r=el.getBoundingClientRect();return r.top>=viewport.top-1&&r.bottom<=viewport.bottom+1;}).length};});
  assert(list.fraction>.55,JSON.stringify({height,...list}));assert(list.visible>=4,JSON.stringify({height,...list}));if(height>=460)assert.equal(list.visible,7);
 }
 await page.evaluate(()=>document.querySelector('.rm-dock-bottom').style.height='460px');await page.waitForTimeout(100);
 const cards=await page.evaluate(()=>['.set-run','.set-participation','.set-reference'].map(selector=>{const el=document.querySelector(selector),s=getComputedStyle(el);return {background:s.backgroundColor,image:s.backgroundImage,border:s.borderTopColor,padding:parseFloat(s.paddingLeft)};}));
 assert.equal(new Set(cards.map(c=>c.background)).size,1,'cards share the room surface');assert(cards.every(c=>c.image==='none'));assert.equal(new Set(cards.map(c=>c.border)).size,1);assert(cards[1].padding>=12&&cards[2].padding>=12,'control and source cards have internal padding');
 const controlGap=await page.locator('.set-participation').evaluate(el=>{const picker=el.querySelector('.set-panel-layout-picker').getBoundingClientRect(),actions=el.querySelector('.set-segment-actions').getBoundingClientRect();return actions.top-picker.bottom;});assert(controlGap>=10,'layout and actions have visible separation');
 await page.screenshot({path:'/private/tmp/producer-set-panel-expanded.png'});
 await page.evaluate(()=>{const dock=document.querySelector('.rm-dock-bottom');dock.classList.add('slim');dock.style.height='56px';});
 for(const width of [1400,1024,800,600,450]){
  await page.setViewportSize({width,height:960});await page.evaluate(w=>document.querySelector('.rm-dock-bottom').style.width=(w-20)+'px',width);await page.waitForTimeout(100);
  const fit=await page.evaluate(()=>{const bar=document.querySelector('.set-controls-toolbar'),r=bar.getBoundingClientRect();return {overflow:bar.scrollWidth>bar.clientWidth+1,visible:[...bar.querySelectorAll('.set-fixed-playback,.set-toolbar-tools')].every(el=>{const b=el.getBoundingClientRect();return b.left>=r.left-1&&b.right<=r.right+1;}),buttons:bar.querySelectorAll('button').length};});assert(!fit.overflow&&fit.visible,JSON.stringify({width,...fit}));assert(fit.buttons<12,'layout count must not add toolbar buttons');
 }
 const scroll=await page.evaluate(()=>{
  const nodes=['.rm-panel-body','.rm-panel-body > .set-controls','.set-controls-toolbar','.set-compact-run'].map(s=>document.querySelector(s));
  for(const node of nodes){node.scrollTop=1000;node.scrollLeft=1000;}
  return nodes.map(n=>({top:n.scrollTop,left:n.scrollLeft}));
 });assert(scroll.every(n=>n.top===0&&n.left===0),'minimized bar must not scroll in either direction');
 await page.getByRole('button',{name:'Set actions',exact:true}).click();assert(await page.locator('.set-actions-popover').evaluate(el=>el.matches(':popover-open')));
 console.log('PASS: identical prepared/running geometry, three merged sections, and compact toolbar remains bounded with 20 extra layouts');
}finally{await browser.close();}
