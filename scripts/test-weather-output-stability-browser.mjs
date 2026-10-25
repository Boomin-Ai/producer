import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'/private/tmp/producer-sets-v2-browser/node_modules/playwright-core/index.mjs');
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:1436/');
 await page.evaluate(async()=>{
  const R=await import('/node_modules/.vite/deps/react.js'),D=await import('/node_modules/.vite/deps/react-dom_client.js');
  const {RehearsalSession}=await import('/src/features/presentation/rehearsal.ts'),{OutputSettings}=await import('/src/features/presentation/OutputSettings.tsx'),{setOutputProjection}=await import('/src/features/presentation/useSetOutput.ts'),{AssetTransport}=await import('/src/features/presentation/assetTransport.ts');
  const doc=await(await fetch('/docs/shows/atmosphere.json')).json();window.session=new RehearsalSession(doc,undefined,'prepare');window.session.enterRehearsal();window.updates=[];window.monitor={};
  window.__TAURI_INTERNALS__={transformCallback:()=>1,invoke:async cmd=>cmd==='live_set_status'?{generation:1}:cmd==='live_virtual_cam_mirror'?false:undefined};
  const s=window.session;window.weather=(temperature)=>{const m=s.moduleSnapshot();return s.receiveModuleData({id:crypto.randomUUID(),setEpoch:m.setEpoch,module:'sky',epoch:m.modules.sky.epoch,op:'weather.update',input:{observedAt:Date.now(),temperature,condition:'clear',isDay:true,wind:12,precipitation:0,provider:'Test',location:'Atlanta',units:'fahrenheit'}});};
  window.weather(52);
  const root=document.createElement('div');document.body.replaceChildren(root);(D.createRoot??D.default.createRoot)(root).render((R.createElement??R.default.createElement)(OutputSettings,{icon:'Settings',session:s,view:'both',onMonitor:m=>{window.monitor=m;},output:{renderer:'native',active:true,bindings:{},framing:{},sources:{items:[]},applyPortrait:async p=>window.updates.push(p),stopPortrait:async()=>{}}}));
  const media=new AssetTransport(),a=setOutputProjection(s,0,'view0-portrait'),b=setOutputProjection(s,0,'view0-portrait');window.clockStable=JSON.stringify(a.timeline.clock)===JSON.stringify(b.timeline.clock);window.signatureStable=JSON.stringify(media.signature(a))===JSON.stringify(media.signature({...b,moduleCommit:{...b.moduleCommit,revision:b.moduleCommit.revision+1}}));
 });
 await page.waitForFunction(()=>window.updates.length===1);await page.waitForTimeout(2300);
 assert.equal(await page.evaluate(()=>window.updates.length),1,'idle polling must not reactivate the native canvas');assert(await page.evaluate(()=>window.clockStable&&window.signatureStable),'shader clock and invisible commits must not change the visual identity');
 await page.evaluate(()=>window.weather(53));await page.waitForFunction(()=>window.updates.length===2);await page.waitForTimeout(1200);
 const result=await page.evaluate(()=>({updates:window.updates.map(p=>({assets:Object.keys(p.assets??{}),text:JSON.stringify(p.root)})),error:window.monitor.error}));assert.equal(result.updates.length,2);assert.equal(result.error,'');
 for(const update of result.updates)assert(update.assets.includes('portrait')&&update.assets.includes('bezel'),'each native compilation receives a complete manifest');assert(result.updates[1].text.includes('53°F'));assert.deepEqual(errors,[]);
 console.log('PASS: nested weather shader clock stays stable; idle polling and invisible commits do not take frames; changed weather sends the complete native portrait manifest');
}finally{await browser.close();}
