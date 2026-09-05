// SETTINGS → ACCESS. Who may do what on this workspace's server, in that
// server's own nouns (docs/CONTRIBUTIONS.md):
//
//   Boomin       → TEAM. Members (type · role), per-surface grants as chips,
//                  per-room roles (host · manager · mod · viewer through the
//                  room-access door), invite by email, and Channel controls —
//                  who may connect / disconnect channels (the `channels`
//                  surface grant, the API's only such control today).
//   Self-hosted  → MODS. A mod is a capability the host hands out: mint a
//                  mod link for a room, see the active seats, revoke one;
//                  and the guest door — enable / rotate / auto-admit.
//
// Same glass list pattern as App / Integrations. Native, never a web console.
import { useCallback, useEffect, useState } from "react";
import type { EndpointInfo, LiveRoom } from "../lib/ipc";
import { isBoomin } from "../lib/workspace";
import { parseConfig } from "../lib/room";
import { copyText } from "../lib/roomLink";
import {
  CHANNEL_CONTROL_SURFACE,
  ROOM_ROLES,
  SURFACES,
  guestDoor,
  memberRoomRole,
  mods,
  team,
  type Member,
  type ModSeatRow,
} from "../lib/access";

function Switch({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} disabled={disabled} className={`switch${on ? " on" : ""}`} onClick={() => onChange(!on)}>
      <span className="knob" />
    </button>
  );
}

const errText = (e: unknown) => String(e).replace(/^Error:\s*/, "");

/** Rooms this workspace has on its server — the only ones a role can be
 * granted on. */
function serverRooms(rooms: LiveRoom[], endpointId: string): { id: string; sid: string; name: string }[] {
  return rooms
    .filter((r) => !r.endpoint_id || r.endpoint_id === endpointId)
    .map((r) => ({ id: r.id, sid: parseConfig(r.config).server_room_id ?? "", name: r.name }))
    .filter((r) => !!r.sid);
}

export function AccessPanel({ endpoint, rooms }: { endpoint: EndpointInfo | null; rooms: LiveRoom[] }) {
  if (!endpoint) return <div className="set-soon">Pick a workspace first.</div>;
  return isBoomin(endpoint) ? <TeamAccess endpoint={endpoint} rooms={rooms} /> : <ModsAccess endpoint={endpoint} rooms={rooms} />;
}

// ── Boomin: Team ──────────────────────────────────────────────────────────────

