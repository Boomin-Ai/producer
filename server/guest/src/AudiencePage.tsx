// /a/:code — the audience phone (#51). No account, no email, no camera:
// a per-device capability token from the door, a hibernating read-only
// socket for state + tally, an HTTP POST per answer. Every frame carries
// server_now; the countdown and the cooldown run on the server's clock.
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { CONNECT_API_BASE_URL } from "./apiConfig";
import { ProgramReceiver } from "./programReceiver";
import { VoteCard } from "./VoteCard";
import { activeInteraction, clockOffset, interactionFromFrame, mergeInteraction, type ProjectedInteraction } from "./interactions";

type Phase = "probe" | "closed" | "live" | "error";

const deviceKey = "producer.audience.device";
const tokenKey = (code: string) => `producer.audience.token.${code}`;

function deviceId(): string {
  try {
    let id = localStorage.getItem(deviceKey);
    if (!id) {
      id = `dev_${crypto.randomUUID()}`;
      localStorage.setItem(deviceKey, id);
    }
    return id;
  } catch {
    return `dev_${Math.random().toString(36).slice(2)}`;
  }
}

export default function AudiencePage({ code }: { code: string }) {
  const [phase, setPhase] = useState<Phase>("probe");
  const [title, setTitle] = useState<string>("");
  const [message, setMessage] = useState<string | null>(null);
  const [list, setList] = useState<ProjectedInteraction[]>([]);
  const [offset, setOffset] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [cooldown, setCooldown] = useState<Record<string, number>>({});
  const [online, setOnline] = useState(false);
  const [roomState, setRoomState] = useState<{ enabled?: boolean; online?: number; chat?: { id: string; name: string; text: string }[] }>({});
  const [chatText, setChatText] = useState("");
  const [raised, setRaised] = useState(false);
  const [invitation, setInvitation] = useState<string | null>(null);
  const [watching, setWatching] = useState(false);
  const [muted, setMuted] = useState(true);
  const [programAspect,setProgramAspect]=useState(16/9);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const receiverRef = useRef<ProgramReceiver | null>(null);
  const iceRef = useRef<RTCIceServer[]>([]);
  const tokenRef = useRef<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(1000);
  const aliveRef = useRef(true);
  const generationRef = useRef(0);
  const wantsVideoRef = useRef(false);
  const watchRequestedRef = useRef(false);

  const mint = useCallback(async (): Promise<{ token: string; signaling_url: string } | null> => {
    const res = await fetch(`${CONNECT_API_BASE_URL}/audience/${encodeURIComponent(code)}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: deviceId() }),
    });
    if (res.status === 404) {
      setPhase("closed");
      return null;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { token: string; signaling_url: string; ice_servers?: RTCIceServer[]; room: { title: string | null } };
    setTitle(body.room.title ?? "");
    tokenRef.current = body.token;
    iceRef.current = body.ice_servers ?? [];
    try {
      localStorage.setItem(tokenKey(code), body.token);
    } catch {
      /* private mode */
    }
    return body;
  }, [code]);

  const connect = useCallback(async () => {
    if (!aliveRef.current) return;
    const generation = generationRef.current;
    let session: { token: string; signaling_url: string } | null;
    try {
      session = await mint();
    } catch {
      if (!aliveRef.current || generation !== generationRef.current) return;
      setMessage("Couldn't reach the show. Retrying…");
      window.setTimeout(() => { if (generation === generationRef.current) void connect(); }, retryRef.current);
      retryRef.current = Math.min(retryRef.current * 2, 15000);
      return;
    }
    if (!session || !aliveRef.current || generation !== generationRef.current) return;
    const api = new URL(CONNECT_API_BASE_URL, window.location.origin);
    const wsUrl = new URL(session.signaling_url, api.origin);
    wsUrl.protocol = api.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(wsUrl.toString());
    wsRef.current = ws;
    ws.onopen = () => {
      if (!aliveRef.current || generation !== generationRef.current) { ws.close(); return; }
      watchRequestedRef.current = false;
      retryRef.current = 1000;
      setOnline(true);
      setPhase("live");
      setMessage(null);
      ws.send(JSON.stringify({ type: "subscribe", channel: "interaction:audience" }));
      ws.send(JSON.stringify({ type: "subscribe", channel: "interactions" }));
      void fetch(`${CONNECT_API_BASE_URL}/audience/${encodeURIComponent(code)}/interactions`).then(r=>r.ok?r.json():null).then(body=>{
        if (!aliveRef.current || wsRef.current !== ws || !Array.isArray(body?.interactions)) return;
        setList(body.interactions.map(interactionFromFrame).filter((doc: ProjectedInteraction | null): doc is ProjectedInteraction => !!doc));
      }).catch(()=>{});
    };
    ws.onmessage = (ev) => {
      if (generation !== generationRef.current || wsRef.current !== ws) return;
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(String(ev.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (frame.type === "audience.snapshot") {
        setRoomState((previous) => ({ ...previous, ...frame }));
        if (wantsVideoRef.current && frame.enabled && frame.host_online && !watchRequestedRef.current) {
          watchRequestedRef.current = true;
          ws.send(JSON.stringify({type:'audience.watch'}));
        }
      }
      if (frame.type === "audience.chat" && frame.message) setRoomState(previous=>({ ...previous, chat: [...(previous.chat??[]).slice(-99), frame.message as {id:string;name:string;text:string}] }));
      if (frame.type === "audience.hand") setRaised(frame.raised===true);
      if (frame.type === "audience.invite" && typeof frame.url === "string") setInvitation(frame.url);
      if (frame.type === "audience.media.closed") { watchRequestedRef.current=false; receiverRef.current?.close(); receiverRef.current=null; streamRef.current=null; setWatching(false); if(videoRef.current)videoRef.current.srcObject=null; }
      if (frame.type === "audience.error") {
        setMessage(frame.code === "hardware_budget_full" ? "The host's direct video connections are full. You can still chat, react, and vote." : String(frame.code ?? "Room unavailable"));
        if(frame.code === "removed") aliveRef.current=false;
      }
      if (frame.type === "audience.reaction" && frame.counts && typeof frame.counts === "object") { setMessage(Object.entries(frame.counts).map(([emoji,count])=>`${emoji} ${count}`).join("  ")); }
      if (frame.type === "audience.signal" && frame.payload) {
        if (!receiverRef.current) receiverRef.current = new ProgramReceiver(iceRef.current, payload=>{
          if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:"audience.signal",payload}));
        },event=>{
          if(!event.streams[0])return;streamRef.current=event.streams[0];if(videoRef.current){videoRef.current.srcObject=event.streams[0];void videoRef.current.play().catch(()=>{});}setWatching(true);
        });
        receiverRef.current.handle(frame.payload as Parameters<ProgramReceiver['handle']>[0]);
      }
      if (typeof frame.server_now === "number") setOffset(clockOffset(frame.server_now));
      if (frame.type === "snapshot" && Array.isArray(frame.interactions)) {
        const docs = (frame.interactions as unknown[]).map(interactionFromFrame).filter((d): d is ProjectedInteraction => !!d);
        setList(docs);
        return;
      }
      const payload = frame.payload as { interaction?: unknown } | undefined;
      const doc = interactionFromFrame(payload?.interaction ?? frame);
      if (doc) setList((l) => mergeInteraction(l, doc));
    };
    ws.onclose = (event) => {
      if (generation !== generationRef.current || wsRef.current !== ws) return;
      watchRequestedRef.current = false;
      receiverRef.current?.close(); receiverRef.current=null;streamRef.current=null;setWatching(false);if(videoRef.current)videoRef.current.srcObject=null;
      if (event.code === 4003 || event.code === 4009 || event.code === 4000) { aliveRef.current=false;setMessage(event.code === 4009?"The room is full.":event.code === 4000?"This room opened in another tab.":"You were removed from the room."); }

      setOnline(false);
      if (!aliveRef.current) return;
      window.setTimeout(() => { if (generation === generationRef.current) void connect(); }, retryRef.current);
      retryRef.current = Math.min(retryRef.current * 2, 15000);
    };
    ws.onerror = () => ws.close();
  }, [mint]);

  useEffect(() => {
    aliveRef.current = true;
    generationRef.current++;
    void connect();
    const ping = window.setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: "ping" }));
    }, 25000);
    return () => {
      aliveRef.current = false;
      generationRef.current++;
      window.clearInterval(ping);
      receiverRef.current?.close(); receiverRef.current=null;
      wsRef.current?.close();
    };
  }, [connect]);

  const pick = async (ix: ProjectedInteraction, optionId: string) => {
    const token = tokenRef.current;
    if (!token) return;
    setAnswers((a) => ({ ...a, [ix.id]: optionId }));
    const res = await fetch(`${CONNECT_API_BASE_URL}/audience/interactions/${encodeURIComponent(ix.id)}/inputs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ value: optionId }),
    }).catch(() => null);
    if (!res) return;
    const body = (await res.json().catch(() => ({}))) as { cooldown_until?: string; error?: { code?: string } };
    if (res.ok && body.cooldown_until) setCooldown((c) => ({ ...c, [ix.id]: Date.parse(body.cooldown_until!) }));
    if (res.status === 409 && body.error?.code === "input_already_counted") return; // a reload re-sent it; fine
    if (!res.ok && res.status !== 409) {
      setAnswers((a) => {
        const n = { ...a };
        delete n[ix.id];
        return n;
      });
      setMessage(res.status === 429 ? "Slow down a moment." : "That didn't count. Try again.");
    }
  };

  const active = activeInteraction(list);
  const send = (frame: Record<string, unknown>) => { if(wsRef.current?.readyState===WebSocket.OPEN)wsRef.current.send(JSON.stringify(frame)); };
  useEffect(()=>{if(videoRef.current && streamRef.current)videoRef.current.srcObject=streamRef.current;},[watching]);

  if (phase === "closed") {
    return (
      <div style={S.shell}><div style={S.card}>
        <h1 style={S.title}>No show at {code.toUpperCase()}</h1>
        <p style={S.sub}>The code only works while the host is live. Check it, or wait for the show to start.</p>
        <button onClick={() => { setPhase("probe"); void connect(); }} style={S.ghost}>Try again</button>
      </div></div>
    );
  }

  return (
    <div style={S.shell}>
      <div style={S.card}>
        <p style={S.eyebrow}><span style={{ ...S.dot, background: online ? "#34c759" : "#8b8b93" }} />{title || "The show"}</p>
        <video ref={videoRef} onLoadedMetadata={e=>{const v=e.currentTarget;if(v.videoWidth&&v.videoHeight)setProgramAspect(v.videoWidth/v.videoHeight);}} onResize={e=>{const v=e.currentTarget;if(v.videoWidth&&v.videoHeight)setProgramAspect(v.videoWidth/v.videoHeight);}} autoPlay playsInline controls muted={muted} style={{width:`min(100%, ${programAspect*90}svh)`,display:'block',margin:'0 auto',aspectRatio:String(programAspect),maxHeight:'90svh',objectFit:'contain',background:'#151517',borderRadius:12}} aria-label="Live program" />
        <div style={{display:'flex',gap:8}}><button style={S.ghost} disabled={!online||!roomState.enabled} onClick={()=>{wantsVideoRef.current=true;watchRequestedRef.current=true;send({type:'audience.watch'});}}>{watching?'Reconnect video':'Watch the show'}</button><button style={S.ghost} onClick={()=>{setMuted(!muted);void videoRef.current?.play();}}>{muted?'Enable sound':'Mute'}</button></div>
        <p style={S.sub}>{roomState.online??0} in the room</p>
        {active ? (
          <VoteCard
            interaction={active}
            offset={offset}
            answered={answers[active.id] ?? null}
            cooldownUntil={cooldown[active.id] ?? null}
            onPick={(o) => void pick(active, o)}
          />
        ) : (
          <div style={S.wait}>
            <h1 style={S.title}>You're in.</h1>
            <p style={S.sub}>Keep this open — when the host asks the room, the question shows up here.</p>
          </div>
        )}
        <div style={{display:'flex',gap:8}}>{['❤️','👏','🔥','😂'].map(emoji=><button key={emoji} aria-label={`React ${emoji}`} disabled={!online} style={S.ghost} onClick={()=>send({type:'audience.reaction',emoji})}>{emoji}</button>)}</div>
        <button style={S.ghost} disabled={!online} onClick={()=>send({type:'audience.hand',raised:!raised})}>{raised?'Lower hand':'Ask to join the stage'}</button>
        {invitation&&<div><p>The host invited you to the stage. Joining opens the guest room, where you can choose your camera and microphone.</p><a style={S.plug} href={invitation}>Review invitation</a><button style={S.ghost} onClick={()=>setInvitation(null)}>Stay in audience</button></div>}
        <div role="log" aria-label="Room chat" style={{maxHeight:240,overflowY:'auto'}}>{(roomState.chat??[]).map(m=><p key={m.id}><strong>{m.name}</strong> {m.text}</p>)}</div>
        <form onSubmit={event=>{event.preventDefault();if(chatText.trim()){send({type:'audience.chat',text:chatText});setChatText('');}}} style={{display:'flex',gap:8}}><input aria-label="Chat message" placeholder="Message the room" maxLength={500} value={chatText} onChange={event=>setChatText(event.target.value)} style={{flex:1,minWidth:0,padding:12,borderRadius:8}}/><button disabled={!online} style={S.ghost}>Send</button></form>
        {message && <p style={S.note}>{message}</p>}
        <p style={S.fine}>
          No account, nothing to install. This page only sends what you tap.{" "}
          Powered by <a href="https://producer.dev" target="_blank" rel="noreferrer" style={S.plug}>Producer</a>
        </p>
      </div>
    </div>
  );
}

const S: Record<string, CSSProperties> = {
  shell: { minHeight: "100vh", display: "grid", placeItems: "center", background: "#0a0a0b", padding: 20, fontFamily: "system-ui, sans-serif" },
  card: { width: "min(480px, 100%)", color: "#fff", display: "grid", gap: 16 },
  eyebrow: { margin: 0, fontSize: 13, letterSpacing: "0.08em", textTransform: "uppercase", color: "#8b8b93", display: "flex", alignItems: "center", gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 999, display: "inline-block" },
  title: { margin: "6px 0 8px", fontSize: 28, fontWeight: 600, letterSpacing: "-0.02em" },
  sub: { margin: 0, color: "#8b8b93", fontSize: 15, lineHeight: 1.5 },
  wait: { padding: "24px 0" },
  note: { margin: 0, color: "#ffb84d", fontSize: 13 },
  fine: { margin: 0, color: "#5f5f66", fontSize: 12, lineHeight: 1.5 },
  plug: { color: "#8b8b93" },
  ghost: { padding: "10px 14px", borderRadius: 10, border: "0.5px solid #3a3a40", background: "transparent", color: "#fff", marginTop: 12 },
};
