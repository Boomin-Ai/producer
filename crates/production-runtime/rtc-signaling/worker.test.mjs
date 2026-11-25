import assert from "node:assert/strict";
import test from "node:test";
import worker, {SignalRoom} from "./worker.mjs";

function room() {
  const data=new Map();
  const storage={
    put:async(k,v)=>data.set(k,structuredClone(v)),
    get:async(k)=>structuredClone(data.get(k)),delete:async(k)=>data.delete(k),
    deleteAll:async()=>data.clear(),setAlarm:async()=>{},transaction:async fn=>fn(storage)
  };
  const r=new SignalRoom({storage});
  return (path,method,token,body)=>r.fetch(new Request("https://local/"+path,{
    method,headers:{Authorization:"Bearer "+token},body:body&&JSON.stringify(body)
  }));
}
const desc=type=>({protocol:"producer-rtc/1",type,sdp:"v=0\r\na=fingerprint:sha-256 00\r\na=candidate:TEST typ host\r\n"});
test("guest claims one offer, host receives the reply and closes both capabilities",async()=>{
  const req=room();
  await req("init","POST","",{owner:"host",guest:"guest",expires:Date.now()+20000,offer:desc("offer")});
  assert.equal((await req("offer","GET","stranger")).status,403);
  assert.equal((await req("answer","GET","guest")).status,405);
  assert.deepEqual(await (await req("offer","GET","guest")).json(),desc("offer"));
  const answer=desc("answer");
  assert.equal((await req("answer","POST","guest",answer)).status,200);
  assert.equal((await req("answer","POST","guest",answer)).status,200);
  assert.equal((await req("answer","POST","guest",{...answer,sdp:answer.sdp+"a=other\r\n"})).status,409);
  assert.equal((await req("offer","GET","guest")).status,409);
  assert.deepEqual((await (await req("answer","GET","host")).json()).answer,answer);
  await req("close","POST","host");
  assert.equal((await req("offer","GET","guest")).status,410);
});
test("expired invitation never returns SDP",async()=>{
  const req=room();await req("init","POST","",{owner:"h",guest:"g",expires:0,offer:desc("offer")});
  assert.equal((await req("offer","GET","g")).status,410);
});
test("a signed-in studio host can create a private mailbox", async t => {
  const id = "dca018f7-875f-4d09-8a16-ed66273d130b";
  const broker = "https://signaling.test";
  const auth = "Bearer test-host";
  let granted = false, initialized = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url.origin, "https://api.boomin.ai");
    assert.equal(url.pathname, `/v1/app/live/rooms/${id}/share-links`);
    assert.equal(url.searchParams.get("brandSlug"), "host");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, auth);
    return granted ? Response.json({room_id:id,brand_slug:"host"}) : new Response(null,{status:403});
  });
  const env = {BROWSER_INVITES:"1",ROOMS:{
    idFromName:id => id,
    get:() => ({fetch:async () => { initialized++; return Response.json({ok:true}); }})
  }};
  const attempt = () => worker.fetch(new Request(`${broker}/sessions?roomId=${id}&brandSlug=host`,{
    method:"POST", headers:{Authorization:auth}, body:JSON.stringify(desc("offer"))
  }),env);
  assert.equal((await attempt()).status,403);
  assert.equal(initialized,0);
  granted = true;
  const created = await attempt();
  assert.equal(created.status,201);
  const data = await created.json();
  assert.equal(new URL(data.link).origin,broker);
  assert.notEqual(new URL(data.link).hash.slice(1),data.owner);
  assert.equal(initialized,1);
});
