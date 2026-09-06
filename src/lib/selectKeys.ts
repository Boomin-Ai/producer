/** The custom Select's keyboard model, as pure math (v0.4.32).
 *
 * One reducer drives every `<Select>` in the app (components/Select.tsx):
 * open / close, the highlighted row, arrow travel that skips disabled
 * options and wraps at the ends, Home / End, Enter / Space to commit,
 * Escape to close, and type-ahead (letters typed within TYPEAHEAD_MS
 * accumulate into a prefix; the first enabled option whose label starts
 * with it — searched from just past the highlight, wrapping — is
 * highlighted). No DOM, no React: the server's vitest runs it.
 */

export const TYPEAHEAD_MS = 700;

export interface SelectOptionLike {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectKeyState {
  open: boolean;
  /** Index into the options, or -1 for none. */
  highlight: number;
  /** Type-ahead buffer and the clock of its last key. */
  typed: string;
  typedAt: number;
}

export const CLOSED_SELECT: SelectKeyState = { open: false, highlight: -1, typed: "", typedAt: 0 };

export type SelectKeyEvent =
  | { type: "open"; selectedIndex: number }
  | { type: "close" }
  | { type: "hover"; index: number }
  | { type: "key"; key: string; now: number; selectedIndex: number };

export interface SelectKeyResult {
  state: SelectKeyState;
  /** The reducer wants the option at this index committed (Enter, Space,
   * or an arrow while CLOSED — native selects change value on arrows). */
  commit?: number;
  /** The key was handled — the caller prevents the default. */
  handled: boolean;
}

const enabledIndexes = (opts: readonly SelectOptionLike[]): number[] =>
  opts.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);

/** The next enabled index `dir` steps from `from`, wrapping. -1 when none. */
export function stepIndex(opts: readonly SelectOptionLike[], from: number, dir: 1 | -1): number {
  const en = enabledIndexes(opts);
  if (!en.length) return -1;
  if (from < 0) return dir === 1 ? en[0] : en[en.length - 1];
  const pos = en.indexOf(from);
  if (pos < 0) {
    // Highlight sits on a disabled row (state from before it was disabled):
    // travel to the nearest enabled one in that direction.
    const after = en.find((i) => (dir === 1 ? i > from : i < from));
    return after ?? (dir === 1 ? en[0] : en[en.length - 1]);
  }
  return en[(pos + dir + en.length) % en.length];
}

/** Type-ahead: the first enabled option whose label starts with `prefix`
 * (case-insensitive), searched from just past `from` and wrapping. A
 * one-letter prefix therefore CYCLES through the options sharing it. */
export function typeaheadIndex(opts: readonly SelectOptionLike[], prefix: string, from: number): number {
  const p = prefix.toLowerCase();
  if (!p) return -1;
  const n = opts.length;
  // A repeated single letter cycles; a longer prefix starts from the top so
  // "ma" finds "Manager" even when the highlight sits past it.
  const start = p.length === 1 ? from + 1 : 0;
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    const o = opts[i];
    if (!o.disabled && o.label.toLowerCase().startsWith(p)) return i;
  }
  return -1;
}

const isPrintable = (key: string) => key.length === 1 && key !== " ";

export function selectKeyReduce(state: SelectKeyState, ev: SelectKeyEvent, opts: readonly SelectOptionLike[]): SelectKeyResult {
  switch (ev.type) {
    case "open": {
      const h = ev.selectedIndex >= 0 && !opts[ev.selectedIndex]?.disabled ? ev.selectedIndex : stepIndex(opts, -1, 1);
      return { state: { open: true, highlight: h, typed: "", typedAt: 0 }, handled: true };
    }
    case "close":
      return { state: { ...CLOSED_SELECT }, handled: true };
    case "hover":
      if (!state.open || ev.index < 0 || ev.index >= opts.length || opts[ev.index].disabled) return { state, handled: false };
      return { state: { ...state, highlight: ev.index }, handled: true };
    case "key": {
      const { key, now } = ev;
      if (!state.open) {
        // Closed trigger: arrows change the value in place (native
        // behaviour), Enter / Space / Alt+Down open, letters type-ahead
        // straight into a commit.
        if (key === "ArrowDown" || key === "ArrowUp") {
          const i = stepIndex(opts, ev.selectedIndex, key === "ArrowDown" ? 1 : -1);
          return i >= 0 ? { state, commit: i, handled: true } : { state, handled: true };
        }
        if (key === "Enter" || key === " " || key === "Spacebar") {
          return selectKeyReduce(state, { type: "open", selectedIndex: ev.selectedIndex }, opts);
        }
        if (isPrintable(key)) {
          const typed = now - state.typedAt < TYPEAHEAD_MS ? state.typed + key : key;
          const i = typeaheadIndex(opts, typed, ev.selectedIndex);
          const next = { ...state, typed, typedAt: now };
          return i >= 0 ? { state: next, commit: i, handled: true } : { state: next, handled: true };
        }
        return { state, handled: false };
      }
      // Open list.
      switch (key) {
        case "Escape":
          return { state: { ...CLOSED_SELECT }, handled: true };
        case "Tab":
          return { state: { ...CLOSED_SELECT }, handled: false };
        case "ArrowDown":
          return { state: { ...state, highlight: stepIndex(opts, state.highlight, 1), typed: "" }, handled: true };
        case "ArrowUp":
          return { state: { ...state, highlight: stepIndex(opts, state.highlight, -1), typed: "" }, handled: true };
        case "Home":
          return { state: { ...state, highlight: stepIndex(opts, -1, 1), typed: "" }, handled: true };
        case "End":
          return { state: { ...state, highlight: stepIndex(opts, -1, -1), typed: "" }, handled: true };
        case "Enter":
        case " ":
        case "Spacebar": {
          const h = state.highlight;
          if (h >= 0 && h < opts.length && !opts[h].disabled) return { state: { ...CLOSED_SELECT }, commit: h, handled: true };
          return { state: { ...CLOSED_SELECT }, handled: true };
        }
        default: {
          if (!isPrintable(key)) return { state, handled: false };
          const typed = now - state.typedAt < TYPEAHEAD_MS ? state.typed + key : key;
          const i = typeaheadIndex(opts, typed, state.highlight);
          return { state: { ...state, typed, typedAt: now, highlight: i >= 0 ? i : state.highlight }, handled: true };
        }
      }
    }
  }
}
