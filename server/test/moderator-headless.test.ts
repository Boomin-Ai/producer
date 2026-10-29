/** Control-plane integration only: real hub/commands, synthetic sockets/storage.
 * Simulated host acknowledgements are not native presentation evidence. */
import { describe, expect, it } from 'vitest';
import { RealtimeHub } from '../src/realtime';
import { signTicket } from '../src/ticket';
import type { Env } from '../src/env';
import { FakeState, asState, asSocket, type FakeSocket } from './do';
const secret = 'synthetic-moderator-sandbox-signing-key';
async function setup() {
  const state = new FakeState(), hub = new RealtimeHub(asState(state), { SIGNALING_SECRET: secret } as Env);
  const base = { roomId:'sandbox-room', channels:[], roomControl:true, authExpiresAt:Date.now()+120000 };
  const host = state.attach('host',{...base,userId:'host',role:'host',publisherId:'synthetic-engine'});
  const mod = state.attach('mod',{...base,userId:'control:mod',role:'control',grants:['room.scene']});
  const send = (socket:FakeSocket, frame:object)=>hub.webSocketMessage(asSocket(socket),JSON.stringify(frame));
  await send(host,{type:'scene.publish',command_protocol:2,scenes:[{id:'one',name:'One'},{id:'two',name:'Two'}],active_scene_id:'one'});
  return {state,hub,host,mod,send};
}
describe('portable moderator control-plane scenarios',()=>{
  it('does not claim a scene changed before a host acknowledgement, and preserves it on failure',async()=>{
    const {state,host,mod,send}=await setup();
    await send(mod,{type:'scene.cut',scene_id:'two',command_id:'cut'});
    expect(mod.frames().at(-1)).toMatchObject({type:'scene.command',status:'accepted'});
    expect(await state.storage.get('scenes')).toMatchObject({active_scene_id:'one'});
    await send(host,{type:'scene.ack',command_id:'cut',status:'failed',error:'Synthetic preparation failure'});
    expect(mod.frames().at(-1)).toMatchObject({type:'scene.command',status:'failed'});
    expect(await state.storage.get('scenes')).toMatchObject({active_scene_id:'one'});
  });
  it('denies new cuts after an authenticated grant narrowing',async()=>{
    const {host,mod,send}=await setup();
    const ticket=await signTicket(secret,{sub:'control:mod',room:'sandbox-room',aud:'room-control',grants:[]});
    await send(mod,{type:'auth.refresh',ticket,request_id:'narrow'});
    const before=host.frames().filter(f=>f.type==='scene.cut').length;
    await send(mod,{type:'scene.cut',scene_id:'two',command_id:'denied'});
    expect(mod.frames().at(-1)).toMatchObject({type:'error'});
    expect(host.frames().filter(f=>f.type==='scene.cut')).toHaveLength(before);
  });
  it('rejects a cut while the publisher socket is closed instead of accepting undeliverable work',async()=>{
    const {host,mod,send}=await setup();host.close();
    await send(mod,{type:'scene.cut',scene_id:'two',command_id:'offline'});
    expect(mod.frames().at(-1)).toMatchObject({type:'error',code:'host_unavailable'});
    expect(host.frames().some(f=>f.command_id==='offline')).toBe(false);
  });
});
