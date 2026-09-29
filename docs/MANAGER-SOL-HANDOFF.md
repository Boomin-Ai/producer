# Manager implementation handoff for Sol

Read [MANAGER-DESKTOP-PROPOSAL.md](MANAGER-DESKTOP-PROPOSAL.md) first. It is the detailed source/API map and acceptance specification. This file is a compact task boundary, not an instruction to implement before the user starts the build.

## Product decisions already settled

- Manager's first click opens the publishing overview from Boomin's `PublishingTimeline`, not Stages or a selected unit.
- The collapsible collections siderail stays present across Overview, Stages, collections, units and parts. Preserve collapse state using desktop preferences.
- Rename the INNER Manager queue item to Stages. Keep Drafts, In Review, Scheduled, Failed and Collab Invites.
- Carry over collections → units → real `unit_parts`, plus unit and part UI.
- Match the supplied light Boomin Manager design inside desktop Producer chrome.
- Remove Studio entry points and metrics/revenue presentation. Preserve backend attribution and all existing identity links.
- Hosted first; no Neon/D1 migration or self-hosted CMS build in this milestone.
- Automations is the later name for hosted Flows. Manager needs real social-post identity and existing-flow attachment. Full editor + CLI follows; don't pretend attachment alone completes that release.

## Start with M0/M1

1. Record repository status and revisions. Preserve existing work.
2. Create an isolated `src/features/manager/` feature with contracts, navigation and fixture adapter.
3. Add an explicit dev-only preview entry; normal browser startup currently shows onboarding without Tauri.
4. Port Overview, persistent rail, Stages, collection/unit/part and standalone-post visual states using fixtures. No live writes.
5. Follow the screenshot layout, including the parts tree. Do not import all of web ProducerHomePage, UnitDetail or PromptSheetSurface and their Studio dependencies.
6. Verify default/minimum desktop sizes, collapse, first-click behavior, selection and return navigation. Run the frontend build.
7. Present screenshots/preview instructions and a precise checkpoint. Let the user review the visual milestone before expanding scope into live mutations.

This visual checkpoint is recommended by the proposal and the user's dev-first preference; it is not a separate blanket approval requirement if the user subsequently authorizes the full build.

## Key implementation facts

- Desktop: `src/views/Home.tsx` owns Rooms/Manager switching. Its current Manager is a jobs rundown, not the CMS.
- Desktop JSON transport already exists: `guests.request` → `endpoint_request` → Rust `access_request`. Reuse credentials and brand scope; expose a neutrally named typed facade.
- Existing bridge loses structured non-404 errors and treats every 404 as unavailable. Add a compatible structured path before relying on precise Manager errors.
- All cache keys and mutations must include/capture endpointId. Web content keys do not include a workspace; copying them unchanged can mix brands.
- Web `PublishingTimeline.tsx` is the overview screenshot. It auto-generates ideas; use static suggestions initially and remove that call, the metrics and credit dependencies.
- Web `pages/content/ManagerView.tsx` becomes Stages.
- Web `ContentSidebar.tsx` and `index.tsx` supply tree behavior. Part selection currently mounts PromptSheetSurface; port only the agreed non-generation behavior.
- `/series/:collectionId/episodes/:unitId/shots` returns real `unit_parts` of kinds shot/segment/slide, including takes and URLs. Parts are not the distribution folder's carousel images.
- Series reads currently lack the same explicit unit-folder assertions as content detail. Close that gap before release to limited collaborators.
- Instagram sync creates `social_posts` without unit_id. Give them a standalone detail; opening them must not create a unit.
- Explicit assignment of a post into a collection needs a retry/idempotency check: existing helper creates a unit when unit_id is omitted, even if already linked.
- Editing/publishing an existing unit must use content services, not desktop quick-post submission that can create a separate unit.
- Existing folder-aware upload is presign → PUT → finalize. Generic `uploadMedia` is not automatically a CMS attachment operation.
- Existing `inManagerScope` hides imports and Studio-stage units; don't use it as the global inventory filter.
- Do not reset authored part mention spans, unknown spec fields, distribution settings, existing media IDs or attribution links while porting.
- Independent endpoints do not yet implement collections/units/parts. Retain their current functional UI until the backend milestone.

## After the visual checkpoint

Follow M2–M5 in the proposal. Make only demonstrated API/transport changes, reuse existing services, and keep errors visible. Test owner/viewer/folder-scoped access and workspace switching. Use a test workspace for writes; GET unit detail can itself materialize folders.

Each checkpoint should record: changed files, behavior completed, tests actually run, gaps, and next package. Do not claim a production deployment or real comment-to-DM validation from a fixture demo.

## Inspection baseline

Producer `cf55688`; web `13d1312`; API `07991fe`; SDK `ebe3ee2`. Sibling repos are under `~/Documents/boomin/`. Check for drift before using line numbers or changing services. No application code was changed during proposal preparation.
