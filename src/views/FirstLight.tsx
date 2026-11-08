import { useCallback, useEffect, useRef, useState } from "react";
import { hasTauri, ipc, vcam as vcamIpc, type LivePermissions, type VcamStatus } from "../lib/ipc";
import { EntryFrame } from "./EntryFrame";

/** First-launch welcome and device access. The completion key is unchanged,
 * so existing users are not sent through setup again after an update. */

const DONE_KEY = "producer.firstlight.v1";

export function firstLightDone(): boolean {
  try {
    return localStorage.getItem(DONE_KEY) === "1";
  } catch {
    return true; // storage unavailable — never trap the user in onboarding
  }
}

type Phase = "welcome" | "permissions";

export function FirstLight({ onDone }: { onDone: () => void }) {
  const [phase, setPhase] = useState<Phase>("welcome");

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

  if (phase === "welcome") return <Welcome onNext={() => setPhase("permissions")} />;
  return <Permissions onDone={finish} />;
}

/* ── Welcome ───────────────────────────────────────────────────────────── */

function Welcome({ onNext }: { onNext: () => void }) {
  return (
    <EntryFrame stage="welcome">
      <p className="entry-eyebrow">Welcome to Producer</p>
      <h1 className="entry-heading">Your studio starts here.</h1>
      <p className="entry-description">Create Sets, go live, and bring guests into your show.</p>
      <div className="entry-actions">
        <button type="button" className="entry-primary" onClick={onNext}>
          Continue to setup
        </button>
      </div>
    </EntryFrame>
  );
}

/* ── Permissions ───────────────────────────────────────────────────────── */

type PermState = LivePermissions | null;

function Permissions({ onDone }: { onDone: () => void }) {
  const [perms, setPerms] = useState<PermState>(null);
  // The virtual camera is a system EXTENSION, not a TCC permission: macOS
  // installs it, the user approves it in Settings, and it only becomes a real
  // device afterwards. Optional by design — you can stream all day without it.
  const [vcam, setVcam] = useState<VcamStatus | null>(null);
  const [vcamBusy, setVcamBusy] = useState(false);
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
        const v = await vcamIpc.status().catch(() => null);
        if (alive && v) setVcam(v);
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

  async function installVirtualCamera() {
    setVcamBusy(true);
    try {
      await vcamIpc.activate();
      setVcam(await vcamIpc.status());
    } finally {
      setVcamBusy(false);
    }
  }

  let cameraDetail = "Use your Producer output as a webcam in other apps.";
  let cameraAction: React.ReactNode = null;
  if (vcam && !vcam.installed) {
    switch (vcam.state) {
      case "move_to_applications":
        cameraDetail = "Move Producer to Applications, then reopen it to install the virtual camera.";
        cameraAction = (
          <button type="button" className="entry-secondary" onClick={() => vcamIpc.revealApp().catch(() => {})}>
            Show in Finder
          </button>
        );
        break;
      case "needs_approval":
        cameraDetail = "Approve Producer Virtual Camera in system settings.";
        cameraAction = (
          <button type="button" className="entry-secondary" onClick={() => vcamIpc.openSettings().catch(() => {})}>
            Open Settings
          </button>
        );
        break;
      case "requires_signed_app":
      case "restart_required":
      case "unsupported":
      case "unavailable":
        cameraDetail = vcam.error ?? "The virtual camera is unavailable in this build.";
        break;
      default: {
        const installing = vcamBusy || vcam.state === "requested" || vcam.state === "active";
        if (vcam.state === "failed") cameraDetail = vcam.error ?? "The virtual camera could not be installed.";
        cameraAction = (
          <button type="button" className="entry-secondary" disabled={installing} onClick={() => void installVirtualCamera().catch(() => {})}>
            {installing ? "Installing…" : "Install"}
          </button>
        );
      }
    }
  }

  return (
    <EntryFrame stage="access">
      <p className="entry-eyebrow">Studio setup</p>
      <h1 className="entry-heading">Give your studio access.</h1>
      <p className="entry-description">
        Allow the screen and devices you plan to use. Your system may ask you to approve access.
      </p>
      <div className="entry-list" role="list" aria-label="Studio permissions">
        <PermRow
          title="Screen recording"
          detail={
            chipUp
              ? "In system settings, add the floating Producer chip to screen recording and turn access on."
              : "Share a screen or window in your show."
          }
          status={perms?.screen === "granted" ? "granted" : perms ? "pending" : "unknown"}
          action={
            needsRelaunch ? (
              <button type="button" className="entry-secondary" onClick={relaunchNow}>
                Restart Producer
              </button>
            ) : screenGranted ? null : (
              <button type="button" className="entry-secondary" onClick={startScreenGrant}>
                Open Settings
              </button>
            )
          }
        />
        <PermRow
          title="Camera"
          detail="Bring your camera into the room."
          status={perms?.camera === "granted" ? "granted" : perms ? "pending" : "unknown"}
          action={
            perms?.camera === "granted" ? null : (
              <button type="button" className="entry-secondary" onClick={() => ipc.liveRequestPermission("camera").catch(() => {})}>
                Allow camera
              </button>
            )
          }
        />
        <PermRow
          title="Microphone"
          detail="Add your voice to the show."
          status={perms?.mic === "granted" ? "granted" : perms ? "pending" : "unknown"}
          action={
            perms?.mic === "granted" ? null : (
              <button type="button" className="entry-secondary" onClick={() => ipc.liveRequestPermission("mic").catch(() => {})}>
                Allow microphone
              </button>
            )
          }
        />

        <PermRow
          title="Virtual camera"
          optional
          detail={cameraDetail}
          status={vcam?.installed ? "granted" : cameraAction ? "pending" : "unknown"}
          action={cameraAction}
        />
      </div>
      <p className="entry-note">Virtual camera is optional. You can manage access later in Settings.</p>
      <div className="entry-actions">
        <button type="button" className={allSet ? "entry-primary" : "entry-secondary"} onClick={onDone} disabled={needsRelaunch}>
          {allSet ? "Continue" : "Skip for now"}
        </button>
      </div>
    </EntryFrame>
  );
}

function PermRow({
  title,
  detail,
  status,
  action,
  optional,
}: {
  title: string;
  detail: string;
  status: "granted" | "pending" | "unknown";
  action: React.ReactNode;
  /** Optional rows never block Continue and say so, so nobody thinks a
   * half-finished list means a broken app. */
  optional?: boolean;
}) {
  return (
    <div className={`fl-perm ${status === "granted" ? "is-granted" : ""}`} role="listitem">
      <div className="fl-perm-check" aria-hidden="true">{status === "granted" ? "✓" : ""}</div>
      <div className="fl-perm-text">
        <div className="fl-perm-title">
          {title}
          {optional && <span className="fl-perm-optional">optional</span>}
        </div>
        <div className="fl-perm-detail">{detail}</div>
      </div>
      <div className="fl-perm-action" aria-live="polite">
        {action ?? (status === "granted" ? <span className="fl-perm-granted">Granted</span> : null)}
      </div>
    </div>
  );
}
