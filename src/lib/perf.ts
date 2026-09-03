// Room-open ruler, upstream half. The room component measures itself from
// its own mount; what a person FEELS starts at the click on the home tile
// (and, on a cold start, at app launch). Stash the click so the room can
// report engine/applied/settled/veil from the moment the user acted.

let roomClickAt: number | null = null;

/** Call at the instant a room tile is clicked. */
export function markRoomClick() {
  roomClickAt = performance.now();
}

/** The click timestamp, consumed once by the room that mounts next. */
export function takeRoomClick(): number | null {
  const t = roomClickAt;
  roomClickAt = null;
  return t;
}
