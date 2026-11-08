import type { LiveItem } from './ipc';
import type { RoomExtra } from './roomConfig';

/** Keep Windows camera restores on the device actually selected in the engine. */
export function withWindowsCameraDevices(
  extras: RoomExtra[] | undefined,
  items: readonly Pick<LiveItem, 'id' | 'kind' | 'device'>[] | undefined,
  platform: string | undefined,
): RoomExtra[] | undefined {
  if (platform !== 'win' || !extras || !items) return extras;
  const cameras = new Map(items.filter(item => item.kind === 'camera' && item.device).map(item => [item.id, item.device!]));
  let changed = false;
  const next = extras.map(extra => {
    const device = cameras.get(extra.id);
    if (extra.spec.kind !== 'camera' || !device || extra.spec.device === device) return extra;
    changed = true;
    return { ...extra, spec: { ...extra.spec, device } };
  });
  return changed ? next : extras;
}
