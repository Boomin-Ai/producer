// The interaction object (docs/INTERACTIVE.md §2.4, producer.interaction/v1)
// — the PURE half: parse a create body, own the state machine. v1 knows one
// type, `vote`, with exactly two options; every later type is a payload on
// the same envelope, not a new table.

export type InteractionType = "vote";
export type InteractionState = "draft" | "open" | "collecting" | "revealed" | "closed" | "cancelled";
export type InputRole = "host" | "mod" | "guest" | "audience";
export type Reveal = "live" | "on_close" | "on_timer" | "manual";

export interface VoteOption {
  id: string;
  label: string;
}

export interface InteractionDoc {
  id: string;
  room_id: string;
  run_id: string | null;
  type: InteractionType;
  state: InteractionState;
  version: number;
  spec: { prompt: string; options: VoteOption[] };
  input: {
    roles: InputRole[];
    identity: "anonymous";
    per_identity: "once";
    /** Per-identity cooldown between accepted inputs, ms. With `once` it only
     *  matters for a re-open; kept on the wire so a phone disables its control
     *  until a SERVER timestamp, never a local countdown. */
    cooldown_ms: number;
    moderation: "none";
  };
  visibility: {
    running_tally: Array<"host" | "mod">;
    reveal: Reveal;
    reveal_to: Array<"host" | "mod" | "guest" | "audience" | "set">;
    inputs: [];
  };
  timing: {
    opened_at?: string;
    collect_ms: number;
    reveal_at?: string;
    reveal_hold_ms: number;
    close_after_ms: number;
    stream_delay_ms: number;
    revealed_at?: string;
    closed_at?: string;
  };
  render: Array<{ surface: "set" | "host" | "guest" | "audience"; kind: string; style?: string }>;
}

export class InteractionError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

export function newInteractionId(random: () => number = Math.random): string {
  let s = "";
  for (let i = 0; i < 12; i++) s += ID_ALPHABET[Math.floor(random() * ID_ALPHABET.length)];
  return `ix_${s}`;
}

const clampInt = (v: unknown, min: number, max: number, dflt: number): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : dflt;
  return Math.max(min, Math.min(max, n));
};

/** Accepts both the contract's envelope (`spec.options`, `input.roles`,
 *  `visibility.reveal`, `timing.collect_ms`) and the short form Producer
 *  sends (`options: [a, b]`, `reveal`, `input.who`). Everything the server
 *  owns (id, state, version, opened_at, reveal_at) is stamped by the caller. */
