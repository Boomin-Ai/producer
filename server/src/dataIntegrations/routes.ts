import {authorSet,parseSetAuthoringInput,AUTHORING_BASE_BYTES} from './setAuthoring';
import {dataAdapterRegistry} from './registry';
import {readObjects,cachedObject,writeObjects,type CachePolicy} from './objectCache';
import {weatherLocationKey} from '../../../shared/set-runtime/weather';
import {Hono} from 'hono';
import type {Env} from '../env';
import {requirePrimary,type TokenClass} from '../auth';
import {ApiError} from '../errors';
import {encryptSecret,decryptSecret} from '../crypto';
import {agent,weather,validateWeatherResult,testConnection,parseConnection,identity,weatherLocations,weatherRequest,ProviderError,type Connection,type WeatherResult} from './providers';
type Row={id:string;config:string;secret_enc:string|null;revision:number;status:string;error:string;tested_at:number|null;last_request_at:number;last_result:string|null;last_result_at:number|null};
export const dataIntegrationRoutes=new Hono<{Bindings:Env;Variables:{tokenClass:TokenClass}}>();
dataIntegrationRoutes.use('*',async(c,next)=>{requirePrimary(c.get('tokenClass'));await next();});
dataIntegrationRoutes.onError((error,c)=>{
 if(error instanceof ApiError)return c.json({error:{code:error.code,message:error.message}},error.status as never);
 if(error instanceof ProviderError)return c.json({error:{code:error.code,message:error.message}},error.code==='invalid_request'?400:502);
 return c.json({error:{code:'integration_failed',message:'The integration request could not complete.'}},500);
});
async function input(req:{text:()=>Promise<string>},maxBytes=20000){const raw=await req.text();if(raw.length>maxBytes||new TextEncoder().encode(raw).byteLength>maxBytes)throw new ApiError(413,'request_too_large','Integration request exceeds its budget');try{const v=JSON.parse(raw);if(!v||typeof v!=='object'||Array.isArray(v))throw Error();return v as Record<string,unknown>;}catch{throw new ApiError(400,'invalid_request','JSON object required');}}
async function load(env:Env,id:string){const row=await env.DB.prepare('SELECT * FROM data_integrations WHERE id = ?1').bind(identity(id)).first<Row>();if(!row)throw new ApiError(404,'connection_not_found','Saved data connection not found');return row;}
const publicRow=(r:Row)=>({connection:parseConnection(JSON.parse(r.config)),revision:r.revision,status:r.status,error:r.error,testedAt:r.tested_at,hasSecret:!!r.secret_enc});
async function secret(env:Env,row:Row){if(!row.secret_enc)return undefined;if(!env.TOKEN_ENCRYPTION_KEY)throw new ApiError(503,'encryption_unconfigured','The workspace server must configure TOKEN_ENCRYPTION_KEY');return decryptSecret(row.secret_enc,env.TOKEN_ENCRYPTION_KEY);}
dataIntegrationRoutes.get('/',async c=>{const rows=await c.env.DB.prepare('SELECT * FROM data_integrations ORDER BY updated_at DESC, id').all<Row>();return c.json({connections:(rows.results??[]).map(publicRow),capabilities:dataAdapterRegistry.capabilities(),adapters:dataAdapterRegistry.catalog()});});
dataIntegrationRoutes.get('/locations',async c=>c.json({locations:await weatherLocations(c.req.query('query'))}));
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
const weatherFlights=new WeakMap<D1Database,Map<string,Promise<WeatherReply>>>();
type WeatherReply={connectionId:string;connectionRevision:number;result:WeatherResult;cached:boolean;stale:boolean;cache:{fetchedAt:number;expiresAt:number}};
export async function querySavedConnection(env:Env,id:string,expectedRevision:number,inputValue?:unknown,options:{refresh?:boolean}={}){
 const row=await load(env,id),connection:Connection=parseConnection(JSON.parse(row.config));
 if(expectedRevision!==row.revision)throw new ApiError(409,'revision_conflict','Connection settings changed. Refresh the saved connection.');
 if(connection.kind!=='weather'){
  await reserve(env,row,2000);const result=await agent(connection,(await secret(env,row))??'',inputValue);
  if((await load(env,row.id)).revision!==row.revision)throw new ApiError(409,'revision_conflict','Connection changed while the provider request was running.');
  return {connectionId:row.id,connectionRevision:row.revision,result};
 }
 const key=weatherLocationKey(weatherRequest(connection,inputValue),connection.units),policy:CachePolicy={freshMs:connection.pollSeconds*1000,staleMs:1800000,maxEntries:16,maxBytes:256*1024};
 const cached=cachedObject(readObjects<WeatherResult>(row.last_result,row.last_result_at),key,policy,Date.now());
 const reply=(entry:NonNullable<typeof cached>,hit:boolean):WeatherReply=>({connectionId:row.id,connectionRevision:row.revision,result:validateWeatherResult(entry.value),cached:hit,stale:entry.stale,cache:{fetchedAt:entry.fetchedAt,expiresAt:entry.expiresAt}});
 if(cached&&!cached.stale&&!options.refresh)return reply(cached,true);
 let flights=weatherFlights.get(env.DB);if(!flights){flights=new Map();weatherFlights.set(env.DB,flights);}
 const flightKey=JSON.stringify([row.id,row.revision,key]),existing=flights.get(flightKey);if(existing)return existing;
 const work=(async()=>{
  try{
   await reserve(env,row,2000);
   const result=await weather(connection,fetch,inputValue),fetchedAt=Date.now();
   // Merge against the latest row with compare-and-swap: concurrent cities
   // cannot overwrite one another, and changed credentials fence old results.
   for(let attempt=0;attempt<4;attempt++){
    const current=await load(env,row.id);if(current.revision!==row.revision)throw new ApiError(409,'revision_conflict','Connection changed while the provider request was running.');
    const raw=writeObjects(readObjects<WeatherResult>(current.last_result,current.last_result_at),{key,fetchedAt,value:result},policy,fetchedAt);
    const saved=await env.DB.prepare('UPDATE data_integrations SET last_result=?1,last_result_at=?2 WHERE id=?3 AND revision=?4 AND last_result IS ?5').bind(raw,fetchedAt,row.id,row.revision,current.last_result).run();
    if(saved.meta.changes)return reply({key,value:result,fetchedAt,expiresAt:fetchedAt+policy.freshMs,stale:false},false);
   }
   throw new ApiError(409,'cache_conflict','Data cache changed; try again.');
  }catch(error){
   // Never mask a permission/revision change or a malformed provider response.
   const current=await load(env,row.id);if(current.revision!==row.revision)throw new ApiError(409,'revision_conflict','Connection changed while the provider request was running.');
   const fallback=cachedObject(readObjects<WeatherResult>(current.last_result,current.last_result_at),key,policy,Date.now());
   if(fallback&&(!(error instanceof ApiError)||error.status===429)&&(!(error instanceof ProviderError)||!['invalid_request','provider_response'].includes(error.code)))return reply({...fallback,stale:error instanceof ApiError&&error.status===429?fallback.stale:true},true);
   throw error;
  }
 })();flights.set(flightKey,work);
 try{return await work;}finally{if(flights.get(flightKey)===work)flights.delete(flightKey);}
}
export async function savedConnection(env:Env,id:string){return publicRow(await load(env,id));}
dataIntegrationRoutes.post('/:id/query',async c=>{
 const body=await input(c.req);if(Object.keys(body).some(k=>!['expectedRevision','input','refresh'].includes(k))||typeof body.expectedRevision!=='number'||body.refresh!==undefined&&typeof body.refresh!=='boolean')throw new ApiError(400,'invalid_request','Invalid query fields');
 return c.json(await querySavedConnection(c.env,c.req.param('id'),body.expectedRevision,body.input,{refresh:body.refresh===true}));
});

