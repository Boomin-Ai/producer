import type { SceneItemLook, RoomConfig } from "./roomConfig";
import type { LiveTransformPatch } from "./sourceSpec";
import { expandSlotBindings, lookPatch, slotOfGuest } from "./slotMath";

export interface ScenePlanItem {
  id: string;
  kind: string;
  visible?: boolean;
  muted?: boolean;
  x?: number; y?: number; w?: number; h?: number; z?: number;
}
export interface SceneChange { id: string; patch: LiveTransformPatch; muted?: boolean }

/** Missing/invalid selection always falls back to the first saved scene.
 * An uninitialized look opens empty; another scene's sources are never a default. */
export function openingScene(config: RoomConfig) {
  return config.scenes.find(scene => scene.id === config.active_scene) ?? config.scenes[0];
}

/** A complete cut, built from engine truth (or the full restore catalog),
 * never the subset React happened to render before source creation finished. */
export function scenePlan(
  look: Record<string, SceneItemLook>,
  items: ScenePlanItem[],
  bindings: Record<string, string>,
  restoring = false,
): SceneChange[] {
  const exists = new Set(items.map(item => item.id));
  const changes = new Map<string, SceneChange>();
  for (const item of items) {
    const slot = item.kind === "guest" ? slotOfGuest(bindings, item.id) : undefined;
    if (item.kind === "guest" && !slot && !(item.id in look)) {
      // Hot reopen keeps admitted, unbound guests in their current state.
      if (restoring) changes.set(item.id, { id: item.id,
        patch: { visible: !!item.visible, x: item.x, y: item.y, w: item.w, h: item.h, z: item.z },
        muted: item.muted ?? true });
    } else if (!(item.id in look) || (slot && !(slot in look))) {
      changes.set(item.id, { id: item.id, patch: { visible: false },
        ...(restoring || item.kind === "guest" ? { muted: true } : {}) });
    }
  }
  const entries = expandSlotBindings(Object.entries(look).filter(([id]) => exists.has(id)), bindings, exists);
  const ordered = [...entries.filter(([, entry]) => !entry.visible),
    ...entries.filter(([, entry]) => entry.visible).sort((a, b) => (a[1].z ?? 0) - (b[1].z ?? 0))];
  let z = 0;
  for (const [id, entry] of ordered) {
    const boundGuest = bindings[slotOfGuest(bindings, id) ?? ""] === id;
    changes.set(id, { id, patch: lookPatch(entry, !!entry.visible, entry.visible ? z++ : undefined),
      ...(restoring || boundGuest ? { muted: !entry.visible } : {}) });
  }
  return [...changes.values()];
}
