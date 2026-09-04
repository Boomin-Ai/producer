// ── The guest's door — the page a person opens from an invite link ────────────
//
// Route: /connect/guest/:code
//
// The opposite of the render page in every way. That one is headless, silent and
// invisible; this one is the only human-facing surface in the whole guest flow,
// and its audience is someone who has never heard of Producer and was sent a link
// by a friend who is about to go live. So: no account, no install, no jargon.
//
// They see themselves, pick a camera and mic, and press one button. Media then
// flows PEER-TO-PEER to the host's machine — it never touches the server.

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useSearchParams } from "./router";
import { CONNECT_API_BASE_URL } from "./apiConfig";

type Guest = { id: string; display_name: string; status: string };
type Session = { signaling_ticket: string; signaling_url: string; ice_servers: RTCIceServer[] };
type Phase = "loading" | "ready" | "waiting" | "connecting" | "live" | "gone" | "error";

/** Display-name prefill from `?name=` — plain text only, capped so a crafted
 *  link can't paint a paragraph into the title. */
function sanitizeName(raw: string | null): string {
  if (!raw) return "";
  let out = "";
  for (const ch of raw) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || c === 0x7f || ch === "<" || ch === ">") continue;
    out += ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, 40);
}

/** POST accept, swallowing network errors and the idempotent 409
 *  (`guest_not_acceptable` = the row is already past `invited`). */
async function acceptQuietly(code: string): Promise<void> {
  try {
    const res = await fetch(`${CONNECT_API_BASE_URL}/guest/${encodeURIComponent(code)}/accept`, { method: "POST" });
    if (res.ok || res.status === 409) return;
  } catch {
    // Offline blip — the caller's status poll retries if the row is still `invited`.
  }
}

