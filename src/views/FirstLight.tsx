import { useCallback, useEffect, useRef, useState } from "react";
import { hasTauri, ipc, type LivePermissions } from "../lib/ipc";
import { Wordmark } from "./Onboarding";

/** First Light — the first-launch experience. A cinematic intro (once,
 * ever), a short welcome, and the permissions ritual with the native drag
 * chip for Screen Recording. Skippable at every step; state lives in
 * localStorage so an update never replays it. */

const DONE_KEY = "producer.firstlight.v1";
const INTRO_KEY = "producer.firstlight.intro.v1";

export function firstLightDone(): boolean {
  try {
    return localStorage.getItem(DONE_KEY) === "1";
  } catch {
    return true; // storage unavailable — never trap the user in onboarding
  }
}

type Phase = "intro" | "welcome" | "permissions";

export function FirstLight({ onDone }: { onDone: () => void }) {
  const [phase, setPhase] = useState<Phase>(() => {
    try {
      return localStorage.getItem(INTRO_KEY) === "1" ? "welcome" : "intro";
    } catch {
      return "welcome";
    }
  });

  // Mid-permissions relaunch (the Screen Recording grant requires one):
  // a Rust-side marker survives the restart — localStorage can't, WKWebView
  // flushes it asynchronously — and drops us straight back on the list.
  useEffect(() => {
    if (!hasTauri()) return;
    ipc
      .firstlightResume("take")
      .then((hit) => {
        if (hit) setPhase("permissions");
      })
      .catch(() => {});
  }, []);

  const finish = useCallback(() => {
    try {
      localStorage.setItem(DONE_KEY, "1");
    } catch {
      /* still proceed */
    }
    if (hasTauri()) {
      ipc.liveScreenCoach("chip_hide").catch(() => {});
      ipc.firstlightResume("clear").catch(() => {});
    }
    onDone();
  }, [onDone]);

  if (phase === "intro")
    return (
      <Intro
        onEnd={() => {
          try {
            localStorage.setItem(INTRO_KEY, "1");
          } catch {
            /* cosmetic only */
          }
          setPhase("welcome");
        }}
      />
    );
  if (phase === "welcome")
    return <Welcome onNext={() => setPhase("permissions")} onSkip={finish} />;
  return <Permissions onDone={finish} />;
}

/* ── Intro: dark fade, mark breathes in, ambient swell ─────────────────── */

function Intro({ onEnd }: { onEnd: () => void }) {
  const ended = useRef(false);
  const end = useCallback(() => {
    if (ended.current) return;
    ended.current = true;
    onEnd();
  }, [onEnd]);

  useEffect(() => {
    const stop = playSwell();
    const t = setTimeout(end, 5200);
    return () => {
      clearTimeout(t);
      stop();
    };
  }, [end]);

  return (
    <div className="fl-intro" onClick={end}>
      <div className="fl-intro-mark">
        <Wordmark />
        <div className="fl-intro-sub">Go live everywhere.</div>
      </div>
    </div>
  );
}

/** Soft two-chord synth swell — no bundled audio, no licensing. If the
 * webview blocks autoplay the intro simply plays silent. */
