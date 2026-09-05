// SETTINGS → ACCESS. Who may do what on this workspace's server, in that
// server's own nouns (docs/CONTRIBUTIONS.md):
//
//   Boomin       → TEAM. One row per member (type · role pills, Manage);
//                  the row expands to the member's surface chips, room roles
//                  (host · manager · mod · viewer through the room-access
//                  door) and the channel control (the `channels` surface
//                  grant, the API's only such control today). Invite at the
//                  bottom. Nothing applies on click: changes are STAGED,
//                  "Review changes" opens a confirm sheet in plain words, and
//                  Confirm applies them in order with per-item progress.
//   Self-hosted  → MODS. A mod is a capability the host hands out: mint a
//                  mod link for a room, see the active seats, revoke one;
//                  and the guest door — enable / rotate / auto-admit.
//
// Same glass list pattern as App / Integrations. Native, never a web console.
import { useCallback, useEffect, useState } from "react";
import { ipc, listServerRooms, type EndpointInfo, type LiveRoom } from "../lib/ipc";
import { WORKSPACE_EVENT, isBoomin } from "../lib/workspace";
import { parseConfig } from "../lib/room";
import { ROOMS_EVENT, isRetired, syncRooms } from "../lib/roomSync";
import { copyText } from "../lib/roomLink";
import { CHANNEL_CONTROL_SURFACE, ROOM_ROLES, SURFACES, guestDoor, mods, team, type Member, type ModSeatRow } from "../lib/access";
import { changeSentence, heldSeat, heldSurfaces, planChanges, seatLabel, type AccessOp, type Desired, type SeatRole } from "../lib/accessDiff";

function Switch({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} disabled={disabled} className={`switch${on ? " on" : ""}`} onClick={() => onChange(!on)}>
      <span className="knob" />
    </button>
  );
}

const errText = (e: unknown) => String(e).replace(/^Error:\s*/, "");

type AccessRoom = { id: string | null; sid: string; name: string };

/** Rooms this workspace has on its server — the only ones a role can be
 * granted on. The SERVER list is the truth (web, deals and other machines
 * mint rooms too); the local rows lend their names to rooms the server
 * lists without a title (Producer-registered ones) and their config to the
 * guest-door controls. Reconciles through the same `syncRooms` Home uses
 * — so a room just created at Home registers and appears here at once —
 * then re-reads on focus, on ROOMS_EVENT and on a workspace switch. */
function useServerRooms(endpoint: EndpointInfo): { rooms: AccessRoom[]; local: LiveRoom[] } {
  const [rooms, setRooms] = useState<AccessRoom[]>([]);
  const [local, setLocal] = useState<LiveRoom[]>([]);
  const epId = endpoint.id;
  const refresh = useCallback(async () => {
    await syncRooms(epId).catch(() => null);
    let mine: LiveRoom[] = [];
    try {
      mine = (await ipc.liveListRooms(epId)).filter((r) => !r.endpoint_id || r.endpoint_id === epId);
    } catch {
      /* engine-less build */
    }
    setLocal(mine);
    const bySid = new Map<string, LiveRoom>();
    for (const r of mine) {
      const sid = parseConfig(r.config).server_room_id;
      if (sid) bySid.set(sid, r);
    }
    try {
      const server = (await listServerRooms(epId)).rooms ?? [];
      setRooms(
        server
          .filter((r) => !isRetired(r))
          .map((r) => {
            const loc = bySid.get(r.id);
            return { id: loc?.id ?? null, sid: r.id, name: (r.title ?? "").trim() || loc?.name || "Room" };
          }),
      );
    } catch {
      // Offline: the local rows that carry a server id are the best we know.
      setRooms([...bySid.entries()].map(([sid, r]) => ({ id: r.id, sid, name: r.name })));
    }
  }, [epId]);
  useEffect(() => {
    void refresh();
    const h = () => void refresh();
    window.addEventListener("focus", h);
    window.addEventListener(ROOMS_EVENT, h);
    window.addEventListener(WORKSPACE_EVENT, h);
    return () => {
      window.removeEventListener("focus", h);
      window.removeEventListener(ROOMS_EVENT, h);
      window.removeEventListener(WORKSPACE_EVENT, h);
    };
  }, [refresh]);
  return { rooms, local };
}

