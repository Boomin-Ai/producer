/** The Manager UI contract. IDs are backend identities, not array positions. */
export type Stage = "studio" | "draft" | "review" | "scheduled" | "processing" | "published" | "partial" | "failed";
export type PartKind = "shot" | "segment" | "slide";

export interface Collection {
  id: string;
  name: string;
  kind: "collection" | "series" | "featured" | "recordings";
  description?: string;
}

export interface ContentUnit {
  id: string;
  collectionId: string | null;
  title: string;
  type: string;
  stage: Stage;
  caption: string;
  partIds: string[];
  postIds: string[];
  selectedChannelIds?: string[];
  /** One target configuration per post destination, matching hosted unit distributions. */
  distributions?: UnitDistribution[];
  scheduledAt?: string;
  publishedAt?: string;
  recording?: { id: string; started_at: string; duration_ms: number; localAvailable?: boolean; localPath?: string; storageStatus?: "local" | "synced" };
}

export interface UnitDistribution {
  id?: string;
  status?: string;
  publishedPostId?: string | null;
  channelId: string;
  platform: string;
  handle: string;
  presets: Record<string, boolean | string | string[]>;
}

export interface UnitPart {
  id: string;
  unitId: string;
  index: number;
  kind: PartKind;
  status: "planned" | "working" | "frames_rendering" | "frames_ready" | "clip_rendering" | "ready" | "failed";
  label: string;
  prompt: string;
  /** Authored prompt sheet from unit_parts.prompt_doc; prompt is the legacy fallback. */
  promptDoc?: { text: string; mentions: Array<Record<string, unknown>> } | null;
  source?: "generated" | "real";
  model?: string | null;
  spec?: Record<string, unknown>;
  /** API selected clip and render history are distinct: a take count alone is not media. */
  clipUrl?: string | null;
  takes?: Array<{ id: string; takeNo: number; clipUrl: string | null }>;
  mediaUrl?: string;
  takeCount?: number;
}

/** Publishable file in a unit's distribution folder, ordered by files.index. */
export interface UnitMedia {
  id: string;
  unitId: string;
  index: number;
  name: string;
  type: "image" | "video";
  url?: string;
}

export interface SocialPost {
  id: string;
  unitId: string | null;
  integrationId: string;
  platform: string;
  account: string;
  mediaId: string;
  type: string;
  title: string;
  caption: string;
  status: "pending" | "published" | "processing" | "failed";
  postedAt: string;
  permalink?: string;
  previewUrl?: string;
  mediaUrl?: string;
  originalMediaAvailable?: boolean;
  mediaArchiveStatus?: string;
  commentCount?: number;
  /** Published settings snapshot; separate posts from one unit may differ. */
  presets?: Record<string, boolean | string | string[]>;
}

export interface CollabInvite {
  id: string;
  account: string;
  title: string;
  status: "pending" | "accepted" | "declined";
}

export interface PostComment {
  id: string;
  commentId: string;
  postId: string;
  username: string;
  text: string;
  createdAt: string;
}

export interface ManagerSnapshot {
  source?: "hosted";
  workspaceName: string;
  collections: Collection[];
  units: ContentUnit[];
  parts: UnitPart[];
  mediaFiles?: UnitMedia[];
  posts: SocialPost[];
  invites: CollabInvite[];
}
