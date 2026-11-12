/** Real publisher dialog/editor entry and canonical validation. Endpoint IPC
 * and unrelated editor dialogs are isolated. No accounts, network, native
 * engine or devices. Assistant's Worker/preview has its own browser suite. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const root=fileURLToPath(new URL('../',import.meta.url));
const fakeIpc=`export const ipc={listEndpoints:async()=>window.endpoints,setLibraryList:async()=>[]};export const guests={request:(...args)=>window.request(...args)};`;
const bundle=await build({stdin:{resolveDir:root,loader:'tsx',contents:`
 import React from 'react';import {createRoot} from 'react-dom/client';
 import {SetConfiguration} from './src/features/presentation/SetConfiguration';
 import {PublishSetDialog} from './src/features/presentation/PublishSetDialog';
 import {RehearsalSession} from './src/features/presentation/rehearsal';
 import {parsePackage} from './src/features/presentation/schema';
 const doc=parsePackage({schema:'producer.presentation/2',id:'publication-test',version:'1',name:'Studio Set',set:{initialLayout:'landscape',values:{headline:{type:'text',default:'Original',maxLength:120}},feeds:{},slots:[],components:{},layouts:[{id:'landscape',label:'Landscape',width:1280,height:720,root:{id:'root',type:'box',styles:{position:'relative',width:1280,height:720},children:[{id:'title',type:'text',text:{get:'values.headline'}}]}}],controls:[]}});
 const session=new RehearsalSession(doc,undefined,'prepare');session.send({type:'field',key:'headline',value:'Configured publication caption'});
 window.session=session;const root=createRoot(document.getElementById('root'));
 window.mountEditor=()=>root.render(<div className="set-preview-dialog"><div className="set-preview-dialog-content"><SetConfiguration session={session} hideOutputAction onChange={()=>window.forbidden.push('onChange')} actions={<div className="set-editor-top-actions"><button type="button" onClick={()=>window.forbidden.push('rehearse')}>Rehearse</button><div className="set-editor-publish" role="group" aria-label="Room output"><span className="set-editor-apply-status changed">Changes not on output</span><button type="button" className="set-editor-apply" onClick={()=>window.forbidden.push('output')}>Show on output</button></div><button type="button" className="set-editor-close" onClick={()=>window.forbidden.push('close-editor')}>Close editor</button></div>}/></div></div>);
 window.mountDialog=(invalid=false)=>{const next=session.exportPreparedPackage();if(invalid)next.name='producer-media:12345678-1234-4234-8234-123456789012';root.render(<PublishSetDialog doc={next} endpointId="workspace-a" onClose={()=>{window.publicationClosed++;root.render(<p>Closed</p>);}}/>);};
 `},bundle:true,write:false,format:'iife',platform:'browser',define:{'import.meta.env.DEV':'false'},plugins:[{name:'publication-fixtures',setup(b){
 b.onResolve({filter:/\.css$/},()=>({path:'css',namespace:'fixture'}));
 b.onResolve({filter:/^@tauri-apps\/plugin-opener$/},()=>({path:'opener',namespace:'fixture'}));
 b.onResolve({filter:/\/lib\/ipc$/},()=>({path:'ipc',namespace:'fixture'}));
 b.onResolve({filter:/\/assistant\/SetAssistantDialog$/},()=>({path:'assistant',namespace:'fixture'}));
 b.onResolve({filter:/^\.\/(catalog|MediaAssetsDialog|PackageAuthoringDialog)$/},args=>args.importer===resolve(root,'src/features/presentation/SetConfiguration.tsx')?({path:args.path.slice(2),namespace:'fixture'}):undefined);
 b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path==='ipc'?fakeIpc:args.path==='opener'?'export async function openUrl(url){window.openedUrls.push(url);}':args.path==='assistant'?'export default function SetAssistantDialog(){window.forbidden.push("assistant");return null;}':args.path==='catalog'?'export const BUILTIN_SETS=[];':args.path==='css'?'':`export function ${args.path}(){return null;}`,loader:'js'}));
 }}]});
const playwright=process.env.PRODUCER_PLAYWRIGHT_MODULE;
const {chromium}=await import(playwright?(playwright.startsWith('file:')?playwright:pathToFileURL(resolve(playwright)).href):new URL('../tools/producer-mcp/node_modules/playwright-core/index.mjs',import.meta.url).href);
const browser=await chromium.launch({headless:true,...(process.env.PRODUCER_TEST_CHROME?{executablePath:process.env.PRODUCER_TEST_CHROME}:{channel:process.env.PRODUCER_BROWSER_CHANNEL??'chrome'})});
const checks=[];
async function fixture({rows=false,selfhost=false,editor=false,invalid=false,open=true,viewport={width:1000,height:800}}={}){
 const page=await browser.newPage({viewport});const errors=[],requests=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',route=>{requests.push(route.request().url());return route.request().url()==='https://publication-fixture.invalid/'?route.fulfill({contentType:'text/html',body:'<main id="root"></main>'}):route.abort();});
 await page.goto('https://publication-fixture.invalid/');
 await page.evaluate(({rows,selfhost})=>{
  localStorage.setItem('producer.workspace.v1','workspace-a');window.calls=[];window.forbidden=[];window.openedUrls=[];window.publicationClosed=0;window.uploadMode='ok';window.deferred=[];
  window.endpoints=[{id:'workspace-a',kind:selfhost?'independent':'connected',endpoint_kind:selfhost?'selfhost':'boomin',brand_slug:selfhost?null:'kleveland',name:'Kleveland',base_url:'https://api.boomin.ai/v1/app/producer'}];
  window.row={id:'publication-1',handle:'kleveland',slug:'studio-set',title:'Studio Set',description:'Saved description',status:'published',visibility:'public',revision:4,version:3,sha256:'a'.repeat(64),byte_length:1000,layout_count:1,orientations:['landscape']};window.rows=rows?[window.row]:[];
  window.confirm=()=>true;
  for(const method of ['getUserMedia','getDisplayMedia','enumerateDevices'])navigator.mediaDevices[method]=()=>{window.forbidden.push(method);return Promise.reject(Error('devices forbidden'));};
  window.request=async(endpoint,method,path,body)=>{
   window.calls.push({endpoint,method,path,body});
   if(method==='GET')return {available:true,status:200,body:path.endsWith('/profile')?{handle:'kleveland',name:'Kleveland',editable:true}:{publications:window.rows,limits:{package_bytes:8388608,thumbnail_bytes:524288}}};
   if(window.uploadMode==='fail'){window.uploadMode='ok';throw Error('PRIVATE_TOKEN_NOT_FOR_UI');}
   if(/^reject(?:400|422)$/.test(window.uploadMode)){const status=Number(window.uploadMode.slice(6));window.uploadMode='ok';return {available:true,status,body:{message:'PRIVATE_REJECTION'}};}
   const next={...window.row,title:body.title??window.row.title,description:body.description??window.row.description,visibility:body.visibility??window.row.visibility,status:body.status??(body.visibility==='private'?'draft':'published'),slug:body.slug??window.row.slug,revision:5,version:method==='PATCH'?3:4};window.rows=[next];
   if(window.uploadMode==='pending')return new Promise(resolve=>window.deferred.push(()=>resolve({available:true,status:200,body:{publication:next}})));
   return {available:true,status:200,body:{publication:next}};
  };
 },{rows,selfhost});
 await page.addStyleTag({content:':root{--h-ctl:36px;--line-1:#283541;--line-2:#34424d;--r-ctl:8px;--surface-1:#101923;--surface-2:#172633;--fg-1:#eef4f7;--fg-2:#aebdca}*{box-sizing:border-box}body{margin:0;background:#0a131c;color:#eef4f7;font:13px system-ui}button{font:inherit}'});
 await page.addStyleTag({content:await readFile(new URL('../src/features/presentation/presentation.css',import.meta.url),'utf8')});
 await page.addStyleTag({content:await readFile(new URL('../src/features/presentation/publication.css',import.meta.url),'utf8')});
 await page.addScriptTag({content:bundle.outputFiles[0].text});
 await page.evaluate(({editor,invalid})=>editor?window.mountEditor():window.mountDialog(invalid),{editor,invalid});
 if(editor){await page.getByRole('toolbar',{name:'Set configuration'}).waitFor();if(open)await page.getByRole('button',{name:'Publish to producer.dev',exact:true}).click();}
 if(open){await page.getByRole('dialog',{name:'Publish Set to producer.dev'}).waitFor();await page.getByRole('status').filter({hasText:'Loading your publications…'}).waitFor({state:'hidden'});}
 return {page,async close(){assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>window.forbidden),[]);assert(requests.every(url=>url==='https://publication-fixture.invalid/'));await page.close();}};
}
async function run(name,fn){await fn();checks.push(name);}
try{
 await run('visible Publish toolbar control supports keyboard entry and restores focus without room-output actions',async()=>{
  const h=await fixture({editor:true,open:false}),publish=h.page.getByRole('button',{name:'Publish to producer.dev',exact:true});
  assert.equal(await publish.innerText(),'Publish');assert.equal(await publish.getAttribute('title'),'Publish to producer.dev');assert.equal(await publish.getAttribute('aria-haspopup'),'dialog');
  await h.page.getByRole('button',{name:'Files ▾'}).focus();await h.page.keyboard.press('Tab');assert(await publish.evaluate(element=>document.activeElement===element));await h.page.keyboard.press('Enter');
  await h.page.getByRole('dialog',{name:'Publish Set to producer.dev'}).waitFor();await h.page.getByRole('status').filter({hasText:'Loading your publications…'}).waitFor({state:'hidden'});
  assert((await h.page.evaluate(()=>window.calls)).every(call=>call.method==='GET'));await h.page.keyboard.press('Escape');await h.page.getByRole('dialog',{name:'Publish Set to producer.dev'}).waitFor({state:'hidden'});assert(await publish.evaluate(element=>document.activeElement===element));await h.close();
 });
 await run('Files shortcut uses the same publication dialog and restores the visible Files trigger',async()=>{
  const h=await fixture({editor:true,open:false}),files=h.page.getByRole('button',{name:'Files ▾'});await files.click();await h.page.locator('.set-files-popover').getByRole('button',{name:'Publish to producer.dev',exact:true}).click();
  await h.page.getByRole('dialog',{name:'Publish Set to producer.dev'}).waitFor();await h.page.getByRole('status').filter({hasText:'Loading your publications…'}).waitFor({state:'hidden'});await h.page.getByRole('button',{name:'Close',exact:true}).click();
  await h.page.getByRole('dialog',{name:'Publish Set to producer.dev'}).waitFor({state:'hidden'});assert(await files.evaluate(element=>document.activeElement===element));await h.close();
 });
 await run('real toolbar CSS keeps Publish, output and Close editor visible without overlap at desktop and compact widths',async()=>{
  for(const width of [1280,960,640,390]){
   const h=await fixture({editor:true,open:false,viewport:{width,height:600}});
   const controls=await Promise.all(['Publish to producer.dev','Show on output','Close editor'].map(async name=>{const button=h.page.getByRole('button',{name,exact:true});assert(await button.isVisible());assert.equal(await button.isDisabled(),false);return button.boundingBox();}));
   for(const box of controls){assert(box);assert(box.x>=0&&box.y>=0&&box.x+box.width<=width&&box.y+box.height<=600,`control within ${width}px viewport`);}
   for(let a=0;a<controls.length;a++)for(let b=a+1;b<controls.length;b++){const x=controls[a],y=controls[b];assert(x.x+x.width<=y.x||y.x+y.width<=x.x||x.y+x.height<=y.y||y.y+y.height<=x.y,`controls do not overlap at ${width}px`);}
   assert.equal(await h.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.equal(await h.page.evaluate(()=>window.calls.length),0);await h.close();
  }
 });
 await run('actual editor entry snapshots configured values; private save never applies output or lists publicly',async()=>{
  const h=await fixture({editor:true});await h.page.getByRole('button',{name:'Save private Set',exact:true}).click();await h.page.getByRole('status').filter({hasText:'Private Set saved'}).waitFor();
  const write=await h.page.evaluate(()=>window.calls.find(call=>call.method==='POST'));assert.equal(write.endpoint,'workspace-a');assert.equal(write.path,'/v1/app/producer/v1/sets/publications');assert.equal(write.body.visibility,'private');assert(write.body.idempotency_key);
  assert.equal(JSON.parse(write.body.package_text).set.values.headline.default,'Configured publication caption');assert.equal(await h.page.getByRole('link',{name:'Download Set ↗'}).count(),0);assert.equal(await h.page.getByRole('button',{name:'Publish saved version'}).count(),1);await h.close();
 });
 await run('public upload requires confirmation; failed response keeps exact retry body/key and sanitizes errors',async()=>{
  const h=await fixture();await h.page.getByLabel('Visibility',{exact:true}).selectOption('public');assert(await h.page.getByRole('button',{name:'Publish Set',exact:true}).isDisabled());
  await h.page.getByRole('checkbox').check();await h.page.evaluate(()=>window.uploadMode='fail');await h.page.getByRole('button',{name:'Publish Set',exact:true}).click();await h.page.getByRole('button',{name:'Retry same request'}).waitFor();
  assert(await h.page.getByLabel('Title',{exact:true}).isDisabled());assert(await h.page.getByRole('button',{name:'Close',exact:true}).isDisabled());assert.doesNotMatch(await h.page.locator('body').innerText(),/PRIVATE_TOKEN/);
  await h.page.getByRole('button',{name:'Retry same request'}).click();await h.page.getByRole('status').filter({hasText:'Set published'}).waitFor();
  const writes=await h.page.evaluate(()=>window.calls.filter(call=>call.method==='POST'));assert.equal(writes.length,2);assert.deepEqual(writes[0],writes[1]);assert.equal(await h.page.getByRole('link',{name:'Download Set ↗'}).getAttribute('href'),'https://producer.dev/kleveland/set/studio-set/download');
  assert.deepEqual(await h.page.evaluate(()=>window.openedUrls),[]);await h.page.getByRole('link',{name:'View Set ↗'}).click();assert.deepEqual(await h.page.evaluate(()=>window.openedUrls),['https://producer.dev/kleveland/set/studio-set']);await h.close();
 });
 await run('new version and withdrawal carry the current publication revision and never create another slug',async()=>{
  const h=await fixture({rows:true});await h.page.getByLabel('Destination',{exact:true}).selectOption('publication-1');await h.page.getByRole('checkbox').check();await h.page.getByRole('button',{name:'Upload new version'}).click();await h.page.getByRole('status').filter({hasText:'Set published'}).waitFor();
  const write=await h.page.evaluate(()=>window.calls.find(call=>call.method==='POST'));assert.equal(write.path,'/v1/app/producer/v1/sets/publications/publication-1/versions');assert.equal(write.body.expected_revision,4);assert.equal(write.body.slug,undefined);
  await h.page.getByRole('button',{name:'Withdraw Set',exact:true}).click();await h.page.getByRole('status').filter({hasText:'Set withdrawn'}).waitFor();const patch=await h.page.evaluate(()=>window.calls.find(call=>call.method==='PATCH'));assert.equal(patch.body.expected_revision,5);assert.equal(patch.body.status,'withdrawn');assert(patch.body.idempotency_key);await h.close();
 });
 await run('private draft becomes public only after explicit saved-version publish and confirmation',async()=>{
  const h=await fixture();await h.page.getByRole('button',{name:'Save private Set'}).click();await h.page.getByRole('status').filter({hasText:'Private Set saved'}).waitFor();await h.page.getByLabel('Visibility',{exact:true}).selectOption('public');
  assert(await h.page.getByRole('button',{name:'Publish saved version'}).isDisabled());await h.page.getByRole('checkbox').check();await h.page.getByRole('button',{name:'Publish saved version'}).click();await h.page.getByRole('link',{name:'Download Set ↗'}).waitFor();
  const patch=await h.page.evaluate(()=>window.calls.find(call=>call.method==='PATCH'));assert.equal(patch.body.status,'published');assert.equal(patch.body.visibility,'public');assert.equal(patch.body.expected_revision,5);assert(patch.body.idempotency_key);await h.close();
 });
 await run('ambiguous withdrawal retry retains the same status operation and key',async()=>{
  const h=await fixture({rows:true});await h.page.getByLabel('Destination',{exact:true}).selectOption('publication-1');await h.page.evaluate(()=>window.uploadMode='fail');await h.page.getByRole('button',{name:'Withdraw Set',exact:true}).click();
  await h.page.getByRole('button',{name:'Retry same request'}).waitFor();assert(await h.page.getByRole('button',{name:'Close',exact:true}).isDisabled());await h.page.getByRole('button',{name:'Retry same request'}).click();await h.page.getByRole('status').filter({hasText:'Set withdrawn'}).waitFor();
  const writes=await h.page.evaluate(()=>window.calls.filter(call=>call.method==='PATCH'));assert.equal(writes.length,2);assert.deepEqual(writes[0],writes[1]);assert.equal(writes[0].body.expected_revision,4);assert(writes[0].body.idempotency_key);await h.close();
 });
 await run('workspace switch fences an old upload response and leaves an exit without cross-workspace writes',async()=>{
  const h=await fixture();await h.page.evaluate(()=>window.uploadMode='pending');await h.page.getByRole('button',{name:'Save private Set'}).click();
  await h.page.waitForFunction(()=>window.deferred.length===1);await h.page.evaluate(()=>{localStorage.setItem('producer.workspace.v1','workspace-b');window.dispatchEvent(new Event('producer:workspace'));window.deferred[0]();});
  await h.page.getByRole('alert').filter({hasText:'Workspace changed'}).waitFor();assert.equal(await h.page.getByRole('status').filter({hasText:'Set saved'}).count(),0);assert((await h.page.evaluate(()=>window.calls)).every(call=>call.endpoint==='workspace-a'));
  await h.page.getByRole('button',{name:'Close',exact:true}).click();assert.equal(await h.page.evaluate(()=>window.publicationClosed),1);await h.close();
 });
 await run('existing self-hosted workspace reports unavailable with no Boomin fallback requests',async()=>{
  const h=await fixture({selfhost:true});await h.page.getByRole('alert').filter({hasText:'not available'}).waitFor();assert.equal(await h.page.evaluate(()=>window.calls.length),0);await h.close();
 });
 await run('nonportable package and oversized preview cannot submit or start media',async()=>{
  const h=await fixture({invalid:true});await h.page.getByRole('alert').filter({hasText:'cannot be published'}).waitFor();assert(await h.page.getByRole('button',{name:'Save private Set'}).isDisabled());assert((await h.page.evaluate(()=>window.calls)).every(call=>call.method==='GET'));await h.close();
  const valid=await fixture();await valid.page.getByLabel('Choose preview image (optional)').setInputFiles({name:'large.png',mimeType:'image/png',buffer:Buffer.alloc(524289)});await valid.page.getByRole('alert').filter({hasText:'up to 512 KiB'}).waitFor();assert((await valid.page.evaluate(()=>window.calls)).every(call=>call.method==='GET'));await valid.close();
 });
 await run('description2001 is blocked with feedback/noPOST;2000 remains admissible',async()=>{
  const h=await fixture();assert.equal(await h.page.getByLabel('Description',{exact:true}).getAttribute('maxlength'),'2000');
  await h.page.evaluate(()=>{const input=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'d'.repeat(2001));input.dispatchEvent(new Event('input',{bubbles:true}));});
  await h.page.getByRole('alert').filter({hasText:'Description must be 2,000'}).waitFor();assert(await h.page.getByRole('button',{name:'Save private Set'}).isDisabled());
  await h.page.locator('form').dispatchEvent('submit');assert((await h.page.evaluate(()=>window.calls)).every(call=>call.method==='GET'));
  await h.page.getByLabel('Description',{exact:true}).fill('d'.repeat(2000));assert.equal(await h.page.getByRole('button',{name:'Save private Set'}).isDisabled(),false);await h.close();
 });
 for(const status of [400,422])await run(`known${status} rejection allows correction without an ambiguous retry lock`,async()=>{
  const h=await fixture();await h.page.evaluate(status=>window.uploadMode='reject'+status,status);await h.page.getByRole('button',{name:'Save private Set'}).click();
  await h.page.getByRole('alert').filter({hasText:'The request was rejected'}).waitFor();assert.equal(await h.page.getByRole('button',{name:'Retry same request'}).count(),0);assert.equal(await h.page.getByLabel('Title',{exact:true}).isDisabled(),false);assert.equal(await h.page.getByRole('button',{name:'Close',exact:true}).isDisabled(),false);
  assert.doesNotMatch(await h.page.locator('body').innerText(),/PRIVATE_REJECTION/);await h.page.getByLabel('Title',{exact:true}).fill('Corrected title');await h.page.getByRole('button',{name:'Save private Set'}).click();await h.page.getByRole('status').filter({hasText:'Private Set saved'}).waitFor();
  const writes=await h.page.evaluate(()=>window.calls.filter(call=>call.method==='POST'));assert.equal(writes.length,2);assert.notEqual(writes[0].body.idempotency_key,writes[1].body.idempotency_key);await h.close();
 });
 console.log(`PASS ${checks.length} real publication/editor browser cases (fake endpoint IPC only; no devices, output or real publication).`);for(const name of checks)console.log('PASS '+name);
}finally{await browser.close();}
