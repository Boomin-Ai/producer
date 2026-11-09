export type NetworkMessage={id:string;connection_id:string;sequence:number;sender_brand_id:string;client_message_id:string;text:string;created_at:string};
export type NetworkConversation={id:string;status:string;counterparty:{id:string;name:string;slug:string;avatar_url:string|null};blocked_by_you:boolean;messaging_blocked:boolean;can_send:boolean;can_manage?:boolean;unread_count:number;last_message:NetworkMessage|null};
export type MessagePage={messages:NetworkMessage[];has_more:boolean};
export interface MessagesClient {
 list():Promise<NetworkConversation[]>;
 read(id:string,cursor?:{before?:number;after?:number}):Promise<MessagePage>;
 send(id:string,clientId:string,text:string):Promise<NetworkMessage>;
 markRead(id:string,messageId:string):Promise<void>;
 block(id:string,blocked:boolean):Promise<void>;
 subscribe(changed:()=>void,status:(live:boolean)=>void):()=>void;
}
export class MessagesUnavailable extends Error {readonly code='network_messages_unavailable';}
export type PendingMessage={clientId:string;text:string;status:'sending'|'failed';error?:string};
export type MessagesState={status:'loading'|'ready'|'unavailable'|'error';conversations:NetworkConversation[];selected:string|null;messages:NetworkMessage[];loadingThread:boolean;loadingOlder:boolean;hasOlder:boolean;draft:string;pending?:PendingMessage;error:string;realtime:boolean};
const messageLimit=500;
const last=<T,>(rows:T[])=>rows[rows.length-1];
// Native EngineError rejects with a string across Tauri IPC, not an Error.
const failure=(error:unknown)=>error instanceof Error?error.message:typeof error==='string'&&error.trim()?error.trim():'Messages could not load. Try again.';
const unavailable=(error:unknown)=>error instanceof MessagesUnavailable||!!error&&typeof error==='object'&&'code'in error&&error.code==='network_messages_unavailable';
function merge(before:NetworkMessage[],after:NetworkMessage[]){
 const rows=new Map(before.map(row=>[row.id,row]));for(const row of after)rows.set(row.id,row);
 return [...rows.values()].sort((a,b)=>a.sequence-b.sequence).slice(-messageLimit);
}

