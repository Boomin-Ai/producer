import type { FilterOp, FilterState } from "./filters";
import type { RoomConfig } from "./roomConfig";

/** Merge against the current room document, never the one from editor mount. */
export function withSourceFilters(room: RoomConfig, source: string, chain: FilterState[]): RoomConfig {
  const extras = room.sources.extras ?? [];
  if (!extras.some(extra => extra.id === source)) return room;
  return { ...room, sources: { ...room.sources, extras: extras.map(extra =>
    extra.id === source ? { ...extra, filters: chain } : extra) } };
}

/** Slider edits must finish native mutation AND persistence in click order. */
export function filterEditQueue(execute: (op: FilterOp) => Promise<FilterState[]>) {
  let tail: Promise<unknown> = Promise.resolve();
  return (op: FilterOp): Promise<FilterState[]> => {
    const result = tail.then(() => execute(op));
    tail = result.catch(() => {});
    return result;
  };
}
