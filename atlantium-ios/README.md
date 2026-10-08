# Atlantium iOS v2

Fresh SwiftUI app for the existing App Store listing, Apple ID **6757367750**.
Bundle ID **com.atlantium.app**, team **9936A69867**, version **2.0.0**.

## Experience

- Four native tabs: Network, Rene, Events, Frontier.
- Frontier opens publicly: articles, searchable jobs, searchable directory, native detail pages and pagination.
- Network: native member profiles, connection requests, introductions, conversations, blocking and support reporting.
- Native email OTP sign-in preserves the current screen. Session cookies are stored in this device's Keychain; expired/untrusted cookies are rejected.
- Native profile setup merges existing questionnaire answers. Public name/headline/interests and professional visibility are explicit.
- Rene hides the tab bar and gives the composer the bottom of the screen. Guest prompts are programmed locally; signed-in Haiku answers stream from the existing API. Objectives, confirmation, contextual answer chips, resource links, previous messages on request, and private reference review/removal use the existing backend.
- Events: public office hours, member reservations and native LiveKit lobby/session audio-video. Camera/microphone start off, turn off on backgrounding, and disconnect on leaving.
- System tab/navigation glass on supported iOS, with native material surfaces on older versions. No web-view shell.

Production API: https://api.atlantium.ai/v1. No model or LiveKit secret is bundled.

## Build

```sh
xcodegen generate
swift test
xcodebuild -project Atlantium.xcodeproj -scheme Atlantium -destination 'generic/platform=iOS' -derivedDataPath DerivedData -scmProvider system -allowProvisioningUpdates build
```

Device UI tests (iPhone must be unlocked):

```sh
xcodebuild -project Atlantium.xcodeproj -scheme Atlantium -destination 'platform=iOS,id=00008110-0012112101F3A01E' -derivedDataPath DerivedData -scmProvider system -allowProvisioningUpdates test
```

## OneSignal

App ID **c083d166-0d67-4754-9bb5-2e0adc4e6f92**, iOS **Stable 5.5.1**, pinned from the official releases JSON. Swift Package Manager; no CocoaPods migration.

App-side calls are centralized in `Sources/OneSignalManager.swift`. The app delegate initializes once; retained observer immediately checks current subscription and subsequent changes. Empty/local placeholder IDs never count as registration. The once-only registration dialog requests permission only on its button. Debug uses OneSignal's verification wording; Release uses member-facing wording. Sign-in links the authenticated user ID, and sign-out removes that identity. Email/SMS subscriptions are never enrolled by sign-in.

Required native infrastructure is included: embedded `AtlantiumNotificationService.appex`, OneSignalExtension, identical App Group **group.com.atlantium.app.onesignal**, remote-notification background mode, and signed APNs entitlement. Debug uses development APNs; distribution export uses production provisioning.

On a device: launch, wait for registration dialog, tap Got it and allow notifications. In OneSignal, verify a server-assigned subscription and send a test notification with an image. APNs .p8 is configured in OneSignal's dashboard; never put it in this repository. A REST key is only needed for backend sending and should be entered as a backend secret, never committed or put in the iOS target. SDK wiring does not itself add notification sends to backend message/event handlers.

No storage clearing or uninstall is needed to re-test.

## Release

Archive with the current Apple account:

```sh
xcodebuild -project Atlantium.xcodeproj -scheme Atlantium -destination 'generic/platform=iOS' -derivedDataPath DerivedData -scmProvider system -allowProvisioningUpdates -archivePath build/Atlantium-v2.xcarchive archive
xcodebuild -exportArchive -archivePath build/Atlantium-v2.xcarchive -exportOptionsPlist Config/ExportOptions.plist -exportPath build/AppStore -allowProvisioningUpdates
```

The upload options target the existing App Store record; no new listing is required. Upload is separate from review approval. Create App Store version 2.0.0, select the processed build, update screenshots/description and privacy answers, and provide reviewer sign-in access. Logged-out users can browse public content without an account. Account deletion lives in Account. Reporting opens an addressed support email; blocking uses the server's existing block endpoint.

Tests cover URL boundaries, public JSON decoding, streaming event parsing, cookie security/expiration, and real push-registration state. Device UI tests exercise public browsing and the guest Rene flow. Authenticated chat/room behavior and real push delivery require device sign-in/APNs configuration for end-to-end verification.
