// ── The guest render target — the page Producer loads in a browser source ─────
//
// Route: /connect/guest/render/:id?k=<render_key>&mic=<device label>
//
// This page IS a video source in a live broadcast. Everything it paints becomes
// pixels on the stream and everything it plays becomes audio on the stream, so
// the rules below are invariants, not preferences:
//
//   1. TRANSPARENT background, no chrome, no cursor, no controls, no error UI.
//      A visible "reconnecting…" card would render live on air. When something
//      is wrong we show NOTHING and keep retrying silently.
//   2. Play ONLY the remote guest's audio. libobs captures this page's audio
//      output via reroute_audio as that source's own mixer strip.
//   3. NEVER play the host's return audio locally. We send the host mic to the
//      guest so they can hear the show, but attaching it to any element here
//      would put the host's own voice back into the broadcast as an echo loop.
//
// Media is PEER-TO-PEER: this page and the guest's browser connect directly.
// The server only introduces them (a signaling ticket + ICE servers), so a guest
// appearance costs nothing per minute. One page per guest — Producer renders each
// as its own browser source, which is what gives independent framing on the stage
// and an independent fader in the mixer.

import { useEffect, useRef } from "react";
import { GuestReturnFeed } from "./guestReturnFeed";
import { useSearchParams } from "./router";
import { CONNECT_API_BASE_URL } from "./apiConfig";
import { labelForStream, parseTrackAnnouncement, peerOf, type HostPeer, type TrackLabel } from "./participants";

type Session = {
  signaling_ticket: string;
  signaling_url: string;
  ice_servers: RTCIceServer[];
  display_name: string;
};

/** Backoff for the silent retry loop. Capped low: a guest reconnecting mid-show
 *  should come back in seconds, and there is no user here to press anything. */
const RETRY_MS = [1000, 2000, 3000, 5000, 8000];

