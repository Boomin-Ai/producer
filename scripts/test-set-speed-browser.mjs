import assert from 'node:assert/strict';
const {chromium,webkit}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'playwright');
for(const engine of [chromium,webkit]){
 const b=await engine.launch(engine===chromium?{channel:'chrome'}:{}),page=await b.newPage();await page.goto('http://localhost:1420/scripts/set-speed-browser.html');
 await page.getByLabel('Load speed package').setInputFiles('/Users/klevelandbishop/Documents/boomin/docs/shows/claude-code-media-walkthrough.json');
 await page.waitForFunction(()=>window.calls.some(c=>c.kind==='warm'&&c.bytes>100000));
 await page.waitForTimeout(150);assert.equal(await page.getByTestId('active').textContent(),'false','warming must not go on air');
 const before=await page.evaluate(()=>window.calls.filter(c=>c.kind==='apply').length);assert.equal(before,0);
 await page.getByRole('button',{name:'Send to output'}).click();await page.waitForFunction(()=>document.querySelector('[data-testid=active]').textContent==='true');
 await page.getByRole('button',{name:'Edit title'}).click();await page.waitForFunction(()=>window.calls.filter(c=>c.kind==='apply').length>=2);
 await page.getByRole('button',{name:'Pause clip'}).click();await page.waitForFunction(()=>window.calls.filter(c=>c.kind==='apply').length>=3);
 const calls=await page.evaluate(()=>window.calls.filter(c=>c.kind==='apply'));assert.ok(calls.every(c=>c.bytes<15000),JSON.stringify(calls));assert.equal(await page.getByRole('alert').textContent(),'');
 await page.getByRole('button',{name:'Change room scene'}).click();await page.getByRole('button',{name:'Send to output'}).click();await page.waitForFunction(()=>window.calls.filter(c=>c.kind==='apply').some(c=>c.bytes>100000));await page.waitForTimeout(100);assert.equal(await page.getByRole('alert').textContent(),'');assert.equal(await page.getByTestId('active').textContent(),'true');
 const count=await page.evaluate(()=>window.calls.filter(c=>c.kind==='apply').length);await page.getByRole('button',{name:'Discard preparation cache'}).click();await page.getByRole('button',{name:'Send to output'}).click();await page.waitForFunction(n=>window.calls.filter(c=>c.kind==='apply').length>=n+2,count);await page.waitForTimeout(100);assert.equal(await page.getByRole('alert').textContent(),'');
 await b.close();console.log('PASS warming, compact updates, scene-camera rebinding and lost-cache recovery: '+engine.name()+' '+JSON.stringify(calls));
}
