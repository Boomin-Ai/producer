import { convertFileSrc } from "@tauri-apps/api/core";
import { guests, type Channel, type LocalRecording } from "../../lib/ipc";
import type { Collection, ContentUnit, ManagerSnapshot, PostComment, SocialPost, Stage, UnitMedia } from "./contracts";

interface DistributionDto {
  id: string;
  channel_id: string;
  platform: string;
  handle: string;
  status: string;
  published_social_post_id: string | null;
  caption_override: string | null;
  presets: Record<string, boolean | string | string[]>;
}
interface UnitDto {
  id: string;
  collection_id: string | null;
  title: string | null;
  type: string;
  stage: string;
  caption: string | null;
  scheduled_at: string | null;
  published_at: string | null;
  distributions: DistributionDto[];
}
interface PostDto {
  id: string;
  unit_id: string | null;
  channel_id: string | null;
  platform: string;
  media_id: string;
  post_type: string;
  caption: string;
  status: SocialPost["status"];
  posted_at: string | null;
  created_at: string;
  platform_permalink: string | null;
  thumbnail_url: string;
  media_url: string;
  original_media_available?: boolean | null;
  media_archive_status?: string | null;
  metrics?: { comments?: number } | null;
}
interface RecordingDto {
  capture_id: string;
  unit_id: string | null;
  started_at: string;
  duration_ms: number;
  storage_status: "local" | "synced";
}

/** Credentials and brand scope stay in Rust. This facade only performs CMS reads. */
async function read<T>(endpointId: string, path: string, signal?: AbortSignal): Promise<T> {
  const response = await guests.request(endpointId, "GET", `/v1/app/${path}`);
  signal?.throwIfAborted();
  if (!response.available || response.status < 200 || response.status >= 300 || !response.body) {
    throw new Error(`Boomin could not load ${path.split("?")[0]} (HTTP ${response.status}).`);
  }
  return response.body as T;
}

export async function loadHostedRecordings(endpointId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await guests.request(endpointId, "GET", "/v1/app/content/recordings");
  signal?.throwIfAborted();
  // Older hosts can still serve the existing library during a staged rollout.
  if (response.status === 404) return { recordings: [] };
  if (!response.available || response.status < 200 || response.status >= 300 || !response.body) {
    throw new Error(`Boomin could not load recordings (HTTP ${response.status}).`);
  }
  return { recordings: array<RecordingDto>(response.body as Record<string, unknown>, "recordings").map((row) => ({
    capture_id: row.capture_id, unit_id: row.unit_id, started_at: row.started_at,
    duration_ms: row.duration_ms, storage_status: row.storage_status,
  })) };
}

function array<T>(body: Record<string, unknown>, key: string): T[] {
  if (!Array.isArray(body[key])) throw new Error(`Boomin returned an invalid ${key} response.`);
  return body[key] as T[];
}

export async function loadHostedPostComments(endpointId: string, postId: string, signal?: AbortSignal): Promise<PostComment[]> {
  const body = await read<Record<string, unknown>>(endpointId, `content/post/comments?social_post_id=${encodeURIComponent(postId)}`, signal);
  return array<Record<string, unknown>>(body, "comments").map((row) => ({
    id: String(row.id), commentId: String(row.comment_id ?? row.id), postId,
    username: typeof row.username === "string" ? row.username : "Unknown",
    text: typeof row.text === "string" ? row.text : "",
    createdAt: typeof row.created_at === "string" ? row.created_at : typeof row.timestamp === "string" ? row.timestamp : "",
  }));
}

const stages: Record<string, Stage> = {
  studio: "studio", draft: "draft", review: "review", schedule: "scheduled",
  scheduled: "scheduled", processing: "processing", published: "published", partial: "partial", failed: "failed",
};
function mapUnit(row: UnitDto): ContentUnit {
  if (!stages[row.stage]) throw new Error(`Unsupported content stage: ${row.stage}`);
  return {
    id: row.id, collectionId: row.collection_id, title: row.title || row.caption?.split("\n")[0].slice(0, 100) || "Untitled post",
    type: row.type, stage: stages[row.stage], caption: row.caption ?? "", partIds: [], postIds: [],
    selectedChannelIds: row.distributions.map((d) => d.channel_id),
    distributions: row.distributions.map((d) => ({
      id: d.id, status: d.status, publishedPostId: d.published_social_post_id,
      channelId: d.channel_id, platform: d.platform, handle: d.handle,
      presets: { ...d.presets, ...(d.caption_override !== null ? { caption: d.caption_override } : {}) },
    })),
    scheduledAt: row.scheduled_at ?? undefined, publishedAt: row.published_at ?? undefined,
  };
}
export function mediaUrl(value?: string | null): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("/vault/")) return `https://cloud.boomin.ai${value}`;
  return /^https?:\/\//i.test(value) ? value : undefined;
}

