import { useEffect, useRef, useState } from "react";
import { hasTauri } from "./ipc";

export type UpdateState = "idle" | "downloading" | "ready";

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** Quiet auto-update: check on launch and every few hours; download in the
 * background; surface only a "restart to update" affordance once staged.
 * Failures (offline, no manifest entry for this platform yet) stay silent —
 * the updater must never nag or block. */
export function useUpdater(): { state: UpdateState; version: string | null; restart: () => void } {
  const [state, setState] = useState<UpdateState>("idle");
  const [version, setVersion] = useState<string | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    if (!hasTauri()) return;
    let alive = true;

    const run = async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        const { check } = await import("@tauri-apps/plugin-updater");
        const update = await check();
        if (!alive || !update) return;
        setState("downloading");
        setVersion(update.version);
        await update.downloadAndInstall();
        if (alive) setState("ready");
      } catch {
        if (alive && state !== "ready") setState("idle");
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
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    },
  };
}
