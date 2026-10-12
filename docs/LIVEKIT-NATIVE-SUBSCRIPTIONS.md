# Native guest subscription checkpoint

The staging native host now owns a LiveKit connection and subscribes only to tracks authorized by an independently authenticated room authority snapshot. Snapshots expire within 3.5 seconds, bind the current host connection and run, and match each guest identity, authorization generation, and permitted media source. Duplicate or stale publications fail closed.

The owner serializes lease renewal and authority reads. A room revision conflict permits one independently validated refresh and retry; it never reclaims another host. Shutdown retires the media sink before closing the SDK room. Dropping a pending owner signals cleanup rather than cancelling SDK initialization.

The actual browser guest and LiveKit Cloud staging test passed admission, stage placement, camera-only microphone withdrawal, microphone restoration, removal, and owner shutdown. Removal cleared all owned tracks in 846 ms. Five attached tracks across authorization generations were retired; the sink closed once and the run ended. See `evidence/native-guest-subscriptions-2026-10-12.json` for numeric results and source hashes.

The browser permission parser now accepts narrowed camera-only, microphone-only, and receive-only grants. It publishes only permitted tracks and checks subscription authority separately. This fixes camera-only recovery after host mute.

This checkpoint retains SDK tracks in a proof sink. It does not deliver decoded frames to OBS, mix guest audio, qualify audio/video synchronization, prove ordinary room speakerphone echo cancellation, or change production. Those integrations remain required. One earlier provider retirement failed without enough status diagnostics to classify its cause; staging now records numeric provider HTTP status without response bodies or credentials. No cleanup safety check was relaxed.