export async function loadHostedCollections(endpointId: string, signal?: AbortSignal): Promise<Collection[]> {
  return array<Collection>(await read<Record<string, unknown>>(endpointId, "content/collections", signal), "collections")
    .map((row) => ({ id: row.id, name: row.name, kind: row.kind, description: row.description }));
}
export async function loadHostedUnits(endpointId: string, signal?: AbortSignal): Promise<ContentUnit[]> {
  return array<UnitDto>(await read<Record<string, unknown>>(endpointId, "content/units", signal), "units").map(mapUnit);
}
export async function loadHostedPosts(endpointId: string, signal?: AbortSignal): Promise<PostDto[]> {
  // Persist only fields this UI uses, never arbitrary provider metadata.
  return array<PostDto>(await read<Record<string, unknown>>(endpointId, "content/social-posts", signal), "posts").map((row) => ({
    id: row.id, unit_id: row.unit_id, channel_id: row.channel_id, platform: row.platform,
    media_id: row.media_id, post_type: row.post_type, caption: row.caption, status: row.status,
    posted_at: row.posted_at, created_at: row.created_at, platform_permalink: row.platform_permalink,
    thumbnail_url: row.thumbnail_url, media_url: row.media_url,
    original_media_available: row.original_media_available, media_archive_status: row.media_archive_status,
    metrics: row.metrics ? { comments: row.metrics.comments } : null,
  }));
}
export async function loadHostedManager(endpointId: string, workspaceName: string, channels: Channel[]): Promise<ManagerSnapshot> {
  // These inventory routes return complete arrays. Do not use the overview's
  // first page (or its 20 upcoming rows) as the workspace's entire inventory.
  const [collections, units, posts, recordings] = await Promise.all([
    loadHostedCollections(endpointId), loadHostedUnits(endpointId), loadHostedPosts(endpointId), loadHostedRecordings(endpointId),
  ]);
  return assembleHostedManager(workspaceName, channels, collections, units, posts, recordings);
}

/** Derived presentation never mutates query records or persisted raw data. */
export function assembleHostedManager(workspaceName: string, channels: Channel[], collections: Collection[], unitRows: ContentUnit[], postRows: PostDto[], recordingResponse: Record<string, unknown>): ManagerSnapshot {
  const units = unitRows.map((unit) => ({ ...unit, postIds: [] as string[] }));
  const unitById = new Map(units.map((unit) => [unit.id, unit]));
  for (const capture of array<RecordingDto>(recordingResponse, "recordings")) {
    const unit = capture.unit_id ? unitById.get(capture.unit_id) : undefined;
    if (unit) unit.recording = { id: capture.capture_id, started_at: capture.started_at, duration_ms: capture.duration_ms, storageStatus: capture.storage_status };
  }
  const posts = postRows.map((row): SocialPost => {
    const unit = row.unit_id ? unitById.get(row.unit_id) : undefined;
    const channel = channels.find((c) => c.id === row.channel_id);
    const distribution = unit?.distributions?.find((d) => d.channelId === row.channel_id);
    const handle = channel?.external_handle || distribution?.handle;
    return {
      id: row.id, unitId: row.unit_id, integrationId: row.channel_id ?? "", platform: row.platform,
      account: handle ? "@" + handle.replace(/^@/, "") : channel?.display_name || row.platform,
      mediaId: row.media_id, type: row.post_type,
      title: unit?.title || row.caption?.split("\n")[0].slice(0, 100) || "Untitled post",
      caption: row.caption, status: row.status, postedAt: row.posted_at || row.created_at,
      originalMediaAvailable: row.original_media_available ?? undefined, mediaArchiveStatus: row.media_archive_status ?? undefined,
      permalink: row.platform_permalink ?? undefined, previewUrl: mediaUrl(row.thumbnail_url), mediaUrl: mediaUrl(row.media_url),
      commentCount: row.metrics?.comments,
      presets: distribution?.presets,
    };
  });
  for (const post of posts) if (post.unitId) unitById.get(post.unitId)?.postIds.push(post.id);
  return { source: "hosted", workspaceName, collections, units, posts, parts: [], mediaFiles: [], invites: [] };
}

