import { Room, RoomEvent, Track, ConnectionState, setLogLevel, LogLevel,
  type ParticipantTrackPermission, type RemoteParticipant, type RemoteTrackPublication, type RemoteTrack } from "livekit-client";
import { readGuestRtcAuthority, validateGuestRtcSession, sameGuestRtcBinding, guestTrackAllowed, guestPeerAudioAllowed, guestAudioRecipients, type GuestRtcAuthority } from "./producerGuestAuthority";

type Callbacks = {
  onStage?: (onStage: boolean) => void;
  onDiagnostic?: (phase: "poll" | "retire_start" | "retire_end" | "connect_start" | "connect_end" | "publish_start" | "publish_end" | "poll_failed") => void;
  onState: (state: "waiting" | "live" | "reconnecting" | "gone" | "error") => void;
  onProgram: (stream: MediaStream | null) => void;
  onAudio: (stream: MediaStream | null) => void;
};
/** Shared guest transport owner, ported from Boomin guest web. Owns SDK
 * publications/subscriptions, never the caller's
 * preview tracks. No HostLink or guest mesh is created on this path. */
export class ProducerGuestRtc {
  private room: Room | null = null;
  private joining: Promise<void> | null = null;
  private preparedRoom: Room | null = null;
  private stopRequested = false;
  private request = new AbortController();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ticket: string | null = null;
  private startupSupported = true;
  private ticketRenewAt = 0;
  private authority: GuestRtcAuthority | null = null;
  private lastAuthorityAt = 0;
  private video: RemoteTrack | null = null;
  private audio: RemoteTrack | null = null;
  private peerAudio = new Map<string,{track:RemoteTrack; element:HTMLMediaElement}>();
  private closed: Promise<void> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  constructor(private input: {api: string; invite: string; participantId: string; endpoint: string;
    localStream: () => MediaStream | null} & Callbacks) {}

