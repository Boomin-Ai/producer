import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {homedir} from 'node:os';
import scenarios from './fixtures/prompt-acceptance.mjs';
import assert from 'node:assert/strict';
const scenarioArg=process.argv.indexOf('--scenario');
const only=scenarioArg<0?null:process.argv[scenarioArg+1];
if(scenarioArg>=0&&!scenarios.some(s=>(s.plan.package?.id??s.plan.id)===only))throw Error('Unknown acceptance scenario.');
const out=fileURLToPath(new URL('../../target/prompt-acceptance/',import.meta.url));await mkdir(out,{recursive:true});
const directory=join(homedir(),'Documents/Producer Sets');
const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('./server.mjs',import.meta.url))],env:{...process.env,PRODUCER_SETS_DIR:directory},stderr:'pipe'});
const client=new Client({name:'producer-prompt-acceptance',version:'1.0.0'});
export async function call(name,args={}){const result=await client.callTool({name,arguments:args});if(result.isError)throw Error(result.content[0]?.text);return JSON.parse(result.content[0].text);}
try{
 await client.connect(transport);
 const capabilities=await call('producer_capabilities');await writeFile(join(out,'capabilities.json'),JSON.stringify(capabilities,null,2));
 if(process.argv.includes('--discover')){
  for(const section of ['node','runtime','animation','integrations'])await writeFile(join(out,'schema-'+section+'.json'),JSON.stringify(await call('producer_schema',{section}),null,2));
  console.log(JSON.stringify({catalogRevision:capabilities.catalog.revision,features:capabilities.target.features,plans:capabilities.catalog.acceptedPlanSchemas}));
 }else{
  const results=only?JSON.parse(await readFile(join(out,'results.json'),'utf8')):[];
  await writeFile(join(out,'plans.json'),JSON.stringify(scenarios,null,2));
  for(const scenario of scenarios){
   if(only&&(scenario.plan.package?.id??scenario.plan.id)!==only)continue;
   const saved=await call('producer_compile_set',{plan:scenario.plan});
   const visual=await call('producer_visual_check',{file:saved.file});
   const preview=await call('producer_preview_set',{file:saved.file});
   const requirements=await call('producer_requirements',{file:saved.file});
   const result={prompt:scenario.prompt,...saved,visual,preview,requirements};
   const previous=results.findIndex(r=>r.prompt===scenario.prompt);
   if(previous<0)results.push(result);else results[previous]=result;
   await writeFile(join(out,'results.json'),JSON.stringify(results,null,2));
   console.log(JSON.stringify({id:scenario.plan.package?.id??scenario.plan.id,file:saved.file,layouts:saved.layouts.length,issues:visual.issues.map(i=>({code:i.code,severity:i.severity,layout:i.layout,node:i.node,message:i.message})),preview:preview.path}));
   assert.deepEqual(visual.issues,[],`Review findings in ${saved.file}`);
  }
 }
}finally{await client.close();await transport.close();}
