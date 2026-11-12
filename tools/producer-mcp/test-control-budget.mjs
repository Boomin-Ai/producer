import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

// Exercise the actual external tool contract independently of browser rendering.
const directory=await mkdtemp(join(tmpdir(),'producer-mcp-controls-'));
const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('./server.mjs',import.meta.url))],env:{...process.env,PRODUCER_SETS_DIR:directory},stderr:'pipe'});
const client=new Client({name:'producer-controls-acceptance',version:'1.0.0'});
let diagnostics='';transport.stderr?.on('data',data=>diagnostics+=data);
async function call(name,args={}){const response=await client.callTool({name,arguments:args});assert(!response.isError,`${name}: ${response.content[0]?.text}`);return JSON.parse(response.content[0].text);}
try{
 await client.connect(transport);
 const capabilities=await call('producer_capabilities');assert.equal(capabilities.catalog.limits.controls,128);
 const schema=await client.readResource({uri:'producer://authoring/schema'});assert.equal(JSON.parse(schema.contents[0].text).properties.set.properties.controls.maxItems,128);
 const original=await readFile(new URL('../../docs/shows/classic.json',import.meta.url),'utf8');
 await writeFile(join(directory,'classic.set.json'),original);
 const inspected=await call('producer_inspect_set',{file:'classic.set.json'});assert.equal(inspected.controlBudget.used,40);assert.equal(inspected.controlBudget.remaining,88);
 const pink={id:'pink',type:'button',label:'Pink accent',action:{type:'value.set',key:'glowColor',value:'#F4A6CD'}};
 const section=inspected.context.set.controlArrangement.sections.findIndex(s=>s.id==='look');
 const saved=await call('producer_edit_set',{file:'classic.set.json',edit:{schema:'producer.set-edit/2',baseRevision:inspected.revision,operations:[{op:'add',path:'/set/controls/-',value:pink},{op:'add',path:`/set/controlArrangement/sections/${section}/controls/-`,value:'set:pink'}]}});
 assert.equal(saved.controlBudget.used,41);assert.equal(saved.controlBudget.remaining,87);assert.equal(saved.outputChanged,false);
 const fresh=await call('producer_inspect_set',{file:saved.file});assert.equal(fresh.revision,saved.revision);assert.deepEqual(fresh.controlBudget,saved.controlBudget);
 const candidate=JSON.parse(await readFile(saved.path,'utf8'));assert.deepEqual(candidate.set.controls.pop(),pink);assert.equal(candidate.set.controlArrangement.sections[section].controls.pop(),'set:pink');
 assert.deepEqual(candidate,JSON.parse(original),'MCP preserves Silver, Mint and every unrelated authored value');
 const full=JSON.parse(original);while(full.set.controls.length<128)full.set.controls.push({...pink,id:'extra-'+full.set.controls.length});
 await writeFile(join(directory,'full.set.json'),JSON.stringify(full));
 const fullState=await call('producer_inspect_set',{file:'full.set.json'});assert.equal(fullState.controlBudget.remaining,0);
 const before=await readdir(directory);
 const rejected=await client.callTool({name:'producer_edit_set',arguments:{file:'full.set.json',edit:{schema:'producer.set-edit/2',baseRevision:fullState.revision,operations:[{op:'add',path:'/set/controls/-',value:pink}]}}});
 assert.equal(rejected.isError,true);assert.match(rejected.content[0].text,/Set control budget exceeded: 129\/128/);assert.deepEqual(await readdir(directory),before,'rejection never saves a partial package');
 assert.equal(await readFile(join(directory,'classic.set.json'),'utf8'),original);assert.equal(diagnostics,'');
 console.log('PASS MCP control budget: real stdio discovery/schema, Classic Pink edit preserving Mint/Silver, fresh 41/128 capacity, 128 accepted, 129 rejected without files or output changes.');
}finally{await client.close();await rm(directory,{recursive:true,force:true});}
