import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import authoredPlan from './fixtures/compute-atlas.mjs';
const out=fileURLToPath(new URL('../../target/compute-atlas/',import.meta.url));await mkdir(out,{recursive:true});
await writeFile(out+'plan.json',JSON.stringify(authoredPlan,null,2));
const client=new Client({name:'atlantium-compute-atlas',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('./server.mjs',import.meta.url))],stderr:'pipe'});
const call=async(name,args={})=>{const r=await client.callTool({name,arguments:args});if(r.isError)throw Error(r.content[0]?.text);return JSON.parse(r.content[0].text);};
try{
 await client.connect(transport);
 const cap=await call('producer_capabilities');await writeFile(out+'capabilities.json',JSON.stringify(cap,null,2));
 if(process.argv.includes('--discover')){
  for(const section of ['node','runtime','animation'])await writeFile(out+'schema-'+section+'.json',JSON.stringify(await call('producer_schema',{section}),null,2));
  const base=await call('producer_inspect_set',{file:'Atlantium-Atlanta-Capacity-35-Second-Cut.set.json'});
  await writeFile(out+'assets-context.json',JSON.stringify({revision:base.revision,assets:base.context.set.assets},null,2));
  console.log('MCP catalog discovered:',cap.catalog.revision,'features:',cap.target.features.length);
 }else{
  let saved;
  if(process.argv.includes('--edit')){
   const previous=JSON.parse(await readFile(out+'compiled.json','utf8'));
   const current=await call('producer_inspect_set',{file:previous.file});
   const plan=JSON.parse(await readFile(out+'plan.json','utf8'));
   saved=await call('producer_edit_set',{file:previous.file,edit:{schema:'producer.set-edit/2',baseRevision:current.revision,operations:[{op:'replace',path:'/set/layouts',value:plan.package.set.layouts},{op:'replace',path:'/set/values',value:plan.package.set.values}]}});
   await writeFile(out+'compiled.json',JSON.stringify(saved,null,2));
  }else if(process.argv.includes('--review'))saved=JSON.parse(await readFile(out+'compiled.json','utf8'));
  else{const plan=JSON.parse(await readFile(out+'plan.json','utf8'));saved=await call('producer_compile_set',{plan,assetsFrom:'Atlantium-Atlanta-Capacity-35-Second-Cut.set.json'});await writeFile(out+'compiled.json',JSON.stringify(saved,null,2));}
  const preview=await call('producer_preview_set',{file:saved.file});
  const requirements=await call('producer_requirements',{file:saved.file});
  await writeFile(out+'result.json',JSON.stringify({...saved,preview,requirements},null,2));
  console.log('Preview:',preview.path);
  const visual=await call('producer_visual_check',{file:saved.file});
  await writeFile(out+'visual.json',JSON.stringify(visual,null,2));
  await writeFile(out+'result.json',JSON.stringify({...saved,preview,requirements,visual},null,2));
  console.log(JSON.stringify({file:saved.file,preview:preview.path,issues:visual.issues},null,2));
 }
}finally{await client.close();await transport.close();}
