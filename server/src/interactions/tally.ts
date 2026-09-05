// The tally — the PURE half of counting. Aggregates only: counts per option,
// per participant kind, a total. Identities are salted hashes kept ONLY to
// enforce `per_identity: once`, capped so a very large audience never turns
// into a per-input table (above the cap dedupe is best-effort; the tally
// stays an aggregate). The sub of a token is never stored.

export type InputKind = "guest" | "audience";

export interface Tally {
  total: number;
  options: Record<string, number>;
  by_kind: Record<InputKind, number>;
}

export interface LiveTally extends Tally {
  /** identity hash → last accepted at (ms). Bounded by SEEN_CAP. */
  seen: Record<string, number>;
  seen_count: number;
}

/** Above this many distinct identities the DO stops remembering hashes and
 *  counts blind: a 10k-phone audience must never cost 10k rows anywhere. */
export const SEEN_CAP = 5000;

export function emptyTally(optionIds: readonly string[]): LiveTally {
  const options: Record<string, number> = {};
  for (const id of optionIds) options[id] = 0;
  return { total: 0, options, by_kind: { guest: 0, audience: 0 }, seen: {}, seen_count: 0 };
}

export type InputVerdict =
  | { accepted: true; tally: LiveTally; cooldown_until?: number }
  | { accepted: false; code: "input_invalid" | "input_already_counted" | "rate_limited"; cooldown_until?: number };

/** Count one input. `once` is absolute: an identity that already counted is
 *  refused for the life of the interaction. Pure — returns a new tally. */
export function applyInput(
  tally: LiveTally,
  input: { identity: string; kind: InputKind; value: unknown; now: number; cooldownMs: number },
): InputVerdict {
  if (typeof input.value !== "string" || !(input.value in tally.options)) return { accepted: false, code: "input_invalid" };
  const last = tally.seen[input.identity];
  if (last !== undefined) {
    // Once means once; the cooldown is what a phone shows meanwhile.
    return { accepted: false, code: "input_already_counted", cooldown_until: input.cooldownMs ? last + input.cooldownMs : undefined };
  }
  const next: LiveTally = {
    total: tally.total + 1,
    options: { ...tally.options, [input.value]: (tally.options[input.value] ?? 0) + 1 },
    by_kind: { ...tally.by_kind, [input.kind]: (tally.by_kind[input.kind] ?? 0) + 1 },
    seen: tally.seen_count < SEEN_CAP ? { ...tally.seen, [input.identity]: input.now } : tally.seen,
    seen_count: tally.seen_count + 1,
  };
  return { accepted: true, tally: next, ...(input.cooldownMs ? { cooldown_until: input.now + input.cooldownMs } : {}) };
}

/** The public aggregate — what persists and what anyone reads back. */
export function publicTally(t: LiveTally | Tally): Tally & { winner: string | null } {
  const entries = Object.entries(t.options);
  const max = Math.max(0, ...entries.map(([, n]) => n));
  const leaders = entries.filter(([, n]) => n === max && max > 0).map(([id]) => id);
  return { total: t.total, options: { ...t.options }, by_kind: { ...t.by_kind }, winner: leaders.length === 1 ? leaders[0] : null };
}
