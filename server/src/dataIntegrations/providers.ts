import { dataAdapterRegistry } from './registry';
import { executeDataOperation, parseDataValue, DataValidationError, type DataContract } from '../../../shared/set-runtime/dataOperation';
import { weatherQueryContract, weatherObservationContract, agentQuestionContract, agentAnswerContract, type WeatherObservation, type AgentAnswer } from '../../../shared/set-runtime/providerContracts';
import {parseWeatherForecast,parseWeatherLocation,weatherLocationKey,type WeatherLocation} from '../../../shared/set-runtime/weather';
/** Managed providers. Packages supply typed inputs, never URLs or credentials. */
export type Connection =
 | {id:string;name:string;kind:'weather';provider:'open-meteo';latitude:number;longitude:number;location:string;units:'celsius'|'fahrenheit';pollSeconds:number}
 | {id:string;name:string;kind:'agent';provider:'openai'|'anthropic';model:string;webSearch:boolean;maxOutputTokens:number;workspaceId?:string};
export type AgentResult = AgentAnswer;
export type WeatherResult = WeatherObservation;
export class ProviderError extends Error {constructor(public code:string,message:string){super(message);}}
async function executeProvider<I,O>(provider:string,operation:string,input:DataContract<I>,output:DataContract<O>,value:unknown,perform:(input:I)=>Promise<unknown>):Promise<O>{
 const descriptor=dataAdapterRegistry.resolve(provider,1,operation,{input:input.id,output:output.id,delivery:'snapshot'});
 try{return await executeDataOperation(descriptor,input,output,value,perform);}
 catch(error){if(error instanceof DataValidationError)throw new ProviderError(error.stage==='input'?'invalid_request':'provider_response',error.message);throw error;}
}
export function validateWeatherResult(value:unknown):WeatherResult{
 try{return parseDataValue(weatherObservationContract,value,'output');}
 catch(error){if(error instanceof DataValidationError)throw new ProviderError('provider_response',error.message);throw error;}
}
const own=(o:object,k:string)=>Object.prototype.hasOwnProperty.call(o,k);
function object(v:unknown,allowed:string[],required=allowed):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v))throw new ProviderError('invalid_request','Object required');const o=v as Record<string,unknown>;if(Object.keys(o).some(k=>!allowed.includes(k))||required.some(k=>!own(o,k)))throw new ProviderError('invalid_request','Unknown or missing integration field');return o;}
function text(v:unknown,max:number){if(typeof v!=='string'||!v.trim()||v.length>max)throw new ProviderError('invalid_request','Invalid integration text');return v.trim();}
function number(v:unknown,min:number,max:number){if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)throw new ProviderError('invalid_request','Invalid integration number');return v;}
export function parseConnection(value:unknown):Connection{
 if(!value||typeof value!=='object')throw new ProviderError('invalid_request','Connection required');const kind=(value as {kind?:unknown}).kind;
 if(kind==='weather'){const o=object(value,['id','name','kind','provider','latitude','longitude','location','units','pollSeconds']);if(o.provider!=='open-meteo'||!['celsius','fahrenheit'].includes(String(o.units)))throw new ProviderError('invalid_request','Unsupported weather provider or units');return {id:identity(o.id),name:text(o.name,80),kind,provider:'open-meteo',latitude:number(o.latitude,-90,90),longitude:number(o.longitude,-180,180),location:text(o.location,120),units:o.units as 'celsius'|'fahrenheit',pollSeconds:number(o.pollSeconds,60,3600)};}
 if(kind==='agent'){const o=object(value,['id','name','kind','provider','model','webSearch','maxOutputTokens','workspaceId'],['id','name','kind','provider','model','webSearch','maxOutputTokens']);if(!['openai','anthropic'].includes(String(o.provider))||typeof o.webSearch!=='boolean')throw new ProviderError('invalid_request','Unsupported agent provider');const model=text(o.model,120);if(!/^[a-zA-Z0-9._:-]+$/.test(model))throw new ProviderError('invalid_request','Invalid model identifier');const maxOutputTokens=number(o.maxOutputTokens,256,4096);if(!Number.isInteger(maxOutputTokens))throw new ProviderError('invalid_request','Token budget must be an integer');return {id:identity(o.id),name:text(o.name,80),kind,provider:o.provider as 'openai'|'anthropic',model,webSearch:o.webSearch,maxOutputTokens,...(o.workspaceId!==undefined?{workspaceId:text(o.workspaceId,120)}:{})};}
 throw new ProviderError('invalid_request','Unsupported integration kind');
}
export function identity(v:unknown){const s=text(v,64);if(!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(s)||['constructor','prototype','__proto__'].includes(s))throw new ProviderError('invalid_request','Invalid connection identity');return s;}
async function readJson(response:Response,max=512000):Promise<Record<string,unknown>>{
 if(!response.ok){await response.body?.cancel();throw new ProviderError(response.status===401||response.status===403?'provider_auth':response.status===429?'provider_rate_limit':'provider_error',response.status===401||response.status===403?'Provider rejected this connection. Check its credentials and access.':response.status===429?'Provider rate limit reached. Try again later.':'Provider request failed ('+response.status+').');}
 const reader=response.body?.getReader();if(!reader)throw new ProviderError('provider_response','Provider returned no body');let length=0;const chunks:Uint8Array[]=[];
 try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>max)throw new ProviderError('provider_response','Provider response exceeded its budget');chunks.push(value);}}catch(e){await reader.cancel().catch(()=>{});throw e;}
 const bytes=new Uint8Array(length);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
 let parsed:unknown;try{parsed=JSON.parse(new TextDecoder().decode(bytes));}catch{throw new ProviderError('provider_response','Provider returned invalid JSON');}if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new ProviderError('provider_response','Provider returned an invalid object');return parsed as Record<string,unknown>;
}
function condition(code:number):WeatherResult['condition']{if(code===0)return 'clear';if(code>=1&&code<=3)return 'cloudy';if(code===45||code===48)return 'fog';if([71,73,75,77,85,86].includes(code))return 'snow';if([95,96,99].includes(code))return 'storm';if([51,53,55,56,57,61,63,65,66,67,80,81,82].includes(code))return 'rain';throw new ProviderError('provider_response','Unsupported weather condition code');}
export function weatherRequest(connection:Extract<Connection,{kind:'weather'}>,input?:unknown):WeatherLocation{
 if(input===undefined)return {id:'connection',label:connection.location,latitude:connection.latitude,longitude:connection.longitude,timezone:'UTC'};
 const o=object(input,['location'],[]);try{return o.location===undefined?weatherRequest(connection):parseWeatherLocation(o.location);}catch{throw new ProviderError('invalid_request','Invalid weather location');}
}
export async function weatherLocations(query:unknown,fetcher:typeof fetch=fetch):Promise<WeatherLocation[]>{
 const name=text(query,100);if(name.length<2)throw new ProviderError('invalid_request','Enter at least two city characters');
 const url=new URL('https://geocoding-api.open-meteo.com/v1/search');url.search=new URLSearchParams({name,count:'5',language:'en',format:'json'}).toString();
 const body=await readJson(await fetcher(url,{signal:AbortSignal.timeout(10000),redirect:'manual'}));
 if(body.results===undefined)return [];if(!Array.isArray(body.results)||body.results.length>5)throw new ProviderError('provider_response','Invalid city lookup');
 return body.results.map(raw=>{if(!raw||typeof raw!=='object')throw new ProviderError('provider_response','Invalid city');const r=raw as Record<string,unknown>;return parseWeatherLocation({id:String(number(r.id,1,1e12)),label:[text(r.name,80),typeof r.admin1==='string'?r.admin1:'',typeof r.country_code==='string'?r.country_code:''].filter(Boolean).join(', ').slice(0,120),latitude:number(r.latitude,-90,90),longitude:number(r.longitude,-180,180),timezone:r.timezone});});
}
export async function weather(connection:Extract<Connection,{kind:'weather'}>,fetcher:typeof fetch=fetch,input?:unknown):Promise<WeatherResult>{
 return executeProvider(connection.provider,'forecast',weatherQueryContract,weatherObservationContract,input===undefined?{}:input,query=>fetchWeather(connection,fetcher,query));
}
async function fetchWeather(connection:Extract<Connection,{kind:'weather'}>,fetcher:typeof fetch,input:unknown):Promise<WeatherResult>{
 const target=weatherRequest(connection,input),url=new URL('https://api.open-meteo.com/v1/forecast');
 url.search=new URLSearchParams({latitude:String(target.latitude),longitude:String(target.longitude),current:'temperature_2m,weather_code,is_day,wind_speed_10m,precipitation,apparent_temperature,relative_humidity_2m,cloud_cover,wind_direction_10m,wind_gusts_10m,visibility,surface_pressure',hourly:'temperature_2m,precipitation_probability,weather_code,is_day',daily:'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,sunrise,sunset,uv_index_max,wind_speed_10m_max',forecast_days:'8',temperature_unit:connection.units,wind_speed_unit:'kmh',timeformat:'unixtime',timezone:'auto'}).toString();
 const body=await readJson(await fetcher(url,{signal:AbortSignal.timeout(15000),redirect:'manual'}));const c=body.current;if(!c||typeof c!=='object'||Array.isArray(c))throw new ProviderError('provider_response','Weather observation missing');const current=c as Record<string,unknown>;
 const isDay=number(current.is_day,0,1);if(isDay!==0&&isDay!==1)throw new ProviderError('provider_response','Invalid day/night value');
 const observedAt=number(current.time,0,Date.now()/1000+300)*1000;
 const maybe=(v:unknown,min:number,max:number)=>v===undefined||v===null?null:number(v,min,max);
 const timezone=typeof body.timezone==='string'?body.timezone:target.timezone,utcOffsetSeconds=body.utc_offset_seconds===undefined?0:number(body.utc_offset_seconds,-50400,50400);
 const table=(value:unknown,columns:string[],max:number)=>{if(value===undefined)return undefined;const o=object(value,['time',...columns]);if(!Array.isArray(o.time)||o.time.length>max||columns.some(k=>!Array.isArray(o[k])||(o[k] as unknown[]).length!==(o.time as unknown[]).length))throw new ProviderError('provider_response','Forecast columns do not align');return o as Record<string,unknown[]>;};
 const hours=table(body.hourly,['temperature_2m','precipitation_probability','weather_code','is_day'],400),days=table(body.daily,['weather_code','temperature_2m_max','temperature_2m_min','precipitation_probability_max','precipitation_sum','sunrise','sunset','uv_index_max','wind_speed_10m_max'],16);
 const hourly=(hours?.time??[]).map((at,i)=>{const day=number(hours!.is_day[i],0,1);if(day!==0&&day!==1)throw new ProviderError('provider_response','Invalid hourly daylight');return {at:number(at,0,1e12)*1000,temperature:maybe(hours!.temperature_2m[i],-150,180),rainChance:maybe(hours!.precipitation_probability[i],0,100),condition:hours!.weather_code[i]===null?null:condition(number(hours!.weather_code[i],0,99)),isDay:day===1};}).filter(h=>h.at>=Math.floor(observedAt/3600000)*3600000).slice(0,48);
 const daily=(days?.time??[]).slice(0,7).map((at,i)=>({date:new Date((number(at,0,1e12)+utcOffsetSeconds)*1000).toISOString().slice(0,10),condition:days!.weather_code[i]===null?null:condition(number(days!.weather_code[i],0,99)),high:maybe(days!.temperature_2m_max[i],-150,180),low:maybe(days!.temperature_2m_min[i],-150,180),rainChance:maybe(days!.precipitation_probability_max[i],0,100),precipitation:maybe(days!.precipitation_sum[i],0,2000),sunrise:days!.sunrise[i]===null?null:number(days!.sunrise[i],0,1e12)*1000,sunset:days!.sunset[i]===null?null:number(days!.sunset[i],0,1e12)*1000,uv:maybe(days!.uv_index_max[i],0,30),wind:maybe(days!.wind_speed_10m_max[i],0,500)}));
 const forecast=parseWeatherForecast({timezone,utcOffsetSeconds,feelsLike:maybe(current.apparent_temperature,-150,180),humidity:maybe(current.relative_humidity_2m,0,100),cloudCover:maybe(current.cloud_cover,0,100),gusts:maybe(current.wind_gusts_10m,0,500),windDirection:maybe(current.wind_direction_10m,0,360),visibility:maybe(current.visibility,0,1000000),pressure:maybe(current.surface_pressure,500,1200),hourly,daily});
 return {observedAt,temperature:number(current.temperature_2m,-150,180),condition:condition(number(current.weather_code,0,99)),isDay:isDay===1,wind:number(current.wind_speed_10m,0,500),precipitation:number(current.precipitation,0,1000),provider:'Open-Meteo',location:target.label,units:connection.units,forecast,requestKey:weatherLocationKey(target,connection.units)};
}
async function openaiAgent(connection:Extract<Connection,{kind:'agent'}>,key:string,input:unknown,fetcher:typeof fetch=fetch):Promise<AgentResult>{
 const o=object(input,['question','mode','instructions'],['question','mode']);const question=text(o.question,1000),instructions=o.instructions===undefined?'':text(o.instructions,1000);if(o.mode!=='answer'&&o.mode!=='factCheck')throw new ProviderError('invalid_request','Invalid agent mode');
 if(o.mode==='factCheck'&&!connection.webSearch)throw new ProviderError('capability_unavailable','Enable web research on this saved connection for fact checks.');
 const researched=o.mode==='factCheck';const body={model:connection.model,input:question,instructions:instructions+'\n'+(researched?'Research this question using the web. Distinguish supported facts, uncertainty and conflicting evidence. Cite sources in your answer. Do not claim certainty beyond the evidence. Keep the answer suitable for a broadcast response panel.':'Answer the question concisely for a broadcast discussion. State uncertainty when appropriate. Do not invent citations.'),store:false,max_output_tokens:connection.maxOutputTokens,...(researched?{tools:[{type:'web_search'}],tool_choice:'required'}:{})};
 const result=await readJson(await fetcher('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(90000),redirect:'manual'}));
 if(result.status!=='completed')throw new ProviderError('provider_incomplete','The provider did not complete the response. Review the connection or token budget.');
 const output=Array.isArray(result.output)?result.output:[];const texts:string[]=[];const citations:AgentResult['citations']=[];let searched=false,offset=0;
 for(const item of output){if(!item||typeof item!=='object')continue;const v=item as Record<string,unknown>;if(v.type==='web_search_call'&&v.status==='completed')searched=true;
  if(v.type!=='message'||!Array.isArray(v.content))continue;for(const content of v.content){if(!content||content.type!=='output_text'||typeof content.text!=='string')continue;const answer=content.text;
   if(Array.isArray(content.annotations))for(const a of content.annotations){if(!a||a.type!=='url_citation'||typeof a.url!=='string'||typeof a.title!=='string')continue;let url:URL;try{url=new URL(a.url);}catch{continue;}if(url.protocol!=='https:'||url.username||url.password||url.href.length>2000)continue;const start=typeof a.start_index==='number'?a.start_index:undefined,end=typeof a.end_index==='number'?a.end_index:undefined;citations.push({title:a.title.slice(0,160),url:url.href,...(Number.isInteger(start)&&Number.isInteger(end)&&start!>=0&&end!>start!&&end!<=answer.length?{start:offset+start!,end:offset+end!}:{})});}
   texts.push(answer);offset+=answer.length+2;
  }
 }
 const response=texts.join('\n\n');if(!response.trim()||response.length>16000||citations.length>20)throw new ProviderError('provider_response','Response is empty or exceeds the broadcast budget');if(researched&&(!searched||!citations.length))throw new ProviderError('provider_evidence','The provider did not return a completed web search with source citations.');
 return {response,citations,researched,model:connection.model};
}
async function claudeAgent(connection:Extract<Connection,{kind:'agent'}>,key:string,input:unknown,fetcher:typeof fetch):Promise<AgentResult>{
 const o=object(input,['question','mode','instructions'],['question','mode']);const question=text(o.question,1000),instructions=o.instructions===undefined?'':text(o.instructions,1000);if(o.mode!=='answer'&&o.mode!=='factCheck')throw new ProviderError('invalid_request','Invalid agent mode');
 const researched=o.mode==='factCheck';if(researched&&!connection.webSearch)throw new ProviderError('capability_unavailable','Enable web research on this saved connection for fact checks.');
 const result=await readJson(await fetcher('https://api.anthropic.com/v1/messages',{method:'POST',headers:claudeHeaders(connection,key),signal:AbortSignal.timeout(90000),redirect:'manual',body:JSON.stringify({model:connection.model,max_tokens:connection.maxOutputTokens,system:instructions+'\n'+(researched?'Search the web to investigate this question. Cite evidence, distinguish supported facts from uncertainty, and keep the answer concise for a broadcast panel. Do not present unsupported claims as verified.':'Answer concisely for a broadcast discussion. State uncertainty and do not invent citations.'),messages:[{role:'user',content:question}],...(researched?{tools:[{type:'web_search_20250305',name:'web_search',max_uses:3}]}:{})})}));
 if(result.stop_reason!=='end_turn')throw new ProviderError('provider_incomplete',result.stop_reason==='pause_turn'?'Claude paused this research turn before completion. Try a more focused question.':'Claude did not complete the response. Review the connection or output budget.');
 const content=Array.isArray(result.content)?result.content:[];const texts:string[]=[];const citations:AgentResult['citations']=[];let searched=false,offset=0;
 for(const block of content){if(!block||typeof block!=='object')continue;
  if(block.type==='web_search_tool_result'&&Array.isArray(block.content)&&block.content.some((c:any)=>c?.type==='web_search_result'))searched=true;
  if(block.type!=='text'||typeof block.text!=='string')continue;
  if(Array.isArray(block.citations))for(const c of block.citations){if(c?.type!=='web_search_result_location'||typeof c.url!=='string'||typeof c.title!=='string')continue;let url:URL;try{url=new URL(c.url);}catch{continue;}if(url.protocol!=='https:'||url.username||url.password||url.href.length>2000)continue;citations.push({title:c.title.slice(0,160),url:url.href,start:offset,end:offset+block.text.length});}
  texts.push(block.text);offset+=block.text.length+2;
 }
 const response=texts.join('\n\n');if(!response.trim()||response.length>16000||citations.length>20)throw new ProviderError('provider_response','Claude response is empty or exceeds the broadcast budget');if(researched&&(!searched||!citations.length))throw new ProviderError('provider_evidence','Claude did not return completed web research with source citations.');
 return {response,citations,researched,model:connection.model};
}
function claudeHeaders(connection:Extract<Connection,{kind:'agent'}>,key:string){return {Authorization:'Bearer '+key,'anthropic-version':'2026-10-21','Content-Type':'application/json',...(connection.workspaceId?{'anthropic-workspace-id':connection.workspaceId}:{})};}
export async function agent(connection:Extract<Connection,{kind:'agent'}>,key:string,input:unknown,fetcher:typeof fetch=fetch):Promise<AgentResult>{return executeProvider(connection.provider,'answer',agentQuestionContract,agentAnswerContract,input,query=>connection.provider==='anthropic'?claudeAgent(connection,key,query,fetcher):openaiAgent(connection,key,query,fetcher));}
export async function testConnection(connection:Connection,key:string|undefined,fetcher:typeof fetch=fetch){
 if(connection.kind==='weather')return {ok:true,sample:await weather(connection,fetcher)};
 if(!key)throw new ProviderError('provider_auth','Save an API key for this connection first.');
 const claude=connection.provider==='anthropic';await readJson(await fetcher((claude?'https://api.anthropic.com':'https://api.openai.com')+'/v1/models/'+encodeURIComponent(connection.model),{headers:claude?claudeHeaders(connection,key):{Authorization:'Bearer '+key},signal:AbortSignal.timeout(15000),redirect:'manual'}));return {ok:true};
}
