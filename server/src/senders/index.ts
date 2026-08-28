import type { PlatformSender } from "./types";
import { instagramSender } from "./instagram";
import { facebookSender } from "./facebook";
import { threadsSender } from "./threads";

// The registry. Adding a platform to producer-server is: one sender file
// + one line here + an OAuth entry in oauth.ts. That is the good-first-
// issue shape for YouTube, X, TikTok, and everything after.
export const SENDERS: Record<string, PlatformSender> = {
  instagram: instagramSender,
  facebook: facebookSender,
  threads: threadsSender,
};

export function senderFor(platform: string): PlatformSender | null {
  return SENDERS[platform] ?? null;
}