export default function GuestJoinPage({ code }: { code: string }) {
  const [search] = useSearchParams();
  // Producer opens this page for the beneficiary of a deal with `?cam=producer`
  // so the Producer virtual camera is the default pick, and `?name=` so the
  // person sees themselves named before the invite row is even read.
  const preferProducerCam = search.get("cam") === "producer";
  const nameHint = sanitizeName(search.get("name"));
  const [guest, setGuest] = useState<Guest | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [message, setMessage] = useState("");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [camId, setCamId] = useState<string>("");
  const [micId, setMicId] = useState<string>("");
  const [muted, setMuted] = useState(false);
  // The show itself, sent back by the host's render page. Video-only — the
  // host's voice arrives separately on #host-return.
  const programRef = useRef<HTMLVideoElement | null>(null);
  const [hasProgram, setHasProgram] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);

  const previewRef = useRef<HTMLVideoElement | null>(null);
  /** False after unmount — the waiting poll must stop, not zombie on. */
  const aliveRef = useRef(true);
  const streamRef = useRef<MediaStream | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Look up the invite. A dead link says so plainly rather than 404ing into the
  // app shell — this person did nothing wrong and needs to know to ask for a new one.
  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    (async () => {
      const res = await fetch(`${CONNECT_API_BASE_URL}/guest/${encodeURIComponent(code)}`);
      if (cancelled) return;
      if (res.status === 404 || res.status === 410) {
        const body = await res.json().catch(() => ({}));
        setMessage(body?.message || "This invite link is no longer valid.");
        setPhase("gone");
        return;
      }
      if (!res.ok) { setPhase("error"); setMessage("Could not load this invitation."); return; }
      const body = (await res.json()) as { guest: Guest };
      setGuest(body.guest);
      setPhase("ready");
    })();
    return () => { cancelled = true; };
  }, [code]);

  // Preview. Labels are empty until permission is granted, so enumerate AFTER
  // getUserMedia or the pickers render as "Microphone 1", "Microphone 2".
  const startPreview = useCallback(async (camera?: string, mic?: string) => {
    try {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      // 720p30 cap: guests publish into a show that composites at most four of
      // them onto a 1080p-or-less program, so anything sharper is decode load
      // in the host's guest pages for zero on-air gain. ideal+max (not exact)
      // lets browsers downscale rather than throw on cameras with odd modes.
      const cap = { width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 }, frameRate: { ideal: 30, max: 30 } };
      const stream = await navigator.mediaDevices.getUserMedia({
        video: camera ? { deviceId: { exact: camera }, ...cap } : cap,
        audio: mic ? { deviceId: { exact: mic }, echoCancellation: true } : { echoCancellation: true },
      });
      streamRef.current = stream;
      if (previewRef.current) previewRef.current.srcObject = stream;
      const list = await navigator.mediaDevices.enumerateDevices();
      setDevices(list.filter((d) => d.kind === "videoinput" || d.kind === "audioinput"));
      if (!camera) {
        // Labels are populated now that permission is granted, so this is the
        // first moment the Producer virtual camera can be told apart.
        const producerCam = preferProducerCam
          ? list.find((d) => d.kind === "videoinput" && /producer|boomin/i.test(d.label))
          : undefined;
        const current = stream.getVideoTracks()[0]?.getSettings().deviceId ?? "";
        if (producerCam && producerCam.deviceId && producerCam.deviceId !== current) {
          setCamId(producerCam.deviceId);
          // Re-open on the virtual camera; the recursive call takes the
          // `camera` branch, so this runs at most once.
          await startPreview(producerCam.deviceId, mic);
          return;
        }
        setCamId(current);
      }
      if (!mic) setMicId(stream.getAudioTracks()[0]?.getSettings().deviceId ?? "");
    } catch {
      setMessage("We need camera and microphone access to put you on the show.");
    }
  }, [preferProducerCam]);

  useEffect(() => {
    if (phase === "ready" && !streamRef.current) void startPreview();
  }, [phase, startPreview]);

  useEffect(() => () => {
    aliveRef.current = false;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    try { wsRef.current?.close(); } catch { /* already closed */ }
    try { pcRef.current?.close(); } catch { /* already closed */ }
  }, []);

  const goLive = useCallback(async () => {
    if (!code || !streamRef.current) return;
    setPhase("connecting");
    try {
      // Only an `invited` row has anything to accept. Knock and deal guests
      // arrive already `waiting`/`accepted` server-side, and the accept route
      // answers those with 409 guest_not_acceptable — noise in the console for
      // a state that is exactly what we want. So skip it for them, and treat
      // that 409 as success if a stale status slipped through.
      if (!guest || guest.status === "invited") await acceptQuietly(code);
      // A guest who KNOCKED (network entry, or a room link) sits in `waiting`
      // until the host admits them — accept above is a no-op for them and the
      // session mint below would 409. Hold here and poll their own status; the
      // invite code is the credential, so no session is needed to ask.
      //
      // The poll must survive a transient network blip (their waiting row is
      // still live server-side — one failed request must not read as denial),
      // stop when the page unmounts, and give up eventually rather than poll a
      // host who left for the day.
      const deadline = Date.now() + 15 * 60_000;
      for (;;) {
        if (!aliveRef.current) return;
        if (Date.now() > deadline) { setPhase("gone"); setMessage("The host didn't answer. Ask them for a fresh link."); return; }
        try {
          const who = await fetch(`${CONNECT_API_BASE_URL}/guest/${encodeURIComponent(code)}`);
          if (who.status === 404 || who.status === 410) { setPhase("gone"); setMessage("The host didn't let you in this time."); return; }
          if (who.ok) {
            const body = (await who.json()) as { guest: Guest };
            if (body.guest.status === "accepted") break;
            if (body.guest.status === "waiting") setPhase("waiting");
            else if (body.guest.status === "invited") {
              // The accept above must have failed in transit — try it again.
              await acceptQuietly(code);
            } else { setPhase("gone"); setMessage("The host didn't let you in this time."); return; }
          }
        } catch {
          // Offline blip while waiting — keep waiting.
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (!aliveRef.current) return;
      setPhase("connecting");
      const res = await fetch(`${CONNECT_API_BASE_URL}/guest/${encodeURIComponent(code)}/session`, { method: "POST" });
      if (!res.ok) { setPhase("error"); setMessage("Could not join the show."); return; }
      const session = (await res.json()) as Session;

      const pc = new RTCPeerConnection({ iceServers: session.ice_servers });
      pcRef.current = pc;
      streamRef.current.getTracks().forEach((t) => pc.addTrack(t, streamRef.current!));

      // The host's return audio — so the guest can actually hold a conversation
      // instead of hearing the broadcast on delay.
      pc.ontrack = (event) => {
        const stream = event.streams[0];
        if (!stream) return;
        if (event.track.kind === "video") {
          // The program return — show the guest what is actually on air.
          const v = programRef.current;
          if (v) { v.srcObject = stream; void v.play().catch(() => {}); }
          setHasProgram(true);
        } else {
          const el = document.getElementById("host-return") as HTMLAudioElement | null;
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
      pc.onnegotiationneeded = async () => {
        try {
          makingOffer = true;
          await pc.setLocalDescription();
          send({ kind: "sdp", description: pc.localDescription });
        } catch { /* retried on reconnect */ } finally { makingOffer = false; }
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "connected") setPhase("live");
        if (pc.connectionState === "failed") pc.restartIce();
      };

      ws.onopen = () => send({ kind: "hello" });
      ws.onmessage = async (event) => {
        let frame: { type?: string; payload?: { kind?: string; description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit } };
        try { frame = JSON.parse(String(event.data)); } catch { return; }
        if (frame.type !== "signal" || !frame.payload) return;
        const msg = frame.payload;
        try {
          if (msg.kind === "sdp" && msg.description) {
            const collision = msg.description.type === "offer" && (makingOffer || pc.signalingState !== "stable");
            // POLITE peer: on a collision we roll back and accept theirs.
            if (collision) await pc.setLocalDescription({ type: "rollback" } as RTCLocalSessionDescriptionInit);
            await pc.setRemoteDescription(msg.description);
            if (msg.description.type === "offer") {
              await pc.setLocalDescription();
              send({ kind: "sdp", description: pc.localDescription });
            }
          } else if (msg.kind === "ice" && msg.candidate) {
            await pc.addIceCandidate(msg.candidate).catch(() => {});
          }
        } catch { /* never let one frame kill the call */ }
      };
    } catch {
      setPhase("error");
      setMessage("Could not join the show.");
    }
  }, [code, guest]);

  const toggleMute = () => {
    const track = streamRef.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setMuted(!track.enabled);
  };
  const toggleCamera = () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setCameraOff(!track.enabled);
  };

  if (phase === "gone" || phase === "error") {
    return (
      <div style={S.shell}>
        <div style={S.card}>
          <h1 style={S.title}>{phase === "gone" ? "This link has expired" : "Something went wrong"}</h1>
          <p style={S.sub}>{message || "Ask whoever invited you for a fresh link."}</p>
        </div>
      </div>
    );
  }

  return (
    <div style={S.shell}>
      <div style={S.card}>
        <p style={S.eyebrow}>
          {phase === "live" ? "You're on" : phase === "waiting" ? "The host has been asked to let you in" : "You've been invited to join"}
        </p>
        <h1 style={S.title}>{nameHint || guest?.display_name || "Live show"}</h1>

        <div style={S.stage}>
          <video
            ref={programRef}
            autoPlay
            playsInline
            muted
            style={{ ...S.program, display: hasProgram ? undefined : "none" }}
          />
          <video ref={previewRef} autoPlay playsInline muted style={hasProgram ? S.pip : S.video} />
          {phase === "live" && <div style={S.liveDot}><span style={S.dot} /> LIVE</div>}
          {cameraOff && <div style={S.camOff}>Camera off</div>}
        </div>

        {phase !== "live" && (
          <div style={S.pickers}>
            <select
              value={camId}
              onChange={(e) => { setCamId(e.target.value); void startPreview(e.target.value, micId); }}
              style={S.select}
            >
              {devices.filter((d) => d.kind === "videoinput").map((d) => (
                <option key={d.deviceId} value={d.deviceId}>{d.label || "Camera"}</option>
              ))}
            </select>
            <select
              value={micId}
              onChange={(e) => { setMicId(e.target.value); void startPreview(camId, e.target.value); }}
              style={S.select}
            >
              {devices.filter((d) => d.kind === "audioinput").map((d) => (
                <option key={d.deviceId} value={d.deviceId}>{d.label || "Microphone"}</option>
              ))}
            </select>
          </div>
        )}

        <div style={S.controls}>
          <button onClick={toggleMute} style={S.ghost}>{muted ? "Unmute" : "Mute"}</button>
          <button onClick={toggleCamera} style={S.ghost}>{cameraOff ? "Start camera" : "Stop camera"}</button>
          {phase !== "live" && (
            <button onClick={() => void goLive()} disabled={phase === "connecting" || phase === "waiting"} style={S.primary}>
              {phase === "connecting" ? "Connecting…" : phase === "waiting" ? "Waiting for the host…" : "Join the show"}
            </button>
          )}
        </div>

        {message && phase !== "live" && <p style={S.note}>{message}</p>}
        <p style={S.fine}>
          Your camera and audio go straight to the host's computer. This server
          doesn't record or store this video.
        </p>
        <p style={S.fine}>
          Powered by{" "}
          <a href="https://producer.dev" target="_blank" rel="noreferrer" style={S.plug}>Producer</a>
        </p>
      </div>
      {/* The host's voice. Separate element so the preview above stays muted and
          the guest never hears themselves. */}
      <audio id="host-return" autoPlay />
    </div>
  );
}

const S: Record<string, CSSProperties> = {
  shell: { minHeight: "100vh", display: "grid", placeItems: "center", background: "#0a0a0b", padding: 24, fontFamily: "system-ui, sans-serif" },
  card: { width: "min(560px, 100%)", color: "#fff" },
  eyebrow: { margin: 0, fontSize: 13, letterSpacing: "0.08em", textTransform: "uppercase", color: "#8b8b93" },
  title: { margin: "6px 0 20px", fontSize: 28, fontWeight: 600, letterSpacing: "-0.02em" },
  stage: { position: "relative", aspectRatio: "16 / 9", background: "#141416", borderRadius: 14, overflow: "hidden", border: "1px solid #232327" },
  video: { width: "100%", height: "100%", objectFit: "cover", transform: "scaleX(-1)" },
  program: { width: "100%", height: "100%", objectFit: "cover" },
  pip: { position: "absolute", right: 10, bottom: 10, width: "28%", aspectRatio: "16 / 9", objectFit: "cover", transform: "scaleX(-1)", borderRadius: 10, border: "1px solid rgba(255,255,255,.25)", boxShadow: "0 4px 14px rgba(0,0,0,.5)" },
  liveDot: { position: "absolute", top: 12, left: 12, display: "flex", alignItems: "center", gap: 6, background: "rgba(0,0,0,.6)", padding: "5px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600, letterSpacing: "0.06em" },
  dot: { width: 7, height: 7, borderRadius: 999, background: "#ff3b30", display: "inline-block" },
  camOff: { position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "#6b6b73", fontSize: 14, background: "#141416" },
  pickers: { display: "grid", gap: 8, gridTemplateColumns: "1fr 1fr", marginTop: 14 },
  select: { background: "#141416", color: "#e7e7ea", border: "1px solid #232327", borderRadius: 10, padding: "9px 10px", fontSize: 13, width: "100%" },
  controls: { display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" },
  ghost: { background: "transparent", color: "#e7e7ea", border: "1px solid #2c2c31", borderRadius: 10, padding: "10px 14px", fontSize: 14, cursor: "pointer" },
  primary: { marginLeft: "auto", background: "#fff", color: "#0a0a0b", border: "none", borderRadius: 10, padding: "10px 18px", fontSize: 14, fontWeight: 600, cursor: "pointer" },
  note: { marginTop: 12, fontSize: 13, color: "#ffb4a8" },
  fine: { marginTop: 18, fontSize: 12, color: "#6b6b73", lineHeight: 1.5 },
  plug: { color: "#e7e7ea", fontWeight: 600, textDecoration: "none", borderBottom: "1px solid #3a3a40" },
};
