// Facebook Pages sender — BYO Facebook Login app, Development Mode. A
// channel is one Page (external_id = page id, token = page access token).
// Photos and videos publish by URL in a single call — Facebook fetches
// the media itself, so this is the simplest sender in the registry.

import type { JobInput, PlatformSender, PreflightIssue, StepResult } from "./types";
import { form, graphCall } from "./types";

const GRAPH = "https://graph.facebook.com/v22.0";

export const facebookSender: PlatformSender = {
  platform: "facebook",

  capabilities() {
    return {
      media: { kinds: ["image", "video"] },
      text: { maxChars: 63206 },
      features: { native_scheduling: false, text_only: true },
    };
  },

  preflight(input: JobInput): PreflightIssue[] {
    const issues: PreflightIssue[] = [];
    if (!input.mediaUrl && !input.caption?.trim()) {
      issues.push({ code: "content_required", message: "A Facebook post needs text or media.", field: "text" });
    }
    return issues;
  },

  async publish(input, checkpoint, accessToken, channel): Promise<StepResult> {
    const pageId = channel.external_id;
    let result: { id?: string; post_id?: string };

    if (input.mediaUrl && input.mediaKind === "video") {
      result = await graphCall(`${GRAPH}/${pageId}/videos`, {
        method: "POST",
        body: form({
          access_token: accessToken,
          file_url: input.mediaUrl,
          description: input.caption ?? undefined,
        }),
      });
    } else if (input.mediaUrl) {
      result = await graphCall(`${GRAPH}/${pageId}/photos`, {
        method: "POST",
        body: form({
          access_token: accessToken,
          url: input.mediaUrl,
          message: input.caption ?? undefined,
        }),
      });
    } else {
      result = await graphCall(`${GRAPH}/${pageId}/feed`, {
        method: "POST",
        body: form({ access_token: accessToken, message: input.caption ?? "" }),
      });
    }

    const externalId = result.post_id ?? result.id ?? "";
    return {
      done: true,
      externalId,
      externalUrl: externalId ? `https://www.facebook.com/${externalId}` : undefined,
      checkpoint,
    };
  },
};
