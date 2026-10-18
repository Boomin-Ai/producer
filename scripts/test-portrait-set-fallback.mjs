import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'playwright');
const browser=await chromium.launch({channel:'chrome'});
try {
 const page=await browser.newPage({viewport:{width:1200,height:900}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`${process.env.PRODUCER_PREVIEW_ORIGIN??'http://127.0.0.1:1432'}/scripts/portrait-browser.html?landscape-only`);
 await page.getByRole('button',{name:'Output settings',exact:true}).click();
 await page.getByRole('button',{name:'Portrait',exact:true}).click();
 await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'Apply test set'}).click();
 await page.waitForFunction(()=>window.portraitProof.requests.length>0);
 const first=await page.evaluate(()=>window.portraitProof.requests.at(-1));
 assert.equal(first.projection.width,1280);assert.equal(first.projection.height,720);
 assert.match(first.projection.root.id,/conversation-arena/,'The set composition must replace the room fallback');
 await page.getByRole('button',{name:'Output settings',exact:true}).click();
 await page.getByText(/complete set is fitted into portrait/).waitFor();
 await page.getByLabel('Portrait layout').selectOption('room');
 await page.waitForFunction(()=>window.portraitProof.roomStarts>1);
 const before=await page.evaluate(()=>window.portraitProof.requests.length);
 await page.getByLabel('Portrait layout').selectOption('auto');
 await page.waitForFunction(count=>window.portraitProof.requests.length>count,before);
 assert.deepEqual(errors,[]);
 console.log('PASS: landscape-only Head to Head remains on portrait output; explicit room override and return to Follow set work.');
 // The existing paired-layout behavior must continue to pick vertical layouts.
 await page.goto(`${process.env.PRODUCER_PREVIEW_ORIGIN??'http://127.0.0.1:1432'}/scripts/portrait-browser.html?paired`);
 await page.getByRole('button',{name:'Apply test set'}).click();
 await page.waitForFunction(()=>window.portraitProof.requests.some(r=>r.projection.root.id.endsWith('opening-portrait-canvas')));
 await page.getByRole('button',{name:'Next layout'}).click();
 await page.waitForFunction(()=>window.portraitProof.requests.some(r=>r.projection.root.id.endsWith('next-portrait-canvas')));
 assert.deepEqual(errors,[]);
 console.log('PASS: paired portrait layouts still follow segment changes.');
} finally {await browser.close();}
