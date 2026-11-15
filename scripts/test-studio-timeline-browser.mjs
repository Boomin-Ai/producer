import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'playwright');
const browser=await chromium.launch({...(process.env.PRODUCER_CHROME?{executablePath:process.env.PRODUCER_CHROME}:{channel:'chrome'}),headless:true});
try {
 const page=await browser.newPage({viewport:{width:1440,height:960}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`${process.env.PRODUCER_PREVIEW_ORIGIN??'http://127.0.0.1:1436'}/scripts/studio-timeline-browser.html`);
 const placement=page.getByRole('switch',{name:'Studio timeline bar'});
 await page.locator('.rm-studio-timeline[data-ready="true"]').waitFor();
 async function verifyCrop(position) {
  await page.waitForFunction(position=>{
   const root=document.querySelector('.rm-studio-timeline');
   const row=root?.closest('[data-studio-timeline-region], [data-dock]');
   const crop=window.studioTimelineProof.crops.at(-1);
   if(!row||!crop||root.dataset.ready!=='true')return false;
   const bar=row.hasAttribute('data-studio-timeline-region');
   const edge=bar?row.getBoundingClientRect().top:document.querySelector('footer').getBoundingClientRect().top;
   return crop.y===0&&Math.abs((crop.y+crop.h)*innerHeight-Math.floor(edge))<1;
  },position);
  assert(await page.getByRole('contentinfo').isVisible());
  assert(await page.getByRole('region',{name:'Other bottom panels'}).isVisible());
 }
 await verifyCrop('bottom');
 await page.getByRole('slider',{name:'Timeline playhead'}).fill('2000');
 await placement.click();
 assert.equal(await placement.getAttribute('aria-checked'),'true');
 await verifyCrop('bottom');
 assert.equal(await page.getByRole('slider',{name:'Timeline playhead'}).inputValue(),'2000','Placement preserves the playhead');
 await placement.click();await verifyCrop('bottom');
 await page.getByRole('button',{name:'Move dock'}).click();await verifyCrop('top');
 await page.getByRole('button',{name:'Resize dock'}).click();await verifyCrop('top');
 await placement.click();await verifyCrop('bottom');
 await placement.click();await verifyCrop('top');
 await page.getByRole('button',{name:'Play',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.studio-composer-clock strong').textContent!=='0:02.0');
 await placement.click();
 assert(await page.getByRole('button',{name:'Play',exact:true}).isVisible(),'Reparenting pauses native motion instead of leaving a detached playback running');
 assert((await page.evaluate(()=>window.studioTimelineProof.pauses)).length>0);
 await page.getByRole('button',{name:'Toggle Studio'}).click();
 assert.equal(await placement.count(),0);
 await page.getByRole('button',{name:'Toggle Studio'}).click();await verifyCrop('bottom');
 assert.equal(await placement.getAttribute('aria-checked'),'true');
 for(const width of [900,600]) {
  await page.setViewportSize({width,height:900});await verifyCrop('bottom');
  assert(await page.locator('.studio-composer').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'Timeline fits the available width');
 }
 assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>window.studioTimelineProof.errors),[]);
 console.log('PASS: docked Timeline included in capture, separate bar excluded, top/bottom placement, preserved playhead, native pause, resized aperture, Studio toggle, footer and other dock panels.');
} finally {await browser.close();}
