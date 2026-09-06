// The first-room walkthrough. Two shapes: a full-room welcome, then coach
// cards that sit beside the real control and wait for the real click. Nothing
// here simulates an action or fakes progress — every step advances because the
// room changed, so a user who wanders off and does it their own way still
// finishes. See lib/walkthrough.ts for why the ORDER (scene before source) is
// the whole point.
import { useEffect, useRef, useState } from "react";
import { Confetti } from "./Confetti";
import {
  COUNTED,
  WALK_COPY,
  WALK_ORDER,
  anchorFor,
  rewindFor,
  stepSatisfied,
  type WalkAnchor,
  type WalkStep,
  type WalkWorld,
} from "../lib/walkthrough";

const CARD_W = 320;
/** Enough for the tallest card (title + body + action). Over-estimating only
 *  makes the placement more conservative, which is the safe direction. */
const CARD_H = 230;
const GAP = 12;

/** Where the card goes so it NEVER covers the thing it is pointing at.
 *
 *  This was a real bug: the card sat under the anchor by default, which is
 *  fine beside a 28px button and wrong beside a full-height panel — it landed
 *  right on top of the source list the user was being told to click.
 *
 *  So: tall anchors (a panel) get the card to the SIDE, short ones (a button)
 *  get it below, and every candidate is rejected if it would overlap the
 *  anchor or fall off screen. */
export function placeCard(
  r: { top: number; left: number; width: number; height: number },
  vw: number,
  vh: number,
): { top: number; left: number } {
  const tall = r.height > 160;
  const right = { top: Math.min(r.top, vh - CARD_H - GAP), left: r.left + r.width + GAP };
  const left = { top: Math.min(r.top, vh - CARD_H - GAP), left: r.left - CARD_W - GAP };
  const below = { top: r.top + r.height + GAP, left: r.left };
  const above = { top: r.top - CARD_H - GAP, left: r.left };
  const order = tall ? [right, left, below, above] : [below, right, left, above];

  const fits = (c: { top: number; left: number }) =>
    c.left >= GAP &&
    c.top >= GAP &&
    c.left + CARD_W <= vw - GAP &&
    c.top + CARD_H <= vh - GAP &&
    // No overlap with the anchor itself — the whole point.
    !(c.left < r.left + r.width && c.left + CARD_W > r.left && c.top < r.top + r.height && c.top + CARD_H > r.top);

  for (const c of order) if (fits(c)) return c;
  // Nothing fits cleanly (a panel filling the window). Bottom-left corner is
  // the least-bad: away from the header, and every dock has room beneath it.
  return { top: Math.max(GAP, vh - CARD_H - GAP), left: GAP };
}

/** Where a coach card lands. Measured from the live DOM each time the step
 *  changes (and on resize): the docks move, so a hard-coded corner would be
 *  wrong the moment someone rearranged their room. */
function useAnchorRect(anchor: WalkAnchor, step: WalkStep): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    if (!anchor) {
      setRect(null);
      return;
    }
    const sel: Record<Exclude<WalkAnchor, null>, string> = {
      "header-edit": "[data-walk='edit']",
      "editbar-add": ".rm-dock .rm-add-anchor button, .rm-addbtn",
      "editbar-done": ".rm-editbar-done",
      "panel-scenes": ".rm-panel-scenes",
      "panel-sources": ".rm-panel-sources",
      "panel-guests": ".rm-panel-guests",
    };
    const find = () => {
      const el = document.querySelector(sel[anchor]);
      setRect(el ? el.getBoundingClientRect() : null);
    };
    find();
    // The target often mounts a frame later (the editor opening, a panel
    // arriving in a dock), so look again for a short while rather than
    // deciding once that there is nothing to point at.
    const iv = window.setInterval(find, 250);
    window.addEventListener("resize", find);
    return () => {
      window.clearInterval(iv);
      window.removeEventListener("resize", find);
    };
  }, [anchor, step]);
  return rect;
}

