// RealtimeHub — grants enforced at the signaling layer (#46).
import { describe, expect, it } from "vitest";
import { RealtimeHub } from "../src/realtime";
import type { Env } from "../src/env";
import { FakeState, asState, upgrade } from "./do";
import { signTicket } from "../src/ticket";

const env = {} as Env;

describe('publisher startup ordering',()=>{
  it('commits scene publication before a back-to-back audience configuration',async()=>{
    const state=new FakeState();
    const hub=new RealtimeHub(asState(state),env);
    const host=state.attach('host',{userId:'host',roomId:'r1',channels:[],role:'host',roomControl:true,publisherId:'native',audienceHost:true,authExpiresAt:Date.now()+120000});
    await Promise.all([
      hub.webSocketMessage(host as never,JSON.stringify({type:'scene.publish',command_protocol:2,scenes:[{id:'one',name:'One'}],active_scene_id:'one'})),
      hub.webSocketMessage(host as never,JSON.stringify({type:'audience.configure',enabled:true,direct_limit:4})),
    ]);
    expect(host.frames().filter(frame=>frame.code==='publisher_busy')).toEqual([]);
    expect(await state.storage.get('audience-room:v1')).toMatchObject({enabled:true,publisher:'native'});
  });
  it('reclaims audience delivery after the old publisher closes',async()=>{
    const state=new FakeState();const hub=new RealtimeHub(asState(state),env);
    const attachment={userId:'host',roomId:'r1',channels:[],role:'host',roomControl:true,audienceHost:true,authExpiresAt:Date.now()+120000};
    const first=state.attach('first',{...attachment,publisherId:'first'});
    const publish=JSON.stringify({type:'scene.publish',command_protocol:2,scenes:[{id:'one',name:'One'}],active_scene_id:'one'});
    const configure=JSON.stringify({type:'audience.configure',enabled:true,direct_limit:4});
    await hub.webSocketMessage(first as never,publish);await hub.webSocketMessage(first as never,configure);
    first.close();const next=state.attach('next',{...attachment,publisherId:'next'});
    await Promise.all([hub.webSocketMessage(next as never,publish),hub.webSocketMessage(next as never,configure)]);
    expect(next.frames().filter(frame=>frame.code==='publisher_busy')).toEqual([]);
    expect(await state.storage.get('audience-room:v1')).toMatchObject({publisher:'next',enabled:true});
  });
});

describe('room authorization renewal',()=>{
  it('keeps publisher identity and media reservation while renewing permission',async()=>{
    const state=new FakeState(),secret='local-signaling-test-secret-123456789';
    const hub=new RealtimeHub(asState(state),{SIGNALING_SECRET:secret} as Env);
    const host=state.attach('host',{userId:'host',roomId:'r1',channels:[],role:'host',roomControl:true,publisherId:'same-publisher',audienceHost:true,authExpiresAt:0});
    const ticket=await signTicket(secret,{sub:'host',room:'r1',aud:'room-control'});
    await hub.webSocketMessage(host as never,JSON.stringify({type:'auth.refresh',ticket,request_id:'renew'}));
    expect(host.closed).toBeNull();expect(host.deserializeAttachment()).toMatchObject({publisherId:'same-publisher',audienceHost:true});
    expect(host.frames().at(-1)).toMatchObject({type:'room.authorized',request_id:'renew'});
  });
  it('rejects wrong room tickets and immediately drops revoked private subscriptions',async()=>{
    const state=new FakeState(),secret='local-signaling-test-secret-123456789';
    const hub=new RealtimeHub(asState(state),{SIGNALING_SECRET:secret} as Env);
    const mod=state.attach('mod',{userId:'control:m',roomId:'r1',channels:['interaction:host'],role:'control',roomControl:true,audienceControl:true});
    const ticket=await signTicket(secret,{sub:'control:m',room:'r1',aud:'room-control',grants:['room.scene']});
    await hub.webSocketMessage(mod as never,JSON.stringify({type:'auth.refresh',ticket,request_id:'renew'}));
    expect(mod.deserializeAttachment()).toMatchObject({channels:[],audienceControl:false});
    const wrong=await signTicket(secret,{sub:'control:m',room:'r2',aud:'room-control'});
    await hub.webSocketMessage(mod as never,JSON.stringify({type:'auth.refresh',ticket:wrong,request_id:'wrong'}));
    expect(mod.closed).toBe(4001);
  });
});

async function connect(state: FakeState, hub: RealtimeHub, headers: Record<string, string>) {
  await hub.acceptUpgrade(upgrade(headers));
  const sockets = state.getWebSockets();
  return sockets[sockets.length - 1] as unknown as import("./do").FakeSocket;
}

describe("[grant] the DO enforces media.screen on the screen peer", () => {
  it("drops a guest's screen offer without media.screen and relays it with the grant", async () => {
    const state = new FakeState();
    const hub = new RealtimeHub(asState(state), env);
    const host = await connect(state, hub, { "X-Producer-User": "host:g1", "X-Producer-Room": "r1", "X-Producer-Role": "host" });
    const guest = await connect(state, hub, {
      "X-Producer-User": "guest:g1",
      "X-Producer-Room": "r1",
      "X-Producer-Role": "guest",
      "X-Producer-Grants": JSON.stringify(["media.camera", "media.mic"]),
    });
    host.sent.length = 0; // discard the initial audience-control snapshot
    await hub.webSocketMessage(guest as never, JSON.stringify({ type: "signal", payload: { peer: "screen", sdp: "offer" } }));
    expect(host.sent).toHaveLength(0);
    expect(guest.frames()[0]).toMatchObject({ type: "error", code: "grant_required", grant: "media.screen", status: 403 });
    // The camera peer is unaffected.
    await hub.webSocketMessage(guest as never, JSON.stringify({ type: "signal", payload: { sdp: "offer" } }));
    expect(host.frames()[0]).toMatchObject({ type: "signal", from: "guest:g1", payload: { sdp: "offer" } });

    const sharer = await connect(state, hub, {
      "X-Producer-User": "guest:g2",
      "X-Producer-Room": "r1",
      "X-Producer-Role": "guest",
      "X-Producer-Grants": JSON.stringify(["media.camera", "media.screen"]),
    });
    await hub.webSocketMessage(sharer as never, JSON.stringify({ type: "signal", payload: { peer: "screen", sdp: "offer" } }));
    expect(host.frames().at(-1)).toMatchObject({ from: "guest:g2", payload: { peer: "screen" } });
  });

  it("a socket from before grants (no header) is a guest on the default bundle: no screen", async () => {
    const state = new FakeState();
    const hub = new RealtimeHub(asState(state), env);
    const guest = await connect(state, hub, { "X-Producer-User": "guest:g1", "X-Producer-Room": "r1" });
    await hub.webSocketMessage(guest as never, JSON.stringify({ type: "signal", payload: { peer: "screen" } }));
    expect(guest.frames()[0]).toMatchObject({ code: "grant_required" });
  });
});
