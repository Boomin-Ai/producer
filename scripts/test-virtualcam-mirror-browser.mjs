import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'playwright');
const browser=await chromium.launch({channel:'chrome'});
try{
 const page=await browser.newPage();
 await page.goto(`${process.env.PRODUCER_PREVIEW_ORIGIN??'http://127.0.0.1:1432'}/scripts/portrait-browser.html?paired`);
 await page.getByRole('button',{name:'Apply test set'}).click();
 await page.waitForFunction(()=>window.portraitProof.requests.length>0);
 await page.getByRole('button',{name:'Output settings',exact:true}).click();
 const checkbox=page.getByRole('checkbox',{name:'Mirror virtual camera'});
 await checkbox.waitFor();
 assert.equal(await checkbox.isChecked(),false);
 const before=await page.evaluate(()=>window.portraitProof.requests.length);
 await checkbox.check();await page.waitForFunction(()=>document.querySelector('[aria-label="Mirror virtual camera"]').checked);
 assert.equal(await checkbox.isChecked(),true);
 await checkbox.uncheck();assert.equal(await checkbox.isChecked(),false);
 assert.equal(await page.evaluate(()=>window.portraitProof.requests.length),before,'Mirror must not rebuild or rearrange the set');
 await page.getByText('Flips the entire outgoing camera picture horizontally, including set text.').waitFor();
 console.log('PASS: gear mirror toggle switches on/off without rebuilding the set and describes whole-picture mirroring.');
}finally{await browser.close();}
