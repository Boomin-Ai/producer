# Native hosted room authority — October 12, 2026

The opt-in native application now contains `rtc_control::Control`, using the
existing hosted connection, control and session endpoints. The client pins the
dedicated staging Worker and authorized LiveKit project. It holds the operator
credential and connection ticket in Rust; neither is serializable or included
in debug output. Responses are bounded to 32 KiB while streaming, requests time
out after five seconds, redirects are disabled, and provider/error bodies are
never logged.

Mutating methods require exclusive mutable ownership. Start, renew and end use
server receipts and compare-and-swap expectations. Renewal must retain the same
run, host participant and epoch. A failed or malformed control response clears
local publication authority. Session parsing uses an independently held receipt
and the fixed producer camera/microphone policy; no authority is copied from a
join token. Connection tickets renew after five minutes when `renew` is called.
This object does not itself schedule heartbeats or automatically reconnect.

The actual native executable passed open → start → validated session → renew →
validated session → end against the isolated hosted room. A subsequent database
read confirmed all 11 selected-room runs ended. Evidence is in
[evidence/rtc-native-control-2026-10-12.json](./evidence/rtc-native-control-2026-10-12.json).
The debug-only `PRODUCER_RTC_CONTROL_PROOF` entry runs this flow before Tauri
window setup, reading only the private operator profile. It opens no devices,
publishes no media, and never reads the LiveKit API secret.

This is **native authority connectivity, not an ordinary-room media call**.
The SDK owner, scheduled heartbeat/control actor, authenticated guest-generation
snapshot, synchronized ingest, native camera/program return, room exit handling
and speaker-reference/AEC still need integration. No UI rollout, production
deployment, signing or notarization is established by this proof.
