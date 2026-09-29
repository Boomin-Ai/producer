import { useEffect, useRef, useState } from "react";
import { guests } from "../lib/ipc";

export function PullPostsButton({ endpointId, channelId }: { endpointId: string; channelId: string }) {
  const [pulling, setPulling] = useState(false);
  const [starting, setStarting] = useState(false);
  const startLock = useRef(false);
  const [message, setMessage] = useState<string | null>(null);
  const changed = () => window.dispatchEvent(new CustomEvent("producer:cache-change", { detail: { endpointId } }));
  async function pull() {
    if (pulling || startLock.current) return;
    startLock.current = true; setStarting(true); setMessage(null);
    try {
      const response = await guests.request(endpointId, "POST", `/v1/app/integrations/${encodeURIComponent(channelId)}/sync`);
      if (!response.available || response.status >= 300) throw new Error(`Couldn’t start pull (HTTP ${response.status}).`);
      changed();
      setPulling(true);
    } catch (error) { setMessage(String(error)); setPulling(false); }
    finally { startLock.current = false; setStarting(false); }
  }
  useEffect(() => {
    if (!pulling) return;
    let alive = true, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await guests.request(endpointId, "GET", `/v1/app/integrations/${encodeURIComponent(channelId)}/sync-status`);
        if (!response.available || response.status >= 300) throw new Error(`Couldn’t check pull (HTTP ${response.status}).`);
        if (!alive) return;
        const status = response.body as { active_jobs?: number; archive_failed_jobs?: number; status?: string };
        changed();
        if (status.active_jobs === 0) {
          setPulling(false); setMessage(status.archive_failed_jobs ? "Some media could not be archived. Pull again to retry." : status.status === "failed" ? "Pull finished with sync errors. Pull again to retry." : "Pull complete."); return;
        }
      } catch (error) { if (!alive) return; setMessage(String(error)); }
      if (alive) timer = setTimeout(() => void poll(), 4000);
    };
    timer = setTimeout(() => void poll(), 4000);
    return () => { alive = false; clearTimeout(timer); };
  }, [pulling, endpointId, channelId]);
  return <><button className="chan-pull" type="button" disabled={pulling || starting} onClick={() => void pull()}>{pulling || starting ? "Pulling…" : "Pull posts"}</button>{message && <span className="cr-chip-kind" role="status">{message}</span>}</>;
}
