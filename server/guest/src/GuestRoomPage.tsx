// ── The room door — what a stranger opens ─────────────────────────────────────
//
// Route: /connect/guest/room/:code
//
// The audience is someone who has never heard of Producer and was sent a link by a
// friend who is about to go live. No account, no install: see yourself, type a
// name, press one button.
//
// Two things here are not cosmetic:
//
//   SLOT RESUME. The invite code is kept in localStorage and replayed on every
//   join. A reload therefore returns the SAME slot, the same render URL, and the
//   host's deliberate framing of this person survives — instead of a stray ⌘R
//   destroying and recreating their source live, mid-show.
//
//   WAITING IS A REAL STATE. A room link is public and will get shared, so
//   nothing reaches the broadcast until the host admits. The guest is told that
//   plainly rather than left staring at a frozen screen wondering if it worked.
//
// Once live they see the SHOW (program video returned by the host) as the main
// stage, with their own camera as a small self-view — the mental model of every
// remote-guest tool. They hear the host's mic, never the program mix: the mix
// contains their own delayed voice, which is what makes headphones mandatory
// everywhere else and is simply not sent here.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { CONNECT_API_BASE_URL } from "./apiConfig";
import { GuestMesh, type StageUpdate } from "./guestMesh";
import { controlsFor, resolveGrants, type GuestControls, type ParticipantLike } from "./participants";
import { HostLink, signalingWsUrl, type Session } from "./hostLink";

/** `grants` / `kind` arrive with the participant row (absent on servers that
 *  predate them → the default guest bundle, see participants.ts). */
type Guest = ParticipantLike & { id: string; display_name: string; status: string };

/** Stop and drop every local track the grants do not cover. A guest who lost
 *  media.mic between preview and join must not publish a microphone just
 *  because the preview already opened one. */
function applyMediaGrants(stream: MediaStream | null, can: GuestControls): void {
  if (!stream) return;
  for (const t of stream.getTracks()) {
    const allowed = t.kind === "video" ? can.camera : can.mic;
    if (!allowed) { t.stop(); stream.removeTrack(t); }
  }
}
type Phase = "name" | "waiting" | "live" | "gone" | "error";

const storageKey = (code: string) => `producer.guest.${code}`;

