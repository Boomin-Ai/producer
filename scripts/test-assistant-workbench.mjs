import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'playwright-core');
const browser=await chromium.launch({executablePath:process.env.PRODUCER_CHROME??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const origin=process.env.PRODUCER_TEST_URL??'http://127.0.0.1:1445/';
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.route(origin,route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'}));
 await page.route('https://**',route=>route.abort());
 await page.goto(origin);
 await page.evaluate(async()=>{
  const refresh=await import('/@react-refresh');refresh.default.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
  const {AUTHORING_CATALOG}=await import('/src/features/presentation/authoring/catalog.ts');
  window.nativeCalls=[];window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
  window.__TAURI_INTERNALS__={invoke:async command=>{
   window.nativeCalls.push(command);
   if(command==='plugin:app|name')return 'Producer DJ Test';
   if(command==='plugin:event|listen')return 1;
   if(command==='plugin:event|unlisten')return;
   if(command==='set_library_list')return [];
   if(command==='assistant_status')return {accounts:[],active:null,signIn:window.signInStatus??null};
   if(command==='assistant_sign_in'){window.signInStatus={id:'test-attempt',status:'waiting',error:null,expiresAt:Math.floor(Date.now()/1000)+900};return 'test-attempt';}
   if(command==='assistant_cancel_sign_in'){window.signInStatus=null;return;}
   if(command==='assistant_authoring_capabilities')return {schema:'producer.native-authoring/1',catalogRevision:2,packageSchema:'producer.presentation/2',features:[...AUTHORING_CATALOG.features],nativeAdmission:'separate-native-preparation-required'};
   throw Error('Unexpected native command in authoring-only view: '+command);
  },transformCallback:()=>1,convertFileSrc:path=>path};
  const R=await import('/node_modules/.vite/deps/react.js'),D=await import('/node_modules/.vite/deps/react-dom_client.js'),{default:Workbench}=await import('/src/features/assistant/AssistantWorkbench.tsx');
  const host=document.createElement('div');document.body.append(host);window.root=(D.createRoot??D.default.createRoot)(host);window.root.render((R.createElement??R.default.createElement)(Workbench));
 });
 await page.getByRole('button',{name:'Assistant',exact:true}).click();
 await page.getByRole('button',{name:'Continue with ChatGPT',exact:true}).waitFor();
 await page.getByText('After Hours',{exact:true}).first().waitFor();
 await page.getByRole('button',{name:'Continue with ChatGPT',exact:true}).click();
 await page.getByText(/^Complete the newest browser sign-in by/).waitFor();
 await page.getByRole('button',{name:'Cancel sign-in',exact:true}).click();
 await page.getByRole('button',{name:'Continue with ChatGPT',exact:true}).waitFor();
 await page.getByRole('button',{name:'Close Set assistant',exact:true}).click();
 assert.deepEqual(errors,[]);
 assert((await page.evaluate(()=>window.nativeCalls)).every(command=>!command.startsWith('live_')),'authoring verification must not start or query the live engine');
 console.log('PASS authoring-only dev view: real Set editor and Assistant, no room or capture commands, login entry, explicit browser deadline and cancellation. Authentication is separately qualified in the signed app.');
} finally {await browser.close();}
