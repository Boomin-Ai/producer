import { describe, expect, it } from "vitest";
import { fakeD1 } from "./d1";
import type { Env } from "../src/env";
import worker from "../src/index";
import { CONTRIBUTIONS_ISSUES } from "../src/stubs";

// Every Phase 1 route the contract-first PR stubbed (501 not_implemented) is
// now BUILT. This test keeps the stubs' one promise — the routes are mounted
// and gated exactly like their families — and pins that none of them answers
// 501 or 404 any more: the host family 401s with no bearer and 403s for an
// automation token; the guest/audience family takes no bearer at all.

const ORIGIN = "https://producer.example.workers.dev";
const PRIMARY = "primary-token-for-tests";
const AUTOMATION = "automation-token-for-tests";

function env(): Env {
  return { DB: fakeD1(), MEDIA: {} as R2Bucket, PRIMARY_TOKEN: PRIMARY, AUTOMATION_TOKEN: AUTOMATION, SIGNALING_SECRET: "a-32-char-signaling-secret-000000" };
}
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

async function call(method: string, path: string, token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const body = method === "GET" ? undefined : "{}";
  return worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body }), env(), ctx);
}

const host: Array<{ name: string; method: string; path: string }> = [
  { name: "participant grant", method: "POST", path: "/v1/app/live/guests/g1/grants" },
  { name: "contributions ledger", method: "GET", path: "/v1/app/live/rooms/r1/contributions" },
  { name: "list interactions", method: "GET", path: "/v1/app/live/rooms/r1/interactions" },
  { name: "open interaction", method: "POST", path: "/v1/app/live/rooms/r1/interactions" },
  { name: "transition interaction", method: "PATCH", path: "/v1/app/live/rooms/r1/interactions/ix_abcdefghijkl" },
];

const connect: Array<{ name: string; method: string; path: string }> = [
  { name: "audience token mint", method: "POST", path: "/v1/connect/audience/KXQZ/token" },
  { name: "audience input", method: "POST", path: "/v1/connect/audience/interactions/ix_abcdefghijkl/inputs" },
  { name: "guest input", method: "POST", path: "/v1/connect/guest/gi_code/interactions/ix_abcdefghijkl/inputs" },
];

describe("former host stubs are built and gated like liveHostRoutes", () => {
  for (const tc of host) {
    it(`${tc.name}: no bearer → 401, automation → 403, primary → a real answer (never 501)`, async () => {
      expect((await call(tc.method, tc.path)).status).toBe(401);
      const auto = await call(tc.method, tc.path, AUTOMATION);
      expect(auto.status).toBe(403);
      expect(((await auto.json()) as { error: { code: string } }).error.code).toBe("token_class_insufficient");
      const res = await call(tc.method, tc.path, PRIMARY);
      expect(res.status).not.toBe(501);
      // r1 / g1 do not exist, so the real answer is the resource's own 404 —
      // the route is there, the thing is not.
      expect([400, 404]).toContain(res.status);
    });
  }
});

describe("former guest + audience stubs take no bearer", () => {
  for (const tc of connect) {
    it(`${tc.name}: reachable with no token → a real answer (never 401 for the door, never 501)`, async () => {
      const res = await call(tc.method, tc.path);
      expect(res.status).not.toBe(501);
      expect([401, 404]).toContain(res.status); // unknown code / no audience token
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).not.toBe("not_implemented");
    });
  }
});

it("the issue map still points at real Phase 1 issues in this repo", () => {
  for (const url of Object.values(CONTRIBUTIONS_ISSUES)) {
    expect(url).toMatch(/^https:\/\/github\.com\/Boomin-Ai\/producer\/issues\/\d+$/);
  }
});
