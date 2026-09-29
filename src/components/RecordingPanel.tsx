import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { recording, type LocalRecording } from "../lib/ipc";

/** Finished capture stays accessible in the room; uploading is a separate action. */
export function RecordingPanel({ capture, onClose, onOpenManager }: { capture: LocalRecording; onClose: () => void; onOpenManager?: () => void }) {
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    closeButton.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [capture.id]);
  useEffect(() => {
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab") {
        const targets = panel.current?.querySelectorAll<HTMLElement>("button, video[controls]");
        if (!targets?.length) return;
        const first = targets[0], last = targets[targets.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [onClose]);
  const seconds = Math.floor(capture.duration_ms / 1000);
  return createPortal(<div className="recording-panel-layer">
    <button type="button" className="recording-panel-scrim" onClick={onClose} aria-label="Close recording" />
    <section ref={panel} className="recording-panel" role="dialog" aria-modal="true" aria-labelledby="recording-panel-title">
      <header><div><small>RECORDING SAVED</small><h2 id="recording-panel-title">{capture.room_name}</h2></div><button ref={closeButton} type="button" onClick={onClose} aria-label="Close recording">×</button></header>
      <video src={convertFileSrc(capture.path)} controls playsInline preload="metadata" />
      <footer><span>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")} · Local</span><button type="button" onClick={() => recording.reveal(capture.path)}>Show file</button>{onOpenManager && <button type="button" className="recording-panel-primary" onClick={onOpenManager}>View in Manager →</button>}</footer>
    </section>
  </div>, document.body);
}
