// Scene cuts by mods (#47, founder decision 2026-09-04) — the PURE half.
//
// The host's Producer publishes its scene list + active scene to the room's
// Durable Object; a control seat (mod) sends `scene.cut`. The DO validates
// here and forwards the cut to the host as a FRAME — never a config the host
// polls — so it lands inside a frame budget, and the host applies it exactly
// as its own keypress would. The host persists active_scene_id afterwards and
// republishes, which is what lights the active scene on every mod's list.
//
// Wire frames (room channel, room-control sockets):
//   host → DO      { type: "scene.publish", scenes: [{ id, name }], active_scene_id }
//   DO → controls  { type: "scene.state", scenes, active_scene_id, server_now }
//   mod → DO       { type: "scene.cut", scene_id, transition? }
//   DO → host      { type: "scene.cut", scene_id, transition?, from, server_now }
//   DO → mod       { type: "scene.cut.ok", scene_id, server_now }
//                | { type: "error", code: "forbidden", status: 403, grant: "room.scene" }
//                | { type: "error", code: "unknown_scene", status: 422, scene_id }

export interface SceneRef {
  id: string;
  name: string;
}

export interface SceneState {
  scenes: SceneRef[];
  active_scene_id: string | null;
  /** Host publish counter — a client ignores a stale state. */
  version: number;
}

export const EMPTY_SCENES: SceneState = { scenes: [], active_scene_id: null, version: 0 };

const MAX_SCENES = 64;

/** Parse a host's `scene.publish`. Tolerant of junk; a malformed publish
 *  yields null and changes nothing. */
export function parseScenePublish(msg: unknown, previous: SceneState): SceneState | null {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as { scenes?: unknown; active_scene_id?: unknown };
  if (!Array.isArray(m.scenes)) return null;
  const scenes: SceneRef[] = [];
  for (const raw of m.scenes.slice(0, MAX_SCENES)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as { id?: unknown; name?: unknown };
    if (typeof r.id !== "string" || !r.id || r.id.length > 80) continue;
    scenes.push({ id: r.id, name: typeof r.name === "string" ? r.name.slice(0, 80) : r.id });
  }
  const active = typeof m.active_scene_id === "string" && scenes.some((s) => s.id === m.active_scene_id) ? m.active_scene_id : null;
  return { scenes, active_scene_id: active, version: previous.version + 1 };
}

export type SceneCutVerdict =
  | { ok: true; scene_id: string; transition?: string }
  | { ok: false; code: "forbidden"; status: 403; grant: "room.scene" }
  | { ok: false; code: "unknown_scene"; status: 422; scene_id: string }
  | { ok: false; code: "invalid"; status: 400 };

/** The authority check. `room.scene` is required unless the sender IS the
 *  host; the scene must be in the list the host published. */
export function validateSceneCut(
  msg: unknown,
  sender: { role?: string; grants?: readonly string[] },
  state: SceneState,
): SceneCutVerdict {
  const m = (msg && typeof msg === "object" ? msg : {}) as { scene_id?: unknown; transition?: unknown };
  if (typeof m.scene_id !== "string" || !m.scene_id) return { ok: false, code: "invalid", status: 400 };
  const allowed = sender.role === "host" || (sender.grants ?? []).includes("room.scene");
  if (!allowed) return { ok: false, code: "forbidden", status: 403, grant: "room.scene" };
  if (!state.scenes.some((s) => s.id === m.scene_id)) return { ok: false, code: "unknown_scene", status: 422, scene_id: m.scene_id };
  const transition = typeof m.transition === "string" && /^[a-z_]{1,24}$/.test(m.transition) ? m.transition : undefined;
  return { ok: true, scene_id: m.scene_id, ...(transition ? { transition } : {}) };
}
