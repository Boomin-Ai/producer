import assert from 'node:assert/strict';
import {build} from 'esbuild';
const layoutBundle=await build({entryPoints:['src/lib/layout.ts'],bundle:true,platform:'node',format:'esm',write:false});
const layout=await import('data:text/javascript;base64,'+Buffer.from(layoutBundle.outputFiles[0].text).toString('base64'));
for(const preset of layout.PRESETS)assert.deepEqual(layout.normalize(preset.layout),preset.layout);
const old=structuredClone(layout.DEFAULT_LAYOUT);old.hidden=old.hidden.filter(p=>p!=='assistant');const upgraded=layout.normalize(old);
assert(upgraded.hidden.includes('assistant'));assert.equal(upgraded.hidden.filter(p=>p==='assistant').length,1);
for(const dock of ['top','left','right','bottom','hidden'])assert.equal(layout.dockOf(layout.movePanel(upgraded,'assistant',dock),'assistant'),dock);
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'playwright-core');
const browser=await chromium.launch({executablePath:process.env.PRODUCER_CHROME??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const origin=process.env.PRODUCER_TEST_URL??'http://127.0.0.1:1445/';
try {
 const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route(origin,r=>r.fulfill({contentType:'text/html',body:'<!doctype html><html><body style="margin:0;background:#070d14"></body></html>'}));
 await page.route(/\/src\/features\/assistant\/provider\.ts(?:\?.*)?$/,r=>r.fulfill({contentType:'application/javascript',body:`export const chatgpt={status:async()=>{window.statusCalls++;return {accounts:[{id:'test',email:'test@example.invalid',planEnabled:true}],active:'test'}},models:async()=>{window.modelCalls++;return [{slug:'test',display_name:'Test model'}]},cancel:async()=>window.cancelled++,turn:(t,e)=>window.respond(t,e)};`}));
 await page.route('https://**',r=>r.abort());await page.goto(origin);
 await page.evaluate(async()=>{
  const refresh=await import('/@react-refresh');refresh.default.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;
  const {AUTHORING_CATALOG}=await import('/src/features/presentation/authoring/catalog.ts');window.nativeCalls=[];window.statusCalls=0;window.modelCalls=0;window.cancelled=0;window.turns=[];window.reviews=[];window.externalLoads=[];window.expands=0;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
  window.__TAURI_INTERNALS__={invoke:async c=>{window.nativeCalls.push(c);if(c==='assistant_authoring_capabilities')return {schema:'producer.native-authoring/1',catalogRevision:2,features:[...AUTHORING_CATALOG.features],packageSchema:'producer.presentation/2',nativeAdmission:'separate-native-preparation-required'};if(c==='plugin:app|version')return '0.4.90';if(c==='set_library_list')return [];return null;},transformCallback:()=>1,convertFileSrc:p=>p};
  const R=await import('/node_modules/.vite/deps/react.js'),D=await import('/node_modules/.vite/deps/react-dom_client.js'),{default:RoomAssistant}=await import('/src/features/assistant/RoomAssistant.tsx'),{RehearsalSession}=await import('/src/features/presentation/rehearsal.ts');
  window.source=await(await fetch('/src/features/presentation/fixtures/after-hours.json')).json();window.session=new RehearsalSession(window.source,undefined,'prepare');window.original=JSON.stringify(window.session.package);
  const shell=document.createElement('div');shell.innerHTML='<div id="root"></div><section id="right" class="assistant-dock-mount" style="width:360px;height:780px"></section><section id="bottom" class="assistant-dock-mount" style="width:1100px;height:360px"></section>';document.body.append(shell);
  window.root=(D.createRoot??D.default.createRoot)(document.getElementById('root'));
  window.props={session:window.session,scope:'panel-room-1',target:document.getElementById('right'),compact:false,onExpand:()=>{window.expands++;window.render({compact:false});},onReview:async d=>{window.reviews.push(structuredClone(d));}};
  window.render=patch=>{window.props={...window.props,...patch};window.root.render((R.createElement??R.default.createElement)(RoomAssistant,window.props));};
  window.respond=async (turn,event)=>{
   window.turns.push(turn);const results=turn.input.filter(i=>i.type==='function_call_output');
   if(!results.length){await new Promise(resolve=>window.release=resolve);return [{type:'function_call',name:'inspect_set',arguments:'{}',call_id:'inspect'}];}
   if(results.length===1){const data=JSON.parse(results[0].output),l=data.context.set.layouts[0],n=l.root.children[0];return [{type:'function_call',name:'edit_set',call_id:'edit',arguments:JSON.stringify({baseRevision:data.revision,label:'Panel title',command_json:JSON.stringify({type:'node.properties',layoutId:l.id,nodeId:n.id,properties:{text:'PANEL VERIFIED'}})})}];}
   event({type:'text',text:'Panel draft is ready.'});return [{type:'message',role:'assistant',content:[{type:'output_text',text:'Panel draft is ready.'}]}];
  };window.render({});
 });
 await page.getByText('Test model',{exact:true}).waitFor();
 assert.equal(await page.locator('.assistant-dock-mount iframe').count(),0,'docked conversation starts no GPU preview');
 await page.getByRole('textbox',{name:'Assistant prompt'}).fill('A precise title change.');
 await page.getByRole('button',{name:'Send ↗',exact:true}).click();await page.waitForFunction(()=>typeof window.release==='function');
 const modelCalls=await page.evaluate(()=>window.modelCalls);
 await page.evaluate(()=>window.render({target:document.getElementById('bottom'),compact:true}));
 await page.getByRole('button',{name:/Assistant.*Working on draft/}).waitFor();
 await page.evaluate(()=>window.release());await page.getByRole('button',{name:/Assistant.*Draft ready/}).waitFor();
 await page.getByRole('button',{name:/Assistant.*Draft ready/}).click();
 await page.getByText('Panel draft is ready.',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.modelCalls),modelCalls,'docking and compact view retain the provider session');
 assert.equal(await page.evaluate(()=>window.cancelled),0,'moving the panel does not cancel its active turn');
 assert.equal(await page.evaluate(()=>JSON.stringify(window.session.package)),await page.evaluate(()=>window.original),'model edits never change the room Set');
 await page.getByRole('textbox',{name:'Assistant prompt'}).fill('Keep this unsent prompt.');
 for(const target of ['right','bottom']){await page.evaluate(t=>window.render({target:document.getElementById(t)}),target);assert.equal(await page.getByRole('textbox',{name:'Assistant prompt'}).inputValue(),'Keep this unsent prompt.');}
 await page.getByRole('button',{name:'Review in Set Edit',exact:true}).click();await page.waitForFunction(()=>window.reviews.length===1);
 assert.equal(await page.evaluate(()=>window.reviews[0].set.layouts[0].root.children[0].text),'PANEL VERIFIED');
 assert.deepEqual(await page.evaluate(()=>window.reviews[0].set.controls),await page.evaluate(()=>window.session.package.set.controls));
 await page.waitForFunction(()=>!document.querySelector('.assistant-draft-card button').disabled);
 // Set Edit receives the edited candidate, not the original source. Reopening
 // Assistant from that draft must keep the same conversation and undo journal.
 await page.evaluate(()=>window.render({request:{id:'editor-request',document:window.reviews[0],onLoad:async d=>window.externalLoads.push(d)}}));
 await page.getByRole('dialog',{name:'Set assistant',exact:true}).waitFor();
 assert.equal(await page.getByText('Panel draft is ready.',{exact:true}).count(),1);
 assert.equal(await page.getByRole('button',{name:'Undo',exact:true}).isDisabled(),false);
 assert.equal(await page.evaluate(()=>window.modelCalls),modelCalls,'opening detailed review does not create another provider session');
 await page.getByRole('button',{name:'Load preparation',exact:true}).click();await page.waitForFunction(()=>window.externalLoads.length===1);
 assert.equal(await page.getByRole('dialog',{name:'Set assistant',exact:true}).count(),0);
 await page.getByText('Panel draft is ready.',{exact:true}).waitFor();
 assert(!(await page.evaluate(()=>window.nativeCalls)).some(c=>/^live_/.test(c)),'panel has no native room or capture authority');
 for(const [name,width,height] of [['side',360,780],['narrow',240,780],['bottom',1100,360],['top',1100,240]]){
  await page.evaluate(({width,height})=>{const target=document.getElementById('right');target.style.width=width+'px';target.style.height=height+'px';document.getElementById('bottom').style.display='none';window.render({target,compact:false});},{width,height});
  await page.waitForFunction(()=>{const element=document.querySelector('.assistant-docked textarea');return element&&element.getBoundingClientRect().height>30});
  const geometry=await page.evaluate(()=>{
   const box=document.querySelector('.assistant-docked').getBoundingClientRect();
   return [...document.querySelectorAll('.assistant-docked .assistant-compose textarea,.assistant-docked .assistant-compose button')].map(element=>{const r=element.getBoundingClientRect();return {inside:r.left>=box.left-1&&r.right<=box.right+1&&r.top>=box.top-1&&r.bottom<=box.bottom+1,width:r.width,height:r.height};});
  });
  assert(geometry.every(r=>r.inside&&r.width>25&&r.height>25),name+' keeps the composer and send control visible');
  if(process.env.PRODUCER_PANEL_SCREENSHOTS)await page.locator('.assistant-docked').screenshot({path:process.env.PRODUCER_PANEL_SCREENSHOTS+'/'+name+'.png'});
 }
 assert.deepEqual(errors,[]);
 // Exercise the production private Set Edit handoff, not a surrogate dialog.
 await page.evaluate(async()=>{
  window.root.unmount();window.applyCalls=0;window.roomChanges=0;window.editorAcks=[];
  const R=await import('/node_modules/.vite/deps/react.js'),D=await import('/node_modules/.vite/deps/react-dom_client.js'),{SetControlsPanel}=await import('/src/features/presentation/SetControlsPanel.tsx');
  const componentSource=await(await fetch('/src/features/presentation/SetControlsPanel.tsx')).text(),runtimePath=componentSource.match(/from "([^"]*rehearsal\.ts[^"]*)"/)[1],{RehearsalSession}=await import(runtimePath);
  const host=document.createElement('div');host.style.cssText='width:1200px;height:650px';document.body.replaceChildren(host);window.editRoot=(D.createRoot??D.default.createRoot)(host);
  window.editorRoom=new RehearsalSession(window.source,undefined,'prepare');window.editorOriginal=JSON.stringify(window.editorRoom.package);
  const output={renderer:'native',active:true,currentPresented:true,busy:false,error:'',bindings:{host:'camera-source'},framing:{},sources:{items:[]},bind:()=>{},frame:()=>{},setAssignments:()=>{},apply:async()=>{window.applyCalls++},applyConfirmed:async()=>{window.applyCalls++},returnToRoom:async()=>true};
  window.editorProps={session:window.editorRoom,output,assistantEditorRequest:{id:'native-editor-request',document:window.reviews[0]},onAssistantEditorOpened:id=>{window.editorAcks.push(id);window.editorProps={...window.editorProps,assistantEditorRequest:undefined};window.renderEditor();},onChange:async doc=>{window.roomChanges++;window.editorRoom=new RehearsalSession(doc,undefined,'prepare');window.editorProps={...window.editorProps,session:window.editorRoom};window.renderEditor();return window.editorRoom;}};
  window.renderEditor=()=>window.editRoot.render((R.createElement??R.default.createElement)(SetControlsPanel,{...window.editorProps,key:window.editorKey??'same'}));window.renderEditor();
 });
 await page.frameLocator('.set-preview-dialog iframe').getByText('PANEL VERIFIED',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.applyCalls),0,'review does not apply live output');
 assert.equal(await page.evaluate(()=>window.roomChanges),0,'review does not replace the current room Set');
 assert.equal(await page.evaluate(()=>JSON.stringify(window.editorRoom.package)),await page.evaluate(()=>window.editorOriginal));
 assert.deepEqual(await page.evaluate(()=>window.editorAcks),['native-editor-request']);
 await page.getByRole('button',{name:'Close editor',exact:true}).click();
 await page.evaluate(()=>{window.editorKey='moved';window.renderEditor();});
 assert.equal(await page.locator('.set-preview-dialog').count(),0,'moving a panel does not replay a consumed editor request');
 assert.deepEqual(errors,[]);
 console.log('PASS Assistant panel: inventory migration; dock and compact forms; active-turn/prompt/conversation preservation; one provider owner; private review; same Set Edit draft and cancellation boundaries; no GPU preview or native output calls.');
} finally {await browser.close();}
