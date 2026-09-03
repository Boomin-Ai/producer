// The room keymap, as data — one registry the stage editor reads and the
// Settings sheet rebinds. Overrides live in localStorage; reads happen at
// keydown time, so a rebind applies instantly with no event plumbing.

export interface KeyBinding {
  id: string;
  label: string;
  /** Default `KeyboardEvent.key` value. */
  def: string;
}

/** Rebindable, single-key stage actions. Fixed chords (⌘1–9 scene cuts,
 * arrow nudges, ⇧/⌥ modifiers, Esc) are listed in Settings for reference
 * but deliberately not rebindable — they are the grammar, not preferences. */
export const KEYMAP: KeyBinding[] = [
  { id: "stage.delete", label: "Remove selected source", def: "Delete" },
  { id: "stage.straighten", label: "Straighten selected (⌥ also clears crop)", def: "r" },
  { id: "stage.layer_up", label: "Bring layer forward", def: "]" },
  { id: "stage.layer_down", label: "Send layer back", def: "[" },
];

const LS = "producer.keys.v1";

function overrides(): Record<string, string> {
  try {
    const raw = localStorage.getItem(LS);
    const v = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    return Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "string")) as Record<string, string>;
  } catch {
    return {};
  }
}

export function getKey(id: string): string {
  const def = KEYMAP.find((b) => b.id === id)?.def ?? "";
  return overrides()[id] ?? def;
}

export function setKey(id: string, key: string) {
  try {
    localStorage.setItem(LS, JSON.stringify({ ...overrides(), [id]: key }));
  } catch {
    /* storage unavailable — binding stays default */
  }
}

export function resetKey(id: string) {
  try {
    const o = overrides();
    delete o[id];
    localStorage.setItem(LS, JSON.stringify(o));
  } catch {
    /* ignore */
  }
}

/** Match at keydown. Case-insensitive for letters; the default Delete
 * binding also answers to Backspace (Mac keyboards label it delete). */
export function keyIs(e: { key: string }, id: string): boolean {
  const k = getKey(id);
  if (k === "Delete" && e.key === "Backspace") return true;
  return e.key.toLowerCase() === k.toLowerCase();
}

/** Human label for a key chip. */
export function displayKey(k: string): string {
  if (k === "Delete") return "⌫ Delete";
  if (k === " ") return "Space";
  if (k === "Escape") return "Esc";
  return k.length === 1 ? k.toUpperCase() : k;
}