export function Walkthrough({
  world,
  start = "welcome",
  onStep,
  onOpenIntegrations,
  onClose,
}: {
  world: WalkWorld;
  /** Resume point. The walkthrough leaves the room for Settings, which
   *  unmounts this whole view — the caller restores where we were. */
  start?: WalkStep;
  /** Every step change, so the caller can persist it across that trip. */
  onStep?: (s: WalkStep) => void;
  /** Leaves the room and opens Settings → Integrations. Absent = that step
   *  degrades to a plain card the user dismisses. */
  onOpenIntegrations?: () => void;
  /** Finished or skipped — either way the pref is written by the caller. */
  onClose: (reason: "done" | "skip") => void;
}) {
  const [step, setStep] = useState<WalkStep>(start);
  /** Steps the user chose to pass on. A skipped step is NOT a step they failed
   *  — so the rewind below must never haul them back into one. Without this,
   *  skipping "add the Scenes panel" while the editor is shut would bounce
   *  straight back to "open the editor", which is not skipping at all. */
  const [skipped, setSkipped] = useState<Set<WalkStep>>(() => new Set());
  useEffect(() => {
    onStep?.(step);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);
  const anchor = anchorFor(step, world.layout);
  const rect = useAnchorRect(anchor, step);

  const advance = (from: WalkStep) =>
    WALK_ORDER[Math.min(WALK_ORDER.indexOf(from) + 1, WALK_ORDER.length - 1)]!;

  /** Skip THIS step, not the walkthrough. Ending it entirely is a separate,
   *  quieter control at the foot of the card. */
  const skipStep = () => {
    setSkipped((prev) => new Set(prev).add(step));
    setStep((s) => advance(s));
  };

  // Advance when the ROOM says the step is done. A short beat first, so the
  // card acknowledges the click instead of vanishing out from under it.
  const [flash, setFlash] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (!stepSatisfied(step, world)) {
      // Undid an earlier step (closed the editor mid-way)? Walk back rather
      // than leaving the user staring at an instruction they cannot follow.
      const back = rewindFor(step, world);
      if (back && !skipped.has(back)) setStep(back);
      return;
    }
    setFlash(true);
    timer.current = window.setTimeout(() => {
      setFlash(false);
      setStep((s) => advance(s));
    }, 520);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, skipped, world.layoutEdit, world.scenes, world.extras, world.mics, world.layout]);

  const copy = WALK_COPY[step];

  // ── The welcome: an entire-room overlay, the one blocking moment ───────
  // Built out of the ROOM'S OWN parts, not a landing page dropped on top of
  // it: a panel at --r-card with a hairline, an 11px/0.16em group label in
  // its head, and rows at 10px the way every list in the room is drawn. The
  // first cut was pill buttons and a gradient headline — generic, and nothing
  // else in Producer looks like that.
  if (step === "welcome") {
    return (
      <div className="walk-veil" role="dialog" aria-modal="true" aria-label="Welcome to your Room, Producer">
        <div className="walk-panel">
          <div className="walk-panel-head">
            <span className="walk-live-dot" />
            <span className="rm-group-label">NEW ROOM</span>
          </div>
          <div className="walk-panel-body">
            <h1 className="walk-title">
              Welcome to your Room, <span className="walk-title-you">Producer</span>
            </h1>
            <p className="walk-body">{copy.body}</p>
            <ul className="walk-steps" aria-label="What you'll do">
              {["A scene", "A source", "Guests", "Audio", "Going live"].map((label, i) => (
                <li key={label} className="walk-step-row" style={{ animationDelay: `${200 + i * 60}ms` }}>
                  <span className="walk-step-n">{i + 1}</span>
                  <span className="walk-step-label">{label}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="walk-panel-foot">
            <span className="walk-foot">About a minute. Settings → App turns it back on.</span>
            <div className="walk-hero-acts">
              <button className="walk-skip" onClick={() => onClose("skip")}>
                Skip
              </button>
              <button className="walk-begin" onClick={() => setStep("edit")}>
                Begin
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── The trip out to Settings ──────────────────────────────────────────
  // The only step that takes the user out of the room. It is optional on
  // purpose: stream keys are a different day's errand for most people, and
  // gating "you finished the walkthrough" on having them would be a lie.
  if (step === "integrations") {
    return (
      <div className="walk-card walk-card-centre" role="dialog" aria-label={copy.title}>
        <h2 className="walk-card-title">{copy.title}</h2>
        <p className="walk-card-body">{copy.body}</p>
        <div className="walk-card-acts walk-card-acts-split">
          <button className="walk-skip" onClick={() => setStep("finish")}>
            Skip — no keys yet
          </button>
          <button
            className="walk-begin"
            onClick={() => {
              // SYNCHRONOUSLY, then leave. setStep only schedules a render,
              // and onOpenIntegrations unmounts this whole view on the same
              // tick — so the effect that persists the step never ran, the
              // breadcrumb was never written, and the walkthrough simply
              // ended in Settings with no way back.
              onStep?.("back");
              setStep("back");
              onOpenIntegrations?.();
            }}
            disabled={!onOpenIntegrations}
          >
            Take me there
          </button>
        </div>
      </div>
    );
  }

  // ── Back from Settings, and the close ─────────────────────────────────
  if (step === "back" || step === "finish") {
    return (
      <>
      {step === "finish" && <Confetti />}
      <div className="walk-card walk-card-centre" role="dialog" aria-label={copy.title}>
        <h2 className="walk-card-title">{copy.title}</h2>
        <p className="walk-card-body">{copy.body}</p>
        <div className="walk-card-acts">
          {step === "back" ? (
            <button className="walk-begin" onClick={() => setStep("finish")}>
              Nearly done
            </button>
          ) : (
            <button className="walk-begin" onClick={() => onClose("done")}>
              Enter room
            </button>
          )}
        </div>
      </div>
      </>
    );
  }

  // ── A coach step: the ring on the real control, the card beside it ─────
  const style: React.CSSProperties = rect
    ? placeCard(rect, window.innerWidth, window.innerHeight)
    : {};
  const n = COUNTED.indexOf(step) + 1;

  return (
    <>
      {rect && (
        <div
          className={`walk-ring${flash ? " hit" : ""}`}
          style={{ top: rect.top - 6, left: rect.left - 6, width: rect.width + 12, height: rect.height + 12 }}
        />
      )}
      <div
        className={`walk-card${rect ? "" : " walk-card-centre"}${flash ? " done" : ""}`}
        style={style}
        role="dialog"
        aria-label={copy.title}
      >
        <div className="walk-card-head">
          <span className="walk-step">Step {n} of {COUNTED.length}</span>
          <button className="walk-x" onClick={skipStep} title="Move past this step">
            Skip step
          </button>
        </div>
        <h2 className="walk-card-title">{copy.title}</h2>
        <p className="walk-card-body">{copy.body}</p>
        {copy.action && <p className="walk-do">{copy.action}</p>}
        <button className="walk-end" onClick={() => onClose("skip")}>
          End walkthrough
        </button>
      </div>
    </>
  );
}
