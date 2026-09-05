// The room channel on BOOMIN (api #392), mapped onto the open server's frames.
//
// Producer keeps one control loop (views/Live.tsx) and one socket class
// (lib/roomControl.ts). What differs between the two backends is the wire:
// the open server speaks `{type: …}` frames on a control socket; Boomin's
// room Durable Object publishes `{channels, action, payload}` and reaches
// Producer through a ticket (`POST /live/rooms/:id/channel-ticket`) and an
// upgrade (`GET /live/rooms/channel?ticket=`). This module is the pure
// translation, in both directions, so Live.tsx never learns the difference:
//
//   Boomin action            → Producer frame
//   scene.cut   (stage)      → { type: "scene.cut", scene_id, from, server_now }
//   stage       (stage)      → dropped — the roster poll carries the stage
//   contribution.opened      → { type: "contribution.opened", contribution }
//   contribution.closed      → { type: "contribution.closed", contribution }
//   interaction.*            → { type: "interaction", channels, payload }
//   error / subscribed / pong→ as is
//
// The scene list goes the other way as ROOM CONFIG (there is no
// `scene.publish` on Boomin): `boominStageConfig` shapes it for
// `PATCH /live/rooms/:id`, whose strict schema wants a stage kind per scene.

import type { Contribution, Interaction } from "./ipc";
import type { ControlFrame } from "./roomControl";

/** Where the audience phone page lives (Boomin web, `/a/:interactionId`). */
export const BOOMIN_APP_URL = "https://boomin.ai";

/** The share link for one vote: no room code on Boomin, the interaction id
 *  IS the payload — `GET /v1/connect/interactions/:id` + the input route. */
export function boominAudienceUrl(interactionId: string, appUrl = BOOMIN_APP_URL): string {
  return `${appUrl.replace(/\/+$/, "")}/a/${encodeURIComponent(interactionId)}`;
}

/** The channels a Producer holds on the room DO. `interactions:control` is
 *  refused by the hub unless the ticket's `can.interactions` is true (a mod
 *  has it; a viewer does not) — the refusal is a harmless error frame. */
export const BOOMIN_ROOM_CHANNELS = ["stage", "contributions", "interactions", "interactions:control"] as const;

export interface ContributionFrame {
  type: "contribution.opened" | "contribution.closed";
  contribution: Contribution;
  server_now?: number;
  [k: string]: unknown;
}

/** One published frame off Boomin's room channel → the frame Live.tsx
 *  already handles. Tolerant: junk never throws in the control loop. */
export function parseBoominFrame(raw: unknown): ControlFrame | null {
  if (typeof raw !== "string") return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const f = v as { type?: unknown; action?: unknown; channels?: unknown; payload?: unknown };
  // Direct frames (subscribed / error / pong) keep their type.
  if (typeof f.type === "string") return v as ControlFrame;
  if (typeof f.action !== "string") return null;
  const channels = Array.isArray(f.channels) ? (f.channels as string[]) : [];
  const p = (f.payload && typeof f.payload === "object" ? f.payload : {}) as Record<string, unknown>;
  switch (f.action) {
    case "scene.cut": {
      if (typeof p.scene_id !== "string") return null;
      const by = (p.by && typeof p.by === "object" ? p.by : {}) as { user_id?: unknown; role?: unknown };
      return {
        type: "scene.cut",
        scene_id: p.scene_id,
        from: typeof by.user_id === "string" ? by.user_id : "server",
        server_now: typeof p.server_now === "number" ? p.server_now : Date.now(),
        ...(typeof by.role === "string" ? { role: by.role } : {}),
        ...(typeof p.version === "number" ? { version: p.version } : {}),
      };
    }
    case "contribution.opened":
    case "contribution.closed": {
      const c = p.contribution;
      if (!c || typeof c !== "object" || typeof (c as { id?: unknown }).id !== "string") return null;
      return { type: f.action, contribution: c as Contribution, server_now: p.server_now } as ContributionFrame;
    }
    case "interaction.open":
    case "interaction.tally":
    case "interaction.revealed":
    case "interaction.closed":
    case "interaction.cancelled": {
      const ix = normalizeBoominInteraction(p.interaction, typeof p.server_now === "number" ? p.server_now : undefined);
      if (!ix) return null;
      return { type: "interaction", channels, payload: ix };
    }
    default:
      // `stage` and anything newer: the roster poll / a later build.
      return null;
  }
}

/** Boomin's projection (api realtime/interaction-state.ts) is the same
 *  document Producer renders, minus a few defaults the open server always
 *  fills. Returns null unless it is recognisably an interaction. */
