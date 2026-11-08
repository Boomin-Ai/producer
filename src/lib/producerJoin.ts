/** Link capabilities stay with their issuer. No Boomin login token is sent to
 * another server and a display name never becomes verified brand identity. */
export type ProducerJoinLink={code:string;kind:'room'|'invite';apiBase:string;joinUrl:string};
const hosted=new Set(['boomin.ai','www.boomin.ai','producer.dev','www.producer.dev']);
function safeUrl(raw:string):URL{
 const u=new URL(raw.trim());
 if(u.username||u.password||!(u.protocol==='https:'||u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)))throw Error('Use an HTTPS guest link, or localhost for a local server.');
 return u;
}
export function parseProducerJoinLink(raw:string,apiOverride?:string):ProducerJoinLink{
 let u:URL;try{u=safeUrl(raw);}catch{throw Error('Paste a complete HTTPS room or guest invitation link.');}
 const path=u.pathname.replace(/\/+$/,'');
 const direct=/^\/(?:connect\/)?guest\/(room\/)?((?:gr_|gi_)[A-Za-z0-9_-]{16,120})$/.exec(path);
 const pretty=hosted.has(u.hostname)?/^\/[A-Za-z0-9_-]+\/guest\/[a-z0-9-]+\/((?:gr_|gi_)[A-Za-z0-9_-]{16,120})$/.exec(path):null;
 const code=direct?.[2]??pretty?.[1];if(!code)throw Error('This is not a Producer room or guest invitation link.');
 if(direct&&!!direct[1]!==code.startsWith('gr_'))throw Error('The guest link has an invalid room credential.');
 let apiBase=hosted.has(u.hostname)?'https://api.boomin.ai':u.origin;
 if(apiOverride?.trim()){
  const api=safeUrl(apiOverride);if(api.search||api.hash)throw Error('The guest API address must not contain a query or fragment.');
  apiBase=api.href.replace(/\/+$/,'');
 }
 return {code,kind:code.startsWith('gr_')?'room':'invite',apiBase,joinUrl:u.href};
}
export function producerConnectBase(apiBase:string):string{
 const u=safeUrl(apiBase);if(u.search||u.hash)throw Error('Invalid guest API address.');
 const prefix=u.pathname.split(/\/v1(?:\/|$)/)[0].replace(/\/+$/,'');return `${u.origin}${prefix}/v1/connect`;
}
export async function resolveProducerInvitation(link:ProducerJoinLink,displayName:string,producerRef:string,signal?:AbortSignal,storage?:Pick<Storage,'getItem'|'setItem'>):Promise<string>{
 if(link.kind==='invite')return link.joinUrl;
 const name=displayName.trim();if(!name||name.length>80)throw Error('Enter a name of up to 80 characters.');
 const key=`producer.join:${producerConnectBase(link.apiBase)}:${link.code}`,url=`${producerConnectBase(link.apiBase)}/guest/room/${encodeURIComponent(link.code)}`;
 const bounded=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(15000)]);
 const options={method:'POST',credentials:'omit' as const,redirect:'error' as const,referrerPolicy:'no-referrer' as const,signal:bounded,cache:'no-store' as const};
 let saved:{inviteCode?:string;proof?:string;expiresAtMs?:number;legacyPending?:boolean}={};
 let store:Pick<Storage,'getItem'|'setItem'>;
 try{store=storage??localStorage;const raw=store.getItem(key);if(raw){if(raw.length>8192)throw Error('Invalid recovery state');saved=JSON.parse(raw);}}catch{throw Error('Allow local storage to recover this guest request safely.');}
 if(!saved||typeof saved!=='object'||saved.inviteCode!==undefined&&!/^gi_[A-Za-z0-9_-]{16,120}$/.test(saved.inviteCode)||saved.proof!==undefined&&(typeof saved.proof!=='string'||!saved.proof||saved.proof.length>2048||!Number.isSafeInteger(saved.expiresAtMs)||Number(saved.expiresAtMs)<=Date.now()))throw Error('This saved guest request cannot be recovered. Ask the host to check it before joining again.');
 if(saved.legacyPending&&!saved.inviteCode)throw Error('The previous join response was lost and this server cannot recover it. Ask the host for your direct guest invitation.');
 const persist=(next:typeof saved)=>{const encoded=JSON.stringify(next);store.setItem(key,encoded);if(store.getItem(key)!==encoded)throw Error('Could not save the guest recovery credential.');};
 if(!saved.inviteCode&&!saved.proof){
  const prepare=await fetch(url+'/join-intent',options);
  if(prepare.status!==404&&prepare.status!==501){
   const proof=await prepare.json().catch(()=>null) as {join_intent?:unknown;expires_at_ms?:unknown}|null;
   if(!prepare.ok||typeof proof?.join_intent!=='string'||!proof.join_intent||proof.join_intent.length>2048||typeof proof.expires_at_ms!=='number'||!Number.isSafeInteger(proof.expires_at_ms)||proof.expires_at_ms<=Date.now())throw Error('Could not prepare a recoverable guest request.');
   saved={proof:proof.join_intent,expiresAtMs:proof.expires_at_ms};persist(saved);
  }else{saved={legacyPending:true};persist(saved);}
 }
 const response=await fetch(url+'/join',{...options,headers:{'Content-Type':'application/json'},body:JSON.stringify({display_name:name,producer_ref:producerRef.slice(0,160),resume_code:saved.inviteCode,join_intent:saved.proof})});
 const result=await response.json().catch(()=>null) as {invite_code?:string;error?:{message?:string}}|null;
 if(!response.ok){if(saved.legacyPending&&response.status<500)persist({});throw Error(result?.error?.message??`Could not join this room (${response.status}).`);}
 if(!result?.invite_code||!/^gi_[A-Za-z0-9_-]{16,120}$/.test(result.invite_code))throw Error('The room server did not return a valid guest invitation.');
 // Keep the intent until the returned private credential is durably saved.
 persist({inviteCode:result.invite_code});
 return `${new URL(link.joinUrl).origin}/connect/guest/${result.invite_code}`;
}
