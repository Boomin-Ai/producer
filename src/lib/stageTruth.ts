/** Honest staging — the stage a mod sees is the HOST's truth, never a wish.
 *
 * The server keeps a versioned stage list (`POST …/stage` → `{on_stage,
 * version}`, pushed as a `stage` frame on the room channel). Two writers
 * post to it:
 *
 *   the mod   — a REQUEST: "put this guest on" / "take them off". The
 *               server accepts it (it cannot know the host's set), bumps
 *               the version and pushes the list. That push is the mod's
 *               own echo, not a fact about the set.
 *   the host  — the TRUTH: after it acts on a request (showGuestInSlot
 *               succeeded, or failed because no guest slot is free) it
 *               posts what its engine actually shows, unconditionally, so
 *               the version bumps again and every seat learns the outcome.
 *
 * A mod's row therefore has three states: off, on, and PENDING (asked; the
 * host has not answered). Only a frame whose version is NEWER than the
 * request's own echo flips it. A newer frame WITHOUT the guest is a
 * refusal — the one cause today is a full set ("no free guest slot"), so
 * the row snaps back with that. No answer within HOST_ANSWER_MS is its own
 * message: the host's Producer is not in the room.
 *
 * Pure: no DOM, no IPC (server/test runs it under tsc). Live.tsx drives it.
 */

export const HOST_ANSWER_MS = 12_000;

export const NO_FREE_SLOT = "No free guest slot on the host's set — ask the host to add one";
export const HOST_KEPT_ON = "The host's set kept them on — ask the host";
export const HOST_SILENT = "The host's Producer didn't confirm — is the host in the room?";
/** A seat's feed has no slot to run out of — a refusal there is the host's
 * own choice (or its feed had not connected yet). */
export const MOD_FEED_NOT_PLACED = "The host's set didn't place your feed — is it connected? Ask the host";

export interface ModStageRequest {
  guestId: string;
  want: boolean;
  /** The version the server assigned to our request (its echo). */
  version: number;
  since: number;
}

export interface ModStageState {
  /** The last list the host confirmed (or the server's list before any
   * request was made from this seat). */
  confirmed: string[];
  version: number;
  pending: ModStageRequest | null;
  /** What to tell the mod about the last outcome, on that guest's row. */
  notice: { guestId: string; text: string } | null;
}

export const EMPTY_MOD_STAGE: ModStageState = { confirmed: [], version: 0, pending: null, notice: null };

export type ModStageEvent =
  /** Our POST succeeded; the server answered with the echo's version. */
  | { type: "request"; guestId: string; want: boolean; version: number; now: number }
  /** Our POST failed outright (409 stage_full, network): nothing changed. */
  | { type: "request-failed"; guestId: string; error: string }
  /** A `stage` frame off the room channel. */
  | { type: "frame"; on_stage: string[]; version: number; now: number }
  | { type: "tick"; now: number }
  /** Clear a notice (the row was clicked again, the guest left). */
  | { type: "dismiss"; guestId?: string };

export function modStageReduce(state: ModStageState, ev: ModStageEvent): ModStageState {
  switch (ev.type) {
    case "request":
      return {
        ...state,
        version: Math.max(state.version, ev.version),
        pending: { guestId: ev.guestId, want: ev.want, version: ev.version, since: ev.now },
        notice: null,
      };
    case "request-failed":
      return { ...state, pending: null, notice: { guestId: ev.guestId, text: ev.error } };
    case "frame": {
      // Stale or duplicate: the version only ever moves forward.
      if (ev.version < state.version) return state;
      const p = state.pending;
      if (p && ev.version <= p.version) {
        // Our own echo (or an older writer's): the list carries our wish, not
        // the set. Keep the row pending; remember the version.
        return { ...state, version: ev.version };
      }
      if (p) {
        // Newer than our echo: the host acted (or another writer moved the
        // list after us). The list IS the truth now.
        const on = ev.on_stage.includes(p.guestId);
        const honoured = on === p.want;
        return {
          confirmed: [...ev.on_stage],
          version: ev.version,
          pending: null,
          notice: honoured ? null : { guestId: p.guestId, text: p.want ? NO_FREE_SLOT : HOST_KEPT_ON },
        };
      }
      if (ev.version === state.version && sameList(state.confirmed, ev.on_stage)) return state;
      return { ...state, confirmed: [...ev.on_stage], version: ev.version };
    }
    case "tick": {
      const p = state.pending;
      if (!p || ev.now - p.since < HOST_ANSWER_MS) return state;
      return { ...state, pending: null, notice: { guestId: p.guestId, text: HOST_SILENT } };
    }
    case "dismiss":
      if (!state.notice) return state;
      if (ev.guestId && state.notice.guestId !== ev.guestId) return state;
      return { ...state, notice: null };
  }
}

