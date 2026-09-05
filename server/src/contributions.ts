// The contribution ledger (#50) — WHO supplied WHAT, FROM WHEN TO WHEN,
// WHERE on the set. Intervals: open once, close once, never edit. Server
// time only. An open interval self-expires against the host heartbeat.
//
// Kinds this server writes:
//   presence      — a guest on the host's stage list (host_stage)
//   media.screen  — a guest's screen share, reported by the guest page
//   overlay       — a host source with a binding (e.g. {sponsor}) shown/hidden
//   input         — an interaction's inputs, one AGGREGATE row per participant
//                   kind (never a row per phone)
// `credit` is in the CHECK for shape parity; nothing here writes it.

import type { Env } from "./env";
import { ApiError } from "./errors";
import { HOST_PRESENCE_WINDOW_MS, hostPresent } from "./guests";

// Interval stamps are MILLISECONDS (unlike the roster's second-grained
// columns): UNIQUE (participant_id, kind, started_at) must let a guest leave
// and return within one second without the second interval colliding with
// the first. The wire is ISO either way.
const nowMs = () => Date.now();
const isoMs = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);

export type ContributionKind = "presence" | "media.screen" | "overlay" | "input" | "credit";
export type ContributionSource = "host_stage" | "participant" | "interaction" | "host_credit";

export interface ContributionRow {
  id: string;
  room_id: string;
  run_id: string | null;
  participant_id: string | null;
  kind: ContributionKind;
  binding: string;
  started_at: number;
  ended_at: number | null;
  source: ContributionSource;
  metadata: string;
  created_at: number;
}

