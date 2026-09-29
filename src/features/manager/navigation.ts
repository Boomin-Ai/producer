export type StageTab = "drafts" | "review" | "scheduled" | "failed" | "collabs";
export const STAGE_TABS: { id: StageTab; label: string }[] = [
  { id: "drafts", label: "Drafts" },
  { id: "review", label: "In Review" },
  { id: "scheduled", label: "Scheduled" },
  { id: "failed", label: "Failed" },
  { id: "collabs", label: "Collab Invites" },
];
export type ParentLocation = { view: "overview" } | { view: "stages"; tab: StageTab } | { view: "collection"; collectionId: string };
export type UnitLocation = { view: "unit"; unitId: string; returnTo: ParentLocation };
export type ManagerLocation =
  | ParentLocation
  | { view: "compose" }
  | UnitLocation
  | { view: "part"; unitId: string; partId: string; returnTo: ParentLocation }
  | { view: "post"; socialPostId: string; returnTo: ParentLocation | UnitLocation };

export const OVERVIEW: ParentLocation = { view: "overview" };
export function parentOf(location: ManagerLocation): ParentLocation | UnitLocation | null {
  if (location.view === "overview") return null;
  if (location.view === "collection" || location.view === "stages" || location.view === "compose") return OVERVIEW;
  return location.returnTo;
}
