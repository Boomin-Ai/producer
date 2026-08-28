// Threads sender — BYO Threads app, Development Mode. Text posts are the
// zero-friction path (no media bridge involved at all); image/video posts
// use the two-step container flow like Instagram, with the capability
// gateway supplying the public URL.

import type { JobInput, PlatformSender, PreflightIssue, StepResult } from "./types";
import { form, graphCall } from "./types";

const GRAPH = "https://graph.threads.net/v1.0";

export const threadsSender: PlatformSender = {
  platform: "threads",

  capabilities() {
    return {
      media: { kinds: ["image", "video"] },
      text: { maxChars: 500 },
      features: { native_scheduling: false, text_only: true },
    };
  },

  preflight(input: JobInput): PreflightIssue[] {
    const issues: PreflightIssue[] = [];
    if (!input.mediaUrl && !input.caption?.trim()) {
      issues.push({ code: "content_required", message: "A thread needs text or media.", field: "text" });
    }
    if ((input.caption?.length ?? 0) > 500) {
      issues.push({ code: "caption_too_long", message: "Threads posts max out at 500 characters.", field: "text" });
    }
    return issues;
  },

  async publish(input, checkpoint, accessToken, channel): Promise<StepResult> {
    const userId = channel.external_id;

    // Step 1: create the container (persist id before consuming it).
    if (!checkpoint.creation_id) {
      const params = form({
        access_token: accessToken,
        text: input.caption ?? undefined,
      });
      if (input.mediaUrl && input.mediaKind === "video") {
        params.set("media_type", "VIDEO");
        params.set("video_url", input.mediaUrl);
      } else if (input.mediaUrl) {
        params.set("media_type", "IMAGE");
        params.set("image_url", input.mediaUrl);
      } else {
        params.set("media_type", "TEXT");
      }
      const container = await graphCall<{ id: string }>(`${GRAPH}/${userId}/threads`, {
        method: "POST",
        body: params,
      });
      const next = { ...checkpoint, creation_id: container.id };
      // Text and images are usually ready instantly; videos process.
      return { done: false, retryInSeconds: input.mediaKind === "video" ? 30 : 5, checkpoint: next };
    }

    // Step 2: publish, then fetch the permalink.
    const published = await graphCall<{ id: string }>(`${GRAPH}/${userId}/threads_publish`, {
      method: "POST",
      body: form({ access_token: accessToken, creation_id: String(checkpoint.creation_id) }),
    });
    const post = await graphCall<{ permalink?: string }>(
      `${GRAPH}/${published.id}?${form({ fields: "permalink", access_token: accessToken })}`,
    ).catch(() => ({ permalink: undefined }));
    return { done: true, externalId: published.id, externalUrl: post.permalink, checkpoint };
  },
};
