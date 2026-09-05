// The vote as a participant sees it (#51): two buttons while collecting,
// the bar once revealed. One component for the guest page and the phone;
// the caller decides how an answer is sent.
import { useEffect, useState, type CSSProperties } from "react";
import { msUntil, shares, type ProjectedInteraction } from "./interactions";

export function VoteCard({
  interaction,
  offset,
  answered,
  cooldownUntil,
  onPick,
  compact,
}: {
  interaction: ProjectedInteraction;
  /** server_now - local now, from the last frame. */
  offset: number;
  /** The option this participant already picked (local memory). */
  answered: string | null;
  /** Server timestamp (ms) until which the controls stay disabled. */
  cooldownUntil: number | null;
  onPick: (optionId: string) => void;
  compact?: boolean;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 500);
    return () => window.clearInterval(t);
  }, []);
  const ix = interaction;
  const collecting = ix.state === "collecting";
  const revealed = ix.state === "revealed" || ix.state === "closed";
  const left = msUntil(ix.timing.reveal_at, offset);
  const cooling = cooldownUntil != null && cooldownUntil > Date.now() + offset;
  const pct = shares(ix.tally, ix.spec.options);
  return (
    <div style={{ ...S.card, ...(compact ? S.compact : null) }}>
      {ix.spec.prompt && <div style={S.prompt}>{ix.spec.prompt}</div>}
      {collecting && (
        <>
          <div style={S.row}>
            {ix.spec.options.map((o) => (
              <button
                key={o.id}
                disabled={!!answered || cooling}
                onClick={() => onPick(o.id)}
                style={{ ...S.btn, ...(answered === o.id ? S.btnOn : null) }}
              >
                {o.label}
              </button>
            ))}
          </div>
          <div style={S.fine}>
            {answered ? "Counted — thanks." : cooling ? "One moment…" : "Pick one."}
            {left != null && left > 0 && ` ${Math.ceil(left / 1000)}s`}
          </div>
        </>
      )}
      {revealed && (
        <div style={S.bars}>
          {ix.spec.options.map((o) => (
            <div key={o.id} style={S.barRow}>
              <span style={{ ...S.barLabel, ...(ix.tally?.winner === o.id ? S.win : null) }}>{o.label}</span>
              <span style={S.track}>
                <span style={{ ...S.fill, width: `${pct[o.id]}%`, ...(ix.tally?.winner === o.id ? S.fillWin : null) }} />
              </span>
              <span style={S.pct}>{pct[o.id]}%</span>
            </div>
          ))}
          <div style={S.fine}>{ix.tally?.total ?? 0} vote{(ix.tally?.total ?? 0) === 1 ? "" : "s"}</div>
        </div>
      )}
    </div>
  );
}

const S: Record<string, CSSProperties> = {
  card: { background: "#151517", border: "0.5px solid #2a2a2e", borderRadius: 14, padding: 16, color: "#fff", display: "grid", gap: 12 },
  compact: { padding: 12, gap: 8 },
  prompt: { fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em" },
  row: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 },
  btn: { padding: "18px 12px", fontSize: 17, fontWeight: 600, borderRadius: 12, border: "0.5px solid #3a3a40", background: "#1f1f24", color: "#fff", cursor: "pointer" },
  btnOn: { background: "#2f6fed", borderColor: "#2f6fed" },
  fine: { fontSize: 12, color: "#8b8b93" },
  bars: { display: "grid", gap: 8 },
  barRow: { display: "grid", gridTemplateColumns: "90px 1fr 44px", alignItems: "center", gap: 8 },
  barLabel: { fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  win: { fontWeight: 700 },
  track: { height: 10, borderRadius: 999, background: "#26262b", overflow: "hidden", display: "block" },
  fill: { display: "block", height: "100%", background: "#5b5b66", transition: "width 240ms ease" },
  fillWin: { background: "#2f6fed" },
  pct: { fontSize: 12, textAlign: "right", fontVariantNumeric: "tabular-nums" },
};
