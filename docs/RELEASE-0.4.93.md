# Producer 0.4.93

Producer adds native Studio motion authoring on macOS and shared improvements
to Set controls, Assistant diagnostics, sounds and compact room panels. All
desktop packages use the same release source; platform media support remains
explicit below.

## Studio motion and Timeline

- Preview and author motion directly in the existing room canvas. The Timeline
  contains transport, motion selection and framing controls without a second
  preview or a separate authoring window.
- Place Timeline in the top or bottom dock, or use its Docked / Studio bar
  switch for a dedicated full-width row above the application status bar.
  The separate bar leaves other bottom-dock panels available. Placement is
  remembered when the room reopens; side docks cannot accept Timeline.
- Animate the Producer window, program canvas, Set Controls or Room Assistant.
  Trim motion clips with their handles and extend the source up to one minute.
  Choose a return to the original framing or a continuous transition to the
  next motion. The Assistant and local development CLI share the versioned
  motion document and validation contract.
- Studio window capture retains native window pixels instead of an early
  low-resolution resize. Perspective-correct GPU sampling, rounded capture
  masks and explicit crop boundaries improve tilted window and panel output.
  Timeline authoring controls and the application status bar are excluded
  from the captured room in either dock or Studio-bar placement.
- Studio no longer forces the room preview into landscape. Portrait and Both
  remain available for ordinary room sources and paired Set layouts.
- Native Studio window capture, panel lifts and motion playback currently
  require macOS. This release does not claim equivalent Windows or Linux
  Studio capture support.

## Set controls and room panels

- Set authors can specify compact controls, equal-width choices, primary
  actions and shared theme tokens. Canvas design and operator controls can
  use the same authored colors while the room header keeps its native app
  appearance.
- Show segments use a compact header selector above their controls. Empty
  segment-control sections are omitted, global Set actions remain separate,
  and source assignments use a compact footer.
- Clips provides direct save, capture and time-window controls in minimized
  horizontal docks, a recent-clip entry, and clearer expanded layouts.
  DJ and output controls fit horizontal room docks more consistently.

## Assistant, sounds and diagnostics

- The Assistant can inspect current room preparation failures and available
  sound metadata through the shared room tools. Authoring contracts describe
  supported sound cues and control styling instead of requiring guesses.
- Failure notices can offer a direct report-to-developer action with a
  sanitized technical report. Sending a report is an explicit user action;
  private credentials and production media are not attached automatically.
- The owned starter collection adds transition and reaction sounds, with
  metadata for sound selection and existing sound-library preview support.
- Private draft validation, explicit output application and existing room
  revision fences remain in place.

## Platform and publication scope

The engine lock and production native guest features remain unchanged.
Apple Silicon and Intel Mac packages retain their matching engine, browser
helpers, recording muxer and camera provider. Mac publication requires
Developer ID signatures, accepted notarization and validated stapled tickets.
Windows retains its installed-engine and native media regression gates.
Linux retains the documented engine-less scope. The shared updater is
promoted only after all four platform packages and updater verification pass.
