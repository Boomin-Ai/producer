// /a/:code — the audience phone (#51). No account, no email, no camera:
// a per-device capability token from the door, a hibernating read-only
// socket for state + tally, an HTTP POST per answer. Every frame carries
// server_now; the countdown and the cooldown run on the server's clock.
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { CONNECT_API_BASE_URL } from "./apiConfig";
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
  const tokenRef = useRef<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(1000);
  const aliveRef = useRef(true);

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
    const body = (await res.json()) as { token: string; signaling_url: string; room: { title: string | null } };
    setTitle(body.room.title ?? "");
    tokenRef.current = body.token;
    try {
      localStorage.setItem(tokenKey(code), body.token);
    } catch {
      /* private mode */
    }
    return body;
  }, [code]);

  const connect = useCallback(async () => {
    if (!aliveRef.current) return;
    let session: { token: string; signaling_url: string } | null;
    try {
      session = await mint();
    } catch {
      setMessage("Couldn't reach the show. Retrying…");
      window.setTimeout(() => void connect(), retryRef.current);
      retryRef.current = Math.min(retryRef.current * 2, 15000);
      return;
    }
    if (!session) return;
    const api = new URL(CONNECT_API_BASE_URL, window.location.origin);
    const wsUrl = new URL(session.signaling_url, api.origin);
    wsUrl.protocol = api.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(wsUrl.toString());
    wsRef.current = ws;
    ws.onopen = () => {
      retryRef.current = 1000;
      setOnline(true);
      setPhase("live");
      setMessage(null);
    };
    ws.onmessage = (ev) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(String(ev.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (typeof frame.server_now === "number") setOffset(clockOffset(frame.server_now));
      if (frame.type === "snapshot" && Array.isArray(frame.interactions)) {
        const docs = (frame.interactions as unknown[]).map(interactionFromFrame).filter((d): d is ProjectedInteraction => !!d);
        setList(docs);
        return;
      }
      const doc = interactionFromFrame(frame);
      if (doc) setList((l) => mergeInteraction(l, doc));
    };
    ws.onclose = () => {
      setOnline(false);
      if (!aliveRef.current) return;
      window.setTimeout(() => void connect(), retryRef.current);
      retryRef.current = Math.min(retryRef.current * 2, 15000);
    };
    ws.onerror = () => ws.close();
  }, [mint]);

  useEffect(() => {
    aliveRef.current = true;
    void connect();
    const ping = window.setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: "ping" }));
    }, 25000);
    return () => {
      aliveRef.current = false;
      window.clearInterval(ping);
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
