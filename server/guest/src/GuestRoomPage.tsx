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

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { CONNECT_API_BASE_URL } from "./apiConfig";
import { GuestMesh, type StageUpdate } from "./guestMesh";

type Guest = { id: string; display_name: string; status: string };
type Session = { signaling_ticket: string; signaling_url: string; ice_servers: RTCIceServer[] };
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
  const showStreamRef = useRef<MediaStream | null>(null);
  // iOS WebKit crashes when a guest captures its camera AND decodes the
  // program return AND runs the mesh at once (memory pressure at admit).
  // Phones keep audio-only return; desktops keep the full picture.
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const [cameraOff, setCameraOff] = useState(false);
  const [hasShow, setHasShow] = useState(false);
  const [onStage, setOnStage] = useState(false);
  const [hostListening, setHostListening] = useState(false);
  const [hostDown, setHostDown] = useState(false);
  const hostDownTimer = useRef<number | null>(null);
  const meshRef = useRef<GuestMesh | null>(null);
  const roomWsRef = useRef<WebSocket | null>(null);

  const selfRef = useRef<HTMLVideoElement | null>(null);
  const showRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
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
    try {
      // Explicit rather than `video: true`. Left to itself a phone will often
      // pick a conservative capture rate, and a guest arriving at 15fps on a
      // 30fps canvas reads as stutter on a moving shot — half the motion
      // smoothness, for no reason we chose.
      //
      // `ideal`, not `exact`: a device that genuinely cannot do 30 should still
      // join at whatever it can, rather than failing to get a camera at all.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { frameRate: { ideal: 30 }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
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
      setMessage("We need camera and microphone access to put you on the show.");
    }
  }, []);

  useEffect(() => { void startPreview(); }, [startPreview]);

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
        const pc = pcRef.current;
        const fresh = streamRef.current;
        if (!pc || !fresh) return;
        for (const sn of pc.getSenders()) {
          const t = fresh.getTracks().find((tr) => tr.kind === sn.track?.kind);
          if (t && sn.track !== t) void sn.replaceTrack(t).catch(() => {});
        }
      })();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [startPreview]);
  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    try { wsRef.current?.close(); } catch { /* already closed */ }
    try { pcRef.current?.close(); } catch { /* already closed */ }
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
    if (!streamRef.current) return;
    const res = await fetch(`${CONNECT_API_BASE_URL}/guest/${encodeURIComponent(inviteCode)}/session`, { method: "POST" });
    if (!res.ok) return;
    const session = (await res.json()) as Session;

    const pc = new RTCPeerConnection({ iceServers: session.ice_servers });
    pcRef.current = pc;
    streamRef.current.getTracks().forEach((t) => pc.addTrack(t, streamRef.current!));

    // Same reasoning as contentHint, applied at the sender: under constraint,
    // drop resolution before framerate. Best-effort — not every browser accepts
    // degradationPreference, and a rejection must not stop the guest joining.
    try {
      const sender = pc.getSenders().find((sn) => sn.track?.kind === "video");
      if (sender) {
        const params = sender.getParameters();
        (params as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference = "maintain-framerate";
        await sender.setParameters(params);
      }
    } catch {
      /* unsupported here; contentHint still biases the encoder */
    }

    // Producer pushes stage changes and cue state to the render page natively,
    // and the render page forwards them down this channel. That is why stage
    // state does not need a server hop — the host IS the authority and now
    // reaches us directly.
    pc.ondatachannel = (ev) => {
      ev.channel.onmessage = (m) => {
        let msg: { kind?: string; on_stage?: string[]; version?: number; listening?: boolean };
        try { msg = JSON.parse(String(m.data)); } catch { return; }
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
      };
    };

    pc.ontrack = (event) => {
      const [stream] = event.streams;
      if (!stream) return;
      if (event.track.kind === "video") {
        // The SHOW. This is what they should be looking at. It only arrives
        // after WE sent program-ready — a phone asks once its connection has
        // settled, so the admit-time decode storm that crashed iOS is gone.
        showStreamRef.current = stream;
        if (showRef.current) { showRef.current.srcObject = stream; void showRef.current.play().catch(() => {}); }
        setHasShow(true);
      } else {
        // Host mic. Deliberately NOT the program mix — that would carry their
        // own delayed voice straight back into their ears and their microphone.
        const el = document.getElementById("host-audio") as HTMLAudioElement | null;
        if (el) { el.srcObject = stream; void el.play().catch(() => {}); }
      }
    };

    const api = new URL(CONNECT_API_BASE_URL, window.location.origin);
    const wsUrl = new URL(session.signaling_url, api.origin);
    wsUrl.protocol = api.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(wsUrl.toString());
    wsRef.current = ws;
    const send = (payload: unknown) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "signal", payload }));
    };

    let makingOffer = false;
    pc.onicecandidate = (e) => { if (e.candidate) send({ kind: "ice", candidate: e.candidate.toJSON() }); };
    // Ask for the program return leg when this end can afford to decode it.
    // Desktop: immediately on connect. iOS: after the connection has been
    // stable for 5s AND the page is visible — decoding the program while
    // acquiring the camera and joining the mesh is what crashed WebKit.
    let programAsked = false;
    const askProgram = () => {
      if (programAsked) return;
      programAsked = true;
      send({ kind: "program-ready" });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState !== "connected") return;
      if (!isIOS) {
        askProgram();
        return;
      }
      window.setTimeout(() => {
        if (pc.connectionState === "connected" && document.visibilityState === "visible") askProgram();
      }, 5000);
    };
    pc.onnegotiationneeded = async () => {
      try { makingOffer = true; await pc.setLocalDescription(); send({ kind: "sdp", description: pc.localDescription }); }
      catch { /* the reconnect path retries */ } finally { makingOffer = false; }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        setPhase("live");
        setHostDown(false);
        if (hostDownTimer.current) { window.clearTimeout(hostDownTimer.current); hostDownTimer.current = null; }
        return;
      }
      if (pc.connectionState === "failed") pc.restartIce();

      if (pc.connectionState === "disconnected" || pc.connectionState === "failed" || pc.connectionState === "closed") {
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
          if (pcRef.current?.connectionState === "connected") return;
          setHostDown(true);
          setOnStage(false);
          setHostListening(false);
          // suspend(), not a synthetic stage update: faking a version would mean
          // no genuine push could ever exceed it and the mesh would stay empty
          // forever once the host came back.
          meshRef.current?.suspend();
        }, 4000);
      }
    };
    ws.onopen = () => {
      send({ kind: "hello" });
      // Flush an offer created before the socket opened — send() drops while
      // CONNECTING, and losing it leaves both peers waiting on each other.
      if (pc.localDescription) send({ kind: "sdp", description: pc.localDescription });
    };
    ws.onmessage = async (event) => {
      let frame: { type?: string; payload?: { kind?: string; description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit } };
      try { frame = JSON.parse(String(event.data)); } catch { return; }
      if (frame.type !== "signal" || !frame.payload) return;
      const msg = frame.payload;
      try {
        if (msg.kind === "sdp" && msg.description) {
          const collision = msg.description.type === "offer" && (makingOffer || pc.signalingState !== "stable");
          // POLITE peer: on a collision we roll back and take theirs.
          if (collision) await pc.setLocalDescription({ type: "rollback" } as RTCLocalSessionDescriptionInit);
          await pc.setRemoteDescription(msg.description);
          if (msg.description.type === "offer") {
            await pc.setLocalDescription();
            send({ kind: "sdp", description: pc.localDescription });
          }
        } else if (msg.kind === "ice" && msg.candidate) {
          await pc.addIceCandidate(msg.candidate).catch(() => {});
        }
      } catch { /* one bad frame must never kill the call */ }
    };
  }, [startPreview]);

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
            <div style={S.stage}>
              {/* The SHOW is the main view — what they should be watching. */}
              <video ref={showRef} autoPlay playsInline muted style={S.video} />
              {!hasShow && <div style={S.placeholder}>Waiting for the show…</div>}
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
              {/* Their own camera, small. Muted: nobody should hear themselves. */}
              <video ref={selfRef} autoPlay playsInline muted style={{ ...S.selfView, ...(selfHidden ? { display: "none" } : null) }} />
            </div>
          </>
        ) : (
          <>
            <p style={S.eyebrow}>{phase === "waiting" ? "Waiting to be let in" : "Join the show"}</p>
            <h1 style={S.title}>{phase === "waiting" ? "You're in the queue" : "What should we call you?"}</h1>
            <div style={S.stage}>
              <video ref={selfRef} autoPlay playsInline muted style={{ ...S.video, transform: "scaleX(-1)", ...(selfHidden ? { visibility: "hidden" } : null) }} />
              {cameraOff && <div style={S.placeholder}>Camera off</div>}
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

        <div style={S.controls}>
          <button onClick={toggleMute} style={S.ghost}>{muted ? "Unmute" : "Mute"}</button>
          <button onClick={toggleCamera} style={S.ghost}>{cameraOff ? "Start camera" : "Stop camera"}</button>
          <button onClick={() => setSelfHidden((h) => !h)} style={S.ghost}>{selfHidden ? "Show my preview" : "Hide my preview"}</button>
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
  selfView: { position: "absolute", right: 12, bottom: 12, width: "26%", aspectRatio: "16 / 9", objectFit: "cover", borderRadius: 8, border: "1px solid #2c2c31", transform: "scaleX(-1)", background: "#0a0a0b" },
  placeholder: { position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "#6b6b73", fontSize: 14 },
  input: { marginTop: 14, width: "100%", background: "#141416", color: "#e7e7ea", border: "1px solid #232327", borderRadius: 10, padding: "12px 14px", fontSize: 15 },
  controls: { display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" },
  ghost: { background: "transparent", color: "#e7e7ea", border: "1px solid #2c2c31", borderRadius: 10, padding: "10px 14px", fontSize: 14, cursor: "pointer" },
  primary: { marginLeft: "auto", background: "#fff", color: "#0a0a0b", border: "none", borderRadius: 10, padding: "10px 18px", fontSize: 14, fontWeight: 600, cursor: "pointer" },
  note: { marginTop: 12, fontSize: 13, color: "#ffb4a8" },
  fine: { marginTop: 18, fontSize: 12, color: "#6b6b73", lineHeight: 1.5 },
  plug: { color: "#e7e7ea", fontWeight: 600, textDecoration: "none", borderBottom: "1px solid #3a3a40" },
};
