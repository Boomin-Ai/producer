# Fresh set library and audience capability proofs

Status: requested scope and implementation acceptance plan, 2026-10-24. This document extends the ownership/lifecycle draft. It is not a claim that the module schema or these showcase integrations are implemented.

## Product scope

Keep Head to Head — The Grand Arena. Replace the rest of the user-facing set library with newly authored experiences. Do not retrofit the old experiences or retain a second legacy playback path as the new product architecture. Source-control history and explicit regression fixtures are engineering evidence, not entries to expose in the new set picker.

Retirement must cover built-in picker entries, saved library entries, room defaults and the dev library seeding script. Merely deleting JSON from one folder is insufficient: the current dev builder copies legacy sets from Documents/boomin/docs/shows and SetConfiguration also injects three built-in fixtures. Preserve Grand Arena's package, artwork, source bindings and layered native composition. Do not delete physical room sources, room/account data, or unrelated production installations while retiring set packages.

The library reset is a separate, reviewable mutation with a manifest of affected packages. Existing authored packages can be moved out of the active library into a recovery archive before removal from the catalog; that is recovery storage, not supported legacy compatibility. Grand Arena's current package will need an explicit conversion to the selected new module format once that format exists. Preserving its design does not imply retaining an old runtime permanently.

## Three new showcase experiences

| Working name | Creative direction | Core proof |
| --- | --- | --- |
| The Decision Room | A deliberate broadcast identity, strong question typography, host/source placement, animated result geometry and clearly staged reveal | Package-authored vote module configures the room and participant controls; real votes and simulation share action/state semantics |
| Open Floor | Editorial question wall with a host composition, readable submission cards, queue/featured modes and native source integration | Audience text submissions and existing room chat are distinct typed inputs; moderation, bounded collections and featured-message composition work without experience-specific application code |
| Atmosphere | Authored day/night weather environments, restrained continuous motion, location/forecast typography and weather-dependent material/effect states | A Producer-managed data connector drives validated state, computed values, view/effect changes and freshness/failure behavior |

All three need landscape 1920×1080 and portrait 1080×1920 authored compositions, logical views independent of orientation, scalable output viewports, layered native sources/media, deliberate typography, and explicit transition/animation definitions. Weather effects need actual renderer capabilities; a condition label or shader color change alone must not be described as a rain/snow simulation. Design/pixel review is required in addition to schema tests.

Grand Arena remains the reference for native layering and segment-specific module state. These three extend it; they must not become three parallel implementations of voting, text intake and data polling.

## One interaction definition, three surfaces

The term "interaction panel" is the audience-facing product surface, not a return to Interaction as the runtime unit name. Modules own behavior and expose three related surfaces:

1. Editor configuration: author/configure a module instance, its question/choices/input rules, source/data bindings and operator controls. Add module uses the same capability registry and validation as import; there is no per-set hardcoded form.
2. Room operator panel: manage the module's committed live instance, admission, round/status, moderation, results and errors. It can contain several simultaneous modules, not just one room vote.
3. Participant panel: a public projection of currently published modules and permitted participant actions. It excludes private tallies, pending text/moderation state, operator grants and connector credentials.

These surfaces share a module contract but are not identical UIs or permission sets. A question editor is not sent to audience clients as an operator action. Rehearsal embeds the same participant component with an isolated simulation transport and rehearsal instance/round IDs. Do not build a separate set of fake rehearsal-only vote buttons that exercises different rules.

## Import, preparation, rehearsal and live publication

Import validates a package and stores its declarative module configuration. Selecting/loading it creates/prepares a private candidate with its configured operator/participant projections. This programmatically configures the intended interaction panel without asking the host to duplicate setup in the Vote panel. Neither import nor private editor changes contact a live audience or replace another running set's published controls.

Applying the set makes the selected set instance the room's configured experience. Starting its show publishes/opens the modules declared by the show entry actions; it does not indiscriminately open every vote/submission endpoint in the package. A standalone set can explicitly publish/open its participant modules without a show. Audience access still depends on the room's existing audience destination/access settings; starting a show cannot silently grant room access or start a stream.

Publishing the audience manifest has a configuration/instance epoch and a transport acknowledgement. Commit/show status must distinguish configured, publishing, live, closed and unavailable states. If audience publication is required and fails, show the failure; never label a simulated or disconnected audience session live. Capability preflight distinguishes hosted and self-hosted server support.

Edits during live operation remain draft until an explicit apply. Changes that invalidate a round create a new round identity through a declared transition. A stale phone must refresh or receive an explicit closed/stale response; it cannot submit against the replacement question. Unloading/replacing a set withdraws owned published controls and fences stale submissions. Set-owned persistent modules follow explicit ownership policies; show stop does not automatically dispose unrelated room services.

Rehearsal creates separate instances with synthetic principals, simulated time/data and no live-publication grants. It uses the same validation/reducers, control definitions and participant renderer. Exiting rehearsal disposes its subscriptions/leases and leaves live state untouched. Rehearsal can exercise publication failure and stale-event cases locally without exposing real participant endpoints.

## Capability contracts to implement

### Audience vote

Typed question/options, round identity, participant admission, change-vote policy, capacity/rate bounds, host close/reveal/reset actions and public result projection. Server authority owns ballots; an operator render snapshot is not a ballot database. Private voter identities and unrevealed aggregates never go into public audience/set render plans. An imported set selects its result visualization without changing the vote's semantic rules.

### Audience text submissions and chat

A prompt-bound text submission module is distinct from continuous room chat. Both may feed a common bounded message/item model through authorized adapters. Intake validates length/type/identity/round, throttles, and treats content as text. Submissions are pending by default; host approve/reject/feature actions manage what is public/on output. Pending bodies are visible only to authorized moderation surfaces. A module may explicitly choose an appropriate automatic publication policy; it is not the default.

