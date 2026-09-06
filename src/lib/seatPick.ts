/** The Mods panel's "+" sheet: who can be seated. Pure so the filter is
 * testable — the member list comes from the Access tab's own `team` API. */
import type { Member } from "./accessDiff";

/** Team owners/admins/editors are hosts by brand role (memberRoomRole):
 * seating them is a no-op the door would refuse, so they never appear. */
export function isTeamHost(m: Pick<Member, "type" | "role">): boolean {
  return m.type === "team" && (m.role === "owner" || m.role === "admin" || m.role === "editor");
}

export function seatCandidates(members: readonly Member[] | null | undefined, seatedUserIds: Iterable<string>): Member[] {
  const seated = new Set(seatedUserIds);
  return (members ?? []).filter((m) => !seated.has(m.user_id) && !isTeamHost(m));
}

export function memberLabel(m: Pick<Member, "name" | "email">): string {
  return (m.name && m.name.trim()) || m.email;
}

/** Seat is pressable only once a real member is chosen. */
export function canSeat(pick: string, candidates: readonly Pick<Member, "id">[]): boolean {
  return pick !== "" && candidates.some((m) => m.id === pick);
}
