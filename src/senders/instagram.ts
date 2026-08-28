// Instagram sender — BYO Instagram Login (Business) app, Development Mode.
// The same container flow the hosted engine runs, self-hosted: create a
// media container from a public URL, poll until Meta finishes processing,
// then publish. Each step checkpoints so a crashed tick resumes.

import type { JobInput, PlatformSender, PreflightIssue, StepResult } from "./types";
import { SendError, form, graphCall, tagList } from "./types";

const GRAPH = "https://graph.instagram.com/v22.0";

export const instagramSender: PlatformSender = {
  platform: "instagram",

  capabilities() {
    return {
      rateLimit: { type: "rolling_window", max: 50, windowSeconds: 86400 },
      media: { kinds: ["image", "reel"] },
      text: { maxChars: 2200 },
      features: { native_scheduling: false },
    };
  },

  preflight(input: JobInput): PreflightIssue[] {
    const issues: PreflightIssue[] = [];
    if (!input.mediaUrl) {
      issues.push({ code: "media_required", message: "Instagram posts require one image or one video.", field: "media" });
    }
    if ((input.caption?.length ?? 0) > 2200) {
      issues.push({ code: "caption_too_long", message: "Instagram captions max out at 2,200 characters.", field: "text" });
    }
    return issues;
  },

  async publish(input, checkpoint, accessToken, channel): Promise<StepResult> {
    const igUserId = channel.external_id;

    // Step 1: create the media container.
    if (!checkpoint.container_id) {
      const params = form({
        access_token: accessToken,
        caption: input.caption ?? undefined,
        cover_url: typeof input.overrides.cover_url === "string" ? input.overrides.cover_url : undefined,
      });
      if (input.mediaKind === "video") {
        params.set("media_type", "REELS");
        params.set("video_url", input.mediaUrl!);
        const feed = input.overrides.feed ?? input.overrides.share_to_feed;
        if (typeof feed === "boolean") params.set("share_to_feed", feed ? "true" : "false");
      } else {
        params.set("image_url", input.mediaUrl!);
      }
      const collaborators = tagList(input.overrides.collaborators, 3);
      if (collaborators.length) params.set("collaborators", JSON.stringify(collaborators));

      const container = await graphCall<{ id: string }>(`${GRAPH}/${igUserId}/media`, {
        method: "POST",
        body: params,
      });
      // Persist the id BEFORE anything consumes it (the idempotency rule).
      return { done: false, retryInSeconds: 15, checkpoint: { ...checkpoint, container_id: container.id } };
    }

    // Step 2: wait for Meta to finish processing.
    if (!checkpoint.container_ready) {
      const status = await graphCall<{ status_code?: string; status?: string }>(
        `${GRAPH}/${checkpoint.container_id}?${form({ fields: "status_code,status", access_token: accessToken })}`,
      );
      const code = String(status.status_code ?? status.status ?? "").toUpperCase();
      if (code === "ERROR" || code === "EXPIRED") {
        throw new SendError("permanent", `Instagram could not process the media (${code}).`);
      }
      if (code !== "FINISHED" && code !== "PUBLISHED") {
        return { done: false, retryInSeconds: 30, checkpoint };
      }
      checkpoint = { ...checkpoint, container_ready: true };
    }

    // Step 3: publish + fetch the permalink.
    const published = await graphCall<{ id: string }>(`${GRAPH}/${igUserId}/media_publish`, {
      method: "POST",
      body: form({ access_token: accessToken, creation_id: String(checkpoint.container_id) }),
    });
    const media = await graphCall<{ permalink?: string }>(
      `${GRAPH}/${published.id}?${form({ fields: "permalink", access_token: accessToken })}`,
    ).catch(() => ({ permalink: undefined }));
    return {
      done: true,
      externalId: published.id,
      externalUrl: media.permalink,
      checkpoint,
    };
  },
};
