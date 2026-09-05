// YOU — the pull-down from the top-right avatar. The same motion Settings
// uses coming out of the left rail, only downward: a glass surface that
// unrolls under the avatar, one open at a time.
//
// Sections: You (who is signed in, how, two-factor), Brand workspaces
// (Boomin — the active one lit, switch, the gear on a brand opens its
// settings), Self-hosted servers (host + Forget), "+ Add a workspace"
// (ALWAYS present: Boomin sign-in or your own server — a machine whose only
// workspace is its own server and is signed out of Boomin still gets the
// door), and Sign out. Brand settings only exist on a Boomin workspace; a
// self-hosted server's settings live on that server.
import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ipc, type EndpointInfo } from "../lib/ipc";
import { fetchMe, type Me } from "../lib/access";
import { isBoomin } from "../lib/workspace";
import { THIS_DEVICE } from "../lib/platform";

const gear = (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </svg>
);

export function AccountSheet({
  open,
  endpoints,
  activeId,
  onSwitch,
  onOpenConsole,
  onRemoveEndpoint,
  onAddWorkspace,
  onSignOut,
  onClose,
}: {
  open: boolean;
  endpoints: EndpointInfo[];
  activeId: string | null;
  onSwitch: (endpointId: string) => void;
  /** Brand settings — a Boomin thing (the runtime console). */
  onOpenConsole: (section: string, endpointId: string) => void;
  /** Self-hosted rows: forget this server on this machine. */
  onRemoveEndpoint: (endpointId: string) => void;
  /** The front door: Boomin sign-in OR your own server. */
  onAddWorkspace: () => void;
  onSignOut?: () => void;
  onClose: () => void;
}) {
  const active = endpoints.find((e) => e.id === activeId) ?? endpoints.find((e) => e.kind === "connected") ?? endpoints[0] ?? null;
  const boominEp = endpoints.find((e) => e.kind === "connected" && e.id === activeId) ?? endpoints.find((e) => e.kind === "connected") ?? null;
  const [me, setMe] = useState<Me | null | "err">(null);
  const [brands, setBrands] = useState<{ slug: string; name: string }[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (!boominEp) {
      setMe(null);
      setBrands([]);
      return;
    }
    let alive = true;
    fetchMe(boominEp.id)
      .then((m) => alive && setMe(m))
      .catch(() => alive && setMe("err"));
    ipc
      .boominListBrands(boominEp.id)
      .then((r) => alive && setBrands(r.brands ?? []))
      .catch(() => alive && setBrands(endpoints.filter((e) => e.brand_slug).map((e) => ({ slug: e.brand_slug!, name: e.name }))));
    return () => {
      alive = false;
    };
  }, [open, boominEp?.id, endpoints]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const pick = async (slug: string) => {
    const bound = endpoints.find((e) => e.brand_slug === slug);
    if (bound) {
      onSwitch(bound.id);
      return;
    }
    if (!boominEp) return;
    setBusy(slug);
    setNote(null);
    try {
      const r = await ipc.boominAddBrand(boominEp.id, slug);
      onSwitch(r.id);
    } catch (e) {
      setNote(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(null);
    }
  };

  /** Two-factor lives on boomin.ai — never a web console inside Producer.
   * The handoff signs the browser in with a one-time code. */
  const openAccountOnWeb = async () => {
    if (!boominEp) return;
    try {
      const res = await ipc.consoleOpen(boominEp.id);
      if (!res.console || !res.handoff || !res.brand_slug) throw new Error("no console");
      const origin = new URL(res.console.console).origin;
      const next = `/brand/${res.brand_slug}/settings/general`;
      await openUrl(`${origin}/handoff?code=${encodeURIComponent(res.handoff.code)}&next=${encodeURIComponent(next)}`);
    } catch {
      await openUrl("https://boomin.ai").catch(() => {});
    }
  };

  const independents = endpoints.filter((e) => !isBoomin(e));
  const rows = brands ?? [];
  const signInLabel = (m: Me) =>
    m.signInMethod ? m.signInMethod.replace(/^\w/, (c) => c.toUpperCase()) : "Email code";

  return (
    <>
      {open && <div className="acct-backdrop" onClick={onClose} />}
      <div className={`acct-sheet${open ? " open" : ""}`} role="menu" aria-hidden={!open}>
        <div className="acct-sheet-in">
          {/* ── You ── */}
          <div className="ws-pop-label">YOU</div>
          {boominEp ? (
            <div className="acct-you">
              <div className="acct-you-head">
                <span className="ws-ava">{((me !== null && me !== "err" ? (me.name ?? me.email)?.[0] : undefined) ?? active?.name?.[0] ?? "?").toUpperCase()}</span>
                <span className="ws-pop-txt">
                  <span className="ws-pop-name">{me !== null && me !== "err" ? me.name ?? me.email ?? "Signed in" : "Signed in to Boomin"}</span>
                  <span className="ws-pop-slug">{me !== null && me !== "err" ? me.email ?? "" : me === "err" ? "Couldn't reach Boomin" : "…"}</span>
                </span>
              </div>
              <div className="acct-row">
                <span className="acct-row-k">Sign-in</span>
                <span className="acct-row-v">{me !== null && me !== "err" ? signInLabel(me) : "—"}</span>
              </div>
              <div className="acct-row">
                <span className="acct-row-k">Two-factor</span>
                {me !== null && me !== "err" && me.twoFactor !== null ? (
                  <span className="acct-row-v">{me.twoFactor ? "On" : "Off"}</span>
                ) : (
                  <button className="acct-link" onClick={() => void openAccountOnWeb()} title="Opens boomin.ai in your browser">
                    Managed on boomin.ai ↗
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="acct-you">
              <div className="acct-row">
                <span className="acct-row-k">Boomin</span>
                <span className="acct-row-v">Not signed in</span>
              </div>
              <div className="cr-hint">Your own server needs no account. Sign in to Boomin for the Network, deals and a brand's rooms.</div>
            </div>
          )}

          {/* ── Brand workspaces (Boomin) ── */}
          {boominEp && (
            <>
              <div className="ws-pop-label">BRAND WORKSPACES</div>
              <div className="ws-pop-list">
                {brands === null && <div className="cr-hint">Loading…</div>}
                {rows.map((b) => {
                  const bound = endpoints.find((e) => e.brand_slug === b.slug);
                  const isCurrent = !!bound && bound.id === active?.id;
                  return (
                    <button key={b.slug} className={`ws-row${isCurrent ? " on" : ""}`} disabled={busy !== null} onClick={() => void pick(b.slug)}>
                      <span className="ws-ava sm">{(b.name?.[0] ?? "B").toUpperCase()}</span>
                      <span className="ws-pop-txt">
                        <span className="ws-pop-name">{b.name}</span>
                        <span className="ws-pop-slug">@{b.slug}{bound ? "" : ` · not on ${THIS_DEVICE}`}</span>
                      </span>
                      {isCurrent ? <i className="ws-dot" /> : busy === b.slug ? <span className="ws-pop-slug">…</span> : null}
                      {bound && (
                        <span
                          className="ws-gear"
                          role="button"
                          tabIndex={0}
                          title={`${b.name} settings`}
                          onClick={(e) => { e.stopPropagation(); onOpenConsole("general", bound.id); }}
                          onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); onOpenConsole("general", bound.id); } }}
                        >
                          {gear}
                        </span>
                      )}
                    </button>
                  );
                })}
                {brands !== null && rows.length === 0 && <div className="cr-hint">No brands on this account yet.</div>}
              </div>
            </>
          )}

          {/* ── Self-hosted servers ── */}
          {independents.length > 0 && (
            <>
              <div className="ws-pop-label">SELF-HOSTED SERVERS</div>
              <div className="ws-pop-list">
                {independents.map((e) => {
                  let host = e.base_url;
                  try {
                    host = new URL(e.base_url).host;
                  } catch {
                    /* keep the raw url */
                  }
                  return (
                    <button key={e.id} className={`ws-row${e.id === active?.id ? " on" : ""}`} onClick={() => onSwitch(e.id)}>
                      <span className="ws-ava sm">{(e.name[0] ?? "S").toUpperCase()}</span>
                      <span className="ws-pop-txt">
                        <span className="ws-pop-name">{e.name}</span>
                        <span className="ws-pop-slug">{host}</span>
                      </span>
                      {e.id === active?.id && <i className="ws-dot" />}
                      <span
                        className="ws-gear ws-drop"
                        role="button"
                        tabIndex={0}
                        title={`Forget ${e.name} on ${THIS_DEVICE}`}
                        onClick={(ev) => { ev.stopPropagation(); onRemoveEndpoint(e.id); }}
                        onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); ev.stopPropagation(); onRemoveEndpoint(e.id); } }}
                      >
                        Forget
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {note && <div className="cr-hint">{note}</div>}

          {/* ── Always: the door ── */}
          <div className="ws-pop-foot">
            <button className="ws-row acct-add" onClick={() => { onClose(); onAddWorkspace(); }}>
              <span className="ws-ava sm acct-plus">+</span>
              <span className="ws-pop-txt">
                <span className="ws-pop-name">Add a workspace</span>
                <span className="ws-pop-slug">Sign in to Boomin, or use your own server</span>
              </span>
            </button>
            {onSignOut && boominEp && (
              <button className="ws-row ws-signout" onClick={() => { onClose(); onSignOut(); }}>
                <span className="ws-pop-name">Sign out</span>
                <span className="ws-pop-slug">of Boomin on {THIS_DEVICE}</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
