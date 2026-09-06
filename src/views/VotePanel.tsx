/** The Vote panel (v0.4.33): the host's one-question control, born from the
 * card that used to sit at the top of Guests. ONE component wears three
 * forms by dock (lib/votePanel.ts `voteFormFor`) and seats two places: the
 * host's dockable panel and the Mod View's vote pad.
 *
 *   strip  row dock — one line: [Vote] question · A 62% ▮▮▮ B 38% · Reveal · Close
 *   card   column dock, idle — last question (or "No vote yet") + Set up
 *   edit   column dock — the FILTERS sub-page: question, A/B, audience, Open
 *   live   bars + Reveal / Close / Cancel
 *
 * The editor's draft is component state; whether the editor is OPEN is the
 * caller's (`editing` / `onEdit`), cleared on Open or back — the same
 * pattern as the Sources panel's `filterFor`. In a row dock the caller opens
 * the editor as a popover over the strip (VoteEditor is exported for it). */
import { useEffect, useState, type ReactNode } from "react";
import type React from "react";
import { Select } from "../components/Select";
import type { Interaction } from "../lib/ipc";
import { voteIsLive, type VoteForm } from "../lib/votePanel";

export type VoteWho = "guest" | "audience" | "both";
export interface VoteOpenInput {
  a: string;
  b: string;
  prompt: string;
  who: VoteWho;
}

const chevRight = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 6l6 6-6 6" />
  </svg>
);

