import type { Collection, ContentUnit, ManagerSnapshot, SocialPost, UnitPart } from "./contracts";
import { managerFixture } from "./fixtures";

/** Data boundary for the dev preview. Hosted implementation follows in M2. */
export interface ManagerReadApi {
  readonly endpointId: string;
  overview(): Promise<{ posts: SocialPost[]; upcoming: ContentUnit[] }>;
  collections(): Promise<Collection[]>;
  units(collectionId?: string): Promise<ContentUnit[]>;
  parts(unitId: string): Promise<UnitPart[]>;
  post(postId: string): Promise<SocialPost | null>;
}

export function fixtureManagerApi(snapshot: ManagerSnapshot = managerFixture): ManagerReadApi {
  return {
    endpointId: "fixture",
    async overview() { return { posts: snapshot.posts, upcoming: snapshot.units.filter((unit) => unit.stage === "scheduled") }; },
    async collections() { return snapshot.collections; },
    async units(collectionId) { return collectionId ? snapshot.units.filter((unit) => unit.collectionId === collectionId) : snapshot.units; },
    async parts(unitId) { return snapshot.parts.filter((part) => part.unitId === unitId).sort((a, b) => a.index - b.index); },
    async post(postId) { return snapshot.posts.find((post) => post.id === postId) ?? null; },
  };
}
