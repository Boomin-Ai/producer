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
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'../tools/producer-mcp/node_modules/playwright-core/index.mjs');
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
 const composerBounds=await page.locator('.assistant-composer').evaluate(form=>{const panel=form.parentElement.getBoundingClientRect(),box=form.getBoundingClientRect();return {tag:form.tagName,direct:form.parentElement.classList.contains('assistant-panel'),left:box.left-panel.left,right:panel.right-box.right,bottom:panel.bottom-box.bottom,radius:getComputedStyle(form).borderRadius};});
 assert(composerBounds.tag==='FORM'&&composerBounds.direct&&Math.abs(composerBounds.left)<=1&&Math.abs(composerBounds.right)<=1&&Math.abs(composerBounds.bottom)<=1&&composerBounds.radius==='0px','the composer is the panel’s full-width bottom section, without an inset wrapper: '+JSON.stringify(composerBounds));
 assert.deepEqual(await page.locator('.assistant-suggestions-track>button').allTextContents(),['Create a Set','Plan a show','Help me get started']);
 assert.equal(await page.locator('.assistant-context-trigger').count(),0,'an empty room does not present a Set-specific header');
 await page.evaluate(()=>document.getElementById('right').style.width='150px');
 const suggestions=page.getByRole('group',{name:'Suggested actions',exact:true});await suggestions.waitFor();
 assert.equal(await page.getByRole('button',{name:'Assistant suggestions',exact:true}).count(),0,'suggestions are visible buttons, not an Ideas menu');
 assert.equal(await page.locator('.assistant-suggestion-popover').count(),0,'the carousel never opens an overlay');
 await page.getByRole('button',{name:'Plan a show',exact:true}).focus();
 await page.getByRole('button',{name:'Plan a show',exact:true}).click();
 assert.match(await page.getByRole('textbox',{name:'Assistant prompt'}).inputValue(),/Help me plan a show/);
 assert.equal(await page.evaluate(()=>window.turns.length),0,'a carousel button only prepares the prompt');
 await page.evaluate(()=>document.getElementById('right').style.width='360px');
 await page.getByRole('button',{name:'Plan a show',exact:true}).click();
 assert.match(await page.getByRole('textbox',{name:'Assistant prompt'}).inputValue(),/Help me plan a show/);
 assert.equal(await page.evaluate(()=>window.turns.length),0,'a suggestion prepares a prompt; it never submits or changes output');
 await page.getByRole('textbox',{name:'Assistant prompt'}).fill('');
 await page.evaluate(()=>window.render({roomState:{setOnOutput:true,screenSharing:false,guestsConnected:false}}));
 await page.getByRole('button',{name:'Refine this Set',exact:true}).waitFor();
 assert.deepEqual(await page.locator('.assistant-suggestions-track>button').allTextContents(),['Refine this Set','Add a layout','Design live controls']);
 await page.evaluate(()=>window.render({roomState:{setOnOutput:true,screenSharing:true,guestsConnected:false}}));
 await page.getByRole('button',{name:'Frame my screen',exact:true}).waitFor();
 await page.evaluate(()=>window.render({roomState:{setOnOutput:true,screenSharing:true,guestsConnected:true}}));
 await page.getByRole('button',{name:'Prepare interview questions',exact:true}).waitFor();
 assert.equal(await page.locator('.assistant-suggestions-track>button').count(),3);
 await page.evaluate(()=>window.render({roomState:{setOnOutput:true,screenSharing:false,guestsConnected:false}}));
 assert.equal(await page.getByRole('button',{name:'Use room Set',exact:true}).count(),0,'context switching belongs to the header, not a permanent row');
 assert.equal(await page.locator('.assistant-sharing').count(),0,'sharing and account controls start collapsed into settings');
 assert((await page.locator('.assistant-dock-header').boundingBox()).height<=66,'one compact header replaces the stacked metadata rows');
 await page.evaluate(()=>{const next=structuredClone(window.source);next.id='second-room-set';next.name='Second room Set';next.set.feeds.healthProbe={type:'text',default:'idle',maxLength:80};window.followedSource=next;window.session=new RehearsalSession(next,undefined,'prepare');window.original=JSON.stringify(window.session.package);window.render({session:window.session});});
 await page.getByRole('button',{name:'Assistant context: Second room Set',exact:true}).waitFor();
 await page.getByText('Test model',{exact:true}).waitFor();
 const feedCheck=await page.evaluate(()=>{const original=window.session.exportPreparedPackage;let exports=0;window.session.exportPreparedPackage=()=>{exports++;return original();};for(let index=0;index<200;index++)window.session.setRoomFeeds({healthProbe:String(index)});window.session.exportPreparedPackage=original;return {exports,models:window.modelCalls};});
 assert.equal(feedCheck.exports,0,'incoming room-feed updates do not clone/hash a Set or reset its authoring context');
 // Use the actual 56px room dock and its auto-height panel body, not a fixed-height surrogate.
 await page.evaluate(()=>{
  const bottom=document.getElementById('bottom');window.miniParent=bottom.parentElement;
  window.miniFixture=document.createElement('div');window.miniFixture.style.cssText='position:fixed;bottom:0;left:0;z-index:999;width:1100px';
  window.miniFixture.innerHTML='<div class="rm-dock rm-dock-bottom sized slim" style="height:56px;width:100%"><section class="rm-panel rm-panel-assistant" data-in="top"><div class="rm-panel-body"></div></section></div>';
  document.body.append(window.miniFixture);window.miniFixture.querySelector('.rm-panel-body').append(bottom);bottom.removeAttribute('style');bottom.dataset.compact='true';
  window.restoreMini=()=>{bottom.dataset.compact='false';bottom.style.cssText='width:1100px;height:360px';window.miniParent.append(bottom);window.miniFixture.remove();window.render({compact:false});};
  window.render({target:bottom,compact:true,onExpand:()=>{window.expands++;window.restoreMini();}});
 });
 for(const dock of ['top','bottom'])for(const width of [240,360,1100]){
  await page.evaluate(({dock,width})=>{window.miniFixture.style.width=width+'px';window.miniFixture.firstElementChild.className=dock==='top'?'rm-dock rm-dock-top':'rm-dock rm-dock-bottom sized slim';},{dock,width});
  const metrics=await page.locator('.assistant-mini').evaluate(el=>{const box=el.getBoundingClientRect();return {height:box.height,controls:[...el.querySelectorAll('textarea,button')].map(control=>{const r=control.getBoundingClientRect();return {inside:r.left>=box.left-1&&r.right<=box.right+1&&r.top>=box.top-1&&r.bottom<=box.bottom+1,width:r.width,height:r.height};})};});
  assert(metrics.height>=38,`${dock} mini dock supplies a real content height`);
  assert(metrics.controls.every(control=>control.inside&&control.height>=26&&control.width>=20),`${dock} ${width}px mini prompt and controls remain visible: ${JSON.stringify(metrics)}`);
 }
 assert.equal(await page.getByRole('button',{name:'Send ↗',exact:true}).isDisabled(),true);
 await page.getByRole('textbox',{name:'Assistant prompt'}).fill('   ');assert.equal(await page.getByRole('button',{name:'Send ↗',exact:true}).isDisabled(),true);
 const multiline='A private mini prompt.\nKeep this second line.';
 await page.getByRole('textbox',{name:'Assistant prompt'}).fill(multiline);
 assert.equal(await page.getByRole('button',{name:'Send ↗',exact:true}).isEnabled(),true);
 if(process.env.PRODUCER_PANEL_SCREENSHOTS)await page.locator('.assistant-docked').screenshot({path:process.env.PRODUCER_PANEL_SCREENSHOTS+'/mini.png'});
 await page.getByRole('button',{name:'Expand Assistant',exact:true}).click();
 await page.getByRole('dialog',{name:'Assistant conversation panel',exact:true}).waitFor();
 assert.equal(await page.getByRole('textbox',{name:'Assistant prompt'}).inputValue(),multiline,'expanding retains the complete shared prompt');
 // Re-clicking Expand used to erase placement while leaving open=true, which
 // hid both the floating panel and the compact input until a reset.
 await page.getByRole('button',{name:'Expand Assistant',exact:true}).click();
 assert.equal(await page.getByRole('dialog',{name:'Assistant conversation panel',exact:true}).count(),0);
 assert.equal(await page.getByRole('textbox',{name:'Assistant prompt'}).inputValue(),multiline);
 for(const method of ['close','escape','outside']){
  await page.getByRole('button',{name:'Expand Assistant',exact:true}).click();
  await page.getByRole('dialog',{name:'Assistant conversation panel',exact:true}).waitFor();
  if(method==='close')await page.getByRole('button',{name:'Close Assistant conversation',exact:true}).click();
  if(method==='escape')await page.keyboard.press('Escape');
  if(method==='outside')await page.mouse.click(1400,1000);
  assert.equal(await page.getByRole('dialog',{name:'Assistant conversation panel',exact:true}).count(),0,method+' closes the floating conversation');
  assert.equal(await page.getByRole('textbox',{name:'Assistant prompt'}).inputValue(),multiline,method+' restores the usable shared mini prompt');
 }
 await page.getByRole('button',{name:'Expand Assistant',exact:true}).click();
 await page.getByRole('button',{name:'Expand dock',exact:true}).click();
 await page.getByRole('textbox',{name:'Assistant prompt'}).fill('');
 await page.evaluate(()=>window.render({target:document.getElementById('right'),onExpand:()=>{window.expands++;window.render({compact:false});}}));
 await page.getByRole('textbox',{name:'Assistant prompt'}).fill('Unsent before any private edit.');
 await page.evaluate(()=>{const next=structuredClone(window.source);next.id='room-set-while-typing';next.name='Room changed while typing';window.session=new RehearsalSession(next,undefined,'prepare');window.original=JSON.stringify(window.session.package);window.render({session:window.session});});
 await page.getByRole('button',{name:'Assistant context: Second room Set',exact:true}).click();await page.getByText('The room has changed. This draft is preserved.',{exact:true}).waitFor();await page.getByRole('region',{name:'Assistant Set context'}).press('Escape');
 assert.equal(await page.getByRole('textbox',{name:'Assistant prompt'}).inputValue(),'Unsent before any private edit.');
 assert.equal(await page.locator('.assistant-dock-mount iframe').count(),0,'docked conversation starts no GPU preview');
 await page.getByRole('textbox',{name:'Assistant prompt'}).fill('A precise title change.');
 await page.getByRole('button',{name:'Send ↗',exact:true}).click();await page.waitForFunction(()=>typeof window.release==='function');
 const modelCalls=await page.evaluate(()=>window.modelCalls);
 await page.evaluate(()=>window.render({target:document.getElementById('bottom'),compact:true}));
 await page.getByRole('button',{name:/Assistant.*Working/}).waitFor();
 await page.evaluate(()=>window.release());await page.getByRole('button',{name:/Assistant.*Reply ready/}).waitFor();
 const completed=page.locator('.assistant-task-toast');await completed.waitFor();assert.match(await completed.innerText(),/Reply ready.*Panel draft is ready/s);
 const dockBounds=await page.locator('.assistant-docked').boundingBox(),toastBounds=await completed.boundingBox();
 assert(toastBounds.x<dockBounds.x+dockBounds.width&&toastBounds.x+toastBounds.width>dockBounds.x&&toastBounds.y<dockBounds.y+dockBounds.height&&toastBounds.y+toastBounds.height>dockBounds.y,'completion previews overlay their dock rather than sit beside it');
 if(process.env.PRODUCER_PANEL_SCREENSHOTS)await completed.screenshot({path:process.env.PRODUCER_PANEL_SCREENSHOTS+'/completion.png'});
 await completed.getByRole('button',{name:'View reply ↗',exact:true}).click();
 assert.equal(await completed.count(),0,'reading the reply dismisses its completion toast');
 await page.getByRole('button',{name:'Expand dock',exact:true}).click();
 await page.getByText('Panel draft is ready.',{exact:true}).waitFor();
 assert.equal((await page.locator('.assistant-suggestions-track>button').allTextContents())[0],'Review changes');
 if(process.env.PRODUCER_PANEL_SCREENSHOTS)await page.locator('.assistant-docked').screenshot({path:process.env.PRODUCER_PANEL_SCREENSHOTS+'/ready.png'});
 assert.equal(await page.evaluate(()=>window.modelCalls),modelCalls,'docking and compact view retain the provider session');
 assert.equal(await page.evaluate(()=>window.cancelled),0,'moving the panel does not cancel its active turn');
 assert.equal(await page.evaluate(()=>JSON.stringify(window.session.package)),await page.evaluate(()=>window.original),'model edits never change the room Set');
 await page.getByRole('textbox',{name:'Assistant prompt'}).fill('Keep this unsent prompt.');
 for(const target of ['right','bottom']){await page.evaluate(t=>window.render({target:document.getElementById(t)}),target);assert.equal(await page.getByRole('textbox',{name:'Assistant prompt'}).inputValue(),'Keep this unsent prompt.');}
 await page.getByRole('button',{name:'Review in Set Edit',exact:true}).click();await page.waitForFunction(()=>window.reviews.length===1);
 assert.equal(await page.evaluate(()=>window.reviews[0].set.layouts[0].root.children[0].text),'PANEL VERIFIED');
 assert.deepEqual(await page.evaluate(()=>window.reviews[0].set.controls),await page.evaluate(()=>window.session.package.set.controls));
 await page.waitForFunction(()=>!document.querySelector('.assistant-draft-card'));
 assert.equal(await page.getByRole('button',{name:'Review in Set Edit',exact:true}).count(),0,'a handed-off revision is not offered for review again');
 // Set Edit receives the edited candidate, not the original source. Reopening
 // Assistant from that draft must keep the same conversation and undo journal.
 await page.evaluate(()=>window.render({request:{id:'editor-request',document:window.reviews[0]}}));
 await page.getByRole('dialog',{name:'Set assistant',exact:true}).waitFor();
 assert.equal(await page.getByText('Panel draft is ready.',{exact:true}).count(),1);
 assert.equal(await page.getByRole('button',{name:'Undo',exact:true}).isDisabled(),false);
 assert.equal(await page.evaluate(()=>window.modelCalls),modelCalls,'opening detailed review does not create another provider session');
 await page.getByRole('button',{name:'Load preparation',exact:true}).click();await page.waitForFunction(()=>window.reviews.length===2);
 assert.equal(await page.getByRole('dialog',{name:'Set assistant',exact:true}).count(),0);
 await page.getByText('Panel draft is ready.',{exact:true}).waitFor();
 // A room Set switch must retain an edited draft, conversation and unsent
 // prompt. Review reopens a private editor rather than an obsolete callback.
 await page.evaluate(()=>{const next=structuredClone(window.source);next.id='third-room-set';next.name='Third room Set';window.session=new RehearsalSession(next,undefined,'prepare');window.render({session:window.session});});
 await page.getByRole('button',{name:'Assistant context: Second room Set',exact:true}).waitFor();
 assert.equal(await page.getByRole('textbox',{name:'Assistant prompt'}).inputValue(),'Keep this unsent prompt.');
 await page.getByRole('button',{name:'Assistant context: Second room Set',exact:true}).click();
 await page.getByRole('button',{name:'Open in Set Edit',exact:true}).click();await page.waitForFunction(()=>window.reviews.length===3);
 assert.equal(await page.evaluate(()=>window.reviews[2].set.layouts[0].root.children[0].text),'PANEL VERIFIED');
 assert.equal(await page.evaluate(()=>window.session.package.name),'Third room Set');
 assert(!(await page.evaluate(()=>window.nativeCalls)).some(c=>/^live_/.test(c)),'panel has no native room or capture authority');
 // A prompt can be submitted and cancelled from the mini row itself.
 const turnsBeforeMini=await page.evaluate(()=>window.turns.length);
 const cancelsBeforeMini=await page.evaluate(()=>window.cancelled);
 await page.evaluate(()=>{window.blockMiniTurn=true;const bottom=document.getElementById('bottom');bottom.dataset.compact='true';bottom.style.cssText='width:1100px;height:40px';window.render({target:bottom,compact:true});});
 await page.getByRole('textbox',{name:'Assistant prompt'}).fill('Test cancellation from the mini prompt.');
 await page.getByRole('textbox',{name:'Assistant prompt'}).press('Enter');
 await page.waitForFunction(count=>window.turns.length===count+1,turnsBeforeMini);
 await page.getByRole('button',{name:'Stop',exact:true}).click();
 await page.waitForFunction(count=>window.cancelled===count+1,cancelsBeforeMini);
 await page.evaluate(()=>{window.releaseMini();window.blockMiniTurn=false;});
 await page.getByRole('button',{name:'Send ↗',exact:true}).waitFor();
 await page.getByRole('textbox',{name:'Assistant prompt'}).fill('Still here after stopping.');
 await page.evaluate(()=>{document.getElementById('bottom').dataset.compact='false';window.render({target:document.getElementById('right'),compact:false});});
 assert.equal(await page.getByRole('textbox',{name:'Assistant prompt'}).inputValue(),'Still here after stopping.');
 await page.evaluate(()=>window.failNext=true);
 await page.getByRole('textbox',{name:'Assistant prompt'}).fill('Keep the retry action reachable in every dock.');await page.getByRole('button',{name:'Send ↗',exact:true}).click();await page.getByRole('button',{name:'Retry request',exact:true}).waitFor();
 for(const [name,width,height] of [['side',360,780],['narrow',240,780],['bottom',1100,360],['top',1100,240]]){
  await page.evaluate(({width,height})=>{const target=document.getElementById('right');target.style.width=width+'px';target.style.height=height+'px';document.getElementById('bottom').style.display='none';window.render({target,compact:false});},{width,height});
  await page.waitForFunction(()=>{const target=document.getElementById('right'),element=target.querySelector('.assistant-docked textarea');return element&&element.getBoundingClientRect().height>=30&&(target.clientHeight>=320||!!target.querySelector('.assistant-tight'));});
  const geometry=await page.evaluate(()=>{
   const box=document.querySelector('.assistant-docked').getBoundingClientRect();
   return [...document.querySelectorAll('.assistant-docked .assistant-compose textarea,.assistant-docked .assistant-compose .assistant-send,.assistant-docked .assistant-error button')].map(element=>{const r=element.getBoundingClientRect();return {inside:r.left>=box.left-1&&r.right<=box.right+1&&r.top>=box.top-1&&r.bottom<=box.bottom+1,width:r.width,height:r.height};});
  });
  assert(geometry.every(r=>r.inside&&r.width>25&&r.height>25),name+' keeps the composer and send control visible: '+JSON.stringify(geometry));
  if(process.env.PRODUCER_PANEL_SCREENSHOTS)await page.locator('.assistant-docked').screenshot({path:process.env.PRODUCER_PANEL_SCREENSHOTS+'/'+name+'.png'});
 }
 await page.locator('.assistant-tight').waitFor();
 await page.getByRole('button',{name:'Expand Assistant',exact:true}).click();
 const fullConversation=page.getByRole('dialog',{name:'Assistant conversation panel',exact:true});await fullConversation.waitFor();
 await fullConversation.getByRole('button',{name:'Retry request',exact:true}).waitFor();
 const fullBounds=await fullConversation.boundingBox();assert(fullBounds.width>=320&&fullBounds.height>=400&&fullBounds.x>=0&&fullBounds.y>=0&&fullBounds.x+fullBounds.width<=1440&&fullBounds.y+fullBounds.height<=1050,'a squeezed tile opens a usable viewport-bounded conversation');
 if(process.env.PRODUCER_PANEL_SCREENSHOTS)await fullConversation.screenshot({path:process.env.PRODUCER_PANEL_SCREENSHOTS+'/full-conversation.png'});
 await fullConversation.getByRole('button',{name:'Close Assistant conversation',exact:true}).click();
 assert.equal(await fullConversation.count(),0,'closing the conversation preserves the compact tile');
 await page.evaluate(()=>{const target=document.getElementById('right');target.style.width='150px';target.style.height='780px';window.failNext=true;});
 await page.getByRole('group',{name:'Suggested actions',exact:true}).waitFor();
 await page.getByRole('textbox',{name:'Assistant prompt'}).fill('Send with Enter from the narrow sidebar.');
 assert.equal(await page.getByRole('button',{name:'Send ↗',exact:true}).isVisible(),false,'super-narrow composers use a keyboard cue');
 const keyFits=await page.locator('.assistant-composer').evaluate(element=>{const input=element.querySelector('textarea').getBoundingClientRect(),key=element.querySelector('.assistant-send-key').getBoundingClientRect();return {fits:input.right<=key.left+1,input:input.toJSON(),key:key.toJSON(),form:getComputedStyle(element).display,keyPosition:getComputedStyle(element.querySelector('.assistant-send-key')).position};});assert(keyFits.fits,'the Enter cue never paints over input text: '+JSON.stringify(keyFits));
 await page.getByRole('textbox',{name:'Assistant prompt'}).press('Enter');
 await page.getByText('Send with Enter from the narrow sidebar.',{exact:true}).waitFor();
 assert.equal(await page.getByRole('textbox',{name:'Assistant prompt'}).inputValue(),'');
 assert.deepEqual(errors,[]);
 // Rendered Markdown remains text-owned: no raw HTML, image requests or
 // executable links. Tables must stay inside the dock's scrollable surface.
 await page.evaluate(async()=>{const {AssistantMessage}=await import('/src/features/assistant/AssistantMessage.tsx');const R=await import('/node_modules/.vite/deps/react.js');window.messageHost=document.createElement('div');document.body.append(window.messageHost);const D=await import('/node_modules/.vite/deps/react-dom_client.js');window.messageRoot=(D.createRoot??D.default.createRoot)(window.messageHost);window.messageRoot.render((R.createElement??R.default.createElement)(AssistantMessage,{text:'**Canvas mapping**\n\n| Output | Canvas |\n| --- | --- |\n| Portrait | `1080 × 1920` |\n\n<img src="https://example.invalid/image" onerror="window.injected=true">'}));});
 await page.getByRole('table').waitFor();assert.equal(await page.locator('table tbody td code').innerText(),'1080 × 1920');assert.equal(await page.locator('.assistant-rich-text img').count(),0);assert.equal(await page.evaluate(()=>window.injected),undefined);
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
 const framing=page.getByRole('combobox',{name:/framing$/}).first();await framing.selectOption({label:'Fit entire source'});const privateFraming=await framing.inputValue();
 await page.evaluate(()=>{window.editorProps={...window.editorProps,assistantEditorRequest:{id:'assistant-return-same-set',document:window.reviews[0]}};window.renderEditor();});
 await page.waitForFunction(()=>window.editorAcks.includes('assistant-return-same-set'));assert.equal(await framing.inputValue(),privateFraming,'returning from Assistant preserves private source framing instead of resetting to room output');
 assert.equal(await page.evaluate(()=>window.applyCalls),0);
 await page.getByRole('button',{name:'Close editor',exact:true}).click();
 await page.evaluate(()=>{window.editorKey='moved';window.renderEditor();});
 assert.equal(await page.locator('.set-preview-dialog').count(),0,'moving a panel does not replay a consumed editor request');
 assert.deepEqual(errors,[]);
 console.log('PASS Assistant panel: real 56px top/bottom mini docks; mini submit/stop; room-context chips; inventory migration; dock and compact forms; active-turn/prompt/conversation preservation; one provider owner; private review; same Set Edit draft and cancellation boundaries; no GPU preview or native output calls.');
} finally {await browser.close();}