/** Explicit one-shot authoring; never installs a package or mutates room output. */
dataIntegrationRoutes.post('/:id/author-set',async c=>{
 const body=await input(c.req,AUTHORING_BASE_BYTES+20000);
 if(Object.keys(body).some(key=>!['expectedRevision','prompt','package'].includes(key))||!Number.isSafeInteger(body.expectedRevision)||(body.expectedRevision as number)<1)throw new ApiError(400,'invalid_request','Expected connection revision and prompt required');
 const request=parseSetAuthoringInput({prompt:body.prompt,...(body.package!==undefined?{package:body.package}:{})});
 const row=await load(c.env,c.req.param('id')),connection=parseConnection(JSON.parse(row.config));
 if(row.revision!==body.expectedRevision)throw new ApiError(409,'revision_conflict','Connection settings changed. Refresh the saved connection.');
 if(connection.kind!=='agent'||connection.provider!=='anthropic')throw new ApiError(400,'invalid_request','Select a saved Claude connection for Set authoring.');
 c.req.raw.signal.throwIfAborted();
 const apiKey=await secret(c.env,row);if(!apiKey)throw new ApiError(400,'provider_auth','The saved Claude connection has no API key.');
 await reserve(c.env,row,2000);
 const result=await authorSet(connection,apiKey,request,{signal:c.req.raw.signal});
 if((await load(c.env,row.id)).revision!==row.revision)throw new ApiError(409,'revision_conflict','Connection changed while the Set draft was being generated.');
 return c.json({connectionId:row.id,connectionRevision:row.revision,...result});
});
