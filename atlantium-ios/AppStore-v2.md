# App Store v2 draft

Existing app: 6757367750 · com.atlantium.app · version 2.0.0

## What’s new

Meet the new Atlantium. HQ brings your tech community together with the Lobby, upcoming events, and updates for you. Explore the Frontier, discover tech jobs and resources, and talk with Rene about your next step. Insiders can join the community feed, connect with members, and participate in live conversations.

## Description

Find your people at the frontier.

Atlantium brings tech conversations, opportunities, and community into one place. Explore Frontier articles, jobs, companies, investors, grants, and resources without creating an account.

Create a free account to chat with Rene, manage your profile, register for events, and watch and listen in the Lobby. Rene helps you work toward your goals with questions, suggestions, and resources you can review.

Insiders can access the community feed and member network, exchange introductions and messages, share projects and thoughts, and use microphone and camera controls in the Lobby.

Features:
- HQ with community updates, the Lobby, and upcoming events.
- Frontier articles and ideas.
- Tech jobs with search, filters, and role details.
- A directory of companies, investors, grants, and resources.
- Rene, your AI guide for goals and next steps.
- Insider community posts, member connections, and messaging.
- Audio and video calls from member conversations.

## Reviewer notes

Existing app: 6757367750; bundle com.atlantium.app; version 2.0.0.

The welcome screen offers Sign in and Continue without an account. Email sign-in uses an inline email field and OTP; Google and native Sign in with Apple are also available. Apple sign-in requests only name and email and supports Hide My Email. Apple authorization is revoked when an Apple-linked account is deleted. Guests can browse Frontier, jobs, directory entries, and public event listings.

Signed-in free members can chat with Rene and watch/listen in the Lobby. Insider membership controls community feed/network access and Lobby microphone/camera access. Membership CTAs open the Atlantium website pricing page; the native app does not embed a card-payment form. The website handoff can prefill the signed-in email, but does not automatically request an OTP.

Reviewer access must include a working sign-in method and an Insider account to exercise gated features. Supply these through App Store Connect review information; never publish credentials in this document.

Account controls: HQ → center profile menu → Profile settings / Account. Account deletion is available there. Contact support and member safety reports open an email addressed to team@atlantium.ai; messages are not sent automatically. Member profiles offer blocking/reporting.

Rene answers use the shared production API. Her guest flow uses scripted prompts. AI-generated answers may be imperfect; members can inspect and remove saved references.

Conversation calls are foreground-only and end when the app enters the background. There is no CallKit/PushKit incoming-call ringing in this release.

Privacy URL: https://atlantium.ai/privacy
Terms: https://atlantium.ai/policies
Support email: team@atlantium.ai

Before review submission, confirm the existing screenshots accurately show this release and review privacy answers against account identity, user messages/profile content, AI coaching references, and push identifiers. App and dependency privacy manifests are included; their presence does not establish the App Store privacy questionnaire answers.

## Development calling validation

Conversation audio/video calls reuse the existing signed media ticket, WebSocket signaling, and configured ICE/TURN servers. A fresh incoming conversation invitation offers Answer call for 90 seconds. The same invitation text is recognized from web calls. Calls are foreground-only in this build and end when the app enters the background; there is no CallKit/PushKit incoming-call ringing yet.

Native SDK/Chrome interoperability passed with received audio and video RTP bytes and bidirectional data transport. Signed-in physical-device calling still needs verification before the next release.

## Guideline 4.8 correction — build 4

Added native Sign in with Apple beside Google and email on the inline sign-in screen. Backend validates Apple signatures, audience, issuer, verified email, expiration, and a single-use server nonce. Apple code exchange retains a refresh token for revocation on account deletion. No advertising tracking is introduced. API typecheck and all 118 tests passed. Production reviewer OTP/Insider session and forged-token rejection passed. Physical-device Apple sign-in has not been verified; user requested proceeding without the phone check.
