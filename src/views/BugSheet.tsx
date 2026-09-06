// "Report a bug" — the sheet behind the footer's quiet button.
//
// Three commitments shape this file:
//
//  1. NOTHING TYPED IS EVER LOST. A failed send does not close the sheet, does
//     not clear the textarea, and offers two ways out that carry the same text:
//     "Open GitHub" (prefilled) and "Copy report". The user is never left
//     holding a paragraph they now have to retype.
//  2. THE PREVIEW IS THE PAYLOAD. "Attach diagnostics" opens onto the literal
//     object that will be posted — `buildReport` is called once and its result
//     is both what is shown and what is sent, so the two cannot drift.
//  3. ANYONE CAN FILE ONE. On a Boomin workspace the report goes through the
//     authenticated door and carries the brand. On a self-hosted workspace or
//     signed out it goes to the SAME Boomin route unauthenticated — the API is
//     auth-optional precisely so this path exists.

import { useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { guests, uiDiagnostics } from "../lib/ipc";
import { isBoomin, resolveActiveEndpoint } from "../lib/workspace";
import { copyText } from "../lib/roomLink";
import { notify } from "../lib/notices";
import { IS_MAC, IS_WINDOWS } from "../lib/platform";
import { buildReport, githubIssueUrl, reportToText, type BugReport } from "../lib/bugReport";

/** Where an unauthenticated report goes. Mirrors the Rust
 *  `DEFAULT_BOOMIN_API_ROOT`; a self-hosted server has no such route. */
const BOOMIN_API = "https://api.boomin.ai";
const REPORT_PATH = "/v1/app/support/report";

export interface BugSheetProps {
  open: boolean;
  onClose: () => void;
  version: string | null;
  engine?: string | null;
  encoder?: string | null;
  /** Room shape, when the sheet is opened from inside a room. */
  scenes?: number | null;
  sources?: number | null;
}

type Phase = { k: "edit" } | { k: "sending" } | { k: "failed"; error: string };

/** The GPU, as the webview names it — "Apple M2 Pro", "ANGLE (NVIDIA GeForce
 *  RTX 3070 …)". A throwaway WebGL context is the only place this string exists
 *  without a native call, and for a video app it is worth one: half of what
 *  goes wrong here is the encoder and the card under it. Undefined when the
 *  browser withholds the extension — a missing field, never a guess. */
function gpuName(): string | undefined {
  try {
    const canvas = document.createElement("canvas");
    const gl = (canvas.getContext("webgl") ?? canvas.getContext("experimental-webgl")) as WebGLRenderingContext | null;
    if (!gl) return undefined;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const raw = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
    return typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 128) : undefined;
  } catch {
    return undefined;
  }
}

/** Last-resort OS/arch when the host command is unavailable (engine-less
 *  build). Deliberately says "unknown" for a Mac's arch rather than repeating
 *  WKWebView's confident lie that every Mac is an Intel one. */
function navigatorFallback(): { os: string; arch: string } {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const os = IS_MAC ? "macos" : IS_WINDOWS ? "windows" : "unknown";
  const arch = /ARM64|aarch64/i.test(ua) ? "aarch64" : IS_WINDOWS && /Win64|x64|WOW64/i.test(ua) ? "x86_64" : "unknown";
  return { os, arch };
}

