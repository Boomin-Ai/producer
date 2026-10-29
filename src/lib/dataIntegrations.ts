import type {WeatherLocation} from '../../shared/set-runtime/weather';
import {guests as guestsIpc} from './ipc';
import type {Connection,AgentResult,WeatherResult} from '../../server/src/dataIntegrations/providers';
export type {Connection,AgentResult,WeatherResult};
export interface SavedConnection {connection:Connection;revision:number;hasSecret:boolean;status:'unverified'|'ready'|'error';error:string;testedAt:number|null}
async function call<T>(endpoint:string,method:'GET'|'POST'|'DELETE',path:string,body?:unknown):Promise<T>{
 const result=await guestsIpc.request(endpoint,method,'/v1/app/data-integrations'+path,body);
 if(!result.available)throw Error('This workspace server does not support data integrations yet.');
 return result.body as T;
}
export const dataIntegrations={
 authorSet:(endpoint:string,id:string,body:{expectedRevision:number;prompt:string;package?:import('../features/presentation/schema').PresentationPackage})=>call<import('../features/presentation/setAuthoring').AuthoringReply>(endpoint,'POST','/'+encodeURIComponent(id)+'/author-set',body),
 locations:(endpoint:string,query:string)=>call<{locations:WeatherLocation[]}>(endpoint,'GET','/locations?query='+encodeURIComponent(query)),
 list:(endpoint:string)=>call<{connections:SavedConnection[];capabilities:string[]}>(endpoint,'GET',''),
 save:(endpoint:string,connection:Connection,apiKey?:string,expectedRevision?:number)=>call<SavedConnection>(endpoint,'POST','',{connection,...(apiKey?{apiKey}:{}),...(expectedRevision!==undefined?{expectedRevision}:{})}),
 remove:(endpoint:string,saved:SavedConnection)=>call<{deleted:boolean}>(endpoint,'DELETE','/'+encodeURIComponent(saved.connection.id),{expectedRevision:saved.revision}),
 test:(endpoint:string,saved:SavedConnection)=>call<{ok:boolean;connectionRevision:number;sample?:WeatherResult}>(endpoint,'POST','/'+encodeURIComponent(saved.connection.id)+'/test',{}),
 query:(endpoint:string,saved:SavedConnection,input?:{question:string;mode:'answer'|'factCheck';instructions?:string}|{location?:WeatherLocation},options:{refresh?:boolean}={})=>call<{connectionId:string;connectionRevision:number;result:AgentResult|WeatherResult;cached?:boolean;stale?:boolean;cache?:{fetchedAt:number;expiresAt:number}}>(endpoint,'POST','/'+encodeURIComponent(saved.connection.id)+'/query',{expectedRevision:saved.revision,...(input?{input}:{}),...(options.refresh?{refresh:true}:{})}),
};
