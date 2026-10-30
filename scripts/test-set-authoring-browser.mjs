import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'/private/tmp/producer-arrangement-browser/node_modules/playwright-core/index.mjs');
const browser=await chromium.launch({executablePath:process.env.PRODUCER_CHROME??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1100,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route(/\/src\/lib\/dataIntegrations\.ts(?:\?.*)?$/,route=>route.fulfill({contentType:'application/javascript',body:'export const dataIntegrations={list:(...args)=>window.mockIntegrations.list(...args),authorSet:(...args)=>window.mockIntegrations.authorSet(...args)};'}));
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
  const host=document.createElement('div');document.body.replaceChildren(host);const root=(D.createRoot??D.default.createRoot)(host);
  root.render((R.createElement??R.default.createElement)(PackageAuthoringDialog,{doc,intent:'edit-set',returnFocus:null,onLoad:doc=>window.loads.push(doc),onClose:()=>root.unmount()}));
 });
 await page.getByRole('combobox',{name:'Saved Claude connection'}).selectOption('claude');
 const prompt=page.getByRole('textbox',{name:'Changes to request'});await prompt.fill('A cream and black magazine Set');await page.getByRole('button',{name:'Generate draft',exact:true}).click();
 assert.equal(await page.getByRole('button',{name:'Load preparation'}).isDisabled(),true);
 assert.equal(await page.evaluate(()=>window.authorCalls[0].body.package),undefined,'fresh draft does not silently send current Set');
 await prompt.fill('Revised prompt while waiting');await page.evaluate(()=>window.resolveDraft());await page.waitForTimeout(50);assert.equal(await page.getByRole('region',{name:'Validated draft preview'}).count(),0,'edited prompt rejects stale generation');
 await page.getByRole('button',{name:'Generate draft',exact:true}).click();await page.evaluate(()=>window.resolveDraft());await page.getByRole('region',{name:'Validated draft preview'}).waitFor();assert.equal(await page.locator('iframe').count(),1);assert.equal(await page.evaluate(()=>window.loads.length),0,'validation and preview never load automatically');
 await page.getByRole('button',{name:'Load preparation',exact:true}).click();assert.equal(await page.evaluate(()=>window.loads.length),1);assert.equal(await page.evaluate(()=>window.loads[0].name),'Generated magazine');assert.equal(await page.locator('dialog').count(),0);
 assert.deepEqual(errors,[]);
 console.log('PASS: prompt → validated preview → explicit preparation load, with saved Claude selection, fresh scope and late-response fencing');
}finally{await browser.close();}
