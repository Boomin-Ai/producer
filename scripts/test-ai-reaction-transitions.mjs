import fs from 'node:fs';
import assert from 'node:assert/strict';
const {chromium,webkit}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'playwright');
const engine=process.argv.includes('--webkit')?webkit:chromium;
const b=await engine.launch(engine===chromium?{channel:'chrome',headless:true}:{});
try{
 const p=await b.newPage({viewport:{width:1300,height:1500}}),errors=[];p.on('pageerror',e=>errors.push(e.message));
 const doc=JSON.parse(fs.readFileSync('docs/shows/ai-signal.show.json'));await p.route('**/docs/shows/json-ui-test.show.json',r=>r.fulfill({json:doc}));
 await p.goto('http://127.0.0.1:1420/scripts/json-ui-test.html');const frame=p.frameLocator('iframe').first();const camera=frame.locator('[data-node$="/host-camera"]');await camera.waitFor();
 const rect=el=>({x:parseFloat(el.style.left),y:parseFloat(el.style.top),w:parseFloat(el.style.width),h:parseFloat(el.style.height)});
 const box=()=>camera.evaluate(rect);await p.getByRole('button',{name:'Start show',exact:true}).first().click();assert.equal((await box()).w,856);
 await p.getByRole('button',{name:'BREAKDOWN',exact:true}).click();await p.waitForTimeout(300);const mid=await box();assert.ok(mid.w>480&&mid.w<856,`intermediate camera width ${mid.w}`);
 const aligned=await frame.locator('body').evaluate(()=>({camera:parseFloat(document.querySelector('[data-node$="/host-camera"]').style.width),rim:parseFloat(document.querySelector('[data-node$="/camera-rim"]').style.width)}));assert.ok(Math.abs(aligned.rim-aligned.camera-6)<1e-6);
 await p.getByRole('button',{name:'REACT',exact:true}).click();const reversed=await box();assert.ok(reversed.w>480&&reversed.w<856);await p.waitForTimeout(250);assert.ok((await box()).w>reversed.w);
 await p.getByRole('button',{name:'Pause',exact:true}).first().click();await p.waitForTimeout(100);const held=await box();await p.waitForTimeout(350);assert.deepEqual(await box(),held);await p.getByRole('button',{name:'Resume',exact:true}).first().click();await p.waitForTimeout(1300);assert.equal((await box()).w,856);
 await p.getByRole('button',{name:'HOT TAKE',exact:true}).click();await p.waitForTimeout(1400);assert.equal((await box()).w,856);assert.equal((await box()).y,712);assert.equal(await p.getByTestId('phase').textContent(),'reaction');assert.equal(await frame.locator('[data-node$="/reaction-content"]').count(),1);
 await p.locator('.set-preview').first().screenshot({path:`/private/tmp/${engine.name()}-ai-transition-take.png`});assert.deepEqual(errors,[]);console.log('PASS browser intermediate geometry, rapid reversal, synchronized rim, pause/resume, final take geometry and one continuous segment.');
}finally{await b.close();}
