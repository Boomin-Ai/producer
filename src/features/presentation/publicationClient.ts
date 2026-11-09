import {guests} from '../../lib/ipc';

export type PublicationVisibility='private'|'unlisted'|'public';
export interface PublishedSet {
 id:string;handle:string;slug:string;title:string;description:string;status:'draft'|'published'|'withdrawn';
 visibility:PublicationVisibility;revision:number;version:number;sha256:string;byte_length:number;
 layout_count:number;orientations:string[];
}
export interface PublisherProfile {handle:string;name:string;editable:boolean;}
export interface PublicationUpload {
 title:string;description:string;visibility:PublicationVisibility;package_text:string;
 thumbnail?:{mime_type:'image/png'|'image/jpeg';data_base64:string};
}
/** Same bounded metadata admission for controls and transport callers. */
export function publicationMetadataIssue(value:Pick<PublicationUpload,'title'|'description'>):string|null {
 if(typeof value.title!=='string'||!value.title.trim()||value.title.length>160)return 'Title must contain 1–160 characters.';
 if(typeof value.description!=='string'||value.description.length>2000)return 'Description must be 2,000 characters or fewer.';
 return null;
}
export class PublicationError extends Error {
 constructor(readonly code:'unavailable'|'conflict'|'denied'|'rejected'|'failed'|'invalid_response'){
  super(code==='unavailable'?'Publishing is not available for this workspace.':code==='conflict'?'This publication or handle changed. Reload before trying again.':
   code==='denied'?'Your workspace role does not allow this action.':code==='rejected'?'The request was rejected. Check your title, description, address and package, then try again.':code==='invalid_response'?'The publishing service returned an unexpected response.':'The request could not be confirmed. Retry uses the same upload request.');
 }
}
type Request=(endpoint:string,method:'GET'|'POST'|'PATCH',path:string,body?:unknown)=>Promise<{available:boolean;status:number;body?:unknown}>;
const BASE='/v1/app/producer/v1';
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const bounded=(value:unknown,max:number)=>typeof value==='string'&&value.length<=max?value:null;
const handle=(value:unknown)=>typeof value==='string'&&value.length<=80&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)?value:null;
const integer=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
export function publicationLinks(item:Pick<PublishedSet,'handle'|'slug'>){
 const url=`https://producer.dev/${encodeURIComponent(item.handle)}/set/${encodeURIComponent(item.slug)}`;
 return {url,download_url:url+'/download'};
}
function parsePublication(value:unknown):PublishedSet {
 const p=object(value);
 if(!bounded(p.id,160)||!handle(p.handle)||!handle(p.slug)||!bounded(p.title,160)||bounded(p.description??'',2000)===null||
  !['draft','published','withdrawn'].includes(String(p.status))||!['private','unlisted','public'].includes(String(p.visibility))||
  !integer(p.revision)||!integer(p.version)||typeof p.sha256!=='string'||!/^[a-f0-9]{64}$/i.test(p.sha256)||!integer(p.byte_length)||
  !integer(p.layout_count)||!Array.isArray(p.orientations)||p.orientations.length>3||p.orientations.some(v=>!['landscape','portrait','square'].includes(String(v))))throw new PublicationError('invalid_response');
 return {id:p.id as string,handle:p.handle as string,slug:p.slug as string,title:p.title as string,description:(p.description??'') as string,
  status:p.status as PublishedSet['status'],visibility:p.visibility as PublicationVisibility,revision:p.revision as number,version:p.version as number,
  sha256:p.sha256,byte_length:p.byte_length as number,layout_count:p.layout_count as number,orientations:p.orientations as string[]};
}
function classify(error:unknown):PublicationError {
 if(error instanceof PublicationError)return error;
 const text=String(error);
 if(/(?:\b409\b|revision_conflict|idempotency_conflict|handle_taken|slug_taken)/i.test(text))return new PublicationError('conflict');
 if(/(?:\b40[13]\b|forbidden|unauthorized)/i.test(text))return new PublicationError('denied');
 if(/endpoint returned HTTP (?:400|422)\b/i.test(text))return new PublicationError('rejected');
 return new PublicationError('failed');
}
export function createPublicationClient(endpoint:string,request:Request=guests.request){
 async function call(method:'GET'|'POST'|'PATCH',path:string,body?:unknown){
  try{
   // Native credentials remain behind endpoint_request; never accept a URL.
   let timer:ReturnType<typeof setTimeout>|undefined;
   const reply=await Promise.race([request(endpoint,method,BASE+path,body),new Promise<never>((_,reject)=>{
    timer=setTimeout(()=>reject(new PublicationError('failed')),30000);
   })]).finally(()=>clearTimeout(timer));
   if(!reply.available||reply.status===404)throw new PublicationError('unavailable');
   if(reply.status===409)throw new PublicationError('conflict');
   if(reply.status===401||reply.status===403)throw new PublicationError('denied');
   if(reply.status===400||reply.status===422)throw new PublicationError('rejected');
   if(reply.status<200||reply.status>=300)throw new PublicationError('failed');
   return object(reply.body);
  }catch(error){throw classify(error);}
 }
 return {
  async list(){const reply=await call('GET','/sets/publications');if(!Array.isArray(reply.publications)||reply.publications.length>200)throw new PublicationError('invalid_response');return reply.publications.map(parsePublication);},
  async profile():Promise<PublisherProfile>{const body=await call('GET','/profile'),p=object(body.profile??body);if(!handle(p.handle)||!bounded(p.name,160)||typeof p.editable!=='boolean')throw new PublicationError('invalid_response');return {handle:p.handle as string,name:p.name as string,editable:p.editable};},
  async upload(value:PublicationUpload&{slug?:string;expected_revision?:number},key:string,id?:string){
   if(publicationMetadataIssue(value))throw new PublicationError('rejected');
   const body=await call('POST',id?`/sets/publications/${encodeURIComponent(id)}/versions`:'/sets/publications',{...value,idempotency_key:key});
   return parsePublication(body.publication);
  },
  async status(item:PublishedSet,status:'published'|'withdrawn',key:string,visibility=item.visibility){
   const body=await call('PATCH',`/sets/publications/${encodeURIComponent(item.id)}`,{status,visibility,expected_revision:item.revision,idempotency_key:key});
   return parsePublication(body.publication);
  },
 };
}
export type PublicationClient=ReturnType<typeof createPublicationClient>;

