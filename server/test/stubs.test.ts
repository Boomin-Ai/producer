import { describe, expect, it } from "vitest";
import { fakeD1 } from "./d1";
import type { Env } from "../src/env";
import worker from "../src/index";
import { CONTRIBUTIONS_ISSUES, NOT_IMPLEMENTED } from "../src/stubs";

// Contract-first stubs (docs/CONTRIBUTIONS.md) must be MOUNTED and gated
// EXACTLY like their neighbours: the host family 401s with no bearer, 403s for
// an automation token, and only a primary token reaches the 501 — which names
// the issue that builds the route. The guest/audience family takes no bearer
// at all. Nothing here may answer 404: a 404 is an unmounted route.

const ORIGIN = "https://producer.example.workers.dev";
const PRIMARY = "primary-token-for-tests";
const AUTOMATION = "automation-token-for-tests";

function env(): Env {
  return { DB: fakeD1(), MEDIA: {} as R2Bucket, PRIMARY_TOKEN: PRIMARY, AUTOMATION_TOKEN: AUTOMATION };
}
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

async function call(method: string, path: string, token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const body = method === "GET" ? undefined : "{}";
  return worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body }), env(), ctx);
}

const host: Array<{ name: string; method: string; path: string; issue: string }> = [
  { name: "contributions ledger", method: "GET", path: "/v1/app/live/rooms/r1/contributions", issue: CONTRIBUTIONS_ISSUES.contributions },
  { name: "list interactions", method: "GET", path: "/v1/app/live/rooms/r1/interactions", issue: CONTRIBUTIONS_ISSUES.interactions },
  { name: "open interaction", method: "POST", path: "/v1/app/live/rooms/r1/interactions", issue: CONTRIBUTIONS_ISSUES.interactions },
  { name: "transition interaction", method: "PATCH", path: "/v1/app/live/rooms/r1/interactions/ix1", issue: CONTRIBUTIONS_ISSUES.interactions },
];

const connect: Array<{ name: string; method: string; path: string; issue: string }> = [
  { name: "audience token mint", method: "POST", path: "/v1/connect/audience/KXQZ/token", issue: CONTRIBUTIONS_ISSUES.interactions },
  { name: "audience input", method: "POST", path: "/v1/connect/audience/interactions/ix1/inputs", issue: CONTRIBUTIONS_ISSUES.interactions },
  { name: "guest input", method: "POST", path: "/v1/connect/guest/gi_code/interactions/ix1/inputs", issue: CONTRIBUTIONS_ISSUES.interactions },
];

describe("host stubs are gated like liveHostRoutes", () => {
  for (const tc of host) {
    it(`${tc.name}: no bearer → 401, automation → 403, primary → 501 + issue`, async () => {
      const anon = await call(tc.method, tc.path);
      expect(anon.status).toBe(401);

      const auto = await call(tc.method, tc.path, AUTOMATION);
      expect(auto.status).toBe(403);
      expect(((await auto.json()) as { error: { code: string } }).error.code).toBe("token_class_insufficient");

      const res = await call(tc.method, tc.path, PRIMARY);
      expect(res.status).toBe(501);
      const body = (await res.json()) as { code: string; issue: string; error: { code: string; details: { issue: string } } };
      expect(body.code).toBe(NOT_IMPLEMENTED);
      expect(body.issue).toBe(tc.issue);
      expect(body.error.code).toBe(NOT_IMPLEMENTED);
      expect(body.error.details.issue).toBe(tc.issue);
    });
  }
});

describe("guest + audience stubs take no bearer", () => {
  for (const tc of connect) {
    it(`${tc.name}: reachable with no token → 501 + issue (never 401, never 404)`, async () => {
      const res = await call(tc.method, tc.path);
      expect(res.status).toBe(501);
      const body = (await res.json()) as { code: string; issue: string };
      expect(body.code).toBe(NOT_IMPLEMENTED);
      expect(body.issue).toBe(tc.issue);
    });
  }
});

it("every stub points at a real Phase 1 issue in this repo", () => {
  for (const url of Object.values(CONTRIBUTIONS_ISSUES)) {
    expect(url).toMatch(/^https:\/\/github\.com\/Boomin-Ai\/producer\/issues\/\d+$/);
  }
});
