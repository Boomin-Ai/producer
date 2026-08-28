# producer-server

> The sovereignty backend for [Producer](https://github.com/Boomin-Ai/producer).
> Your server, your storage, your keys. AGPL-3.0.

producer-server is the self-hosted Producer backend: a single-user
Cloudflare Worker (Hono + D1 + R2 + cron) you deploy to your own
account with one `wrangler deploy`. It schedules and publishes your
posts 24/7 — laptop closed — with your own platform keys, for $0 at
personal scale.

The Boomin hosted backend (`api.boomin.ai`) implements the same
contract; the desktop app, CLI, and agents are equal clients of either.

## Status

Pre-alpha. The **API contract lives here** and is the project's spine:
[`contract/openapi.yaml`](./contract/openapi.yaml). The worker
implementation lands per the Phase 1 plan (milestones M4–M5) in the
[producer](https://github.com/Boomin-Ai/producer) repo's
`docs/PHASE1.md` (v4.1.1, frozen).

## Design commitments

- **Single-user, permanently.** No accounts, orgs, teams, billing,
  RBAC, or multi-tenancy — ever. That simplicity is what makes
  `wrangler deploy` credible. Managed multi-user is Boomin's job.
- **Two token classes, not RBAC:** a primary endpoint token, and a
  separately revocable automation token (publish/read/media-upload
  only) for agents, CLI, MCP, and CI.
- **Humans establish channel authority; agents exercise it.** Channel
  OAuth is always a human browser action.
- **Private storage, capability URLs.** R2 stays private; platforms
  fetch media through opaque ≥128-bit bearer-capability URLs only.
- **Effectively-once acceptance.** Durable idempotency keys; publish-now
  is a job; one queue, one state machine, one failure model.

## License

AGPL-3.0-only © 2026 Boomin. Modified versions offered as a network
service must make their corresponding source available to the users of
that service.
