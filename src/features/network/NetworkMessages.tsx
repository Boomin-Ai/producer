import {useCallback,useEffect,useLayoutEffect,useRef,useState,useSyncExternalStore} from 'react';
import type {EndpointInfo} from '../../lib/ipc';
import {createMessagesClient} from './client';
import {NetworkMessagesController,type MessagesClient,type MessagesState} from './controller';
import './network.css';

export type NetworkMessagesProps={endpoint:EndpointInfo|null;onClose:()=>void;onConnections:()=>void;onUnreadChange?:(count:number)=>void;client?:MessagesClient};
const empty:MessagesState={status:'loading',conversations:[],selected:null,messages:[],loadingThread:false,loadingOlder:false,hasOlder:false,draft:'',error:'',realtime:false};
export function NetworkMessages(props:NetworkMessagesProps){
 if(!props.endpoint)return <section className="network-messages network-messages-empty"><h1>Messages</h1><p>Choose a workspace to see its connected producers.</p><button onClick={props.onClose}>Back to rooms</button></section>;
 return <MessagesPane key={props.endpoint.id} {...props} endpoint={props.endpoint}/>;
}
function MessagesPane({endpoint,onClose,onConnections,onUnreadChange,client}:NetworkMessagesProps&{endpoint:EndpointInfo}){
 const [controller,setController]=useState<NetworkMessagesController|null>(null),[filter,setFilter]=useState('');
 const thread=useRef<HTMLDivElement>(null),bottom=useRef(true),selectedBefore=useRef<string|null>(null),olderHeight=useRef<number|null>(null);
 useEffect(()=>{
  const c=new NetworkMessagesController(client??createMessagesClient(endpoint));setController(c);
  const visible=()=>document.visibilityState==='visible'&&navigator.onLine;
  const sync=()=>{c.setVisible(visible());c.setReadVisible(visible()&&document.hasFocus()&&bottom.current);};
  sync();c.start();
  document.addEventListener('visibilitychange',sync);window.addEventListener('online',sync);window.addEventListener('offline',sync);window.addEventListener('focus',sync);window.addEventListener('blur',sync);
  return()=>{c.close();document.removeEventListener('visibilitychange',sync);window.removeEventListener('online',sync);window.removeEventListener('offline',sync);window.removeEventListener('focus',sync);window.removeEventListener('blur',sync);};
 },[endpoint.id,endpoint.base_url,client]);
 const subscribe=useCallback((fn:()=>void)=>controller?.subscribe(fn)??(()=>{}),[controller]);
 const snapshot=useCallback(()=>controller?.snapshot()??empty,[controller]);
 const state=useSyncExternalStore(subscribe,snapshot),conversation=state.conversations.find(c=>c.id===state.selected);
 const unread=state.conversations.reduce((n,c)=>n+c.unread_count,0);
 useEffect(()=>{onUnreadChange?.(unread);},[unread,onUnreadChange]);
 const visibleRead=()=>controller?.setReadVisible(document.visibilityState==='visible'&&document.hasFocus()&&bottom.current);
 useLayoutEffect(()=>{
  const el=thread.current;if(!el)return;
  if(selectedBefore.current!==state.selected){selectedBefore.current=state.selected;bottom.current=true;olderHeight.current=null;}
  if(olderHeight.current!==null&&!state.loadingOlder){el.scrollTop+=el.scrollHeight-olderHeight.current;olderHeight.current=null;}
  else if(bottom.current)el.scrollTop=el.scrollHeight;
  const frame=requestAnimationFrame(visibleRead);return()=>cancelAnimationFrame(frame);
 },[state.selected,state.messages,state.loadingOlder,controller]);
 const active=state.status==='ready',canSend=!!conversation?.can_send&&!state.pending;
 const count=[...state.draft].length;
 return <section className="network-messages" aria-label="Network messages">
  <header className="network-messages-heading"><div><span className="network-eyebrow">PRODUCER NETWORK</span><h1>Messages {unread>0&&<span className="network-unread-total">{unread}</span>}</h1><p>{endpoint.name} · private conversations between connected producers</p></div><div><button onClick={onConnections}>Connections</button><button className="network-close" aria-label="Close messages" onClick={onClose}>×</button></div></header>
  {state.status==='unavailable'?<div className="network-messages-empty"><h2>Messages are not available on this server</h2><p>{state.error}</p><p>Your workspace stays on {endpoint.name}. You can still join another Producer using its guest room link.</p><button onClick={onClose}>Back to rooms</button></div>:
   state.status==='error'?<div className="network-messages-empty"><h2>Couldn’t load messages</h2><p role="alert">{state.error}</p><button onClick={()=>void controller?.refresh()}>Try again</button></div>:
   <div className="network-messages-body">
    <aside className="network-conversations" aria-label="Conversations"><label className="network-search"><span>Find a conversation</span><input aria-label="Find a conversation" placeholder="Search connections" value={filter} onChange={e=>setFilter(e.target.value)}/></label>
     {state.status==='loading'?<p className="network-placeholder" role="status">Loading conversations…</p>:!state.conversations.length?<div className="network-placeholder"><strong>Start with a connection</strong><p>Connect with a producer to start a private conversation.</p><button onClick={onConnections}>Find a producer</button></div>:state.conversations.filter(c=>(c.counterparty.name+' '+c.counterparty.slug).toLowerCase().includes(filter.toLowerCase())).map(c=><button key={c.id} className={'network-conversation'+(c.id===state.selected?' selected':'')} aria-pressed={c.id===state.selected} onClick={()=>controller?.select(c.id)}>
      {c.counterparty.avatar_url?<img src={c.counterparty.avatar_url} alt=""/>:<span className="network-avatar">{c.counterparty.name.slice(0,1)}</span>}<span className="network-conversation-copy"><strong>{c.counterparty.name}</strong><span>@{c.counterparty.slug}</span><small>{c.last_message?.text??'Say hello'}</small></span>{c.unread_count>0&&<span className="network-conversation-unread" aria-label={`${c.unread_count} unread messages`}>{c.unread_count}</span>}
     </button>)}
    </aside>
    <div className="network-thread">
     {conversation?<><header className="network-thread-heading"><div><h2>{conversation.counterparty.name}</h2><span>@{conversation.counterparty.slug} <i aria-hidden="true">·</i> {state.realtime?'Connected':'Checking for updates'}</span></div>{conversation.can_manage!==false&&<button onClick={()=>void controller?.block(!conversation.blocked_by_you)}>{conversation.blocked_by_you?'Unblock':'Block'}</button>}</header>
      {state.error&&<p className="network-message-error" role="alert">{state.error}</p>}
      <div className="network-thread-scroll" ref={thread} tabIndex={0} aria-label={`Messages with ${conversation.counterparty.name}`} onScroll={()=>{const el=thread.current;if(!el)return;bottom.current=el.scrollHeight-el.scrollTop-el.clientHeight<45;visibleRead();}}>
       {state.hasOlder&&state.messages.length<500&&<button className="network-load-older" disabled={state.loadingOlder} onClick={()=>{olderHeight.current=thread.current?.scrollHeight??null;bottom.current=false;void controller?.older();}}>{state.loadingOlder?'Loading…':'Load earlier messages'}</button>}
       {state.hasOlder&&state.messages.length>=500&&<p className="network-history-window">Showing the latest 500 messages.</p>}
       {state.loadingThread?<p role="status" className="network-placeholder">Loading messages…</p>:!state.messages.length?<p className="network-placeholder">This is the start of your conversation. Your messages stay between these workspaces.</p>:state.messages.map(message=>{
        const incoming=message.sender_brand_id===conversation.counterparty.id;
        return <article key={message.id} className={'network-message'+(incoming?' incoming':' outgoing')}><span>{incoming?conversation.counterparty.name:'Your workspace'}</span><p>{message.text}</p><time dateTime={message.created_at}>{new Date(message.created_at).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}</time></article>;
       })}
       {state.pending&&<article className="network-message outgoing pending"><span>{state.pending.status==='sending'?'Sending…':'Not sent'}</span><p>{state.pending.text}</p>{state.pending.status==='failed'&&<><small role="alert">{state.pending.error}</small><div><button onClick={()=>void controller?.retrySend()}>Retry message</button><button onClick={()=>controller?.dismissFailed()}>Dismiss</button></div></>}</article>}
      </div>
      <form className="network-compose" onSubmit={e=>{e.preventDefault();void controller?.send();}}><label htmlFor="network-message-draft">{conversation.messaging_blocked?'Messaging is blocked':conversation.status!=='active'?'This connection is closed':!conversation.can_send?'This workspace has read-only messaging access':'Message'}</label><textarea id="network-message-draft" aria-label="Message" placeholder="Write a message…" maxLength={8000} value={state.draft} disabled={!conversation.can_send||state.pending?.status==='sending'} onChange={e=>controller?.setDraft(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){e.preventDefault();if(canSend)void controller?.send();}}}/><div><small className={count>4000?'over-limit':''}>{count.toLocaleString()} / 4,000 · Ctrl/⌘ Enter to send</small><button className="network-send" type="submit" disabled={!active||!canSend||!state.draft.trim()||count>4000}>{state.pending?.status==='sending'?'Sending…':'Send message'}</button></div></form>
     </>:<div className="network-messages-empty"><h2>Make something together.</h2><p>Choose a connected producer to open your conversation.</p></div>}
    </div>
   </div>}
 </section>;
}
