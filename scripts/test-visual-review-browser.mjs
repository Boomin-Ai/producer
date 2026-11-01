import assert from 'node:assert/strict';
import {chromium} from '../tools/producer-mcp/node_modules/playwright-core/index.mjs';
const browser=await chromium.launch({executablePath:process.env.PRODUCER_CHROME??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const url=process.env.PRODUCER_TEST_URL??'http://127.0.0.1:1436/';
 await page.route(url,route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'}));await page.goto(url);
 await page.evaluate(async()=>{
  const refresh=await import('/@react-refresh');refresh.default.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
  const R=await import('/node_modules/.vite/deps/react.js'),D=await import('/node_modules/.vite/deps/react-dom_client.js');
  const {VisualReview}=await import('/src/features/presentation/authoring/VisualReview.tsx');
  const {compileDesignPlan}=await import('/src/features/presentation/authoring/compiler.ts');
  const doc=compileDesignPlan({schema:'producer.design-plan/1',id:'review',name:'Review',background:'#000000',layouts:[{id:'main',name:'Main',orientation:'landscape',elements:[{id:'ring',kind:'effect',bounds:[200,200,500,500],effect:'voiceRing',radius:250},{id:'host',kind:'camera',bounds:[300,300,400,400],slot:'host',radius:200},{id:'headline',kind:'text',bounds:[900,100,180,40],size:72,text:'This headline needs more space'}]}]},{catalogRevision:1,features:['core@1','shader.voiceRing@1']});
  window.original=JSON.stringify(doc);window.doc=doc;window.repairs=[];window.calls=[];
  window.__TAURI_INTERNALS__={invoke:cmd=>{window.calls.push(cmd);throw Error('Visual review must not call native devices or room actions');}};
  const react=R.default??R,createRoot=D.createRoot??D.default.createRoot;
  const host=document.createElement('div');document.body.append(host);window.root=createRoot(host);
  function App(){const [value,setValue]=react.useState(doc);return react.createElement(VisualReview,{doc:value,onRepair:fixed=>{window.repairs.push(fixed);setValue(fixed);}});}
  window.root.render(react.createElement(App));
 });
 await page.getByRole('button',{name:'Fit ring around host · main'}).waitFor();
 await page.getByText(/Text needs/).waitFor();
 await page.getByRole('button',{name:'Fit ring around host · main'}).click();
 await page.waitForFunction(()=>window.repairs.length===1);
 await page.getByText('1 findings to review.',{exact:false}).waitFor();
 assert.equal(await page.evaluate(()=>JSON.stringify(window.doc)),await page.evaluate(()=>window.original));
 assert.equal(await page.evaluate(()=>window.repairs[0].set.layouts[0].root.children[0].shader.radius),200);
 assert.deepEqual(await page.evaluate(()=>window.calls),[]);
 await page.evaluate(()=>window.root.unmount());assert.equal(await page.locator('iframe').count(),0);assert.deepEqual(errors,[]);
 console.log('PASS: dev visual review reports text overflow, repairs selected ring, retains original, makes no native calls and cleans up hidden renderers.');
}finally{await browser.close();}
