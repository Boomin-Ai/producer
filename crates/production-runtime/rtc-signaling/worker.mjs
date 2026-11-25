import {guestPage} from './guest-page.mjs';
// An expiring, single-guest signaling mailbox. No RTP, TURN or media endpoint.
const ttl = 120_000;
const headers = {"Cache-Control":"no-store","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff"};
const json = (v,status=200) => Response.json(v,{status,headers});
const key = () => crypto.randomUUID().replaceAll("-","") + crypto.randomUUID().replaceAll("-","");
const page = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Join Producer RTC</title><style>body{background:#0c141e;color:#e8f2f0;font:18px system-ui;margin:12vh auto;padding:24px;max-width:30em}a{background:#78ddba;color:#08241a;border-radius:8px;padding:12px 18px;display:inline-block;text-decoration:none}small{color:#a8b8ba}</style><h1>Join the studio</h1><p>Open this invitation in Producer. You choose when to share your camera and microphone.</p><a id="open">Open in Producer</a><p><small>You can also copy this page’s link and choose “Join room link” in People.</small></p><script>document.getElementById('open').href='producer-rtc://join?url='+encodeURIComponent(location.href)</script></html>`;
function valid(d,kind) {
  return d?.protocol==="producer-rtc/1" && d.type===kind && typeof d.sdp==="string" && d.sdp.length<65536 &&
    d.sdp.startsWith("v=0") && d.sdp.includes("a=fingerprint:sha-256 ") && !d.sdp.includes(" typ relay");
}
async function body(req) {
  if (+req.headers.get("content-length")>96000) return null;
  const reader=req.body?.getReader();if(!reader) return null;
  let size=0; const chunks=[];
  for (;;) {
    const {done,value}=await reader.read();if(done) break;
    if ((size+=value.length)>96000){await reader.cancel();return null;} chunks.push(value);
  }
  try{return JSON.parse(await new Blob(chunks).text());}catch{return null;}
}
const allowedOrigins = new Set(["https://producer.dev", "https://boomin.ai"]);
async function canCreate(req, url, env) {
  const auth = req.headers.get("Authorization");
  if (env.CREATE_KEY && auth === "Bearer " + env.CREATE_KEY) return true;
  if (env.PUBLIC_ROOM || env.BROWSER_INVITES !== "1") return false;
  const id = url.searchParams.get("roomId"), brand = url.searchParams.get("brandSlug");
  if (!/^Bearer [a-z0-9_.-]{1,512}$/i.test(auth ?? "") ||
      !/^[a-f0-9-]{36}$/i.test(id ?? "") || !/^[a-z0-9][a-z0-9_-]{0,119}$/i.test(brand ?? "")) return false;
  const authority = new URL(`https://api.boomin.ai/v1/app/live/rooms/${id}/share-links`);
  authority.searchParams.set("brandSlug", brand);
  try {
    const response = await fetch(authority, {headers:{Authorization:auth, Accept:"application/json"}, redirect:"error", cache:"no-store"});
    if (!response.ok) return false;
    const room = await response.json();
    return room.room_id === id && room.brand_slug === brand;
  } catch {
    return false;
  }
}
export default {
  async fetch(req,env) {
    const origin=req.headers.get("Origin");
    if(origin && origin!==new URL(req.url).origin && !allowedOrigins.has(origin)) return json({error:"Unknown origin"},403);
    const response=req.method==="OPTIONS" ? new Response(null,{status:204}) : await route(req,env);
    if(!origin) return response;
    const result=new Response(response.body,response);
    result.headers.set("Access-Control-Allow-Origin",origin);
    result.headers.set("Vary","Origin");
    result.headers.set("Access-Control-Allow-Headers","Authorization, Content-Type");
    result.headers.set("Access-Control-Allow-Methods","GET, POST, OPTIONS");
    return result;
  }
};
async function route(req,env) {
    const url=new URL(req.url);
    // A studio credential on this deployment is bound to one Boomin room.
    const room=env.PUBLIC_ROOM;
    const directory=()=>env.ROOMS.get(env.ROOMS.idFromName("public/"+room));
    if(room && req.method==="GET" && url.pathname==="/public/"+room) {
      const profile=await fetch("https://api.boomin.ai/v1/connect/rooms/"+room+"/profile",{cache:"no-store"});
      if(!profile.ok || (await profile.json()).room?.id!==env.PUBLIC_ROOM_ID) return json({error:"Room unavailable"},404);
      const pointer=await directory().fetch("https://internal/current");
      if(!pointer.ok) return pointer;
      const {id,guest}=await pointer.json();
      const mailbox=env.ROOMS.get(env.ROOMS.idFromName(id));
      const offer=await mailbox.fetch("https://internal/offer",{headers:{Authorization:"Bearer "+guest}});
      if(!offer.ok) return json({error:"Studio is unavailable"},410);
      return json({id,guest,offer:await offer.json()});
    }
    if(req.method==="POST" && url.pathname==="/sessions"){
      if(!await canCreate(req,url,env))return json({error:"Host authorization required"},403);
      const offer=await body(req);if(!valid(offer,"offer"))return json({error:"Invalid offer"},400);
      const id=crypto.randomUUID(),owner=key(),guest=key();
      const stub=env.ROOMS.get(env.ROOMS.idFromName(id));
      const initialized=await stub.fetch("https://internal/init",{method:"POST",body:JSON.stringify({offer,owner,guest,expires:Date.now()+ttl})});
      if(!initialized.ok)return json({error:"Studio invitation unavailable"},503);
      if(room) await directory().fetch("https://internal/register",{method:"POST",body:JSON.stringify({id,guest,expires:Date.now()+ttl})});
      return json({link:url.origin+"/r/"+id+"#"+guest,owner,id},201);
    }
    const match=url.pathname.match(/^\/r\/([a-f0-9-]{36})(?:\/(offer|answer|close))?$/);
    if(!match)return json({error:"Unknown room"},404);
    if(!match[2] && req.method==="GET")return new Response(env.BROWSER_INVITES==="1"?guestPage:page,{headers:{...headers,"Content-Type":"text/html; charset=utf-8","Content-Security-Policy":"default-src 'none'; connect-src 'self'; media-src 'self' blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'"}});
    if(!match[2])return json({error:"Unsupported request"},405);
    return env.ROOMS.get(env.ROOMS.idFromName(match[1])).fetch(req);
}
export class SignalRoom {
  constructor(ctx){this.ctx=ctx;}
  async alarm(){await this.ctx.storage.deleteAll();}
  async fetch(req){
    const path=new URL(req.url).pathname.split("/").pop(),store=this.ctx.storage;
    if(path==="register"){
      const entry=await req.json();await store.put("entry",entry);await store.setAlarm(entry.expires);return json({ok:true});
    }
    if(path==="current"){
      const entry=await store.get("entry");
      return entry && entry.expires>Date.now()?json(entry):json({error:"Studio is offline"},410);
    }
    if(path==="init"){
      const state=await req.json();await store.put("session",state);await store.setAlarm(state.expires);return json({ok:true});
    }
    // Read bodies before the transaction so simultaneous answers cannot claim one invitation twice.
    const payload=path==="answer"&&req.method==="POST"?await body(req):null;
    return store.transaction(async txn=>{
      const s=await txn.get("session");
      if(!s||s.expires<Date.now())return json({error:"Invitation expired"},410);
      const auth=req.headers.get("Authorization");
      const owner=auth==="Bearer "+s.owner, guest=auth==="Bearer "+s.guest;
      if(!owner&&!guest)return json({error:"Invalid invitation"},403);
      if(owner&&path==="close"&&req.method==="POST"){await txn.delete("session");return json({ok:true});}
      if(guest&&path==="offer"&&req.method==="GET")return s.answer?json({error:"Invitation claimed"},409):json(s.offer);
      if(guest&&path==="answer"&&req.method==="POST"){
        if(!valid(payload,"answer"))return json({error:"Invalid reply"},400);
        if(s.answer)return JSON.stringify(payload)===JSON.stringify(s.answer)?json({ok:true}):json({error:"Invitation claimed"},409);
        s.answer=payload;await txn.put("session",s);return json({ok:true});
      }
      if(owner&&path==="answer"&&req.method==="GET")return json({answer:s.answer??null});
      return json({error:"Unsupported request"},405);
    });
  }
}
