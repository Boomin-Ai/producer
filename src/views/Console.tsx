// ── The server's settings console, delivered at runtime ──────────────────────
// Producer is open source and bundles no Boomin UI. When the server it is
// signed into advertises a console (`server.console` on the session — Boomin
// does; a self-hosted server may not), this view loads that server's runtime
// script and mounts `@boomin/components/console` into a shadow root here.
// Brand settings, Payments (Stripe Connect, wallet, deal funding), members,
// API keys — all of it ships from the server, so a fix reaches every install
// without a Producer release.
//
// The keychain token never enters this webview: Rust mints a one-time
// handoff code (POST /v1/app/auth/handoff) and the console exchanges it for
// its own in-memory session. Hosted flows (Stripe onboarding, Checkout) open
// in the system browser; the console re-polls on focus.
import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ipc, type EndpointInfo } from "../lib/ipc";

const SUPPORTED_CONTRACT = 1;

type ConsoleHandle = { unmount(): void; navigate(section: string): void };
type ComponentsRuntime = {
  contract: number;
  mount(name: string, el: HTMLElement, opts: Record<string, unknown>): Promise<ConsoleHandle>;
};

declare global {
  interface Window {
    Boomin?: { components?: ComponentsRuntime };
  }
}

const runtimeLoads = new Map<string, Promise<ComponentsRuntime>>();

function loadRuntime(url: string): Promise<ComponentsRuntime> {
  const existing = window.Boomin?.components;
  if (existing) return Promise.resolve(existing);
  const pending = runtimeLoads.get(url);
  if (pending) return pending;
  const p = new Promise<ComponentsRuntime>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = url;
    s.async = true;
    s.onload = () => {
      const rt = window.Boomin?.components;
      if (rt) resolve(rt);
      else reject(new Error("The console runtime loaded but exposed nothing."));
    };
    s.onerror = () => {
      runtimeLoads.delete(url);
      reject(new Error(`Couldn't load the console runtime from ${url}.`));
    };
    document.head.appendChild(s);
  });
  runtimeLoads.set(url, p);
  return p;
}

type Status =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "unavailable"; message: string }
  | { kind: "error"; message: string; webOrigin: string | null };

export function ConsoleHost({ endpoint, section }: { endpoint: EndpointInfo | null; section: string }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<ConsoleHandle | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    handleRef.current = null;
    setStatus({ kind: "loading" });
    if (!endpoint) {
      setStatus({ kind: "unavailable", message: "Pick a workspace first." });
      return;
    }
    if (endpoint.kind !== "connected") {
      setStatus({ kind: "unavailable", message: "This workspace is self-hosted. Its settings live on your own server." });
      return;
    }
    let webOrigin: string | null = null;
    (async () => {
      try {
        const res = await ipc.consoleOpen(endpoint.id);
        if (cancelled) return;
        if (!res.console || !res.handoff || !res.brand_slug) {
          setStatus({ kind: "unavailable", message: "This server doesn't provide a settings console." });
          return;
        }
        webOrigin = new URL(res.console.console).origin;
        if (res.console.contract !== SUPPORTED_CONTRACT) {
          setStatus({ kind: "error", message: `This server's console needs a newer Producer (contract ${res.console.contract}).`, webOrigin });
          return;
        }
        const runtime = await loadRuntime(res.console.runtime);
        if (cancelled || !mountRef.current) return;
        const apiBase = new URL(endpoint.base_url).origin;
        const handle = await runtime.mount("console", mountRef.current, {
          handoff: res.handoff.code,
          brand: res.brand_slug,
          section,
          apiBase,
          theme: "dark",
          onExternal: (url: string) => {
            openUrl(url).catch(() => {});
          },
          onAuthExpired: () => setStatus({ kind: "error", message: "Your session expired. Reopen settings.", webOrigin }),
        });
        if (cancelled) {
          handle.unmount();
          return;
        }
        handleRef.current = handle;
        setStatus({ kind: "ready" });
      } catch (err) {
        if (cancelled) return;
        setStatus({ kind: "error", message: err instanceof Error ? err.message : String(err), webOrigin });
      }
    })();
    return () => {
      cancelled = true;
      handleRef.current?.unmount();
      handleRef.current = null;
    };
    // The section is steered via navigate() below; only the endpoint remounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint?.id, endpoint?.kind, endpoint?.base_url]);

  useEffect(() => {
    handleRef.current?.navigate(section);
  }, [section]);

  // The safety net: the same console as a web page, signed in with a fresh code.
  const openInBrowser = async () => {
    if (!endpoint || status.kind !== "error" || !status.webOrigin) return;
    try {
      const res = await ipc.consoleOpen(endpoint.id);
      if (!res.handoff || !res.brand_slug) return;
      const next = `/brand/${res.brand_slug}/settings/${section}`;
      await openUrl(`${status.webOrigin}/handoff?code=${encodeURIComponent(res.handoff.code)}&next=${encodeURIComponent(next)}`);
    } catch {
      /* the button stays; the user can retry */
    }
  };

  return (
    <div className="console-host">
      {status.kind !== "ready" && (
        <div className="console-host-state">
          {status.kind === "loading" && <span className="console-host-spin" />}
          {status.kind === "loading" && <p>Opening settings…</p>}
          {status.kind === "unavailable" && <p>{status.message}</p>}
          {status.kind === "error" && (
            <>
              <p>{status.message}</p>
              {status.webOrigin && (
                <button className="console-host-btn" onClick={() => void openInBrowser()}>
                  Open in browser
                </button>
              )}
            </>
          )}
        </div>
      )}
      <div ref={mountRef} className="console-host-mount" data-ready={status.kind === "ready" ? "1" : undefined} />
    </div>
  );
}
