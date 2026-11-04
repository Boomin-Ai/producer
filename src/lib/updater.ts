import { useEffect, useRef, useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { hasTauri } from "./ipc";

export type UpdateState = "idle" | "checking" | "current" | "error" | "downloading" | "ready" | "installing" | "restarting" | "installed";

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** Quiet auto-update: check on launch and every few hours; download in the
 * background; surface only a "restart to update" affordance once staged.
 * Failures (offline, no manifest entry for this platform yet) stay silent —
 * the updater must never nag or block.
 *
 * Downloading and installing are deliberately two steps. `downloadAndInstall()`
 * runs the installer the instant the bytes land: on Windows the plugin hands
 * the NSIS installer to `ShellExecuteW` and then calls `std::process::exit(0)`,
 * so the app disappears mid-session and the installer races the dying process
 * for the write lock on its own `producer.exe` — the user gets "Error opening
 * file for writing" with Abort/Retry/Ignore, and the update never lands. macOS
 * survives the same call because a running bundle can be swapped underneath
 * itself. Staging the download and installing on the affordance above is what
 * this comment always claimed, works on both platforms, and means the app is
 * quiet and expendable at the moment its own binary is replaced.
 */
export interface UpdaterStatus {
  state: UpdateState;
  version: string | null;
  error: string | null;
  restart: () => Promise<void>;
  checkNow: () => void;
}

export function useUpdater(): UpdaterStatus {
  const [state, setState] = useState<UpdateState>("idle");
  const [version, setVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const installing = useRef(false);
  const installed = useRef(false);
  const checkNow = useRef<() => void>(() => {});
  /** The downloaded-but-not-installed update, kept for `restart`. */
  const staged = useRef<Update | null>(null);

  useEffect(() => {
    if (!hasTauri()) return;
    let alive = true;

    const run = async () => {
      if (busy.current || staged.current || installed.current || installing.current) return;
      busy.current = true;
      setError(null);
      setState("checking");
      let downloading = false;
      try {
        const { check } = await import("@tauri-apps/plugin-updater");
        const update = await check();
        if (!alive) return;
        if (!update) {setVersion(null);setState("current");return;}
        downloading = true;
        setState("downloading");
        setVersion(update.version);
        await update.download();
        if (!alive) return;
        staged.current = update;
        setState("ready");
      } catch (cause) {
        if (alive && !staged.current) {
          setError(`${downloading ? "Could not download the update" : "Could not check for updates"}. ${cause instanceof Error ? cause.message : String(cause)}`);
          setState("error");
        }
      } finally {
        busy.current = false;
      }
    };

    checkNow.current = () => {void run();};
    run();
    const t = setInterval(run, CHECK_INTERVAL_MS);
    return () => {
      alive = false;
      checkNow.current = () => {};
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    state,
    version,
    error,
    checkNow: () => checkNow.current(),
    restart: async () => {
      // Guard synchronously: React may not have painted the disabled button yet.
      if (installing.current || (!staged.current && !installed.current)) return;
      installing.current = true;
      setError(null);
      setState(installed.current ? "restarting" : "installing");
      try {
        // Paint acknowledgement before native extraction / bundle replacement.
        await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
        const { relaunch } = await import("@tauri-apps/plugin-process");
        if (!installed.current) {
          // Windows exits here; macOS/Linux return after bundle replacement.
          await staged.current!.install();
          installed.current = true;
          staged.current = null;
        }
        setState("restarting");
        await relaunch();
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        setError(`${installed.current ? "The update is installed, but Producer could not restart" : "The update could not be installed"}. ${detail}`);
        // Keep downloaded bytes for an installation retry. A relaunch retry
        // must never try to install already-consumed bytes a second time.
        setState(installed.current ? "installed" : "ready");
      } finally {
        installing.current = false;
      }
    },
  };
}
