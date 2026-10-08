import assert from 'node:assert/strict';
import fs from 'node:fs';
const file='/Users/klevelandbishop/Documents/boomin/docs/shows/shader-combo.show.json',doc=JSON.parse(fs.readFileSync(file));
assert.equal(doc.show.phases.length,16);assert.equal(doc.set.layouts.length,32);
assert.equal(new Set(doc.set.layouts.flatMap(l=>l.root.children.filter(n=>n.shader).map(n=>n.shader.effect))).size,11);
const {chromium,webkit}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'playwright');
for(const engine of [chromium,webkit]){
 const browser=await engine.launch(engine===chromium?{channel:'chrome'}:{});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:1350}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://localhost:1420/scripts/combo-browser.html');await page.getByLabel('Load combo').setInputFiles(file);
  const frame=page.frameLocator('iframe');
  for(const layout of doc.set.layouts){
   await page.getByLabel('Layout',{exact:true}).selectOption(layout.id);await page.waitForTimeout(1000);
   const expected=layout.root.children.filter(n=>n.type==='shader');assert.equal(await frame.locator('canvas[data-gpu="webgl"]').count(),expected.length);
   const field=frame.locator('canvas[data-effect="'+expected[0].shader.effect+'"]');
   const pixels=()=>field.evaluate(el=>{const gl=el.getContext('webgl'),p=new Uint8Array(el.width*el.height*4);gl.readPixels(0,0,el.width,el.height,gl.RGBA,gl.UNSIGNED_BYTE,p);let lit=0,h=0;for(let i=0;i<p.length;i++){h=Math.imul(h,31)+p[i]|0;if(i%4!==3&&p[i]>20)lit++;}return {lit,h};});
   const a=await pixels();assert.ok(a.lit>100,layout.id+' field is blank');await page.waitForTimeout(120);assert.notEqual((await pixels()).h,a.h,layout.id+' clock is frozen');
   if(engine===chromium&&['liquid-portrait','stars-portrait','petals-portrait','grid-landscape','silk-landscape'].includes(layout.id))await frame.locator('#canvas').screenshot({path:'/private/tmp/combo-'+layout.id+'.png'});
  }
  assert.deepEqual(errors,[]);console.log('PASS 32 layouts, all 11 GPU presets, animated pixels, one/two host compositions: '+engine.name());
 }finally{await browser.close();}
}
