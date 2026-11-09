import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const directory=await mkdtemp(join(tmpdir(),'producer-public-mcp-'));
const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('./server.mjs',import.meta.url))],env:{...process.env,PRODUCER_SETS_DIR:directory,PRODUCER_ENABLE_PUBLISH:'1',PRODUCER_PUBLISH_CONFIG:join(directory,'no-login.json')},stderr:'pipe'});
const client=new Client({name:'producer-publication-test',version:'1.0.0'});
try {
 await writeFile(join(directory,'atmosphere.set.json'),await readFile('docs/shows/atmosphere.json'));
 await client.connect(transport);
 const tools=(await client.listTools()).tools;
 assert.equal(tools.length,15);
 for(const name of ['producer_list_publications','producer_publish_set','producer_withdraw_set']) assert.equal(tools.find(tool=>tool.name===name).annotations.openWorldHint,true);
 const capabilities=JSON.parse((await client.callTool({name:'producer_capabilities',arguments:{}})).content[0].text);
 assert.equal(capabilities.publishing.enabled,true);
 const invalid=await client.callTool({name:'producer_publish_set',arguments:{file:'atmosphere.set.json',workspace:'kleveland',slug:'atmosphere',visibility:'public',idempotencyKey:'11111111-1111-4111-8111-111111111111'}});
 assert.equal(invalid.isError,true); assert.match(invalid.content[0].text,/Confirm/);
 const noLogin=await client.callTool({name:'producer_publish_set',arguments:{file:'atmosphere.set.json',workspace:'kleveland',slug:'atmosphere',visibility:'private',idempotencyKey:'11111111-1111-4111-8111-111111111111'}});
 assert.equal(noLogin.isError,true); // no login is never a successful publication
 const poster=JSON.parse((await client.callTool({name:'producer_preview_set',arguments:{file:'atmosphere.set.json',exportThumbnail:true}})).content[0].text);
 assert.equal(poster.outputChanged,false);assert.match(poster.thumbnail,/^poster-[a-f0-9-]+\.jpg$/);
 const bytes=await readFile(poster.thumbnailPath);assert(bytes.length>10000&&bytes.length<=524288);assert.equal(bytes[0],255);assert.equal(bytes[1],216);
 console.log('PASS: opt-in publishing tools, external-action annotations, explicit public consent before login, truthful missing-credential failure and real isolated JPEG poster through stdio MCP.');
} finally { await client.close();await rm(directory,{recursive:true,force:true}); }