const parse = (s: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** Canonical JSON for a binding so two writes of the same binding compare
 *  equal in SQL (key order sorted, one level deep is enough for stage ids). */
export function canonicalBinding(binding: Record<string, unknown> | null | undefined): string {
  if (!binding) return "{}";
  const keys = Object.keys(binding).sort();
  const out: Record<string, unknown> = {};
  for (const k of keys) if (binding[k] !== undefined) out[k] = binding[k];
  return JSON.stringify(out);
}

export function publicContribution(row: ContributionRow) {
  return {
    id: row.id,
    room_id: row.room_id,
    run_id: row.run_id,
    participant_id: row.participant_id,
    kind: row.kind,
    binding: parse(row.binding),
    started_at: isoMs(row.started_at),
    ended_at: isoMs(row.ended_at),
    source: row.source,
    metadata: parse(row.metadata),
  };
}

async function currentRunId(env: Env, roomId: string): Promise<string | null> {
  const r = await env.DB.prepare("SELECT run_id FROM live_rooms WHERE id = ?1").bind(roomId).first<{ run_id: string | null }>();
  return r?.run_id ?? null;
}

/** The OPEN interval for (room, participant, kind, binding), if any. */
async function openRow(env: Env, roomId: string, participantId: string | null, kind: ContributionKind, binding: string) {
  return env.DB.prepare(
    `SELECT * FROM contributions
     WHERE room_id = ?1 AND kind = ?2 AND binding = ?3 AND ended_at IS NULL
       AND ((?4 IS NULL AND participant_id IS NULL) OR participant_id = ?4)
     ORDER BY started_at DESC LIMIT 1`,
  )
    .bind(roomId, kind, binding, participantId)
    .first<ContributionRow>();
}

/** Open an interval. Idempotent: an already-open interval for the same
 *  (participant, kind, binding) is returned, never forked — and the UNIQUE
 *  (participant_id, kind, started_at) makes a same-second retry a no-op at
 *  the database too. Time is the server's; `at` exists for the expiry sweep
 *  and tests, never for a client. */
export async function openInterval(
  env: Env,
  input: {
    roomId: string;
    participantId: string | null;
    kind: ContributionKind;
    binding?: Record<string, unknown> | null;
    source: ContributionSource;
    metadata?: Record<string, unknown> | null;
    runId?: string | null;
    at?: number;
  },
): Promise<ContributionRow> {
  const binding = canonicalBinding(input.binding);
  const existing = await openRow(env, input.roomId, input.participantId, input.kind, binding);
  if (existing) return existing;
  const now = input.at ?? nowMs();
  const id = `ct_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const runId = input.runId !== undefined ? input.runId : await currentRunId(env, input.roomId);
  await env.DB.prepare(
    `INSERT INTO contributions (id, room_id, run_id, participant_id, kind, binding, started_at, source, metadata, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?7)
     ON CONFLICT (participant_id, kind, started_at) DO NOTHING`,
  )
    .bind(id, input.roomId, runId, input.participantId, input.kind, binding, now, input.source, JSON.stringify(input.metadata ?? {}))
    .run();
  const opened = await openRow(env, input.roomId, input.participantId, input.kind, binding);
  if (opened) return opened;
  // The UNIQUE index absorbed a same-instant retry of an interval that has
  // since closed: that row IS the answer — never a fork.
  return (await env.DB.prepare(
    "SELECT * FROM contributions WHERE kind = ?2 AND started_at = ?3 AND ((?1 IS NULL AND participant_id IS NULL) OR participant_id = ?1)",
  )
    .bind(input.participantId, input.kind, now)
    .first<ContributionRow>())!;
}

/** Close the open interval for (participant, kind, binding). Nothing open =
 *  nothing to do (a stop after a stop is not an error). */
export async function closeInterval(
  env: Env,
  input: { roomId: string; participantId: string | null; kind: ContributionKind; binding?: Record<string, unknown> | null; at?: number },
): Promise<ContributionRow | null> {
  const binding = canonicalBinding(input.binding);
  const row = await openRow(env, input.roomId, input.participantId, input.kind, binding);
  if (!row) return null;
  const at = Math.max(row.started_at, input.at ?? nowMs());
  await env.DB.prepare("UPDATE contributions SET ended_at = ?2 WHERE id = ?1 AND ended_at IS NULL").bind(row.id, at).run();
  return { ...row, ended_at: at };
}

/** Close EVERY open interval of one participant (they left / were removed). */
export async function closeAllFor(env: Env, roomId: string, participantId: string, at = nowMs()): Promise<void> {
  await env.DB.prepare(
    "UPDATE contributions SET ended_at = MAX(started_at, ?3) WHERE room_id = ?1 AND participant_id = ?2 AND ended_at IS NULL",
  )
    .bind(roomId, participantId, at)
    .run();
}

/** Close every open interval in a room (the run ended). */
export async function closeAllInRoom(env: Env, roomId: string, at = nowMs()): Promise<number> {
  const r = await env.DB.prepare("UPDATE contributions SET ended_at = MAX(started_at, ?2) WHERE room_id = ?1 AND ended_at IS NULL")
    .bind(roomId, at)
    .run();
  return r.meta.changes;
}

/** Presence follows the stage list: open for who just arrived, close for who
 *  just left. The binding is the guest's slot in the list, a stable stage id. */
export async function syncPresence(env: Env, roomId: string, onStage: readonly string[], at = nowMs()): Promise<void> {
  const open = await env.DB.prepare(
    "SELECT * FROM contributions WHERE room_id = ?1 AND kind = 'presence' AND ended_at IS NULL",
  )
    .bind(roomId)
    .all<ContributionRow>();
  const wanted = new Set(onStage);
  for (const row of open.results ?? []) {
    if (row.participant_id && !wanted.has(row.participant_id)) {
      await env.DB.prepare("UPDATE contributions SET ended_at = MAX(started_at, ?2) WHERE id = ?1").bind(row.id, at).run();
    }
  }
  const openIds = new Set((open.results ?? []).map((r) => r.participant_id));
  for (let i = 0; i < onStage.length; i++) {
    const id = onStage[i];
    if (openIds.has(id)) continue;
    await openInterval(env, { roomId, participantId: id, kind: "presence", binding: { slot: i }, source: "host_stage", at });
  }
}

/** The heartbeat rule: when a room's host has not been seen for the
 *  presence window, its open intervals end at the moment the host was last
 *  known alive plus the window — the ledger never credits a crashed host's
 *  silence as time on stage. Run by the queue tick every minute. */
export async function expireStale(env: Env, now = Date.now()): Promise<number> {
  const rooms = await env.DB.prepare(
    `SELECT DISTINCT r.id, r.host_seen_at FROM live_rooms r
     JOIN contributions c ON c.room_id = r.id AND c.ended_at IS NULL`,
  ).all<{ id: string; host_seen_at: number | null }>();
  let closed = 0;
  for (const room of rooms.results ?? []) {
    if (hostPresent(room.host_seen_at, now)) continue;
    const at = room.host_seen_at ? room.host_seen_at * 1000 + HOST_PRESENCE_WINDOW_MS : now;
    closed += await closeAllInRoom(env, room.id, Math.min(at, now));
  }
  return closed;
}

/** The run report. `runId` absent = the open run, else the latest run that
 *  has rows, else everything. Newest first. */
export async function listForRoom(env: Env, roomId: string, runId?: string | null): Promise<ContributionRow[]> {
  return (await listRun(env, roomId, runId)).rows;
}

/** Same, with the run it resolved to. */
export async function listRun(env: Env, roomId: string, runId?: string | null): Promise<{ run_id: string | null; rows: ContributionRow[] }> {
  let run = runId ?? null;
  if (!run) {
    run = await currentRunId(env, roomId);
    if (!run) {
      const latest = await env.DB.prepare(
        "SELECT run_id FROM contributions WHERE room_id = ?1 AND run_id IS NOT NULL ORDER BY started_at DESC LIMIT 1",
      )
        .bind(roomId)
        .first<{ run_id: string }>();
      run = latest?.run_id ?? null;
    }
  }
  const rows = run
    ? await env.DB.prepare("SELECT * FROM contributions WHERE room_id = ?1 AND run_id = ?2 ORDER BY started_at DESC, created_at DESC")
        .bind(roomId, run)
        .all<ContributionRow>()
    : await env.DB.prepare("SELECT * FROM contributions WHERE room_id = ?1 ORDER BY started_at DESC, created_at DESC")
        .bind(roomId)
        .all<ContributionRow>();
  return { run_id: run, rows: rows.results ?? [] };
}

/** Summed closed presence for one guest, in whole seconds — must equal the
 *  guest row's stage_seconds cache when both are driven by the same stage
 *  publishes. */
export async function presenceSeconds(env: Env, roomId: string, participantId: string): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT COALESCE(SUM((ended_at / 1000) - (started_at / 1000)), 0) AS s FROM contributions
     WHERE room_id = ?1 AND participant_id = ?2 AND kind = 'presence' AND ended_at IS NOT NULL`,
  )
    .bind(roomId, participantId)
    .first<{ s: number }>();
  // Integer division mirrors the stage clock's second-grained arithmetic.
  return Number(r?.s ?? 0);
}

