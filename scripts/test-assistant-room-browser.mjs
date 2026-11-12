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
  window.props={roomState:{setOnOutput:false,screenSharing:false,guestsConnected:false},session:window.session,scope:'room-authoring-browser',target:document.getElementById('right'),compact:false,onExpand:()=>{window.expands++;window.render({compact:false});},onReview:async d=>{window.reviews.push(structuredClone(d));}};
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

 await page.evaluate(async()=>{
  const {registerRoomControl}=await import('/src/features/room-control/runtime.ts');
  window.roomActions=[];window.roomData={name:'Authoring Browser',host:true,ready:true,config:{layout:{left:['assistant'],right:['setControls'],top:[],bottom:[],hidden:['chat','scenes']},sizes:{}},docks:{left:{open:true},right:{open:true}},sources:{items:[{id:'host-camera',kind:'camera',label:'Host camera',visible:true}]},scenes:[{id:'active',name:'Current',look:{}}],activeScene:'active',presentation:{document:window.source,bindings:{host:'host-camera'},currentPresented:true},output:{streaming:false,recording:false}};
  registerRoomControl('room',{epoch:'browser-epoch',roomId:'browser-room',snapshot:()=>window.roomData,commands:{
   'panel.move':args=>{window.roomActions.push(['panel.move',args]);return args;},
   'scene.create':args=>{window.roomActions.push(['scene.create',args]);window.roomData.scenes.push({id:'new-scene',name:args.name,look:{}});return {id:'new-scene'};},
   'source.add':args=>{window.roomActions.push(['source.add',args]);window.roomData.sources.items.push({id:'new-color',...args,visible:false});return {id:'new-color'};},
   'scene.source':args=>{window.roomActions.push(['scene.source',args]);return args;},
   'set.bind':args=>{window.roomActions.push(['set.bind',args]);return args;},
   'scene.select':args=>{window.roomActions.push(['scene.select',args]);return args;},
  }});
  window.render({roomState:{roomId:'browser-room',setOnOutput:true,screenSharing:false,guestsConnected:false}});
  const canvas=document.createElement('canvas');canvas.width=200;canvas.height=100;const ctx=canvas.getContext('2d');ctx.fillStyle='#285e8e';ctx.fillRect(0,0,200,100);window.imageBytes=canvas.toDataURL('image/png').split(',')[1];
  window.step=0;
  window.respond=async(turn,event)=>{
   window.lastTurn=turn;
   if(window.onlyCancel){if(!turn.input.some(item=>item.call_id==='cancel-scene'))return [{type:'function_call',namespace:'room',name:'select_scene',call_id:'cancel-scene',arguments:JSON.stringify({roomEpoch:'browser-epoch',id:'new-scene'})}];return [{type:'message',role:'assistant',content:[{type:'output_text',text:'Cancelled'}]}];}
   const room=(name,args)=>({type:'function_call',namespace:'room',name,call_id:'room-'+window.step+'-'+name,arguments:JSON.stringify(args)});
   const set=(name,args)=>({type:'function_call',namespace:'producer',name,call_id:'set-'+window.step+'-'+name,arguments:JSON.stringify(args)});
   const results=turn.input.filter(item=>item.type==='function_call_output');
   switch(window.step++){
    case 0:window.imageInput=structuredClone(turn.input);return [room('inspect_room',{})];
    case 1:return [room('move_panel',{roomEpoch:'browser-epoch',panel:'scenes',dock:'left'}),room('create_scene',{roomEpoch:'browser-epoch',name:'Prepared scene'})];
    case 2:return [room('add_source',{roomEpoch:'browser-epoch',kind:'color',label:'Prepared color',color:'#30343b'})];
    case 3:return [room('assign_scene_source',{roomEpoch:'browser-epoch',sceneId:'new-scene',sourceId:'new-color',visible:true,x:0,y:0,w:1280,h:720})];
    case 4:return [room('bind_set_slot',{roomEpoch:'browser-epoch',slot:'host',source:'new-color'})];
    case 5:return [set('inspect_set',{})];
    case 6:{
     const context=JSON.parse(results.at(-1).output);window.assetIds=Object.keys(context.context.set.assets??{});
     const doc={schema:'producer.presentation/2',id:'browser-authored',name:'Browser Authored Show',version:'1',set:{initialLayout:'wide',views:{main:{landscape:'wide',portrait:'tall'}},initialView:'main',slots:[{id:'host',label:'Host camera'}],values:{},feeds:{},components:{},controls:[],layouts:[['wide',1280,720],['tall',720,1280]].map(([id,width,height])=>({id,label:id,width,height,root:{id:'root',type:'box',styles:{position:'relative',width,height,background:'#15191d'},children:[{id:'host',type:'slot',slotId:'host',styles:{position:'absolute',left:40,top:80,width:width-80,height:height-120}}]}}))}};
     return [set('create_set',{baseRevision:context.revision,label:'Create paired Set',plan_json:JSON.stringify({schema:'producer.design-plan/2',package:doc,assetRefs:window.assetIds})})];
    }
    case 7:return [set('author_show',{baseRevision:JSON.parse(results.at(-1).output).revision,label:'Create runnable Show',show_json:JSON.stringify({id:'browser-rundown',version:'1',initialPhase:'hello',phases:[{id:'hello',label:'Hello',layoutId:'wide',next:'bye'},{id:'bye',label:'Bye',layoutId:'tall'}],choices:[]})})];
    default:event({type:'text',text:'Created the Room, paired Set and actual Show rundown.'});return [{type:'message',role:'assistant',content:[{type:'output_text',text:'Created the Room, paired Set and actual Show rundown.'}]}];
   }
  };
 });
 const bytes=Buffer.from(await page.evaluate(()=>window.imageBytes),'base64');
 await page.getByRole('button',{name:'Attach files',exact:true}).click();await page.getByRole('button',{name:'Add inspiration',exact:false}).click();
 await page.getByLabel('Assistant attachments',{exact:true}).setInputFiles({name:'reference.png',mimeType:'image/png',buffer:bytes});
 await page.getByText('Inspiration only',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Attach files',exact:true}).click();await page.getByRole('button',{name:'Add production asset',exact:false}).click();
 await page.getByLabel('Assistant attachments',{exact:true}).setInputFiles({name:'logo.png',mimeType:'image/png',buffer:bytes});
 await page.getByText('Production asset',{exact:true}).waitFor();
 await page.getByRole('textbox',{name:'Assistant prompt'}).fill('Prepare a room, a paired Set and an actual Show. Use the logo but treat the reference as inspiration only.');
 await page.getByRole('button',{name:'Send ↗',exact:true}).click();
 const confirmation=page.getByRole('region',{name:'Confirm room change',exact:true});
 await page.getByRole('button',{name:'Confirm change',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.roomActions.some(([name])=>name==='set.bind')),false,'output bindings wait for the host');
 await page.getByRole('button',{name:'Confirm change',exact:true}).click();
 await page.getByText('Created the Room, paired Set and actual Show rundown.',{exact:true}).waitFor();
 assert.deepEqual(await page.evaluate(()=>window.roomActions.map(([name])=>name)),['panel.move','scene.create','source.add','scene.source','set.bind']);
 assert.equal(await page.evaluate(()=>window.assetIds.length),1,'only the production file is available as a Set asset');
 assert.equal(await page.evaluate(()=>window.imageInput.at(-1).content.filter(item=>item.type==='input_image').length),2,'explicitly attached images reach the provider adapter');
 assert.equal(await page.evaluate(()=>window.reviews.length),0,'authoring does not silently load or take the candidate on output');
 await page.evaluate(()=>{window.onlyCancel=true;});
 await page.getByRole('textbox',{name:'Assistant prompt'}).fill('Select the prepared scene.');await page.getByRole('button',{name:'Send ↗',exact:true}).click();await page.getByRole('button',{name:'Confirm change',exact:true}).waitFor();
 await page.getByRole('button',{name:'Stop',exact:true}).click();
 assert.equal(await page.getByRole('button',{name:'Confirm change',exact:true}).count(),0);assert.equal(await page.evaluate(()=>window.roomActions.some(([name])=>name==='scene.select')),false,'stopping a pending confirmation never changes output');
 assert.deepEqual(errors,[]);
 console.log('PASS Assistant room browser: real draft worker, Room tool dispatch, inactive scenes/hidden sources, approval and Stop, paired Set + actual Show generation, reference/production file picker paths and image input, no silent preparation/output.');
} finally {await browser.close();}
