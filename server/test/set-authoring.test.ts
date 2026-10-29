import {afterEach,describe,expect,it,vi} from 'vitest';
import {Hono} from 'hono';
import {authorSet,parseSetAuthoringInput} from '../src/dataIntegrations/setAuthoring';
import {dataIntegrationRoutes} from '../src/dataIntegrations/routes';
import {parsePackageText} from '../../src/features/presentation/validation';
import type {Connection} from '../src/dataIntegrations/providers';
import type {Env} from '../src/env';
import {fakeD1} from './d1';
const connection:Connection={id:'author',name:'Set author',kind:'agent',provider:'anthropic',model:'test-claude',webSearch:true,maxOutputTokens:2048};
const draft={schema:'producer.presentation/2',id:'generated',version:'1.0.0',name:'Generated studio',set:{initialLayout:'main',values:{},feeds:{},slots:[{id:'host',label:'Host camera'}],components:{},controls:[],layouts:[{id:'main',label:'Main',width:1920,height:1080,root:{id:'camera',type:'slot',slotId:'host',styles:{width:1920,height:1080}}}]}};
const response=(doc:unknown=draft,stop_reason='end_turn')=>Response.json({stop_reason,content:[{type:'text',text:JSON.stringify(doc)}]});
function app(role:'primary'|'automation'='primary'){const a=new Hono<{Bindings:Env;Variables:{tokenClass:'primary'|'automation'}}>();a.use('*',async(c,next)=>{c.set('tokenClass',role);await next();});a.route('/connections',dataIntegrationRoutes);return a;}
const env=()=>({DB:fakeD1(),TOKEN_ENCRYPTION_KEY:'synthetic-encryption-key'} as Env);
const request=(a:ReturnType<typeof app>,e:Env,path:string,body:unknown)=>a.request('/connections'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)},e);
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
describe('one-shot Set authoring',()=>{
 it('uses saved Claude limits, sends a valid small example without research tools, and returns only a validated draft',async()=>{
  const fetcher=vi.fn<typeof fetch>(async()=>response());
  const result=await authorSet(connection,'synthetic-secret',{prompt:'A striking solo camera cover'},{fetcher});
  expect(result.package.id).toBe('generated');expect(result.provider).toBe('anthropic');expect(fetcher).toHaveBeenCalledTimes(1);
  const [url,init]=fetcher.mock.calls[0],body=JSON.parse(init!.body as string);expect(url).toBe('https://api.anthropic.com/v1/messages');expect(init!.redirect).toBe('manual');expect(new Headers(init!.headers).get('x-api-key')).toBe('synthetic-secret');expect(body.max_tokens).toBe(2048);expect(body.tools).toBeUndefined();expect(body.system).not.toContain('Answer concisely');expect(body.system.length).toBeLessThan(8000);
  expect(parsePackageText(body.system.split('Minimal valid example:\n')[1]).set.slots[0].id).toBe('host');
  expect(JSON.stringify(result)).not.toContain('synthetic-secret');expect(Object.keys(result).sort()).toEqual(['model','package','provider']);
 });
 it('rejects invalid JSON, schema, embedded media and truncated/tool responses without retry',async()=>{
  for(const result of [Response.json({stop_reason:'end_turn',content:[{type:'text',text:'```json\n{}\n```'}]}),response({wrong:'schema'}),response(draft,'max_tokens'),Response.json({stop_reason:'end_turn',content:[{type:'tool_use',id:'tool'}]}),response({...draft,set:{...draft.set,assets:{image:{name:'Local',mime:'image/png',data:'producer-media:00000000-0000-0000-0000-000000000000'}}}})]){
   const fetcher=vi.fn<typeof fetch>(async()=>result);await expect(authorSet(connection,'key',{prompt:'Generate'},{fetcher})).rejects.toThrow();expect(fetcher).toHaveBeenCalledTimes(1);
  }
 });
 it('refuses unsupported features instead of returning a silently degraded Set',async()=>{
  const fetcher=vi.fn<typeof fetch>(async()=>response({error:{code:'unsupported_request',message:'Live weather needs an integration'}}));
  await expect(authorSet(connection,'key',{prompt:'Live weather in 3D'},{fetcher})).rejects.toMatchObject({code:'unsupported_request'});expect(fetcher).toHaveBeenCalledTimes(1);
  const unused=vi.fn<typeof fetch>();await expect(authorSet(connection,'key',{prompt:'Revise',package:{...draft,requires:['chart@1']}},{fetcher:unused})).rejects.toMatchObject({code:'invalid_request'});expect(unused).not.toHaveBeenCalled();
 });
 it('checks prompt/base/provider/token bounds before a provider request',async()=>{
  const fetcher=vi.fn<typeof fetch>();
  for(const input of [{prompt:''},{prompt:'x'.repeat(4001)},{prompt:'Make it',extra:true},{prompt:'Make it',package:{...draft,name:'x'.repeat(70000)}},{prompt:'Make it',package:{...draft,set:{...draft.set,assets:{image:{name:'Local',mime:'image/png',data:'producer-media:00000000-0000-0000-0000-000000000000'}}}}}])await expect(authorSet(connection,'key',input,{fetcher})).rejects.toMatchObject({code:'invalid_request'});
  await expect(authorSet({...connection,provider:'openai'},'key',{prompt:'Generate'},{fetcher})).rejects.toThrow('Claude');
  await expect(authorSet({...connection,maxOutputTokens:4097},'key',{prompt:'Generate'},{fetcher})).rejects.toThrow('budget');expect(fetcher).not.toHaveBeenCalled();
  expect(parseSetAuthoringInput({prompt:'  Cover  ',package:draft}).prompt).toBe('Cover');
 });
 it('bounds streamed responses and respects cancellation without retry',async()=>{
  const fetcher=vi.fn<typeof fetch>(async()=>new Response('x'.repeat(256*1024+1)));await expect(authorSet(connection,'key',{prompt:'Generate'},{fetcher})).rejects.toThrow('size budget');expect(fetcher).toHaveBeenCalledTimes(1);
  const controller=new AbortController();controller.abort();const aborted=vi.fn<typeof fetch>();await expect(authorSet(connection,'key',{prompt:'Generate'},{fetcher:aborted,signal:controller.signal})).rejects.toThrow();expect(aborted).not.toHaveBeenCalled();
  const live=new AbortController();const pendingFetch=vi.fn<typeof fetch>(async(_url,init)=>{live.abort();expect(init!.signal!.aborted).toBe(true);return response();});await expect(authorSet(connection,'key',{prompt:'Generate'},{fetcher:pendingFetch,signal:live.signal})).rejects.toThrow();expect(pendingFetch).toHaveBeenCalledTimes(1);
 });
 it('uses the encrypted saved credential and returns a draft without touching any room',async()=>{
  const a=app(),e=env();expect((await request(a,e,'',{connection,apiKey:'saved-secret'})).status).toBe(201);
  const fetcher=vi.fn<typeof fetch>(async()=>response());vi.stubGlobal('fetch',fetcher);
  const result=await request(a,e,'/author/author-set',{expectedRevision:1,prompt:'Cover'});expect(result.status).toBe(200);const body=await result.json() as any;expect(body.connectionId).toBe('author');expect(body.connectionRevision).toBe(1);expect(body.package.id).toBe('generated');expect(JSON.stringify(body)).not.toContain('saved-secret');expect(new Headers(fetcher.mock.calls[0][1]!.headers).get('x-api-key')).toBe('saved-secret');
  const row=await e.DB.prepare('SELECT revision,last_result FROM data_integrations WHERE id=?1').bind('author').first<{revision:number;last_result:string|null}>();expect(row!.revision).toBe(1);expect(row!.last_result).toBeNull();
  expect((await request(a,e,'/author/author-set',{expectedRevision:1,prompt:'Again'})).status).toBe(429);expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('blocks automation, stale settings and oversized input before spending',async()=>{
  const e=env(),a=app();await request(a,e,'',{connection,apiKey:'key'});const fetcher=vi.fn<typeof fetch>();vi.stubGlobal('fetch',fetcher);
  expect((await request(app('automation'),e,'/author/author-set',{expectedRevision:1,prompt:'Cover'})).status).toBe(403);
  expect((await request(a,e,'/author/author-set',{expectedRevision:2,prompt:'Cover'})).status).toBe(409);
  expect((await request(a,e,'/author/author-set',{expectedRevision:1,prompt:'x'.repeat(100000)})).status).toBe(413);expect(fetcher).not.toHaveBeenCalled();
 });
 it('discards a completed draft when the saved connection changed while generating',async()=>{
  const e=env(),a=app();await request(a,e,'',{connection,apiKey:'key'});
  let release!:(response:Response)=>void,started!:()=>void;const ready=new Promise<void>(r=>{started=r;});const fetcher=vi.fn<typeof fetch>(()=>{started();return new Promise(r=>{release=r;});});vi.stubGlobal('fetch',fetcher);
  const generated=request(a,e,'/author/author-set',{expectedRevision:1,prompt:'Cover'});await ready;
  expect((await request(a,e,'',{connection:{...connection,name:'Changed'},expectedRevision:1})).status).toBe(200);release(response());expect((await generated).status).toBe(409);expect(fetcher).toHaveBeenCalledTimes(1);
 });
});
