# Voice Studio reference Set

`voice-studio.json` is an importable dev reference with landscape and portrait layouts, a host camera slot, editable title, and reusable `voiceBars` shader. It is not installed into saved rooms automatically.

The native renderer supplies a smoothed level from the strongest existing room microphone source, after its gain/mute handling. The Set does not open a microphone, record sound, or alter routing. With no microphone signal the bars remain at a small stationary baseline. This is a level-reactive graphic, not a PCM waveform or frequency spectrum.

Browser previews intentionally simulate a pulse and identify it in the canvas tooltip/accessibility label. They never request microphone access. Native output uses measured levels instead.

Add a `shader` node with `effect: "voiceBars"` to any Set. Existing trusted shader geometry limits apply: place it directly under a plain relative canvas root, keep numeric absolute geometry within the canvas, and use at most four shader layers. `intensity` (0–2) adjusts sensitivity; `scale` (0.25–4) adjusts density, bounded to 8–96 bars. Colors, speed, opacity and corner radius retain existing shader controls. The audio level is renderer-owned and cannot be injected through package JSON.

The draft authoring profile accepts this one trusted audio-reactive preset alongside its core text/box/camera layouts. It does not enable arbitrary shader code, new audio capture, 3D, charts or live API integrations.

Dev verification: native build passed; three envelope expiry/bounds tests, shared schema/projection checks, browser GPU pixels, nine mocked authoring tests and frontend/server types passed. A debug-only native render probe injected a synthetic envelope and observed average pixel delta17.7608 while active and0.0168 after expiry. It opened no microphone. Real microphone permission/device selection remains a hands-on check in the Voice Studio dev room. No production deployment or hosted authoring artifact update was performed.

Follow-up room-path verification: unified legacy and v2 preset validation to fix normal-room rejection. A normal v2 prepare/take probe passed with synthetic audio (activePixelDelta39.2959, expiredPixelDelta0.0126). No capture device was opened by the probe. The isolated demo room camera assignment was cleared after its copied source lacked a ready frame; select a camera through Sources to bind one explicitly.
