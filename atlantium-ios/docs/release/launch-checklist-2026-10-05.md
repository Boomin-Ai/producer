# Atlantium launch gate — October 5, 2026

Target: complete readiness checks within one hour, starting 4:20 PM MDT. This is a verification target; Apple processing/review is outside this window.

Status: unchecked items require fresh evidence. Earlier development builds and API tests passed, but do not certify a distribution release.

## 0–10 minutes: release baseline
- [x] Native core tests after crash fix: 17 executed, 1 skipped, 0 failures.
- [x] API: 113 tests passed; TypeScript type checking passed.
- [x] Web production build passed.
- [x] Production web, jobs API and directory API return HTTP 200.
- [x] Updated Release archive and distribution export passed; exported app uses production APNs, get-task-allow=false, and excludes debug preview arguments.

## 10–30 minutes: critical member journeys
- [x] Email OTP: request, invalid code, successful sign-in, persisted session, sign-out — user verified on iPhone.
- [x] Google sign-in returns to the correct screen — user verified on iPhone.
- [ ] Rene on iOS and web completes a real reply; retry does not duplicate messages.
- [ ] Rene resources, goal controls and returning-member summary work.
- [ ] iOS Insider action opens web pricing with email prefilled; OTP is sent only after user action.
- [ ] Direct API enforcement: verify free accounts cannot read Insider feed or publish lobby audio/video. App UI restrictions passed — user verified.
- [x] Insider feed, people and posting access passed — user verified.

## 30–45 minutes: live room on two devices
- [x] Free listener appears in audience; publishing member appears on stage. — user verified in two-device lobby test.
- [x] Camera off removes video immediately on both devices. — user verified in two-device lobby test.
- [ ] Microphone mute works; speaking border follows actual speech. Speaking border passed; mute still needs explicit verification.
- [x] Chat arrives promptly in both directions without duplicates. — user verified in two-device lobby test.
- [ ] Reconnect restores room/chat; leaving removes participant and stops capture. Leaving/capture shutdown passed; reconnect still needs verification.
- [ ] Keyboard dismisses; composer stays clear of messages and navigation.

## 45–55 minutes: release essentials
- [ ] Inbox avatars, timestamps and conversation navigation work.
- [ ] Jobs/directory metrics, filters, pagination and detail links work.
- [ ] Events listing and registration work; occupancy is not exposed before registration.
- [x] Profile editing, legal links, blocking/reporting and account-deletion availability passed — user verified. Actual account deletion not exercised.
- [x] Push arrives on iPhone and opens the correct destination — user verified.
- [ ] Review screenshots, privacy answers and reviewer access are ready.
- [x] App/extension signing verified; App Store distribution export succeeded.

## 55–60 minutes: decision
- [ ] Record failures, fixes and any explicitly accepted limitations.
- [ ] Confirm rollback deployment/build identifiers.
- [ ] Decide: launch, limited beta, or hold.

## Evidence / blockers
- Fresh verification started at 4:20 PM MDT.
- Two-device authenticated flows require signed-in physical devices; build success alone is insufficient.
- No App Store upload or payment transaction is implied by this checklist.

- Logs: `/private/tmp/launch-native-tests.log`, `/private/tmp/launch-web-build.log`, `/private/tmp/launch-api-types.log`, `/private/tmp/launch-api-tests.log`, `/private/tmp/launch-archive.log`.

## Launch blocker: Rene iOS crash
- [x] Keyboard dictation and Rene action buttons passed on the patched iPhone build — user verified.
- Crash report: `Atlantium-2026-10-05-195024.ips`, main-thread SwiftUI `ForEachState` / `KEY_TYPE_OF_DICTIONARY_VIOLATES_HASHABLE_REQUIREMENTS`.
- Cause: APIValue hashing used unordered JSON serialization. Replaced with compiler-synthesized structural Hashable; nested-object dictionary regression test added.
- Crash blocker cleared by user retest. The earlier Release archive predates this fix and must be rebuilt.

## Mobile web upgrade follow-up
- [x] Full payment-form scrolling and mobile layout passed on iPhone after deployment — user verified.
- User verified iOS handoff opens the site; payment form scrolling failed.
- Mobile checkout moved outside Rene into a viewport dialog with independent scrolling and visual-viewport keyboard sizing.
- Touch inputs use at least 16px text to prevent Safari focus zoom; member pages have tighter gutters, scrollable navigation and bottom clearance.
- WebKit layout regression passed: overflowing checkout scrolls, bottom test button reachable, dialog within viewport, input font 16px. Stripe payment submission was not tested or charged.

- Mobile web fix deployment: `https://f4e6bf0a.atlantium-fe.pages.dev`. Payment submission and webhook activation remain unverified.

- User verified free/Insider UI restrictions and publishing access. Direct API bypass checks remain separate.