/** One endpoint, one subscription. No private message bodies enter app-wide caches. */
export class NetworkMessagesController {
 private state:MessagesState={status:'loading',conversations:[],selected:null,messages:[],loadingThread:false,loadingOlder:false,hasOlder:false,draft:'',error:'',realtime:false};
 private listeners=new Set<()=>void>();
 private closed=false;private started=false;private visible=true;private readable=false;
 private refreshing=false;private again=false;private threadGeneration=0;private threadBusy=false;private threadAgain=false;
 private poll?:ReturnType<typeof setTimeout>;private invalidation?:ReturnType<typeof setTimeout>;private unsubscribe?:()=>void;
 private drafts=new Map<string,string>();private outbox=new Map<string,PendingMessage>();private acknowledged=new Map<string,number>();private reading=new Set<string>();
 constructor(private client:MessagesClient,private uuid:()=>string=()=>crypto.randomUUID()){}
 snapshot=()=>this.state;
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
 private update(patch:Partial<MessagesState>){if(this.closed)return;this.state={...this.state,...patch};for(const listener of this.listeners)listener();}
 start(){if(this.started||this.closed)return;this.started=true;void this.refresh();}
 close(){this.closed=true;this.threadGeneration++;clearTimeout(this.poll);clearTimeout(this.invalidation);this.unsubscribe?.();this.unsubscribe=undefined;this.drafts.clear();this.outbox.clear();this.listeners.clear();}
 setVisible(visible:boolean){
  if(this.visible===visible||this.closed)return;this.visible=visible;
  if(!visible){this.readable=false;clearTimeout(this.poll);clearTimeout(this.invalidation);this.unsubscribe?.();this.unsubscribe=undefined;this.update({realtime:false});}
  else if(this.started){void this.refresh();}
 }
 setReadVisible(visible:boolean){this.readable=visible; if(visible)void this.acknowledge();}
 private connect(){
  if(this.unsubscribe||!this.visible||this.closed||this.state.status!=='ready')return;
  this.unsubscribe=this.client.subscribe(()=>{
   if(this.invalidation||this.closed||!this.visible)return;
   this.invalidation=setTimeout(()=>{this.invalidation=undefined;void this.refresh();},120);
  },live=>{this.update({realtime:live});this.schedule();if(live)void this.refresh();});
 }
 private schedule(){clearTimeout(this.poll);if(this.closed||!this.visible||this.state.status==='unavailable')return;this.poll=setTimeout(()=>void this.refresh(),this.state.realtime?30000:7000);}
 refresh=async()=>{
  if(this.closed||!this.visible)return;if(this.refreshing){this.again=true;return;}this.refreshing=true;clearTimeout(this.poll);
  try{
   const conversations=await this.client.list();if(this.closed||!this.visible)return;
   this.update({status:'ready',conversations,error:''});this.connect();
   if(this.state.selected&&!conversations.some(row=>row.id===this.state.selected))this.select(null);
   if(!this.state.selected&&conversations.length)this.select(conversations[0].id);
   else if(this.state.selected)await this.refreshThread();
  }catch(error){if(!this.closed&&this.visible){if(unavailable(error)){this.unsubscribe?.();this.unsubscribe=undefined;}this.update({status:unavailable(error)?'unavailable':this.state.status==='ready'?'ready':'error',error:failure(error)});}}
  finally{this.refreshing=false;const again=this.again;this.again=false;if(again&&!this.closed&&this.visible)void this.refresh();else this.schedule();}
 };
 select(id:string|null){
  if(this.closed||id===this.state.selected||id&&!this.state.conversations.some(row=>row.id===id))return;
  this.threadGeneration++;this.threadBusy=false;this.threadAgain=false;this.readable=false;
  this.update({selected:id,messages:[],loadingThread:!!id,loadingOlder:false,hasOlder:false,draft:id?this.drafts.get(id)??'':'',pending:id?this.outbox.get(id):undefined,error:''});
  if(id)void this.refreshThread(true);
 }
 private async refreshThread(initial=false){
  const id=this.state.selected,generation=this.threadGeneration;if(!id||this.closed)return;
  if(this.threadBusy){this.threadAgain=true;return;}this.threadBusy=true;
  try{
   // Drain bounded delta pages after reconnect; never reload an entire thread.
   let after=initial?undefined:last(this.state.messages)?.sequence;
   for(let page=0;page<6;page++){
    const firstPage=after===undefined,reply=await this.client.read(id,firstPage?undefined:{after});
    if(this.closed||generation!==this.threadGeneration||id!==this.state.selected)return;
    const previous=this.state.messages,next=merge(previous,reply.messages);
    this.update({messages:next,loadingThread:false,hasOlder:firstPage?reply.has_more:this.state.hasOlder||previous.length+reply.messages.length>messageLimit,error:''});
    initial=false;after=last(next)?.sequence;
    if(firstPage||!reply.has_more||!reply.messages.length)break;
    if(page===5)this.threadAgain=true;
   }
   void this.acknowledge();
  }catch(error){if(!this.closed&&generation===this.threadGeneration)this.update({loadingThread:false,error:failure(error)});}
  finally{if(generation===this.threadGeneration){this.threadBusy=false;const again=this.threadAgain;this.threadAgain=false;if(again&&this.visible&&!this.closed)void this.refreshThread();}}
 }
 older=async()=>{
  const id=this.state.selected,first=this.state.messages[0],generation=this.threadGeneration;
  if(!id||!first||this.state.loadingOlder||!this.state.hasOlder||this.state.messages.length>=messageLimit)return;
  this.update({loadingOlder:true});
  try{const reply=await this.client.read(id,{before:first.sequence});if(this.closed||generation!==this.threadGeneration)return;this.update({messages:merge(reply.messages,this.state.messages),hasOlder:reply.has_more,error:''});}
  catch(error){if(generation===this.threadGeneration)this.update({error:failure(error)});}
  finally{if(generation===this.threadGeneration)this.update({loadingOlder:false});}
 };
 setDraft(text:string){const id=this.state.selected;if(!id||this.closed)return;this.drafts.set(id,text);this.update({draft:text});}
 send=async()=>{
  const id=this.state.selected,row=this.state.conversations.find(c=>c.id===id),text=this.state.draft.replace(/\r\n/g,'\n').trim();
  if(!id||!row?.can_send||this.outbox.has(id)||!text)return;
  if([...text].length>4000){this.update({error:'Write a message of up to 4,000 characters.'});return;}
  const pending:PendingMessage={clientId:this.uuid(),text,status:'sending'};this.outbox.set(id,pending);this.update({pending,error:''});await this.deliver(id,pending);
 };
 retrySend=async()=>{const id=this.state.selected,pending=id?this.outbox.get(id):undefined;if(!id||pending?.status!=='failed')return;const retry={...pending,status:'sending' as const,error:undefined};this.outbox.set(id,retry);this.update({pending:retry});await this.deliver(id,retry);};
 dismissFailed(){const id=this.state.selected;if(id&&this.outbox.get(id)?.status==='failed'){this.outbox.delete(id);this.update({pending:undefined});}}
 private async deliver(id:string,pending:PendingMessage){
  try{const message=await this.client.send(id,pending.clientId,pending.text);if(this.closed)return;this.outbox.delete(id);
   if(this.drafts.get(id)?.trim()===pending.text)this.drafts.set(id,'');
   if(this.state.selected===id)this.update({messages:merge(this.state.messages,[message]),pending:undefined,draft:this.drafts.get(id)??'',error:''});
   void this.refresh();
  }catch(error){if(this.closed)return;const failed={...pending,status:'failed' as const,error:failure(error)};this.outbox.set(id,failed);if(this.state.selected===id)this.update({pending:failed});}
 }
 private async acknowledge(){
  const id=this.state.selected,message=last(this.state.messages);if(!id||!message||this.closed||!this.visible||!this.readable||this.state.loadingThread||this.reading.has(id)||(this.acknowledged.get(id)??0)>=message.sequence)return;
  this.reading.add(id);
  try{await this.client.markRead(id,message.id);if(this.closed)return;this.acknowledged.set(id,message.sequence);
   // A newer unseen message must not be cleared by an older read receipt.
   this.update({conversations:this.state.conversations.map(c=>c.id===id&&(!c.last_message||c.last_message.sequence<=message.sequence)?{...c,unread_count:0}:c)});
  }catch{/* Retry only when the visible thread changes or a future refresh succeeds. */}
  finally{this.reading.delete(id);if(this.state.selected===id&&last(this.state.messages)?.sequence!==message.sequence)void this.acknowledge();}
 }
 block=async(blocked:boolean)=>{const id=this.state.selected,row=this.state.conversations.find(c=>c.id===id);if(!id||row?.can_manage===false)return;try{await this.client.block(id,blocked);if(!this.closed)await this.refresh();}catch(error){this.update({error:failure(error)});}};
}
