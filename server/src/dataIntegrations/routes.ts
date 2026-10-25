import {Hono} from 'hono';
import type {Env} from '../env';
import {requirePrimary,type TokenClass} from '../auth';
import {ApiError} from '../errors';
import {encryptSecret,decryptSecret} from '../crypto';
import {agent,weather,testConnection,parseConnection,identity,ProviderError,type Connection} from './providers';
type Row={id:string;config:string;secret_enc:string|null;revision:number;status:string;error:string;tested_at:number|null;last_request_at:number;last_result:string|null;last_result_at:number|null};
export const dataIntegrationRoutes=new Hono<{Bindings:Env;Variables:{tokenClass:TokenClass}}>();
dataIntegrationRoutes.use('*',async(c,next)=>{requirePrimary(c.get('tokenClass'));await next();});
dataIntegrationRoutes.onError((error,c)=>{
 if(error instanceof ApiError)return c.json({error:{code:error.code,message:error.message}},error.status as never);
 if(error instanceof ProviderError)return c.json({error:{code:error.code,message:error.message}},error.code==='invalid_request'?400:502);
 return c.json({error:{code:'integration_failed',message:'The integration request could not complete.'}},500);
});
async function input(req:{text:()=>Promise<string>}){const raw=await req.text();if(raw.length>20000)throw new ApiError(413,'request_too_large','Integration request exceeds its budget');try{const v=JSON.parse(raw);if(!v||typeof v!=='object'||Array.isArray(v))throw Error();return v as Record<string,unknown>;}catch{throw new ApiError(400,'invalid_request','JSON object required');}}
async function load(env:Env,id:string){const row=await env.DB.prepare('SELECT * FROM data_integrations WHERE id = ?1').bind(identity(id)).first<Row>();if(!row)throw new ApiError(404,'connection_not_found','Saved data connection not found');return row;}
const publicRow=(r:Row)=>({connection:parseConnection(JSON.parse(r.config)),revision:r.revision,status:r.status,error:r.error,testedAt:r.tested_at,hasSecret:!!r.secret_enc});
async function secret(env:Env,row:Row){if(!row.secret_enc)return undefined;if(!env.TOKEN_ENCRYPTION_KEY)throw new ApiError(503,'encryption_unconfigured','The workspace server must configure TOKEN_ENCRYPTION_KEY');return decryptSecret(row.secret_enc,env.TOKEN_ENCRYPTION_KEY);}
dataIntegrationRoutes.get('/',async c=>{const rows=await c.env.DB.prepare('SELECT * FROM data_integrations ORDER BY updated_at DESC, id').all<Row>();return c.json({connections:(rows.results??[]).map(publicRow),capabilities:['data.weather@1','data.agent@1']});});
dataIntegrationRoutes.post('/',async c=>{
 const body=await input(c.req);if(Object.keys(body).some(k=>!['connection','apiKey','expectedRevision'].includes(k)))throw new ApiError(400,'invalid_request','Unknown connection field');const connection=parseConnection(body.connection);
 const previous=await c.env.DB.prepare('SELECT * FROM data_integrations WHERE id = ?1').bind(connection.id).first<Row>();
 if(previous&&body.expectedRevision!==previous.revision)throw new ApiError(409,'revision_conflict','This connection changed. Reload before saving.');
 if(previous&&(parseConnection(JSON.parse(previous.config)).kind!==connection.kind||parseConnection(JSON.parse(previous.config)).provider!==connection.provider))throw new ApiError(409,'connection_kind','Create a new connection to change its kind or provider.');
 let encrypted=previous?.secret_enc??null;
 if(body.apiKey!==undefined){if(connection.kind!=='agent'||typeof body.apiKey!=='string'||!body.apiKey.trim()||body.apiKey.length>512)throw new ApiError(400,'invalid_request','Invalid provider key');if(!c.env.TOKEN_ENCRYPTION_KEY)throw new ApiError(503,'encryption_unconfigured','Configure TOKEN_ENCRYPTION_KEY on the workspace server before saving provider credentials.');encrypted=await encryptSecret(body.apiKey.trim(),c.env.TOKEN_ENCRYPTION_KEY);}
 if(connection.kind==='agent'&&!encrypted)throw new ApiError(400,'provider_auth','An agent connection requires an API key.');
 const now=Date.now();
 if(previous){const res=await c.env.DB.prepare("UPDATE data_integrations SET config=?1, secret_enc=?2, revision=revision+1, status='unverified', error='', tested_at=NULL, last_request_at=0, last_result=NULL, last_result_at=NULL, updated_at=?3 WHERE id=?4 AND revision=?5").bind(JSON.stringify(connection),encrypted,now,connection.id,previous.revision).run();if(!res.meta.changes)throw new ApiError(409,'revision_conflict','This connection changed. Reload before saving.');}
 else{const res=await c.env.DB.prepare("INSERT OR IGNORE INTO data_integrations (id,config,secret_enc,updated_at) VALUES (?1,?2,?3,?4)").bind(connection.id,JSON.stringify(connection),encrypted,now).run();if(!res.meta.changes)throw new ApiError(409,'revision_conflict','This connection already exists.');}
 return c.json(publicRow(await load(c.env,connection.id)),previous?200:201);
});
dataIntegrationRoutes.delete('/:id',async c=>{const body=await input(c.req);if(!Number.isSafeInteger(body.expectedRevision))throw new ApiError(400,'invalid_request','Expected revision required');const res=await c.env.DB.prepare('DELETE FROM data_integrations WHERE id=?1 AND revision=?2').bind(identity(c.req.param('id')),body.expectedRevision).run();if(!res.meta.changes)throw new ApiError(409,'revision_conflict','Connection was changed or removed');return c.json({deleted:true});});
async function reserve(env:Env,row:Row,delay:number){const now=Date.now();const res=await env.DB.prepare('UPDATE data_integrations SET last_request_at=?1 WHERE id=?2 AND revision=?3 AND last_request_at<=?4').bind(now,row.id,row.revision,now-delay).run();if(!res.meta.changes)throw new ApiError(429,'connection_busy','This connection was recently requested or changed. Try again shortly.');}
dataIntegrationRoutes.post('/:id/test',async c=>{
 const row=await load(c.env,c.req.param('id'));await reserve(c.env,row,2000);
 try{const result=await testConnection(parseConnection(JSON.parse(row.config)),await secret(c.env,row));if('sample'in result)await c.env.DB.prepare('UPDATE data_integrations SET last_result=?1,last_result_at=?2 WHERE id=?3 AND revision=?4').bind(JSON.stringify(result.sample),Date.now(),row.id,row.revision).run();await c.env.DB.prepare("UPDATE data_integrations SET status='ready',error='',tested_at=?1 WHERE id=?2 AND revision=?3").bind(Date.now(),row.id,row.revision).run();return c.json({...result,connectionRevision:row.revision});}
 catch(error){const message=error instanceof ProviderError?error.message:'Connection test did not complete';await c.env.DB.prepare("UPDATE data_integrations SET status='error',error=?1,tested_at=?2 WHERE id=?3 AND revision=?4").bind(message,Date.now(),row.id,row.revision).run();throw error;}
});
export async function querySavedConnection(env:Env,id:string,expectedRevision:number,inputValue?:unknown){
 const row=await load(env,id),connection:Connection=parseConnection(JSON.parse(row.config));
 if(expectedRevision!==row.revision)throw new ApiError(409,'revision_conflict','Connection settings changed. Refresh the saved connection.');
 if(connection.kind==='weather'&&row.last_result&&row.last_result_at&&Date.now()-row.last_result_at<connection.pollSeconds*1000)return {connectionId:row.id,connectionRevision:row.revision,result:JSON.parse(row.last_result),cached:true};
 await reserve(env,row,connection.kind==='weather'?connection.pollSeconds*1000:2000);
 const result=connection.kind==='weather'?await weather(connection):await agent(connection,(await secret(env,row))??'',inputValue);
 const current=await load(env,row.id);if(current.revision!==row.revision)throw new ApiError(409,'revision_conflict','Connection changed while the provider request was running.');
 if(connection.kind==='weather')await env.DB.prepare('UPDATE data_integrations SET last_result=?1,last_result_at=?2 WHERE id=?3 AND revision=?4').bind(JSON.stringify(result),Date.now(),row.id,row.revision).run();
 return {connectionId:row.id,connectionRevision:row.revision,result};
}
export async function savedConnection(env:Env,id:string){return publicRow(await load(env,id));}
dataIntegrationRoutes.post('/:id/query',async c=>{
 const body=await input(c.req);if(Object.keys(body).some(k=>!['expectedRevision','input'].includes(k))||typeof body.expectedRevision!=='number')throw new ApiError(400,'invalid_request','Invalid query fields');
 return c.json(await querySavedConnection(c.env,c.req.param('id'),body.expectedRevision,body.input));
});
