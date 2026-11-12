import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import plan,{classicGuide} from './fixtures/classic.mjs';
const root=resolve(process.env.PRODUCER_SETS_DIR??'outputs/classic');
await mkdir(root,{recursive:true});
const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('./server.mjs',import.meta.url))],env:{...process.env,PRODUCER_SETS_DIR:root},stderr:'pipe'});
const client=new Client({name:'producer-classic-authoring',version:'1.0.0'});
const save=(name,value)=>writeFile(join(root,name),JSON.stringify(value,null,2));
const call=async(name,args={})=>{const result=await client.callTool({name,arguments:args},undefined,{timeout:180000});if(result.isError)throw Error(result.content?.[0]?.text??name);return JSON.parse(result.content[0].text);};
try{
 await client.connect(transport);
 const command=process.argv[2]??'build';
 if(command==='build'){
  await save('capabilities.json',await call('producer_capabilities'));
  await save('design-plan.json',plan);await save('classic.guide.json',classicGuide);
  const result=await call('producer_compile_set',{plan});await save('compiled.json',result);
  await save('validation.json',await call('producer_validate_set',{file:result.file}));
  console.log(JSON.stringify(result));
 }else{
  const compiled=JSON.parse(await readFile(join(root,'compiled.json'),'utf8'));
  if(command==='check'){
   const report=[];
   for(const theme of ['dark','light']){
    const variant=theme==='dark'?compiled:await call('producer_edit_set',{file:compiled.file,edit:{schema:'producer.set-edit/2',baseRevision:compiled.revision,operations:[{op:'replace',path:'/set/values/theme/default',value:'light'}]}});
    const result=await call('producer_visual_check',{file:variant.file});report.push({theme,file:variant.file,result});console.log(JSON.stringify({theme,textChecked:result.textChecked,layouts:result.admission?.length,issues:result.issues}));
   }await save('visual-checks.json',report);
  }else if(command==='preview'){
   const preview=await call('producer_preview_set',{file:compiled.file});await save('preview.json',preview);console.log(JSON.stringify(preview));
  }else throw Error('Use build, check or preview.');
 }
}finally{await client.close();await transport.close();}
