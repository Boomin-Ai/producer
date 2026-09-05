/** The ON AIR order on the control-room home: the brand's main stage first,
 * then by creation (oldest first), id as the tiebreak. A FIXED order —
 * never by last_live_at, which changes the moment you leave a room and
 * made the cards trade places under the pointer. Pure; tested in
 * server/test/room-order.test.ts. */
export function sortRooms<T extends { id: string; created_at: string }>(rooms: readonly T[], mainId: string | null): T[] {
  return [...rooms].sort((a, b) => {
    if (a.id === mainId) return -1;
    if (b.id === mainId) return 1;
    return a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
  });
}
