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
 console.log('PASS: running camera blocks orientation with an explicit stop action; stop and switch show pending state until acknowledged.');
}finally{await browser.close();}