/** The strip's transport is icon-only (28px glass buttons, tooltips). */
const svgProps = { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
const sic = {
  plus: (
    <svg {...svgProps}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  play: (
    <svg {...svgProps}>
      <path d="M7 5v14l11-7z" fill="currentColor" stroke="none" />
    </svg>
  ),
  eye: (
    <svg {...svgProps}>
      <path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </svg>
  ),
  check: (
    <svg {...svgProps}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  ),
  x: (
    <svg {...svgProps}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  ),
};

/** One icon-only strip button: the tooltip IS the label. */
function StripBtn({ icon, tip, primary, onClick }: { icon: ReactNode; tip: string; primary?: boolean; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void }) {
  return (
    <button type="button" className={`rm-vote-ib${primary ? " primary" : ""}`} title={tip} aria-label={tip} onClick={onClick}>
      {icon}
    </button>
  );
}

/** Percent of the tally one option holds; 0 while nobody has answered. */
function pctOf(vote: Interaction | null, id: string): number {
  const total = vote?.tally?.total ?? 0;
  return total ? Math.round(((vote?.tally?.options[id] ?? 0) / total) * 100) : 0;
}

/** The last question asked in this room, or null when there was none. */
export function lastQuestion(vote: Interaction | null): string | null {
  if (!vote) return null;
  const q = vote.spec.prompt?.trim();
  if (q) return q;
  const opts = vote.spec.options.map((o) => o.label).filter(Boolean);
  return opts.length ? opts.join(" / ") : null;
}

/** The sub-page: question, two options, who votes, Open. Used in the flow
 * (column dock) and inside a popover (row dock) — same fields, same chrome. */
export function VoteEditor({
  onOpen,
  onBack,
  crumb = "Vote",
}: {
  onOpen: (input: VoteOpenInput) => void;
  onBack: () => void;
  crumb?: string;
}) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [prompt, setPrompt] = useState("");
  const [who, setWho] = useState<VoteWho>("both");
  const ready = !!a.trim() && !!b.trim();
  return (
    <div className="rm-filters rm-vote-edit">
      <div className="rm-filters-head">
        <button className="rm-crumb" onClick={onBack}>
          {chevRight}
          {crumb}
        </button>
        <span className="rm-filters-title">New question</span>
      </div>
      <div className="rm-vote-form">
        <input
          className="rm-vote-in"
          placeholder="Question (optional)"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          maxLength={140}
          autoFocus
        />
        <div className="rm-vote-opts">
          <input className="rm-vote-in" placeholder="Option A" value={a} onChange={(e) => setA(e.target.value)} maxLength={60} />
          <input className="rm-vote-in" placeholder="Option B" value={b} onChange={(e) => setB(e.target.value)} maxLength={60} />
        </div>
        <Select
          size="sm"
          className="rm-vote-in rm-vote-who"
          value={who}
          onChange={(v) => setWho(v as VoteWho)}
          title="Who votes"
          options={[
            { value: "both", label: "Guests + audience" },
            { value: "guest", label: "Guests only" },
            { value: "audience", label: "Audience only" },
          ]}
        />
        <div className="rm-vote-actions">
          <button
            className="rm-guest-admit"
            disabled={!ready}
            onClick={() => onOpen({ a: a.trim(), b: b.trim(), prompt: prompt.trim(), who })}
          >
            Open vote
          </button>
          <button className="rm-guest-modlink" onClick={onBack}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export function VotePanel({
  form,
  vote,
  audienceLink,
  editing,
  onEdit,
  onOpen,
  onTransition,
  onAudienceLink,
  popover,
}: {
  form: VoteForm;
  vote: Interaction | null;
  audienceLink: string | null;
  /** The editor is open (LiveView's `voteEdit`). */
  editing: boolean;
  /** Open / close the editor. The strip passes the button it was pressed
   * from so the caller can anchor the popover on it. */
  onEdit: (open: boolean, anchor?: HTMLElement) => void;
  onOpen: (input: VoteOpenInput) => void;
  onTransition: (t: "open" | "reveal" | "close" | "cancel", holdMs?: number) => void;
  onAudienceLink: () => void;
  /** Row dock only: the caller's popover (the editor in a Pop), rendered
   * inside the strip's anchor so it lands under the Set up button. */
  popover?: ReactNode;
}) {
  // A live tally re-reads its countdown twice a second.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!vote || vote.state !== "collecting") return;
    const t = window.setInterval(() => tick((n) => n + 1), 500);
    return () => window.clearInterval(t);
  }, [vote?.id, vote?.state]);

  const live = voteIsLive(vote?.state);
  const total = vote?.tally?.total ?? 0;
  const pct = (id: string) => pctOf(vote, id);
  const left = vote?.timing.reveal_at ? Math.max(0, Math.ceil((Date.parse(vote.timing.reveal_at) - Date.now()) / 1000)) : null;
  const last = lastQuestion(vote);

  const audienceBtn = (
    <button className="rm-guest-modlink rm-vote-aud" onClick={onAudienceLink} title={audienceLink ?? "Copy a link the audience opens on their phones (no account)"}>
      Audience link
    </button>
  );

  /** The transport for a live vote — one row that wraps under 220px. */
  const transport = live && vote && (
    <div className="rm-vote-actions">
      {vote.state === "open" && (
        <>
          <button className="rm-guest-admit" onClick={() => onTransition("open")}>Start</button>
          <button className="rm-guest-modlink" onClick={() => onTransition("cancel")}>Cancel</button>
        </>
      )}
      {vote.state === "collecting" && (
        <>
          <button className="rm-guest-admit" onClick={() => onTransition("reveal", 0)}>Reveal</button>
          <button className="rm-guest-modlink" onClick={() => onTransition("reveal", 3000)} title="The server reveals in 3 s — a countdown on the set">
            in 3s
          </button>
          <button className="rm-guest-modlink" onClick={() => onTransition("close")}>Close</button>
          <button className="rm-guest-modlink" onClick={() => onTransition("cancel")}>Cancel</button>
        </>
      )}
      {vote.state === "revealed" && <button className="rm-guest-admit" onClick={() => onTransition("close")}>Close</button>}
    </div>
  );

  if (form === "strip") {
    // ONE line, chat-strip sizing, never wider than the dock: the label
    // (fixed width), the question, the inline tally, an icon-only transport
    // — every span may ellipsize; everything sits on the row's centre line.
    const stripTransport = live && vote && (
      <span className="rm-vote-actions rm-vote-strip-actions">
        {vote.state === "open" && (
          <>
            <StripBtn icon={sic.play} tip="Start collecting answers" primary onClick={() => onTransition("open")} />
            <StripBtn icon={sic.x} tip="Cancel this vote" onClick={() => onTransition("cancel")} />
          </>
        )}
        {vote.state === "collecting" && (
          <>
            <StripBtn icon={sic.eye} tip="Reveal the result now" primary onClick={() => onTransition("reveal", 0)} />
            <button type="button" className="rm-vote-ib rm-vote-ib-txt" title="The server reveals in 3 s — a countdown on the set" aria-label="Reveal in 3 seconds" onClick={() => onTransition("reveal", 3000)}>
              3s
            </button>
            <StripBtn icon={sic.check} tip="Close the vote" onClick={() => onTransition("close")} />
            <StripBtn icon={sic.x} tip="Cancel this vote" onClick={() => onTransition("cancel")} />
          </>
        )}
        {vote.state === "revealed" && <StripBtn icon={sic.check} tip="Close the vote" onClick={() => onTransition("close")} />}
      </span>
    );
    return (
      <div className="rm-strip rm-row-strip rm-vote-strip" data-live={live ? "1" : undefined}>
        <span className="rm-vote-tag">Vote</span>
        <span className="rm-vote-strip-q" title={last ?? undefined}>
          {live && vote ? (vote.spec.prompt || last) : last ?? "No vote"}
        </span>
        {live && vote && (
          <span className="rm-vote-strip-tally">
            {vote.spec.options.map((o) => (
              <span key={o.id} className={`rm-vote-strip-opt${vote.tally?.winner === o.id && vote.state !== "collecting" ? " win" : ""}`}>
                <span className="rm-vote-label">{o.label}</span>
                <span className="rm-vote-n">{pct(o.id)}%</span>
                <span className="rm-vote-track"><span className="rm-vote-fill" style={{ width: `${pct(o.id)}%` }} /></span>
              </span>
            ))}
            {vote.state === "collecting" && left != null && <span className="rm-vote-fine">{left}s</span>}
          </span>
        )}
        {live ? (
          stripTransport
        ) : (
          <span className="rm-pop-anchor rm-vote-anchor">
            <StripBtn icon={sic.plus} tip="Set up a vote" onClick={(e) => onEdit(!editing, e.currentTarget)} />
            {editing && popover}
          </span>
        )}
      </div>
    );
  }

  if (form === "edit") {
    return <VoteEditor onOpen={onOpen} onBack={() => onEdit(false)} />;
  }

  if (form === "live" && vote) {
    return (
      <div className="rm-vote rm-vote-live">
        <div className="rm-vote-head">
          <span className="rm-vote-title">
            {vote.state === "open" && "Ready"}
            {vote.state === "collecting" && "Collecting"}
            {vote.state === "revealed" && "Revealed"}
          </span>
          {audienceBtn}
        </div>
        {vote.spec.prompt && <div className="rm-vote-prompt">{vote.spec.prompt}</div>}
        {vote.spec.options.map((o) => (
          <div key={o.id} className={`rm-vote-bar${vote.tally?.winner === o.id && vote.state !== "collecting" ? " win" : ""}`}>
            <span className="rm-vote-label">{o.label}</span>
            <span className="rm-vote-track"><span className="rm-vote-fill" style={{ width: `${pct(o.id)}%` }} /></span>
            <span className="rm-vote-n">{vote.tally?.options[o.id] ?? 0}</span>
          </div>
        ))}
        <div className="rm-vote-fine">
          {vote.state === "open" && "Not taking answers yet."}
          {vote.state === "collecting" && `${total} so far${left != null ? ` · reveals in ${left}s` : ""}`}
          {vote.state === "revealed" && `Revealed · ${total} vote${total === 1 ? "" : "s"}`}
        </div>
        {transport}
      </div>
    );
  }

  // card: idle in a column.
  return (
    <div className="rm-vote rm-vote-card">
      <div className="rm-vote-head">
        <span className="rm-vote-title">Vote</span>
        {audienceBtn}
      </div>
      <div className="rm-vote-last">
        <span className="rm-vote-last-q" title={last ?? undefined}>
          {last ?? "No vote yet"}
          {last && vote?.tally && (
            <em className="rm-vote-fine"> · {vote.spec.options.map((o) => `${o.label} ${pct(o.id)}%`).join(" · ")}</em>
          )}
        </span>
        <button className="rm-guest-admit" onClick={(e) => onEdit(true, e.currentTarget)}>
          Set up
        </button>
      </div>
    </div>
  );
}
