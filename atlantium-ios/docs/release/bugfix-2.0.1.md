# Atlantium 2.0.1 (5) — post-launch fixes

## Web and API deployed
- Web inbox constrains the thread column to the available height so the message history scrolls and the composer remains visible.
- Enter submits a reply; Shift+Enter adds a newline. IME composition does not submit; sends are guarded while pending.
- Free members receive one Office Hours publishing session every 14 days. The previous implementation allowed only a single lifetime session.
- Existing active reservations return successfully on repeated registration, including after the free pass has been consumed. Publishing access persists for the same event.
- Membership errors now describe recurring free access and unlimited Insider Office Hours. Website copy matches.

Validation: API typecheck passed; all 121 API tests passed with one worker (initial parallel run hit database fixture hook timeouts under concurrent build load). Production API version `3b0e2664-1f4e-4ed5-a57f-6ebc243c6b37`. Pages deployment `c3a9e0b4.atlantium-fe.pages.dev`, live bundle `index-DLnPR3GF.js` verified (final copy also updated on public Office Hours and admin event forms). Production member reservation returned registered/complimentary and subsequent token returned can_publish true, reason free_pass_current_event. On live web at 1440×692, composer bottom was 680; message list had 490px viewport and 1098px scroll height. Empty-composer keyboard checks confirmed Enter handled and Shift+Enter unprevented without sending a test message.

## iOS changes
- Peer calls explicitly use the platform audio device module and configure the WebRTC audio session with playback/recording, voice chat, speaker default, Bluetooth support, and audio enabled. Replaces the implicit audio-module/session setup; physical two-way audio verification is required.
- Live rooms display remote screen-share tracks separately using aspect fit; camera cards select camera tracks specifically. Backend already grants subscription access to registered free and paid members.
- Event check-ins render as compact avatar/name/event rows with smaller reaction controls; report/block/delete actions remain available.
- Event detail loads existing registration, avoids offering another reservation after it is reserved, and disables entering without a confirmed reservation.
- Insider-required errors render a dismissible membership notice with two-week free access copy and an unlimited Office Hours CTA to website pricing through the existing email-prefilled link flow.

Native Debug build and signed Release archive both compiled successfully. Archive version verified as 2.0.1 (5), bundle com.atlantium.app. TestFlight upload succeeded and Apple processing completed. Build 2.0.1 (5), ID c6e0d77e-3271-44df-8810-677424856ae3, assigned to manual-distribution Owner QA group with only the account holder kleveland.bishop@gmail.com. Confirmed Testing status. App Store 2.0.1 draft created with release notes and build 5 attached; not submitted for App Review pending physical call and screen-share testing. These native changes are not in the public App Store build yet. Audio, screen-sharing visibility, and membership UI require physical-device verification before App Review submission. No native development build was installed over the user's App Store installation, to preserve production push registration.
