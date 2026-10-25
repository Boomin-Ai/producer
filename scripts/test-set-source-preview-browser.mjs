import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'/private/tmp/producer-sets-v2-browser/node_modules/playwright-core/index.mjs');
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
 const page=await browser.newPage();await page.goto('http://127.0.0.1:1436/');
 await page.evaluate(async()=>{
  const callbacks=new Map();let serial=0;window.previewCalls=[];
  window.__TAURI_INTERNALS__={transformCallback:cb=>{callbacks.set(++serial,cb);return serial;},invoke:async(cmd,args)=>{
   if(cmd==='plugin:event|listen'){window.emitPreview=payload=>callbacks.get(args.handler)({payload});return 1;}
   if(cmd==='live_set_preview_sources')window.previewCalls.push(args);
  }};window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
  const R=await import('/node_modules/.vite/deps/react.js'),D=await import('/node_modules/.vite/deps/react-dom_client.js');
  const {SetPreview}=await import('/src/features/presentation/SetPreview.tsx');const {HEAD_TO_HEAD}=await import('/src/features/presentation/fixtures.ts');const {RehearsalSession}=await import('/src/features/presentation/rehearsal.ts');
  const session=new RehearsalSession(HEAD_TO_HEAD,undefined,'prepare');
  const host=document.createElement('div');host.style.width='900px';document.body.replaceChildren(host);const root=(D.createRoot??D.default.createRoot)(host);
  const output={bindings:{host:'camera-test'},framing:{host:{mode:'fill',x:0,y:0}},sources:{items:[{id:'camera-test',src_w:400,src_h:800}]}};
  window.renderPreview=()=>root.render((R.createElement??R.default.createElement)(SetPreview,{doc:HEAD_TO_HEAD,state:session.snapshot(),output}));window.renderPreview();
  window.changePreview=()=>{output.bindings={host:'image-test'};output.sources.items=[{id:'image-test',src_w:800,src_h:400}];window.renderPreview();};window.closePreview=()=>root.unmount();
 });
 const frame=page.frameLocator('iframe');await frame.locator('[data-slot="host"]').waitFor();
 await page.waitForFunction(()=>window.previewCalls.some(c=>c.ids.includes('camera-test')));
 await page.evaluate(()=>{const c=document.createElement('canvas');c.width=40;c.height=80;const x=c.getContext('2d');x.fillStyle='#19c75a';x.fillRect(0,0,40,80);window.testJpeg=c.toDataURL('image/jpeg').split(',')[1];window.emitPreview({type:'guest_thumbs',thumbs:[{id:'camera-test',jpeg:window.testJpeg}]});});
 const image=frame.locator('[data-slot="host"] img[data-live-source]');await image.waitFor();await image.evaluate(img=>img.decode());
 assert.equal(await frame.locator('[data-slot="host"]').getAttribute('aria-label'),'Host source preview');
 const geometry=await image.evaluate(el=>({w:parseFloat(el.style.width),h:parseFloat(el.style.height)}));assert.equal(geometry.h/geometry.w,2);
 await page.evaluate(()=>window.changePreview());await page.waitForFunction(()=>window.previewCalls.some(c=>c.ids.includes('image-test')));
 await frame.getByText('Waiting for video…',{exact:true}).waitFor();assert.equal(await frame.locator('[data-slot="host"] img').count(),0);
 await page.evaluate(()=>window.emitPreview({type:'guest_thumbs',thumbs:[{id:'image-test',jpeg:window.testJpeg}]}));await image.waitFor();
 await page.evaluate(()=>window.closePreview());await page.waitForFunction(()=>window.previewCalls.at(-1).ids.length===0);
 console.log('PASS: assigned hidden-source frames appear inside set preview; aspect restored, reassignment clears old picture, closing releases demand');
}finally{await browser.close();}
