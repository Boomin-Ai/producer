const { chromium, webkit } = await import(process.env.PRODUCER_PLAYWRIGHT_MODULE ?? 'playwright');
import assert from 'node:assert/strict';
for(const engine of [chromium,webkit]) {
 const browser=await engine.launch(engine===chromium?{channel:'chrome'}:{});
 const page=await browser.newPage({viewport:{width:1100,height:800}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`${process.env.PRODUCER_PREVIEW_ORIGIN ?? 'http://localhost:1420'}/scripts/presentation-browser.html`);
 await page.getByRole('button',{name:'Set edit',exact:true}).click();
 const dialog=page.getByRole('dialog');await dialog.waitFor();
 await page.getByRole('textbox',{name:'Host name',exact:true}).fill('Djayla');
 assert.equal(await page.getByRole('textbox',{name:'Host name',exact:true}).inputValue(),'Djayla');
 await dialog.getByRole('button',{name:'Solo',exact:true}).click();
 assert.equal(await dialog.locator('.set-source-slots li').count(),1,'Solo exposes only its host slot');
 await dialog.getByRole('button',{name:'Conversation',exact:true}).click();
 assert.equal(await dialog.locator('.set-source-slots li').count(),2,'Conversation restores both source slots');
 await page.getByRole('button',{name:'Close preview'}).click();
 assert.equal(await page.getByRole('textbox',{name:'Host name',exact:true}).count(),0);
 await page.getByRole('button',{name:'Rehearse',exact:true}).click();
 await page.getByRole('button',{name:'Exit rehearsal',exact:true}).click();
 await page.setViewportSize({width:500,height:700});
 await page.getByRole('button',{name:'Set edit',exact:true}).click();
 assert(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+2));
 await page.frameLocator('iframe').getByText('AFTER HOURS',{exact:true}).waitFor();
 assert.deepEqual(errors,[]);
 await browser.close();console.log(engine.name()+': editor, content, dock separation, rehearsal, narrow viewport passed');
}
