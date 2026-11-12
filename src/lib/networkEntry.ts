export type EntryReply={available:boolean;status:number;body?:unknown};
export class NetworkEntryError extends Error{
 constructor(readonly code:string,readonly status:number,message:string){super(message);}
}
const messages:Record<string,string>={
 network_room_closed:'The host’s room connection is not ready. Wait for the host to finish reopening the room, then try Enter again.',
 rtc_network_entry_superseded:'This invitation was replaced. Choose Enter again to request the current invitation.',
 rtc_request_reused:'This entry attempt is no longer valid. Choose Enter again to start a fresh request.',
 guest_not_acceptable:'The host is not accepting this guest seat. Check with the host before trying again.',
 guest_room_full:'This room has reached its guest limit.',
};
function failure(reply:EntryReply):NetworkEntryError{
 const value=reply.body&&typeof reply.body==='object'?reply.body as Record<string,unknown>:{};
 const nested=value.error&&typeof value.error==='object'?value.error as Record<string,unknown>:{};
 const rawCode=value.code??nested.code;
 const code=typeof rawCode==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(rawCode)?rawCode:'';
 const rawMessage=value.message??nested.message??(typeof value.error==='string'?value.error:undefined);
 const message=messages[code]??(typeof rawMessage==='string'&&rawMessage.trim()?rawMessage.trim().slice(0,400):'This server could not open the Producer guest seat.');
 return new NetworkEntryError(code,reply.status,message);
}
/** At most one knock per endpoint/target. A lost response retries the same
 * operation. A completed or definitively invalid operation is retired; only a
 * later user action can create its successor. Admission remains server-owned. */
export class NetworkEntryRequests{
 private pending=new Map<string,Promise<unknown>>();
 private ids=new Map<string,string>();
 async enter<T>(key:string,request:(requestId:string)=>Promise<EntryReply>):Promise<T>{
  if(this.pending.has(key))return this.pending.get(key) as Promise<T>;
  if(!this.ids.has(key)){if(this.ids.size>=32)this.ids.delete(this.ids.keys().next().value!);this.ids.set(key,crypto.randomUUID());}
  const id=this.ids.get(key)!;
  const task=(async()=>{
   const reply=await request(id);const body=reply.body as {join_url?:unknown}|undefined;
   if(!reply.available||reply.status<200||reply.status>=300||typeof body?.join_url!=='string'||!body.join_url){
    const error=failure(reply);
    // A lost/uncertain response must replay the same operation. These explicit
    // server rejections instead prove that this receipt can no longer be used.
    if(reply.available&&reply.status===409&&['rtc_network_entry_superseded','rtc_request_reused','guest_not_acceptable'].includes(error.code))this.ids.delete(key);
    throw error;
   }
   this.ids.delete(key);return body as T;
  })();
  this.pending.set(key,task);
  try{return await task;}finally{if(this.pending.get(key)===task)this.pending.delete(key);}
 }
}