function playSwell(): () => void {
  try {
    const Ctx = window.AudioContext ?? (window as never as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    const master = ctx.createGain();
    master.gain.value = 0;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 900;
    master.connect(lp).connect(ctx.destination);
    const t0 = ctx.currentTime;
    master.gain.linearRampToValueAtTime(0.07, t0 + 2.2);
    master.gain.linearRampToValueAtTime(0.0, t0 + 5.0);
    const voices: OscillatorNode[] = [];
    const chord = (freqs: number[], start: number, dur: number) => {
      for (const f of freqs) {
        const o = ctx.createOscillator();
        o.type = "sine";
        o.frequency.value = f;
        const g = ctx.createGain();
        g.gain.value = 0;
        g.gain.setValueAtTime(0, t0 + start);
        g.gain.linearRampToValueAtTime(0.5, t0 + start + dur * 0.4);
        g.gain.linearRampToValueAtTime(0, t0 + start + dur);
        o.connect(g).connect(master);
        o.start(t0 + start);
        o.stop(t0 + start + dur + 0.1);
        voices.push(o);
      }
    };
    chord([110, 220, 277.18, 329.63], 0, 3.2); // A add9 bloom
    chord([123.47, 246.94, 311.13, 392.0], 2.2, 2.8); // lift to B
    return () => {
      try {
        for (const v of voices) v.stop();
        ctx.close().catch(() => {});
      } catch {
        /* already gone */
      }
    };
  } catch {
    return () => {};
  }
}

/* ── Welcome ───────────────────────────────────────────────────────────── */

function Welcome({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) {
  return (
    <div className="fl-screen">
      <div className="fl-body">
        <Wordmark />
        <h1 className="fl-h1">Welcome to Producer</h1>
        <p className="fl-sub">The open-source studio for going live everywhere, from one Mac.</p>
        <div className="fl-props">
          <div className="fl-prop">
            <span className="fl-prop-dot" />
            <div>
              <strong>Multistream natively.</strong> Twitch, Kick, and YouTube at once — one
              encoder, zero extra apps.
            </div>
          </div>
          <div className="fl-prop">
            <span className="fl-prop-dot" />
            <div>
              <strong>Overlays built in.</strong> Alerts, browser overlays, and window capture
              with true transparency.
            </div>
          </div>
          <div className="fl-prop">
            <span className="fl-prop-dot" />
            <div>
              <strong>Part of a network.</strong> Connect your Boomin workspace and your streams
              join something bigger.
            </div>
          </div>
        </div>
        <div className="fl-actions">
          <button className="fl-primary" onClick={onNext}>
            Set up permissions
          </button>
          <button className="fl-ghost" onClick={onSkip}>
            Skip for now
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Permissions ───────────────────────────────────────────────────────── */

type PermState = LivePermissions | null;

function Permissions({ onDone }: { onDone: () => void }) {
  const [perms, setPerms] = useState<PermState>(null);
  // Screen Recording only takes effect for processes launched after the
  // grant. If it flips to granted during THIS run, a relaunch is required.
  const initialScreen = useRef<string | null>(null);
  const [chipUp, setChipUp] = useState(false);

  useEffect(() => {
    if (!hasTauri()) return;
    // From here on, every launch returns to this list until the user
    // finishes or skips — finish() clears the marker.
    ipc.firstlightResume("set").catch(() => {});
    let alive = true;
    const poll = async () => {
      try {
        const p = await ipc.livePermissions();
        if (!alive) return;
        if (initialScreen.current === null) initialScreen.current = p.screen;
        setPerms(p);
      } catch {
        /* engine-less build — rows render as unavailable */
      }
    };
    poll();
    const t = setInterval(poll, 1200);
    return () => {
      alive = false;
      clearInterval(t);
      ipc.liveScreenCoach("chip_hide").catch(() => {});
    };
  }, []);

  const screenGranted = perms?.screen === "granted";
  const needsRelaunch = screenGranted && initialScreen.current !== "granted";
  const allSet = screenGranted && perms?.camera === "granted" && perms?.mic === "granted";

  useEffect(() => {
    if (screenGranted && chipUp) {
      ipc.liveScreenCoach("chip_hide").catch(() => {});
      setChipUp(false);
    }
  }, [screenGranted, chipUp]);

  async function startScreenGrant() {
    try {
      await ipc.liveScreenCoach("open_settings");
      await ipc.liveScreenCoach("chip_show");
      setChipUp(true);
    } catch {
      /* engine-less build */
    }
  }

  async function relaunchNow() {
    // Await the marker write — the IPC roundtrip guarantees it is on disk
    // before the process dies.
    await ipc.firstlightResume("set").catch(() => {});
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  }

  return (
    <div className="fl-screen">
      <div className="fl-body">
        <Wordmark />
        <h1 className="fl-h1">Three quick permissions</h1>
        <p className="fl-sub">
          macOS asks once. With Producer signed and notarized, these grants survive updates.
        </p>

        <PermRow
          title="Screen recording"
          detail={
            chipUp
              ? "System Settings is open — drag the floating Producer chip into the list, then flip its toggle on."
              : "Lets Producer capture your screen for the stream."
          }
          status={perms?.screen === "granted" ? "granted" : perms ? "pending" : "unknown"}
          action={
            needsRelaunch ? (
              <button className="fl-primary" onClick={relaunchNow}>
                Restart Producer to finish
              </button>
            ) : screenGranted ? null : (
              <button className="fl-primary" onClick={startScreenGrant}>
                Open Settings
              </button>
            )
          }
        />
        <PermRow
          title="Camera"
          detail="For your on-stream camera. Producer never records without you."
          status={perms?.camera === "granted" ? "granted" : perms ? "pending" : "unknown"}
          action={
            perms?.camera === "granted" ? null : (
              <button className="fl-primary" onClick={() => ipc.liveRequestPermission("camera").catch(() => {})}>
                Allow camera
              </button>
            )
          }
        />
        <PermRow
          title="Microphone"
          detail="So your voice makes it to the stream."
          status={perms?.mic === "granted" ? "granted" : perms ? "pending" : "unknown"}
          action={
            perms?.mic === "granted" ? null : (
              <button className="fl-primary" onClick={() => ipc.liveRequestPermission("mic").catch(() => {})}>
                Allow microphone
              </button>
            )
          }
        />

        <div className="fl-actions">
          <button className={allSet ? "fl-primary" : "fl-ghost"} onClick={onDone} disabled={needsRelaunch}>
            {allSet ? "Continue" : "Set up later"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PermRow({
  title,
  detail,
  status,
  action,
}: {
  title: string;
  detail: string;
  status: "granted" | "pending" | "unknown";
  action: React.ReactNode;
}) {
  return (
    <div className={`fl-perm ${status === "granted" ? "is-granted" : ""}`}>
      <div className="fl-perm-check">{status === "granted" ? "✓" : ""}</div>
      <div className="fl-perm-text">
        <div className="fl-perm-title">{title}</div>
        <div className="fl-perm-detail">{detail}</div>
      </div>
      <div className="fl-perm-action">
        {status === "granted" ? <span className="fl-perm-granted">Granted</span> : action}
      </div>
    </div>
  );
}