export function BugSheet({ open, onClose, version, engine, encoder, scenes, sources }: BugSheetProps) {
  const [text, setText] = useState("");
  const [contact, setContact] = useState("");
  const [attach, setAttach] = useState(true);
  const [showWhat, setShowWhat] = useState(false);
  const [phase, setPhase] = useState<Phase>({ k: "edit" });
  const [host, setHost] = useState<{ log: string; os: string; arch: string } | null>(null);
  const [gpu, setGpu] = useState<string | undefined>(undefined);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  // Resolved as a PROMISE, not state: Send must never race the lookup and post
  // anonymously from a workspace that had a perfectly good session.
  const boominRef = useRef<Promise<string | null> | null>(null);

  // The log tail is read when the sheet OPENS, not when Send is pressed: the
  // last lines before the user noticed something is the interesting window, and
  // by the time they finish typing a paragraph it has scrolled away.
  useEffect(() => {
    if (!open) return;
    let live = true;
    boominRef.current = resolveActiveEndpoint()
      .then((ep) => (isBoomin(ep) && ep ? ep.id : null))
      .catch(() => null);
    setGpu(gpuName());
    uiDiagnostics()
      .then((d) => live && setHost(d))
      .catch(() => live && setHost({ log: "", ...navigatorFallback() }));
    const t = window.setTimeout(() => areaRef.current?.focus(), 120);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [open]);

  // Esc closes — but never mid-send, which would strand the request with no
  // surface to report back to.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && phase.k !== "sending") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, phase.k, onClose]);

  const fallback = navigatorFallback();
  // ONE report object: previewed below, posted on Send, copied on failure.
  const report: BugReport = useMemo(
    () =>
      buildReport({
        text,
        attachDiagnostics: attach,
        contact,
        version,
        os: host?.os || fallback.os,
        arch: host?.arch || fallback.arch,
        engine,
        encoder,
        gpu,
        scenes,
        sources,
        log: host?.log,
      }),
    [text, attach, contact, version, host, engine, encoder, gpu, scenes, sources, fallback.os, fallback.arch],
  );

  const canSend = text.trim().length > 0 && phase.k !== "sending";

  const send = async () => {
    if (!canSend) return;
    setPhase({ k: "sending" });
    try {
      const boominEndpointId = await (boominRef.current ?? Promise.resolve(null));
      let body: Record<string, unknown>;
      if (boominEndpointId) {
        // The authenticated door (v0.4.32's `endpoint_request`): the report
        // carries who filed it and which brand they were in.
        const r = await guests.request(boominEndpointId, "POST", REPORT_PATH, report);
        if (!r.available) throw new Error("This server has no bug-report route.");
        body = (r.body ?? {}) as Record<string, unknown>;
      } else {
        // Self-hosted or signed out: the SAME Boomin route, unauthenticated.
        const res = await fetch(BOOMIN_API + REPORT_PATH, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(report),
        });
        body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) {
          throw new Error(
            res.status === 429
              ? "Too many reports in the last hour. Try again shortly."
              : typeof body.message === "string"
                ? body.message
                : `The server answered ${res.status}.`,
          );
        }
      }
      const n = typeof body.issue_number === "number" ? body.issue_number : null;
      if (n !== null) {
        // The number, and nothing else. Filing a bug must not throw the user out
        // of the app they were using into a browser — they were mid-show, and a
        // GitHub tab is our business, not theirs.
        notify(`Filed as #${n}`, { tone: "success", check: true, ttl: 9000 });
      } else {
        notify("Sent — thank you", { tone: "success", check: true });
      }
      // Only a success clears the sheet.
      setText("");
      setContact("");
      setPhase({ k: "edit" });
      onClose();
    } catch (e) {
      setPhase({ k: "failed", error: e instanceof Error ? e.message : String(e) });
    }
  };

  const copy = async () => {
    const ok = await copyText(reportToText(report));
    // A failed copy must not wear the success tone — the whole point of this
    // button is that the user can trust they now have their words somewhere.
    notify(ok ? "Report copied" : "Couldn't copy — select the text and copy it by hand", {
      tone: ok ? "success" : "warning",
      check: ok,
    });
  };

  return (
    <>
      {open && <div className="acct-backdrop" onClick={phase.k === "sending" ? undefined : onClose} />}
      <div className={`acct-sheet bug-sheet${open ? " open" : ""}`} role="dialog" aria-label="Report a bug" aria-hidden={!open}>
        <div className="acct-sheet-in">
          <div className="acc-confirm-title">Report a bug</div>
          <div className="cr-hint bug-lede">
            Goes straight to the people who build Producer. You don't need an account — a self-hosted or signed-out report
            reaches us just the same.
          </div>

          <textarea
            ref={areaRef}
            className="bug-text"
            placeholder="What happened?"
            value={text}
            maxLength={4000}
            onChange={(e) => setText(e.target.value)}
            // ⌘/Ctrl+Enter sends: the muscle memory for a box like this one.
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
            }}
          />

          <label className="bug-check">
            <input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} />
            <span>Attach diagnostics</span>
            <button
              type="button"
              className="acct-link bug-what"
              onClick={() => setShowWhat((v) => !v)}
              aria-expanded={showWhat}
              disabled={!attach}
            >
              {showWhat ? "Hide" : "What's sent?"}
            </button>
          </label>
          {attach && showWhat && (
            // Not a description of the payload — the payload.
            <pre className="bug-preview">{JSON.stringify(report.diagnostics ?? {}, null, 2)}</pre>
          )}

          <input
            className="bug-contact"
            type="email"
            placeholder="Email (optional) — so we can reply"
            value={contact}
            onChange={(e) => setContact(e.target.value)}
          />

          {phase.k === "failed" && (
            <div className="bug-failed">
              <div className="acc-confirm-err">Couldn't send: {phase.error}</div>
              <div className="cr-hint">Nothing you typed is lost. Send it yourself, or copy it and try later.</div>
              <div className="bug-failed-actions">
                <button className="cr-ghost" onClick={() => void openUrl(githubIssueUrl(report)).catch(() => {})}>
                  Open GitHub ↗
                </button>
                <button className="cr-ghost" onClick={() => void copy()}>
                  Copy report
                </button>
              </div>
            </div>
          )}

          <div className="acc-confirm-actions">
            <button className="cr-ghost" onClick={onClose} disabled={phase.k === "sending"}>
              Cancel
            </button>
            <button className="cr-ghost acc-primary" onClick={() => void send()} disabled={!canSend}>
              {phase.k === "sending" ? "Sending…" : phase.k === "failed" ? "Try again" : "Send"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