  start(): void {
    if (this.stopRequested || this.watchdog) return;
    setLogLevel(LogLevel.silent);
    this.preparedRoom = new Room({adaptiveStream: false, dynacast: false, stopLocalTrackOnUnpublish: false});
    // DNS/TLS warming carries no token, capture, publication or admission.
    void this.preparedRoom.prepareConnection(this.input.endpoint).catch(() => {});
    this.watchdog=setInterval(()=>{
      if(this.room && this.authority && this.lastAuthorityAt && Date.now()-this.lastAuthorityAt>=3500){
        this.lastAuthorityAt=0;void this.retire();this.input.onState("reconnecting");
      }
    },100);
    void this.poll();
  }
  private async json(path: string, body?: unknown): Promise<{status: number; value: unknown}> {
    const r = await fetch(`${this.input.api}/guest/${encodeURIComponent(this.input.invite)}/rtc/${path}`, {
      method: body === undefined ? "GET" : "POST", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", redirect: "error",
      headers: body === undefined ? {} : {"Content-Type": "application/json"},
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([this.request.signal, AbortSignal.timeout(2500)]),
    });
    if (path === "startup" && (r.status === 404 || r.status === 405)) {
      await r.body?.cancel();
      return {status:r.status,value:null};
    }
    // Never put token-bearing or provider error responses into a diagnostic.
    const reader=r.body?.getReader();
    if(!reader)throw new Error("Guest media response unavailable");
    const chunks:Uint8Array[]=[];let size=0;
    try {
      for (;;) {
        const chunk=await reader.read();if(chunk.done)break;
        size+=chunk.value.byteLength;
        if(size>32768){await reader.cancel();throw new Error("Guest media response too large");}
        chunks.push(chunk.value);
      }
    } finally {reader.releaseLock();}
    const bytes=new Uint8Array(size);let offset=0;
    for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    return {status: r.status, value: JSON.parse(new TextDecoder().decode(bytes))};
  }
  private clearReturn(): void {
    for(const peer of this.peerAudio.values()){peer.element.pause();peer.track.detach(peer.element);peer.element.srcObject=null;peer.element.remove();}
    this.peerAudio.clear();
    this.video = this.audio = null;
    this.input.onProgram(null); this.input.onAudio(null);
  }
  private async retire(): Promise<void> {
    this.input.onDiagnostic?.("retire_start");
    const room = this.room; this.room = null; this.authority = null;this.lastAuthorityAt=0;
    this.clearReturn();
    if (room) { room.removeAllListeners(); await room.disconnect(false); }
    this.input.onDiagnostic?.("retire_end");
  }
  private subscribe(publication: RemoteTrackPublication, participant: RemoteParticipant): void {
    const authorized = this.authority?.expected.can_subscribe === true && !this.stopRequested && this.lastAuthorityAt>0 && Date.now()-this.lastAuthorityAt<3500 && (participant.identity === this.authority?.producer_identity &&
      ((publication.source === Track.Source.Camera && publication.kind === Track.Kind.Video) ||
       (publication.source === Track.Source.Microphone && publication.kind === Track.Kind.Audio)) ||
       !!this.authority && guestPeerAudioAllowed(this.authority,participant.identity) && publication.source===Track.Source.Microphone && publication.kind===Track.Kind.Audio);
    publication.setSubscribed(authorized);
  }
  private returnTrack(track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant): void {
    if (this.stopRequested || this.authority?.expected.can_subscribe !== true || !this.lastAuthorityAt || Date.now()-this.lastAuthorityAt>=3500 ) {publication.setSubscribed(false); return;}
    if(participant.identity!==this.authority.producer_identity){
      if(!guestPeerAudioAllowed(this.authority,participant.identity) || publication.source!==Track.Source.Microphone || track.kind!==Track.Kind.Audio){publication.setSubscribed(false);return;}
      const old=this.peerAudio.get(publication.trackSid);
      if(old?.track===track)return;
      if(old){old.element.pause();old.track.detach(old.element);old.element.srcObject=null;old.element.remove();}
      const element=track.attach();element.hidden=true;document.body.appendChild(element);
      this.peerAudio.set(publication.trackSid,{track,element});void element.play().catch(()=>{});return;
    }
    if (publication.source === Track.Source.Camera && track.kind === Track.Kind.Video) {
      if (this.video && this.video.sid === track.sid && this.video.mediaStreamTrack === track.mediaStreamTrack) return;
      this.video = track; this.input.onProgram(new MediaStream([track.mediaStreamTrack]));
    } else if (publication.source === Track.Source.Microphone && track.kind === Track.Kind.Audio) {
      if (this.audio && this.audio.sid === track.sid && this.audio.mediaStreamTrack === track.mediaStreamTrack) return;
      this.audio = track; this.input.onAudio(new MediaStream([track.mediaStreamTrack]));
    } else publication.setSubscribed(false);
  }
  private updateAudioPermissions(authority:GuestRtcAuthority):void {
    const room=this.room;if(!room)return;
    const mic=[...room.localParticipant.trackPublications.values()].find(pub=>pub.source===Track.Source.Microphone)?.trackSid;
    room.localParticipant.setTrackSubscriptionPermissions(false,[
      {participantIdentity:authority.producer_identity,allowAll:true},
      ...(mic ? guestAudioRecipients(authority).map<ParticipantTrackPermission>(participantIdentity=>({participantIdentity,allowAll:false,allowedTrackSids:[mic]})):[]),
    ]);
    for(const [sid,peer]of this.peerAudio){
      const participant=[...room.remoteParticipants.values()].find(p=>[...p.trackPublications.values()].some(pub=>pub.trackSid===sid));
      if(!participant || !guestPeerAudioAllowed(authority,participant.identity)){
        peer.element.pause();peer.track.detach(peer.element);peer.element.srcObject=null;peer.element.remove();this.peerAudio.delete(sid);
      }
    }
  }
  private async join(authority: GuestRtcAuthority, startupSession?: unknown): Promise<void> {
    if (!this.ticket) {
      const c = await this.json("connection", {session_version: 1});
      const v = c.value as {connection_ticket?: unknown};
      if (![200,201].includes(c.status) || typeof v.connection_ticket !== "string" || !v.connection_ticket || v.connection_ticket.length > 8192) throw new Error("Guest connection unavailable");
      this.ticket = v.connection_ticket; this.ticketRenewAt = Date.now() + 300000;
    }
    const e = authority.expected;
    let sessionValue = startupSession;
    if (sessionValue === undefined) {
      const minted = await this.json("session", {connection_ticket: this.ticket,
        expected: {run_id: e.run_id, control_revision: e.control_revision, host_lease_epoch: e.host_lease_epoch}});
      if (minted.status === 401 || minted.status === 409) {this.ticket=null;this.ticketRenewAt=0;}
      if (minted.status !== 200) throw new Error("Guest authorization changed while joining");
      sessionValue = minted.value;
    }
    const session = validateGuestRtcSession(sessionValue, authority);
    if (this.stopRequested) return;
    // The SDK can otherwise log provider credentials in errors. This owner
    // exposes only fixed application messages and disables SDK console logs.
    setLogLevel(LogLevel.silent);
    const room = this.preparedRoom ?? new Room({adaptiveStream: false, dynacast: false, stopLocalTrackOnUnpublish: false});
    this.preparedRoom = null;
    this.room = room; this.authority = authority;
    room.on(RoomEvent.TrackPublished, (pub, participant) => this.subscribe(pub, participant));
    room.on(RoomEvent.TrackSubscribed, (track, pub, participant) => this.returnTrack(track, pub, participant));
    room.on(RoomEvent.TrackUnsubscribed, track => {
      const peer=track.sid ? this.peerAudio.get(track.sid):undefined;
      if(peer){peer.element.pause();track.detach(peer.element);peer.element.srcObject=null;peer.element.remove();if(track.sid)this.peerAudio.delete(track.sid);}
      if (this.video?.sid === track.sid) {this.video = null; this.input.onProgram(null);}
      if (this.audio?.sid === track.sid) {this.audio = null; this.input.onAudio(null);}
    });
    room.on(RoomEvent.Reconnecting, () => {
      this.lastAuthorityAt=0;this.clearReturn();
      if(this.authority)room.localParticipant.setTrackSubscriptionPermissions(false,[{participantIdentity:this.authority.producer_identity,allowAll:true}]);
      this.input.onState("reconnecting");
    });
    room.on(RoomEvent.Reconnected, () => {
      // Authority is checked by the next poll before returning media.
      this.lastAuthorityAt = 0; this.input.onState("reconnecting");
    });
    room.on(RoomEvent.Disconnected, () => {this.clearReturn(); this.input.onState("reconnecting");});
    this.input.onDiagnostic?.("connect_start");
    await room.connect(session.endpoint, session.join_token, {autoSubscribe: false});
    this.input.onDiagnostic?.("connect_end");
    if (this.stopRequested || this.room !== room) {await room.disconnect(false); return;}
    if (room.localParticipant.identity !== session.rtc_identity) throw new Error("Guest RTC identity mismatch");
    // Read again after SDK connect. Admission can change while ICE is running.
    const current = await this.json("state?stage_audio=1");
    const next = readGuestRtcAuthority(current.value, this.input.participantId, this.input.endpoint);
    if (current.status !== 200 || !sameGuestRtcBinding(authority, next)) throw new Error("Guest authority changed during connect");
    if(this.stopRequested || this.room!==room){await room.disconnect(false);return;}
    this.lastAuthorityAt = Date.now();
    // Backstage publications are readable only by the current host receiver.
    // Keep this permission through Show/Hide; program placement is separate.
    room.localParticipant.setTrackSubscriptionPermissions(false, [
      {participantIdentity: next.producer_identity, allowAll: true},
    ]);
    this.authority=next;
    this.input.onStage?.(next.on_stage === true);
    const stream = this.input.localStream();
    const tracks = stream?.getTracks().filter(track => guestTrackAllowed(authority,track.kind)) ?? [];
    if ((guestTrackAllowed(authority,"video") && !tracks.some(t=>t.kind==="video")) ||
        (guestTrackAllowed(authority,"audio") && !tracks.some(t=>t.kind==="audio")) || tracks.some(t=>t.readyState!=="live"))
      throw new Error("Authorized camera or microphone unavailable");
    for (const track of tracks) {
      this.input.onDiagnostic?.("publish_start");
      await room.localParticipant.publishTrack(track, {source: track.kind === "video" ? Track.Source.Camera : Track.Source.Microphone,
        name: track.kind === "video" ? "guest-camera" : "guest-microphone", stream: "guest-av",
        simulcast: false, dtx: false, red: false, videoCodec: "vp8"});
      this.input.onDiagnostic?.("publish_end");
      if (this.stopRequested || this.room !== room) {await room.disconnect(false); return;}
    }
    this.updateAudioPermissions(next);
    for (const p of room.remoteParticipants.values()) for (const pub of p.trackPublications.values()) this.subscribe(pub, p);
    this.input.onState("live");
  }
  private async poll(): Promise<void> {
    this.input.onDiagnostic?.("poll");
    try {
      let startupSession: unknown;
      let state: {status:number;value:unknown};
      if (this.startupSupported && !this.ticket && !this.room && !this.joining) {
        state = await this.json("startup", {session_version:1});
        if (state.status === 404 || state.status === 405) {
          this.startupSupported = false;
          state = await this.json("state?stage_audio=1");
        } else if (state.status === 201) {
          if (this.stopRequested) return;
          const value = state.value as {authority?:unknown;connection_ticket?:unknown;session?:unknown;session_version?:unknown};
          if (value?.session_version !== 1 || typeof value.connection_ticket !== "string"
            || !value.connection_ticket || value.connection_ticket.length > 4096)
            throw new Error("Guest startup response unavailable");
          const authority = readGuestRtcAuthority(value.authority,this.input.participantId,this.input.endpoint);
          validateGuestRtcSession(value.session,authority);
          this.ticket = value.connection_ticket; this.ticketRenewAt = Date.now() + 300000;
          startupSession = value.session;
          state = {status:200,value:value.authority};
        }
      } else state = await this.json("state?stage_audio=1");
      if (this.stopRequested) return;
      if (state.status === 404 || state.status === 410) {await this.close(); this.input.onState("gone"); return;}
      // A host gap invalidates the run-bound connection; keep caller capture alive.
      if (state.status === 409) {this.ticket=null;this.ticketRenewAt=0;await this.retire(); this.input.onState("waiting");}
      else if (state.status !== 200) throw new Error("Guest authority unavailable");
      else {
        const next = readGuestRtcAuthority(state.value, this.input.participantId, this.input.endpoint);
        if (this.authority && !sameGuestRtcBinding(this.authority, next)) {await this.retire(); this.ticket = null;}
        this.lastAuthorityAt = Date.now();
        this.input.onStage?.(next.on_stage === true);
        if (this.ticket && Date.now() >= this.ticketRenewAt) {
          const r = await this.json("connection/renew", {connection_ticket: this.ticket});
          if(r.status===401 || r.status===409){this.ticket=null;this.ticketRenewAt=0;await this.retire();}
          const v = r.value as {connection_ticket?: unknown};
          if (r.status !== 200 || typeof v.connection_ticket !== "string" || !v.connection_ticket || v.connection_ticket.length > 8192) throw new Error("Guest renewal unavailable");
          this.ticket = v.connection_ticket; this.ticketRenewAt = Date.now() + 300000;
        }
        if (this.room?.state === ConnectionState.Disconnected) await this.retire();
        if (!this.room && !this.joining) {
          // SDK connect/publication may exceed the authority freshness window.
          // Keep polling independently instead of letting our watchdog cancel
          // a healthy join. Only one SDK join may be in flight at a time.
          const joining = this.join(next,startupSession).catch(async () => {
            if (this.stopRequested) return;
            this.input.onDiagnostic?.("poll_failed");
            await this.retire();
            this.input.onState("reconnecting");
          }).finally(() => {
            if (this.joining === joining) this.joining = null;
          });
          this.joining = joining;
        } else if (!this.joining && this.room?.state === ConnectionState.Connected) {
          this.authority=next;
          this.updateAudioPermissions(next);
          for (const p of this.room.remoteParticipants.values()) for (const pub of p.trackPublications.values()) {
            this.subscribe(pub, p);
            if (pub.track) this.returnTrack(pub.track, pub, p);
          }
          this.input.onState("live");
        }
      }
    } catch {
      this.input.onDiagnostic?.("poll_failed");
      // A stale permit cannot keep publishing through a control-plane outage.
      if (this.stopRequested) return;
      if (!this.lastAuthorityAt || Date.now() - this.lastAuthorityAt >= 3000) await this.retire();
      this.input.onState("reconnecting");
    } finally {
      if (!this.stopRequested) this.timer = setTimeout(() => {this.timer = null; void this.poll();}, 1000);
    }
  }
  async replaceLocalTracks(): Promise<void> {
    // Retire the whole publication pair so a camera replacement cannot leave
    // old audio attached. The next independently authorized poll republishes.
    await this.retire();
  }
  async resumeAudio(): Promise<void> {await this.room?.startAudio();await Promise.allSettled([...this.peerAudio.values()].map(peer=>peer.element.play()));}
  close(): Promise<void> {
    if (this.closed) return this.closed;
    this.stopRequested = true; this.request.abort();
    if (this.timer) {clearTimeout(this.timer); this.timer = null;}
    if(this.watchdog){clearInterval(this.watchdog);this.watchdog=null;}
    this.ticket = null;
    const prepared=this.preparedRoom;this.preparedRoom=null;
    if(prepared)prepared.removeAllListeners();
    this.closed = Promise.all([this.retire(),prepared?.disconnect(false)]).then(()=>{});
    return this.closed;
  }
}
