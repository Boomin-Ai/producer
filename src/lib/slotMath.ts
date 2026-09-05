/** Guest SLOT model, as pure math.
 *
 * A Guest slot (`gslot-N`) is scene furniture: a color source whose rect is
 * authored on the stage and stored in the scene's look. A guest source
 * (`guest-<uuid8>`) is transient — it is created when the roster says the
 * person is admitted and destroyed when they leave — so it carries NO
 * geometry of its own. Showing a guest binds them to a slot; the guest takes
 * the slot's rect AND its layer, and the slot itself hides at exactly the
 * same rect. Hiding the guest unbinds and the placeholder returns.
 *
 * Two invariants this module exists to hold:
 *
 *  1. A slot's rect NEVER changes because of occupancy. Hidden items in a
 *     look still receive their geometry (`lookPatch`), so a slot that is
 *     hidden at scene-apply time (because someone fills it) does not sit at
 *     whatever bounds the engine gave the source at creation — full frame —
 *     and then "re-expand" when the guest is hidden or the slot refills.
 *
 *  2. A guest filling a slot inherits the slot's z. The look is expanded so
 *     the guest is applied AS the slot (`expandSlotBindings`), and between
 *     applies the engine poll is reconciled against the binding
 *     (`guestSlotPatch`) so a guest that got pushed to the top of the stack
 *     by its own creation, or by a reorder that did not know about it, is put
 *     back at the slot's layer.
 */
import type { LiveTransformPatch } from "./ipc";

export interface LookEntry {
  visible: boolean;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  z?: number;
}

export interface Placed {
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
}

export const SLOT_PREFIX = "gslot-";
export const isSlotId = (id: string) => id.startsWith(SLOT_PREFIX);

/** The transform one look entry means for its item. Geometry rides along
 * whether or not the entry is visible — an item you cannot see still has a
 * place, and it must be there when it becomes visible again. `z` is the
 * caller's stacking index for visible items (the look's own z is only used
 * to ORDER them). */
export function lookPatch(l: LookEntry, visible: boolean, z?: number): LiveTransformPatch {
  const patch: LiveTransformPatch = { visible };
  if (z != null) patch.z = z;
  if (l.x != null && l.y != null && l.w != null && l.h != null) {
    patch.x = l.x;
    patch.y = l.y;
    patch.w = l.w;
    patch.h = l.h;
  }
  return patch;
}

/** Expand a scene look over the slot bindings: a slot bound to a guest that
 * exists yields the GUEST at the slot's entry (same rect, same visibility,
 * same layer) and the slot itself hidden at that rect. Bindings to guests
 * that do not exist (left, or not admitted yet) leave the slot as authored.
 * Entries are otherwise passed through untouched, in order. */
export function expandSlotBindings(
  entries: [string, LookEntry][],
  bindings: Record<string, string>,
  exists: Set<string>,
): [string, LookEntry][] {
  const out: [string, LookEntry][] = [];
  for (const [id, l] of entries) {
    const guest = isSlotId(id) ? bindings[id] : undefined;
    if (guest && exists.has(guest)) {
      out.push([guest, { ...l }]);
      out.push([id, { ...l, visible: false }]);
    } else {
      out.push([id, l]);
    }
  }
  return out;
}

const EPS = 0.5;

/** What a shown guest owes the slot it fills: the slot's rect, and its
 * layer. Null when nothing needs to move. Layer equality is "adjacent":
 * OBS re-inserts an item at a position by detaching it first, so the guest
 * lands one above or one below the (hidden) slot depending on where it came
 * from — both mean "at the slot's layer" for everything else in the stack. */
export function guestSlotPatch(slot: Placed, guest: Placed): LiveTransformPatch | null {
  const patch: LiveTransformPatch = {};
  if (
    Math.abs(slot.x - guest.x) > EPS ||
    Math.abs(slot.y - guest.y) > EPS ||
    Math.abs(slot.w - guest.w) > EPS ||
    Math.abs(slot.h - guest.h) > EPS
  ) {
    patch.x = slot.x;
    patch.y = slot.y;
    patch.w = slot.w;
    patch.h = slot.h;
  }
  if (Math.abs(slot.z - guest.z) > 1) patch.z = slot.z;
  return Object.keys(patch).length ? patch : null;
}

/** The slot a guest is bound to, if any. */
export function slotOfGuest(bindings: Record<string, string>, guestId: string): string | null {
  for (const [slot, g] of Object.entries(bindings)) if (g === guestId) return slot;
  return null;
}
