const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE ?? 'playwright');
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const browser=await chromium.launch({channel:'chrome'});
const page=await browser.newPage({viewport:{width:1300,height:800}});
await page.goto(`${process.env.PRODUCER_PREVIEW_ORIGIN ?? 'http://localhost:1420'}/scripts/presentation-browser.html?dock=bottom&constrained`);
const doc=JSON.parse(await readFile('docs/shows/fixtures/head-to-head.presentation.json','utf8'));
const first=doc.show.phases[0];doc.show.phases=Array.from({length:16},(_,i)=>({...first,id:i===0?first.id:`segment${i}`,label:`Segment ${i+1}`,next:i===15?undefined:`segment${i+1}`}));
await page.getByLabel('Import set package').setInputFiles({name:'long.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(doc))});
await page.waitForTimeout(300); await page.keyboard.press('Escape');
await page.getByRole('button',{name:'Rehearse',exact:true}).click();
const list=page.getByRole('region',{name:'Segment list',exact:true});
await list.locator('li').first().waitFor(); assert.equal(await list.locator('li').count(),16);
for(const height of [220,350,500]) {
 await page.locator('.rm-panel-setControls').evaluate((el,h)=>el.style.height=`${h}px`,height);
 const result=await list.evaluate(el=>({height:el.clientHeight,scroll:el.scrollHeight}));
 assert(result.scroll>result.height,`Rundown must scroll at dock height ${height}`);
 assert(result.height<height,`Rundown must fit resized dock ${height}`);
 await list.evaluate(el=>el.scrollTop=el.scrollHeight);
 assert(await list.evaluate(el=>el.scrollTop>0));
}
await browser.close();console.log('PASS: 16-segment rundown scrolls within 220, 350 and 500px dock heights.');
