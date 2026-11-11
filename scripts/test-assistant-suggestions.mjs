import assert from 'node:assert/strict';
import {build} from 'esbuild';

const bundle=await build({entryPoints:['src/features/assistant/conversationSuggestions.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {conversationSuggestions,parseSuggestedReplies,isSuggestionCall}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const themes='| Theme | Look and feel |\n| --- | --- |\n| **Nyla’s Rainbow Club** | Cheerful colors |\n| **Nyla’s Cozy Castle** | Soft and cozy |\n| **Nyla’s Little Discovery Show** | Curious and playful |';
const planning=[{role:'user',text:'A show for Nyla. No edits yet.'},{role:'assistant',text:themes}];
assert.deepEqual(conversationSuggestions(planning,undefined,false).map(item=>item.label),['Nyla’s Rainbow Club','Nyla’s Cozy Castle','Nyla’s Little Discovery Show']);
const simplified=[...planning,{role:'user',text:'Simpler, please. Still no edits.'},{role:'assistant',text:'Let’s keep it simple.\n- **Say hello**\n- **Show a favorite toy**\n- **Say bye-bye**'}];
assert.deepEqual(conversationSuggestions(simplified,undefined,false).map(item=>item.label),['Say hello','Show a favorite toy','Say bye-bye'],'old creative choices are not reused after a new exchange');
const previousEdit=[{role:'user',text:'Edit the old Set.'},{role:'tool',text:'Draft updated and validated.'},...planning];
assert(!conversationSuggestions(previousEdit,undefined,true).some(item=>item.action),'old saved edits do not hijack a new planning conversation');
assert.equal(conversationSuggestions([{role:'user',text:'Edit the title.'},{role:'tool',text:'Draft updated and validated.'},{role:'assistant',text:'The title is updated.'}],undefined,true)[0].action,'review');
for(const value of [null,'{}','{"suggestions":[]}',JSON.stringify({suggestions:[{label:'x',prompt:'y',action:'review'}]}),JSON.stringify({suggestions:[{label:'x',prompt:'y'},{label:'X',prompt:'z'}]}),JSON.stringify({suggestions:[{label:'<script>',prompt:'x'}]}),JSON.stringify({suggestions:[{label:'x',prompt:'x'.repeat(601)}]})])assert.throws(()=>parseSuggestedReplies(value));
const safe=parseSuggestedReplies(JSON.stringify({suggestions:[{label:'Rainbow Club',prompt:'Explore the rainbow direction, without edits.'}]}));
assert.equal(safe[0].action,undefined,'model metadata can only fill editable prompts, never invoke review or output actions');
assert(isSuggestionCall({type:'function_call',namespace:'producer_assistant',name:'suggest_replies'}));
assert(!isSuggestionCall({type:'function_call',namespace:'other',name:'suggest_replies'}));

const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'playwright-core');
const browser=await chromium.launch({executablePath:process.env.PRODUCER_CHROME??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const origin=process.env.PRODUCER_TEST_URL??'http://127.0.0.1:1436/';
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route(origin,route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body style="margin:0;background:#070d14"></body></html>'}));
 await page.route(/\/src\/features\/assistant\/provider\.ts(?:\?.*)?$/,route=>route.fulfill({contentType:'application/javascript',body:`export const chatgpt={status:async()=>({accounts:window.connected?[{id:'test',email:'test@example.invalid',planEnabled:true}]:[],active:window.connected?'test':null,signIn:window.signState?{id:'test-signin',status:window.signState}:null}),models:async()=>{window.modelCalls++;return [{slug:'test',display_name:'Test model'}]},signIn:async()=>{window.signIns++;window.signState='waiting';return 'test-signin'},cancelSignIn:async()=>{},cancel:async()=>window.cancelled++,turn:(turn,event)=>window.respond(turn,event)};`}));
 await page.route('https://**',route=>route.abort());await page.goto(origin);
 await page.evaluate(async()=>{
  const refresh=await import('/@react-refresh');refresh.default.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
  await import('/src/App.css');window.connected=true;window.signIns=0;window.modelCalls=0;window.cancelled=0;window.turns=[];window.drafts=[];window.loads=0;window.nativeCalls=[];
  const {AUTHORING_CATALOG}=await import('/src/features/presentation/authoring/catalog.ts');
  window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};window.__TAURI_INTERNALS__={invoke:async command=>{window.nativeCalls.push(command);if(command==='assistant_authoring_capabilities')return {schema:'producer.native-authoring/1',catalogRevision:2,features:[...AUTHORING_CATALOG.features],packageSchema:'producer.presentation/2',nativeAdmission:'separate-native-preparation-required'};if(command==='plugin:app|version')return '0.4.90';return null;},transformCallback:()=>1,convertFileSrc:path=>path};
  const R=await import('/node_modules/.vite/deps/react.js'),D=await import('/node_modules/.vite/deps/react-dom_client.js'),{default:Assistant}=await import('/src/features/assistant/SetAssistantDialog.tsx');
  window.source=await(await fetch('/src/features/presentation/fixtures/after-hours.json')).json();
  document.body.innerHTML='<div id="root"></div><section id="dock" class="assistant-dock-mount" style="width:480px;height:800px;margin:20px"></section>';
  window.root=(D.createRoot??D.default.createRoot)(document.getElementById('root'));
  window.props={document:window.source,scope:'conversation-ui-test',dock:{target:document.getElementById('dock'),compact:false,onExpand:()=>window.render({dock:{...window.props.dock,compact:false}}),onUseCurrent:()=>{},contextLabel:'Room Set'},onLoad:async()=>window.loads++,onClose:()=>{},onDraftChange:doc=>window.drafts.push(JSON.stringify(doc))};
  window.render=patch=>{window.props={...window.props,...patch};window.root.render((R.createElement??R.default.createElement)(Assistant,window.props));};
  window.items=[{label:'Rainbow Club',prompt:'Explore Nyla’s Rainbow Club with me. Describe it first; no edits yet.'},{label:'Cozy Castle',prompt:'Explore Nyla’s Cozy Castle. No edits yet.'},{label:'Little Discovery',prompt:'Explore Nyla’s Little Discovery Show. No edits yet.'}];window.answer='Three directions for **Nyla’s Show**. Which feels right?';
  window.respond=async(turn,event)=>{
   window.turns.push(structuredClone(turn));
   if(window.block)await new Promise(resolve=>window.release=resolve);
   if(window.metadataOnly&&!turn.input.slice(turn.input.findLastIndex(item=>item.role==='user')).some(item=>item.type==='function_call_output'))return [{type:'function_call',namespace:'producer_assistant',name:'suggest_replies',arguments:JSON.stringify({suggestions:window.items}),call_id:'metadata-only'}];
   event({type:'text',text:window.answer});
   return [{type:'message',role:'assistant',content:[{type:'output_text',text:window.answer}]},...(window.omitMetadata||window.metadataOnly?[]:[{type:'function_call',namespace:'producer_assistant',name:'suggest_replies',arguments:JSON.stringify({suggestions:window.items}),call_id:'replies-'+window.turns.length}])];
  };window.render({});
 });
 await page.getByText('Test model',{exact:true}).waitFor();
 await page.getByRole('textbox',{name:'Assistant prompt'}).fill('Help me plan Nyla’s Show. No edits yet.');await page.getByRole('button',{name:'Send ↗',exact:true}).click();
 await page.getByRole('button',{name:'Rainbow Club',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.turns.length),1,'suggestions accompanying the final answer require no extra inference');
 assert.equal(await page.locator('.assistant-message.tool').count(),0,'reply metadata creates no fake Set inspection or edit log');
 await page.getByRole('button',{name:'Cozy Castle',exact:true}).click();
 assert.equal(await page.getByRole('textbox',{name:'Assistant prompt'}).inputValue(),'Explore Nyla’s Cozy Castle. No edits yet.');
 assert.equal(await page.evaluate(()=>window.turns.length),1,'choosing a reply only fills the editable prompt');
 await page.evaluate(()=>{window.items=[{label:'Make it simpler',prompt:'Keep it to hello, a favorite toy and goodbye. No edits.'},{label:'Choose a palette',prompt:'Help me pick colors. No edits yet.'},{label:'Plan the goodbye',prompt:'Plan a simple goodbye screen without editing.'}];window.answer='Let’s keep it simple: hello, one toy, goodbye.';});
 await page.getByRole('button',{name:'Send ↗',exact:true}).click();await page.getByRole('button',{name:'Choose a palette',exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Rainbow Club',exact:true}).count(),0,'next-turn suggestions replace old creative choices');
 if(process.env.PRODUCER_PANEL_SCREENSHOTS)await page.locator('.assistant-docked').screenshot({path:process.env.PRODUCER_PANEL_SCREENSHOTS+'/contextual-replies.png'});
 await page.evaluate(()=>{window.omitMetadata=true;window.answer='Choose the next screen:\n- **Say hello**\n- **Show a favorite toy**\n- **Say bye-bye**';});
 await page.getByRole('textbox',{name:'Assistant prompt'}).fill('Can we keep it much simpler? No edits.');await page.getByRole('button',{name:'Send ↗',exact:true}).click();
 await page.getByRole('button',{name:'Show a favorite toy',exact:true}).waitFor();
 assert.deepEqual(await page.locator('.assistant-suggestions button').allTextContents(),['Say hello','Show a favorite toy','Say bye-bye'],'the local fallback uses the newest reply when metadata is omitted');
 assert.equal(await page.evaluate(()=>new Set(window.drafts).size),1,'planning and suggestion metadata never edit the private Set');
 assert.equal(await page.evaluate(()=>window.loads),0,'no suggestion can load or place a Set on output');
 const beforeMetadataOnly=await page.evaluate(()=>window.turns.length);
 await page.evaluate(()=>{window.metadataOnly=true;window.omitMetadata=false;window.answer='Let’s explore a soft, cozy palette.';window.items=[{label:'Soft pastels',prompt:'Explore a pastel palette with no edits.'},{label:'Natural colors',prompt:'Explore natural colors with no edits.'},{label:'Cozy neutrals',prompt:'Explore neutrals with no edits.'}];});
 await page.getByRole('textbox',{name:'Assistant prompt'}).fill('What palette could work? No edits.');await page.getByRole('button',{name:'Send ↗',exact:true}).click();await page.getByRole('button',{name:'Cozy neutrals',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.turns.length),beforeMetadataOnly+2,'tool-only metadata is acknowledged and retained through the final conversational answer');
 await page.evaluate(()=>window.metadataOnly=false);
 // Only the current authorized response may replace the suggestions.
 await page.evaluate(()=>{window.block=true;window.omitMetadata=false;window.items=[{label:'Stale reply',prompt:'This should never appear.'}];});
 await page.getByRole('textbox',{name:'Assistant prompt'}).fill('Think through another option. No edits.');await page.getByRole('button',{name:'Send ↗',exact:true}).click();await page.waitForFunction(()=>typeof window.release==='function');
 await page.getByRole('button',{name:'Stop',exact:true}).click();await page.evaluate(()=>{window.release();window.block=false;});
 assert.equal(await page.getByRole('button',{name:'Stale reply',exact:true}).count(),0,'late metadata cannot overwrite chips after Stop');
 // Sharing off removes draft authority but retains bounded UI metadata.
 await page.getByRole('button',{name:'Assistant settings',exact:true}).click();await page.getByText('On request · Data shared',{exact:true}).click();await page.getByRole('checkbox',{name:'Share this Set’s design with ChatGPT'}).uncheck();await page.getByRole('button',{name:'Close Assistant settings',exact:true}).click();
 await page.evaluate(()=>{window.items=[{label:'Pick a color',prompt:'Help me choose a color without editing.'}];window.answer='What color does she like?';});
 await page.getByRole('textbox',{name:'Assistant prompt'}).fill('Help me plan without sharing my Set.');await page.getByRole('button',{name:'Send ↗',exact:true}).click();await page.getByRole('button',{name:'Pick a color',exact:true}).waitFor();
 assert.deepEqual(await page.evaluate(()=>window.turns.at(-1).tools.map(tool=>tool.name)),['producer_assistant']);
 assert.equal(await page.evaluate(()=>window.turns.at(-1).input.length),1);
 // Completion previews overlay the panel, time out at 8s and remain unread.
 await page.clock.install();
 await page.evaluate(()=>{document.getElementById('dock').style.cssText='position:fixed;bottom:10px;right:10px;width:550px;height:40px';window.render({dock:{...window.props.dock,compact:true}});window.answer='Start with **Nyla showing a favorite toy**.';});
 await page.getByRole('textbox',{name:'Assistant prompt'}).fill('A simple first episode, please.');await page.getByRole('textbox',{name:'Assistant prompt'}).press('Enter');
 const toast=page.locator('.assistant-task-toast');await toast.waitFor();assert(!(await toast.innerText()).includes('**'),'preview strips Markdown syntax');
 const bounds=await toast.boundingBox(),dock=await page.locator('.assistant-docked').boundingBox();assert(bounds.y<dock.y+dock.height&&bounds.y+bounds.height>dock.y&&bounds.x>=dock.x&&bounds.x+bounds.width<=dock.x+dock.width,'bottom notification overlays its own dock');
 await page.clock.fastForward(7000);assert.equal(await toast.count(),1,'preview stays for the promised reading interval');
 await page.clock.fastForward(1100);assert.equal(await toast.count(),0,'preview clears automatically after eight seconds');
 await page.getByLabel('Unread Assistant reply',{exact:true}).waitFor();
 if(process.env.PRODUCER_PANEL_SCREENSHOTS)await page.locator('.assistant-docked').screenshot({path:process.env.PRODUCER_PANEL_SCREENSHOTS+'/unread-mini.png'});
 await page.getByRole('button',{name:/Assistant.*Reply ready/}).click();await page.getByRole('dialog',{name:'Assistant conversation panel',exact:true}).waitFor();assert.equal(await page.getByLabel('Unread Assistant reply',{exact:true}).count(),0,'opening the reply marks it read');
 await page.getByRole('button',{name:'Close Assistant conversation',exact:true}).click();
 await page.getByRole('textbox',{name:'Assistant prompt'}).fill('One more idea, no edits.');await page.getByRole('textbox',{name:'Assistant prompt'}).press('Enter');await toast.waitFor();
 if(process.env.PRODUCER_PANEL_SCREENSHOTS)await page.screenshot({path:process.env.PRODUCER_PANEL_SCREENSHOTS+'/notification-overlay.png'});
 await toast.getByRole('button',{name:'Dismiss Assistant notification',exact:true}).click();assert.equal(await toast.count(),0);await page.getByLabel('Unread Assistant reply',{exact:true}).waitFor();
 const modelCalls=await page.evaluate(()=>window.modelCalls);
 for(let cycle=0;cycle<3;cycle++){
  await page.getByRole('button',{name:'Expand Assistant',exact:true}).click();await page.getByRole('dialog',{name:'Assistant conversation panel',exact:true}).waitFor();
  await page.getByRole('button',{name:'Expand Assistant',exact:true}).click();assert.equal(await page.getByRole('dialog',{name:'Assistant conversation panel',exact:true}).count(),0);await page.getByRole('textbox',{name:'Assistant prompt'}).fill('Prompt survives cycle '+cycle);
 }
 assert.equal(await page.evaluate(()=>window.modelCalls),modelCalls,'view toggles retain the provider and conversation owner');
 // A disconnected mini dock exposes the same sign-in adapter as the full view.
 await page.evaluate(()=>{window.root.unmount();window.connected=false;window.signState=undefined;window.props={...window.props,scope:'disconnected-ui-test'};});
 await page.evaluate(async()=>{const D=await import('/node_modules/.vite/deps/react-dom_client.js');window.root=(D.createRoot??D.default.createRoot)(document.getElementById('root'));window.render({});});
 const connect=page.getByRole('button',{name:'Continue with ChatGPT',exact:true});await connect.waitFor();assert.equal(await page.getByRole('textbox',{name:'Assistant prompt'}).count(),0);
 for(const width of [150,240,360,550]){
  await page.evaluate(width=>document.getElementById('dock').style.width=width+'px',width);
  const geometry=await connect.evaluate(button=>{const bounds=button.getBoundingClientRect(),parent=button.closest('.assistant-mini').getBoundingClientRect();return {fits:bounds.left>=parent.left&&bounds.right<=parent.right&&bounds.top>=parent.top&&bounds.bottom<=parent.bottom&&button.scrollHeight<=button.clientHeight,bounds:bounds.toJSON(),parent:parent.toJSON(),scrollHeight:button.scrollHeight,clientHeight:button.clientHeight};});
  assert(geometry.fits,'compact ChatGPT sign-in stays usable at '+width+'px: '+JSON.stringify(geometry));
 }
 if(process.env.PRODUCER_PANEL_SCREENSHOTS)await page.locator('.assistant-docked').screenshot({path:process.env.PRODUCER_PANEL_SCREENSHOTS+'/compact-sign-in.png'});
 await connect.click();assert.equal(await page.evaluate(()=>window.signIns),1);await page.getByRole('button',{name:'Connecting…',exact:true}).waitFor();
 await page.evaluate(()=>{window.connected=true;window.signState='complete';});await page.clock.runFor(1100);await page.getByRole('textbox',{name:'Assistant prompt'}).waitFor();
 assert(!(await page.evaluate(()=>window.nativeCalls)).some(command=>/^live_/.test(command)));
 assert.deepEqual(errors,[]);
 console.log('PASS Assistant conversation: current-turn metadata and fallback chips; no extra inference or authoring; Stop and sharing fences; repeat expand/close; overlay preview, 8s dismissal, unread persistence; compact ChatGPT sign-in.');
}finally{await browser.close();}