- Contact support and member safety report mail links updated to `team@atlantium.ai`; phone build passed and update installed.

## Distribution evidence
- Exported IPA: `build/AppStore-ready/Atlantium.ipa`, version 2.0.0 (1).
- Support email is present in the Release binary; debug preview arguments are absent.
- App/extension signature validation passed, shared App Group present, production APNs confirmed on exported IPA.
- Community membership gate and lobby publishing tests: 9 tests passed. Direct production bypass tests still require actual account sessions.
- App Store Connect upload started using Xcode’s existing account and automatic build-number management.

- Distribution IPA SHA-256: `690595c4337d0917aeaa60577f2ec80aede139488a419b167354c4a66207d077`.
- First upload failed in Xcode symbol packaging; retry disabled uploadSymbols while retaining all local archive dSYMs. Second attempt ran out of disk; removed only generated Atlantium build intermediates and temporary IPA verification extraction, then retried. Archive and IPA preserved.

- Final upload retry reached Apple at 21:20 MDT; upload/processing confirmation pending.
- Listing copy updated in `AppStore-v2.md` to describe HQ, Insider gates and external web pricing accurately.
- Listing automation blocked by macOS Chrome Apple Events permission; user signed in to App Store Connect, permission request pending.

## App Store upload completed
- Apple confirmed upload succeeded at 21:22:37 MDT, October 5, 2026.
- Xcode: `Uploaded Atlantium` / `EXPORT SUCCEEDED`; package entered Apple processing.
- Evidence: `/private/tmp/launch-upload-disk-retry.log`.
- Review submission not completed: signed-in Chrome automation denied by macOS; browser access request pending.
- Ready review copy: `AppStore-v2.md`. Next: select processed build, verify screenshots/privacy/reviewer access, submit review.

## App Store listing and reviewer access
- Version 2.0.0 was created and processed build 2 attached. Automatic release after approval selected.
- Updated description, What’s New, and review instructions saved in App Store Connect.
- Privacy disclosures published for persisted messages, profile photos/content, user/device identifiers, and push product interactions. All new disclosures linked to identity; no tracking use selected.
- Dedicated review identity is configured through a Worker secret, restricted to sign-in for test@example.com, with expiry January 5, 2027 UTC. Complimentary Insider access uses an entitlement grant, not a fabricated Stripe subscription or administrator role.
- Production verification passed: OTP request, incorrect-code rejection, correct-code session, Insider feed access, non-admin status, unrelated-account rejection, and sign-out.
- API typecheck passed; 112/115 tests passed with default hook limits. The 13-test lead integration file passed separately with longer hook timeouts after three machine-load timeouts, covering all 115 tests.
- Validation of build 2 found a required 13-inch iPad screenshot. User authorized iPhone-only distribution because no iPad or simulator disk space is available. Project/device-family configuration changed to iPhone only; replacement build 3 archive underway. Apple compatibility validation pending.
- Fresh Atlas Cloud campaign artwork generated and inspected. Header composition is docs/release/artwork/app-store-header-v2.jpg. Browser upload is not confirmed.
- App Store submission remains pending replacement-build validation and listing assets.

## iPhone-only replacement uploaded
- Build 3 archive succeeded and contains UIDeviceFamily [1], version 2.0.0.
- Apple confirmed the replacement upload succeeded at 22:03:51 MDT October 5, 2026. Evidence: /private/tmp/iphone-release-upload.log.
- Preserved archive: build/Atlantium-iphone-release.xcarchive, including local dSYMs.
- Cleared only generated native compiler intermediates and SDK/module caches after the Mac filled up; Chrome can launch again.
- October 6 morning: App Store Connect session has expired. User sign-in requested. Need attach processed build 3, check device compatibility and screenshots, upload inspected header artwork, then submit. No review submission confirmed.

## Apple review submission confirmed
- Version 2.0.0 (build 3) submitted to Apple on October 6, 2026 at 12:52 PM as displayed by App Store Connect. Confirmed status: Waiting for Review. Submission ID: 80d33fd7-9e09-4f59-b5ff-8ab05be9476a. Automatic release after approval remains selected. iPhone-only build passed listing validation. Optional campaign header was removed because its upload blocked submission; artwork is preserved locally.

## Sign in with Apple correction submitted
- Version 2.0.0 (build 4), with native Sign in with Apple and Hide My Email, resubmitted October 6, 2026 at 4:18 PM as displayed by App Store Connect. Confirmed Waiting for Review. Submission ID 80d33fd7-9e09-4f59-b5ff-8ab05be9476a. Automatic release after approval remains enabled. API typecheck and all 118 tests passed; production auth negative checks and reviewer account regression passed. Physical-device Apple login was not verified; user requested proceeding without that check. Existing screenshots retained.
