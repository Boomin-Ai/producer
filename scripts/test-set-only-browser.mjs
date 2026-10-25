import assert from 'node:assert/strict';
const {chromium}=await import('/private/tmp/producer-sets-v2-browser/node_modules/playwright-core/index.mjs');
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:1436/');
 await page.evaluate(async()=>{
  const M=await import('/node_modules/.vite/deps/react.js'),R=M.default??M,D=await import('/node_modules/.vite/deps/react-dom_client.js');
  const {SetControlsPanel}=await import('/src/features/presentation/SetControlsPanel.tsx'),{SetRoomVoting}=await import('/src/features/presentation/SetRoomVoting.tsx'),{AFTER_HOURS,HEAD_TO_HEAD}=await import('/src/features/presentation/fixtures.ts');
  const source=await(await fetch('/src/features/presentation/SetControlsPanel.tsx')).text(),{RehearsalSession}=await import(source.match(/from "([^"]*rehearsal\.ts[^"]*)"/)[1]);
  window.__TAURI_INTERNALS__={transformCallback:()=>1,invoke:async(cmd)=>cmd==='set_library_list'?[]:null};window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
  window.manualSession=new RehearsalSession(AFTER_HOURS,undefined,'prepare');window.voteCalls=[];
  function Harness(){const [session,setSession]=R.useState(window.manualSession),[vote,setVote]=R.useState(null);window.manualSession=session;window.switchToShow=()=>setSession(new RehearsalSession(HEAD_TO_HEAD,undefined,'prepare'));
   return R.createElement(SetControlsPanel,{session,onChange:doc=>setSession(new RehearsalSession(doc,undefined,'prepare')),voting:R.createElement(SetRoomVoting,{vote,savedVotes:[],onSelectVote:()=>{},onOpen:async(input)=>{window.voteCalls.push(input);setVote({id:'room-vote',state:'collecting',spec:{prompt:input.prompt,options:[{id:'a',label:input.a},{id:'b',label:input.b}]},timing:{},tally:{total:0,options:{a:0,b:0}}});return true;},onTransition:action=>{window.voteCalls.push(action);setVote(old=>({...old,state:action==='reveal'?'revealed':'closed'}));}}),output:{renderer:'native',active:true,busy:false,error:'',bindings:{},framing:{},sources:{items:[]},bind:()=>{},frame:()=>{},apply:async()=>{},returnToRoom:async()=>true}});
  }
  const host=document.createElement('div');host.className='rm-dock-bottom';host.style.cssText='height:650px;width:1400px';host.innerHTML='<div class="rm-panel-setControls" style="container:panel / inline-size;height:100%;width:100%"><div class="rm-panel-body" style="height:100%;display:flex;flex-direction:column"></div></div>';document.body.style.background='#0d131d';document.body.replaceChildren(host);(D.createRoot??D.default.createRoot)(host.querySelector('.rm-panel-body')).render(R.createElement(Harness));
 });
 assert.equal(await page.getByRole('button',{name:'Start show',exact:true}).count(),0);
 assert.equal(await page.getByRole('group',{name:'Show playback'}).count(),0);
 assert.equal(await page.locator('.set-participation,.set-run,.set-segments').count(),0);
 await page.locator('.set-layout-list button').filter({hasText:'Solo'}).click();
 assert.equal(await page.evaluate(()=>window.manualSession.snapshot().layoutId),'solo');assert.equal(await page.evaluate(()=>window.manualSession.snapshot().running),false);
 await page.getByRole('textbox',{name:'Host name',exact:false}).fill('Manual host');assert.equal(await page.evaluate(()=>window.manualSession.snapshot().values.hostName),'Manual host');
 await page.locator('.set-room-voting').getByRole('button',{name:'Set up',exact:true}).click();await page.getByPlaceholder('Option A').fill('BeltLine');await page.getByPlaceholder('Option B').fill('Piedmont Park');await page.getByPlaceholder('Question (optional)').fill('Where are we going?');await page.getByRole('button',{name:'Open vote',exact:true}).click();
 await page.waitForFunction(()=>window.voteCalls.length===1);assert.equal(await page.evaluate(()=>window.manualSession.snapshot().running),false);
 await page.locator('.set-room-voting').getByRole('button',{name:'Reveal',exact:true}).click();assert.equal(await page.evaluate(()=>window.voteCalls.at(-1)),'reveal');await page.locator('.set-room-voting').getByRole('button',{name:'Close',exact:true}).click();
 await page.getByRole('button',{name:'Set settings',exact:true}).click();const editor=page.locator('dialog[open]');
 assert(await editor.getByText('Set details',{exact:true}).isVisible());assert.equal(await editor.getByRole('button',{name:'Rehearse',exact:true}).count(),0);assert.equal(await editor.getByRole('combobox',{name:'Edit segment',exact:true}).count(),0);
 await editor.getByRole('button',{name:'Close editor',exact:true}).click();
 for(const width of [1000,720,480]){await page.setViewportSize({width,height:960});await page.evaluate(w=>document.querySelector('.rm-dock-bottom').style.width=(w-20)+'px',width);await page.waitForTimeout(80);assert(await page.locator('.set-sections').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'set-only cards fit at '+width);}
 await page.setViewportSize({width:1440,height:960});await page.evaluate(()=>document.querySelector('.rm-dock-bottom').style.width='1400px');await page.screenshot({path:'/private/tmp/producer-set-only-panel.png'});
 await page.evaluate(()=>window.switchToShow());await page.waitForSelector('.set-run');assert(await page.locator('.set-participation').isVisible());assert.equal(await page.locator('.set-room-voting').count(),0);
 assert.deepEqual(errors,[]);console.log('PASS: standalone layouts/content and real vote-service callbacks work without show transport; editor stays set-only; attaching a show restores segment controls');
}finally{await browser.close();}
