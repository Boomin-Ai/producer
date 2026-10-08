# Production push diagnosis — October 7, 2026

## Result
Corrected the owner iPhone subscription in OneSignal. Follow-up push delivered successfully without an app update. No backend or native source changes were needed.

## Evidence
- Latest direct message: OneSignal accepted the request, but recorded 0 delivered and 1 unsubscribed.
- Targeted diagnostic reproduced the failure. Subscription status: `apns_bad_device_token`.
- The subscription retained `test_type: 1` (development) from pre-release installation while its current APNs token was production.
- A direct APNs request using the existing push key, bundle ID `com.atlantium.app`, and current token returned HTTP 200 on production and HTTP 400 `BadDeviceToken` on sandbox. No tokens or private keys are recorded here.
- App-level OneSignal APNs configuration was already production, with the correct bundle ID and developer team.

## Repair and verification
- Updated only the owner iPhone subscription: production test type, enabled, notification types 1. This restores the subscribed state invalidated by the environment mismatch; the phone had been subscribed immediately before the failed send.
- Confirmed the subscription no longer had an invalid identifier.
- Sent a second OneSignal test only to that subscription.
- Verification report: [Owner production push verification](https://dashboard.onesignal.com/apps/c083d166-0d67-4754-9bb5-2e0adc4e6f92/push/2d746f58-4be9-4db3-8a42-e04b15f9fc0b): 1 sent, 1 delivered, 0 unsubscribed, 0 failed.
- User-visible receipt confirmation is still pending. Delivery metrics establish provider delivery, not visibility of a banner under Focus or notification settings.

## Account behavior
The currently registered Atlantium account was `klevelandbishop21@gmail.com`. Apple ID email does not choose the Atlantium push recipient. OneSignal login moves the phone subscription to the current Atlantium account; direct messages for a previously signed-in account will not target this phone after switching accounts.

## Scope
This was a pre-release-to-App-Store device migration issue. Do not force every subscription to production: genuine Xcode development installations need sandbox routing. Ordinary new App Store installations should register production subscriptions automatically. Recheck this migrated phone after relaunch/account switching if delivery regresses; do not globally override push payload routing.

## Follow-up: real-message test at 8:21 PM MDT
User screenshot confirmed both direct APNs and corrected OneSignal diagnostic banners appeared. The top message banner was a Gmail notification, not an Atlantium push.

Production outbox showed the two new messages at 8:20:08 and 8:20:52 PM targeted `kleveland.bishop@gmail.com`; both returned `no_subscribed_devices`. The active iPhone subscription still belonged to `klevelandbishop21@gmail.com`, with production routing and a valid identifier after the app reopened at 8:20:35 PM. Thus these messages targeted a different account from the currently registered phone. Requested the user sign into the intended recipient account and send a fresh message for end-to-end production verification.

## Follow-up: account switch resets environment (8:25 PM MDT)
The next real message targeted the intended account correctly. Provider ID `a5e66fdd-2673-43c0-b7ef-ee3421e9ed50`, created 2026-10-08 02:25:29 UTC. After the sign-in, the same subscription reported `external_user_id: ZzKJe7KtVEKOspkceD88PXlljHyc9aoN`, but `test_type: 1` and `invalid_identifier: true` again. Thus a manual OneSignal correction does not survive account switching on this migrated development installation. Requested deleting and reinstalling the App Store app to clear the SDK state, followed by a new production message test. Permanent verification is pending that new installation; do not report all push flows fixed yet.
