# Voice Studio reference Set

`voice-studio.json` is an importable dev reference with landscape and portrait layouts, a host camera slot, editable title, and reusable `voiceRing` shader. It is not installed into saved rooms automatically.

The native renderer supplies a smoothed level from the strongest existing room microphone source, after its gain/mute handling. The Set does not open a microphone, record sound, or alter routing. With no microphone signal the bars remain at a small stationary baseline. This is a level-reactive graphic, not a PCM waveform or frequency spectrum.

Browser previews intentionally simulate a pulse and identify it in the canvas tooltip/accessibility label. They never request microphone access. Native output uses measured levels instead.

Add a `shader` node with `effect: "voiceBars"` to any Set. Existing trusted shader geometry limits apply: place it directly under a plain relative canvas root, keep numeric absolute geometry within the canvas, and use at most four shader layers. `intensity` (0–2) adjusts sensitivity; `scale` (0.25–4) adjusts density, bounded to 8–96 bars. Colors, speed, opacity and corner radius retain existing shader controls. The audio level is renderer-owned and cannot be injected through package JSON.

The draft authoring profile accepts this one trusted audio-reactive preset alongside its core text/box/camera layouts. It does not enable arbitrary shader code, new audio capture, 3D, charts or live API integrations.

Dev verification: native build passed; three envelope expiry/bounds tests, shared schema/projection checks, browser GPU pixels, nine mocked authoring tests and frontend/server types passed. A debug-only native render probe injected a synthetic envelope and observed average pixel delta17.7608 while active and0.0168 after expiry. It opened no microphone. Real microphone permission/device selection remains a hands-on check in the Voice Studio dev room. No production deployment or hosted authoring artifact update was performed.

Follow-up room-path verification: unified legacy and v2 preset validation to fix normal-room rejection. A normal v2 prepare/take probe passed with synthetic audio (activePixelDelta39.2959, expiredPixelDelta0.0126). No capture device was opened by the probe. The isolated demo room camera assignment was cleared after its copied source lacked a ready frame; select a camera through Sources to bind one explicitly.


## Center Stage controls

Landscape and portrait center a circular host camera inside a voice-reactive contour. The camera framing remains centered. Sensitivity (0–2), Motion (0–4), and Glow (0–1) are authored numeric Set fields, available in the quick controls. They bind to trusted shader parameters and resolve into bounded numeric values before rendering. Glow is analytic light falloff around each bar, with no extra blur pass; at silence it adds no light.

The same camera, text, masks, and bounded shader layers can be recombined into other compositions. This is layout flexibility using trusted primitives, not arbitrary uploaded shader code. Browser microphone motion is simulated; native output follows the strongest already active room microphone after gain and mute handling.

Center Stage native verification: native build and normal v2 prepare/take pixel probe passed after resolving a native shader uniform/local name collision. Synthetic audio produced average active pixel delta 42.5144 and expired delta 0.00046, without opening a microphone. The input feed now reads audio callback atomics each render rather than waiting for UI meter polling, with a bounded noise gate, faster attack, and smooth release. Layout field discovery includes shader bindings so the numeric controls remain visible. Real device responsiveness still needs a hands-on check.

## Reactive camera border

Voice Studio v1.3.1 uses `voiceRing`: one closed circular contour that develops smooth traveling waves with microphone level, then relaxes to a clean circle at silence. Integer angular harmonics keep its seam continuous; the stroke stays smooth and the glow follows it. The shader is centered on the camera with 90px padding; `radius` matches half the camera width. The center remains transparent and the camera is composited above the shader. Sensitivity, Motion, and Glow remain available. The original linear `voiceBars` preset is retained for other layouts. Browser GPU checks cover the empty center, stable idle border, reactive pixels on all four sides, moving voice waves, and uninterrupted coverage at every angle across multiple frames. The native normal-room prepare/take probe passed with synthetic input (active pixel delta 5.33917, expired delta 0.00412), without opening capture devices. Dev only.

Visibility adjustment: the contour stroke is now 16px at silence and up to 28px with voice, about four times its earlier width, with brighter color and broader glow. The camera center remains transparent. GPU verification includes a minimum visible stroke check as well as continuity and audio motion.