Featuring/unfeaturing changes visual state without rewriting or impersonating the original author. Late submissions after close/reset are rejected. Duplicates, item removal, collection capacity, connection loss and abuse cases have declared handling. Room chat integration is the first chat adapter. YouTube/Twitch/other web chat require supported connectors and credentials; a generic "web chat" capability cannot imply those providers already exist.

### Weather/data

A Producer-managed weather adapter accepts validated location coordinates, units and polling policy. It produces a typed snapshot with provider/observation time, temperature, weather code, day/night state, precipitation and wind as supported. No arbitrary fetch URL or provider credentials live inside a set package. New location/configuration epochs fence earlier fetch results. Polling is bounded, cancellable, timed out and retry/backoff controlled, with explicit stale/offline states and last-good/fallback behavior.

Open-Meteo's current weather API is a candidate for the initial adapter; verify provider usage terms for the intended deployment and expose attribution. Official documentation: https://open-meteo.com/en/docs . Current conditions include temperature_2m, weather_code, is_day, precipitation and wind_speed_10m. Upstream numeric values are validated and normalized before rule evaluation. WMO condition mapping and units must be tested, not guessed from labels.

Simulation can inject clear, cloudy, rain, snow, storm, night, stale and unavailable snapshots into the rehearsal instance. Live mode consumes the provider adapter. Simulated snapshots must remain visibly identified as simulation. A test using prerecorded data does not prove successful live API delivery.

## Current implementation findings

- `src/features/presentation/SetConfiguration.tsx` offers fixed built-in packages and saved packages; it has source/media configuration but no module editor.
- `src/features/presentation/schema.ts` currently parses the presentation/1 visual/control/show format. The new module contract is only a design draft.
- `src/views/Live.tsx` has room-control transport, two-option vote creation/transition handling and audience chat state. Its vote creation also creates a room overlay; the new set integration must reuse the interaction service without forcing an unrelated legacy overlay into a set's composition.
- `server/src/interactions/schema.ts` explicitly supports only `vote` with exactly two options. Generalized package-driven participant manifests, submission modules and scoped module routing need server support; changing only the desktop UI cannot supply them.
- `src/features/sets-v2/interactions.ts` supplies a pure poll session for initial conformance work, not a complete deployed audience transport.
- `scripts/sets-v2/dev-room.py` currently seeds the isolated saved library from legacy packages. Retirement needs to remove that behavior so old sets do not reappear on rebuild.

## Implementation sequence

1. Finalize the narrow executable module/package contract from the ownership draft: independent instance identity/state, one commit path, module/control configuration, capability discovery, view variants, epochs, public projection and lifecycle.
2. Implement one vote module through schema → editor → isolated rehearsal participant panel → room operator panel → audience manifest/transport → native set-bound visuals. Use the new Decision Room design and convert the retained Arena's interaction configuration when the contract is ready.
3. Implement moderated text intake and room-chat adapter through the same module/collection/publication infrastructure. Build Open Floor and prove unapproved content never reaches audience or compositor.
4. Implement the managed weather connector and simulation fixtures. Build Atmosphere; prove live provider delivery, stale/error handling and authored effects in both orientations.
5. Install the newly validated packages into the reset catalog alongside Grand Arena. Exercise importing the packages into a clean profile with no manual Vote-panel setup.

Catalog cleanup can be prepared earlier, but do not remove the operator's only usable library and call unfinished mockups its replacement. The product reset is complete only when the replacement packages pass their relevant acceptance checks. No production server deployment, audience publication or streaming is performed merely by writing this plan.

## Completion evidence

- The same generic editor adds/configures a module in a newly imported set; no package-ID branches in the room, audience renderer or compositor.
- Import prepares the correct room/participant interface; explicit live activation publishes it without separate question/choice setup.
- Two real browser participant sessions exercise vote/submission routes against a local test server. Principal/round/epoch rejection, moderation and public privacy are asserted. Rehearsal creates no live traffic or live-state changes.
- Show-driven and standalone activation both work. A persistent module survives a segment change; isolated segment instances do not share local state.
- Real API request succeeds and populates validated weather state; simulated cases separately cover weather effects, malformed input, stale results, reconnect and provider failures.
- Native landscape/portrait captures demonstrate correct source layering, sharp text, dynamic visuals and intentional transitions. Ready scene switching does not gain a generic buffer or unrequested text fade.
- Active picker and a rebuilt clean dev profile contain only the intended fresh library. Grand Arena and its camera bindings remain intact. Existing capture/mixer/room data are not deleted.

These experiences provide evidence for supported composition, module isolation, audience/data integration and authoring flexibility. They do not prove an unbounded "fully capable" engine; unsupported capabilities must still fail preflight explicitly.

## Catalog reset completed

The initial reset removed 16 packages from the isolated dev active library, leaving Grand Arena with an unchanged package hash. Recovery files are outside `sets-library`, under the isolated profile’s `retired-set-packages` directory; [retirement manifest](catalog-retirement.json) records IDs and hashes. The picker’s fixed legacy built-ins are replaced by Grand Arena, new-room fallback uses Grand Arena, and the dev builder seeds only Grand Arena. Regression fixtures remain engineering inputs rather than catalog entries. Existing room source/mixer/account data and the installed production app were not modified.

Validation: TypeScript passed; the configuration browser test passed Grand Arena selection, absence of retired built-ins, saved-package selection/search, thumbnails, nested export/media dialogs, valid/invalid import and toolbar placement. The Python builder script parses and no longer references the legacy seed directory. These checks cover catalog/UI changes, not implementation of the three proposed new experiences.
