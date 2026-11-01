import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,symlink,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const directory=await mkdtemp(join(tmpdir(),'producer-mcp-'));
const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('./server.mjs',import.meta.url))],env:{...process.env,PRODUCER_SETS_DIR:directory},stderr:'pipe'});
const client=new Client({name:'producer-acceptance',version:'1.0.0'});
let diagnostics='';transport.stderr?.on('data',data=>diagnostics+=data);
async function call(name,args={}){const result=await client.callTool({name,arguments:args});assert(!result.isError,result.content[0]?.text);return JSON.parse(result.content[0].text);}
async function rejected(name,args){const result=await client.callTool({name,arguments:args});assert.equal(result.isError,true);}
try {
 await client.connect(transport);
 assert.equal((await client.listTools()).tools.length,10);
 const capabilities=await call('producer_capabilities');assert.equal(capabilities.nativeReadiness,'not-tested');
 const guide=await client.readResource({uri:'producer://authoring/guide'});assert.match(guide.contents[0].text,/producer.design-plan/);
 const schema=await client.readResource({uri:'producer://authoring/schema'});assert.equal(JSON.parse(schema.contents[0].text).type,'object');
 const plan={schema:'producer.design-plan/1',id:'magazine',name:'Magazine',background:'#fff5db',layouts:['landscape','portrait'].map(orientation=>({id:orientation,name:orientation,orientation,elements:[{id:'title',kind:'text',bounds:[40,30,950,110],text:'ATTN IS CURRENCY',color:'#000000',size:64},{id:'host',kind:'camera',bounds:[90,220,760,760],slot:'host',radius:380},{id:'voice',kind:'effect',bounds:[40,170,860,860],effect:'voiceRing',radius:380}]}))};
 const saved=await call('producer_compile_set',{plan});assert.equal(saved.layouts.length,2);
 const original=await readFile(saved.path,'utf8');
 const inspected=await call('producer_inspect_set',{file:saved.file});assert.equal(inspected.revision,saved.revision);
 const edit={schema:'producer.set-edit/1',baseRevision:inspected.revision,operations:[{op:'text',layout:'landscape',node:'title',text:'MONEY / CULTURE / MUSIC'}]};
 const edited=await call('producer_edit_set',{file:saved.file,edit});assert.notEqual(edited.file,saved.file);assert.equal(await readFile(saved.path,'utf8'),original);
 assert((await call('producer_validate_set',{file:edited.file})).ok);
 const geometry=await call('producer_check_geometry',{file:edited.file});assert(geometry.issues.some(i=>i.code==='ring_padding'));
 const repair=await call('producer_repair_ring',{file:edited.file,baseRevision:edited.revision,layout:'landscape',ring:'voice',camera:'host'});
 const repairedGeometry=await call('producer_check_geometry',{file:repair.file});assert(!repairedGeometry.issues.some(i=>i.layout==='landscape'&&i.code.startsWith('ring_')));
 const visual=await call('producer_visual_check',{file:repair.file});assert.equal(visual.textChecked,true);assert.equal(visual.revision,repair.revision);assert.equal(visual.nativeReadiness,'not-tested');
 await rejected('producer_repair_ring',{file:repair.file,baseRevision:edited.revision,layout:'landscape',ring:'voice',camera:'host'});
 await rejected('producer_edit_set',{file:edited.file,edit});
 const bad=structuredClone(plan);bad.layouts[0].elements[0].bounds=[1900,0,500,100];
 const before=await readdir(directory);await rejected('producer_compile_set',{plan:bad});assert.deepEqual(await readdir(directory),before);
 await rejected('producer_validate_set',{file:'../escape.set.json'});
 await symlink(saved.path,join(directory,'link.set.json'));await rejected('producer_validate_set',{file:'link.set.json'});
 await writeFile(join(directory,'invalid.set.json'),'{}');await rejected('producer_validate_set',{file:'invalid.set.json'});
 const road=await readFile(new URL('../../docs/shows/road-to-v1.json',import.meta.url),'utf8');await writeFile(join(directory,'road.set.json'),road);
 const roadContext=await call('producer_inspect_set',{file:'road.set.json'});assert(!JSON.stringify(roadContext).includes('base64,'));
 const roadDraft=await call('producer_edit_set',{file:'road.set.json',edit:{schema:'producer.set-edit/1',baseRevision:roadContext.revision,operations:[{op:'duplicate-layout',layout:'sea-landscape',id:'mcp-variant',name:'MCP variant'}]}});
 assert.deepEqual(JSON.parse(await readFile(roadDraft.path,'utf8')).set.assets,JSON.parse(road).set.assets);
 const preview=await call('producer_preview_set',{file:edited.file});assert.equal(preview.outputChanged,false);assert.match(await readFile(preview.path,'utf8'),/Browser preview only/);
 // Exercise the real renderer, including switching aspect ratio and hostile text escaping.
 if(process.env.PRODUCER_PLAYWRIGHT_MODULE){
  const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE);
  const browser=await chromium.launch({executablePath:process.env.PRODUCER_CHROME??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  try{
   const page=await browser.newPage({viewport:{width:1200,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto('file://'+preview.path);
   await page.frameLocator('.set-preview iframe').getByText('MONEY / CULTURE / MUSIC',{exact:true}).waitFor();
   await page.locator('#layouts').selectOption('portrait');
   await page.frameLocator('.set-preview iframe').getByText('ATTN IS CURRENCY',{exact:true}).waitFor();
   assert.deepEqual(errors,[]);
   const unsafe=structuredClone(plan);unsafe.layouts[0].elements[0].text='</script><script>window.__escaped=true</script>';
   const draft=await call('producer_compile_set',{plan:unsafe});const html=await call('producer_preview_set',{file:draft.file});await page.goto('file://'+html.path);
   await page.locator('.set-preview iframe').waitFor();assert.equal(await page.evaluate(()=>window.__escaped),undefined);
  }finally{await browser.close();}
 }
 assert.equal(diagnostics,'');
 console.log('PASS: real stdio MCP discovery, compiler, fenced edits, validation, immutable originals, bounded file access, browser previews and resource contract.');
}finally{await client.close();await rm(directory,{recursive:true,force:true});}
