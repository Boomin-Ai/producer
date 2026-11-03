/** Local CLI over exactly the MCP compiler. The caller supplies the design;
 * this command does not request a model, connect devices or alter room output. */
import {parseArgs} from 'node:util';
import {open,mkdir,unlink} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {authoringRuntime,previewHtml} from '../tools/producer-mcp/runtime.mjs';
const {values,positionals}=parseArgs({allowPositionals:true,options:{plan:{type:'string'},base:{type:'string'},edit:{type:'string'},'assets-from':{type:'string'},out:{type:'string'},file:{type:'string'}}});
async function read(file,max){
 if(!file)throw Error('Required input file is missing.');
 const f=await open(file,'r');try{const chunks=[];let size=0;for await(const b of f.createReadStream({autoClose:false})){size+=b.length;if(size>max)throw Error('Input exceeds its byte budget.');chunks.push(b);}return Buffer.concat(chunks).toString('utf8');}finally{await f.close();}
}
try{
 const api=await authoringRuntime(),target={catalogRevision:api.AUTHORING_CATALOG.revision,features:[...api.AUTHORING_CATALOG.features]};
 const command=positionals[0];let doc;
 if(command==='capabilities')console.log(JSON.stringify({catalog:api.AUTHORING_CATALOG,instructions:api.DESIGN_INSTRUCTIONS,nativeReadiness:'not-tested'},null,2));
 else if(command==='schema')console.log(JSON.stringify(api.presentationJsonSchema,null,2));
 else if(command==='requirements'){doc=api.parsePackageText(await read(values.file,40*1024*1024));console.log(JSON.stringify({integrations:api.integrationRequirements(doc),features:api.packageFeatures(doc),nativeReadiness:'not-tested'},null,2));}
 else if(command==='check'){const {checkRenderedSet}=await import('../tools/producer-mcp/visual-check.mjs');doc=api.parsePackageText(await read(values.file,40*1024*1024));const report=await checkRenderedSet(doc);console.log(JSON.stringify(report,null,2));if(report.issues.some(i=>i.severity==='error'))process.exitCode=1;}
 else if(command==='preview'){
  if(!values.out?.endsWith('.html'))throw Error('--out must name a new .html file.');doc=api.parsePackageText(await read(values.file,40*1024*1024));const path=resolve(values.out),html=await previewHtml(doc);await mkdir(dirname(path),{recursive:true});const file=await open(path,'wx',0o600);try{await file.writeFile(html);await file.sync();}catch(error){await file.close();await unlink(path).catch(()=>{});throw error;}finally{await file.close().catch(()=>{});}console.log(JSON.stringify({path,preview:'browser-simulation',nativeReadiness:'not-tested'}));
 }
 else if(command==='compile'||command==='edit'){
  if(!values.out)throw Error('--out must name a new .set.json file.');
  if(!values.out.endsWith('.set.json'))throw Error('Output must end in .set.json.');
  if(command==='compile'){
   const assets=values['assets-from']?api.parsePackageText(await read(values['assets-from'],40*1024*1024)).set.assets:{};
   doc=api.compileDesignPlan(JSON.parse(await read(values.plan,api.AUTHORING_CATALOG.limits.designBytes)),target,assets);
  }else{
   const base=api.parsePackageText(await read(values.base,40*1024*1024)),revision=await api.packageRevision(base);
   doc=await api.applyDesignEdits(base,JSON.parse(await read(values.edit,api.AUTHORING_CATALOG.limits.designBytes)),target);
   if(await api.packageRevision(api.parsePackageText(await read(values.base,40*1024*1024)))!==revision)throw Error('The source Set changed during this edit.');
  }
  const path=resolve(values.out);await mkdir(dirname(path),{recursive:true});const file=await open(path,'wx',0o600);try{await file.writeFile(JSON.stringify(doc,null,2));await file.sync();}catch(error){await file.close();await unlink(path).catch(()=>{});throw error;}finally{await file.close().catch(()=>{});}
  console.log(JSON.stringify({path,id:doc.id,layouts:doc.set.layouts.length,views:doc.set.views??{},revision:await api.packageRevision(doc),features:api.packageFeatures(doc),integrations:api.integrationRequirements(doc),nativeReadiness:'not-tested'}));
 }else throw Error('Usage: generate-set.mjs capabilities | schema | requirements --file SET | check --file SET | preview --file SET --out NEW.html | compile --plan PLAN [--assets-from SET] --out NEW.set.json | edit --base SET --edit EDIT --out NEW.set.json');
}catch(error){console.error(JSON.stringify({ok:false,error:String(error.message)}));process.exitCode=1;}
