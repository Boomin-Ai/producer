import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';

const source=(await readFile(new URL('../src/views/Home.tsx',import.meta.url),'utf8')).replaceAll('\r\n','\n');
const start=source.indexOf('  useEffect(() => {\n    if (view.kind !== "opening") return;');
assert(start>=0,'Room opening effect is present');
const end=source.indexOf('  }, [view]);',start)+'  }, [view]);'.length;
const bundle=await build({
  stdin:{contents:`
    import React,{useEffect,useState,startTransition} from 'react';
    import {createRoot} from 'react-dom/client';
    import {ipc} from './src/lib/ipc';
    function Harness(){
      const [view,setView]=useState({kind:'home'});
      window.openCard=room=>setView({kind:'opening',room});
      window.cancelOpening=()=>setView({kind:'home'});
      useEffect(()=>{window.currentView=view;},[view]);
      ${source.slice(start,end)}
      return null;
    }
    createRoot(document.getElementById('root')).render(<Harness/>);
  `,resolveDir:process.cwd(),loader:'tsx'},
  bundle:true,write:false,platform:'browser',format:'iife',
});
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??
  new URL('../tools/producer-mcp/node_modules/playwright-core/index.mjs',import.meta.url).href);
const browser=await chromium.launch({headless:true,...(process.env.PRODUCER_TEST_CHROME?
  {executablePath:process.env.PRODUCER_TEST_CHROME}:{channel:'chrome'})});
try{
  const page=await browser.newPage();
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.setContent('<div id="root"></div>');
  await page.evaluate(()=>{
    window.requests=[];
    window.__TAURI_INTERNALS__={transformCallback:()=>1,invoke:(command,args)=>{
      if(command!=='live_list_rooms')throw Error('Unexpected command '+command);
      return new Promise((resolve,reject)=>window.requests.push({args,resolve,reject}));
    }};
  });
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  await page.waitForFunction(()=>typeof window.openCard==='function');
  const oldRoom={id:'room-a',endpoint_id:'workspace',name:'Test room',config:'{"studio_output":false}'};
  const latest={...oldRoom,config:'{"studio_output":true,"active_scene":"window"}'};
  await page.evaluate(room=>window.openCard(room),oldRoom);
  await page.waitForFunction(()=>window.requests.length===1);
  assert.equal(await page.evaluate(()=>window.currentView.kind),'opening');
  assert.deepEqual(await page.evaluate(()=>window.requests[0].args),{endpointId:'workspace'});
  await page.evaluate(room=>window.requests[0].resolve([room]),latest);
  await page.waitForFunction(()=>window.currentView.kind==='room');
  assert.deepEqual(await page.evaluate(()=>window.currentView.room),latest);

  await page.evaluate(room=>window.openCard(room),oldRoom);
  await page.waitForFunction(()=>window.requests.length===2);
  await page.evaluate(()=>window.cancelOpening());
  await page.evaluate(room=>window.requests[1].resolve([room]),latest);
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(()=>window.currentView.kind),'home');

  await page.evaluate(room=>window.openCard(room),oldRoom);
  await page.waitForFunction(()=>window.requests.length===3);
  const roomB={...latest,id:'room-b',name:'Other room'};
  await page.evaluate(room=>window.openCard(room),roomB);
  await page.waitForFunction(()=>window.requests.length===4);
  await page.evaluate(room=>window.requests[2].resolve([room]),latest);
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(()=>window.currentView.kind),'opening');
  await page.evaluate(room=>window.requests[3].resolve([room]),roomB);
  await page.waitForFunction(()=>window.currentView.kind==='room');
  assert.deepEqual(await page.evaluate(()=>window.currentView.room),roomB);

  await page.evaluate(room=>window.openCard(room),oldRoom);
  await page.waitForFunction(()=>window.requests.length===5);
  await page.evaluate(()=>window.requests[4].reject(Error('Native database unavailable')));
  await page.waitForFunction(()=>window.currentView.kind==='room');
  assert.deepEqual(await page.evaluate(()=>window.currentView.room),oldRoom);
  assert.deepEqual(errors,[]);
  console.log('PASS: room opening uses the latest saved document, ignores cancelled and superseded reads, and retains offline fallback.');
}finally{await browser.close();}
