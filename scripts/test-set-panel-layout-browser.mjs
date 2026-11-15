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
  doc.set.controls.push({id:'opening-topic',type:'button',label:'Opening topic',when:{op:'eq',args:[{get:'show.phase'},doc.show.phases[0].id]},action:{type:'value.set',key:'topic',value:'Opening'}});
  for (const layout of doc.set.layouts) (layout.root.children ??= []).push({id:'shared-topic',type:'text',text:{get:'values.topic'}});
  let last=doc.show.phases.at(-1);
  for(let i=0;i<4;i++){const phase={id:'extra-phase-'+i,label:['Counterpoint','Receipts','Crowd call','Final verdict'][i],layoutId:doc.set.layouts[0].id};last.next=phase.id;doc.show.phases.push(phase);last=phase;}
  last.layoutId='extra-0';
  window.panelSession=new RehearsalSession(doc,undefined,'prepare');const slot=doc.set.slots[0];const host=document.createElement('div');host.className='rm-dock-bottom';host.style.cssText='height:600px;width:1400px';host.innerHTML='<div class="rm-panel-setControls" style="container:panel / inline-size;height:100%;width:100%"><div class="rm-panel-body" style="height:100%;display:flex;flex-direction:column"></div></div>';document.body.replaceChildren(host);
  (D.createRoot??D.default.createRoot)(host.querySelector('.rm-panel-body')).render((R.createElement??R.default.createElement)(SetControlsPanel,{session:window.panelSession,onChange:()=>{},output:{renderer:'native',layoutReadiness:Object.fromEntries(doc.set.layouts.map((l,i)=>[l.id,{state:i===0?'loading':'ready'}])),active:true,busy:false,error:'',bindings:{[slot.id]:'test-camera'},framing:{},sources:{items:[{id:'test-camera',label:'Test camera',kind:'camera',has_frame:true}]},cameraBackground:{},bind:()=>{},frame:()=>{},apply:async()=>{},returnToRoom:async()=>true}}));
 });
 const header=page.locator('.set-run-disclosure');
 const menu=page.getByRole('region',{name:'Show segments'});
 const footer=page.getByRole('contentinfo',{name:'Assigned sources'});
 const body=page.locator('.set-sections');
 await header.waitFor();
 const segmentControls=body.getByRole('region',{name:'Segment controls'});
 const entireSet=body.getByRole('region',{name:'Entire Set'});
 assert(await segmentControls.getByRole('button',{name:'Opening topic',exact:true}).isVisible());
 assert.equal(await page.locator('.set-playback-status').textContent(),'Ready');
 assert.equal(await entireSet.getByRole('button',{name:'Reset topic',exact:true}).count(),1);
 assert(await entireSet.getByRole('button',{name:'Reset topic',exact:true}).isVisible(),'Set-wide cues are directly available');
 assert.equal(await entireSet.getByRole('button',{name:/^(Expand|Collapse) .* section$/}).count(),0);
 assert.equal(await segmentControls.evaluate(el=>getComputedStyle(el).borderTopWidth),'0px');
 assert.equal(await entireSet.evaluate(el=>getComputedStyle(el).borderTopWidth),'1px','A single divider separates the two sections');
 assert.equal(await segmentControls.getByRole('button',{name:'Reset topic',exact:true}).count(),0);
 assert.equal(await segmentControls.getByRole('combobox',{name:'Segment layout'}).count(),0,'The live segment controls omit the layout selector');
 assert((await entireSet.boundingBox()).y>(await segmentControls.boundingBox()).y);
 assert.equal(await page.getByRole('button',{name:'Set settings',exact:true}).innerText(),'');
 assert.equal(await body.locator('.set-segments').count(),0,'Only the dropdown contains the segment list');
 assert.equal(await page.getByRole('region',{name:'Camera backgrounds'}).count(),0,'Saved Sets without an explicit preference omit the camera background controls');
 for(const width of [340,240,156]){
  await page.evaluate(w=>{const dock=document.querySelector('.rm-dock-bottom,.rm-dock-side');dock.className='rm-dock-side';dock.style.cssText=`width:${w}px;height:285px;margin-left:1050px`;},width);
  const before=await Promise.all([header.boundingBox(),footer.boundingBox()]);
  assert.ok(before[1].height<32,'Sources footer stays one line tall');
  assert.ok(await body.evaluate(el=>{el.scrollTop=1000;return el.scrollTop>0&&el.scrollLeft===0;}),'The body scrolls vertically inside the dock');
  assert.deepEqual(await Promise.all([header.boundingBox(),footer.boundingBox()]),before);
  await header.click();
  assert.equal(await menu.locator('li').count(),7);
  assert.equal(await menu.locator('li').first().getAttribute('data-readiness'),'loading');
  assert.deepEqual(await Promise.all([header.boundingBox(),footer.boundingBox()]),before,'Opening the dropdown does not move the panel');
  const dropdown=await menu.boundingBox();
  const toolbar=await page.locator('.set-controls-toolbar').boundingBox();
  const transport=await page.locator('.set-fixed-playback').boundingBox();
  const setName=await page.locator('.set-current-name').boundingBox();
  assert(Math.abs(dropdown.x-toolbar.x)<1&&Math.abs(dropdown.width-toolbar.width)<1,'Dropdown aligns to the header');
  assert(Math.abs(dropdown.y-(toolbar.y+toolbar.height))<1,'Dropdown starts at the header edge');
  assert(await menu.evaluate(el=>parseFloat(getComputedStyle(el).borderBottomWidth)>=2),'The extension has a visible bottom border');
  assert(await menu.evaluate(el=>{
   const ctx=document.createElement('canvas').getContext('2d');
   ctx.fillStyle=getComputedStyle(el).backgroundColor;
   ctx.fillRect(0,0,1,1);
   return ctx.getImageData(0,0,1,1).data[3]===255;
  }),'The header extension must fully cover the controls underneath');
  const tools=await page.locator('.set-toolbar-tools').boundingBox();
  assert(setName.y+setName.height<=transport.y,'The sidebar Set name sits above playback');
  assert(Math.abs(setName.x+setName.width/2-(toolbar.x+toolbar.width/2))<1,'The sidebar Set name is centered');
  if(width<=250){
   const output=await page.locator('.set-output-switch').boundingBox();
   assert(Math.abs(transport.width-toolbar.width)<1,'Playback spans its own row');
   assert(output.y>=transport.y+transport.height&&Math.abs(output.y-tools.y)<1,'The three actions share the next row');
   assert(Math.abs(output.x+(tools.x+tools.width-output.x)/2-(toolbar.x+toolbar.width/2))<1,'The action row is centered');
  }
  assert(before[0].y>=Math.max(setName.y+setName.height,tools.y+tools.height),'Segment picker sits below the Set name and actions');
  assert(await page.locator('.set-controls-toolbar').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'Toolbar fits horizontally');
  await page.keyboard.press('Escape');
  await menu.waitFor({state:'hidden'});
 }
 await header.click();
 await menu.getByRole('button',{name:/Final verdict/}).click();
 await menu.waitFor({state:'hidden'});
 assert.match(await header.innerText(),/Final verdict/);
 assert.equal(await segmentControls.count(),0,'Segments with no controls omit the section');
 assert.equal(await entireSet.getByRole('button',{name:'Reset topic',exact:true}).count(),1,'Set-wide controls stay in place when the segment changes');
 await page.evaluate(()=>{const dock=document.querySelector('.rm-dock-side');dock.className='rm-dock-bottom';dock.style.cssText='height:460px;width:1400px';});
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
 await page.getByRole('button',{name:'Show rundown',exact:true}).click();
 assert(await menu.evaluate(el=>el.matches(':popover-open')));
 console.log('PASS: header dropdown, sticky Sources, camera controls opt-in, and compact toolbar with 20 extra layouts');
}finally{await browser.close();}
