import fs from 'node:fs';
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'../target/browser-check/node_modules/playwright-core/index.mjs');
const browser=await chromium.launch({channel:'chrome'});fs.mkdirSync('target/road-to-v1',{recursive:true});
try{
 const page=await browser.newPage({viewport:{width:1400,height:1200}});await page.goto('http://127.0.0.1:1436/');await page.addStyleTag({content:'.set-preview{position:relative;width:100%;overflow:hidden}.set-preview iframe{position:absolute;inset:0;display:block;width:100%;height:100%;border:0}'});
 await page.evaluate(async(sample)=>{
  const callbacks=new Map();let serial=0;window.__TAURI_INTERNALS__={transformCallback:cb=>{callbacks.set(++serial,cb);return serial;},invoke:async(cmd,args)=>{if(cmd==='plugin:event|listen'){window.emit=p=>callbacks.get(args.handler)({payload:p});return 1;}}};window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(){}};
  const M=await import('/node_modules/.vite/deps/react.js'),R=M.default??M,D=await import('/node_modules/.vite/deps/react-dom_client.js'),{SetPreview}=await import('/src/features/presentation/SetPreview.tsx'),{RehearsalSession}=await import('/src/features/presentation/rehearsal.ts');
  window.doc=await(await fetch('/docs/shows/road-to-v1.json')).json();const host=document.createElement('main');document.body.replaceChildren(host);document.body.style.margin='0';const root=(D.createRoot??D.default.createRoot)(host),session=new RehearsalSession(window.doc);if(sample)session.send({type:'field',key:'liveCaption',value:sample.slice(-window.doc.set.values.liveCaption.maxLength)});
  window.preview=id=>{const l=window.doc.set.layouts.find(l=>l.id===id);host.style.width=l.width>l.height?'1280px':'540px';root.render(R.createElement(SetPreview,{doc:window.doc,state:{...session.snapshot(),layoutId:id},output:{bindings:{host:'host-preview'},framing:{},sources:{items:[{id:'host-preview',src_w:480,src_h:640}]}}}));};
  window.frame=()=>{const c=document.createElement('canvas');c.width=480;c.height=640;const x=c.getContext('2d');x.fillStyle='#14161b';x.fillRect(0,0,480,640);x.fillStyle='#a4a6ad';x.beginPath();x.ellipse(240,230,98,120,0,0,Math.PI*2);x.fill();x.beginPath();x.ellipse(240,640,215,260,0,0,Math.PI*2);x.fill();x.fillStyle='white';x.font='22px Arial';x.textAlign='center';x.fillText('HOST CAMERA',240,600);window.emit?.({type:'guest_thumbs',thumbs:[{id:'host-preview',jpeg:c.toDataURL('image/jpeg').split(',')[1]}]});};
 },process.env.PRODUCER_CAPTION_PREVIEW??'');
 for(const id of ['live-landscape','live-portrait','title-landscape','title-portrait','sea-landscape','sea-portrait']){
  await page.evaluate(id=>window.preview(id),id);await page.frameLocator('iframe').locator('canvas[data-effect="launchV1"]').first().waitFor();await page.waitForTimeout(1000);await page.evaluate(()=>window.frame());await page.waitForTimeout(300);await page.locator('.set-preview').screenshot({path:`target/road-to-v1/${id}.png`});
 }
 console.log('PASS: six actual SetPreview compositions with embedded artwork and live shader preview.');
}finally{await browser.close();}