export function normalizeBoominInteraction(raw: unknown, serverNow?: number): Interaction | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.state !== "string") return null;
  const spec = (r.spec && typeof r.spec === "object" ? r.spec : {}) as Record<string, unknown>;
  const options = Array.isArray(spec.options)
    ? (spec.options as unknown[])
        .map((o) => (o && typeof o === "object" ? (o as { id?: unknown; label?: unknown }) : null))
        .filter((o): o is { id: string; label?: unknown } => !!o && typeof o.id === "string")
        .map((o) => ({ id: o.id, label: typeof o.label === "string" ? o.label : o.id }))
    : [];
  const input = (r.input && typeof r.input === "object" ? r.input : {}) as Record<string, unknown>;
  const timing = (r.timing && typeof r.timing === "object" ? r.timing : {}) as Record<string, unknown>;
  const tallyRaw = r.tally && typeof r.tally === "object" ? (r.tally as Record<string, unknown>) : null;
  const tally = tallyRaw
    ? {
        total: typeof tallyRaw.total === "number" ? tallyRaw.total : 0,
        options: (tallyRaw.options && typeof tallyRaw.options === "object" ? tallyRaw.options : {}) as Record<string, number>,
        by_kind: (tallyRaw.by_kind && typeof tallyRaw.by_kind === "object" ? tallyRaw.by_kind : {}) as Record<string, number>,
        winner: typeof tallyRaw.winner === "string" ? tallyRaw.winner : null,
      }
    : undefined;
  return {
    id: r.id,
    room_id: typeof r.room_id === "string" ? r.room_id : "",
    type: typeof r.type === "string" ? r.type : "vote",
    state: r.state,
    version: typeof r.version === "number" ? r.version : 0,
    spec: { prompt: typeof spec.prompt === "string" ? spec.prompt : "", options },
    input: {
      roles: Array.isArray(input.roles) ? (input.roles as string[]) : ["guest", "audience"],
      per_identity: typeof input.per_identity === "string" ? input.per_identity : "once",
      cooldown_ms: typeof input.cooldown_ms === "number" ? input.cooldown_ms : 0,
    },
    timing: {
      ...(typeof timing.opened_at === "string" ? { opened_at: timing.opened_at } : {}),
      ...(typeof timing.reveal_at === "string" ? { reveal_at: timing.reveal_at } : {}),
      ...(typeof timing.revealed_at === "string" ? { revealed_at: timing.revealed_at } : {}),
      ...(typeof timing.closed_at === "string" ? { closed_at: timing.closed_at } : {}),
      collect_ms: typeof timing.collect_ms === "number" ? timing.collect_ms : 0,
      reveal_hold_ms: typeof timing.reveal_hold_ms === "number" ? timing.reveal_hold_ms : 0,
    },
    render: Array.isArray(r.render) ? (r.render as Interaction["render"]) : [],
    ...(tally ? { tally } : {}),
    server_now: serverNow ?? (typeof r.server_now === "number" ? r.server_now : Date.now()),
  };
}

/** The create body for a two-choice vote on Boomin (contract envelope; the
 *  open server also takes a short form, Boomin does not). Option ids are
 *  stable `a` / `b` so the overlay and the phones agree without a lookup. */
export function boominVoteBody(input: { a: string; b: string; prompt: string; who: "guest" | "audience" | "both" }) {
  const roles = input.who === "both" ? ["guest", "audience"] : [input.who];
  return {
    type: "vote",
    spec: {
      prompt: input.prompt,
      options: [
        { id: "a", label: input.a },
        { id: "b", label: input.b },
      ],
    },
    input: { roles, per_identity: "once", cooldown_ms: 0 },
    timing: { collect_ms: 0 },
    render: [
      { surface: "set", kind: "bar" },
      { surface: "audience", kind: "buttons" },
      { surface: "guest", kind: "card" },
    ],
  };
}

/** Producer's scene list as Boomin room config. The server's schema is
 *  strict and stage-shaped (every scene needs a `kind`, the config a
 *  `stage_enabled`); a Producer room's stage is the engine, so the config is
 *  a scene DIRECTORY: ids + labels a mod can cut to, nothing the web stage
 *  would render (`stage_enabled: false`). Ids are cut to the schema's 40. */
export function boominStageConfig(
  scenes: readonly { id: string; name: string }[],
  activeSceneId: string | null | undefined,
): { stage_enabled: false; scenes: { id: string; kind: "cam"; label: string }[]; active_scene_id?: string } {
  const list = scenes.slice(0, 12).map((s) => ({ id: s.id.slice(0, 40), kind: "cam" as const, label: s.name.slice(0, 40) }));
  const active = activeSceneId ? activeSceneId.slice(0, 40) : undefined;
  return {
    stage_enabled: false,
    scenes: list.length ? list : [{ id: "default", kind: "cam", label: "Scene" }],
    ...(active && list.some((s) => s.id === active) ? { active_scene_id: active } : {}),
  };
}

/** Read the scene directory back (a mod's Producer, from `GET /live/rooms`). */
export function scenesFromBoominConfig(config: unknown): { scenes: { id: string; name: string }[]; active_scene_id: string | null } {
  const c = (config && typeof config === "object" ? config : {}) as { scenes?: unknown; active_scene_id?: unknown };
  const scenes = Array.isArray(c.scenes)
    ? (c.scenes as unknown[])
        .map((s) => (s && typeof s === "object" ? (s as { id?: unknown; label?: unknown }) : null))
        .filter((s): s is { id: string; label?: unknown } => !!s && typeof s.id === "string")
        .map((s) => ({ id: s.id, name: typeof s.label === "string" && s.label ? s.label : s.id }))
    : [];
  return { scenes, active_scene_id: typeof c.active_scene_id === "string" ? c.active_scene_id : null };
}

/** Group a Boomin ledger (no run ids for Producer rooms) into the run that
 *  just ended: every interval that overlaps [startedAt, endedAt]. */
export function contributionsInWindow<T extends { started_at: string; ended_at: string | null }>(
  rows: readonly T[],
  startedAt: number,
  endedAt: number,
): T[] {
  return rows.filter((c) => {
    const s = Date.parse(c.started_at);
    const e = c.ended_at ? Date.parse(c.ended_at) : Number.POSITIVE_INFINITY;
    return Number.isFinite(s) && s <= endedAt && e >= startedAt;
  });
}
