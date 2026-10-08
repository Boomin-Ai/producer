import fs from 'node:fs';
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'playwright');
const doc=JSON.parse(fs.readFileSync('docs/shows/local-host.show.json'));
const browser=await chromium.launch({channel:'chrome',headless:true});
try{const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')console.log(m.text());});await page.route('**/local-host-preview.json',r=>r.fulfill({json:doc}));
for(const l of doc.set.layouts){await page.setViewportSize({width:l.width/2,height:l.height/2});await page.goto('http://127.0.0.1:1420/scripts/local-host-preview.html?layout='+l.id);await page.locator("iframe").waitFor();await page.frameLocator('iframe').locator('[data-node$="/host-camera"]').waitFor({timeout:30000});await page.waitForTimeout(1000);if(await page.getByRole('alert').count())throw Error(await page.getByRole('alert').innerText());const frame=page.frameLocator('iframe');const heading=frame.locator('[data-node$="/title"], [data-node$="/question"]');assert.ok((await heading.first().innerText()).length>0);assert.equal(await frame.locator('canvas[data-effect="edgeGlow"]').count(),2);assert.deepEqual(errors,[]);await page.screenshot({path:'/private/tmp/'+l.id+'.png'});console.log(l.id);}
}finally{await browser.close();}
