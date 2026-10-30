# Managed data and agent connections

Settings → Integrations configures weather, OpenAI and Anthropic/Claude connections. `/v1/app/data-integrations` requires the primary workspace credential. Apply migration `0004_data_integrations.sql` on the intended server. Provider credentials are AES-GCM encrypted with the server's existing `TOKEN_ENCRYPTION_KEY`; no provider key is returned by list/read/save or stored in the desktop endpoint-token vault. New package/server capability integration remains separate work; these routes do not publish audience modules.

Connection changes require an expected revision. A connection's kind/provider cannot be changed in place: create a new connection, so an old provider key is not sent to another provider. Existing keys are retained when the edit omits a replacement. Test uses provider model retrieval for agents rather than a paid generation. Weather observations are normalized, cached for the configured poll interval, and reused across queries. Host callers cannot supply arbitrary provider URLs.

Agent queries make one bounded request and do not automatically retry paid calls. Explicit response status/stop reason must indicate completion. Fact-check requests require web research and real source annotations; unsupported, uncited or paused/incomplete responses fail visibly. `pause_turn` continuation is not implemented for Claude in this initial adapter. This must not be presented as a completed fact check. OpenAI and Claude use distinct adapters with the same typed answer/citation result. The model ID is configured by the user, not silently substituted. Automated tests use synthetic credentials and controlled responses. A separate user-authorized live Claude check subsequently passed with a real key and four source citations through the Just Facts module; see `docs/set-runtime/claude-provider-proof.json`. No key is in that artifact. OpenAI has not been tested against a real account.

Documentation verified 2026-10-24:

- [OpenAI Responses web search](https://developers.openai.com/api/docs/guides/tools-web-search): required search tool choice, output text annotations and citation positions. Preserve citations for clickable participant/operator presentation.
- [Claude API overview](https://platform.claude.com/docs/en/api/overview): API-key Bearer authentication, explicit `anthropic-version: 2026-10-21`, optional workspace selection for workspace-scoped keys.
- [Claude web search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool): basic `web_search_20250305`, bounded searches, text-block `web_search_result_location` citations, tool errors and incomplete `pause_turn` responses.
- [Claude model retrieval](https://platform.claude.com/docs/en/api/models/retrieve): model/alias access check.
- [Open-Meteo API](https://open-meteo.com/en/docs): current temperature, WMO condition, precipitation, day/night and wind. API usage/attribution must match the operator's deployment.

Verification: 12 provider/route tests cover real SQL, encrypted keys, primary-only access, revisions, caching, normalized weather, both agent request formats, evidence/completion checks and provider-error redaction. The actual Integrations component browser test covers creating Claude/OpenAI/weather entries, connection test status, secret omission on edit and absence of saved keys in the rendered UI. These are controlled-provider tests, not a claim that a user's API account has been tested.

Weather uses bounded data-object caching in the connection’s existing durable storage: 16 city/unit query objects, at most 256 KiB per connection revision. The full provider object contains current, hourly and daily forecasts, so panel/view selection performs no provider pull. Freshness is the saved poll interval; reads never extend it. Explicit Refresh weather bypasses freshness subject to the two-second request limit. Identical in-flight queries coalesce; compare-and-swap merges preserve different-city results. Stale results may be reused for a provider outage for up to 30 additional minutes, retain their original fetch time and are labeled stale. A changed connection revision invalidates prior objects; city revisions still reject late results. Agent responses are excluded from automatic caching. The storage reader adopts the previous single-weather-result format; no database migration is required.

## Versioned adapter discovery (development foundation)

The authenticated connection-list response now includes an additive `adapters`
array, alongside the unchanged `connections` and `capabilities` fields. Older
servers may omit it; clients must not infer adapter support from an absent catalog.
The catalog currently describes only Open-Meteo, OpenAI and Anthropic. Discovery
performs no provider calls and grants no permission to execute an operation.

`shared/set-runtime/dataAdapters.ts` defines `producer.data-adapter/1` and an owned,
bounded registry. Each adapter version declares a capability, transport, operations,
versioned input/output contract references, snapshot/event delivery, and whether
an explicit refresh is supported. Compatibility resolution requires exact input,
output and delivery matches; there is no implicit version conversion. Catalog and
resolution results are detached copies. Unknown fields, duplicate versions or
operations, malformed references and unsupported push-refresh promises fail.

Current references describe existing parsers/results in `providers.ts`:

| Adapter/operation | Input contract | Output contract | Delivery |
| --- | --- | --- | --- |
| open-meteo@1 / forecast | weather.location-query@1 | weather.observation@1 | snapshot |
| openai@1 / answer | agent.question@1 | agent.answer@1 | snapshot |
| anthropic@1 / answer | agent.question@1 | agent.answer@1 | snapshot |

Weather input may omit the location to use the saved connection. Agent inputs
include the existing answer/factCheck mode; a catalog entry does not guarantee
that an account/model or saved connection supports web search. Existing provider
parsers and route authorization remain responsible for execution checks.

This is metadata and compatibility groundwork, **not** full typed-data validation
or a generic adapter execution engine. Contract JSON schemas, normalized result
validation, generic scheduling, authenticated webhook ingress, stream recovery,
and renderer-facing generic bindings are still pending. Test webhook descriptors
exercise compatibility only; no webhook service is advertised by the real catalog.
Adding metadata alone must never activate provider code or network destinations.

Run `npm --prefix server test -- test/data-adapter-registry.test.ts test/data-integrations.test.ts`
for registry and existing-provider route coverage. Tests use synthetic connections
and responses; no paid provider calls are made.

## Executable ingestion update

Weather and agent operations now pass through `shared/set-runtime/dataOperation.ts`
and the typed parsers in `providerContracts.ts`. Input is checked before execution;
normalized output is checked before returning it. Weather cache reads use the same
output contract. Registry compatibility alone is still not permission to execute:
the existing authenticated routes and saved connection revisions remain mandatory.

Claude is the next prioritized adapter after weather. Both existing agent provider
implementations normalize into `agent.answer@1`, so Set modules consume the same
answer/citation shape. Claude multi-block text separators now agree with its
citation offsets. Incomplete turns and missing research evidence retain the
existing explicit failure behavior. No automatic paid retries were introduced.

Public data JSON Schemas, richer structured LLM outputs, streaming assembly,
authenticated webhook delivery and generic scheduling remain pending. The earlier
metadata-only description above records the first slice; this update adds actual
input/output validation without claiming those remaining capabilities.
