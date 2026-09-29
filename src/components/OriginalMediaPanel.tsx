import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { guests, ipc } from "../lib/ipc";
import type { SocialPost } from "../features/manager/contracts";

/** Restore a missing local original without creating a new publication. */
export function OriginalMediaPanel({ endpointId, post, onRestored }: { endpointId: string; post: SocialPost; onRestored?: () => void | Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const alive = useRef(true);
  const uploaded = useRef<string | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function restore() {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(null);
    try {
      if (!uploaded.current) {
        const path = await open({ multiple: false, filters: [{ name: "Original media", extensions: post.type.includes("video") ? ["mp4", "mov", "webm"] : ["jpg", "jpeg", "png", "webp", "gif"] }] });
        if (typeof path !== "string" || !alive.current) return;
        const upload = await ipc.uploadMedia(endpointId, path);
        if (upload.endpoint_id !== endpointId) throw new Error("Upload belongs to another workspace.");
        uploaded.current = upload.upload_id;
      }
      if (!alive.current) return;
      const response = await guests.request(endpointId, "POST", `/v1/app/content/social-posts/${encodeURIComponent(post.id)}/original`, { file_id: uploaded.current });
      if (!response.available || response.status >= 300) throw new Error(`Couldn’t attach the original (HTTP ${response.status}).`);
      // Notify the active view as well as the inactive cache sessions.
      if (alive.current) await onRestored?.();
    } catch (cause) { if (alive.current) setError(String(cause)); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  return <div className="pm-original-media" role="status">
    <p>Original media unavailable from Instagram.</p>
    <small>{post.previewUrl ? "The saved thumbnail and post insights are available." : "The post and its insights are available."}</small>
    {post.type !== "carousel" && <button type="button" disabled={busy} onClick={() => void restore()}>{busy ? "Adding original…" : "Add original"}</button>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