export type ModRowStage = "off" | "on" | "pending-on" | "pending-off";

/** How one guest's row reads: the confirmed list, overlaid by a pending ask. */
export function modRowStage(state: ModStageState, guestId: string): ModRowStage {
  if (state.pending?.guestId === guestId) return state.pending.want ? "pending-on" : "pending-off";
  return state.confirmed.includes(guestId) ? "on" : "off";
}

/** The list a toggle asks for: the confirmed list with one guest flipped.
 * Always the FULL list, so a dropped call is corrected by the next one. */
export function modStageWish(state: ModStageState, guestId: string): { on_stage: string[]; want: boolean } {
  const cur = state.confirmed;
  const want = !cur.includes(guestId);
  return { on_stage: want ? [...cur, guestId] : cur.filter((x) => x !== guestId), want };
}

// ── The host's half ──────────────────────────────────────────────────────────

export interface HostStageInput {
  /** The list a `stage` frame carried. */
  requested: readonly string[];
  /** Participant ids currently ON THE SET by the engine's truth: guests
   * shown in a slot, seats whose MOD camera feed is placed. */
  shown: readonly string[];
  /** Participant ids that may be put on: admitted guests, and seats the
   * host handed media. */
  admitted: readonly string[];
  /** Participant ids that are SEATS (monitor rows with media, v0.4.32).
   * A seat is honoured through the MOD path — its own source kind, its own
   * placement — never through a guest slot. Absent = everyone is a guest. */
  seats?: readonly string[];
}

export interface HostStagePlan {
  /** Guests to pop into a free guest slot, in request order. */
  toShow: string[];
  /** Guests to pop out of their slot. */
  toHide: string[];
  /** Seats whose MOD camera feed must be PLACED (mod path). */
  toPlaceMod: string[];
  /** Seats whose MOD feed must be REMOVED from the set. */
  toRemoveMod: string[];
}

/** What the host must do to honour a request: show the requested-and-
 * admitted guests it is not showing, hide the shown guests the request
 * left out — and the same for seats, on the MOD path. Order preserved
 * from the request. A seat is never in toShow / toHide; a guest is never
 * in toPlaceMod / toRemoveMod. */
export function hostStagePlan(input: HostStageInput): HostStagePlan {
  const admitted = new Set(input.admitted);
  const shown = new Set(input.shown);
  const requested = new Set(input.requested);
  const seats = new Set(input.seats ?? []);
  const wantOn = input.requested.filter((id) => admitted.has(id) && !shown.has(id));
  const wantOff = input.shown.filter((id) => !requested.has(id));
  return {
    toShow: wantOn.filter((id) => !seats.has(id)),
    toHide: wantOff.filter((id) => !seats.has(id)),
    toPlaceMod: wantOn.filter((id) => seats.has(id)),
    toRemoveMod: wantOff.filter((id) => seats.has(id)),
  };
}

/** A frame is the host's OWN echo when its version is not newer than the
 * last version the host posted: nothing to act on. */
export function isOwnEcho(frameVersion: number, lastPostedVersion: number): boolean {
  return frameVersion <= lastPostedVersion;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((x, i) => x === sb[i]);
}
