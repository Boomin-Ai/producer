# Native/browser WebRTC interoperability

The probe links the same LiveKitWebRTC binary and codec factories as the native call controller. It negotiates with Chrome using browser RTCPeerConnection, checks a bidirectional data-channel exchange, and asserts received RTP bytes for both audio and video. Browser audio is silent synthetic audio; video is a generated canvas. It does not access a real microphone/camera, create user messages, or require server secrets.

Compile NativeProbe.swift on macOS with the cached LiveKitWebRTC macOS framework using swiftc, -parse-as-library, -F, -framework LiveKitWebRTC and the matching runtime rpath. Run browser.mjs with the probe binary path as its first argument. Set PLAYWRIGHT_MODULE to an installed Playwright module if it is not in node_modules. Chrome must be installed; port 8894 must be free.

This checks SDK/browser media interoperability. It does not replace signed-in device-to-web testing of the production ticket route, TURN traversal on cellular, permissions, rendering, or call interruption behavior.

To force a real relay test, set ICE_JSON to a JSON array of freshly minted, short-lived RTCIceServer entries; both peers then require relay candidates. Restrict their URLs to turns:turn.cloudflare.com:443?transport=tcp to test TLS/443-only traversal. Keep credentials out of source and logs. The native subprocess inherits this environment.

Verified on 2026-10-04: Chrome-to-Chrome bidirectional decoded video over normal TURN and TLS/443-only TURN, and native LiveKitWebRTC-to-Chrome audio/video RTP plus bidirectional data over TLS/443-only TURN. Physical iPhone-to-production verification is still required.
