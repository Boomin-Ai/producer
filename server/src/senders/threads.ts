// Threads sender — BYO Threads app, Development Mode. Text posts are the
// zero-friction path; image/video posts use the two-step container flow
// with the capability gateway supplying the public URL.
//
// Platform params (per the Threads publishing docs):
//   reply_control    — everyone | accounts_you_follow | mentioned_only
//   topic_tag        — one per post, 1-50 chars, no periods or ampersands
//   link_attachment  — preview-card URL, TEXT posts only

import type { JobInput, PlatformSender, PreflightIssue, StepResult } from "./types";
import { form, graphCall } from "./types";

const GRAPH = "https://graph.threads.com/v1.0";
const REPLY_CONTROLS = new Set(["everyone", "accounts_you_follow", "mentioned_only"]);

function topicTag(overrides: Record<string, unknown>): string | undefined {
  const raw = typeof overrides.topic_tag === "string" ? overrides.topic_tag.trim().replace(/^#/, "") : "";
  return raw ? raw : undefined;
}

export const threadsSender: PlatformSender = {
  platform: "threads",

  capabilities() {
    return {
      media: { kinds: ["image", "video"], image_max_bytes: 8 * 1024 * 1024, video_max_bytes: 1024 * 1024 * 1024 },
      text: { maxChars: 500 },
      features: {
        native_scheduling: false,
        text_only: true,
        topic_tag: true,
        link_attachment: "text_only",
        reply_control: [...REPLY_CONTROLS],
      },
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
    const tag = topicTag(input.overrides);
    if (tag && (tag.length > 50 || /[.&]/.test(tag))) {
      issues.push({
        code: "topic_tag_invalid",
        message: "Topic tags are 1-50 characters and cannot contain periods or ampersands.",
        field: "overrides.topic_tag",
      });
    }
    if (typeof input.overrides.link_attachment === "string" && input.overrides.link_attachment && input.mediaUrl) {
      issues.push({
        code: "link_attachment_text_only",
        message: "Threads link attachments only work on text-only posts — remove the media or the link.",
        field: "overrides.link_attachment",
      });
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
        topic_tag: topicTag(input.overrides),
      });
      const reply = input.overrides.reply_control;
      if (typeof reply === "string" && REPLY_CONTROLS.has(reply)) {
        params.set("reply_control", reply);
      }
      if (input.mediaUrl && input.mediaKind === "video") {
        params.set("media_type", "VIDEO");
        params.set("video_url", input.mediaUrl);
      } else if (input.mediaUrl) {
        params.set("media_type", "IMAGE");
        params.set("image_url", input.mediaUrl);
      } else {
        params.set("media_type", "TEXT");
        const link = input.overrides.link_attachment;
        if (typeof link === "string" && /^https?:\/\//i.test(link)) {
          params.set("link_attachment", link);
        }
      }
      const container = await graphCall<{ id: string }>(`${GRAPH}/${userId}/threads`, {
        method: "POST",
        body: params,
      });
      const next = { ...checkpoint, creation_id: container.id };
      // The docs recommend ~30s before publishing so processing completes;
      // text is usually instant, video needs the full wait.
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