// ── Runs ─────────────────────────────────────────────────────────────────────

/** Start a run: a new run id, and presence intervals for whoever is already
 *  on stage (closed under the previous run first, so no interval spans two
 *  runs). Idempotent while a run is open. */
export async function startRun(env: Env, roomId: string, stage: readonly string[]): Promise<{ run_id: string; started_at: string }> {
  const room = await env.DB.prepare("SELECT run_id, run_started_at FROM live_rooms WHERE id = ?1")
    .bind(roomId)
    .first<{ run_id: string | null; run_started_at: number | null }>();
  if (!room) throw new ApiError(404, "room_not_found", "That room was not found.");
  if (room.run_id) return { run_id: room.run_id, started_at: isoMs((room.run_started_at ?? 0) * 1000)! };
  const now = nowMs();
  const sec = Math.floor(now / 1000);
  const runId = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await closeAllInRoom(env, roomId, now);
  await env.DB.prepare("UPDATE live_rooms SET run_id = ?2, run_started_at = ?3, updated_at = ?3 WHERE id = ?1").bind(roomId, runId, sec).run();
  // One millisecond after the close, so a presence interval that was open
  // under the previous run (or none) and reopens here never shares a
  // started_at with the row that just ended.
  await syncPresence(env, roomId, stage, now + 1);
  return { run_id: runId, started_at: isoMs(now)! };
}

/** End the run: every open interval closes now; the room has no run until
 *  the next start. Returns the id so the client can read its report. */
export async function stopRun(env: Env, roomId: string): Promise<{ run_id: string | null; closed: number }> {
  const room = await env.DB.prepare("SELECT run_id FROM live_rooms WHERE id = ?1").bind(roomId).first<{ run_id: string | null }>();
  if (!room) throw new ApiError(404, "room_not_found", "That room was not found.");
  const now = nowMs();
  const closed = await closeAllInRoom(env, roomId, now);
  await env.DB.prepare("UPDATE live_rooms SET run_id = NULL, run_started_at = NULL, updated_at = ?2 WHERE id = ?1").bind(roomId, Math.floor(now / 1000)).run();
  return { run_id: room.run_id, closed };
}

/** An interaction's inputs, as the ledger keeps them: ONE aggregate row per
 *  participant kind (never a row per phone), spanning the collect window,
 *  bound to the interaction. Written once, at close. */
export async function recordInputAggregates(
  env: Env,
  input: { roomId: string; runId: string | null; interactionId: string; openedAt: number; closedAt: number; byKind: Record<string, number> },
): Promise<void> {
  for (const [kind, count] of Object.entries(input.byKind)) {
    if (!count) continue;
    const binding = canonicalBinding({ interaction_id: input.interactionId, participant_kind: kind });
    const id = `ct_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    await env.DB.prepare(
      `INSERT INTO contributions (id, room_id, run_id, participant_id, kind, binding, started_at, ended_at, source, metadata, created_at)
       VALUES (?1, ?2, ?3, NULL, 'input', ?4, ?5, ?6, 'interaction', ?7, ?5)
       ON CONFLICT (participant_id, kind, started_at) DO NOTHING`,
    )
      .bind(id, input.roomId, input.runId, binding, input.openedAt, Math.max(input.openedAt, input.closedAt), JSON.stringify({ count }))
      .run();
  }
}
