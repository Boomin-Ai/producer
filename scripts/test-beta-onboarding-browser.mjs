// Exercise App routing and the actual Onboarding/SignIn/ModLinkDrop components.
// Home, native IPC, permission UI and media seats are controlled test seams.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

const root=resolve(fileURLToPath(new URL('../',import.meta.url)));
const mocks={
  nativeInvoke:`export const invoke=(command,args)=>window.testInvoke(command,args);`,
  workspace:`export const setActiveEndpointId=id=>{window.activeEndpoint=id;};`,
  Home:`import React from 'react';export function Home(props){window.homeProps=props;return <section><h1>Saved workspace Home</h1><output>{props.endpoints.map(e=>e.id).join(',')}</output><button onClick={()=>props.onAddEndpoint('server')}>Connect a server</button><button onClick={()=>props.onAddEndpoint()}>Add workspace</button><button onClick={props.onSignOut}>Sign out</button></section>;}`,
  FirstLight:`import React from 'react';export const firstLightDone=()=>window.fixture.firstLightDone;export function FirstLight({onDone}){return <section><h1>Permissions setup</h1><button onClick={onDone}>Continue permissions</button></section>;}`,
  ModSeat:`import React from 'react';export function ModSeat({link,onLeave}){window.openedMod=link;return <section><h1>Invitation control seat</h1><button onClick={onLeave}>Leave invitation</button></section>;}`,
  SetsDevelopmentRoom:`import React from 'react';export const SetsDevelopmentRoom=()=> <h1>Unexpected development room</h1>;`,
  opener:`export const openUrl=async url=>{window.openedUrls.push(url);};`,
};
const bundle=await build({
  stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import App from './src/App';import {Onboarding} from './src/views/Onboarding';const root=createRoot(document.getElementById('root'));window.renderDirect=props=>root.render(<Onboarding {...props} onConnected={()=>{}}/>);root.render(<App/>);`,resolveDir:root,loader:'tsx'},
  bundle:true,write:false,format:'iife',platform:'browser',define:{'import.meta.env':'{}'},
  plugins:[{name:'beta-entry-fixture',setup(b){
    b.onResolve({filter:/\.css$/},()=>({path:'css',namespace:'mock'}));
    b.onResolve({filter:/nativeInvoke|lib\/workspace|views\/(Home|FirstLight|ModSeat|SetsDevelopmentRoom)$|plugin-opener/},args=>{
      const key=args.path.endsWith('plugin-opener')?'opener':Object.keys(mocks).find(key=>args.path.endsWith('/'+key));
      return key?{path:key,namespace:'mock'}:undefined;
    });
    b.onLoad({filter:/.*/,namespace:'mock'},args=>({contents:args.path==='css'?'':mocks[args.path],loader:'tsx',resolveDir:root}));
  }}],
});
const module=process.env.PRODUCER_PLAYWRIGHT_MODULE;
const {chromium}=await import(module?(module.startsWith('file:')?module:pathToFileURL(resolve(module)).href):new URL('../tools/producer-mcp/node_modules/playwright-core/index.mjs',import.meta.url).href);
const browser=await chromium.launch({headless:true,...(process.env.PRODUCER_TEST_CHROME?{executablePath:process.env.PRODUCER_TEST_CHROME}:{channel:process.env.PRODUCER_BROWSER_CHANNEL??'chrome'})});
const boomin={id:'brand',kind:'connected',name:'Boomin brand',brand_slug:'beta',base_url:'https://api.example.test'};
const owned={id:'owned',kind:'independent',name:'Existing server',base_url:'https://owned.example.test'};
const results=[];
async function pageFor(options={}){
  const page=await browser.newPage();page.setDefaultTimeout(8000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setContent('<div id="root"></div>');
  await page.evaluate(options=>{
    window.fixture={endpoints:[],firstLightDone:true,...options};window.calls=[];window.openedUrls=[];
    if(window.fixture.native!==false)window.__TAURI_INTERNALS__={};
    const values=new Map(window.fixture.returning?[['producer.signedin.v1','1']]:[]);
    Object.defineProperty(window,'localStorage',{value:{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key)},configurable:true});
    window.testInvoke=async(command,args)=>{
      window.calls.push({command,args});const f=window.fixture;
      if(command==='live_set_v2_smoke_enabled')return false;
      if(command==='list_endpoints'){if(f.listError)throw Error('Endpoint storage unavailable');return [...f.endpoints];}
      if(command==='boomin_request_otp')return {};
      if(command==='boomin_connect'){
        if(f.connectError)throw Error('Test verification failed');
        if(f.noBrands)throw Error('this account has no workspace yet — create one in the Boomin web app first');
        if(f.multipleBrands)return {needs_brand:true,brands:[{slug:'first',name:'First brand'},{slug:'second',name:'Second brand'}]};
        f.endpoints.push({id:'connected-beta',kind:'connected',name:'Beta account',base_url:'https://api.example.test'});return {id:'connected-beta'};
      }
      if(command==='boomin_select_brand'){const id='brand-'+args.brandSlug;f.endpoints.push({id,kind:'connected',name:args.brandSlug,base_url:'https://api.example.test'});return {id};}
      if(command==='network_status')return {membership:f.membership==='new'?null:{status:'active'}};
      if(command==='network_join')return {joined:true};
      if(command==='add_endpoint'){f.endpoints.push({id:'added-owned',kind:'independent',name:args.name,base_url:args.baseUrl});return {id:'added-owned'};}
      if(command==='remove_endpoint'){f.endpoints=f.endpoints.filter(e=>e.id!==args.endpointId);return;}
      throw Error('Unexpected test IPC: '+command);
    };
  },options);
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  return {page,errors};
}
async function noInitialServer(page){
  assert.equal(await page.getByText('Use my own server',{exact:true}).count(),0);
  assert.equal(await page.getByText('Use your own server',{exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:/Advanced|Connect my server|Self-hosting guide/}).count(),0);
  assert.equal(await page.getByLabel('Server URL',{exact:true}).count(),0);
  assert.equal(await page.getByLabel('API root (advanced)',{exact:true}).count(),0);
}
async function codeStep(page){
  await page.getByLabel('Email',{exact:true}).fill('creator@example.test');
  await page.getByRole('button',{name:'Email me a code',exact:true}).click();
  await page.getByLabel('Sign-in code',{exact:true}).fill('000000');
}
try{
  for(const returning of [false,true]){
    const {page,errors}=await pageFor({returning});
    await page.getByRole('heading',{name:returning?'Welcome back.':'Start with Boomin.',exact:true}).waitFor();
    await page.getByText('New installations require a Boomin account during the beta.',{exact:false}).waitFor();await noInitialServer(page);
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
    else{await page.getByRole('heading',{name:'Welcome back.',exact:true}).waitFor();await noInitialServer(page);}
    assert.deepEqual(await page.evaluate(()=>window.calls.filter(c=>c.command==='remove_endpoint').map(c=>c.args.endpointId)),['brand']);results.push(keepOwned?'Boomin sign-out preserves existing owned-server Home':'last Boomin sign-out returns to beta sign-in');await page.close();
  }
  {
    const {page}=await pageFor({membership:'new'});await page.getByRole('heading',{name:'Start with Boomin.'}).waitFor();await codeStep(page);
    await page.getByRole('button',{name:'Back',exact:true}).click();await noInitialServer(page);await page.getByRole('button',{name:'Email me a code',exact:true}).click();await page.getByLabel('Sign-in code',{exact:true}).fill('000000');
    await page.getByRole('button',{name:'Verify & connect',exact:true}).click();await page.getByRole('heading',{name:'Join the Brand Network?',exact:true}).waitFor();
    await page.getByRole('button',{name:'Continue',exact:true}).click();await page.getByRole('heading',{name:'Saved workspace Home'}).waitFor();
    assert.equal(await page.evaluate(()=>window.calls.some(c=>c.command==='network_join')),false);
    assert.equal(await page.evaluate(()=>window.calls.filter(c=>['boomin_request_otp','boomin_connect'].includes(c.command)).every(c=>c.args.apiRoot===null)),true);
    assert.equal(await page.evaluate(()=>window.activeEndpoint),'connected-beta');results.push('email/code connects through default Boomin API; network opt-in stays optional and off');await page.close();
  }
  {
    const {page}=await pageFor({multipleBrands:true});await page.getByRole('heading',{name:'Start with Boomin.'}).waitFor();await codeStep(page);await page.getByRole('button',{name:'Verify & connect',exact:true}).click();
    await page.getByRole('heading',{name:'Which workspace?',exact:true}).waitFor();await page.getByRole('button',{name:'Use a different email',exact:true}).waitFor();await noInitialServer(page);
    await page.getByRole('button',{name:'First brand',exact:false}).click();await page.getByRole('heading',{name:'Saved workspace Home'}).waitFor();assert.equal(await page.evaluate(()=>window.activeEndpoint),'brand-first');results.push('multi-brand beta sign-in keeps the workspace selection path');await page.close();
  }
  {
    const {page}=await pageFor();await page.getByRole('heading',{name:'Start with Boomin.'}).waitFor();await page.evaluate(()=>window.renderDirect({start:'server',allowServerConnection:false}));await page.getByRole('heading',{name:'Start with Boomin.'}).waitFor();await noInitialServer(page);results.push('stale/direct server start cannot bypass fresh-primary requirement');await page.close();
  }
  {
    const {page}=await pageFor();await page.getByRole('heading',{name:'Start with Boomin.'}).waitFor();await page.evaluate(()=>window.renderDirect({allowServerConnection:true}));await page.getByRole('button',{name:'Sign in with email',exact:true}).click();await page.getByRole('button',{name:'Advanced: custom API root',exact:true}).click();await page.getByLabel('API root (advanced)',{exact:true}).fill('https://custom.example.test');
    await page.evaluate(()=>window.renderDirect({allowServerConnection:false}));await page.getByRole('heading',{name:'Start with Boomin.'}).waitFor();await noInitialServer(page);await codeStep(page);await page.getByRole('button',{name:'Verify & connect',exact:true}).click();await page.waitForFunction(()=>window.calls.some(c=>c.command==='boomin_connect'));assert.equal(await page.evaluate(()=>window.calls.filter(c=>['boomin_request_otp','boomin_connect'].includes(c.command)).every(c=>c.args.apiRoot===null)),true);results.push('beta entry ignores a retained custom API root after permission changes');await page.close();
  }
  {
    const {page}=await pageFor({noBrands:true});await page.getByRole('heading',{name:'Start with Boomin.'}).waitFor();await codeStep(page);await page.getByRole('button',{name:'Verify & connect',exact:true}).click();
    await page.getByText('this account has no workspace yet — create one in the Boomin web app first',{exact:false}).waitFor();await noInitialServer(page);
    assert.equal(await page.evaluate(()=>window.fixture.endpoints.length),0);assert.equal(await page.getByRole('heading',{name:'Saved workspace Home'}).count(),0);
    await page.getByRole('button',{name:'Create a Boomin account',exact:false}).click();assert.deepEqual(await page.evaluate(()=>window.openedUrls),['https://boomin.ai/signup']);
    await page.getByRole('button',{name:'Back',exact:true}).click();await page.getByLabel('Email',{exact:true}).fill('other@example.test');results.push('workspace-less account stays at sign-in with an explicit Boomin account/workspace recovery link');await page.close();
  }
  {
    const {page}=await pageFor({listError:true});await page.getByRole('heading',{name:'Start with Boomin.'}).waitFor();await noInitialServer(page);results.push('endpoint lookup failure keeps beta entry closed to new owned-server registration');await page.close();
  }
  {
    const {page}=await pageFor({firstLightDone:false,endpoints:[owned]});await page.getByRole('heading',{name:'Permissions setup'}).waitFor();await page.getByRole('button',{name:'Continue permissions'}).click();await page.getByRole('heading',{name:'Saved workspace Home'}).waitFor();results.push('FirstLight remains ahead of normal routing');await page.close();
  }
  {
    const {page}=await pageFor();await page.getByRole('heading',{name:'Start with Boomin.'}).waitFor();await page.getByRole('button',{name:'Open a mod link',exact:false}).click();await page.getByLabel('Mod link',{exact:true}).fill('https://host.example.test/connect/mod/gm_synthetic_invitation');await page.getByLabel('Mod link',{exact:true}).press('Enter');
    await page.getByRole('heading',{name:'Invitation control seat'}).waitFor();assert.equal(await page.evaluate(()=>window.openedMod.origin),'https://host.example.test');assert.equal(await page.evaluate(()=>window.fixture.endpoints.length),0);
    await page.getByRole('button',{name:'Leave invitation'}).click();await page.getByRole('heading',{name:'Start with Boomin.'}).waitFor();await noInitialServer(page);results.push('capability-based mod invitation still opens and returns without creating an account/workspace');await page.close();
  }
  {
    const {page}=await pageFor({native:false});await page.getByRole('heading',{name:'Start with Boomin.'}).waitFor();assert(await page.getByRole('button',{name:'Open the desktop app',exact:true}).isDisabled());await noInitialServer(page);assert.equal(await page.evaluate(()=>window.calls.length),0);results.push('browser preview stays static without a native bridge');await page.close();
  }
  console.log(`PASS: ${results.length} beta-entry cases using actual App and onboarding components; no real authentication, endpoint changes, devices or media.`);
  for(const result of results)console.log('PASS '+result);
}finally{await browser.close();}
