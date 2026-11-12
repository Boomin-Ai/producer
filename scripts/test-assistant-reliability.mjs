import assert from 'node:assert/strict';
import {build} from 'esbuild';
const layoutBundle=await build({entryPoints:['src/lib/layout.ts'],bundle:true,platform:'node',format:'esm',write:false});
const layout=await import('data:text/javascript;base64,'+Buffer.from(layoutBundle.outputFiles[0].text).toString('base64'));
for(const preset of layout.PRESETS)assert.deepEqual(layout.normalize(preset.layout),preset.layout);
const old=structuredClone(layout.DEFAULT_LAYOUT);old.hidden=old.hidden.filter(p=>p!=='assistant');const upgraded=layout.normalize(old);
assert(upgraded.hidden.includes('assistant'));assert.equal(upgraded.hidden.filter(p=>p==='assistant').length,1);
for(const dock of ['top','left','right','bottom','hidden'])assert.equal(layout.dockOf(layout.movePanel(upgraded,'assistant',dock),'assistant'),dock);
const suggestionBundle=await build({entryPoints:['src/features/assistant/suggestions.ts'],bundle:true,write:false,platform:'node',format:'esm'});
const {roomSuggestions}=await import('data:text/javascript;base64,'+Buffer.from(suggestionBundle.outputFiles[0].text).toString('base64'));
const room={setOnOutput:true,screenSharing:true,guestsConnected:true};
assert.deepEqual(roomSuggestions(room,{edited:false,started:true,design:false,canEdit:true,messages:[{role:'user',text:'Plan a teaching show; no edits.'},{role:'assistant',text:'Choose a direction:\n- **Code lab** — hands-on demos\n- **Field notes** — lessons from projects\n- **Office hours** — questions'}]}).map(chip=>chip.label),['Code lab','Field notes','Office hours'],'an active content conversation gets its actual choices rather than onboarding');
assert(roomSuggestions(room,{edited:true,started:true,design:true,canEdit:false}).every(chip=>!chip.action&&chip.label!=='Refine controls'),'sharing off never exposes a private edit or review shortcut');
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
  await import('/src/App.css');
  const {AUTHORING_CATALOG}=await import('/src/features/presentation/authoring/catalog.ts');window.nativeCalls=[];window.statusCalls=0;window.modelCalls=0;window.cancelled=0;window.turns=[];window.reviews=[];window.externalLoads=[];window.expands=0;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
  window.__TAURI_INTERNALS__={invoke:async c=>{window.nativeCalls.push(c);if(c==='assistant_authoring_capabilities')return {schema:'producer.native-authoring/1',catalogRevision:2,features:[...AUTHORING_CATALOG.features],packageSchema:'producer.presentation/2',nativeAdmission:'separate-native-preparation-required'};if(c==='plugin:app|version')return '0.4.90';if(c==='set_library_list')return [];return null;},transformCallback:()=>1,convertFileSrc:p=>p};
  const R=await import('/node_modules/.vite/deps/react.js'),D=await import('/node_modules/.vite/deps/react-dom_client.js'),{default:RoomAssistant}=await import('/src/features/assistant/RoomAssistant.tsx'),{RehearsalSession}=await import('/src/features/presentation/rehearsal.ts');
  window.RehearsalSession=RehearsalSession;window.source=await(await fetch('/src/features/presentation/fixtures/after-hours.json')).json();window.session=new RehearsalSession(window.source,undefined,'prepare');window.original=JSON.stringify(window.session.package);
  const shell=document.createElement('div');shell.innerHTML='<div id="root"></div><section id="right" class="assistant-dock-mount" style="width:360px;height:780px"></section><section id="bottom" class="assistant-dock-mount" style="width:1100px;height:360px"></section>';document.body.append(shell);
  window.root=(D.createRoot??D.default.createRoot)(document.getElementById('root'));
  window.props={roomState:{setOnOutput:false,screenSharing:false,guestsConnected:false},session:window.session,scope:'panel-room-1',target:document.getElementById('right'),compact:false,onExpand:()=>{window.expands++;window.render({compact:false});},onReview:async d=>{window.reviews.push(structuredClone(d));}};
  window.render=patch=>{window.props={...window.props,...patch};window.root.render((R.createElement??R.default.createElement)(RoomAssistant,window.props));};
  window.respond=async (turn,event)=>{
   if(window.failNext){window.failNext=false;throw Error('Test connection dropped.');}
   window.turns.push(turn);if(window.blockMiniTurn){await new Promise(resolve=>window.releaseMini=resolve);return [{type:'function_call',name:'inspect_set',arguments:'{}',call_id:'cancelled-mini'}];}const results=turn.input.filter(i=>i.type==='function_call_output');
   if(!results.length){await new Promise(resolve=>window.release=resolve);return [{type:'function_call',name:'inspect_set',arguments:'{}',call_id:'inspect'}];}
   if(results.length===1){const data=JSON.parse(results[0].output),l=data.context.set.layouts[0],n=l.root.children[0];return [{type:'function_call',name:'edit_set',call_id:'edit',arguments:JSON.stringify({baseRevision:data.revision,label:'Panel title',command_json:JSON.stringify({type:'node.properties',layoutId:l.id,nodeId:n.id,properties:{text:'PANEL VERIFIED'}})})}];}
   event({type:'text',text:'Panel draft is ready.'});return [{type:'message',role:'assistant',content:[{type:'output_text',text:'Panel draft is ready.'}]}];
  };window.render({});
 });

 await page.getByText('Test model',{exact:true}).waitFor();
 await page.evaluate(()=>{
  window.planDoc={...structuredClone(window.source),id:'reliability-created',name:'Reliability Lab'};
  const set=window.planDoc.set;
  set.layouts=[['wide',1280,720],['tall',720,1280]].map(([id,width,height])=>({id,label:id,width,height,root:{id:'root-'+id,type:'box',styles:{position:'absolute',inset:0,background:'#101419'},children:[{id:'title-'+id,type:'text',text:'RELIABILITY LAB',styles:{position:'absolute',left:'5%',top:'5%',fontSize:'40px',color:'#fafafa'}},{id:'host-'+id,type:'slot',slotId:'host',styles:{position:'absolute',left:'5%',top:'20%',width:'90%',height:'70%'}}]}}));
  set.controls=set.controls.filter(control=>control.type==='text');set.initialLayout='wide';set.views={main:{landscape:'wide',portrait:'tall'}};set.initialView='main';
  window.respond=async(turn,event)=>{
   const results=turn.input.filter(item=>item.type==='function_call_output');
   if(!results.length){await new Promise(resolve=>window.releaseThinking=resolve);return [{type:'function_call',name:'inspect_set',arguments:'{}',call_id:'inspect-new'}];}
   const inspected=JSON.parse(results[0].output);
   if(results.length===1||results.length===2){
    if(results.length===2){window.rejected=JSON.parse(results[1].output);await new Promise(resolve=>window.releaseRepair=resolve);}
    const doc=structuredClone(window.planDoc);if(results.length===1)doc.set.layouts[0].root.styles.opacity=9;
    return [{type:'function_call',name:'create_set',call_id:'create-'+results.length,arguments:JSON.stringify({baseRevision:inspected.revision,label:'Build Reliability Lab',plan_json:JSON.stringify({schema:'producer.design-plan/2',package:doc,assetRefs:[]})})}];
   }
   event({type:'text',text:'Created Reliability Lab with paired canvases.'});return [{type:'message',role:'assistant',content:[{type:'output_text',text:'Created Reliability Lab with paired canvases.'}]}];
  };
 });
 await page.getByRole('textbox',{name:'Assistant prompt'}).fill('Create a new paired-format Set.');
 await page.getByRole('button',{name:'Send ↗',exact:true}).click();
 await page.waitForFunction(()=>!!window.releaseThinking);
 await page.getByText('Thinking…',{exact:true}).waitFor();
 assert.equal(await page.locator('.assistant-suggestions').count(),0,'no stale onboarding chips during work');
 await page.waitForFunction(()=>document.querySelector('.assistant-progress time')?.textContent!=='0:00');
 await page.evaluate(()=>window.releaseThinking());
 await page.waitForFunction(()=>!!window.releaseRepair);
 await page.getByText('Needs correction',{exact:true}).waitFor();
 assert.equal(await page.locator('.assistant-message.rejected>span').innerText(),'Needs correction','a rejected candidate never has a success tick');
 assert.equal(await page.locator('.assistant-progress').isVisible(),true);
 assert.equal(await page.evaluate(()=>window.rejected.ok),false);
 assert.equal(await page.evaluate(()=>JSON.stringify(window.session.package)),await page.evaluate(()=>window.original),'creation and failed candidates cannot change live output');
 await page.evaluate(()=>window.releaseRepair());
 await page.getByText('Created Reliability Lab with paired canvases.',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Review in Set Edit',exact:true}).click();
 await page.waitForFunction(()=>window.reviews.length===1);
 assert.deepEqual(await page.evaluate(()=>window.reviews[0].set.views),{main:{landscape:'wide',portrait:'tall'}});
 // The applied candidate rebases edit status without destroying conversation.
 await page.evaluate(()=>{window.session=new RehearsalSession(window.reviews[0],undefined,'prepare');window.render({session:window.session,roomState:{setOnOutput:true}});});
 await page.waitForFunction(()=>!document.querySelector('.assistant-context-trigger small'));
 assert.equal(await page.getByText('Created Reliability Lab with paired canvases.',{exact:true}).count(),1,'applying a draft retains the conversation');
 // Another edited draft must not pin a NEW room Set forever, even when IDs are reused.
 await page.evaluate(async()=>{const {controlState,executeRoomControl}=await import('/src/features/room-control/runtime.ts');const a=controlState().assistant;window.callAssistant=(command,args)=>executeRoomControl({surface:'assistant',command,epoch:a.epoch,roomId:a.roomId,args});const plan=structuredClone(window.planDoc);plan.name='Preserved private design';await window.callAssistant('create',{plan:{schema:'producer.design-plan/2',package:plan,assetRefs:[]}});});
 await page.getByRole('button',{name:'Assistant context: Preserved private design',exact:true}).waitFor();
 await page.evaluate(()=>{const next=structuredClone(window.reviews[0]);next.name='Current room design';window.session=new RehearsalSession(next,undefined,'prepare');window.render({session:window.session});});
 await page.getByRole('button',{name:'Assistant context: Current room design',exact:true}).waitFor();
 await page.getByRole('button',{name:'Assistant context: Current room design',exact:true}).click();
 await page.getByRole('button',{name:'Resume saved draft · Preserved private design',exact:true}).click();
 await page.getByRole('button',{name:'Assistant context: Preserved private design',exact:true}).waitFor();
 await page.getByRole('button',{name:'Follow room',exact:true}).waitFor();
 // New conversation releases a deliberately restored older target, retaining its journal.
 await page.getByRole('button',{name:'Assistant settings',exact:true}).click();
 await page.locator('.assistant-sharing summary').click();
 await page.getByRole('button',{name:'New conversation',exact:true}).click();
 await page.getByRole('button',{name:'Assistant context: Current room design',exact:true}).waitFor();
 // Returning to the original source must not restore a different Set created from it.
 await page.evaluate(()=>{window.session=new RehearsalSession(window.source,undefined,'prepare');window.render({session:window.session});});
 await page.getByRole('button',{name:'Assistant context: After Hours',exact:true}).waitFor();
 await page.getByRole('button',{name:'Assistant context: After Hours',exact:true}).click();
 await page.getByRole('button',{name:'Resume saved draft · Preserved private design',exact:true}).waitFor();
 await page.getByRole('region',{name:'Assistant Set context'}).press('Escape');
 // Remount is a real room reopen: the clean active branch and recovery catalog persist.
 await page.evaluate(async()=>{window.root.unmount();const D=await import('/node_modules/.vite/deps/react-dom_client.js');window.root=(D.createRoot??D.default.createRoot)(document.getElementById('root'));window.render({});});
 await page.getByRole('button',{name:'Assistant context: After Hours',exact:true}).waitFor();
 await page.getByRole('button',{name:'Assistant context: After Hours',exact:true}).click();
 await page.getByRole('button',{name:'Resume saved draft · Preserved private design',exact:true}).click();
 await page.getByRole('button',{name:'Assistant context: Preserved private design',exact:true}).waitFor();
 assert.equal(await page.getByText('Private draft',{exact:true}).count(),1);
 assert.deepEqual(errors,[]);
 console.log('PASS real Worker Set creation; rejected-candidate repair; elapsed progress; no output mutations; applied-draft rebase; reused-ID room changes; recoverable saved drafts; new-conversation target reset.');
} finally {await browser.close();}
