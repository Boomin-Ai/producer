import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'playwright');
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage();await page.goto(`${process.env.PRODUCER_PREVIEW_ORIGIN??'http://127.0.0.1:1433'}/scripts/portrait-browser.html?camera-controls`);
 await page.getByRole('button',{name:'Output settings',exact:true}).click();
 const portrait=page.getByRole('button',{name:'Portrait',exact:true});
 assert(await portrait.isDisabled());
 await page.getByText('Virtual camera is on. Stop it to change orientation.').waitFor();
 await page.getByRole('button',{name:'Stop virtual camera',exact:true}).click();
 await page.getByRole('button',{name:'Stopping…',exact:true}).waitFor();
 assert(await portrait.isDisabled());
 await page.evaluate(()=>window.finishCameraStop());
 await page.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Portrait').disabled);
 await portrait.click();await page.getByText('Switching output…').waitFor();assert(await portrait.isDisabled());
 await page.evaluate(()=>window.finishOutputSwitch());
 await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Portrait').getAttribute('aria-pressed')==='true');
 assert.equal(await portrait.isDisabled(),false);
 for(const edge of ['top','bottom','left','right']){
  await page.setViewportSize({width:320,height:380});
  await page.goto(`${process.env.PRODUCER_PREVIEW_ORIGIN??'http://127.0.0.1:1433'}/scripts/portrait-browser.html?edge=${edge}`);
  const bar=page.locator('.stg-bar');
  const collapsed=await bar.boundingBox();
  const surface=await bar.evaluate(element=>getComputedStyle(element).backgroundColor);
  const open=page.getByRole('button',{name:'Output settings',exact:true});
  await open.click();
  const close=page.getByRole('button',{name:'Close output settings',exact:true});
  assert.equal(await close.getAttribute('aria-expanded'),'true');
  const settings=bar.getByRole('region',{name:'Output settings'});
  const bounds=await bar.boundingBox();
  assert.equal(await bar.evaluate(element=>getComputedStyle(element).backgroundColor),surface);
  assert(bounds.width>collapsed.width, `${edge} controller expands`);
  assert(bounds.x>=0&&bounds.x+bounds.width<=320, `${edge} controller stays inside the window`);
  assert.equal(await page.locator('[popover]:popover-open').count(),0);
  const controls=await bar.locator('.stg-bar-tools').boundingBox();
  const panel=await settings.boundingBox();
  assert({
   top:panel.y>=controls.y+controls.height,
   bottom:controls.y>=panel.y+panel.height,
   left:panel.x>=controls.x+controls.width,
   right:controls.x>=panel.x+panel.width,
  }[edge], `${edge} settings expand toward the canvas`);
  await close.press('Escape');
  assert.equal(await settings.count(),0);
  assert.equal(await open.evaluate(button=>document.activeElement===button),true);
 }
 console.log('PASS: camera lock and pending states, inline expansion on all four edges, and Escape focus return.');
}finally{await browser.close();}
