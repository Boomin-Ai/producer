import { useEffect, useRef, useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { hasTauri } from "./ipc";

export type UpdateState = "idle" | "downloading" | "ready";

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
export function useUpdater(): { state: UpdateState; version: string | null; restart: () => void } {
  const [state, setState] = useState<UpdateState>("idle");
  const [version, setVersion] = useState<string | null>(null);
  const busy = useRef(false);
  /** The downloaded-but-not-installed update, kept for `restart`. */
  const staged = useRef<Update | null>(null);

  useEffect(() => {
    if (!hasTauri()) return;
    let alive = true;

    const run = async () => {
      if (busy.current || staged.current) return;
      busy.current = true;
      try {
        const { check } = await import("@tauri-apps/plugin-updater");
        const update = await check();
        if (!alive || !update) return;
        setState("downloading");
        setVersion(update.version);
        await update.download();
        if (!alive) return;
        staged.current = update;
        setState("ready");
      } catch {
        if (alive && !staged.current) setState("idle");
      } finally {
        busy.current = false;
      }
    };

    run();
    const t = setInterval(run, CHECK_INTERVAL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    state,
    version,
    restart: async () => {
      const update = staged.current;
      const { relaunch } = await import("@tauri-apps/plugin-process");
      if (!update) {
        // Nothing staged — the affordance shouldn't be up, but a plain restart
        // is the honest thing to do rather than pretending to install.
        await relaunch();
        return;
      }
      // Windows: launches the installer and exits this process, so nothing
      // below runs. macOS: swaps the bundle in place and comes back here.
      await update.install();
      await relaunch();
    },
  };
}