export function parseInteractionCreate(body: unknown, ctx: { roomId: string; runId: string | null; id?: string }): InteractionDoc {
  if (!body || typeof body !== "object") throw new InteractionError(400, "invalid_request", "The request body must be a JSON object.");
  const b = body as Record<string, unknown>;
  if (b.type !== "vote") throw new InteractionError(422, "interaction_type", "v1 opens with type \"vote\".");
  const spec = (b.spec && typeof b.spec === "object" ? b.spec : {}) as Record<string, unknown>;
  const rawOptions = Array.isArray(spec.options) ? spec.options : Array.isArray(b.options) ? b.options : null;
  if (!rawOptions || rawOptions.length !== 2) throw new InteractionError(422, "interaction_options", "A vote needs exactly two options.");
  const options: VoteOption[] = rawOptions.map((o, i) => {
    if (typeof o === "string") return { id: i === 0 ? "a" : "b", label: o.trim().slice(0, 60) };
    if (o && typeof o === "object") {
      const r = o as { id?: unknown; label?: unknown };
      const id = typeof r.id === "string" && /^[a-z0-9_-]{1,16}$/i.test(r.id) ? r.id : i === 0 ? "a" : "b";
      const label = typeof r.label === "string" ? r.label.trim().slice(0, 60) : "";
      return { id, label };
    }
    return { id: i === 0 ? "a" : "b", label: "" };
  });
  if (options.some((o) => !o.label)) throw new InteractionError(422, "interaction_options", "Every option needs a label.");
  if (options[0].id === options[1].id) throw new InteractionError(422, "interaction_options", "Option ids must differ.");
  const prompt = typeof spec.prompt === "string" ? spec.prompt.trim().slice(0, 140) : typeof b.prompt === "string" ? b.prompt.trim().slice(0, 140) : "";

  const input = (b.input && typeof b.input === "object" ? b.input : {}) as Record<string, unknown>;
  let roles: InputRole[];
  if (Array.isArray(input.roles)) {
    roles = input.roles.filter((r): r is InputRole => r === "guest" || r === "audience" || r === "host" || r === "mod");
  } else {
    const who = input.who === "guest" || input.who === "audience" || input.who === "both" ? input.who : "both";
    roles = who === "both" ? ["guest", "audience"] : [who];
  }
  if (!roles.some((r) => r === "guest" || r === "audience")) throw new InteractionError(422, "interaction_input", "Someone must be able to vote: guest, audience or both.");

  const visibility = (b.visibility && typeof b.visibility === "object" ? b.visibility : {}) as Record<string, unknown>;
  const revealRaw = visibility.reveal ?? b.reveal;
  const reveal: Reveal = revealRaw === "manual" || revealRaw === "on_timer" || revealRaw === "live" ? revealRaw : "on_close";
  const timing = (b.timing && typeof b.timing === "object" ? b.timing : {}) as Record<string, unknown>;
  const collect_ms = clampInt(timing.collect_ms ?? b.collect_ms, 0, 60 * 60 * 1000, 0);
  if (reveal === "on_timer" && collect_ms <= 0) throw new InteractionError(422, "interaction_timing", "on_timer needs timing.collect_ms > 0.");

  const render = Array.isArray(b.render)
    ? (b.render as unknown[])
        .filter((r): r is { surface: string; kind: string } => !!r && typeof r === "object" && typeof (r as { kind?: unknown }).kind === "string")
        .filter((r) => ["set", "host", "guest", "audience"].includes(r.surface))
        .slice(0, 8)
        .map((r) => {
          const style = (r as { style?: unknown }).style;
          return { surface: r.surface as "set", kind: r.kind.slice(0, 24), ...(typeof style === "string" ? { style: style.slice(0, 24) } : {}) };
        })
    : [
        { surface: "set" as const, kind: "overlay", style: "bar" },
        { surface: "host" as const, kind: "panel_card" },
        { surface: "guest" as const, kind: "pick" },
        { surface: "audience" as const, kind: "controller", style: "choices" },
      ];

  return {
    id: ctx.id ?? newInteractionId(),
    room_id: ctx.roomId,
    run_id: ctx.runId,
    type: "vote",
    state: "open",
    version: 0,
    spec: { prompt, options },
    input: { roles, identity: "anonymous", per_identity: "once", cooldown_ms: clampInt(input.cooldown_ms, 0, 600_000, 0), moderation: "none" },
    visibility: { running_tally: ["host", "mod"], reveal, reveal_to: ["host", "mod", "guest", "audience", "set"], inputs: [] },
    timing: { collect_ms, reveal_hold_ms: clampInt(timing.reveal_hold_ms ?? b.reveal_hold_ms, 0, 60_000, 0), close_after_ms: clampInt(timing.close_after_ms, 0, 3_600_000, 0), stream_delay_ms: clampInt(timing.stream_delay_ms, 0, 60_000, 0) },
    render,
  };
}

// ── The state machine ────────────────────────────────────────────────────────

export type Transition = "open" | "reveal" | "close" | "cancel";

/** Which transitions are legal from a state. `open` = start collecting;
 *  `reveal` = show results (or ARM the timed reveal — the server fires it);
 *  `close` = archive. `revealed` is never asked for by name. */
export const LEGAL: Record<InteractionState, Transition[]> = {
  draft: ["open", "cancel"],
  open: ["open", "cancel", "close"],
  collecting: ["reveal", "close", "cancel"],
  revealed: ["close", "cancel"],
  closed: [],
  cancelled: [],
};

export function nextState(from: InteractionState, t: Transition): InteractionState {
  if (!LEGAL[from].includes(t)) throw new InteractionError(409, "interaction_state", `Cannot ${t} an interaction that is ${from}.`);
  switch (t) {
    case "open":
      return "collecting";
    case "reveal":
      return "revealed";
    case "close":
      return "closed";
    case "cancel":
      return "cancelled";
  }
}

/** True when this role may input right now. */
export function mayInput(doc: Pick<InteractionDoc, "state" | "input">, role: InputRole): boolean {
  return doc.state === "collecting" && doc.input.roles.includes(role);
}
