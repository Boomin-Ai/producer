// Exercise App routing and the actual Onboarding/SignIn/ModLinkDrop components.
// Home, native IPC, permission UI and media seats are controlled test seams.
// CSS and FirstLight are mocked: this suite makes no visual or device-permission claims.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

const root=resolve(fileURLToPath(new URL('../',import.meta.url)));
const mocks={
  nativeInvoke:`export const invoke=(command,args)=>window.testInvoke(command,args);`,
  workspace:`export const setActiveEndpointId=id=>{window.activeEndpoint=id;};`,
  Home:`import React from 'react';export function Home(props){window.homeProps=props;return <section><h1>Saved workspace Home</h1><output>{props.endpoints.map(e=>e.id).join(',')}</output><button onClick={()=>props.onAddEndpoint('server')}>Connect a server</button><button onClick={()=>props.onAddEndpoint()}>Add workspace</button><button onClick={props.onSignOut}>Sign out</button></section>;}`,
  FirstLight:`import React from 'react';export const firstLightDone=()=>window.fixture.firstLightDone;export function FirstLight({onDone}){window.firstLightMounts=(window.firstLightMounts??0)+1;return <section><h1>Permissions setup</h1><button onClick={onDone}>Continue permissions</button></section>;}`,
  ModSeat:`import React from 'react';export function ModSeat({link,onLeave}){window.openedMod=link;return <section><h1>Invitation control seat</h1><button onClick={onLeave}>Leave invitation</button></section>;}`,
  SetsDevelopmentRoom:`import React from 'react';export const SetsDevelopmentRoom=()=> <h1>Unexpected development room</h1>;`,
  opener:`export const openUrl=async url=>{window.openedUrls.push(url);};`,
  appIdentifier:`export const getIdentifier=async()=>{window.appIdentifierReads=(window.appIdentifierReads??0)+1;return window.fixture.appIdentifier??'ai.boomin.producer.sets-v2-dev';};`,
};
const bundles=new Map();
function bundleFor(env={}){
 const key=JSON.stringify(env);
 if(!bundles.has(key))bundles.set(key,build({
  stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import App from './src/App';import {Onboarding} from './src/views/Onboarding';const root=createRoot(document.getElementById('root'));window.renderDirect=props=>root.render(<Onboarding {...props} onConnected={()=>{}}/>);root.render(<App/>);`,resolveDir:root,loader:'tsx'},
  bundle:true,write:false,format:'iife',platform:'browser',define:{'import.meta.env':key},
  plugins:[{name:'beta-entry-fixture',setup(b){
    b.onResolve({filter:/\.css$/},()=>({path:'css',namespace:'mock'}));
    b.onResolve({filter:/^@tauri-apps\/api\/app$/},()=>({path:'appIdentifier',namespace:'mock'}));
    b.onResolve({filter:/nativeInvoke|lib\/workspace|views\/(Home|FirstLight|ModSeat|SetsDevelopmentRoom)$|plugin-opener/},args=>{
      const key=args.path.endsWith('plugin-opener')?'opener':Object.keys(mocks).find(key=>args.path.endsWith('/'+key));
      return key?{path:key,namespace:'mock'}:undefined;
    });
    b.onLoad({filter:/.*/,namespace:'mock'},args=>({contents:args.path==='css'?'':mocks[args.path],loader:'tsx',resolveDir:root}));
  }}],
 }));
 return bundles.get(key);
}
const bundle=await bundleFor();
const module=process.env.PRODUCER_PLAYWRIGHT_MODULE;
const {chromium}=await import(module?(module.startsWith('file:')?module:pathToFileURL(resolve(module)).href):new URL('../tools/producer-mcp/node_modules/playwright-core/index.mjs',import.meta.url).href);
const browser=await chromium.launch({headless:true,...(process.env.PRODUCER_TEST_CHROME?{executablePath:process.env.PRODUCER_TEST_CHROME}:{channel:process.env.PRODUCER_BROWSER_CHANNEL??'chrome'})});
const boomin={id:'brand',kind:'connected',name:'Boomin brand',brand_slug:'beta',base_url:'https://api.example.test'};
const owned={id:'owned',kind:'independent',name:'Existing server',base_url:'https://owned.example.test'};
const results=[];
async function pageFor(options={},env=null){
  const page=await browser.newPage();page.setDefaultTimeout(8000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setContent('<div id="root"></div>');
  await page.evaluate(options=>{
    window.fixture={endpoints:[],firstLightDone:true,...options};window.calls=[];window.openedUrls=[];
    // Hold the native boundary open to exercise actual pending React states.
    // Releasing one command is one-shot; it never authenticates outside this page.
    window.pendingIpc=Object.create(null);
    window.releaseIpc=(command,error)=>{
      const pending=window.pendingIpc[command];
      if(!pending)throw Error('No pending fixture IPC: '+command);
      delete window.pendingIpc[command];
      window.fixture.deferCommands=(window.fixture.deferCommands??[]).filter(value=>value!==command);
      if(error)pending.reject(Error(error));else pending.resolve();
    };
    if(window.fixture.native!==false)window.__TAURI_INTERNALS__={};
    const values=new Map(window.fixture.returning?[['producer.signedin.v1','1']]:[]);
    Object.defineProperty(window,'localStorage',{value:{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key)},configurable:true});
    window.testInvoke=async(command,args)=>{
      window.calls.push({command,args});const f=window.fixture;
      if(command==='ui_log')return;
      if(f.deferCommands?.includes(command))await new Promise((resolve,reject)=>{
        if(window.pendingIpc[command])throw Error('Duplicate pending fixture IPC: '+command);
        window.pendingIpc[command]={resolve,reject};
      });
      if(command==='live_set_v2_smoke_enabled')return false;
      if(command==='list_endpoints'){if(f.listError)throw Error('Endpoint storage unavailable');return [...f.endpoints];}
      if(command==='boomin_request_otp')return {};
      if(command==='boomin_connect'){
        if(f.connectError)throw Error('Test verification failed');
        if(f.noBrands)throw Error('this account has no workspace yet — create one in the Boomin web app first');
        if(f.multipleBrands)return {needs_brand:true,brands:[{slug:'first',name:'First brand'},{slug:'second',name:'Second brand'}]};
        f.endpoints.push({id:'connected-beta',kind:'connected',name:'Beta account',base_url:'https://api.example.test'});return f.omitEndpointId?{}:{id:'connected-beta'};
      }
      if(command==='boomin_select_brand'){const id='brand-'+args.brandSlug;f.endpoints.push({id,kind:'connected',name:args.brandSlug,base_url:'https://api.example.test'});return f.omitEndpointId?{}:{id};}
      if(command==='network_status')return {membership:f.membership==='new'?null:{status:'active'}};
      if(command==='network_join')return {joined:true};
      if(command==='add_endpoint'){f.endpoints.push({id:'added-owned',kind:'independent',name:args.name,base_url:args.baseUrl});return {id:'added-owned'};}
      if(command==='remove_endpoint'){f.endpoints=f.endpoints.filter(e=>e.id!==args.endpointId);return;}
      throw Error('Unexpected test IPC: '+command);
    };
  },options);
  const compiled=env===null?bundle:await bundleFor(env);
  await page.addScriptTag({content:compiled.outputFiles[0].text});
  return {page,errors};
}
async function noInitialServer(page){
  assert.equal(await page.getByText('Use my own server',{exact:true}).count(),0);
  assert.equal(await page.getByText('Use your own server',{exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:/Advanced|Connect my server|Self-hosting guide/}).count(),0);
  assert.equal(await page.getByLabel('Server URL',{exact:true}).count(),0);
  assert.equal(await page.getByLabel('API root (advanced)',{exact:true}).count(),0);
}
async function codeStep(page,code='000000'){
  await page.getByLabel('Email',{exact:true}).fill('creator@example.test');
  await page.getByRole('button',{name:'Email me a code',exact:true}).click();
  await page.getByLabel('Sign-in code',{exact:true}).fill(code);
}
try{
  for(const returning of [false,true]){
    const {page,errors}=await pageFor({returning});
    await page.getByRole('heading',{name:returning?'Welcome back':'Sign in to Producer',exact:true}).waitFor();
    await page.getByText('Producer beta requires a Boomin account and workspace.',{exact:false}).waitFor();await noInitialServer(page);
    assert.equal(await page.evaluate(()=>window.calls.filter(c=>!['list_endpoints','live_set_v2_smoke_enabled'].includes(c.command)).length),0);
    assert.deepEqual(errors,[]);results.push(returning?'signed-out entry requires Boomin':'fresh entry requires Boomin');await page.close();
  }
  {
    const {page}=await pageFor({endpoints:[owned]});await page.getByRole('heading',{name:'Saved workspace Home'}).waitFor();
    await page.getByRole('button',{name:'Connect a server',exact:true}).click();await page.getByLabel('Server URL',{exact:true}).waitFor();
    await page.getByLabel('Name',{exact:true}).fill('Second server');await page.getByLabel('Server URL',{exact:true}).fill('https://second.example.test');await page.getByLabel('Primary token',{exact:true}).fill('synthetic-token');
    await page.getByRole('button',{name:'Verify & connect',exact:true}).click();await page.getByRole('heading',{name:'Saved workspace Home'}).waitFor();
    assert.deepEqual(await page.evaluate(()=>window.fixture.endpoints.map(e=>e.id)),['owned','added-owned']);
    assert.equal(await page.evaluate(()=>window.calls.some(c=>c.command.startsWith('boomin_'))),false);results.push('existing owned server enters Home and can explicitly connect another server');await page.close();
  }
  {
    const {page}=await pageFor({endpoints:[boomin]});await page.getByRole('heading',{name:'Saved workspace Home'}).waitFor();await page.getByRole('button',{name:'Add workspace',exact:true}).click();
    await page.getByText('Use your own server',{exact:true}).waitFor();await page.getByRole('button',{name:'Connect my server',exact:true}).click();await page.getByLabel('Server URL',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Back',exact:true}).click();await page.getByText('Use your own server',{exact:true}).waitFor();await page.locator('button[title="Back to the control room"]').click();await page.getByRole('heading',{name:'Saved workspace Home'}).waitFor();
    results.push('existing Boomin endpoint retains explicit workspace/server connection chooser');await page.close();
  }
  for(const keepOwned of [false,true]){
    const {page}=await pageFor({returning:true,endpoints:keepOwned?[boomin,owned]:[boomin]});await page.getByRole('heading',{name:'Saved workspace Home'}).waitFor();await page.getByRole('button',{name:'Sign out',exact:true}).click();
    if(keepOwned){await page.getByRole('heading',{name:'Saved workspace Home'}).waitFor();await page.waitForFunction(()=>window.homeProps.endpoints.length===1);assert.equal(await page.evaluate(()=>window.homeProps.endpoints[0].id),'owned');}
    else{await page.getByRole('heading',{name:'Welcome back',exact:true}).waitFor();await noInitialServer(page);}
    assert.deepEqual(await page.evaluate(()=>window.calls.filter(c=>c.command==='remove_endpoint').map(c=>c.args.endpointId)),['brand']);results.push(keepOwned?'Boomin sign-out preserves existing owned-server Home':'last Boomin sign-out returns to beta sign-in');await page.close();
  }
  {
    const {page}=await pageFor({membership:'new'});await page.getByRole('heading',{name:'Sign in to Producer'}).waitFor();await codeStep(page);
    await page.getByRole('button',{name:'Back',exact:true}).click();await noInitialServer(page);await page.getByRole('button',{name:'Email me a code',exact:true}).click();
    assert.equal(await page.getByLabel('Sign-in code',{exact:true}).inputValue(),'');
    await page.getByLabel('Sign-in code',{exact:true}).fill('000000');
    await page.getByRole('button',{name:'Verify & connect',exact:true}).click();await page.getByRole('heading',{name:'Meet your network',exact:true}).waitFor();
    const optIn=page.getByRole('checkbox',{name:/^List my workspace on Boomin/});
    assert.equal(await optIn.isChecked(),false);
    assert.equal(await page.evaluate(()=>window.calls.some(c=>c.command==='network_join')),false);
    await page.getByRole('button',{name:'Continue',exact:true}).click();await page.getByRole('heading',{name:'Saved workspace Home'}).waitFor();
    assert.equal(await page.evaluate(()=>window.calls.some(c=>c.command==='network_join')),false);
    assert.equal(await page.evaluate(()=>window.calls.filter(c=>['boomin_request_otp','boomin_connect'].includes(c.command)).every(c=>c.args.apiRoot===null)),true);
    assert.equal(await page.evaluate(()=>window.activeEndpoint),'connected-beta');results.push('email/code connects through default Boomin API; network opt-in stays optional and off');await page.close();
  }
  {
    const {page}=await pageFor({membership:'new',deferCommands:['network_join']});
    await page.getByRole('heading',{name:'Sign in to Producer'}).waitFor();await codeStep(page);
    await page.getByRole('button',{name:'Verify & connect',exact:true}).click();await page.getByRole('heading',{name:'Meet your network',exact:true}).waitFor();
    const optIn=page.getByRole('checkbox',{name:/^List my workspace on Boomin/});
    assert.equal(await optIn.isChecked(),false);await optIn.press('Space');assert.equal(await optIn.isChecked(),true);
    await page.getByRole('button',{name:'Join and continue',exact:true}).click();
    await page.waitForFunction(()=>!!window.pendingIpc.network_join);
    assert.equal(await optIn.isDisabled(),true);assert.equal(await page.getByRole('button',{name:'Finishing…',exact:true}).isDisabled(),true);
    assert.deepEqual(await page.evaluate(()=>window.calls.filter(c=>c.command==='network_join').map(c=>c.args.endpointId)),['connected-beta']);
    await page.evaluate(()=>window.releaseIpc('network_join'));await page.getByRole('heading',{name:'Saved workspace Home'}).waitFor();
    assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='network_join').length),1);
    results.push('keyboard network opt-in joins the selected workspace exactly once and cannot toggle while pending');await page.close();
  }
  for(const multipleBrands of [false,true]){
    // An already-saved connected endpoint stays first in storage. Consent
    // belongs to the just-authenticated endpoint, never this earlier one.
    const {page}=await pageFor({endpoints:[boomin,owned],membership:'new',multipleBrands});
    await page.getByRole('heading',{name:'Saved workspace Home'}).waitFor();await page.getByRole('button',{name:'Add workspace',exact:true}).click();
    await page.getByRole('button',{name:'Sign in with email',exact:true}).click();await codeStep(page);
    await page.getByRole('button',{name:'Verify & connect',exact:true}).click();
    const expected=multipleBrands?'brand-second':'connected-beta';
    if(multipleBrands){await page.getByRole('heading',{name:'Choose a workspace',exact:true}).waitFor();await page.getByRole('button',{name:'Second brand',exact:false}).click();}
    await page.getByRole('heading',{name:'Meet your network',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.fixture.endpoints[0].id),'brand');
    assert.deepEqual(await page.evaluate(()=>window.calls.filter(c=>c.command==='network_status').map(c=>c.args.endpointId)),[expected]);
    const optIn=page.getByRole('checkbox',{name:/^List my workspace on Boomin/});assert.equal(await optIn.isChecked(),false);await optIn.check();
    await page.getByRole('button',{name:'Join and continue',exact:true}).click();await page.getByRole('heading',{name:'Saved workspace Home'}).waitFor();
    assert.deepEqual(await page.evaluate(()=>window.calls.filter(c=>c.command==='network_join').map(c=>c.args.endpointId)),[expected]);
    assert.equal(await page.evaluate(()=>window.activeEndpoint),expected);
    results.push(multipleBrands?'brand selection lists and joins only the newly selected workspace when an older connected endpoint is first':'single-workspace verification lists and joins only the new returned endpoint when an older connected endpoint is first');await page.close();
  }
  for(const multipleBrands of [false,true]){
    const {page}=await pageFor({endpoints:[boomin,owned],membership:'new',multipleBrands,omitEndpointId:true});
    await page.getByRole('heading',{name:'Saved workspace Home'}).waitFor();await page.getByRole('button',{name:'Add workspace',exact:true}).click();
    await page.getByRole('button',{name:'Sign in with email',exact:true}).click();await codeStep(page);
    await page.getByRole('button',{name:'Verify & connect',exact:true}).click();
    if(multipleBrands){await page.getByRole('heading',{name:'Choose a workspace',exact:true}).waitFor();await page.getByRole('button',{name:'Second brand',exact:false}).click();}
    await page.getByRole('heading',{name:'Saved workspace Home'}).waitFor();
    assert.equal(await page.getByRole('heading',{name:'Meet your network',exact:true}).count(),0);
    assert.equal(await page.evaluate(()=>window.calls.some(c=>['network_status','network_join'].includes(c.command))),false);
    assert.deepEqual(await page.evaluate(()=>window.fixture.endpoints.map(endpoint=>endpoint.id)),['brand','owned',multipleBrands?'brand-second':'connected-beta']);
    results.push(multipleBrands?'older engine without a brand-selection endpoint ID finishes without inspecting or listing an arbitrary saved workspace':'older engine without a verification endpoint ID finishes without inspecting or listing an arbitrary saved workspace');await page.close();
  }
  {
    const {page}=await pageFor();await page.getByRole('heading',{name:'Sign in to Producer'}).waitFor();
    const email=page.getByLabel('Email',{exact:true});assert.equal(await email.getAttribute('autocomplete'),'email');
    await email.fill('creator@example.test');await page.getByRole('button',{name:'Email me a code',exact:true}).click();
    await page.getByRole('heading',{name:'Check your inbox',exact:true}).waitFor();
    const code=page.getByLabel('Sign-in code',{exact:true});
    assert.equal(await code.evaluate(input=>input.type),'text');assert.equal(await code.getAttribute('inputmode'),'numeric');
    assert.equal(await code.getAttribute('autocomplete'),'one-time-code');assert.equal(await code.getAttribute('maxlength'),'6');
    assert.equal(await code.evaluate(input=>input===document.activeElement),true);
    await page.getByText('Enter the sign-in code sent to creator@example.test.',{exact:true}).waitFor();
    await code.fill('00123');await page.getByRole('button',{name:'Verify & connect',exact:true}).click();
    assert.equal(await code.evaluate(input=>input.validity.patternMismatch),true);
    assert.equal(await page.evaluate(()=>window.calls.some(c=>c.command==='boomin_connect')),false);
    await code.fill('00123x');await page.getByRole('button',{name:'Verify & connect',exact:true}).click();
    assert.equal(await page.evaluate(()=>window.calls.some(c=>c.command==='boomin_connect')),false);
    await code.fill('001234');assert.equal(await code.inputValue(),'001234');await code.press('Enter');
    await page.getByRole('heading',{name:'Saved workspace Home'}).waitFor();
    assert.deepEqual(await page.evaluate(()=>window.calls.filter(c=>c.command==='boomin_connect').map(c=>({email:c.args.email,code:c.args.code}))),[{email:'creator@example.test',code:'001234'}]);
    results.push('OTP autofill uses a text field, focuses the code, validates six digits and preserves leading zeros through keyboard submission');await page.close();
  }
  {
    const {page}=await pageFor({deferCommands:['boomin_request_otp']});await page.getByRole('heading',{name:'Sign in to Producer'}).waitFor();
    const email=page.getByLabel('Email',{exact:true});await email.fill('creator@example.test');
    await page.getByRole('button',{name:'Email me a code',exact:true}).click();await page.waitForFunction(()=>!!window.pendingIpc.boomin_request_otp);
    const form=page.locator('form.entry-form');assert.equal(await form.getAttribute('aria-busy'),'true');
    assert.equal(await email.isDisabled(),true);assert.equal(await page.getByRole('button',{name:'Sending code…',exact:true}).isDisabled(),true);
    assert.equal(await page.getByRole('button',{name:'Create a Boomin account',exact:false}).isDisabled(),true);
    assert.equal(await page.getByRole('button',{name:'Open a mod link',exact:true}).isDisabled(),true);
    await form.evaluate(form=>form.requestSubmit());
    assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='boomin_request_otp').length),1);
    assert.equal(await page.getByLabel('Sign-in code',{exact:true}).count(),0);
    await page.evaluate(()=>window.releaseIpc('boomin_request_otp'));await page.getByRole('heading',{name:'Check your inbox',exact:true}).waitFor();
    assert.equal(await page.getByLabel('Sign-in code',{exact:true}).isEnabled(),true);assert.equal(await form.getAttribute('aria-busy'),'false');
    assert.deepEqual(await page.evaluate(()=>window.calls.filter(c=>c.command==='boomin_request_otp').map(c=>c.args.email)),['creator@example.test']);
    results.push('pending code delivery freezes email and alternate actions and rejects duplicate form submission');await page.close();
  }
  {
    const {page}=await pageFor({deferCommands:['boomin_connect']});await page.getByRole('heading',{name:'Sign in to Producer'}).waitFor();
    await page.getByRole('button',{name:'Open a mod link',exact:true}).click();await codeStep(page,'001234');
    const invitation=page.getByLabel('Mod link',{exact:true});assert.equal(await invitation.isEnabled(),true);
    await page.getByRole('button',{name:'Verify & connect',exact:true}).click();await page.waitForFunction(()=>!!window.pendingIpc.boomin_connect);
    const form=page.locator('form.entry-form');assert.equal(await form.getAttribute('aria-busy'),'true');
    assert.equal(await page.getByLabel('Sign-in code',{exact:true}).isDisabled(),true);
    for(const name of ['Signing in…','Back','Open a mod link'])assert.equal(await page.getByRole('button',{name,exact:true}).isDisabled(),true);
    assert.equal(await page.getByRole('button',{name:'Create a Boomin account',exact:false}).isDisabled(),true);
    assert.equal(await page.locator('fieldset.entry-invitation-fields').evaluate(fieldset=>fieldset.disabled),true);
    assert.equal(await invitation.isDisabled(),true);
    // dispatchEvent intentionally bypasses native disabled-input behavior.
    // PreventDefault proves the real React paste/drop handler parsed the link;
    // the caller's busy guard must still reject opening its capability seat.
    const pasted=await invitation.evaluate(input=>{
      const data=new DataTransfer();data.setData('text','https://host.example.test/connect/mod/gm_synthetic_pending');
      const event=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data});input.dispatchEvent(event);return event.defaultPrevented;
    });
    assert.equal(pasted,true);
    const dropped=await page.locator('.entry-invitation .modlink-drop').evaluate(target=>{
      const data=new DataTransfer();data.setData('text/uri-list','https://host.example.test/connect/mod/gm_synthetic_pending');
      const event=new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data});target.dispatchEvent(event);return event.defaultPrevented;
    });
    assert.equal(dropped,true);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>resolve())));
    assert.equal(await page.getByRole('heading',{name:'Invitation control seat'}).count(),0);
    assert.equal(await page.evaluate(()=>window.openedMod===undefined),true);
    await page.getByRole('heading',{name:'Check your inbox',exact:true}).waitFor();
    await form.evaluate(form=>form.requestSubmit());
    assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='boomin_connect').length),1);
    assert.equal(await page.getByRole('heading',{name:'Saved workspace Home'}).count(),0);
    await page.evaluate(()=>window.releaseIpc('boomin_connect'));await page.getByRole('heading',{name:'Saved workspace Home'}).waitFor();
    assert.equal(await page.evaluate(()=>window.activeEndpoint),'connected-beta');
    assert.equal(await page.evaluate(()=>window.openedMod===undefined),true);
    assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='boomin_connect').length),1);
    results.push('pending verification disables expanded invitation inputs and rejects forced paste/drop without duplicate authentication or a capability-seat jump');await page.close();
  }
  for(const command of ['boomin_request_otp','boomin_connect']){
    const {page}=await pageFor({deferCommands:[command]});await page.getByRole('heading',{name:'Sign in to Producer'}).waitFor();
    if(command==='boomin_connect'){await codeStep(page);await page.getByRole('button',{name:'Verify & connect',exact:true}).click();}
    else{await page.getByLabel('Email',{exact:true}).fill('creator@example.test');await page.getByRole('button',{name:'Email me a code',exact:true}).click();}
    await page.waitForFunction(command=>!!window.pendingIpc[command],command);
    await page.evaluate(command=>window.releaseIpc(command,'Synthetic sign-in failure'),command);
    const alert=page.getByRole('alert');await alert.waitFor();assert.match(await alert.textContent(),/Synthetic sign-in failure/);
    const form=page.locator('form.entry-form');assert.equal(await form.getAttribute('aria-busy'),'false');
    assert.equal(await form.getAttribute('aria-describedby'),await alert.getAttribute('id'));
    assert.equal(await page.evaluate(()=>window.fixture.endpoints.length),0);assert.equal(await page.getByRole('heading',{name:'Saved workspace Home'}).count(),0);
    if(command==='boomin_connect'){
      assert.equal(await page.getByLabel('Sign-in code',{exact:true}).isEnabled(),true);await page.getByRole('button',{name:'Back',exact:true}).click();
      assert.equal(await page.getByRole('alert').count(),0);
    }
    assert.equal(await page.getByLabel('Email',{exact:true}).isEnabled(),true);await noInitialServer(page);
    await page.getByRole('button',{name:'Email me a code',exact:true}).click();await page.getByRole('heading',{name:'Check your inbox',exact:true}).waitFor();
    assert.equal(await page.getByLabel('Sign-in code',{exact:true}).inputValue(),'');
    results.push(command==='boomin_connect'?'verification failure is announced, associated with the form and recovers without opening a workspace':'code-delivery failure is announced and restores retry controls');await page.close();
  }
  {
    const {page}=await pageFor({multipleBrands:true});await page.getByRole('heading',{name:'Sign in to Producer'}).waitFor();await codeStep(page);await page.getByRole('button',{name:'Verify & connect',exact:true}).click();
    await page.getByRole('heading',{name:'Choose a workspace',exact:true}).waitFor();await page.getByRole('button',{name:'Use a different email',exact:true}).waitFor();await noInitialServer(page);
    await page.getByRole('button',{name:'First brand',exact:false}).click();await page.getByRole('heading',{name:'Saved workspace Home'}).waitFor();assert.equal(await page.evaluate(()=>window.activeEndpoint),'brand-first');results.push('multi-brand beta sign-in keeps the workspace selection path');await page.close();
  }
  {
    const {page}=await pageFor();await page.getByRole('heading',{name:'Sign in to Producer'}).waitFor();await page.evaluate(()=>window.renderDirect({start:'server',allowServerConnection:false}));await page.getByRole('heading',{name:'Sign in to Producer'}).waitFor();await noInitialServer(page);results.push('stale/direct server start cannot bypass fresh-primary requirement');await page.close();
  }
  {
    const {page}=await pageFor();await page.getByRole('heading',{name:'Sign in to Producer'}).waitFor();await page.evaluate(()=>window.renderDirect({allowServerConnection:true}));await page.getByRole('button',{name:'Sign in with email',exact:true}).click();await page.getByRole('button',{name:'Advanced: custom API root',exact:true}).click();await page.getByLabel('API root (advanced)',{exact:true}).fill('https://custom.example.test');
    await page.evaluate(()=>window.renderDirect({allowServerConnection:false}));
    // The heading exists before and after this concurrent React render. Wait
    // for the changed permission to commit, not the already-present heading.
    await page.getByLabel('API root (advanced)',{exact:true}).waitFor({state:'detached'});
    await noInitialServer(page);await codeStep(page);await page.getByRole('button',{name:'Verify & connect',exact:true}).click();await page.waitForFunction(()=>window.calls.some(c=>c.command==='boomin_connect'));assert.equal(await page.evaluate(()=>window.calls.filter(c=>['boomin_request_otp','boomin_connect'].includes(c.command)).every(c=>c.args.apiRoot===null)),true);results.push('beta entry ignores a retained custom API root after permission changes');await page.close();
  }
  {
    const {page}=await pageFor({noBrands:true});await page.getByRole('heading',{name:'Sign in to Producer'}).waitFor();await codeStep(page);await page.getByRole('button',{name:'Verify & connect',exact:true}).click();
    await page.getByText('this account has no workspace yet — create one in the Boomin web app first',{exact:false}).waitFor();await noInitialServer(page);
    assert.equal(await page.evaluate(()=>window.fixture.endpoints.length),0);assert.equal(await page.getByRole('heading',{name:'Saved workspace Home'}).count(),0);
    await page.getByRole('button',{name:'Create a Boomin account',exact:false}).click();assert.deepEqual(await page.evaluate(()=>window.openedUrls),['https://boomin.ai/signup']);
    await page.getByRole('button',{name:'Back',exact:true}).click();await page.getByLabel('Email',{exact:true}).fill('other@example.test');results.push('workspace-less account stays at sign-in with an explicit Boomin account/workspace recovery link');await page.close();
  }
  {
    const {page}=await pageFor({listError:true});await page.getByRole('heading',{name:'Sign in to Producer'}).waitFor();await noInitialServer(page);results.push('endpoint lookup failure keeps beta entry closed to new owned-server registration');await page.close();
  }
  {
    const {page}=await pageFor({firstLightDone:false,endpoints:[owned]});await page.getByRole('heading',{name:'Permissions setup'}).waitFor();await page.getByRole('button',{name:'Continue permissions'}).click();await page.getByRole('heading',{name:'Saved workspace Home'}).waitFor();results.push('FirstLight remains ahead of normal routing');await page.close();
  }
  {
    const {page}=await pageFor();await page.getByRole('heading',{name:'Sign in to Producer'}).waitFor();
    const disclosure=page.getByRole('button',{name:'Open a mod link',exact:true});
    assert.equal(await disclosure.getAttribute('aria-expanded'),'false');assert.equal(await page.getByLabel('Mod link',{exact:true}).count(),0);
    const controls=await disclosure.getAttribute('aria-controls');assert.ok(controls);
    await disclosure.press('Enter');assert.equal(await disclosure.getAttribute('aria-expanded'),'true');
    assert.equal(await page.evaluate(id=>!!document.getElementById(id)?.querySelector('input[aria-label="Mod link"]'),controls),true);
    await disclosure.press('Space');assert.equal(await disclosure.getAttribute('aria-expanded'),'false');assert.equal(await page.getByLabel('Mod link',{exact:true}).count(),0);
    await disclosure.press('Enter');await page.getByLabel('Mod link',{exact:true}).fill('https://host.example.test/connect/mod/gm_synthetic_invitation');await page.getByLabel('Mod link',{exact:true}).press('Enter');
    await page.getByRole('heading',{name:'Invitation control seat'}).waitFor();assert.equal(await page.evaluate(()=>window.openedMod.origin),'https://host.example.test');assert.equal(await page.evaluate(()=>window.fixture.endpoints.length),0);
    await page.getByRole('button',{name:'Leave invitation'}).click();await page.getByRole('heading',{name:'Sign in to Producer'}).waitFor();await noInitialServer(page);
    assert.equal(await page.getByRole('button',{name:'Open a mod link',exact:true}).getAttribute('aria-expanded'),'false');
    results.push('keyboard invitation disclosure announces its state and preserves account-free capability entry and return');await page.close();
  }
  {
    const {page}=await pageFor({native:false});await page.getByRole('heading',{name:'Sign in to Producer'}).waitFor();assert(await page.getByRole('button',{name:'Open the desktop app',exact:true}).isDisabled());await noInitialServer(page);assert.equal(await page.evaluate(()=>window.calls.length),0);results.push('browser preview stays static without a native bridge');await page.close();
  }
  for(const appIdentifier of ['ai.boomin.producer.sets-v2-dev','ai.boomin.producer.windows-network-dev']){
    const {page,errors}=await pageFor({endpoints:[boomin,owned],appIdentifier},{DEV:true,VITE_PRODUCER_ENTRY_REVIEW:'1'});
    await page.getByRole('heading',{name:'Sign in to Producer',exact:true}).waitFor();await noInitialServer(page);
    assert.equal(await page.getByRole('heading',{name:'Saved workspace Home'}).count(),0);
    assert.equal(await page.evaluate(()=>window.firstLightMounts??0),0);
    await page.waitForFunction(()=>window.calls.some(call=>call.command==='ui_log'&&call.args.line.startsWith('[entry-review]')));
    await page.getByRole('button',{name:'Back to studio',exact:true}).click();await page.getByRole('heading',{name:'Saved workspace Home'}).waitFor();
    assert.deepEqual(await page.evaluate(()=>window.fixture.endpoints),[boomin,owned]);
    assert.equal(await page.getByRole('button',{name:'Back to studio',exact:true}).count(),0);
    assert.equal(await page.evaluate(()=>window.appIdentifierReads),1);
    assert.equal(await page.evaluate(()=>window.calls.every(call=>['list_endpoints','live_set_v2_smoke_enabled','ui_log'].includes(call.command))),true);
    assert.deepEqual(errors,[]);results.push(appIdentifier.endsWith('windows-network-dev')?'Windows development entry review exits to the unchanged saved workspace without authentication or logout':'Mac development entry review exits to the unchanged saved workspace without authentication or logout');await page.close();
  }
  {
    const {page}=await pageFor({endpoints:[boomin],firstLightDone:false},{DEV:true,VITE_PRODUCER_ENTRY_REVIEW:'1'});
    await page.getByRole('heading',{name:'Sign in to Producer',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.firstLightMounts??0),0);assert.equal(await page.getByRole('heading',{name:'Permissions setup'}).count(),0);
    assert.deepEqual(await page.evaluate(()=>window.fixture.endpoints),[boomin]);
    results.push('development entry review never mounts FirstLight even when setup was not marked complete');await page.close();
  }
  for(const scenario of [
    {label:'unknown bundle',env:{DEV:true,VITE_PRODUCER_ENTRY_REVIEW:'1'},appIdentifier:'ai.boomin.producer',identifierReads:1},
    {label:'production build',env:{DEV:false,VITE_PRODUCER_ENTRY_REVIEW:'1'},appIdentifier:'ai.boomin.producer.sets-v2-dev',identifierReads:0},
    {label:'missing DEV flag',env:{VITE_PRODUCER_ENTRY_REVIEW:'1'},appIdentifier:'ai.boomin.producer.sets-v2-dev',identifierReads:0},
  ]){
    const {page,errors}=await pageFor({endpoints:[boomin,owned],appIdentifier:scenario.appIdentifier},scenario.env);
    await page.getByRole('heading',{name:'Saved workspace Home'}).waitFor();
    assert.equal(await page.getByRole('heading',{name:'Sign in to Producer',exact:true}).count(),0);
    assert.equal(await page.getByRole('button',{name:'Back to studio',exact:true}).count(),0);
    assert.deepEqual(await page.evaluate(()=>window.fixture.endpoints),[boomin,owned]);
    assert.equal(await page.evaluate(()=>window.appIdentifierReads??0),scenario.identifierReads);
    assert.equal(await page.evaluate(()=>window.calls.some(call=>call.command==='ui_log')),false);
    assert.equal(await page.evaluate(()=>window.calls.every(call=>['list_endpoints','live_set_v2_smoke_enabled'].includes(call.command))),true);
    assert.deepEqual(errors,[]);results.push(`entry review flag is refused for ${scenario.label}; saved Home remains available`);await page.close();
  }
  console.log(`PASS: ${results.length} beta-entry cases using actual App and onboarding components; no real authentication, endpoint changes, devices or media.`);
  for(const result of results)console.log('PASS '+result);
}finally{await browser.close();}
