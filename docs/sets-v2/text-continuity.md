# Text continuity across segment morphs

The reported flicker affected text rather than camera sources or artwork. `layoutTransition` generated an opacity track whenever a text node was new, its string changed, or its position/font size changed. A 650 ms morph held that text at zero opacity until 228 ms, then faded it to one. Only running, unpaused morph changes generated these tracks; other switches did not. The visible duration also depended on the segment clock position when the native take occurred.

Geometry morphs now switch text with the prepared layout without synthesizing text opacity tracks. Explicitly authored text opacity tracks remain supported. Camera rig geometry and entering-panel animation retain their existing behavior. This does not add a crossfade or segment buffer.

The regression test failed before the fix on `host-case-landscape`, reporting an unexpected opacity track for `output/stage/stage-label`. Afterward the 25 presentation checks pass, including adjacent Grand Arena layouts in landscape/portrait and an explicitly authored stage-label fade. The browser Grand Arena check compiles all 12 layouts, confirms eight camera-rig geometry tracks per segment edge, exercises vote/result projection, and renders preview screenshots. TypeScript and diff checks pass.

The older standalone `test-animation.mjs` passed its authoring/clock assertions but could not run its browser portion because its default `playwright` package is absent; it also targets the separate legacy port 1420 harness. It is not counted as a passing browser check here. The current Grand Arena browser suite ran against port 1436.
