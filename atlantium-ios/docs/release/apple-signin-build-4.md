# Sign in with Apple — build 4

- Apple capability enabled for com.atlantium.app.
- Native Continue with Apple button sits beside Google and inline email OTP. Requests name/email and supports private relay.
- Backend verifies RS256 signature with Apple JWKS, issuer, bundle audience, expiration, verified email and single-use server nonce.
- Authorization code exchange stores Apple refresh token for revocation before account deletion.
- Private key stored outside repository in a restricted Application Support directory and deployed as Worker secret; no key contents in release artifacts.
- Atlantium email domains and support senders registered with Apple private email relay. Existing Resend DKIM covers notifications.atlantium.ai.
- API typecheck and all 118 tests passed. Production checks: challenge issuance 200, forged identity 401, direct native-flow bypass 400; reviewer OTP, session, Insider feed and logout all 200.
- API deployment c31ff179-f9a9-43a0-8e97-249e0ac5da71.
- Signed archive build/Atlantium-apple-signin.xcarchive compiled; upload succeeded October 6 at 16:12:44 local time.
- Apple entitlement is present in archived signature.
- Physical-device Apple login has not been verified. User requested proceeding without phone verification.
- App Store processing completed and build 4 resubmitted. Confirmed Waiting for Review at 4:18 PM October 6. Automatic release retained. Existing screenshots retained; no newly captured sign-in screenshot available.
