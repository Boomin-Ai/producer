import {afterEach,describe,expect,it,vi} from 'vitest';
import {Hono} from 'hono';
import type {Env} from '../src/env';
import {dataIntegrationRoutes,querySavedConnection} from '../src/dataIntegrations/routes';
import {parseConnection,weather,agent,testConnection,type Connection} from '../src/dataIntegrations/providers';
import {fakeD1} from './d1';
import {decryptSecret} from '../src/crypto';
const config:Connection={id:'weather-main',name:'Weather',kind:'weather',provider:'open-meteo',latitude:33.749,longitude:-84.388,location:'Atlanta',units:'celsius',pollSeconds:300};
const llm:Connection={id:'research',name:'Research',kind:'agent',provider:'openai',model:'test-model',webSearch:true,maxOutputTokens:1024};
const env=()=>({DB:fakeD1(),TOKEN_ENCRYPTION_KEY:'test-workspace-encryption-key'} as Env);
const observation=()=>({current:{time:Math.floor(Date.now()/1000),temperature_2m:22,weather_code:63,is_day:1,wind_speed_10m:14,precipitation:2}});
function app(role:'primary'|'automation'='primary'){const a=new Hono<{Bindings:Env;Variables:{tokenClass:'primary'|'automation'}}>();a.use('*',async(c,next)=>{c.set('tokenClass',role);await next();});a.route('/connections',dataIntegrationRoutes);return a;}
const request=(a:ReturnType<typeof app>,e:Env,path='',method='GET',body?:unknown)=>a.request('/connections'+path,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})},e);
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
describe('managed data integration routes',()=>{
 it('creates, lists, updates and removes connections with explicit revision checks',async()=>{
  const a=app(),e=env();expect((await request(a,e,'','POST',{connection:config})).status).toBe(201);
  let list=await (await request(a,e)).json() as any;expect(list.connections[0].connection.location).toBe('Atlanta');expect(list.connections[0].hasSecret).toBe(false);
  expect((await request(a,e,'','POST',{connection:{...config,location:'New city'},expectedRevision:0})).status).toBe(409);
  const updated=await request(a,e,'','POST',{connection:{...config,location:'New city'},expectedRevision:1});expect(updated.status).toBe(200);expect((await updated.json() as any).revision).toBe(2);
  expect((await request(a,e,'/weather-main','DELETE',{expectedRevision:1})).status).toBe(409);expect((await request(a,e,'/weather-main','DELETE',{expectedRevision:2})).status).toBe(200);
 });
 it('encrypts provider keys and never echoes them in connection responses',async()=>{
  const a=app(),e=env(),key='synthetic-api-secret';const saved=await request(a,e,'','POST',{connection:llm,apiKey:key});expect(saved.status).toBe(201);expect(await saved.text()).not.toContain(key);
  const row=await e.DB.prepare('SELECT secret_enc FROM data_integrations WHERE id=?1').bind('research').first<{secret_enc:string}>();expect(row!.secret_enc).not.toContain(key);expect(await decryptSecret(row!.secret_enc,e.TOKEN_ENCRYPTION_KEY!)).toBe(key);
  expect(await (await request(a,e)).text()).not.toContain(key);expect((await request(a,e,'','POST',{connection:{...llm,name:'Renamed'},expectedRevision:1})).status).toBe(200);
 });
 it('blocks automation credentials and requires configured encryption for agent keys',async()=>{
  const e=env();expect((await request(app('automation'),e)).status).toBe(403);expect((await request(app('automation'),e,'','POST',{connection:config})).status).toBe(403);
  e.TOKEN_ENCRYPTION_KEY=undefined;expect((await request(app(),e,'','POST',{connection:llm,apiKey:'synthetic-key'})).status).toBe(503);
 });
 it('rejects arbitrary provider URLs and unknown connection fields',()=>{
  expect(()=>parseConnection({...config,url:'https://private.example/'})).toThrow();expect(()=>parseConnection({...config,latitude:100})).toThrow();expect(()=>parseConnection({...llm,provider:'https://private.example'})).toThrow();
 });
 it('reuses validated weather from the connection test instead of immediately polling again',async()=>{
  const a=app(),e=env(),fetcher=vi.fn<typeof fetch>(async()=>Response.json(observation()));vi.stubGlobal('fetch',fetcher);
  await request(a,e,'','POST',{connection:config});expect((await request(a,e,'/weather-main/test','POST',{})).status).toBe(200);
  const queried=await request(a,e,'/weather-main/query','POST',{expectedRevision:1});expect(queried.status).toBe(200);const body=await queried.json() as any;expect(body.cached).toBe(true);expect(body.result.condition).toBe('rain');expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('keeps separate city objects, reuses all forecast panels, and preserves the original fetch time',async()=>{
  let now=Date.now();vi.spyOn(Date,'now').mockImplementation(()=>now);
  const a=app(),e=env(),fetcher=vi.fn<typeof fetch>(async()=>Response.json(observation()));vi.stubGlobal('fetch',fetcher);
  await request(a,e,'','POST',{connection:config});const first=await querySavedConnection(e,config.id,1);expect('cache' in first&&first.cache.fetchedAt).toBe(now);
  now+=2100;const location={id:'denver',label:'Denver, Colorado, US',latitude:39.74,longitude:-104.99,timezone:'America/Denver'};
  await querySavedConnection(e,config.id,1,{location});now+=2100;
  for(let panel=0;panel<4;panel++){const again=await querySavedConnection(e,config.id,1);expect('cached' in again&&again.cached).toBe(true);expect('cache' in again&&again.cache.fetchedAt).toBe(now-4200);expect(again.result.location).toBe('Atlanta');}
  expect(fetcher).toHaveBeenCalledTimes(2);
 });
 it('coalesces concurrent identical pulls and supports explicit refresh inside the freshness window',async()=>{
  let now=Date.now();vi.spyOn(Date,'now').mockImplementation(()=>now);const a=app(),e=env();
  const fetcher=vi.fn<typeof fetch>(async()=>Response.json(observation()));vi.stubGlobal('fetch',fetcher);
  await request(a,e,'','POST',{connection:config});const [x,y]=await Promise.all([querySavedConnection(e,config.id,1),querySavedConnection(e,config.id,1)]);expect(x.result).toEqual(y.result);expect(fetcher).toHaveBeenCalledTimes(1);
  now+=2100;await querySavedConnection(e,config.id,1,undefined,{refresh:true});expect(fetcher).toHaveBeenCalledTimes(2);
 });
 it('marks outage fallback stale without extending freshness, and rejects expired fallback',async()=>{
  let now=Date.now();vi.spyOn(Date,'now').mockImplementation(()=>now);const a=app(),e=env();
  vi.stubGlobal('fetch',vi.fn<typeof fetch>(async()=>Response.json(observation())));await request(a,e,'','POST',{connection:config});const first=await querySavedConnection(e,config.id,1);
  now+=300001;vi.stubGlobal('fetch',vi.fn<typeof fetch>(async()=>{throw Error('Provider offline');}));
  const fallback=await querySavedConnection(e,config.id,1);expect('stale' in fallback&&fallback.stale).toBe(true);expect('cache' in fallback&&fallback.cache.fetchedAt).toBe('cache' in first&&first.cache.fetchedAt);
  now+=1800001;await expect(querySavedConnection(e,config.id,1)).rejects.toThrow('Provider offline');
 });
 it('merges concurrent different-city responses without overwriting an existing object',async()=>{
  let now=Date.now();vi.spyOn(Date,'now').mockImplementation(()=>now);const a=app(),e=env();let release!:()=>void,entered!:()=>void;
  const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
  const fetcher=vi.fn<typeof fetch>(async()=>{if(fetcher.mock.calls.length===1){entered();await gate;}return Response.json(observation());});vi.stubGlobal('fetch',fetcher);
  await request(a,e,'','POST',{connection:config});const atlanta=querySavedConnection(e,config.id,1);await started;now+=2100;
  const location={id:'denver',label:'Denver',latitude:39.74,longitude:-104.99,timezone:'America/Denver'};await querySavedConnection(e,config.id,1,{location});release();await atlanta;
  expect((await querySavedConnection(e,config.id,1)).result.location).toBe('Atlanta');expect((await querySavedConnection(e,config.id,1,{location})).result.location).toBe('Denver');expect(fetcher).toHaveBeenCalledTimes(2);
 });
 it('rejects stale connection revisions before contacting any provider',async()=>{
  const a=app(),e=env(),fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);await request(a,e,'','POST',{connection:config});expect((await request(a,e,'/weather-main/query','POST',{expectedRevision:0})).status).toBe(409);expect(fetcher).not.toHaveBeenCalled();
 });
});
describe('provider adapters',()=>{
 it('normalizes actual weather variables, request units and WMO codes',async()=>{
  const f=vi.fn<typeof fetch>(async()=>Response.json(observation()));const result=await weather(config,f as typeof fetch);expect(result.condition).toBe('rain');expect(result.isDay).toBe(true);expect(result.temperature).toBe(22);expect(String(f.mock.calls[0][0])).toContain('temperature_unit=celsius');
  await expect(weather(config,async()=>Response.json({current:{...observation().current,temperature_2m:'22'}}))).rejects.toThrow();
 });
 it('uses Responses web research, preserves citation positions and requires completed evidence',async()=>{
  const f=vi.fn<typeof fetch>(async()=>Response.json({status:'completed',output:[{type:'web_search_call',status:'completed'},{type:'message',content:[{type:'output_text',text:'Evidence supports this.',annotations:[{type:'url_citation',title:'Primary evidence',url:'https://example.com/evidence',start_index:0,end_index:8}]}]}]}));
  const result=await agent(llm,'synthetic-key',{question:'What is supported?',mode:'factCheck'},f as typeof fetch);expect(result.researched).toBe(true);expect(result.citations[0]).toMatchObject({start:0,end:8,url:'https://example.com/evidence'});const body=JSON.parse(String(f.mock.calls[0][1]?.body));expect(body.tool_choice).toBe('required');expect(body.store).toBe(false);
  await expect(agent(llm,'key',{question:'Evidence?',mode:'factCheck'},async()=>Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'Unsupported answer'}]}]}))).rejects.toThrow('did not return');
 });
 it('never leaks provider response error details or retries paid requests automatically',async()=>{
  const f=vi.fn<typeof fetch>(async()=>Response.json({error:{message:'secret synthetic-key upstream'}},{status:401}));await expect(agent(llm,'synthetic-key',{question:'Question?',mode:'answer'},f as typeof fetch)).rejects.toThrow('Check its credentials');expect(f).toHaveBeenCalledTimes(1);
 });
 it('supports Claude API authentication, model testing and cited web research',async()=>{
  const connection:Extract<Connection,{kind:'agent'}>={...llm,provider:'anthropic',model:'claude-model-test',workspaceId:'wrkspc_test'};
  const f=vi.fn<typeof fetch>(async()=>Response.json({stop_reason:'end_turn',content:[{type:'web_search_tool_result',content:[{type:'web_search_result',url:'https://example.com/evidence'}]},{type:'text',text:'Evidence from a primary source.',citations:[{type:'web_search_result_location',url:'https://example.com/evidence',title:'Primary source',cited_text:'Evidence'}]}]}));
  const result=await agent(connection,'synthetic-anthropic-key',{question:'Check the evidence',mode:'factCheck'},f as typeof fetch);
  expect(result.researched).toBe(true);expect(result.citations[0]).toMatchObject({url:'https://example.com/evidence',start:0,end:31});
  expect(f.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages');const options=f.mock.calls[0][1]!;
  expect(options.headers).toMatchObject({Authorization:'Bearer synthetic-anthropic-key','anthropic-version':'2026-10-21','anthropic-workspace-id':'wrkspc_test'});
  const body=JSON.parse(String(options.body));expect(body.tools[0]).toMatchObject({name:'web_search',max_uses:3});expect(body.messages[0].content).toBe('Check the evidence');
  const test=vi.fn<typeof fetch>(async()=>Response.json({id:'claude-model-test'}));await testConnection(connection,'synthetic-anthropic-key',test as typeof fetch);expect(test.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/models/claude-model-test');
 });
 it('rejects incomplete Claude turns and uncited fact-check responses',async()=>{
  const connection:Extract<Connection,{kind:'agent'}>={...llm,provider:'anthropic'};
  await expect(agent(connection,'key',{question:'Check this',mode:'factCheck'},async()=>Response.json({stop_reason:'pause_turn',content:[]}))).rejects.toThrow('paused');
  await expect(agent(connection,'key',{question:'Check this',mode:'factCheck'},async()=>Response.json({stop_reason:'end_turn',content:[{type:'text',text:'Uncited claim'}]}))).rejects.toThrow('source citations');
 });
 it('can save a Claude connection without replacing the OpenAI connection or exposing either key',async()=>{
  const a=app(),e=env();await request(a,e,'','POST',{connection:llm,apiKey:'synthetic-openai-key'});
  const claude={...llm,id:'claude-research',name:'Claude research',provider:'anthropic'};
  expect((await request(a,e,'','POST',{connection:claude,apiKey:'synthetic-claude-key'})).status).toBe(201);
  const list=await (await request(a,e)).json() as any;expect(list.connections).toHaveLength(2);expect(JSON.stringify(list)).not.toContain('synthetic-');
  expect((await request(a,e,'','POST',{connection:{...llm,provider:'anthropic'},expectedRevision:1})).status).toBe(409);
 });

 it('rejects provider redirects without forwarding the credential',async()=>{
  const fetcher=vi.fn<typeof fetch>(async()=>new Response(null,{status:302,headers:{Location:'https://another.example/'}}));
  await expect(testConnection(llm,'synthetic-private-key',fetcher)).rejects.toThrow('Provider request failed (302)');
  expect(fetcher).toHaveBeenCalledTimes(1);expect(fetcher.mock.calls[0][1]?.redirect).toBe('manual');
 });

});
