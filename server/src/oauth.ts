// Channel authorization — the "humans establish authority" half.
//
// The user creates their OWN Meta developer apps (Development Mode is
// enough to publish to accounts they own) and puts the app ids/secrets on
// this worker. Connecting a channel is always an explicit human browser
// consent: the API mints a single-use connect session, the browser walks
// Meta's dialog, and the callback is authenticated by the session's
// `state` — never by a bearer token. Agents can hold an automation token
// forever and still never mint themselves a channel.

import type { Env } from "./env";
import { ApiError } from "./errors";

export interface ConnectedIdentity {
  external_id: string;
  display_name: string;
  handle: string | null;
  access_token: string;
  /** epoch seconds; null = effectively non-expiring (FB page tokens). */
  token_expires_at: number | null;
}

const nowSec = () => Math.floor(Date.now() / 1000);

function need(value: string | undefined, name: string): string {
  if (!value) {
    throw new ApiError(503, "platform_unconfigured", `${name} is not set on this server — see SELF_HOSTING.md.`);
  }
  return value;
}

async function json<T>(resp: Response, what: string): Promise<T> {
  const body = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (!resp.ok) {
    const err = (body.error ?? body) as Record<string, unknown>;
    throw new ApiError(502, "oauth_exchange_failed", `${what}: ${String(err.message ?? err.error_message ?? resp.status)}`);
  }
  return body as T;
}

export function authorizeUrl(platform: string, env: Env, redirectUri: string, state: string): string {
  switch (platform) {
    case "instagram": {
      const id = need(env.INSTAGRAM_APP_ID, "INSTAGRAM_APP_ID");
      const scope = "instagram_business_basic,instagram_business_content_publish";
      return `https://www.instagram.com/oauth/authorize?client_id=${id}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scope)}&state=${state}`;
    }
    case "facebook": {
      const id = need(env.FACEBOOK_APP_ID, "FACEBOOK_APP_ID");
      const scope = "pages_show_list,pages_manage_posts,pages_read_engagement";
      return `https://www.facebook.com/v22.0/dialog/oauth?client_id=${id}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scope)}&state=${state}`;
    }
    case "threads": {
      const id = need(env.THREADS_APP_ID, "THREADS_APP_ID");
      const scope = "threads_basic,threads_content_publish";
      // threads.net redirects to threads.com and DROPS the query string —
      // the authorize URL must target www.threads.com directly.
      return `https://www.threads.com/oauth/authorize?client_id=${id}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scope)}&state=${state}`;
    }
    default:
      throw new ApiError(404, "not_found", `Unknown platform: ${platform}`);
  }
}

/** Exchange the callback code for long-lived credential(s). Facebook yields
 *  one identity per Page the user manages. */
export async function exchangeCode(
  platform: string,
  env: Env,
  redirectUri: string,
  code: string,
): Promise<ConnectedIdentity[]> {
  if (platform === "instagram") return [await exchangeInstagram(env, redirectUri, code)];
  if (platform === "facebook") return exchangeFacebook(env, redirectUri, code);
  if (platform === "threads") return [await exchangeThreads(env, redirectUri, code)];
  throw new ApiError(404, "not_found", `Unknown platform: ${platform}`);
}

async function exchangeInstagram(env: Env, redirectUri: string, code: string): Promise<ConnectedIdentity> {
  const id = need(env.INSTAGRAM_APP_ID, "INSTAGRAM_APP_ID");
  const secret = need(env.INSTAGRAM_APP_SECRET, "INSTAGRAM_APP_SECRET");

  const short = await json<{ access_token: string; user_id?: string | number }>(
    await fetch("https://api.instagram.com/oauth/access_token", {
      method: "POST",
      body: new URLSearchParams({
        client_id: id,
        client_secret: secret,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        code,
      }),
    }),
    "Instagram code exchange",
  );

  const long = await json<{ access_token: string; expires_in?: number }>(
    await fetch(
      `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${secret}&access_token=${encodeURIComponent(short.access_token)}`,
    ),
    "Instagram long-lived exchange",
  );

  const me = await json<{ user_id?: string | number; id?: string; username?: string; name?: string }>(
    await fetch(
      `https://graph.instagram.com/me?fields=user_id,username,name&access_token=${encodeURIComponent(long.access_token)}`,
    ),
    "Instagram profile",
  );

  const externalId = String(me.user_id ?? me.id ?? short.user_id ?? "");
  return {
    external_id: externalId,
    display_name: me.name || me.username || "Instagram",
    handle: me.username ?? null,
    access_token: long.access_token,
    token_expires_at: nowSec() + (long.expires_in ?? 60 * 86400),
  };
}

async function exchangeFacebook(env: Env, redirectUri: string, code: string): Promise<ConnectedIdentity[]> {
  const id = need(env.FACEBOOK_APP_ID, "FACEBOOK_APP_ID");
  const secret = need(env.FACEBOOK_APP_SECRET, "FACEBOOK_APP_SECRET");

  const short = await json<{ access_token: string }>(
    await fetch(
      `https://graph.facebook.com/v22.0/oauth/access_token?client_id=${id}&client_secret=${secret}&redirect_uri=${encodeURIComponent(redirectUri)}&code=${encodeURIComponent(code)}`,
    ),
    "Facebook code exchange",
  );

  const long = await json<{ access_token: string }>(
    await fetch(
      `https://graph.facebook.com/v22.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${id}&client_secret=${secret}&fb_exchange_token=${encodeURIComponent(short.access_token)}`,
    ),
    "Facebook long-lived exchange",
  );

  const pages = await json<{ data?: { id: string; name: string; access_token: string }[] }>(
    await fetch(
      `https://graph.facebook.com/v22.0/me/accounts?fields=id,name,access_token&access_token=${encodeURIComponent(long.access_token)}`,
    ),
    "Facebook pages",
  );

  const rows = pages.data ?? [];
  if (rows.length === 0) {
    throw new ApiError(422, "no_pages", "This Facebook account manages no Pages — Facebook publishing targets a Page.");
  }
  // Page tokens derived from a long-lived user token do not expire.
  return rows.map((p) => ({
    external_id: p.id,
    display_name: p.name,
    handle: null,
    access_token: p.access_token,
    token_expires_at: null,
  }));
}

async function exchangeThreads(env: Env, redirectUri: string, code: string): Promise<ConnectedIdentity> {
  const id = need(env.THREADS_APP_ID, "THREADS_APP_ID");
  const secret = need(env.THREADS_APP_SECRET, "THREADS_APP_SECRET");

  const short = await json<{ access_token: string; user_id?: string | number }>(
    await fetch("https://graph.threads.net/oauth/access_token", {
      method: "POST",
      body: new URLSearchParams({
        client_id: id,
        client_secret: secret,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        code,
      }),
    }),
    "Threads code exchange",
  );

  const long = await json<{ access_token: string; expires_in?: number }>(
    await fetch(
      `https://graph.threads.net/access_token?grant_type=th_exchange_token&client_secret=${secret}&access_token=${encodeURIComponent(short.access_token)}`,
    ),
    "Threads long-lived exchange",
  );

  const me = await json<{ id?: string; username?: string; name?: string }>(
    await fetch(
      `https://graph.threads.net/me?fields=id,username,name&access_token=${encodeURIComponent(long.access_token)}`,
    ),
    "Threads profile",
  );

  return {
    external_id: String(me.id ?? short.user_id ?? ""),
    display_name: me.name || me.username || "Threads",
    handle: me.username ?? null,
    access_token: long.access_token,
    token_expires_at: nowSec() + (long.expires_in ?? 60 * 86400),
  };
}
