import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import plan from './fixtures/ai-engineering-essentials.mjs';
const out=fileURLToPath(new URL('../../target/ai-engineering-essentials/',import.meta.url));await mkdir(out,{recursive:true});
const client=new Client({name:'ai-engineering-essentials',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('./server.mjs',import.meta.url))],stderr:'pipe'});
const call=async(name,args={})=>{const r=await client.callTool({name,arguments:args});if(r.isError)throw Error(r.content[0]?.text);return JSON.parse(r.content[0].text);};
try{
 await client.connect(transport);await writeFile(out+'capabilities.json',JSON.stringify(await call('producer_capabilities'),null,2));
 await writeFile(out+'plan.json',JSON.stringify(plan,null,2));let saved;
 if(process.argv.includes('--edit')){const old=JSON.parse(await readFile(out+'compiled.json','utf8')),current=await call('producer_inspect_set',{file:old.file});saved=await call('producer_edit_set',{file:old.file,edit:{schema:'producer.set-edit/2',baseRevision:current.revision,operations:[{op:'replace',path:'/set/layouts',value:plan.package.set.layouts},{op:'replace',path:'/set/values',value:plan.package.set.values}]}});}
 else saved=await call('producer_compile_set',{plan,assetsFrom:'ai-engineering-brand-assets.set.json'});
 await writeFile(out+'compiled.json',JSON.stringify(saved,null,2));const preview=await call('producer_preview_set',{file:saved.file});await writeFile(out+'result.json',JSON.stringify({...saved,preview},null,2));
 const visual=await call('producer_visual_check',{file:saved.file});await writeFile(out+'visual.json',JSON.stringify(visual,null,2));await writeFile(out+'result.json',JSON.stringify({...saved,preview,visual},null,2));console.log(JSON.stringify({file:saved.path,preview:preview.path,issues:visual.issues},null,2));
}finally{await client.close();await transport.close();}
