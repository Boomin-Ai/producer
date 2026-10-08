import type { ManagerSnapshot } from "./contracts";

/** Deterministic preview data. These IDs never leave the fixture adapter. */
export const managerFixture: ManagerSnapshot = {
  workspaceName: "ATLANTIUM",
  collections: [
    { id: "coll-report", name: "The Atlantium Job Report", kind: "series", description: "Stories from the city's working world." },
    { id: "coll-lore", name: "ATL LORE — The City Talks", kind: "series" },
    { id: "coll-paycheck", name: "PAYCHECK — What Atlanta Earns", kind: "series" },
    { id: "coll-list", name: "THE LIST — Who’s Hiring in Atlanta", kind: "series", description: "Weekly openings from around Atlanta." },
    { id: "coll-corner", name: "Same Corner", kind: "collection" },
    { id: "coll-quick", name: "Quick clips", kind: "collection" },
    { id: "coll-brand", name: "Atlantium", kind: "collection" },
  ],
  units: [
    { id: "unit-list-001", collectionId: "coll-list", title: "THE LIST 001 — Atlanta is Hiring", type: "carousel", stage: "published", caption: "Five jobs inside Atlanta's historic Fox Theatre.", partIds: [], postIds: ["post-list-001", "post-list-002"], selectedChannelIds: ["ig-atlantium", "threads-atlantium"], distributions: [{ channelId: "ig-atlantium", platform: "instagram", handle: "@atlantium.ai", presets: { feed: true, location: "Atlanta" } }, { channelId: "threads-atlantium", platform: "threads", handle: "@atlantium.ai", presets: { reply_control: "accounts_you_follow", topic_tag: "AtlantaJobs" } }], publishedAt: "2026-08-15T21:55:00Z" },
    { id: "unit-report-001", collectionId: "coll-report", title: "A day in the city", type: "short-video", stage: "draft", caption: "", partIds: ["part-report-01"], postIds: [], selectedChannelIds: ["ig-atlantium", "threads-atlantium"], distributions: [{ channelId: "ig-atlantium", platform: "instagram", handle: "@atlantium.ai", presets: { feed: true } }, { channelId: "threads-atlantium", platform: "threads", handle: "@atlantium.ai", presets: {} }] },
    { id: "unit-lore-001", collectionId: "coll-lore", title: "The story of Peachtree", type: "short-video", stage: "review", caption: "What makes one street the heart of Atlanta?", partIds: [], postIds: [], selectedChannelIds: ["ig-atlantium"] },
    { id: "unit-quick-001", collectionId: "coll-quick", title: "Behind the scenes", type: "short-video", stage: "scheduled", caption: "A quick look at today's shoot.", partIds: [], postIds: [], selectedChannelIds: ["ig-atlantium"], scheduledAt: "2026-09-27T16:00:00Z" },
    { id: "unit-paycheck-001", collectionId: "coll-paycheck", title: "The salary question", type: "short-video", stage: "failed", caption: "", partIds: [], postIds: [], selectedChannelIds: ["ig-atlantium"] },
    { id: "unit-corner-001", collectionId: "coll-corner", title: "Net Revenue", type: "short-video", stage: "published", caption: "Net Revenue", partIds: [], postIds: ["post-corner-001"], publishedAt: "2026-06-11T19:31:00Z" },
    { id: "unit-in-production", collectionId: "coll-list", title: "THE LIST 002 — In production", type: "short-video", stage: "studio", caption: "", partIds: [], postIds: [] },
  ],
  parts: [
    { id: "part-report-01", unitId: "unit-report-001", index: 1, kind: "shot", status: "planned", label: "Opening shot", prompt: "Morning commute through downtown Atlanta." },
  ],
  mediaFiles: Array.from({ length: 7 }, (_, i) => ({ id: `file-list-0${i + 1}`, unitId: "unit-list-001", index: i, type: "image" as const, name: i === 0 ? "Atlanta is hiring — cover" : `Job ${i} — carousel image` })),
  posts: [
    { id: "post-list-001", unitId: "unit-list-001", integrationId: "ig-atlantium", platform: "instagram", account: "@atlantium.ai", mediaId: "17901234567890123", type: "carousel", title: "Atlanta is hiring", caption: "Five jobs inside Atlanta's historic Fox Theatre.", status: "published", postedAt: "2026-08-15T21:55:00Z", commentCount: 11, presets: { feed: true, location: "Atlanta" } },
    { id: "post-list-002", unitId: "unit-list-001", integrationId: "threads-atlantium", platform: "threads", account: "@atlantium.ai", mediaId: "17901234567890126", type: "carousel", title: "Atlanta is hiring", caption: "Five jobs inside Atlanta's historic Fox Theatre.", status: "published", postedAt: "2026-08-15T21:56:00Z", commentCount: 3, presets: { reply_control: "accounts_you_follow", topic_tag: "AtlantaJobs" } },
    { id: "post-corner-001", unitId: "unit-corner-001", integrationId: "ig-atlantium", platform: "instagram", account: "@atlantium.ai", mediaId: "17901234567890124", type: "short-video", title: "Net Revenue", caption: "Net Revenue", status: "published", postedAt: "2026-06-11T19:31:00Z", commentCount: 0 },
    { id: "post-unassigned", unitId: null, integrationId: "ig-atlantium", platform: "instagram", account: "@atlantium.ai", mediaId: "17901234567890125", type: "image", title: "A post already on Instagram", caption: "Imported from your connected account.", status: "published", postedAt: "2026-09-22T14:10:00Z", commentCount: 4 },
  ],
  invites: [{ id: "invite-001", account: "@atlcityguide", title: "Collaborate on a reel", status: "pending" }],
};
