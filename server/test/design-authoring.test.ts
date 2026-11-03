import {describe,it,expect,vi} from 'vitest';
import {authorDesign,parseDesignInput} from '../src/dataIntegrations/designAuthoring';
import {AUTHORING_CATALOG} from '../../src/features/presentation/authoring/catalog';
import {compileDesignPlan,applyDesignEdits,designContext,packageRevision} from '../../src/features/presentation/authoring/compiler';
import {negotiateAuthoringTarget} from '../../src/features/presentation/authoring/discovery';
import {readFileSync} from 'node:fs';
import type {Connection} from '../src/dataIntegrations/providers';
const connection:Connection={id:'claude',name:'Claude',kind:'agent',provider:'anthropic',model:'test-model',webSearch:false,maxOutputTokens:4096};
const target={catalogRevision:2,features:[...AUTHORING_CATALOG.features]};
const plan={schema:'producer.design-plan/1',id:'studio',name:'Studio',background:'#000000',layouts:[{id:'main',name:'Main',orientation:'landscape',elements:[{id:'host',kind:'camera',slot:'host',bounds:[0,0,1920,1080]}]}]};
const response=(document:unknown,stop_reason='end_turn')=>Response.json({stop_reason,content:[{type:'text',text:JSON.stringify(document)}]});
describe('compact design generation',()=>{
 it('uses saved credentials and limits, then compiles locally',async()=>{
  const fetcher=vi.fn<typeof fetch>(async()=>response(plan));
  const result=await authorDesign(connection,'synthetic-secret',{prompt:'Solo host',target},{fetcher});
  expect(compileDesignPlan(result.document,target).set.slots[0].id).toBe('host');
  const body=JSON.parse(fetcher.mock.calls[0][1]!.body as string);expect(body.max_tokens).toBe(4096);expect(body.system).toContain('producer.design-plan/1');expect(body.messages[0].content).not.toContain('synthetic-secret');expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('accepts canonical generation with portable weather and a user-selected larger budget',async()=>{
  const original=compileDesignPlan(plan,target),tree=structuredClone(original);delete tree.set.assets;
  tree.integrations={schema:'producer.integrations/1',requirements:[{role:'forecast',label:'Weather',capability:'data.weather@1',input:'weather.location-query@1',output:'weather.observation@1',delivery:'snapshot',optional:false}]};
  const document={schema:'producer.design-plan/2',package:tree};
  const fetcher=vi.fn<typeof fetch>(async()=>response(document));
  const result=await authorDesign({...connection,maxOutputTokens:16384},'synthetic-secret',{prompt:'Portable weather studio',target},{fetcher});
  expect(compileDesignPlan(result.document,target).integrations?.requirements[0].role).toBe('forecast');
  expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string).max_tokens).toBe(16384);expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('edits the real launch Set without sending embedded artwork',async()=>{
  const base=JSON.parse(readFileSync('../docs/shows/road-to-v1.json','utf8')),baseRevision=await packageRevision(base);
  const document={schema:'producer.set-edit/1',baseRevision,operations:[{op:'duplicate-layout',layout:'sea-landscape',id:'new-host',name:'New host'},{op:'replace-camera',layout:'new-host',node:'live-captions',slot:'host'}]};
  const fetcher=vi.fn<typeof fetch>(async()=>response(document));
  const result=await authorDesign(connection,'synthetic-secret',{prompt:'Add host variant',target,context:designContext(base),baseRevision},{fetcher});
  expect(fetcher.mock.calls[0][1]!.body).not.toContain('base64,');
  const edited=await applyDesignEdits(base,result.document,target);expect(edited.set.assets).toEqual(base.set.assets);expect(edited.set.layouts.slice(0,base.set.layouts.length)).toEqual(base.set.layouts);
 });
 it('rejects incompatible targets and asset bytes before paid work',async()=>{
  const fetcher=vi.fn<typeof fetch>();
  await expect(authorDesign(connection,'key',{prompt:'x',target:{...target,catalogRevision:999}},{fetcher})).rejects.toThrow();
  expect(()=>parseDesignInput({prompt:'x',target,baseRevision:'a'.repeat(64),context:{image:'data:image/png;base64,AA=='}})).toThrow(/metadata/);expect(fetcher).not.toHaveBeenCalled();
 });
 it('rejects truncation, refusal and wrong edit revision without retry',async()=>{
  for(const [document,reason] of [[plan,'max_tokens'],[{error:{code:'unsupported_request'}},'end_turn'],[{schema:'producer.set-edit/1',baseRevision:'b'.repeat(64)},'end_turn']] as const){
   const fetcher=vi.fn<typeof fetch>(async()=>response(document,reason));await expect(authorDesign(connection,'key',{prompt:'x',target},{fetcher})).rejects.toThrow();expect(fetcher).toHaveBeenCalledTimes(1);
  }
 });
 it('intersects native and workspace features; unknown releases fail closed',()=>{
  const engine={version:'0.4.78',native:true,effects:['mask@1'],scene3d:false};
  const result=negotiateAuthoringTarget(engine,{revision:2,features:['core@1','mask@1','scene3d@1']});expect(result.features).toEqual(['core@1','mask@1']);
  expect(()=>negotiateAuthoringTarget({...engine,version:'0.4.76'},{revision:2,features:['core@1']})).toThrow(/verified/);
 });
});

import {Hono} from 'hono';
import {dataIntegrationRoutes} from '../src/dataIntegrations/routes';
import {fakeD1} from './d1';
import type {Env} from '../src/env';
describe('design authoring route',()=>{
 it('uses saved secrets, enforces revision and primary authority, and advertises its catalog',async()=>{
  const env={DB:fakeD1(),TOKEN_ENCRYPTION_KEY:'synthetic-encryption-key'} as Env;
  const app=(role:'primary'|'automation')=>{const a=new Hono<{Bindings:Env;Variables:{tokenClass:'primary'|'automation'}}>();a.use('*',async(c,next)=>{c.set('tokenClass',role);await next();});a.route('/connections',dataIntegrationRoutes);return a;};
  const primary=app('primary');
  const post=(a:ReturnType<typeof app>,path:string,body:unknown)=>a.request('/connections'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)},env);
  expect((await post(primary,'',{connection,apiKey:'saved-synthetic-secret'})).status).toBe(201);
  expect((await primary.request('/connections/authoring-capabilities',{},env)).status).toBe(200);
  const fetcher=vi.fn<typeof fetch>(async()=>response(plan));vi.stubGlobal('fetch',fetcher);
  try{
   const input={prompt:'Host studio',target,expectedRevision:1};
   expect((await post(app('automation'),'/claude/author-design',input)).status).toBe(403);
   expect((await post(primary,'/claude/author-design',{...input,expectedRevision:2})).status).toBe(409);expect(fetcher).not.toHaveBeenCalled();
   const result=await post(primary,'/claude/author-design',input);expect(result.status).toBe(200);const body=await result.json() as any;expect(body.document.schema).toBe('producer.design-plan/1');expect(JSON.stringify(body)).not.toContain('saved-synthetic-secret');expect(new Headers(fetcher.mock.calls[0][1]!.headers).get('x-api-key')).toBe('saved-synthetic-secret');
   expect((await post(primary,'/claude/author-design',input)).status).toBe(429);expect(fetcher).toHaveBeenCalledTimes(1);
  }finally{vi.unstubAllGlobals();}
 });
});
