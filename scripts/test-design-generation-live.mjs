// Opt-in paid acceptance; one saved-provider request per invocation, no retries.
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {authoringRuntime} from '../tools/producer-mcp/runtime.mjs';
const {values}=parseArgs({options:{live:{type:'boolean'},'workspace-file':{type:'string'},connection:{type:'string'},output:{type:'string'}}});
if(!values.live||!values['workspace-file']||!values.connection)throw Error('Usage: node scripts/test-design-generation-live.mjs --live --workspace-file PRIVATE_FILE --connection ID [--output DIRECTORY]. Uses your saved provider account once.');
const workspace=JSON.parse(await readFile(values['workspace-file'],'utf8'));
const endpoint=new URL(workspace.baseUrl);
if(endpoint.protocol!=='https:'&&!(endpoint.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)))throw Error('Workspace must use HTTPS or loopback HTTP.');
const headers={Authorization:'Bearer '+workspace.token,'Content-Type':'application/json'};
async function request(path,body){const res=await fetch(new URL(path,endpoint),{method:body?'POST':'GET',headers,...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(105000)});const data=await res.json();if(!res.ok)throw Error(`${res.status}: ${data.error?.code??'request_failed'}: ${data.error?.message??'Request failed'}`);return data;}
const api=await authoringRuntime();
const {connections}=await request('/v1/app/data-integrations');
const connection=connections.find(c=>c.connection.id===values.connection);if(!connection)throw Error('Saved connection not found.');
const catalog=await request('/v1/app/data-integrations/authoring-capabilities');
const target={catalogRevision:catalog.revision,features:catalog.features.filter(f=>['core@1','shader.voiceRing@1'].includes(f))};
const prompt='Create an Attention Is Currency magazine studio with cream background, black text, a red accent, one host camera, an editable topic headline and MONEY / CULTURE / MUSIC. Make landscape and portrait layouts. Include a voiceRing effect around the host. Keep typography within its bounds. Keep the plan concise.';
const start=Date.now(),directory=resolve(values.output??'target/authoring-acceptance');await mkdir(directory,{recursive:true});
try{
 const result=await request(`/v1/app/data-integrations/${encodeURIComponent(values.connection)}/author-design`,{expectedRevision:connection.revision,prompt,target});
 const doc=api.compileDesignPlan(result.document,target);
 await writeFile(resolve(directory,'claude-plan.json'),JSON.stringify(result.document,null,2),{mode:0o600});
 await writeFile(resolve(directory,'claude-magazine.set.json'),JSON.stringify(doc,null,2),{mode:0o600});
 const report={ok:true,provider:result.provider,model:result.model,elapsedMs:Date.now()-start,layouts:doc.set.layouts.map(l=>({id:l.id,width:l.width,height:l.height})),slots:doc.set.slots.length,controls:doc.set.controls.length,planBytes:Buffer.byteLength(JSON.stringify(result.document)),packageBytes:Buffer.byteLength(JSON.stringify(doc)),nativeReadiness:'not-tested'};
 await writeFile(resolve(directory,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){const report={ok:false,elapsedMs:Date.now()-start,error:error.message};await writeFile(resolve(directory,'report.json'),JSON.stringify(report,null,2));console.error(JSON.stringify(report));process.exitCode=1;}
