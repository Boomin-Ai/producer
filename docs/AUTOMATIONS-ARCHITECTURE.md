# Producer Automations — architecture proposal

Reviewed: 2026-09-25. Research only; no backend migration or product implementation performed.

## Manager prerequisite

The user has selected Manager integration first. [MANAGER-DESKTOP-PROPOSAL.md](MANAGER-DESKTOP-PROPOSAL.md) specifies the source-reviewed desktop port: publishing overview on entry, an always-present collapsible collections siderail, Stages, units and real unit parts, with Studio and metrics presentation removed. Attribution remains intact. [MANAGER-SOL-HANDOFF.md](MANAGER-SOL-HANDOFF.md) defines the first dev UI work package. This adds a delivery prerequisite; it does not narrow the later full-Flows-parity or CLI goal.

## Accepted product direction

- Bring existing hosted Boomin Flows into a Producer sidebar tab called Automations, with feature parity. Boomin retains the Flows name until its creator surface is simplified. Its admin retains access to the underlying services.
- Instagram comment-to-DM and DM replies are priority acceptance scenarios, not a reason to remove existing block types or capabilities.
- Hosted Automations should be free to users, with storage the intended paid component. Infrastructure consumption is an internal operating concern, not a proposed contact/run subscription.
- Agents must configure and operate automations through a CLI backed by the same API as the editor.
- Ship hosted integration first. Migrate toward the Worker/D1/Queues/cron stack in first-party production, then release the single-organization self-hosted edition from that proven implementation.
- Temporary PostgreSQL compatibility is a migration tool, not the desired permanent split between hosted and open engines.

## Repository findings

The web, api, sdk, developers and mcp repositories are available under `~/Documents/boomin/`.

| Surface | Evidence | Architectural implication |
| --- | --- | --- |
| Flows editor | web `src/components/flows/FlowBuilderV1.tsx`, `FlowStage.tsx`, shared canvas engine | Reuse the editor and existing features; inject API/workspace dependencies and product labels rather than embed the whole website. |
| Runtime | api `src/services/flow-blocks.ts`, `services/runtime/compiler.ts`, `engine.ts` | Preserve definitions, immutable versions, runs, steps and waits. Map dependencies on contacts, offers, email and agents before extraction. |
| Hosted Producer | api `src/routes/app/producer.ts` | Manager channels and publishing already use Boomin's integrations, content units, distributions, publish jobs, posts and files. |
| Desktop boundary | Producer `src-tauri/src/client.rs` | The desktop consumes an HTTP contract, not PostgreSQL directly. Keep that contract stable while changing server storage. |
| Open server | Producer `server/schema.sql`, `server/wrangler.toml` | Worker, D1, R2 and cron already exist; live uses Durable Objects. Automation tables and queue bindings still need implementation. |
| Agent precedent | sdk `packages/cli/src/network-apply.js`; api `src/routes/app/live.ts` | Reuse declarative JSON/YAML plan/apply patterns and room registration's stable external reference model. Dedicated automation commands were not found in the inspected SDK. |
| MCP | mcp `packages/mcp/src/protocol.js` | Another client of the automation API, not a runtime dependency. |

The API already uses Cloudflare Queues and cron. Redis, Kafka and a new always-on application server are not prerequisites for this extraction. Existing media/voice containers belong to other workloads; full feature parity still requires inventorying the services each block invokes.

## Live database assessment

Read-only inspection of Boomin's primary Neon database found approximately 79 MiB of database storage, 189 public tables, 651 foreign-key constraints and 235 JSONB columns. These are a dated snapshot, not a workload benchmark. No application-defined stored routines, public views, triggers or row-level-security tables were found; extension-provided routines were excluded from that finding.

Data volume is modest. The main work is preserving application semantics and relationships:

- Flows and runs reference organizations, brands, contacts, events, triggers and versions.
- Channels and publishing share integrations, credentials, files and content data with other Boomin features.
- Contacts also participate in commerce; extracting a single table family does not isolate the complete domain.
- The schema uses PostgreSQL enums, UUIDs, timestamps and JSONB. SQLite representations and application validation need explicit migrations.
- `api/src/services/operations/kernel.ts` uses data-modifying CTEs and conditional conflict updates to atomically admit operations. These require a tested D1 equivalent, not mechanical SQL translation.
- Active waiting runs exist. A migration must preserve their pinned versions and deadlines, or drain them on the old runtime with explicit ownership.

No customer message bodies or credentials are included here. No database writes were performed. Actual throughput, billing and Meta application approvals were not audited.

## Delivery sequence

### 1. Hosted parity and CLI

Expose the existing hosted Flows service in Producer under Automations. Keep existing IDs, definitions, contacts, connections, webhooks and execution ownership. Both surfaces initially edit the same objects: no duplication or second webhook runtime.

