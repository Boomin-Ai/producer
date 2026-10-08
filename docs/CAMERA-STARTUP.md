# Camera startup protection

The October 7, 2026 crash at 11:00:40 occurred in the bundled OBS 32.1.2
`OBSAVCapture.startCaptureSession` callback. macOS's unified log reports:
`setActiveFormat: May not be called without first successfully gaining exclusive ownership of the device using -lockForConfiguration:`.
The exception escaped OBS's session queue and terminated the application.

`capture_guard.m` installs a narrow adapter on that plugin's startup method
after modules load and before sources are created. It acquires a configuration
lock for preset startup, preserves locks already owned by OBS's manual-format
path, and releases only its own lock in `@finally`. Lock refusal skips startup.
An Objective-C exception during startup is logged and contained on the session
thread. The camera can remain unavailable; selecting the device again recreates
its session. This does not change shader rendering or catch global exceptions.

The adapter checks the expected class and selectors. If the plugin API changes,
installation reports a warning; revalidate this adapter when upgrading OBS.

Failure-path validation:

```sh
clang -fobjc-arc scripts/test-capture-guard.m src-tauri/src/live/capture_guard.m \
  -framework Foundation -framework AVFoundation -o /private/tmp/producer-capture-guard-test
/private/tmp/producer-capture-guard-test
```

The test covers lock refusal, exception containment, successful retry, repeated
installation/start, and preserving an OBS-owned lock. A debug native probe with
an explicit `camera-check` marker starts the default camera three times and
requires nonzero captured dimensions each time. It uses an empty isolated graph
and does not load or save a room document.

Validated October 7 on the M1 MacBook Air running macOS 27.0.1: three
successive FaceTime HD Camera starts delivered 1280×720 frames. Results are in
`/private/tmp/producer-camera-check/result.json`. This verifies normal startup
and the tested failure paths; it does not prove an intermittent OS/device fault
cannot recur.