export function AccessPanel({ endpoint }: { endpoint: EndpointInfo | null }) {
  if (!endpoint) return <div className="set-soon">Pick a workspace first.</div>;
  return isBoomin(endpoint) ? <TeamAccess endpoint={endpoint} /> : <ModsAccess endpoint={endpoint} />;
}

// ── Confirm panel: every change here is staged, then confirmed ───────────────

export interface ConfirmItem {
  key: string;
  /** Plain words: what happens if this runs. */
  text: string;
  run: () => Promise<unknown>;
}

type ItemState = "wait" | "busy" | "ok" | { error: string };

/** The glass sheet that lists what will happen, runs it in order on Confirm
 * with per-item progress, and hands back on Done. Same motion as the
 * account sheet (pull-down glass). */
function ConfirmSheet({
  title,
  summary,
  items,
  onCancel,
  onDone,
}: {
  title: string;
  /** Plain-word sentences shown above the call list, one per member. */
  summary?: string[];
  items: ConfirmItem[];
  onCancel: () => void;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<"review" | "running" | "done">("review");
  const [states, setStates] = useState<Record<string, ItemState>>({});
  useEffect(() => {
    const t = window.setTimeout(() => setOpen(true), 10);
    return () => window.clearTimeout(t);
  }, []);

  const confirm = async () => {
    setPhase("running");
    for (const it of items) {
      setStates((s) => ({ ...s, [it.key]: "busy" }));
      try {
        await it.run();
        setStates((s) => ({ ...s, [it.key]: "ok" }));
      } catch (e) {
        setStates((s) => ({ ...s, [it.key]: { error: errText(e) } }));
      }
    }
    setPhase("done");
  };
  const failed = Object.values(states).filter((s) => typeof s === "object").length;

  return (
    <>
      <div className="acct-backdrop" onClick={phase === "running" ? undefined : phase === "done" ? onDone : onCancel} />
      <div className={`acct-sheet acc-confirm${open ? " open" : ""}`} role="dialog" aria-label={title}>
        <div className="acct-sheet-in">
          <div className="acc-confirm-title">{title}</div>
          {summary && summary.length > 0 && (
            <div className="acc-confirm-summary">
              {summary.map((t, i) => (
                <div key={i}>{t}</div>
              ))}
            </div>
          )}
          <div className="acc-confirm-list">
            {items.map((it) => {
              const st = states[it.key] ?? "wait";
              return (
                <div key={it.key} className={`acc-confirm-item${st === "ok" ? " ok" : typeof st === "object" ? " fail" : ""}`}>
                  <span className="acc-confirm-dot">{st === "ok" ? "✓" : typeof st === "object" ? "✕" : st === "busy" ? "…" : "·"}</span>
                  <span className="acc-confirm-text">
                    {it.text}
                    {typeof st === "object" && <span className="acc-confirm-err">{st.error}</span>}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="acc-confirm-actions">
            {phase === "review" && (
              <>
                <button className="cr-ghost" onClick={onCancel}>Cancel</button>
                <button className="cr-ghost acc-primary" onClick={() => void confirm()}>Confirm</button>
              </>
            )}
            {phase === "running" && <span className="cr-sheet-row-sub">Applying…</span>}
            {phase === "done" && (
              <>
                {failed > 0 && <span className="cr-hint acc-err">{failed} of {items.length} failed</span>}
                <button className="cr-ghost acc-primary" onClick={onDone}>Done</button>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

// ── Boomin: Team ──────────────────────────────────────────────────────────────

const isTeam = (m: Member) => m.type === "team" || m.role === "owner" || m.role === "admin";
const hostsEverywhere = (m: Member) => m.role === "owner" || m.role === "admin" || m.role === "editor";

function TeamAccess({ endpoint }: { endpoint: EndpointInfo }) {
  const [brandId, setBrandId] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  /** Staged state per member — only members that were touched have an entry. */
  const [staged, setStaged] = useState<Record<string, Desired>>({});
  const [review, setReview] = useState(false);
  const { rooms: srvRooms } = useServerRooms(endpoint);

  const load = useCallback(async () => {
    try {
      const id = brandId ?? (await team.brandId(endpoint.id));
      if (!id) throw new Error("This workspace has no brand.");
      setBrandId(id);
      setMembers(await team.members(endpoint.id, id));
      setErr(null);
    } catch (e) {
      setErr(errText(e));
      setMembers((m) => m ?? []);
    }
  }, [endpoint.id, brandId]);
  useEffect(() => {
    void load();
  }, [load]);

  const desiredFor = (m: Member): Desired =>
    staged[m.id] ?? { surfaces: heldSurfaces(m), rooms: Object.fromEntries(srvRooms.map((r) => [r.sid, heldSeat(m, r.sid).role ?? ""])) };

  const stage = (m: Member, fn: (d: Desired) => Desired) => setStaged((s) => ({ ...s, [m.id]: fn(desiredFor(m)) }));
  const toggleSurface = (m: Member, key: string) =>
    stage(m, (d) => {
      const surfaces = new Set(d.surfaces);
      if (surfaces.has(key)) surfaces.delete(key);
      else surfaces.add(key);
      return { ...d, surfaces };
    });
  const setSeat = (m: Member, sid: string, role: SeatRole | "") => stage(m, (d) => ({ ...d, rooms: { ...d.rooms, [sid]: role } }));

  const changes = planChanges(members ?? [], staged, srvRooms);
  const pendingCount = changes.reduce((n, c) => n + c.ops.length, 0);

  const runOp = (op: AccessOp) => {
    if (!brandId) return Promise.reject(new Error("no brand"));
    switch (op.kind) {
      case "surface.grant":
        return team.grantSurface(endpoint.id, brandId, op.memberId, op.surfaceKey);
      case "surface.revoke":
        return team.revokeGrant(endpoint.id, brandId, op.memberId, op.grantId);
      case "room.grant":
        return team.setRoomRole(endpoint.id, op.roomId, op.memberId, op.grant);
      case "room.revoke":
        return team.clearRoomRole(endpoint.id, op.roomId, op.grantId);
    }
  };
  const confirmItems: ConfirmItem[] = changes.flatMap((c) =>
    c.ops.map((op, i) => ({ key: `${c.memberId}:${i}`, text: `${c.who} — ${op.label}`, run: () => runOp(op) })),
  );

  return (
    <>
      {err && <div className="cr-hint acc-err">{err}</div>}

      <div className="cr-label set-gap">TEAM</div>
      <div className="set-list acc-list">
        {members === null && <div className="cr-sheet-row-sub">Loading members…</div>}
        {members?.length === 0 && !err && <div className="cr-sheet-row-sub">Only you, so far.</div>}
        {members?.map((m) => {
          const open = expanded === m.id;
          const change = changes.find((c) => c.memberId === m.id) ?? null;
          const d = desiredFor(m);
          const held = heldSurfaces(m);
          return (
            <div key={m.id} className={`acc-member${open ? " open" : ""}${change ? " dirty" : ""}`}>
              <div className="acc-member-head">
                <span className="ws-ava sm">{((m.name ?? m.email)[0] ?? "?").toUpperCase()}</span>
                <span className="ws-pop-txt">
                  <span className="ws-pop-name">{m.name ?? m.email}</span>
                  <span className="ws-pop-slug">{m.email}</span>
                </span>
                <button type="button" className="acc-pills" onClick={() => setExpanded(open ? null : m.id)} title={open ? "Collapse" : "Manage access"}>
                  <span className="acc-chip acc-type">{m.type}</span>
                  <span className="acc-chip acc-role">{m.role}</span>
                  {change && <span className="acc-chip acc-pending">{change.ops.length} pending</span>}
                </button>
                <button type="button" className="acc-manage" onClick={() => setExpanded(open ? null : m.id)}>
                  {open ? "Close" : "Manage"}
                </button>
              </div>
              {open && (
                <div className="acc-member-body">
                  {isTeam(m) ? (
                    <div className="acc-member-sub">Team member — every surface, hosts every room.</div>
                  ) : (
                    <>
                      <div className="acc-body-label">Surfaces</div>
                      <div className="acc-surfaces">
                        {SURFACES.map((sf) => {
                          const on = d.surfaces.has(sf.key);
                          const was = held.has(sf.key);
                          const diff = on !== was ? (on ? " added" : " removed") : "";
                          return (
                            <button
                              type="button"
                              key={sf.key}
                              className={`acc-chip acc-toggle${on ? " on" : ""}${diff}`}
                              title={on ? `Stage removing ${sf.label}` : `Stage granting ${sf.label}`}
                              onClick={() => toggleSurface(m, sf.key)}
                            >
                              {sf.label}
                            </button>
                          );
                        })}
                      </div>
                      {!hostsEverywhere(m) && (
                        <>
                          <div className="acc-body-label">Room roles</div>
                          {srvRooms.length === 0 && <div className="cr-sheet-row-sub">No rooms on the server yet — open a room once and it registers.</div>}
                          {srvRooms.map((r) => {
                            const cur = heldSeat(m, r.sid).role ?? "";
                            const want = d.rooms[r.sid] ?? cur;
                            return (
                              <div key={r.sid} className={`cr-sheet-row acc-room-row${want !== cur ? " dirty" : ""}`}>
                                <span className="cr-sheet-row-name">{r.name}</span>
                                {want !== cur && (
                                  <span className="cr-sheet-row-sub acc-was">
                                    <s>{cur ? seatLabel(cur) : "No seat"}</s>
                                  </span>
                                )}
                                <select className="acc-select" value={want} onChange={(e) => setSeat(m, r.sid, e.target.value as SeatRole | "")}>
                                  <option value="">No seat</option>
                                  {ROOM_ROLES.filter((x) => x.grant).map((x) => (
                                    <option key={x.role} value={x.role}>{x.label}</option>
                                  ))}
                                </select>
                              </div>
                            );
                          })}
                        </>
                      )}
                      <div className="acc-body-label">Channel controls</div>
                      <div className={`cr-sheet-row${d.surfaces.has(CHANNEL_CONTROL_SURFACE) !== held.has(CHANNEL_CONTROL_SURFACE) ? " dirty" : ""}`}>
                        <span className="cr-sheet-row-name">May connect and disconnect channels</span>
                        <span className="cr-sheet-row-sub">{d.surfaces.has(CHANNEL_CONTROL_SURFACE) ? "channels grant" : "no grant"}</span>
                        <Switch on={d.surfaces.has(CHANNEL_CONTROL_SURFACE)} onChange={() => toggleSurface(m, CHANNEL_CONTROL_SURFACE)} />
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {pendingCount > 0 && (
        <div className="acc-review-bar">
          <span className="cr-sheet-row-sub">
            {pendingCount} staged change{pendingCount === 1 ? "" : "s"} — nothing applied yet.
          </span>
          <button className="cr-ghost" onClick={() => setStaged({})}>Discard</button>
          <button className="cr-ghost acc-primary" onClick={() => setReview(true)}>Review changes</button>
        </div>
      )}

      {review && (
        <ConfirmSheet
          title="Review changes"
          summary={changes.map(changeSentence)}
          items={confirmItems}
          onCancel={() => setReview(false)}
          onDone={() => {
            setReview(false);
            setStaged({});
            void load();
          }}
        />
      )}

      <div className="cr-label set-gap">INVITE</div>
      <div className="set-list acc-list">
        <InviteForm endpoint={endpoint} brandId={brandId} rooms={srvRooms} onSent={() => void load()} />
      </div>
    </>
  );
}

function InviteForm({
  endpoint,
  brandId,
  rooms,
  onSent,
}: {
  endpoint: EndpointInfo;
  brandId: string | null;
  rooms: { sid: string; name: string }[];
  onSent: () => void;
}) {
  const [email, setEmail] = useState("");
  const [type, setType] = useState<"team" | "collaborator">("collaborator");
  const [role, setRole] = useState<"admin" | "editor" | "viewer">("viewer");
  const [roomSid, setRoomSid] = useState("");
  const [roomRole, setRoomRole] = useState<"admin" | "editor" | "viewer">("editor");
  const [surfaces, setSurfaces] = useState<Set<string>>(() => new Set(["live"]));
  const [state, setState] = useState<"idle" | "busy" | "sent" | string>("idle");

  const send = async () => {
    if (!brandId || !email.trim()) return;
    setState("busy");
    try {
      await team.invite(endpoint.id, brandId, {
        email: email.trim(),
        type,
        role,
        surfaces: type === "collaborator" ? [...surfaces] : [],
        room: type === "collaborator" && roomSid ? { id: roomSid, grant: roomRole } : undefined,
      });
      setState("sent");
      setEmail("");
      onSent();
      window.setTimeout(() => setState("idle"), 2500);
    } catch (e) {
      setState(errText(e));
    }
  };

  return (
    <form
      className="acc-invite"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <div className="acc-invite-row">
        <input type="email" required placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <select value={type} onChange={(e) => setType(e.target.value as "team" | "collaborator")} className="acc-select">
          <option value="collaborator">Collaborator</option>
          <option value="team">Team</option>
        </select>
        <select value={role} onChange={(e) => setRole(e.target.value as "admin" | "editor" | "viewer")} className="acc-select">
          <option value="viewer">Viewer</option>
          <option value="editor">Editor</option>
          <option value="admin">Admin</option>
        </select>
      </div>
      {type === "collaborator" && (
        <>
          <div className="acc-surfaces">
            {SURFACES.map((sf) => (
              <button
                type="button"
                key={sf.key}
                className={`acc-chip acc-toggle${surfaces.has(sf.key) ? " on" : ""}`}
                onClick={() =>
                  setSurfaces((s) => {
                    const n = new Set(s);
                    if (n.has(sf.key)) n.delete(sf.key);
                    else n.add(sf.key);
                    return n;
                  })
                }
              >
                {sf.label}
              </button>
            ))}
          </div>
          {rooms.length > 0 && (
            <div className="acc-invite-row">
              <span className="cr-sheet-row-sub">Room seat</span>
              <select value={roomSid} onChange={(e) => setRoomSid(e.target.value)} className="acc-select">
                <option value="">None</option>
                {rooms.map((r) => (
                  <option key={r.sid} value={r.sid}>{r.name}</option>
                ))}
              </select>
              <select value={roomRole} disabled={!roomSid} onChange={(e) => setRoomRole(e.target.value as "admin" | "editor" | "viewer")} className="acc-select">
                <option value="admin">Manager</option>
                <option value="editor">Mod</option>
                <option value="viewer">Viewer</option>
              </select>
            </div>
          )}
        </>
      )}
      <div className="acc-invite-row">
        <button type="submit" className="cr-ghost" disabled={state === "busy" || !brandId || !email.trim()}>
          {state === "busy" ? "Sending…" : state === "sent" ? "Sent" : "Send invite"}
        </button>
        {state !== "idle" && state !== "busy" && state !== "sent" && <span className="cr-hint acc-err">{state}</span>}
      </div>
    </form>
  );
}

// ── Self-hosted: Mods ─────────────────────────────────────────────────────────

function ModsAccess({ endpoint }: { endpoint: EndpointInfo }) {
  const { rooms: srvRooms, local } = useServerRooms(endpoint);
  return (
    <>
      <div className="cr-sheet-row-sub acc-note">
        Your server has no accounts. A mod is a capability you hand out: a link another Producer opens to admit, stage, order, remove and cut scenes — never on the set. Revoke the seat and the link dies at its next exchange.
      </div>
      {srvRooms.length === 0 && (
        <div className="set-list acc-list">
          <div className="cr-sheet-row-sub">No rooms on the server yet — open a room once and it registers.</div>
        </div>
      )}
      {srvRooms.map((r) => (
        <RoomMods key={r.sid} endpoint={endpoint} room={r} local={local.find((x) => x.id === r.id) ?? null} />
      ))}
    </>
  );
}

function RoomMods({ endpoint, room, local }: { endpoint: EndpointInfo; room: { sid: string; name: string }; local: LiveRoom | null }) {
  const [seats, setSeats] = useState<ModSeatRow[] | null | "none">(null);
  const [minted, setMinted] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** One-item confirmations: what the sheet will do when confirmed. */
  const [confirm, setConfirm] = useState<ConfirmItem | null>(null);
  const cfg = local ? parseConfig(local.config) : null;
  const [door, setDoor] = useState<{ enabled: boolean; auto_admit: boolean | null; join_url: string | null }>({
    enabled: !!cfg?.guest_link,
    auto_admit: null,
    join_url: cfg?.guest_link ?? null,
  });

  const load = useCallback(async () => {
    try {
      const list = await mods.list(endpoint.id, room.sid);
      setSeats(list === null ? "none" : list);
      setErr(null);
    } catch (e) {
      setErr(errText(e));
      setSeats((s) => (s === null ? [] : s));
    }
  }, [endpoint.id, room.sid]);
  useEffect(() => {
    void load();
  }, [load]);

  const mint = async () => {
    const r = await mods.mint(endpoint.id, room.sid, null);
    setMinted(r.mod_url);
    setCopied(false);
    await load();
  };
  const revoke = async (id: string) => {
    await mods.revoke(endpoint.id, id);
    await load();
  };
  const setDoorState = async (input: { enabled: boolean; rotate?: boolean; auto_admit?: boolean }) => {
    const r = await guestDoor.set(endpoint.id, room.sid, input);
    setDoor({ enabled: r.enabled, auto_admit: r.auto_admit, join_url: r.join_url ?? (input.rotate ? null : door.join_url) });
    setErr(null);
  };
  const ask = (key: string, text: string, run: () => Promise<unknown>) => setConfirm({ key, text, run });

  return (
    <>
      <div className="cr-label set-gap">{room.name.toUpperCase()}</div>
      <div className="set-list acc-list">
        {err && <div className="cr-hint acc-err">{err}</div>}
        <div className="cr-sheet-row">
          <span className="cr-sheet-row-name">Mod link</span>
          <span className="cr-sheet-row-sub">a control seat, shown once</span>
          <button className="cr-ghost" onClick={() => ask("mint", `Mint a new mod link for ${room.name} — a control seat that admits, stages, orders, removes and cuts scenes.`, mint)}>Mint</button>
        </div>
        {minted && (
          <div className="acc-minted">
            <code>{minted}</code>
            <button
              className="cr-ghost"
              onClick={() => {
                void copyText(minted);
                setCopied(true);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        )}
        <div className="acc-seats">
          {seats === null && <div className="cr-sheet-row-sub">Loading seats…</div>}
          {seats === "none" && <div className="cr-sheet-row-sub">This server predates mod links — update producer-server to mint seats.</div>}
          {Array.isArray(seats) && seats.length === 0 && <div className="cr-sheet-row-sub">No active mod seats.</div>}
          {Array.isArray(seats) &&
            seats.map((s) => (
              <div key={s.id} className="cr-sheet-row">
                <span className="cr-sheet-row-name">{s.display_name || "Mod seat"}</span>
                <span className="cr-sheet-row-sub">{(s.grants ?? []).map((g) => g.replace(/^room\./, "")).join(" · ") || "control"}</span>
                <button className="cr-ghost acc-danger" onClick={() => ask(`revoke:${s.id}`, `Revoke the mod seat "${s.display_name || "Mod seat"}" in ${room.name} — its link dies at its next exchange.`, () => revoke(s.id))}>Revoke</button>
              </div>
            ))}
        </div>
        <div className="cr-sheet-row">
          <span className="cr-sheet-row-name">Guest link</span>
          <span className="cr-sheet-row-sub">{door.enabled ? "open" : "closed"}</span>
          <button
            className="cr-ghost"
           
            onClick={() =>
              ask(
                "door",
                door.enabled
                  ? `Rotate the guest link for ${room.name} — the old link stops admitting anyone.`
                  : `Open the guest door for ${room.name} — anyone with the link may ask to join.`,
                () => setDoorState({ enabled: true, rotate: true }),
              )
            }
          >
            {door.enabled ? "Rotate" : "Enable"}
          </button>
          {door.enabled && (
            <button className="cr-ghost acc-danger" onClick={() => ask("close", `Close the guest door for ${room.name} — the link stops admitting anyone.`, () => setDoorState({ enabled: false }))}>Close</button>
          )}
        </div>
        {door.join_url && (
          <div className="acc-minted">
            <code>{door.join_url}</code>
            <button className="cr-ghost" onClick={() => void copyText(door.join_url!)}>Copy</button>
          </div>
        )}
        <div className="cr-sheet-row">
          <span className="cr-sheet-row-name">Auto-admit</span>
          <span className="cr-sheet-row-sub">{door.auto_admit === null ? "link guests wait for you unless on" : door.auto_admit ? "link guests go straight to the roster" : "link guests wait for you"}</span>
          <Switch
            on={door.auto_admit === true}
           
            onChange={(v) => ask("auto", v ? `Auto-admit link guests to ${room.name} — they go straight to the roster.` : `Link guests to ${room.name} wait for you to admit them.`, () => setDoorState({ enabled: true, auto_admit: v }))}
          />
        </div>
      </div>
      {confirm && (
        <ConfirmSheet
          title={room.name}
          items={[confirm]}
          onCancel={() => setConfirm(null)}
          onDone={() => {
            setConfirm(null);
            void load();
          }}
        />
      )}
    </>
  );
}