function TeamAccess({ endpoint, rooms }: { endpoint: EndpointInfo; rooms: LiveRoom[] }) {
  const [brandId, setBrandId] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const srvRooms = serverRooms(rooms, endpoint.id);

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

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
      await load();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const toggleSurface = (m: Member, key: string) => {
    if (!brandId) return;
    const g = m.grants.find((x) => x.scope_type === "surface" && x.surface_key === key);
    void run(`${m.id}:${key}`, () => (g ? team.revokeGrant(endpoint.id, brandId, m.id, g.id) : team.grantSurface(endpoint.id, brandId, m.id, key)));
  };

  const setRoom = (m: Member, sid: string, value: string) => {
    const cur = memberRoomRole(m, sid);
    void run(`${m.id}:${sid}`, async () => {
      if (value === "") {
        if (cur.grant) await team.clearRoomRole(endpoint.id, sid, cur.grant.id);
        return;
      }
      const spec = ROOM_ROLES.find((r) => r.role === value);
      if (!spec?.grant) return;
      await team.setRoomRole(endpoint.id, sid, m.id, spec.grant);
    });
  };

  const isTeam = (m: Member) => m.type === "team" || m.role === "owner" || m.role === "admin";
  const hostsEverywhere = (m: Member) => m.role === "owner" || m.role === "admin" || m.role === "editor";

  return (
    <>
      {err && <div className="cr-hint acc-err">{err}</div>}

      <div className="cr-label set-gap">TEAM</div>
      <div className="set-list acc-list">
        {members === null && <div className="cr-sheet-row-sub">Loading members…</div>}
        {members?.length === 0 && !err && <div className="cr-sheet-row-sub">Only you, so far.</div>}
        {members?.map((m) => (
          <div key={m.id} className="acc-member">
            <div className="acc-member-head">
              <span className="ws-ava sm">{((m.name ?? m.email)[0] ?? "?").toUpperCase()}</span>
              <span className="ws-pop-txt">
                <span className="ws-pop-name">{m.name ?? m.email}</span>
                <span className="ws-pop-slug">{m.email}</span>
              </span>
              <span className="acc-chip acc-type">{m.type}</span>
              <span className="acc-chip acc-role">{m.role}</span>
            </div>
            {isTeam(m) ? (
              <div className="acc-member-sub">Team member — every surface, hosts every room.</div>
            ) : (
              <div className="acc-surfaces">
                {SURFACES.map((sf) => {
                  const on = m.grants.some((g) => g.scope_type === "surface" && g.surface_key === sf.key);
                  const k = `${m.id}:${sf.key}`;
                  return (
                    <button
                      key={sf.key}
                      className={`acc-chip acc-toggle${on ? " on" : ""}${busy === k ? " busy" : ""}`}
                      disabled={busy !== null}
                      title={on ? `Remove the ${sf.label} grant` : `Grant ${sf.label}`}
                      onClick={() => toggleSurface(m, sf.key)}
                    >
                      {sf.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="cr-label set-gap">ROOM ROLES</div>
      <div className="set-list acc-list">
        {srvRooms.length === 0 && <div className="cr-sheet-row-sub">No rooms on the server yet — open a room once and it registers.</div>}
        {srvRooms.map((r) => (
          <div key={r.sid} className="acc-room">
            <div className="acc-room-name">{r.name}</div>
            {(members ?? []).filter((m) => !hostsEverywhere(m)).length === 0 && (
              <div className="cr-sheet-row-sub">Everyone here hosts every room. Invite a collaborator to give them a seat.</div>
            )}
            {(members ?? [])
              .filter((m) => !hostsEverywhere(m))
              .map((m) => {
                const cur = memberRoomRole(m, r.sid);
                const k = `${m.id}:${r.sid}`;
                return (
                  <div key={m.id} className="cr-sheet-row acc-room-row">
                    <span className="cr-sheet-row-name">{m.name ?? m.email}</span>
                    <select className="acc-select" value={cur.role ?? ""} disabled={busy !== null} onChange={(e) => setRoom(m, r.sid, e.target.value)}>
                      <option value="">No seat</option>
                      {ROOM_ROLES.filter((x) => x.grant).map((x) => (
                        <option key={x.role} value={x.role}>{x.label}</option>
                      ))}
                    </select>
                    {busy === k && <span className="cr-sheet-row-sub">…</span>}
                  </div>
                );
              })}
          </div>
        ))}
      </div>

      <div className="cr-label set-gap">CHANNEL CONTROLS</div>
      <div className="set-list acc-list">
        <div className="cr-sheet-row-sub acc-note">Who may connect and disconnect this brand's channels. Team members always can; a collaborator needs the Channels grant.</div>
        {(members ?? []).map((m) => {
          const g = m.grants.find((x) => x.scope_type === "surface" && x.surface_key === CHANNEL_CONTROL_SURFACE);
          const on = isTeam(m) || !!g;
          return (
            <div key={m.id} className="cr-sheet-row">
              <span className="cr-sheet-row-name">{m.name ?? m.email}</span>
              <span className="cr-sheet-row-sub">{isTeam(m) ? "team" : on ? "channels grant" : "no grant"}</span>
              <Switch on={on} disabled={isTeam(m) || busy !== null} onChange={() => toggleSurface(m, CHANNEL_CONTROL_SURFACE)} />
            </div>
          );
        })}
      </div>

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

function ModsAccess({ endpoint, rooms }: { endpoint: EndpointInfo; rooms: LiveRoom[] }) {
  const srvRooms = serverRooms(rooms, endpoint.id);
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
        <RoomMods key={r.sid} endpoint={endpoint} room={r} local={rooms.find((x) => x.id === r.id) ?? null} />
      ))}
    </>
  );
}

function RoomMods({ endpoint, room, local }: { endpoint: EndpointInfo; room: { sid: string; name: string }; local: LiveRoom | null }) {
  const [seats, setSeats] = useState<ModSeatRow[] | null | "none">(null);
  const [minted, setMinted] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
    setBusy(true);
    try {
      const r = await mods.mint(endpoint.id, room.sid, null);
      setMinted(r.mod_url);
      setCopied(false);
      await load();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (id: string) => {
    setBusy(true);
    try {
      await mods.revoke(endpoint.id, id);
      await load();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const setDoorState = async (input: { enabled: boolean; rotate?: boolean; auto_admit?: boolean }) => {
    setBusy(true);
    try {
      const r = await guestDoor.set(endpoint.id, room.sid, input);
      setDoor({ enabled: r.enabled, auto_admit: r.auto_admit, join_url: r.join_url ?? (input.rotate ? null : door.join_url) });
      setErr(null);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="cr-label set-gap">{room.name.toUpperCase()}</div>
      <div className="set-list acc-list">
        {err && <div className="cr-hint acc-err">{err}</div>}
        <div className="cr-sheet-row">
          <span className="cr-sheet-row-name">Mod link</span>
          <span className="cr-sheet-row-sub">a control seat, shown once</span>
          <button className="cr-ghost" disabled={busy} onClick={() => void mint()}>Mint</button>
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
                <button className="cr-ghost acc-danger" disabled={busy} onClick={() => void revoke(s.id)}>Revoke</button>
              </div>
            ))}
        </div>
        <div className="cr-sheet-row">
          <span className="cr-sheet-row-name">Guest link</span>
          <span className="cr-sheet-row-sub">{door.enabled ? "open" : "closed"}</span>
          <button className="cr-ghost" disabled={busy} onClick={() => void setDoorState({ enabled: true, rotate: true })}>
            {door.enabled ? "Rotate" : "Enable"}
          </button>
          {door.enabled && (
            <button className="cr-ghost acc-danger" disabled={busy} onClick={() => void setDoorState({ enabled: false })}>Close</button>
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
          <Switch on={door.auto_admit === true} disabled={busy} onChange={(v) => void setDoorState({ enabled: true, auto_admit: v })} />
        </div>
      </div>
    </>
  );
}
