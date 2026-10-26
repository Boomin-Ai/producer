# Just Facts: host-led question show

Version 2.0.0 is a development redesign based on the supplied portrait reference.
It contains ten regular questions and an eleventh, optional tie-breaker. Every
step is manual. The same landscape and portrait layouts are reused across the
show; each question has its own segment-owned research module.

## Presentation

Portrait places a large host camera above two guest cameras, followed by the
score ribbon, question and TRUE/FALSE answer cards. Landscape keeps the cameras
and score on the left and the question/evidence area on the right. The original
generated studio layers remain as a restrained background under native camera
placements and readable graphics. No people or camera footage are baked into
those layers.

The score ribbon reports actual host-awarded points. It does not display invented
viewer counts, audience percentages or poll results. The TRUE/FALSE cards show
which guests the host has assigned to each answer. They are output graphics;
operation happens through the host's module controls.

## Run a round

1. Assign the host, Guest A and Guest B sources in Set edit; select the saved
   research connection once. All eleven research instances share that role.
2. Apply the set and start the Show. The initial question is authored content and
   appears before requesting an agent response.
3. Use **Guest A says** and **Guest B says** to record their TRUE/FALSE answers.
4. Edit the question if needed and use **Show question** to publish the edit.
5. Choose **Ask agent** to request research. The authored `researchView` makes the
   question smaller and opens evidence space while keeping the question visible.
   **Fact-check view** can open that presentation without making a provider call.
6. Review the response privately; **Show response** reveals it. Question view
   restores the larger question presentation. Longer answers retain page controls.
7. Set the host verdict to TRUE, FALSE or Inconclusive, then award the round to
   Guest A or Guest B. The agent never awards points or selects a champion.
8. Advance to the next question.

Each round contributes at most one point. Repeating an award does not add another
point. Switching its winner transfers the point; Clear round award removes it.
Answers, verdicts and awards are stored separately. The host may leave a round
unawarded when neither guest should receive the point.

The scoreboard is set-owned and survives question changes. Research is isolated
per segment; returning to a question restores that question's own state, not
another segment's answer. Segment exit pauses its research module and reentry
resumes it. Delayed results remain addressed to their original instance.

## Finish and tie-breaker

Question 10 is labeled Final question. The host can declare either guest the
champion, declare a draw and stop the Show there. Next enters the explicitly
labeled optional tie-breaker when the host wants it. There is no automatic
conditional jump or claim that the runtime checks tie eligibility.

The tie-breaker is another independent question and can award one additional
point. Awarding/correcting any round clears a previously declared champion so
the host can confirm the new result. Reset on the scoreboard resets the match's
scores, answers, verdicts and awards; resetting one research module affects only
that question's research state.

## Edit the prepared questions

For saved question defaults, open Set edit → Interaction modules, expand the
question's fact-check module and edit Opening question. Save the module, then
apply the prepared set. This changes package configuration and can replace the
live runtime; prepare defaults before the production.

For an edit during the current production, use the current question's operator
text area and Show question. These are live instance values rather than edits to
the reusable package definition. Provider credentials stay in Integrations.

Migration of the isolated development fixture preserves camera bindings, framing,
customized participant names and compatible added set-owned modules. The prior
saved package and room configurations were backed up locally before replacement.
The original v1 question-only headline upgrade remains separate from this redesign.

## Additive authoring primitives

- Operator `Control.segment` scopes a control to an existing Show phase. The
  package validator rejects unknown segments. Visibility is not authorization;
  runtime role/grant checks still govern every command.
- Agent `initialQuestion` supplies authored initial question text. It is public
  authored content; subsequent operator drafts and researched answers keep the
  existing explicit publication gates.
- Agent `researchView` selects a declared module view when research starts;
  `showView` selects the response view on reveal. This show binds geometry to the
  active question module's view without changing its shared layout identity.

These additions require an updated host/server runtime. This document is not a
claim that the previously released installer implements the redesigned contract.

## Bounded live snapshot cache

Native acceptance initially reached the existing 768 MiB per-output scene-cache
limit during question changes. Prepared scene ownership now retains authored
layouts, the latest successfully presented snapshot per output and in-flight
pinned takes; it releases historical live snapshots after use. The existing
native count and texture limits remain unchanged.

Module state and GPU scene residency are separate. Reclaiming a historical
rendered snapshot does not discard a question, response, answer or score.
Revisiting it can reprepare its graphics. An 80-variant regression checks bounded
cache growth, retained authored layouts and preservation of active snapshots.

## Checks

`test-just-facts-show.mjs` verifies the eleven-step rundown, host authority,
idempotent/correctable awards, scores across segments, question isolation,
research-view activation and compact question projection. Existing module and
presentation regressions remain applicable.

`test-just-facts-show-browser.mjs` exercises the actual operator controls and
previews, both orientations, private response/reveal, preserved question text,
evidence fit, tie-breaker and native-plan compilation. Preview captures use
simulated source placeholders rather than fabricated participant footage.

`VITE_JUST_FACTS_PROOF=1` opts into native dev acceptance through the ordinary
editor and Show controls. It uses existing source bindings and a clearly marked
sample response, makes no paid provider calls, and clears its test award/research
state afterward. A running virtual camera is preserved; when orientation is
locked, native acceptance covers the current program output and browser checks
cover both orientations. Do not run this automation during manual operation.

The upload manifest is retained separately from live scene snapshots. Retention
names at most 24 asset IDs, still subject to the existing 40 MiB media budget.
Changing a question must not clear that manifest and force the same artwork to
be uploaded and hashed again. Replacing the loaded package releases unused IDs.

## Verification

- `node scripts/test-just-facts-show.mjs`: all eleven question instances, correctable
  one-point awards, persistent scores, isolated research and operator authority.
- `node scripts/test-just-facts-show-browser.mjs`: actual operator controls and
  landscape/portrait previews; question remains visible beside revealed evidence.
- `node scripts/test-prepared-scenes-browser.mjs`: 80 changing live snapshots stay
  bounded; loaded artwork uploads once and unused manifests are released.
- Opt-in `VITE_JUST_FACTS_PROOF=1`: native show replay through all eleven segments
  and back, award idempotence, evidence reveal and restoration of test state.
  This test uses the existing camera binding, creates no sources and makes no
  provider calls. Program output was verified natively; portrait was verified
  in the real browser preview and native-plan compilation. The user's active
  virtual camera was preserved, including its orientation lock. Recorded result:
  [native acceptance](../sets-v2/native/just-facts-show-ui-proof.json).

The isolated dev app now navigates to the current Vite frontend on normal reopen,
so a plain cargo-staged build cannot silently display older embedded frontend
assets. Inspection does not replace the configured package with the studio proof.