export default function GuestRenderPage({ id }: { id: string }) {
  const [params] = useSearchParams();
  const renderKey = params.get("k") ?? "";
  const micLabel = params.get("mic");
  const programLabel = params.get("program");
  // `?track=screen` makes this the SCREEN page: the second browser source
  // Producer loads for a guest who holds media.screen. It shares the guest's
  // signaling channel with the camera page, so every frame is tagged with the
  // peer it belongs to and each page answers only its own. The screen page
  // receives the share and nothing else: no mic capture, no program return
  // (the camera page already carries both), and no quality report — that
  // would clobber the camera page's reading for the same guest.
  const peer: HostPeer = params.get("track") === "screen" ? "screen" : "main";
  const isScreen = peer === "screen";
  // `?feed=0`: Producer's statement that this participant does not hold
  // media.return_feed. Nothing goes back — no host mic, no program — so a
  // capture CEF may deny or hang is never even attempted for them. The
  // guest page gates the same thing on its side; this saves the work.
  const sendReturn = !isScreen && params.get("feed") !== "0";
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const teardownRef = useRef<(() => void) | null>(null);

  // The host page is the IMPOLITE peer in perfect negotiation: on a collision it
  // keeps its own offer and the guest rolls back. Deterministic because the two
  // roles are fixed by which URL you loaded.
  useEffect(() => {
    if (!id || !renderKey) return;
    let cancelled = false;
    let attempt = 0;

    async function connect() {
      if (cancelled) return;
      let pc: RTCPeerConnection | null = null;
      let ws: WebSocket | null = null;
      let returnFeed: GuestReturnFeed | null = null;
      let disposed = false;
      let qualityTimer: number | null = null;

      const cleanup = () => {
        if (disposed) return;
        disposed = true;
        returnFeed?.close();
        if (ws) { ws.onclose = null; ws.onmessage = null; ws.onopen = null; }
        if (pc) { pc.onconnectionstatechange = null; pc.oniceconnectionstatechange = null; pc.onnegotiationneeded = null; }
        try { ws?.close(); } catch { /* already closed */ }
        try { pc?.close(); } catch { /* already closed */ }
        if (qualityTimer) { window.clearInterval(qualityTimer); qualityTimer = null; }
        ws = null;
        pc = null;
      };
      teardownRef.current = cleanup;

      const retry = () => {
        if (disposed) return;
        cleanup();
        if (cancelled) return;
        const wait = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)];
        attempt += 1;
        window.setTimeout(() => void connect(), wait);
      };

      try {
        const res = await fetch(
          `${CONNECT_API_BASE_URL}/guest/render/${id}/session?k=${encodeURIComponent(renderKey)}`,
          { method: "POST" },
        );
        // 410 = revoked/ended. The host kicked this guest; stop for good rather
        // than hammering a dead session.
        if (res.status === 410) return;
        if (!res.ok) return retry();
        const session = (await res.json()) as Session;
        if (cancelled || disposed) return;

        pc = new RTCPeerConnection({ iceServers: session.ice_servers });

        // Register video requests synchronously; audio capture is independent.
        returnFeed = new GuestReturnFeed({ pc, programLabel, micLabel, enabled: sendReturn });

        // ── the guest's media IN ──────────────────────────────────────────────
        // Which stream is which: the guest announces a label per MediaStream
        // ({kind:"track"}) before the offer that carries it. Unlabeled → camera,
        // so a page from before labels existed still renders a face here and
        // can never be mistaken for a screen.
        const labels = new Map<string, TrackLabel>();
        const remote = new MediaStream();
        const dropStream = (_streamId: string) => {
          for (const t of remote.getTracks()) {
            if (t.readyState === "ended") remote.removeTrack(t);
          }
          // Nothing left → paint nothing. A stopped share must not freeze on
          // its last frame in the broadcast.
          if (videoRef.current && remote.getTracks().every((t) => t.readyState === "ended")) {
            videoRef.current.srcObject = null;
          }
        };
        pc.ontrack = (event) => {
          const stream = event.streams[0];
          const wanted: TrackLabel = isScreen ? "screen" : "camera";
          if (stream && labelForStream(labels, stream.id) !== wanted) return;
          // A share the guest ends (or the browser's own stop button) ends
          // the remote track; clear the element rather than freeze on it.
          event.track.onended = () => dropStream(stream?.id ?? "");
          stream?.getTracks().forEach((t) => {
            if (!remote.getTracks().includes(t)) remote.addTrack(t);
          });
          // ONE element carrying BOTH tracks, unmuted.
          //
          // This previously used a muted <video> plus a separate <audio>, which
          // meant two independent playout paths and no A/V synchronisation at
          // all — the browser only keeps tracks together when they share an
          // element. Guests looked dubbed for a reason we introduced.
          //
          // libobs still captures video via CEF and page audio via
          // reroute_audio, so it is the same two capture paths on the engine
          // side — but they are now fed from a synchronised source instead of
          // two drifting ones.
          //
          // Unmuted is REQUIRED: a muted element produces no page audio, so
          // reroute_audio would capture silence and the guest would be seen and
          // not heard.
          if (videoRef.current && videoRef.current.srcObject !== remote) {
            videoRef.current.srcObject = remote;
            videoRef.current.muted = false;
            void videoRef.current.play().catch(() => { /* autoplay policy; retried on the next track */ });
          }
        };

        ws = new WebSocket(signalingWsUrl(session));
        const send = (payload: object) => {
          if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "signal", payload: { ...payload, peer } }));
        };

        let makingOffer = false;
        pc.onicecandidate = (e) => { if (e.candidate) send({ kind: "ice", candidate: e.candidate.toJSON() }); };
        pc.onnegotiationneeded = async () => {
          try {
            makingOffer = true;
            await pc!.setLocalDescription();
            send({ kind: "sdp", description: pc!.localDescription });
          } catch {
            /* renegotiation will be retried by the reconnect loop */
          } finally {
            makingOffer = false;
          }
        };
        pc.oniceconnectionstatechange = () => {
          if (pc?.iceConnectionState === "failed") pc.restartIce();
        };
        pc.onconnectionstatechange = () => {
          if (pc?.connectionState === "failed" || pc?.connectionState === "closed") retry();
        };

        ws.onopen = () => {
          attempt = 0; // a successful connect resets backoff
          // Announce ourselves so a guest already waiting knows to negotiate.
          send({ kind: "hello" });
          // Flush an offer that onnegotiationneeded may have produced BEFORE the
          // socket was open — send() silently drops while CONNECTING, and
          // without this the offer is lost and both peers wait on each other.
          if (pc?.localDescription) send({ kind: "sdp", description: pc.localDescription });
        };
        ws.onclose = () => retry();
        ws.onerror = () => { /* onclose follows; retry there */ };
        ws.onmessage = async (event) => {
          let frame: { type?: string; payload?: { kind?: string; description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit } };
          try { frame = JSON.parse(String(event.data)); } catch { return; }
          if (frame.type !== "signal" || !frame.payload || !pc) return;
          const msg = frame.payload;
          // Not ours: the guest talking to the other host page.
          if (peerOf(msg) !== peer) return;

          try {
            const announced = parseTrackAnnouncement(msg);
            if (announced) {
              if (announced.ended) {
                labels.delete(announced.stream_id);
                dropStream(announced.stream_id);
              } else {
                labels.set(announced.stream_id, announced.label);
              }
              return;
            }
            if (msg.kind === "hello") {
              // The guest just arrived. Kick negotiation by touching the
              // transceiver set — onnegotiationneeded does the rest.
              if (pc.getTransceivers().length === 0) pc.addTransceiver("video", { direction: "recvonly" });
              else await pc.setLocalDescription().then(() => send({ kind: "sdp", description: pc!.localDescription }));
              return;
            }
            if (msg.kind === "sdp" && msg.description) {
              const offerCollision = msg.description.type === "offer" && (makingOffer || pc.signalingState !== "stable");
              // Impolite peer: ignore a colliding offer and keep our own.
              if (offerCollision) return;
              await pc.setRemoteDescription(msg.description);
              if (msg.description.type === "offer") {
                // Prefer software-decoded codecs. iOS guests push H.264, and
                // hardware-decoded H.264 frames never reach CEF's offscreen
                // readback — the source composites BLACK while the page swears
                // the video is playing (VDO.Ninja ships the same &codec=vp8
                // workaround for mobile guests). Reorder, don't remove: VP8
                // first, H.264 kept as a last resort for clients without it.
                try {
                  const caps = RTCRtpReceiver.getCapabilities("video")?.codecs ?? [];
                  const soft = caps.filter((c) => !/H264/i.test(c.mimeType));
                  const hard = caps.filter((c) => /H264/i.test(c.mimeType));
                  for (const tr of pc.getTransceivers()) {
                    if (tr.receiver.track?.kind === "video" && tr.setCodecPreferences) {
                      tr.setCodecPreferences([...soft, ...hard]);
                    }
                  }
                } catch { /* codec reordering is best-effort */ }
                await pc.setLocalDescription();
                send({ kind: "sdp", description: pc.localDescription });
              }
              return;
            }
            if (msg.kind === "program-ready") {
              returnFeed?.request();
              return;
            }
            if (msg.kind === "ice" && msg.candidate) {
              await pc.addIceCandidate(msg.candidate).catch(() => { /* candidate raced a rollback */ });
            }
          } catch {
            /* a malformed frame must never take the source down */
          }
        };

        // ── quality reporting ────────────────────────────────────────────────
        // Measured on the INBOUND stream, because that is what actually reaches
        // the broadcast. The guest's own view of its uplink is a proxy; this is
        // the thing the host is deciding about when they put someone on air.
        //
        // Coarse on purpose. A host needs "is this person about to fall over",
        // not a bitrate graph, and three states map onto a dot they can read at
        // a glance mid-show.
        let lastLost = 0;
        let lastTotal = 0;
        // framesDecoded is the ONLY signal that distinguishes "connected and
        // sending pixels" from "connected and sending nothing". See below.
        let lastFramesDecoded = -1;
        qualityTimer = window.setInterval(async () => {
          if (isScreen || !pc || pc.connectionState !== "connected") return;
          try {
            const stats = await pc.getStats();
            let lost = 0, received = 0, jitter = 0, frames = 0, kind = "";
            let framesDecoded = -1;
            stats.forEach((r) => {
              if (r.type === "inbound-rtp" && !r.isRemote) {
                lost += Number(r.packetsLost ?? 0);
                received += Number(r.packetsReceived ?? 0);
                jitter = Math.max(jitter, Number(r.jitter ?? 0));
                if (r.kind === "video") {
                  frames = Number(r.framesPerSecond ?? 0);
                  framesDecoded = Number(r.framesDecoded ?? 0);
                  kind = "video";
                }
              }
            });

            // ── THE BLACK-TILE CHECK ─────────────────────────────────────────
            // Found on hardware: two guests showed GREEN while rendering pure
            // black. Their transport was genuinely healthy — pages alive, peer
            // connections up, no loss — and no frames were decoding (a locked or
            // backgrounded phone). A host reading that panel puts someone on air
            // into a black hole.
            //
            // The old check was `frames > 0 && frames < 8`, which is FALSE when
            // fps is zero, so a completely stalled decoder fell through to
            // "good". The guard against audio-only false positives created a far
            // worse false negative.
            //
            // Connection health cannot answer "is video arriving". Only a
            // framesDecoded DELTA can.
            const hasVideo = framesDecoded >= 0;
            const stalled = hasVideo && lastFramesDecoded >= 0 && framesDecoded === lastFramesDecoded;
            if (hasVideo) lastFramesDecoded = framesDecoded;
            // Deltas, not lifetime totals: a connection that lost packets an hour
            // ago is not degraded NOW, and lifetime ratios would pin a guest to
            // "failing" for the rest of the show after one early blip.
            const dLost = Math.max(0, lost - lastLost);
            const dTotal = Math.max(0, lost + received - lastTotal);
            lastLost = lost;
            lastTotal = lost + received;
            const loss = dTotal > 0 ? dLost / dTotal : 0;

            // No packets at all is FAILING, not "good with zero loss" — the
            // arithmetic would otherwise report a dead connection as perfect.
            // `stalled` first: a frozen picture on a perfect connection is the
            // case the host most needs to see, and every transport metric will
            // insist everything is fine.
            const quality = stalled || dTotal === 0
              ? "failing"
              : loss > 0.08 || jitter > 0.25 || (kind === "video" && frames > 0 && frames < 8)
                ? "failing"
                : loss > 0.02 || jitter > 0.1 || (kind === "video" && frames > 0 && frames < 15)
                  ? "degraded"
                  : "good";

            await fetch(
              `${CONNECT_API_BASE_URL}/guest/render/${id}/quality?k=${encodeURIComponent(renderKey)}`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  quality,
                  stats: { loss: Number(loss.toFixed(4)), jitter, fps: frames, frames_decoded: framesDecoded, stalled },
                }),
              },
            ).catch(() => { /* reporting must never disturb a live connection */ });
          } catch {
            /* stats unavailable on this connection — stay silent rather than lie */
          }
        }, 5000);

        // Receive-only video transceiver so the guest has something to answer to
        // even before they publish.
        // Always recvonly for the FIRST negotiation. The return-audio track is
        // fire-and-forget above and may never arrive; when it does, addTrack
        // renegotiates and upgrades this to sendrecv. Getting the guest on
        // screen must never wait on a capture that CEF may deny or hang.
        pc.addTransceiver("video", { direction: "recvonly" });
        // The share is video only; the guest's voice rides the camera page.
        if (!isScreen) pc.addTransceiver("audio", { direction: "recvonly" });
      } catch {
        retry();
      }
    }

    void connect();
    return () => {
      cancelled = true;
      teardownRef.current?.();
    };
  }, [id, renderKey, micLabel, programLabel, peer, isScreen, sendReturn]);

  // The host paints the ground; this page must composite over it. CEF honours
  // alpha, so a background here would become an opaque rectangle on the stage.
  useEffect(() => {
    const prevHtml = document.documentElement.style.background;
    const prevBody = document.body.style.background;
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    document.body.style.margin = "0";
    document.body.style.overflow = "hidden";
    document.body.style.cursor = "none";
    return () => {
      document.documentElement.style.background = prevHtml;
      document.body.style.background = prevBody;
    };
  }, []);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "transparent",
        overflow: "hidden",
        cursor: "none",
      }}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        // Muted so the VIDEO element never duplicates audio — the audio element
        // below is the single playback path, and it is what libobs captures.
        // NOT muted: this element is the single synchronised source for BOTH
        // the pixels CEF captures and the audio reroute_audio captures. Muting
        // it would show the guest and silence them.
        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", background: "transparent" }}
      />
    </div>
  );
}

/** The signaling endpoint as an absolute ws(s) URL. The API hands us a path so
 *  the page never hardcodes it — see the double-prefix bug that shipped once. */
function signalingWsUrl(session: Session): string {
  const api = new URL(CONNECT_API_BASE_URL, window.location.origin);
  const url = new URL(session.signaling_url, api.origin);
  url.protocol = api.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
