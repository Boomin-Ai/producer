import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../site/_worker.js";

test("Producer serves the branded room without redirecting or forwarding credentials", async () => {
  const previous = globalThis.fetch;
  let target;
  globalThis.fetch = async (url, options) => {
    target = String(url);
    assert.equal(options.headers.authorization, undefined);
    assert.equal(options.headers.cookie, undefined);
    return new Response('<html><meta property="og:site_name" content="Boomin"><meta property="og:url" content="https://boomin.ai/kleveland/audience/producer-demo"></html>', { headers: { "Content-Type": "text/html", "Set-Cookie": "private=secret" } });
  };
  try {
    const response = await worker.fetch(new Request("https://producer.dev/kleveland/audience/producer-demo", { headers: { Authorization: "Bearer private", Cookie: "private=secret" } }), {});
    assert.equal(response.status, 200);
    assert.equal(target, "https://boomin.ai/kleveland/audience/producer-demo");
    assert.equal(response.headers.get("location"), null);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const html = await response.text();
    assert.match(html, /content="Producer"/);
    assert.match(html, /content="https:\/\/producer.dev\/kleveland\/audience\/producer-demo"/);
  } finally { globalThis.fetch = previous; }
});
test("missing chunks fail cleanly instead of serving a cached HTML fallback", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response("<html>SPA</html>", { headers: { "Content-Type": "text/html" } });
  try { assert.equal((await worker.fetch(new Request("https://producer.dev/room-assets/assets/missing.js"), {})).status, 503); }
  finally { globalThis.fetch = previous; }
});
test("the marketing site and unrelated paths continue using static assets", async () => {
  const assets = { ASSETS: { fetch: async () => new Response("landing") } };
  for (const path of ["/", "/chair.png", "/settings", "/arbitrary/route"]) assert.equal(await (await worker.fetch(new Request(`https://producer.dev${path}`), assets)).text(), "landing");
});
test("legacy guest links serve the same dedicated entry bundle", async () => {
  const previous = globalThis.fetch;
  let target;
  globalThis.fetch = async url => { target = String(url); return new Response("room entry", { headers: { "Content-Type": "text/html" } }); };
  try {
    assert.equal((await worker.fetch(new Request("https://producer.dev/connect/guest/room/gr_123456789012345678901234"), {})).status, 200);
    assert.equal(target, "https://boomin.ai/room-assets/room");
  } finally { globalThis.fetch = previous; }
});
