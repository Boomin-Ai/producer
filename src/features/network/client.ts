import {guests,type EndpointInfo} from '../../lib/ipc';
import {MessagesUnavailable,type MessagesClient,type NetworkConversation,type NetworkMessage,type MessagePage} from './controller';

const route='/v1/app/network/conversations';
export function createMessagesClient(endpoint:EndpointInfo):MessagesClient {
 async function request<T>(method:'GET'|'POST',path:string,body?:unknown):Promise<T>{
  const result=await guests.request(endpoint.id,method,path,body);
  if(!result.available||result.status===404||result.status===501)throw new MessagesUnavailable('This server does not provide network messages. Guest room links still work.');
  if(result.status<200||result.status>=300){const value=result.body as {error?:{message?:string}|string;message?:string}|undefined;throw Error(typeof value?.error==='object'?value.error.message:typeof value?.error==='string'?value.error:value?.message??'Messages are unavailable. Check workspace access and try again.');}
  return result.body as T;
 }
 return {
  list:async()=>{const r=await request<{conversations:NetworkConversation[]}>('GET',route);return r.conversations;},
  read:(id,cursor)=>{const query=cursor?.before!==undefined?'?before='+cursor.before:cursor?.after!==undefined?'?after='+cursor.after:'';return request<MessagePage>('GET',route+'/'+encodeURIComponent(id)+'/messages'+query);},
  send:async(id,client_message_id,text)=>(await request<{message:NetworkMessage}>('POST',route+'/'+encodeURIComponent(id)+'/messages',{client_message_id,text})).message,
  markRead:async(id,message_id)=>{await request('POST',route+'/'+encodeURIComponent(id)+'/read',{message_id});},
  block:async(id,blocked)=>{await request('POST',route+'/'+encodeURIComponent(id)+'/block',{blocked});},
  subscribe(changed,status){
   let closed=false,socket:WebSocket|undefined,retry:ReturnType<typeof setTimeout>|undefined,heartbeat:ReturnType<typeof setInterval>|undefined,attempt=0,lastFrame=0;
   const clear=()=>{clearInterval(heartbeat);heartbeat=undefined;};
   const reconnect=()=>{clear();if(closed)return;status(false);clearTimeout(retry);retry=setTimeout(()=>void connect(),Math.min(30000,1000*2**Math.min(attempt++,5)));};
   async function connect(){
    if(closed)return;
    try{
     const {ticket}=await request<{ticket:string}>('POST',route+'/realtime/ticket');if(closed)return;
     const base=endpoint.base_url.split('/v1/')[0].replace(/\/$/,'');const url=new URL(base+route+'/realtime');if(!['https:','http:'].includes(url.protocol))throw Error('Unsupported message endpoint');url.protocol=url.protocol==='https:'?'wss:':'ws:';url.searchParams.set('ticket',ticket);
     const ws=new WebSocket(url);socket=ws;lastFrame=Date.now();
     ws.onopen=()=>{if(closed||socket!==ws){ws.close();return;}ws.send(JSON.stringify({type:'subscribe',channel:'network_chat'}));
      heartbeat=setInterval(()=>{if(Date.now()-lastFrame>45000)ws.close();else if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'ping'}));},20000);
     };
     ws.onmessage=event=>{if(closed||socket!==ws||typeof event.data!=='string'||event.data.length>65536)return;try{const frame=JSON.parse(event.data);lastFrame=Date.now();if(frame.type==='subscribed'&&frame.channel==='network_chat'){attempt=0;status(true);}else if(frame.action==='changed'&&Array.isArray(frame.channels)&&frame.channels.includes('network_chat'))changed();}catch{/* Ignore malformed provider frames. */}};
     ws.onclose=()=>{if(socket===ws){socket=undefined;reconnect();}};ws.onerror=()=>ws.close();
    }catch{reconnect();}
   }
   void connect();
   return()=>{closed=true;clearTimeout(retry);clear();if(socket){socket.onclose=null;socket.close();socket=undefined;}};
  },
 };
}
