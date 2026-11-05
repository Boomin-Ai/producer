# Producer 0.4.84

Room Set preparation prioritizes the selected output before background layouts and reuses prepared layouts within the current room generation. Cached layout switches avoid redundant discovery and status requests. Source changes, room changes and expired native resources still invalidate or recover through the existing first-frame and generation checks; a failed preparation retains the current output.

Room and microphone initialization move synchronous native waits off the asynchronous workers used by network and RTC operations. RTC shutdown wakes promptly, stops media work and preserves the authority, in-flight mutation and END retirement fences. Shared HTTP transports avoid rebuilding a client for each control request.

Leaving a room conceals and removes both native previews before clearing its Set and camera graph. An opaque transition covers native removal, with retry if removal fails. A reopening waits for the previous room's native cleanup so its preview cannot be hidden by stale work.

Settings includes optional local performance capture, export and separate opt-in diagnostic sharing. Capture and sharing start off. Captures contain bounded timing and counter metadata, not room names, media, clipboard contents or credentials. Sharing requires a compatible authenticated service and explicit consent; local export remains available independently.

This is the stable Windows update after 0.4.83 and includes production native guest RTC. Windows installers are rebuilt from this release source. Updater signatures are verified before publication; they are separate from Windows Authenticode signing. The Windows installers do not currently carry an Authenticode certificate.

The newer owned-raster graphics cache in the private performance.5/.6 builds is excluded from this release pending D3D11 validation. Mac performance.6 testing continues separately. No claim is made that all startup stalls or high CPU use have been eliminated.

Validation and Windows handoff are recorded in the release PR and its linked Actions runs. Hosted checks cover compilation, the installed engine and available native rendering tests. Real Windows camera/microphone drivers, Atlantium cold and warm opens, guest-link copy, six Set layouts in both orientations, source edits, panel drops, edit mode and room close still require a Windows hardware session. Keep local tracing enabled for that session and record the exact version/source before comparing timings.
