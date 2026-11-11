import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'playwright-core');
const browser=await chromium.launch({executablePath:process.env.PRODUCER_CHROME??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const origin=process.env.PRODUCER_TEST_URL??'http://127.0.0.1:1445/';
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route(origin,route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'}));
 await page.route(/\/src\/features\/assistant\/provider\.ts(?:\?.*)?$/,route=>route.fulfill({contentType:'application/javascript',body:`export const chatgpt={status:async()=>({accounts:[{id:'test',email:'test@example.invalid',planEnabled:true}],active:'test'}),models:async()=>[{slug:'test',display_name:'Test'}],cancel:async()=>{},turn:(t,e)=>window.respond(t,e)};`}));
 await page.route('https://**',route=>route.abort());await page.goto(origin);
 await page.evaluate(async()=>{
  const refresh=await import('/@react-refresh');refresh.default.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;
  const {AUTHORING_CATALOG}=await import('/src/features/presentation/authoring/catalog.ts');
  const target={catalogRevision:AUTHORING_CATALOG.revision,features:[...AUTHORING_CATALOG.features]};
  window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
  window.__TAURI_INTERNALS__={invoke:async c=>c==='assistant_authoring_capabilities'?{schema:'producer.native-authoring/1',...target,packageSchema:'producer.presentation/2',nativeAdmission:'separate-native-preparation-required'}:c==='plugin:app|version'?'0.4.90':null,transformCallback:()=>1,convertFileSrc:p=>p};
  const R=await import('/node_modules/.vite/deps/react.js'),D=await import('/node_modules/.vite/deps/react-dom_client.js'),{default:Assistant}=await import('/src/features/assistant/SetAssistantDialog.tsx');
  const {parsePackage}=await import('/src/features/presentation/schema.ts');
  const fixture=parsePackage(await(await fetch('/src/features/presentation/fixtures/after-hours.json')).json());
  const scene=()=>({id:'testScene',type:'scene3d',styles:{position:'absolute',left:0,top:0,width:100,height:100},scene3d:{id:'test-scene',pass:'background',music:{sensitivity:1,intensity:1,waveform:false,waveHeight:0,drop:0,money:false,color:'#ffffff',motion:.2},world:{schema:'producer.scene3d/1',fps:30,clearColor:'#000000',fog:{color:'#000000',near:10,far:100},camera:{position:[0,0,10],target:[0,0,0],fov:45},objects:[],slots:[]}}});
  window.fixture=fixture;window.loads=[];window.turns=[];window.target=target;
  window.mount=doc=>{window.root?.unmount();const host=document.createElement('div');document.body.replaceChildren(host);window.root=(D.createRoot??D.default.createRoot)(host);window.root.render((R.createElement??R.default.createElement)(Assistant,{document:doc,onLoad:async d=>window.loads.push(d),onClose:()=>window.root.unmount()}));};
  const invalid=structuredClone(fixture);invalid.id='preview-recovery';invalid.set.layouts[0].root.children.push(scene());window.invalid=invalid;
  window.respond=async (turn,event)=>{
   window.turns.push(turn);
   const results=turn.input.filter(i=>i.type==='function_call_output');
   if(!results.length)return [{type:'function_call',name:'inspect_set',arguments:'{}',call_id:'inspect'}];
   if(results.length===1){const inspected=JSON.parse(results[0].output),nodes=inspected.context.set.layouts[0].root.children,index=nodes.findIndex(n=>n.id==='testScene');return [{type:'function_call',name:'edit_set',call_id:'repair',arguments:JSON.stringify({baseRevision:inspected.revision,label:'Repair preview',command_json:JSON.stringify({type:'canonical',edit:{schema:'producer.set-edit/2',baseRevision:inspected.revision,operations:[{op:'replace',path:'/set/layouts/0/root/children/'+index+'/scene3d/music/waveform',value:'off'},{op:'replace',path:'/set/layouts/0/root/children/'+index+'/scene3d/music/waveHeight',value:.25}]}})})}];}
   event({type:'text',text:'Repaired the default projection.'});return [{type:'message',role:'assistant',content:[{type:'output_text',text:'Repaired the default projection.'}]}];
  };
  window.makeScene=scene;window.mount(invalid);
 });
 await page.getByRole('heading',{name:'Preview needs a correction'}).waitFor();
 assert(await page.getByRole('button',{name:'Load preparation',exact:true}).isDisabled());
 await page.getByText('Test',{exact:true}).waitFor();
 await page.getByRole('textbox',{name:'Assistant prompt'}).fill('Repair the preview.');await page.getByRole('button',{name:'Send ↗',exact:true}).click();
 await page.getByText('Repaired the default projection.',{exact:true}).waitFor();
 assert.equal(await page.getByRole('heading',{name:'Preview needs a correction'}).count(),0,'a valid revision resets the preview boundary');
 assert((await page.evaluate(()=>window.turns[0].instructions)).includes('Invalid music visual controls'),'isolated preview diagnostic reaches the repair turn');
 const geometry=await page.evaluate(()=>window.invalid.set.layouts.map(l=>({id:l.id,ratio:l.width/l.height})));
 for(const layout of geometry){
  await page.getByRole('combobox',{name:'Assistant preview layout',exact:true}).selectOption(layout.id);
  const box=await page.locator('.assistant-preview-canvas>.set-preview').boundingBox(),frame=await page.locator('.assistant-preview-canvas iframe').boundingBox();
  assert(Math.abs((box.width-2)/(box.height-2)-layout.ratio)<.02,'Assistant preserves each canvas aspect ratio');
  assert(Math.abs(frame.width-(box.width-2))<2&&Math.abs(frame.height-(box.height-2))<2,'iframe fills the measured canvas without intrinsic-size distortion');
 }
 await page.getByRole('button',{name:'Load preparation',exact:true}).click();await page.waitForFunction(()=>window.loads.length===1);
 // A legacy draft whose non-selected layout is invalid must not load.
 await page.evaluate(async()=>{
  const {AuthoringSession}=await import('/shared/authoring/session.ts'),{setDocumentAdapter}=await import('/src/features/presentation/authoring/service.ts');
  const base=structuredClone(window.fixture);base.id='alternate-preview';base.set.layouts.at(-1).root.children.push(window.makeScene());
  const adapter=setDocumentAdapter(window.target),legacy={...adapter};delete legacy.validateForCommit;
  const draft=await AuthoringSession.create(legacy,base),revision=draft.snapshot().revision;
  await draft.edit({operationId:'legacy',baseRevision:revision,label:'Legacy name',command:{type:'canonical',edit:{schema:'producer.set-edit/2',baseRevision:revision,operations:[{op:'replace',path:'/name',value:'Legacy alternate draft'}]}}});
  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('producer-authoring',1);r.onsuccess=()=>resolve(r.result);r.onerror=reject;});
  await new Promise((resolve,reject)=>{const tx=db.transaction('drafts','readwrite');tx.objectStore('drafts').put(draft.exportJournal(),'local:'+base.id+':'+revision);tx.oncomplete=resolve;tx.onerror=reject;});db.close();window.mount(base);
 });
 await page.getByText('Restored your saved draft.',{exact:true}).waitFor();
 assert.equal(await page.getByRole('heading',{name:'Preview needs a correction'}).count(),0);
 await page.getByRole('button',{name:'Load preparation',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'default preview: Invalid music visual controls'}).waitFor();
 assert.equal(await page.evaluate(()=>window.loads.length),1,'invalid alternate layout never loads');
 await page.getByRole('button',{name:'Close Set assistant'}).click();
 // The same Set ID at two source revisions retains two separate local drafts.
 const result=await page.evaluate(async()=>{
  const {SetAuthoringWorker}=await import('/src/features/presentation/authoring/workerClient.ts');
  const a=structuredClone(window.fixture);a.id='source-revisions';const b=structuredClone(a);b.name='Second source revision';
  async function edit(base,value){const w=new SetAuthoringWorker(),s=await w.open(base,window.target,'revision-test');const changed=await w.edit(s.revision,{type:'node.properties',layoutId:base.set.layouts[0].id,nodeId:base.set.layouts[0].root.children[0].id,properties:{text:value}},'Edit '+value);w.close();return changed;}
  const first=await edit(a,'FIRST'),second=await edit(b,'SECOND');
  const w=new SetAuthoringWorker(),restored=await w.open(a,window.target,'revision-test');w.close();
  return {first:first.revision,second:second.revision,restored:restored.revision,didRestore:restored.restored};
 });
 assert.equal(result.restored,result.first);assert.notEqual(result.first,result.second);assert(result.didRestore);
 assert.deepEqual(errors,[]);
 console.log('PASS Assistant preview: real React fault isolation and repair, all-layout preparation gate, legacy invalid draft recovery, independent source-revision journals; no native output or real inference.');
} finally {await browser.close();}
