import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'/private/tmp/producer-arrangement-browser/node_modules/playwright-core/index.mjs');
const browser=await chromium.launch({executablePath:process.env.PRODUCER_CHROME??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1100,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route(/\/src\/lib\/dataIntegrations\.ts(?:\?.*)?$/,route=>route.fulfill({contentType:'application/javascript',body:'export const dataIntegrations={authoringCapabilities:(...args)=>window.mockIntegrations.authoringCapabilities(...args),authorDesign:(...args)=>window.mockIntegrations.authorDesign(...args),list:(...args)=>window.mockIntegrations.list(...args),authorSet:(...args)=>window.mockIntegrations.authorSet(...args)};'}));
 await page.route(process.env.PRODUCER_TEST_URL??'http://127.0.0.1:1436/',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'}));
 await page.goto(process.env.PRODUCER_TEST_URL??'http://127.0.0.1:1436/');
 await page.evaluate(async()=>{
  const refresh=await import('/@react-refresh');refresh.default.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
  await import('/src/features/presentation/presentation.css');
  const R=await import('/node_modules/.vite/deps/react.js'),D=await import('/node_modules/.vite/deps/react-dom_client.js'),{PackageAuthoringDialog}=await import('/src/features/presentation/PackageAuthoringDialog.tsx'),{dataIntegrations}=await import('/src/lib/dataIntegrations.ts'),{setActiveEndpointId}=await import('/src/lib/workspace.ts'),{parsePackage}=await import('/src/features/presentation/schema.ts');
  const doc=parsePackage(await(await fetch('/src/features/presentation/fixtures/after-hours.json')).json());window.draftDoc={...doc,name:'Generated magazine'};window.loads=[];window.authorCalls=[];
  setActiveEndpointId('authoring-browser-test');
  window.mockIntegrations={};window.mockIntegrations.list=async()=>({connections:[{connection:{id:'claude',name:'Studio Claude',kind:'agent',provider:'anthropic',model:'test-model',webSearch:false,maxOutputTokens:4096},revision:3,hasSecret:true,status:'ready',error:'',testedAt:1}],capabilities:[]});
  window.mockIntegrations.authorSet=async(endpoint,id,body)=>{window.authorCalls.push({endpoint,id,body});return new Promise(resolve=>{window.resolveDraft=()=>resolve({connectionId:'claude',connectionRevision:3,provider:'anthropic',model:'test-model',package:window.draftDoc});});};
  window.__TAURI_INTERNALS__={invoke:async cmd=>cmd==='plugin:app|version'?'0.4.78':cmd==='live_set_v2_capabilities'?['mask@1','backdrop@1','chart@1']:true};
  window.mockIntegrations.authoringCapabilities=async()=>({revision:1,features:['core@1','shader.voiceBars@1']});
  window.mockIntegrations.authorDesign=async(endpoint,id,body)=>{window.authorCalls.push({endpoint,id,body});return {connectionId:'claude',connectionRevision:3,provider:'anthropic',model:'test-model',document:{schema:'producer.design-plan/1',id:'compiled',name:'Compiled studio',background:'#000000',layouts:[{id:'main',name:'Main',orientation:'landscape',elements:[{id:'host',kind:'camera',slot:'host',bounds:[0,0,1920,1080]}]}]}};};
  const host=document.createElement('div');document.body.replaceChildren(host);const root=(D.createRoot??D.default.createRoot)(host);
  root.render((R.createElement??R.default.createElement)(PackageAuthoringDialog,{doc,intent:'edit-set',returnFocus:null,onLoad:doc=>window.loads.push(doc),onClose:()=>root.unmount()}));
 });
 await page.getByRole('combobox',{name:'Saved Claude connection'}).selectOption('claude');
 await page.getByRole('checkbox',{name:'Use design compiler',exact:true}).check();
 await page.getByText('Design compiler ready.',{exact:false}).waitFor();
 await page.getByRole('textbox',{name:'Changes to request'}).fill('Make a solo host studio');
 await page.getByRole('button',{name:'Generate draft',exact:true}).click();
 await page.getByRole('region',{name:'Validated draft preview'}).waitFor();
 assert.equal(await page.evaluate(()=>window.authorCalls.length),1);
 assert.deepEqual(await page.evaluate(()=>window.authorCalls[0].body.target.features),['core@1','shader.voiceBars@1']);
 assert.equal(await page.evaluate(()=>window.loads.length),0);
 await page.getByRole('button',{name:'Load preparation',exact:true}).click();
 assert.equal(await page.evaluate(()=>window.loads[0].id),'compiled');assert.deepEqual(errors,[]);
 console.log('PASS: installed/workspace capability intersection → saved Claude request → local compilation → private preview → explicit load.');
}finally{await browser.close();}