export default function GuestRoomPage({ code }: { code: string }) {
  const [phase, setPhase] = useState<Phase>("name");
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [guest, setGuest] = useState<Guest | null>(null);
  const [muted, setMuted] = useState(false);
  /** Hide MY OWN preview only — the camera keeps publishing; presenters who
   * find their own face distracting can turn the mirror off. */
  const [selfHidden, setSelfHidden] = useState(false);
  /** Hide the program's corner tile while off stage. */
  const [showHidden, setShowHidden] = useState(false);
  const showStreamRef = useRef<MediaStream | null>(null);
  // iOS WebKit crashes when a guest captures its camera AND decodes the
  // program return AND runs the mesh at once (memory pressure at admit).
  // Phones keep audio-only return; desktops keep the full picture.
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const [cameraOff, setCameraOff] = useState(false);
  const [hasShow, setHasShow] = useState(false);
  const [onStage, setOnStage] = useState(false);
  /** The program fills the picture only ON STAGE and only once it arrived;
   *  otherwise the self view stays large, never doubled. */
  const programMain = onStage && hasShow;
  const [hostListening, setHostListening] = useState(false);
  const [hostDown, setHostDown] = useState(false);
  const hostDownTimer = useRef<number | null>(null);
  const meshRef = useRef<GuestMesh | null>(null);
  const roomWsRef = useRef<WebSocket | null>(null);

  // What this participant may do. Unknown before the join answers (the room
  // link carries no identity), so the preview opens on the default bundle and
  // is trimmed the moment the server says otherwise.
  const grants = useMemo(() => resolveGrants(guest), [guest]);
  const can = useMemo(() => controlsFor(grants), [grants]);
  const canRef = useRef(can);
  canRef.current = can;

  const selfRef = useRef<HTMLVideoElement | null>(null);
  const showRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  /** Every connection that ends in Producer: camera peer, and the screen
   * peer while sharing. */
  const linkRef = useRef<HostLink | null>(null);
  const [sharing, setSharing] = useState(false);
  const inviteRef = useRef<string | null>(null);
  const guestIdRef = useRef<string | null>(null);

  // Remember the name too, so a reload does not make them retype it.
  useEffect(() => {
    if (!code) return;
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey(code)) ?? "null") as { invite?: string; name?: string } | null;
      if (saved?.invite) inviteRef.current = saved.invite;
      if (saved?.name) setName(saved.name);
    } catch { /* private mode, or cleared storage — a fresh join is correct */ }
  }, [code]);

  const startPreview = useCallback(async () => {
    const c = canRef.current;
    // Nothing to capture: a participant here to watch and take part, not to
    // appear. Never ask the browser for a permission we will not use.
    if (!c.camera && !c.mic) { streamRef.current = null; return; }
    try {
      // Explicit rather than `video: true`. Left to itself a phone will often
      // pick a conservative capture rate, and a guest arriving at 15fps on a
      // 30fps canvas reads as stutter on a moving shot — half the motion
      // smoothness, for no reason we chose.
      //
      // `ideal`, not `exact`: a device that genuinely cannot do 30 should still
      // join at whatever it can, rather than failing to get a camera at all.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: c.camera ? { frameRate: { ideal: 30 }, width: { ideal: 1280 }, height: { ideal: 720 } } : false,
        audio: c.mic ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true } : false,
      });
      streamRef.current = stream;
      // Tell the encoder this is MOTION, not a slideshow. Without the hint,
      // WebRTC's default degradation trades framerate away to hold resolution
      // the moment it thinks it is constrained — precisely the wrong trade for a
      // talking head, where a sharp stuttering face is worse than a slightly
      // softer smooth one.
      const vt = stream.getVideoTracks()[0];
      if (vt) vt.contentHint = "motion";
      if (selfRef.current) selfRef.current.srcObject = stream;
    } catch {
      setMessage(c.camera && c.mic
        ? "We need camera and microphone access to put you on the show."
        : c.camera ? "We need camera access to put you on the show." : "We need microphone access to put you on the show.");
    }
  }, []);

  useEffect(() => { void startPreview(); }, [startPreview]);

  // Grants can only NARROW what the preview already holds (the join answer
  // arrives after the preview opened on the default bundle). Widening would
  // need a fresh capture, which the guest triggers by reloading — and the
  // server never widens mid-show today.
  useEffect(() => { applyMediaGrants(streamRef.current, can); }, [can]);

  // Phase flips (waiting -> live, show arriving) remount the video elements;
  // a remounted node has NO srcObject. Re-attach whatever we hold so the
  // self view and the show survive every layout branch switch.
  useEffect(() => {
    const selfEl = selfRef.current;
    if (selfEl && streamRef.current && selfEl.srcObject !== streamRef.current) {
      selfEl.srcObject = streamRef.current;
      void selfEl.play().catch(() => {});
    }
    const showEl = showRef.current;
    if (showEl && showStreamRef.current && showEl.srcObject !== showStreamRef.current) {
      showEl.srcObject = showStreamRef.current;
      void showEl.play().catch(() => {});
    }
  });

  // Coming back to the foreground with dead tracks (phone locked mid-show,
  // app-switched during the queue): re-acquire, and if a call is already up,
  // swap the fresh tracks into its senders — no renegotiation needed.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      const s = streamRef.current;
      if (s && s.getTracks().every((t) => t.readyState === "live")) return;
      void (async () => {
        await startPreview();
        const fresh = streamRef.current;
        if (fresh) linkRef.current?.replaceLocalTracks(fresh);
      })();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [startPreview]);
  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    linkRef.current?.close();
  }, []);

  /** Poll our own admission state. The host may admit at any time, and there is
   *  nobody here to refresh the page. */
  const pollAdmission = useCallback(async (inviteCode: string) => {
    const res = await fetch(`${CONNECT_API_BASE_URL}/guest/${encodeURIComponent(inviteCode)}`);
    if (res.status === 410 || res.status === 404) { setPhase("gone"); return null; }
    if (!res.ok) return null;
    const body = (await res.json()) as { guest: Guest };
    setGuest(body.guest);
    return body.guest;
  }, []);

  const connect = useCallback(async (inviteCode: string) => {
    // iOS kills getUserMedia tracks when the page backgrounds or the phone
    // locks — routine during a queue wait. The ref still holds the DEAD
    // stream, so a truthiness check passes and we would wire ended tracks
    // into the call: black video, silent mic, a "connected" guest nobody
    // can see. Re-acquire whenever any track is no longer live.
    if (!streamRef.current || streamRef.current.getTracks().some((t) => t.readyState !== "live")) {
      await startPreview();
    }
    // Trim to the grants BEFORE anything is added to the call — the only
    // place a disallowed track could otherwise slip onto the wire.
    applyMediaGrants(streamRef.current, canRef.current);
    const res = await fetch(`${CONNECT_API_BASE_URL}/guest/${encodeURIComponent(inviteCode)}/session`, { method: "POST" });
    if (!res.ok) return;
    const session = (await res.json()) as Session;

    linkRef.current?.close();
    const link = new HostLink({
      session,
      wsUrl: signalingWsUrl(CONNECT_API_BASE_URL, session),
      // A participant with no media grants still connects — to receive the
      // return feed and, later, to take part — they simply publish nothing.
      localStream: () => streamRef.current,
      returnFeed: canRef.current.returnFeed,
      // Desktop asks for the program the moment the connection is up. iOS
      // waits until it has been stable for 5s AND the page is visible.
      delayReturnFeedMs: isIOS ? 5000 : 0,
      onProgram: (stream) => {
        // The SHOW. This is what they should be looking at.
        if (!canRef.current.returnFeed) return;
        showStreamRef.current = stream;
        if (showRef.current) { showRef.current.srcObject = stream; void showRef.current.play().catch(() => {}); }
        setHasShow(!!stream);
      },
      onHostAudio: (stream) => {
        // Host mic. Deliberately NOT the program mix — that would carry their
        // own delayed voice straight back into their ears and their microphone.
        // The return leg is a grant; without it nothing the host sends plays.
        if (!canRef.current.returnFeed) return;
        const el = document.getElementById("host-audio") as HTMLAudioElement | null;
        if (el) { el.srcObject = stream; void el.play().catch(() => {}); }
      },
      onData: (raw) => {
        const msg = raw as { kind?: string; on_stage?: string[]; version?: number; listening?: boolean };
        if (msg.kind === "stage" && Array.isArray(msg.on_stage) && typeof msg.version === "number") {
          const update: StageUpdate = { on_stage: msg.on_stage, version: msg.version };
          // "host": live truth from Producer, which is what unlocks publishing.
          meshRef.current?.applyStage(update, "host");
          setOnStage(msg.on_stage.includes(guestIdRef.current ?? ""));
        } else if (msg.kind === "cue") {
          // Being listened to privately is something we tell the guest. A green
          // room someone believes is private, that isn't, is a trust problem.
          setHostListening(!!msg.listening);
        }
      },
      onShareEnded: () => setSharing(false),
      onMainState: (state) => {
        if (state === "connected") {
          setPhase("live");
          setHostDown(false);
          if (hostDownTimer.current) { window.clearTimeout(hostDownTimer.current); hostDownTimer.current = null; }
          return;
        }
        if (state === "disconnected" || state === "failed" || state === "closed") {
          // FAIL CLOSED when the host goes away.
          //
          // The guest↔guest mesh is a SEPARATE connection and survives the host
          // dropping. Without this, guests keep talking to each other with "You're
          // on air" still lit, believing they are broadcasting to an audience that
          // is receiving nothing — and people say things off air they would never
          // say on it.
          //
          // A few seconds of grace first, because a brief ICE blip is not the host
          // leaving and flashing the indicator would be its own problem.
          if (hostDownTimer.current) return;
          hostDownTimer.current = window.setTimeout(() => {
            hostDownTimer.current = null;
            if (linkRef.current?.mainConnectionState() === "connected") return;
            setHostDown(true);
            setOnStage(false);
            setHostListening(false);
            // suspend(), not a synthetic stage update: faking a version would mean
            // no genuine push could ever exceed it and the mesh would stay empty
            // forever once the host came back.
            meshRef.current?.suspend();
          }, 4000);
        }
      },
    });
    linkRef.current = link;
  }, [startPreview, isIOS]);

  /** The ROOM channel: guest↔guest introduction only.
   *
   *  Stage state does NOT come from here — it arrives over the host's data
   *  channel, because Producer is the authority and reaching us directly is both
   *  faster and one fewer moving part. This socket exists solely because two
   *  guests cannot be introduced to each other any other way: each guest's
   *  render page is a separate browser process, so the host cannot relay between
   *  them. */
  const joinRoomChannel = useCallback(async (inviteCode: string) => {
    const res = await fetch(`${CONNECT_API_BASE_URL}/guest/${encodeURIComponent(inviteCode)}/room-session`, { method: "POST" });
    if (!res.ok) return;
    const body = (await res.json()) as {
      signaling_ticket: string; signaling_url: string; peer_id: string;
      stage: StageUpdate; ice_servers?: RTCIceServer[];
    };
    guestIdRef.current = body.peer_id;

    const api = new URL(CONNECT_API_BASE_URL, window.location.origin);
    const wsUrl = new URL(body.signaling_url, api.origin);
    wsUrl.protocol = api.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(wsUrl.toString());
    roomWsRef.current = ws;

    const mesh = new GuestMesh({
      selfId: body.peer_id,
      iceServers: body.ice_servers ?? [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }],
      localStream: () => streamRef.current,
      send: (to, payload) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "signal", to, payload }));
      },
      onPeerAudio: (peerId, stream) => {
        const elId = `peer-${peerId}`;
        let el = document.getElementById(elId) as HTMLAudioElement | null;
        if (!stream) { if (el) { el.srcObject = null; el.remove(); } return; }
        if (!el) {
          el = document.createElement("audio");
          el.id = elId;
          el.autoplay = true;
          document.body.appendChild(el);
        }
        el.srcObject = stream;
        void el.play().catch(() => {});
      },
    });
    meshRef.current = mesh;

    // Seed from the server's copy so we start CORRECT rather than waiting for
    // the host's first push. This is the cold-start path.
    // "server": the cached copy. Enough to start LISTENING immediately, not
    // enough to start speaking — see applyStage.
    mesh.applyStage(body.stage, "server");
    setOnStage(body.stage.on_stage.includes(body.peer_id));

    ws.onmessage = (event) => {
      let frame: { type?: string; from?: string; payload?: Record<string, unknown> };
      try { frame = JSON.parse(String(event.data)); } catch { return; }
      if (frame.type === "signal" && frame.from && frame.payload) {
        void mesh.onSignal(frame.from, frame.payload as never);
      }
    };
  }, []);

  /** One still frame so the host sees a face rather than a self-typed name.
   *  Small on purpose: 320px is plenty to recognise someone, and this is an
   *  unauthenticated upload. Returns undefined on any failure — a guest with no
   *  camera must still be able to join and simply shows a placeholder. */
  const captureSnapshot = useCallback((): string | undefined => {
    try {
      const video = selfRef.current;
      if (!video || !video.videoWidth) return undefined;
      const w = 320;
      const h = Math.round((video.videoHeight / video.videoWidth) * w) || 180;
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return undefined;
      ctx.drawImage(video, 0, 0, w, h);
      return canvas.toDataURL("image/jpeg", 0.7);
    } catch {
      return undefined;
    }
  }, []);

  const join = useCallback(async () => {
    if (!code || !name.trim()) return;
    setMessage("");
    const res = await fetch(`${CONNECT_API_BASE_URL}/guest/room/${encodeURIComponent(code)}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        display_name: name.trim(),
        resume_code: inviteRef.current ?? undefined,
        snapshot: captureSnapshot(),
      }),
    });
    if (res.status === 409) { setMessage("This room is full right now. Ask the host to make space."); return; }
    if (res.status === 410 || res.status === 404) { setPhase("gone"); return; }
    if (!res.ok) { setMessage("Could not join. Try again in a moment."); return; }

    const body = (await res.json()) as { guest: Guest; invite_code: string };
    inviteRef.current = body.invite_code;
    try { localStorage.setItem(storageKey(code), JSON.stringify({ invite: body.invite_code, name: name.trim() })); }
    catch { /* private mode — resume simply will not survive a reload */ }
    setGuest(body.guest);
    guestIdRef.current = body.guest.id;

    if (body.guest.status === "accepted") {
      setPhase("live");
      void connect(body.invite_code);
      void joinRoomChannel(body.invite_code);
    }
    else setPhase("waiting");
  }, [code, name, connect, captureSnapshot, joinRoomChannel]);

  useEffect(() => () => {
    if (hostDownTimer.current) window.clearTimeout(hostDownTimer.current);
    meshRef.current?.close();
    try { roomWsRef.current?.close(); } catch { /* already closed */ }
  }, []);

  // While waiting, watch for the host to admit us.
  useEffect(() => {
    if (phase !== "waiting" || !inviteRef.current) return;
    const invite = inviteRef.current;
    const timer = window.setInterval(async () => {
      const g = await pollAdmission(invite);
      if (g?.status === "accepted") {
        window.clearInterval(timer);
        setPhase("live");
        void connect(invite);
        void joinRoomChannel(invite);
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [phase, pollAdmission, connect, joinRoomChannel]);

  const toggleMute = () => {
    const t = streamRef.current?.getAudioTracks()[0];
    if (!t) return; t.enabled = !t.enabled; setMuted(!t.enabled);
  };
  const toggleCamera = () => {
    const t = streamRef.current?.getVideoTracks()[0];
    if (!t) return; t.enabled = !t.enabled; setCameraOff(!t.enabled);
  };
  /** Screen share is the HIGHER grant (media.screen): a second video track
   *  to the host, framed by them as its own source. */
  const toggleShare = async () => {
    const link = linkRef.current;
    if (!link) return;
    if (link.sharing) { link.stopShare(); setSharing(false); return; }
    const ok = await link.startShare();
    setSharing(ok);
    if (!ok) setMessage("Couldn't start screen sharing here. Try a desktop browser.");
  };

  if (phase === "gone" || phase === "error") {
    return (
      <div style={S.shell}><div style={S.card}>
        <h1 style={S.title}>This link has expired</h1>
        <p style={S.sub}>{message || "Ask whoever invited you for a fresh link."}</p>
      </div></div>
    );
  }

  return (
    <div style={S.shell}>
      <div style={S.card}>
        {phase === "live" ? (
          <>
            <p style={S.eyebrow}>
              {hostDown
                ? <><span style={S.dotIdle} /> Disconnected</>
                : onStage
                  ? <><span style={S.dot} /> You're on air</>
                  : <><span style={S.dotIdle} /> In the green room</>}
            </p>
            <h1 style={S.title}>{guest?.display_name}</h1>
            {/* ON STAGE: the program is the whole picture and you are a corner
                tile — the mental model of every remote-guest tool, and the
                only layout in which you are never doubled. GREEN ROOM: your
                own preview stays large (as while waiting), and the program,
                once it arrives, becomes the corner tile so you can follow the
                show until you are brought on. Tap either tile to hide it. */}
            <div style={S.stage}>
              {programMain ? (
                <video ref={showRef} autoPlay playsInline muted style={S.video} />
              ) : (
                <video ref={selfRef} autoPlay playsInline muted style={{ ...S.video, transform: "scaleX(-1)", ...(selfHidden ? { visibility: "hidden" } : null) }} />
              )}
              {!programMain && !can.camera && <div style={S.placeholder}>{can.mic ? "Audio only" : "You're here to watch and take part"}</div>}
              {!programMain && can.camera && cameraOff && <div style={S.placeholder}>Camera off</div>}
              {programMain && cameraOff && !selfHidden && <div style={S.tileNote}>Camera off</div>}
              {hostDown && (
                // Over the last frame rather than replacing it, so the guest can
                // see the connection is the problem and not their camera.
                <div style={S.reconnecting}>Reconnecting to the show…</div>
              )}
              {hostListening && !onStage && !hostDown && (
                // Told, not hidden. Someone in a room they believe is private,
                // being listened to, is a trust problem rather than a feature.
                <div style={S.listening}>The host is listening</div>
              )}
              {/* The corner tile: self while on stage, the show while off it. */}
              {programMain && can.camera && (
                <video
                  ref={selfRef}
                  autoPlay playsInline muted
                  title="Tap to hide"
                  onClick={() => setSelfHidden(true)}
                  style={{ ...S.tile, transform: "scaleX(-1)", ...(selfHidden ? { display: "none" } : null) }}
                />
              )}
              {!programMain && can.returnFeed && (
                <video
                  ref={showRef}
                  autoPlay playsInline muted
                  title="Tap to hide"
                  onClick={() => setShowHidden(true)}
                  style={{ ...S.tile, ...(hasShow && !showHidden ? null : { display: "none" }) }}
                />
              )}
              {!programMain && can.returnFeed && !hasShow && !onStage && !hostDown && (
                <div style={S.tileWait}>Waiting for the show…</div>
              )}
              {programMain && selfHidden && can.camera && (
                <button onClick={() => setSelfHidden(false)} style={S.tileChip}>Show me</button>
              )}
              {!programMain && showHidden && hasShow && (
                <button onClick={() => setShowHidden(false)} style={S.tileChip}>Show the program</button>
              )}
            </div>
          </>
        ) : (
          <>
            <p style={S.eyebrow}>{phase === "waiting" ? "Waiting to be let in" : "Join the show"}</p>
            <h1 style={S.title}>{phase === "waiting" ? "You're in the queue" : "What should we call you?"}</h1>
            <div style={S.stage}>
              <video ref={selfRef} autoPlay playsInline muted style={{ ...S.video, transform: "scaleX(-1)", ...(selfHidden ? { visibility: "hidden" } : null) }} />
              {can.camera && cameraOff && <div style={S.placeholder}>Camera off</div>}
              {!can.camera && <div style={S.placeholder}>{can.mic ? "Audio only" : "You're here to watch and take part"}</div>}
            </div>
            {phase === "waiting" ? (
              <p style={S.sub}>The host has to let you in. Keep this tab open — you'll go live automatically.</p>
            ) : (
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void join(); }}
                placeholder="Your name"
                maxLength={80}
                style={S.input}
              />
            )}
          </>
        )}

        {/* Controls exist only for grants held. A control the participant
            cannot use is not disabled — it is absent, so the page reads as
            what THEY are here to do. */}
        <div style={S.controls}>
          {can.mic && <button onClick={toggleMute} style={S.ghost}>{muted ? "Unmute" : "Mute"}</button>}
          {can.camera && <button onClick={toggleCamera} style={S.ghost}>{cameraOff ? "Start camera" : "Stop camera"}</button>}
          {can.camera && (
            <button onClick={() => setSelfHidden((h) => !h)} style={S.ghost}>{selfHidden ? "Show my preview" : "Hide my preview"}</button>
          )}
          {can.screen && phase === "live" && (
            <button onClick={() => void toggleShare()} style={sharing ? S.ghostOn : S.ghost}>
              {sharing ? "Stop sharing" : "Share screen"}
            </button>
          )}
          {phase === "name" && (
            <button onClick={() => void join()} disabled={!name.trim()} style={S.primary}>Join the show</button>
          )}
        </div>

        {message && <p style={S.note}>{message}</p>}
        <p style={S.fine}>
          Your camera and audio go straight to the host's computer. This server
          doesn't record or store this video. You're only heard by the audience
          while you're on air.
        </p>
        <p style={S.fine}>
          Powered by{" "}
          <a href="https://producer.dev" target="_blank" rel="noreferrer" style={S.plug}>Producer</a>
        </p>
      </div>
      {/* Host mic only — never the program mix, which would carry your own
          delayed voice back to you. */}
      <audio id="host-audio" autoPlay />
    </div>
  );
}

const S: Record<string, CSSProperties> = {
  shell: { minHeight: "100vh", display: "grid", placeItems: "center", background: "#0a0a0b", padding: 24, fontFamily: "system-ui, sans-serif" },
  card: { width: "min(680px, 100%)", color: "#fff" },
  eyebrow: { margin: 0, fontSize: 13, letterSpacing: "0.08em", textTransform: "uppercase", color: "#8b8b93", display: "flex", alignItems: "center", gap: 8 },
  dot: { width: 7, height: 7, borderRadius: 999, background: "#ff3b30", display: "inline-block" },
  dotIdle: { width: 7, height: 7, borderRadius: 999, background: "#6b6b73", display: "inline-block" },
  reconnecting: { position: "absolute", inset: 0, display: "grid", placeItems: "center", background: "rgba(10,10,11,.72)", fontSize: 14, color: "#e7e7ea" },
  listening: { position: "absolute", top: 12, left: 12, background: "rgba(0,0,0,.65)", padding: "6px 10px", borderRadius: 999, fontSize: 12, letterSpacing: "0.02em" },
  title: { margin: "6px 0 20px", fontSize: 28, fontWeight: 600, letterSpacing: "-0.02em" },
  sub: { color: "#8b8b93", fontSize: 14, marginTop: 14, lineHeight: 1.5 },
  stage: { position: "relative", aspectRatio: "16 / 9", background: "#141416", borderRadius: 14, overflow: "hidden", border: "1px solid #232327" },
  video: { width: "100%", height: "100%", objectFit: "cover", display: "block" },
  /** The corner tile — 160px on a phone, a quarter of the picture on a
   *  desktop, never both images at full size. */
  tile: { position: "absolute", right: 12, bottom: 12, width: "clamp(120px, 26%, 220px)", aspectRatio: "16 / 9", objectFit: "cover", borderRadius: 8, border: "1px solid #2c2c31", background: "#0a0a0b", cursor: "pointer", boxShadow: "0 4px 14px rgba(0,0,0,.5)" },
  tileWait: { position: "absolute", right: 12, bottom: 12, width: "clamp(120px, 26%, 220px)", aspectRatio: "16 / 9", display: "grid", placeItems: "center", borderRadius: 8, border: "1px dashed #2c2c31", color: "#6b6b73", fontSize: 11, background: "rgba(10,10,11,.6)" },
  tileNote: { position: "absolute", right: 12, bottom: 12, width: "clamp(120px, 26%, 220px)", aspectRatio: "16 / 9", display: "grid", placeItems: "center", borderRadius: 8, color: "#6b6b73", fontSize: 11, pointerEvents: "none" },
  tileChip: { position: "absolute", right: 12, bottom: 12, background: "rgba(0,0,0,.65)", color: "#e7e7ea", border: "1px solid #2c2c31", borderRadius: 999, padding: "6px 10px", fontSize: 12, cursor: "pointer" },
  placeholder: { position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "#6b6b73", fontSize: 14 },
  input: { marginTop: 14, width: "100%", background: "#141416", color: "#e7e7ea", border: "1px solid #232327", borderRadius: 10, padding: "12px 14px", fontSize: 15 },
  controls: { display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" },
  ghost: { background: "transparent", color: "#e7e7ea", border: "1px solid #2c2c31", borderRadius: 10, padding: "10px 14px", fontSize: 14, cursor: "pointer" },
  ghostOn: { background: "#1d3a2f", color: "#a7f3d0", border: "1px solid #2f6b55", borderRadius: 10, padding: "10px 14px", fontSize: 14, cursor: "pointer" },
  primary: { marginLeft: "auto", background: "#fff", color: "#0a0a0b", border: "none", borderRadius: 10, padding: "10px 18px", fontSize: 14, fontWeight: 600, cursor: "pointer" },
  note: { marginTop: 12, fontSize: 13, color: "#ffb4a8" },
  fine: { marginTop: 18, fontSize: 12, color: "#6b6b73", lineHeight: 1.5 },
  plug: { color: "#e7e7ea", fontWeight: 600, textDecoration: "none", borderBottom: "1px solid #3a3a40" },
};
