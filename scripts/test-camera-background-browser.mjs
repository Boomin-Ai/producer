import assert from 'node:assert/strict';
import {build} from 'esbuild';
const bundle=await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`
 import React from 'react'; import {createRoot} from 'react-dom/client';
 import {CameraBackgroundControls} from './src/features/presentation/CameraBackgroundControls';
 const f=window.fixture={requests:[],listeners:new Set()};
 const request=(op,source,mode)=>new Promise((resolve,reject)=>f.requests.push({op,source,mode,resolve,reject}));
 const controls={read:(slot,source)=>request('read',source),set:(slot,source,mode)=>request('set',source,mode),subscribe:listener=>{f.listeners.add(listener);return()=>f.listeners.delete(listener);}};
 const root=createRoot(document.getElementById('root'));
 window.render=(source='camera-a',disabled=false)=>root.render(<CameraBackgroundControls slot="host" source={source} label="Host" controls={controls} disabled={disabled}/>);
 window.resolve=(index,mode)=>f.requests[index].resolve(mode);
 window.reject=(index)=>f.requests[index].reject(Error('Camera update failed. Retry.'));
 window.changed=source=>{for(const listener of f.listeners)listener(source);};
 window.closeControl=()=>root.unmount();
 window.render();
 `},bundle:true,format:'iife',platform:'browser',write:false});
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??new URL('../tools/producer-mcp/node_modules/playwright-core/index.mjs',import.meta.url).href);
const browser=await chromium.launch({headless:true,...(process.env.PRODUCER_TEST_CHROME?{executablePath:process.env.PRODUCER_TEST_CHROME}:{channel:process.env.PRODUCER_BROWSER_CHANNEL??'chrome'})});
const errors=[];
try{
 const page=await browser.newPage();page.on('pageerror',error=>errors.push(error.message));await page.route('**/*',route=>route.abort());await page.clock.install();
 await page.setContent('<div id="root"></div>');await page.addScriptTag({content:bundle.outputFiles[0].text});
 await page.waitForFunction(()=>window.fixture.requests.length===1);
 const framed=page.getByRole('button',{name:'Host Framed',exact:true}),cutout=page.getByRole('button',{name:'Host Cutout',exact:true});
 assert.equal(await framed.isDisabled(),true);assert.equal(await cutout.getAttribute('aria-pressed'),'false');
 await page.evaluate(()=>window.resolve(0,'framed'));await page.waitForFunction(()=>document.querySelector('[aria-label="Host Framed"]').getAttribute('aria-pressed')==='true');
 await cutout.click();assert.equal(await cutout.isDisabled(),true);assert.equal(await cutout.getAttribute('aria-pressed'),'false','Pending mutation does not claim confirmation');
 await page.evaluate(()=>window.resolve(1,'cutout'));await page.waitForFunction(()=>document.querySelector('[aria-label="Host Cutout"]').getAttribute('aria-pressed')==='true');
 console.log('PASS: actual React buttons wait for native receipt and expose pending state');

 await page.evaluate(()=>window.changed('camera-a'));await page.waitForFunction(()=>window.fixture.requests.length===3);
 await page.evaluate(()=>window.resolve(2,'soft'));await page.getByRole('status').filter({hasText:'Soft background'}).waitFor();
 await page.clock.fastForward(120_000);assert.equal(await page.evaluate(()=>window.fixture.requests.length),3,'No background polling');
 console.log('PASS: normal Filters changes refresh confirmed background without polling');

 await cutout.click();await page.evaluate(()=>window.reject(3));await page.getByRole('alert').waitFor();
 assert.equal(await framed.getAttribute('aria-pressed'),'false');assert.equal(await cutout.getAttribute('aria-pressed'),'false');assert.equal(await cutout.isEnabled(),true);
 await page.getByRole('button',{name:'Retry applying/saving',exact:true}).click();
 assert.deepEqual(await page.evaluate(()=>{const {op,source,mode}=window.fixture.requests[4];return {op,source,mode};}),{op:'set',source:'camera-a',mode:'cutout'},'Failed save retries the original mutation/persistence intent, not a read');
 await page.evaluate(()=>window.resolve(4,'cutout'));await page.getByRole('alert').waitFor({state:'detached'});
 console.log('PASS: native/save failure retries the requested mode and cannot replace persistence with a read');

 await cutout.click();await page.evaluate(()=>window.render('camera-b'));await page.waitForFunction(()=>window.fixture.requests.length===7);
 await page.evaluate(()=>window.resolve(6,'framed'));await page.waitForFunction(()=>document.querySelector('[aria-label="Host Framed"]').getAttribute('aria-pressed')==='true');
 await page.evaluate(()=>window.resolve(5,'cutout'));await page.clock.runFor(50);
 assert.equal(await framed.getAttribute('aria-pressed'),'true');assert.equal(await cutout.getAttribute('aria-pressed'),'false');
 console.log('PASS: late old-camera completion cannot label the rebound camera');

 await page.evaluate(()=>window.changed('camera-b'));await page.waitForFunction(()=>window.fixture.requests.length===8);
 await page.evaluate(()=>window.reject(7));await page.getByRole('button',{name:'Check camera',exact:true}).click();
 assert.equal(await page.evaluate(()=>window.fixture.requests[8].op),'read','Only read failure offers a read retry');
 await page.evaluate(()=>window.resolve(8,'framed'));await page.getByRole('alert').waitFor({state:'detached'});
 console.log('PASS: camera read failures retain their separate Check camera retry');

 await page.evaluate(()=>window.render('camera-b',true));await page.clock.runFor(50);const count=await page.evaluate(()=>window.fixture.requests.length);
 assert.equal(await cutout.isDisabled(),true);await page.clock.fastForward(60_000);assert.equal(await page.evaluate(()=>window.fixture.requests.length),count);
 await page.evaluate(()=>window.closeControl());assert.equal(await page.evaluate(()=>window.fixture.listeners.size),0);assert.deepEqual(errors,[]);
 console.log('PASS: disabled/rehearsal controls stay inert and unmount releases the listener');
}finally{await browser.close();}
