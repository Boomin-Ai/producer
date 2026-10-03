// The interactive room control plane. Media is peer-to-peer; the DO only
// admits viewers, routes signaling and coordinates chat/hand/moderation state.
// All mutations share one queue so admission cannot oversubscribe the budget.
export interface AudienceSocketState {
  audienceId?: string; name?: string; publisherId?: string;
  audienceControl?: boolean; audienceHost?: boolean; audienceInvite?: boolean;
  mutedUntil?: number; lastChat?: number; lastReaction?: number; lastHand?: number; lastWatch?: number;
}
interface Store { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void> }
interface Socket { send(data: string): void; close(code?: number, reason?: string): void; deserializeAttachment(): unknown; serializeAttachment(data: unknown): void }
interface ChatMessage { id: string; from: string; name: string; text: string; at: number }
interface AudienceState { enabled: boolean; direct_limit: number; publisher: string | null; chat: ChatMessage[]; hands: { id: string; name: string; at: number }[]; bans: Record<string, number>; mutes: Record<string, number> }
const KEY = 'audience-room:v1';
const LIMIT = 100;
export class AudienceRoom {
  private reactions: Record<string, number> = {};
  private reactionTimer: ReturnType<typeof setTimeout> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly storage: Store, private readonly sockets: () => Socket[], private readonly inviteAllowed: (url: URL) => boolean = () => false) {}
  private serialize<T>(run: () => Promise<T>): Promise<T> { const next=this.queue.then(run,run);this.queue=next.catch(()=>{});return next; }
  private async load(): Promise<AudienceState> { return await this.storage.get<AudienceState>(KEY) ?? { enabled:false,direct_limit:4,publisher:null,chat:[],hands:[],bans:{},mutes:{} }; }
  private send(ws: Socket, type: string, payload: object = {}): void { try{ws.send(JSON.stringify({ type,...payload,server_now:Date.now() }));}catch{} }
  private attachment(ws: Socket): AudienceSocketState { return (ws.deserializeAttachment() ?? {}) as AudienceSocketState; }
  private viewers(): Socket[] { return this.sockets().filter((ws)=>!!this.attachment(ws).audienceId); }
  private publisher(state: AudienceState): Socket | undefined { return this.sockets().find((ws)=>this.attachment(ws).publisherId === state.publisher && this.attachment(ws).audienceHost); }
  private broadcast(type: string, data: object): void { for(const ws of this.sockets()) { const a=this.attachment(ws); if(a.audienceId||a.audienceControl||a.audienceHost)this.send(ws,type,data); } }
  private controls(type: string, data: object): void { for(const ws of this.sockets()) { const a=this.attachment(ws);if(a.audienceHost||a.audienceControl)this.send(ws,type,data); } }
  private publicState(state: AudienceState): object { return { enabled:state.enabled,direct_limit:state.direct_limit,capacity:LIMIT,online:new Set(this.viewers().map((ws)=>this.attachment(ws).audienceId)).size,chat:state.chat,host_online:!!this.publisher(state) }; }
  status(): Promise<{ enabled: boolean }> { return this.serialize(async()=>({ enabled:(await this.load()).enabled })); }
  snapshot(ws: Socket): Promise<void> { return this.serialize(async()=>{const state=await this.load();this.send(ws,'audience.snapshot',this.publicState(state)); if(this.attachment(ws).audienceControl||this.attachment(ws).audienceHost)this.send(ws,'audience.hands',{ hands:state.hands });}); }
  admit(ws: Socket): Promise<boolean> { return this.serialize(async()=>{
    const state=await this.load(), actor=this.attachment(ws), id=actor.audienceId;
    if(!id) return false;
    if((state.bans[id]??0)>Date.now()){ws.serializeAttachment({...actor,audienceId:undefined,audienceMedia:false});this.send(ws,'audience.error',{code:'removed'});ws.close(4003,'Removed from room');return false;}
    const others=this.viewers().filter((other)=>other!==ws && this.attachment(other).audienceId!==id);
    if(others.length>=LIMIT){ws.serializeAttachment({...actor,audienceId:undefined,audienceMedia:false});this.send(ws,'audience.error',{code:'room_full'});ws.close(4009,'Room full');return false;}
    for(const old of this.viewers())if(old!==ws&&this.attachment(old).audienceId===id){this.controls('audience.viewer.left',{id});old.serializeAttachment({...this.attachment(old),audienceId:undefined,audienceMedia:false});old.close(4000,'New session');}
    this.send(ws,'audience.snapshot',{...this.publicState(state),self:id});
    this.controls('audience.presence',{online:others.length+1});return true;
  }); }
  handle(ws: Socket, msg: Record<string,unknown>): Promise<boolean> { return this.serialize(async()=>{
    if(typeof msg.type!=='string'||!msg.type.startsWith('audience.'))return false;
    const actor=this.attachment(ws),state=await this.load(),now=Date.now(),id=actor.audienceId;
    const fail=(code:string)=>{this.send(ws,'audience.error',{code});return true;};
    const host=this.publisher(state), control=actor.audienceHost||actor.audienceControl;
    if(id&&(state.bans[id]??0)>now){ws.close(4003,'Removed from room');return true;}
    if(msg.type==='audience.configure'){
      if(!actor.audienceHost||!actor.publisherId)return fail('forbidden');
      if(host&&host!==ws)return fail('publisher_busy');
      if(typeof msg.enabled!=='boolean'||!Number.isInteger(msg.direct_limit)||Number(msg.direct_limit)<1||Number(msg.direct_limit)>8)return fail('invalid_budget');
      if(!msg.enabled){for(const viewer of this.viewers()){viewer.serializeAttachment({...this.attachment(viewer),audienceMedia:false});this.controls('audience.viewer.left',{id:this.attachment(viewer).audienceId});this.send(viewer,'audience.media.closed',{});}}
      const retained = this.viewers().filter((viewer)=>(viewer.deserializeAttachment() as {audienceMedia?:boolean}).audienceMedia);
      for(const viewer of retained.slice(Number(msg.direct_limit))){const a=this.attachment(viewer);viewer.serializeAttachment({...a,audienceMedia:false});this.controls('audience.viewer.left',{id:a.audienceId});this.send(viewer,'audience.media.closed');}
      state.enabled=msg.enabled;state.direct_limit=Number(msg.direct_limit);state.publisher=actor.publisherId;
      await this.storage.put(KEY,state);this.broadcast('audience.snapshot',this.publicState(state));return true;
    }
    if(msg.type==='audience.chat'){
      if(!id && !control)return fail('forbidden');
      if((state.mutes?.[id??'']??actor.mutedUntil??0)>now)return fail('muted');
      if(now-(actor.lastChat??0)<1500)return fail('slow_down');
      if(typeof msg.text!=='string'||!msg.text.trim()||msg.text.length>500)return fail('invalid_message');
      const m:ChatMessage={id:crypto.randomUUID(),from:id??actor.publisherId??'moderator',name:actor.name??(control?'Host':'Viewer'),text:msg.text.trim(),at:now};
      actor.lastChat=now;ws.serializeAttachment(actor);state.chat=[...state.chat.slice(-99),m];await this.storage.put(KEY,state);this.broadcast('audience.chat',{message:m});return true;
    }
    if(msg.type==='audience.reaction'){
      if(!id)return fail('forbidden');if(now-(actor.lastReaction??0)<1000)return fail('slow_down');
      if(!['❤️','👏','🔥','😂'].includes(String(msg.emoji)))return fail('invalid_reaction');
      actor.lastReaction=now;ws.serializeAttachment(actor);
      const emoji=String(msg.emoji);this.reactions[emoji]=(this.reactions[emoji]??0)+1;
      if(!this.reactionTimer)this.reactionTimer=setTimeout(()=>{const counts=this.reactions;this.reactions={};this.reactionTimer=null;this.broadcast('audience.reaction',{counts});},250);
      return true;
    }
    if(msg.type==='audience.hand'){
      if(!id)return fail('forbidden');if(now-(actor.lastHand??0)<2000)return fail('slow_down');actor.lastHand=now;ws.serializeAttachment(actor);
      state.hands=state.hands.filter((h)=>h.id!==id);if(msg.raised===true)state.hands.push({id,name:actor.name??'Viewer',at:now});state.hands=state.hands.slice(-100);
      await this.storage.put(KEY,state);this.controls('audience.hands',{hands:state.hands});this.send(ws,'audience.hand',{raised:msg.raised===true});return true;
    }
    if(msg.type==='audience.watch'){
      if(!id)return fail('forbidden');if(!state.enabled||!host)return fail('host_offline');
      if(now-(actor.lastWatch??0)<2000)return fail('slow_down');actor.lastWatch=now;ws.serializeAttachment(actor);
      const media=this.sockets().filter((other)=>(other.deserializeAttachment() as {audienceMedia?:boolean})?.audienceMedia===true);
      if(!(actor as {audienceMedia?:boolean}).audienceMedia&&media.length>=state.direct_limit){this.send(host,'audience.capacity',{direct_limit:state.direct_limit,active:media.length});return fail('hardware_budget_full');}
      ws.serializeAttachment({...actor,audienceMedia:true});this.send(host,'audience.viewer',{id});return true;
    }
    if(msg.type==='audience.unwatch'){
      if(id){ws.serializeAttachment({...actor,audienceMedia:false});this.controls('audience.viewer.left',{id});}
      else if(actor.audienceHost&&ws===host&&typeof msg.id==='string'){const peer=this.viewers().find(other=>this.attachment(other).audienceId===msg.id);if(peer){peer.serializeAttachment({...this.attachment(peer),audienceMedia:false});this.send(peer,'audience.media.closed');}}
      else return fail('forbidden');return true;
    }
    if(msg.type==='audience.signal'){
      if(id){if(!(actor as {audienceMedia?:boolean}).audienceMedia||!host)return fail('no_media_slot');this.send(host,'audience.signal',{from:id,payload:msg.payload});}
      else if(actor.audienceHost&&ws===host){const peer=this.viewers().find((other)=>this.attachment(other).audienceId===msg.to&&(other.deserializeAttachment() as {audienceMedia?:boolean}).audienceMedia);if(peer)this.send(peer,'audience.signal',{payload:msg.payload});}
      else return fail('forbidden');return true;
    }
    if(msg.type==='audience.invite.request'){
      if(!actor.audienceHost&&!actor.audienceInvite)return fail('forbidden');
      if(!host)return fail('host_offline');
      const peer=this.viewers().find(other=>this.attachment(other).audienceId===msg.id);
      if(!peer)return fail('viewer_not_found');
      const recipient=this.attachment(peer);
      this.send(host,'audience.invite.request',{id:recipient.audienceId,name:recipient.name??'Audience guest'});return true;
    }
    if(msg.type==='audience.invite'){
      if(!actor.audienceHost&&!actor.audienceInvite)return fail('forbidden');
      // The host supplies an invite minted by the existing admission service.
      // Never trust an arbitrary external URL, and never activate camera/mic here.
      if(typeof msg.url!=='string'||typeof msg.id!=='string')return fail('invalid_invite');
      let url:URL;try{url=new URL(msg.url);}catch{return fail('invalid_invite');}
      if(!['http:','https:'].includes(url.protocol)||!/^\/(g|connect\/guest)\/[A-Za-z0-9_-]+$/.test(url.pathname)||!this.inviteAllowed(url))return fail('invalid_invite');
      const peer=this.viewers().find((other)=>this.attachment(other).audienceId===msg.id);if(peer)this.send(peer,'audience.invite',{url:msg.url});return true;
    }
    if(msg.type==='audience.moderate'){
      if(!control||typeof msg.id!=='string')return fail('forbidden');
      const peers=this.viewers().filter((other)=>this.attachment(other).audienceId===msg.id);
      if(msg.action==='remove'){state.bans=Object.fromEntries(Object.entries(state.bans).filter(([,until])=>until>now));if(Object.keys(state.bans).length>=100&&!state.bans[msg.id])return fail('moderation_limit');state.bans[msg.id]=now+3600000;state.hands=state.hands.filter((h)=>h.id!==msg.id);await this.storage.put(KEY,state);this.controls('audience.viewer.left',{id:msg.id});for(const peer of peers){peer.serializeAttachment({...this.attachment(peer),audienceMedia:false});this.send(peer,'audience.error',{code:'removed'});peer.close(4003,'Removed from room');}}
      else if(msg.action==='mute'){state.mutes=Object.fromEntries(Object.entries(state.mutes??{}).filter(([,until])=>until>now));if(Object.keys(state.mutes).length>=100&&!state.mutes[msg.id])return fail('moderation_limit');state.mutes[msg.id]=now+300000;await this.storage.put(KEY,state);for(const peer of peers)peer.serializeAttachment({...this.attachment(peer),mutedUntil:now+300000});}
      else if(msg.action==='delete'&&typeof msg.message_id==='string'){state.chat=state.chat.filter((m)=>m.id!==msg.message_id);await this.storage.put(KEY,state);this.broadcast('audience.snapshot',this.publicState(state));}
      else return fail('invalid_moderation');this.controls('audience.hands',{hands:state.hands});return true;
    }
    return fail('unknown_action');
  }); }
  leave(ws: Socket): Promise<void> { return this.serialize(async()=>{const actor=this.attachment(ws),state=await this.load();ws.serializeAttachment({...actor,audienceId:undefined,audienceMedia:false,audienceHost:false});if(actor.audienceHost && actor.publisherId===state.publisher){for(const viewer of this.viewers()){viewer.serializeAttachment({...this.attachment(viewer),audienceMedia:false});this.send(viewer,'audience.media.closed',{reason:'host_offline'});}}if(actor.audienceId){state.hands=state.hands.filter((h)=>h.id!==actor.audienceId);await this.storage.put(KEY,state);this.controls('audience.viewer.left',{id:actor.audienceId});this.controls('audience.hands',{hands:state.hands});}this.broadcast('audience.snapshot',this.publicState(state));}); }
}
