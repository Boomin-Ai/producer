import assert from 'node:assert/strict';
const {chromium,webkit}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'playwright');
for(const engine of [chromium,webkit]){
 const browser=await engine.launch(engine===chromium?{channel:'chrome'}:{});const page=await browser.newPage({viewport:{width:1100,height:800}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(`${process.env.PRODUCER_PREVIEW_ORIGIN??'http://localhost:1420'}/scripts/portrait-browser.html`);
 const gear=page.getByRole('button',{name:'Output settings',exact:true});await gear.click();
 await page.getByRole('button',{name:'Both',exact:true}).click();
 await page.getByLabel('Native portrait canvas').waitFor();assert.equal(await page.getByLabel('Landscape room output').count(),1);
 await page.waitForFunction(()=>window.portraitProof.roomStarts>0&&window.portraitProof.previews.some(r=>r&&r.w>0));
 assert.equal(await page.evaluate(()=>window.portraitProof.requests.length),0);
 assert.equal(await page.evaluate(()=>window.portraitProof.jpegCalls),0);
 await page.getByText('Portrait sources',{exact:true}).click();await page.getByRole('button',{name:'Hide Djayla on portrait'}).click();await page.getByRole('button',{name:'Show Djayla on portrait'}).click();
 await page.keyboard.press('Escape');
 for(const size of [{width:1100,height:800},{width:650,height:500}]){
  await page.setViewportSize(size);const bounds=await page.evaluate(()=>{const r=s=>{const a=document.querySelector(s).getBoundingClientRect();return {x:a.x,y:a.y,w:a.width,h:a.height};};return {canvas:r('.rm-canvas'),land:r('.live-preview'),port:r('.rm-portrait-monitor')};});
  assert(Math.abs(bounds.land.w/bounds.land.h-16/9)<.02);assert(Math.abs(bounds.port.w/bounds.port.h-9/16)<.02);assert(bounds.land.x+bounds.land.w<=bounds.port.x+1);assert(bounds.port.y+bounds.port.h<=bounds.canvas.y+bounds.canvas.h+1);
 }
 await gear.click();await page.getByRole('button',{name:'Portrait',exact:true}).click();assert.equal(await page.getByLabel('Landscape room output').count(),0);assert.equal(await page.getByLabel('Native portrait canvas').count(),1);
 await page.keyboard.press('Escape');
 const priorEdits=await page.evaluate(()=>window.portraitProof.transforms.length);
 const editor=page.locator('.rm-portrait-native .stage-editor');await editor.waitFor();const rect=await editor.boundingBox();
 const x=rect.x+rect.width*.5,y=rect.y+rect.height*.45;
 await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+20,y+15,{steps:5});await page.mouse.up();
 await page.waitForFunction(count=>window.portraitProof.transforms.length>count,priorEdits);assert.equal(await page.evaluate(()=>window.portraitProof.transforms[0].id),'camera');
 assert.equal(await page.evaluate(()=>window.portraitProof.landscapeEdits),0,'Portrait gestures must never call landscape transform IPC');
 await gear.click();await page.getByRole('button',{name:'Landscape',exact:true}).click();await page.getByLabel('Landscape room output').waitFor();assert.equal(await page.getByLabel('Native portrait canvas').count(),0);await page.waitForFunction(()=>window.portraitProof.previews.some(r=>r===null));
 await page.keyboard.press('Escape');
 await page.goto(`${process.env.PRODUCER_PREVIEW_ORIGIN??'http://localhost:1420'}/scripts/portrait-browser.html?paired`);
 await page.getByRole('button',{name:'Apply test set'}).click();
 await page.waitForFunction(()=>window.portraitProof.requests.some(r=>r.projection.root.id.endsWith('opening-portrait-canvas')));
 await page.getByRole('button',{name:'Next layout'}).click();
 await page.waitForFunction(()=>window.portraitProof.requests.some(r=>r.projection.root.id.endsWith('next-portrait-canvas')));
 assert.deepEqual(errors,[]);await browser.close();console.log(`PASS: ${engine.name()} landscape/portrait/both switching, native display attachment, room without a set, independent drag, aspect ratios and detach.`);
}
