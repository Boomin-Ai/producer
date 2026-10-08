import { describe,it,expect,vi } from 'vitest';
import { AudienceRoom } from '../src/audienceRoom';
import { FakeState,FakeSocket } from './do';
function setup(){const state=new FakeState();const controller=new AudienceRoom(state.storage,()=>state.getWebSockets(),url=>url.origin==='https://room.test');const host=state.attach('host',{publisherId:'native',audienceHost:true});const viewer=(id:string)=>state.attach(id,{audienceId:id,name:id});return {state,controller,host,viewer};}
describe('interactive audience authority',()=>{
  it('routes moderator invitation requests to the active host and enforces admission permission',async()=>{
    const {controller,host,viewer,state}=setup();await controller.handle(host,{type:'audience.configure',enabled:true,direct_limit:1});
    const guest=viewer('viewer');await controller.admit(guest);
    const restricted=state.attach('restricted',{audienceControl:true});
    await controller.handle(restricted,{type:'audience.invite.request',id:'viewer'});
    expect(restricted.frames().at(-1)).toMatchObject({code:'forbidden'});
    const moderator=state.attach('mod',{audienceControl:true,audienceInvite:true});
    await controller.handle(moderator,{type:'audience.invite.request',id:'viewer'});
    expect(host.frames().at(-1)).toMatchObject({type:'audience.invite.request',id:'viewer',name:'viewer'});
    expect(guest.frames().filter(f=>f.type==='audience.invite')).toHaveLength(0);
  });
  it('releases media reservations on host disconnect and duplicate viewer replacement',async()=>{
    const {controller,host,viewer,state}=setup();
    await controller.handle(host,{type:'audience.configure',enabled:true,direct_limit:1});
    const first=viewer('first');await controller.admit(first);await controller.handle(first,{type:'audience.watch'});
    const replacement=viewer('first');await controller.admit(replacement);
    expect(first.deserializeAttachment()).toMatchObject({audienceMedia:false});
    await controller.handle(replacement,{type:'audience.watch'});
    await controller.leave(host);
    expect(replacement.deserializeAttachment()).toMatchObject({audienceMedia:false});
    expect(replacement.frames()).toContainEqual(expect.objectContaining({type:'audience.media.closed',reason:'host_offline'}));
    const newHost=state.attach('new-host',{publisherId:'new-native',audienceHost:true});
    await controller.handle(newHost,{type:'audience.configure',enabled:true,direct_limit:1});
    replacement.serializeAttachment({...replacement.deserializeAttachment() as object,lastWatch:0});await controller.handle(replacement,{type:'audience.watch'});
    expect(newHost.frames().at(-1)).toMatchObject({type:'audience.viewer',id:'first'});
  });
  it('atomically bounds room admission and replaces duplicate identities',async()=>{const {controller,viewer,state}=setup();const accepted=await Promise.all(Array.from({length:100},(_,i)=>{const ws=viewer(String(i));return controller.admit(ws);}));expect(accepted.every(Boolean)).toBe(true);const extra=viewer('extra');expect(await controller.admit(extra)).toBe(false);expect(extra.closed).toBe(4009);const replaced=viewer('0');expect(await controller.admit(replaced)).toBe(true);expect((state.getWebSockets()[1] as unknown as FakeSocket).closed).toBe(4000);});
  it('grants only the direct media budget while chat remains available',async()=>{const {controller,host,viewer}=setup();await controller.handle(host,{type:'audience.configure',enabled:true,direct_limit:1});const one=viewer('one'),two=viewer('two');await controller.admit(one);await controller.admit(two);await Promise.all([controller.handle(one,{type:'audience.watch'}),controller.handle(two,{type:'audience.watch'})]);expect(host.frames().filter(f=>f.type==='audience.viewer')).toHaveLength(1);expect(two.frames().at(-1)).toMatchObject({code:'hardware_budget_full'});await controller.handle(two,{type:'audience.chat',text:'still here'});expect(one.frames().at(-1)).toMatchObject({type:'audience.chat',message:{text:'still here'}});await controller.handle(one,{type:'audience.unwatch'});two.serializeAttachment({...two.deserializeAttachment() as object,lastWatch:0});await controller.handle(two,{type:'audience.watch'});expect(host.frames().at(-1)).toMatchObject({type:'audience.viewer',id:'two'});});
  it('refuses viewer moderation, settings, and signaling without a media slot',async()=>{const {controller,viewer}=setup();const ws=viewer('v');for(const type of ['audience.configure','audience.moderate','audience.invite','audience.signal']){await controller.handle(ws,{type,id:'other',enabled:true,direct_limit:8});expect(ws.frames().at(-1)?.type).toBe('audience.error');}});
  it('persists chat mutes and bans across reconnects and eviction',async()=>{const {controller,host,viewer,state}=setup();const first=viewer('first');await controller.admit(first);await controller.handle(host,{type:'audience.moderate',id:'first',action:'mute'});await controller.leave(first);const again=viewer('first');const recreated=new AudienceRoom(state.storage,()=>state.getWebSockets());await recreated.admit(again);await recreated.handle(again,{type:'audience.chat',text:'muted'});expect(again.frames().at(-1)).toMatchObject({code:'muted'});await recreated.handle(host,{type:'audience.moderate',id:'first',action:'remove'});const third=viewer('first');expect(await recreated.admit(third)).toBe(false);});
  it('delivers stage invitations only to their recipient and accepted origin',async()=>{const {controller,host,viewer}=setup();const one=viewer('one'),two=viewer('two');await controller.handle(host,{type:'audience.invite',id:'one',url:'https://evil.test/g/code'});expect(one.sent).toHaveLength(0);await controller.handle(host,{type:'audience.invite',id:'one',url:'https://room.test/g/code'});expect(one.frames().at(-1)).toMatchObject({type:'audience.invite'});expect(two.sent).toHaveLength(0);});
  it('coalesces reactions before fanout',async()=>{vi.useFakeTimers();try{const {controller,viewer}=setup();const one=viewer('one'),two=viewer('two');await controller.handle(one,{type:'audience.reaction',emoji:'🔥'});await controller.handle(two,{type:'audience.reaction',emoji:'🔥'});expect(one.sent).toHaveLength(0);await vi.advanceTimersByTimeAsync(250);expect(one.frames()).toEqual([expect.objectContaining({type:'audience.reaction',counts:{'🔥':2}})]);}finally{vi.useRealTimers();}});
});
