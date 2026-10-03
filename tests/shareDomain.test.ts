import { test } from "node:test";
import assert from "node:assert/strict";
import { shareDomain, audienceShareUrl, guestShareUrl } from "../src/lib/shareDomain.ts";

test("new installs and invalid preferences default to Producer", () => {
  for (const value of [null, undefined, "", "example.com", "producer.dev"]) assert.equal(shareDomain(value), "producer.dev");
  assert.equal(shareDomain("boomin.ai"), "boomin.ai");
});
test("both domains address the same room", () => {
  for (const domain of ["producer.dev", "boomin.ai"] as const) assert.equal(audienceShareUrl(domain, "/kleveland/audience/producer-demo"), `https://${domain}/kleveland/audience/producer-demo`);
});
test("changing domains preserves guest credentials and camera/name query", () => {
  const code = "gi_123456789012345678901234";
  const first = guestShareUrl("producer.dev", "/kleveland/guest/producer-demo", `https://boomin.ai/connect/guest/${code}?cam=producer&name=Guest#fragment`);
  assert.equal(first, `https://producer.dev/kleveland/guest/producer-demo/${code}?cam=producer&name=Guest#fragment`);
  assert.equal(guestShareUrl("boomin.ai", "/kleveland/guest/producer-demo", first), `https://boomin.ai/kleveland/guest/producer-demo/${code}?cam=producer&name=Guest#fragment`);
});
test("a cached room link is rebranded without rotating its code", () => {
  const code = "gr_123456789012345678901234";
  assert.equal(guestShareUrl("producer.dev", "/kleveland/guest/producer-demo", `https://boomin.ai/connect/guest/room/${code}`), `https://producer.dev/kleveland/guest/producer-demo/${code}`);
});
test("rejects forged origins, renderer URLs, and invalid server paths", () => {
  for (const original of ["https://attacker.example/gi_123456789012345678901234", "https://boomin.ai.evil.example/gi_123456789012345678901234", "http://boomin.ai/gi_123456789012345678901234", "https://boomin.ai/connect/guest/render/room?k=secret"]) assert.throws(() => guestShareUrl("producer.dev", "/kleveland/guest/producer-demo", original));
  assert.throws(() => audienceShareUrl("producer.dev", "//attacker.example/audience/room"));
});
