// ── Contract-first stubs — docs/CONTRIBUTIONS.md (open-server view) ───────────
// Routes the contract (server/contract/openapi.yaml, `x-status:
// documented-unimplemented`) documents but this server does not build yet.
// Each one is MOUNTED and gated EXACTLY like its neighbours — the host family
// behind the primary token, the guest/audience family behind no bearer at all —
// and answers
//   501 { code: "not_implemented", issue: "<the issue that builds it>" }
// wrapped in the contract's error envelope, so a client gets the real access
// answer today (401 / 403) and a pointer instead of a silent 404.
//
// Nouns: participant, grant, contribution, interaction. Never brand, deal,
// wallet. No money routes, ever.
//
// When an issue lands, its handler replaces the stub in place; the gate and
// test/stubs.test.ts stay.

import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "./env";
import { requirePrimary, type TokenClass } from "./auth";

type Vars = { tokenClass: TokenClass };
type App = Hono<{ Bindings: Env; Variables: Vars }>;

/** The issue that turns each stub into a route. Exported so the test pins them. */
export const CONTRIBUTIONS_ISSUES = {
  /** Phase 1 item 1 — participant kind + grants on the open server. */
  participants: "https://github.com/Boomin-Ai/producer/issues/46",
  /** Phase 1 item 5 — the contribution ledger + run report. */
  contributions: "https://github.com/Boomin-Ai/producer/issues/50",
  /** Phase 1 item 7 — one interaction end to end (DO, alarm reveal, audience token). */
  interactions: "https://github.com/Boomin-Ai/producer/issues/51",
} as const;

export const NOT_IMPLEMENTED = "not_implemented" as const;

function notImplemented(c: Context<{ Bindings: Env; Variables: Vars }>, issue: string) {
  const message = "Documented in docs/CONTRIBUTIONS.md; not built yet. Follow the issue.";
  return c.json(
    {
      // The contract's error envelope (errors.ts) …
      error: { code: NOT_IMPLEMENTED, message, details: { issue } },
      // … and the flat form the plan specifies, so either reader finds it.
      code: NOT_IMPLEMENTED,
      issue,
    },
    501,
  );
}

// ── Host family: /v1/app/live/* (primary token only, like liveHostRoutes) ─────

export const contributionHostStubs: App = new Hono<{ Bindings: Env; Variables: Vars }>();

contributionHostStubs.use("*", async (c, next) => {
  requirePrimary(c.get("tokenClass"));
  return next();
});

// Item 1 (#46) — `POST /guests/:id/grants` is IMPLEMENTED in live.ts.

/** Item 5 — the run's interval ledger: `{ contributions: Contribution[] }`. */
contributionHostStubs.get("/rooms/:id/contributions", (c) => notImplemented(c, CONTRIBUTIONS_ISSUES.contributions));

/** Item 7 — interactions: list, open, transition (open | reveal | close). */
contributionHostStubs.get("/rooms/:id/interactions", (c) => notImplemented(c, CONTRIBUTIONS_ISSUES.interactions));
contributionHostStubs.post("/rooms/:id/interactions", (c) => notImplemented(c, CONTRIBUTIONS_ISSUES.interactions));
contributionHostStubs.patch("/rooms/:id/interactions/:ix", (c) => notImplemented(c, CONTRIBUTIONS_ISSUES.interactions));

// ── Guest + audience family: /v1/connect/* (no bearer — the code IS the credential)

export const contributionConnectStubs: App = new Hono<{ Bindings: Env; Variables: Vars }>();

/** Item 7 — mint a per-device audience capability token at the room-code door.
 *  No account, no email; `aud: "audience"`, expires with the show. */
contributionConnectStubs.post("/audience/:code/token", (c) => notImplemented(c, CONTRIBUTIONS_ISSUES.interactions));

/** Item 7 — an input from an audience device (`Authorization: Bearer <audience token>`). */
contributionConnectStubs.post("/audience/interactions/:ix/inputs", (c) => notImplemented(c, CONTRIBUTIONS_ISSUES.interactions));

/** Item 7 — an input from a guest (the invite code is the credential). */
contributionConnectStubs.post("/guest/:code/interactions/:ix/inputs", (c) => notImplemented(c, CONTRIBUTIONS_ISSUES.interactions));