Inventory the entire Flows surface, including list/templates, editor blocks, import/export, sharing, testing, activity, connection handling and dependent services. Reuse existing behavior before undertaking independent redesigns. Verify Instagram scenarios end to end; a provider option in an editor is not evidence of implemented delivery.

Define a versioned automation API used by UI, SDK, CLI and MCP. Preserve existing Boomin routes through compatibility adapters. Proposed CLI capabilities, not existing commands:

- list/get/export and schema-aware validate;
- plan/apply from JSON or YAML, stable external references and structured JSON output;
- explicit publish/pause and distinct cancellation of running work;
- simulated event tests by default, with deliberate live-send controls;
- run status, step results and actionable errors.

Use workspace-scoped authorization, idempotency and optimistic version checks. Export definitions without credentials. An agent must not need a GUI or direct database access. Publishing/version semantics need agreement with the existing runtime before changing behavior under current users.

### 2. Move a coherent domain onto D1

Extract shared execution logic and migrate related workspace data deliberately: definitions, versions, contacts/conversations, event receipts, runs, waits and delivery state, alongside the channel/publishing dependencies that must move with them. Identify which shared services remain remote during transition.

Choose database boundaries after measuring writes and cross-organization operations. The current dataset does not demand immediate sharding. A per-organization database is a possible destination for organization-local Producer data, while identity/routing and global marketplace data need separate treatment. Organizations and brands are not interchangeable tenancy keys.

Do not scatter a financial transaction across databases and assume a queue restores SQL atomicity. Retain coherent transactional boundaries; use explicit asynchronous contracts where boundaries genuinely allow them. Preserve IDs and implement reconciliation, migration validation, a write-ownership cutover and rollback routing.

Prove duplicate/out-of-order event handling, concurrent replies, operation admission, tenant isolation, expired credentials, opt-out and old-version continuation. Benchmark actual query plans and load. Run the D1 implementation in hosted production before recommending it to independent operators.

### 3. Package the proven single-organization edition

Use the same core, schema migrations, queue handlers and tests. Deployment configuration and tenancy differ; business logic should not fork.

One Worker can expose HTTP, queue-consumer and scheduled handlers, with D1 for durable state, Queues plus a dead-letter queue for dispatch/retries, cron for due waits/recovery, and R2 for attachments. Existing live features can keep their Durable Objects. This is one application deployment with managed bindings, not a stateless Worker alone.

Self-hosting needs its own integration credentials, webhook registration and Meta onboarding. Producer's current open Instagram OAuth requests basic/publishing scopes; messaging setup remains additional work. Do not promise a permission path until validated against an actual Meta app. Boomin's global admin, marketplace and financial machinery need not be prerequisites for a single-organization automation installation; block dependencies must be explicitly supported or replaced before claiming parity there.

## D1 tradeoffs

| Benefit | Cost or constraint |
| --- | --- |
| Hosted and open editions can share schema, migrations and operational knowledge. | Convergence requires actual hosted migration, not just a second adapter. |
| Existing Worker/Queues/cron deployment becomes simpler to reproduce. | Cloudflare bindings remain a platform dependency, even with SQLite-compatible data. |
| Usage-based database operations can suit small, intermittent workspaces. | Lower bills are not guaranteed: row scans, retries, writes, Worker CPU and queue operations matter. |
| Current database volume is well within one paid D1 database's capacity. | D1 caps each database at 10 GB on Paid and 500 MB on Free; an individual database processes queries serially. Read replicas do not remove primary write contention. |
| D1 supports transactional batches and point-in-time recovery. | PostgreSQL-specific CTEs, locking assumptions, JSON operators and transaction patterns still require redesign. Separate D1 databases do not supply cross-database SQL joins/transactions. |

Keep attachments in R2 and use indexed queries and retention policies for execution history. Free product pricing does not require the operator's production deployment to fit Cloudflare's free plan. Measure operating costs internally without introducing per-contact or per-run product charges.

## Execution invariants

Persist verified normalized webhooks and durable dispatch intent before acknowledgement. Queue IDs rather than message bodies; recover undispatched work from an outbox. Deduplicate events and run creation, claim advancement atomically, and pin immutable versions. Persist long waits in D1; queue retention is not a scheduler.

Provider sends are external side effects: a timeout after acceptance is ambiguous. Record attempts/receipts and reconcile uncertainty rather than promise exactly-once delivery. Enforce opt-out, connection state and provider eligibility. The existing private-reply safety check has a placeholder in the inspected code and needs verification before claiming that guarantee.

## References

- https://developers.cloudflare.com/d1/platform/limits/
- https://developers.cloudflare.com/d1/worker-api/d1-database/
- https://developers.cloudflare.com/d1/platform/pricing/
- https://developers.cloudflare.com/d1/best-practices/read-replication/
- https://developers.cloudflare.com/d1/reference/time-travel/
- https://developers.cloudflare.com/queues/platform/pricing/
- https://developers.cloudflare.com/workers/platform/pricing/