export async function createHostedLibraryEntry(endpointId: string, kind: "series" | "featured", name: string, requestId: string): Promise<{ collectionId: string; unitId?: string }> {
  const response = await guests.request(endpointId, "POST", "/v1/app/content/library", { kind, name, request_id: requestId });
  const result = response.body as { collection?: { id: string }; unit?: { id: string } } | undefined;
  if (!response.available || !result?.collection?.id) throw new Error("Boomin could not create this item. Your existing content has not changed.");
  return { collectionId: result.collection.id, unitId: result.unit?.id };
}

export async function createHostedCollectionUnit(endpointId: string, collectionId: string): Promise<ContentUnit> {
  const response = await guests.request(endpointId, "POST", "/v1/app/content/units", { collection_id: collectionId, stage: "draft" });
  const result = response.body as { unit?: UnitDto } | undefined;
  if (!response.available || !result?.unit?.id) throw new Error("Boomin could not create the unit.");
  return mapUnit(result.unit);
}

export async function renameHostedCollection(endpointId: string, collectionId: string, name: string): Promise<void> {
  // This existing collection-backed writer only updates supplied fields. The
  // older content PATCH schema defaults omitted metadata to {}, so use the
  // series title writer to preserve universe/settings metadata while renaming.
  const response = await guests.request(endpointId, "PATCH", `/v1/app/series/${collectionId}`, { title: name });
  if (!response.available || response.status < 200 || response.status >= 300) throw new Error("Boomin could not rename the collection.");
}

/** Local captures show immediately, even while provenance sync is pending. */
export function mergeLocalRecordings(snapshot: ManagerSnapshot, recordings: LocalRecording[]): ManagerSnapshot {
  const collections = [...snapshot.collections];
  const units = [...snapshot.units];
  const mediaFiles = [...(snapshot.mediaFiles ?? [])];
  for (const capture of recordings.filter((capture) => capture.status === "ready")) {
    const collectionId = capture.collection_id ?? `local-recordings-${capture.room_id}`;
    const unitId = capture.unit_id ?? `local-recording-${capture.id}`;
    if (!collections.some((collection) => collection.id === collectionId)) collections.push({ id: collectionId, name: `${capture.room_name} recordings`, kind: "recordings" });
    const index = units.findIndex((unit) => unit.id === unitId);
    const recording = { ...capture, localAvailable: true, storageStatus: "local" as const };
    if (index >= 0) units[index] = { ...units[index], recording };
    else units.push({ id: unitId, collectionId, title: `${capture.room_name} · ${new Date(capture.started_at).toLocaleString()}`, type: "long-video", stage: "studio", caption: "", postIds: [], partIds: [], recording });
    mediaFiles.push({ id: `capture-file-${capture.id}`, unitId, index: 0, name: capture.room_name, type: "video", url: convertFileSrc(capture.path) });
  }
  return { ...snapshot, collections, units, mediaFiles };
}

export async function loadHostedUnitMedia(endpointId: string, unitId: string, signal?: AbortSignal): Promise<UnitMedia[]> {
  // Same detail read as web: resolves this unit's distribution folder.
  const detail = await read<{ distribution_folder_id: string }>(endpointId, `content/units/${encodeURIComponent(unitId)}`, signal);
  if (!detail.distribution_folder_id) throw new Error("Boomin did not return this unit's media folder.");
  const response = await read<Record<string, unknown>>(endpointId, `files/list?folder_id=${encodeURIComponent(detail.distribution_folder_id)}`, signal);
  return array<{ id: string; name: string; type: string; index: number; content_url?: string; url?: string }>(response, "files")
    .filter((file) => file.type === "image" || file.type === "video")
    .map((file): UnitMedia => ({ id: file.id, unitId, name: file.name, index: file.index, type: file.type as UnitMedia["type"], url: mediaUrl(file.content_url || file.url) }))
    .sort((a, b) => a.index - b.index);
}
