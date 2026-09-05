// project(interaction, role) — the per-role view of one interaction. Pure,
// and the ONLY way a document leaves the server: an audience socket never
// receives raw inputs, identities, or a running tally it is not entitled to.
// Every frame carries server_now so a phone that slept computes countdowns
// as `reveal_at - server_now + local_offset`.

import type { InteractionDoc } from "./schema";
import { publicTally, type Tally } from "./tally";

export type ViewerRole = "host" | "mod" | "guest" | "audience" | "set";

export interface Projected {
  id: string;
  room_id: string;
  type: "vote";
  state: InteractionDoc["state"];
  version: number;
  spec: InteractionDoc["spec"];
  input: { roles: InteractionDoc["input"]["roles"]; per_identity: "once"; cooldown_ms: number };
  timing: InteractionDoc["timing"];
  render: InteractionDoc["render"];
  /** Present only when this role may see it now. */
  tally?: ReturnType<typeof publicTally>;
  server_now: number;
}

const revealed = (doc: InteractionDoc) => doc.state === "revealed" || doc.state === "closed";

/** Whether `role` may read the tally in the document's current state. */
export function canSeeTally(doc: Pick<InteractionDoc, "state" | "visibility">, role: ViewerRole): boolean {
  if (doc.state === "revealed" || doc.state === "closed") return doc.visibility.reveal_to.includes(role as never) || role === "host" || role === "mod";
  if (doc.state === "collecting") {
    if (doc.visibility.reveal === "live") return true;
    return (doc.visibility.running_tally as string[]).includes(role);
  }
  return false;
}

export function project(doc: InteractionDoc, tally: Tally | null, role: ViewerRole, now = Date.now()): Projected {
  const out: Projected = {
    id: doc.id,
    room_id: doc.room_id,
    type: doc.type,
    state: doc.state,
    version: doc.version,
    spec: doc.spec,
    input: { roles: doc.input.roles, per_identity: "once", cooldown_ms: doc.input.cooldown_ms },
    timing: doc.timing,
    render: doc.render.filter((r) => role === "host" || role === "mod" || r.surface === role),
    server_now: now,
  };
  if (tally && canSeeTally(doc, role)) out.tally = publicTally(tally);
  void revealed;
  return out;
}
