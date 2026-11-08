export type EntryReply={available:boolean;status:number;body?:unknown};
/** At most one knock per endpoint/target. A lost response retries the same
 * operation, while an acknowledged entry makes the next click a fresh entry. */
export class NetworkEntryRequests{
 private pending=new Map<string,Promise<unknown>>();
 private ids=new Map<string,string>();
 async enter<T>(key:string,request:(requestId:string)=>Promise<EntryReply>):Promise<T>{
  if(this.pending.has(key))return this.pending.get(key) as Promise<T>;
  if(!this.ids.has(key)){if(this.ids.size>=32)this.ids.delete(this.ids.keys().next().value!);this.ids.set(key,crypto.randomUUID());}
  const id=this.ids.get(key)!;
  const task=(async()=>{
   const reply=await request(id);const body=reply.body as {join_url?:string;error?:{code?:string;message?:string}}|undefined;
   if(!reply.available||reply.status<200||reply.status>=300||!body?.join_url)throw Error(`${body?.error?.code?body.error.code+': ':''}${body?.error?.message??'This server could not open the Producer guest seat.'}`);
   this.ids.delete(key);return body as T;
  })();
  this.pending.set(key,task);
  try{return await task;}finally{if(this.pending.get(key)===task)this.pending.delete(key);}
 }
}
