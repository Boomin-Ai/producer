import type { Interaction } from "./ipc";

/** Stable across server snapshots (newest first) and live frames. */
export function newestVotes(votes: Interaction[]): Interaction[] {
  const time = (vote: Interaction) => Date.parse(vote.timing.opened_at ?? "") || 0;
  return [...votes].sort((a, b) => time(b) - time(a) || b.id.localeCompare(a.id));
}

export function activeRoomVote(votes: Interaction[]): Interaction | null {
  const ordered = newestVotes(votes).filter(v => v.type === "vote");
  return ordered.find(v => v.state === "collecting")
    ?? ordered.find(v => v.state === "open")
    ?? ordered.find(v => v.state === "revealed" || v.state === "closed") ?? null;
}

/** Keep cancellation tombstones so a delayed snapshot cannot revive a vote. */
export function mergeRoomVote(votes: Map<string, Interaction>, next: Interaction, snapshot = false): boolean {
  const current = votes.get(next.id);
  if (current && (current.version > next.version || (snapshot && current.version === next.version))) return false;
  votes.set(next.id, next);
  return true;
}