/** One ambiguous upload retains its exact payload/key until success or an
 * explicit discard. The caller cannot silently turn a retry into another Set. */
export function createPublicationUpload(client:PublicationClient,uuid=()=>crypto.randomUUID()){
 type Intent={kind:'upload';value:PublicationUpload&{slug?:string;expected_revision?:number};key:string;id?:string}|
  {kind:'status';item:PublishedSet;status:'published'|'withdrawn';visibility:PublicationVisibility;key:string};
 let pending:Intent|null=null;
 let running:Promise<PublishedSet>|null=null;
 const send=()=>{
  if(running)return running;
  if(!pending)return Promise.reject(new PublicationError('failed'));
  const intent=pending;
  const write=intent.kind==='upload'?client.upload(intent.value,intent.key,intent.id):client.status(intent.item,intent.status,intent.key,intent.visibility);
  const promise=write.then(value=>{if(pending===intent)pending=null;return value;},error=>{
   // A definite admission rejection did not publish. Let the user edit it;
   // only an uncertain response retains a retryable, immutable operation.
   if(error instanceof PublicationError&&error.code==='rejected'&&pending===intent)pending=null;
   throw error;
  });
  running=promise;void promise.then(()=>{if(running===promise)running=null;},()=>{if(running===promise)running=null;});return promise;
 };
 return {start(value:PublicationUpload&{slug?:string;expected_revision?:number},id?:string){if(pending)return Promise.reject(new PublicationError('conflict'));pending={kind:'upload',value:structuredClone(value),key:uuid(),id};return send();},
  changeStatus(item:PublishedSet,status:'published'|'withdrawn',visibility=item.visibility){if(pending)return Promise.reject(new PublicationError('conflict'));pending={kind:'status',item:structuredClone(item),status,visibility,key:uuid()};return send();},
  retry:send,hasPending:()=>!!pending,discard(){if(!running)pending=null;}};
}
