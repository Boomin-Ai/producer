import { describe, expect, it } from "vitest";
import { backoffSeconds } from "../src/queue";
import { decryptSecret, encryptSecret, randomCapability, sha256Hex, timingSafeEqual } from "../src/crypto";
import { tagList } from "../src/senders/types";
import { instagramSender } from "../src/senders/instagram";
import { facebookSender } from "../src/senders/facebook";
import { threadsSender } from "../src/senders/threads";

describe("crypto", () => {
  it("capability ids carry >=128 bits of entropy (32 hex chars)", () => {
    const id = randomCapability();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(randomCapability()).not.toBe(id);
  });

  it("AES-GCM round-trips platform tokens", async () => {
    const secret = "a-32-char-encryption-key-000000";
    const enc = await encryptSecret("IGQVJtoken123", secret);
    expect(enc).not.toContain("IGQVJtoken123");
    expect(await decryptSecret(enc, secret)).toBe("IGQVJtoken123");
  });

  it("sha256 is deterministic", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("timing-safe compare", () => {
    expect(timingSafeEqual("tok", "tok")).toBe(true);
    expect(timingSafeEqual("tok", "tok2")).toBe(false);
    expect(timingSafeEqual("tok", "tok".replace("k", "x"))).toBe(false);
  });
});

describe("queue backoff", () => {
  it("grows linearly and caps at 10 minutes", () => {
    expect(backoffSeconds(1)).toBe(30);
    expect(backoffSeconds(5)).toBe(150);
    expect(backoffSeconds(100)).toBe(600);
  });
});

describe("tag lists", () => {
  it("strips @, splits, and caps", () => {
    expect(tagList("@drew, @bliss  extra", 2)).toEqual(["drew", "bliss"]);
    expect(tagList(["@a", "", "b"], 3)).toEqual(["a", "b"]);
    expect(tagList(undefined, 3)).toEqual([]);
  });
});

describe("sender preflights", () => {
  const base = { caption: "hi", mediaUrl: "https://x/a.jpg", mediaKind: "image" as const, overrides: {} };

  it("instagram requires media and bounds captions", () => {
    expect(instagramSender.preflight(base)).toEqual([]);
    expect(instagramSender.preflight({ ...base, mediaUrl: null, mediaKind: null })[0].code).toBe("media_required");
    expect(instagramSender.preflight({ ...base, caption: "x".repeat(2201) })[0].code).toBe("caption_too_long");
  });

  it("facebook accepts text-only", () => {
    expect(facebookSender.preflight({ ...base, mediaUrl: null, mediaKind: null })).toEqual([]);
    expect(facebookSender.preflight({ caption: null, mediaUrl: null, mediaKind: null, overrides: {} })[0].code).toBe(
      "content_required",
    );
  });

  it("threads accepts text-only and bounds at 500", () => {
    expect(threadsSender.preflight({ ...base, mediaUrl: null, mediaKind: null })).toEqual([]);
    expect(threadsSender.preflight({ ...base, caption: "x".repeat(501) })[0].code).toBe("caption_too_long");
  });
});

describe("capabilities emit limits (never hardcoded client-side)", () => {
  it("instagram exposes the rolling window", () => {
    const caps = instagramSender.capabilities() as Record<string, any>;
    expect(caps.rateLimit).toEqual({ type: "rolling_window", max: 50, windowSeconds: 86400 });
    expect(caps.text.maxChars).toBe(2200);
  });
  it("threads exposes the 500-char bound", () => {
    const caps = threadsSender.capabilities() as Record<string, any>;
    expect(caps.text.maxChars).toBe(500);
  });
});
