// Two token classes, not RBAC (PHASE1.md v4.1.1):
//   primary    — everything: publish, read, channel administration,
//                connection/OAuth, media administration, server admin.
//   automation — publish, read, media upload ONLY. It will be pasted into
//                agents, CLI configs, and CI — its blast radius is scoped
//                accordingly. It can never connect/disconnect channels,
//                rotate credentials, mint tokens, or change configuration.
// Humans establish channel authority; agents exercise granted authority.

import type { Context } from "hono";
import type { Env } from "./env";
import { ApiError } from "./errors";
import { timingSafeEqual } from "./crypto";

export type TokenClass = "primary" | "automation";

export function classifyToken(env: Env, c: Context): TokenClass {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) {
    throw new ApiError(401, "unauthorized", "A bearer token is required.");
  }
  if (env.PRIMARY_TOKEN && timingSafeEqual(token, env.PRIMARY_TOKEN)) return "primary";
  if (env.AUTOMATION_TOKEN && timingSafeEqual(token, env.AUTOMATION_TOKEN)) return "automation";
  throw new ApiError(401, "unauthorized", "The endpoint did not accept this access token.");
}

export function requirePrimary(tokenClass: TokenClass): void {
  if (tokenClass !== "primary") {
    throw new ApiError(
      403,
      "token_class_insufficient",
      "This route requires the primary endpoint token — automation tokens can publish, read, and upload media only.",
    );
  }
}
