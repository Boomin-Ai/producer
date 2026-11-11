import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'/private/tmp/producer-arrangement-browser/node_modules/playwright-core/index.mjs');
const browser=await chromium.launch({executablePath:process.env.PRODUCER_CHROME??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const origin=process.env.PRODUCER_TEST_URL??'http://127.0.0.1:1445/';
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route(origin,route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'}));
 await page.route(/\/src\/features\/assistant\/provider\.ts(?:\?.*)?$/,route=>route.fulfill({contentType:'application/javascript',body:`
   export const chatgpt={id:'chatgpt-plan',label:'ChatGPT',status:()=>window.mockAssistant.status(),models:async()=>[{slug:'test-model',display_name:'Test model'}],select:async()=>{},signIn:async()=>{window.signIns++;return 'test-attempt'},cancelSignIn:async()=>{},disconnect:async()=>true,cancel:async()=>{window.cancels++},turn:(turn,event)=>window.mockAssistant.turn(turn,event)};
   export const assistantProviders=[chatgpt];
 `}));
 await page.route('https://**',route=>route.abort());
 await page.goto(origin);
 await page.evaluate(async()=>{
  const refresh=await import('/@react-refresh');refresh.default.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
  window.nativeCalls=[];window.signIns=0;window.cancels=0;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
  const {AUTHORING_CATALOG}=await import('/src/features/presentation/authoring/catalog.ts');
  window.__TAURI_INTERNALS__={invoke:async(command)=>{window.nativeCalls.push(command);if(command==='assistant_authoring_capabilities')return {schema:'producer.native-authoring/1',catalogRevision:2,packageSchema:'producer.presentation/2',features:[...AUTHORING_CATALOG.features],nativeAdmission:'separate-native-preparation-required'};if(command==='plugin:app|version')return '0.4.90';if(command==='plugin:event|listen')return 1;return null;},transformCallback:()=>1,convertFileSrc:p=>p};
  window.mockAssistant={status:async()=>({accounts:[{id:'account-test',email:'test@example.invalid',planEnabled:true,verified:true}],active:'account-test',signIn:null}),turn:async(turn,event)=>{
    window.turns.push(structuredClone(turn));
    if(window.blockNextTurn)return await new Promise(resolve=>{window.releaseLate=()=>{event({type:'text',text:'Late result'});resolve([]);}});
    if(!turn.tools.length){event({type:'text',text:'Design sharing is off.'});return [{type:'message',role:'assistant',content:[{type:'output_text',text:'Design sharing is off.'}]}];}
    const results=turn.input.filter(i=>i.type==='function_call_output');
    if(!results.length)return [{type:'function_call',namespace:'producer',name:'inspect_set',arguments:'{}',call_id:'call-inspect'}];
    if(results.length===1||results.length===2){
      const inspected=JSON.parse(results[0].output),layout=inspected.context.set.layouts[0],node=layout.root.children.find(n=>n.type==='text')??layout.root.children[0];
      if(results.length===2&&JSON.parse(results[1].output).ok!==false)throw Error('Expected an invalid candidate to be rejected.');
      const command={type:'node.properties',layoutId:layout.id,nodeId:node.id,properties:{styles:{opacity:results.length===1?9:0.8}}};
      return [{type:'function_call',namespace:'producer',name:'edit_set',arguments:JSON.stringify({baseRevision:inspected.revision,label:'Refine headline',command_json:JSON.stringify(command)}),call_id:'call-edit-'+results.length}];
    }
    event({type:'text',text:'Refined your headline while preserving the Set controls.'});return [{type:'message',role:'assistant',content:[{type:'output_text',text:'Refined your headline while preserving the Set controls.'}]}];
  }};
  const R=await import('/node_modules/.vite/deps/react.js'),D=await import('/node_modules/.vite/deps/react-dom_client.js'),{default:Assistant}=await import('/src/features/assistant/SetAssistantDialog.tsx'),{parsePackage}=await import('/src/features/presentation/schema.ts');
  window.sourceDoc=parsePackage(await(await fetch('/src/features/presentation/fixtures/after-hours.json')).json());window.loads=[];window.turns=[];
  window.mountAssistant=()=>{const host=document.createElement('div');document.body.replaceChildren(host);window.root=(D.createRoot??D.default.createRoot)(host);window.root.render((R.createElement??R.default.createElement)(Assistant,{document:window.sourceDoc,onLoad:async doc=>{window.loads.push(doc)},onClose:()=>window.root.unmount()}));};
  window.mountAssistant();
 });
 await page.getByRole('combobox',{name:'Assistant model',exact:true}).waitFor();await page.waitForFunction(()=>document.querySelector('[aria-label="Assistant model"]')?.value==='test-model');
 await page.getByRole('textbox',{name:'Assistant prompt'}).fill('Refine the headline while preserving all existing controls.');await page.getByRole('button',{name:'Send ↗',exact:true}).click();
 await page.getByText('Refined your headline while preserving the Set controls.',{exact:true}).waitFor();
 await page.getByText('Validation details',{exact:true}).click();
 assert((await page.locator('.assistant-message.tool pre').innerText()).length>0,'the rejected candidate exposes actionable feedback');
 assert.equal(await page.evaluate(()=>window.loads.length),0,'tool calls only edit the private draft');
 await page.getByRole('button',{name:'Undo',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.assistant-history button:nth-child(2)').disabled);
 assert.equal(await page.getByRole('button',{name:'Load preparation',exact:true}).isDisabled(),true);
 await page.getByRole('button',{name:'Redo',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.assistant-footer button').disabled);
 await page.getByRole('button',{name:'Close Set assistant'}).click();await page.evaluate(()=>window.mountAssistant());
 await page.getByText('Restored your saved draft.',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Load preparation',exact:true}).click();
 await page.waitForFunction(()=>window.loads.length===1);
 assert.equal(await page.evaluate(()=>window.loads.length),1);assert.deepEqual(await page.evaluate(()=>window.loads[0].set.controls),await page.evaluate(()=>window.sourceDoc.set.controls));assert.deepEqual(await page.evaluate(()=>window.loads[0].set.controlArrangement),await page.evaluate(()=>window.sourceDoc.set.controlArrangement));
 // A failed continuation keeps its completed tool batch. Retry must not repeat
 // the user message, inspection or a previously committed draft edit.
 await page.evaluate(()=>{
  window.sourceDoc={...window.sourceDoc,id:'retry-continuation'};window.originalTurn=window.mockAssistant.turn;window.retryTurns=[];window.failedOnce=false;
  window.mockAssistant.turn=async(turn,event)=>{
   window.retryTurns.push(structuredClone(turn));const results=turn.input.filter(i=>i.type==='function_call_output');
   if(!results.length)return [{type:'function_call',namespace:'producer',name:'inspect_set',arguments:'{}',call_id:'retry-inspect'}];
   if(results.length===1&&!window.failedOnce){window.failedOnce=true;throw Error('Test connection closed before a response.');}
   if(results.length===1){const inspected=JSON.parse(results[0].output),layout=inspected.context.set.layouts[0],node=layout.root.children[0];return [{type:'function_call',namespace:'producer',name:'edit_set',call_id:'retry-edit',arguments:JSON.stringify({baseRevision:inspected.revision,label:'Recovered title',command_json:JSON.stringify({type:'node.properties',layoutId:layout.id,nodeId:node.id,properties:{styles:{opacity:.65}}})})}];}
   event({type:'text',text:'Recovered the same request.'});return [{type:'message',role:'assistant',content:[{type:'output_text',text:'Recovered the same request.'}]}];
  };window.mountAssistant();
 });
 await page.waitForFunction(()=>document.querySelector('[aria-label="Assistant model"]')?.value==='test-model');
 await page.getByRole('textbox',{name:'Assistant prompt'}).fill('Continue after a connection drop.');await page.getByRole('button',{name:'Send ↗',exact:true}).click();
 await page.getByRole('button',{name:'Retry request',exact:true}).click();await page.getByText('Recovered the same request.',{exact:true}).waitFor();
 assert.equal(await page.getByText('Continue after a connection drop.',{exact:true}).count(),1);
 assert.equal(await page.evaluate(()=>window.retryTurns.filter(t=>!t.input.some(i=>i.type==='function_call_output')).length),1,'inspection is not restarted');
 assert.equal(await page.evaluate(()=>window.retryTurns.at(-1).input.filter(i=>i.role==='user').length),1,'retry adds no duplicate user prompt');
 assert.equal(await page.evaluate(()=>window.retryTurns.at(-1).input.filter(i=>i.type==='function_call_output'&&i.call_id==='retry-edit').length),1,'completed draft edit is represented once');
 await page.getByRole('button',{name:'Close Set assistant'}).click();await page.evaluate(()=>{window.mockAssistant.turn=window.originalTurn});
 await page.evaluate(()=>{window.mountAssistant();window.blockNextTurn=true;});await page.waitForFunction(()=>document.querySelector('[aria-label="Assistant model"]')?.value==='test-model');
 await page.getByRole('textbox',{name:'Assistant prompt'}).fill('Another edit.');await page.getByRole('button',{name:'Send ↗',exact:true}).click();await page.waitForFunction(()=>typeof window.releaseLate==='function');await page.getByRole('button',{name:'Stop',exact:true}).click();await page.evaluate(()=>{window.releaseLate();window.blockNextTurn=false;});
 assert.equal(await page.getByText('Late result',{exact:true}).count(),0,'stopped provider results are fenced');
 await page.getByText('On request · Data shared',{exact:true}).click();await page.getByRole('checkbox',{name:'Share this Set’s design with ChatGPT'}).uncheck();
 await page.getByRole('textbox',{name:'Assistant prompt'}).fill('What can you help with?');await page.getByRole('button',{name:'Send ↗',exact:true}).click();await page.getByText('Design sharing is off.',{exact:true}).waitFor();assert.deepEqual(await page.evaluate(()=>window.turns.at(-1).tools),[]);assert.equal(await page.evaluate(()=>window.turns.at(-1).input.length),1,'changed sharing excludes old context/history');
 assert(!(await page.evaluate(()=>window.nativeCalls)).some(c=>/live_.*(apply|create|start|stop|record|stream)/.test(c)),'assistant never owns native output');
 assert.deepEqual(errors,[]);
 if(process.env.PRODUCER_ASSISTANT_SCREENSHOT){await fs.mkdir(new URL('.',`file://${process.env.PRODUCER_ASSISTANT_SCREENSHOT}`).pathname,{recursive:true});await page.screenshot({path:process.env.PRODUCER_ASSISTANT_SCREENSHOT});}
 console.log('PASS Assistant browser: real worker/IndexedDB, completed tool loop, private preview, authored controls preserved, undo/redo, saved draft restore, cancellation, data-policy history reset, explicit preparation load; no native output calls.');
} finally {await browser.close();}
