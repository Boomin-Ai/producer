# Producer 0.4.91

Producer now includes a dockable Room assistant with ChatGPT sign-in, private
Set authoring and a quieter room toolbar. This release combines the development
work since 0.4.90 into one source for Windows x64, Apple Silicon, Intel Mac and
the existing Linux distribution.

## Room assistant and Set authoring

- Connect a ChatGPT account from the Assistant, including its compact dock.
  Available models come from the connected account. Eligible requests use the
  account's ChatGPT plan, subject to its availability and limits.
- Plan a show, create a Set or refine an existing design through conversation.
  Suggestions follow the latest exchange. Selecting a suggestion prepares an
  editable prompt and does not submit it or change output.
- Drafts use shared, revision-protected authoring transactions, validation,
  undo/redo and saved local journals. Sources, assets, configured values,
  animation and custom per-layout controls remain part of the design contract.
- New multi-format designs must explicitly pair their authored canvases.
  Preview failures remain isolated, with repair and saved-history access.
- The Assistant follows the room Set until editing starts, then preserves its
  private draft when the room changes. Reviewing opens private Set Edit;
  showing changes on output remains a separate host action.
- Move, minimize or expand the panel without cancelling its request or losing
  its prompt. Squeezed docks open a usable conversation overlay. Completion
  previews overlay their dock, dismiss with X or after eight seconds, and
  retain an unread indicator until opened.
- Interrupted sends use bounded recovery. Explicit retry resumes completed
  tool batches without repeating already committed edits. Credential and
  transport work stays outside the capture, audio and graphics paths.

## Room and Set workflow

- The room toolbar uses accessible icons and viewport-bounded tooltips.
  Connected channel icons and the latest Activity notice remain visible.
- Streaming and recording use small anchored confirmation panels with actual
  destinations, output formats and recording save information.
- Set Edit exposes Publish to producer.dev while keeping publication separate
  from room output. Existing handle pages and portable Set downloads continue.
- Missing Set sources have an explicit reconnect picker. Replacing a removed
  capture repairs its shared assignments while preserving source framing.
- Add connected-platform Chat directly to a Set source slot. Chat creation
  uses the existing local overlay bridge and surfaces bridge failures.
- Screen-zoom sliders retain final scrub values and fence late changes from a
  previous room/source. Camera background controls use confirmed native state.
- Unassigned Set slots retain their identity without allocating large empty
  graphics surfaces. Existing Camera, Screen share and React compositions,
  chat toggles, CTA values, custom controls and paired canvases remain covered
  by the existing Set format.
- Room publisher registration and renewal recover with confirmed ownership;
  stale sockets and notices cannot control or leak into a replacement room.
- Messages preserves actionable native workspace-access errors and can recover
  in the same workspace after access is restored.

## Network and platform scope

The release retains the qualified Network recovery work and opt-in native
720p30 program appearances with room ownership and generation fences. Native
appearances remain opt-in; the supported browser transport remains available.
This release does not announce a new latency benchmark or unrestricted
simultaneous output support.

Windows and both Mac targets include their matching native engines and native
guest runtime. Intel requires macOS 13 or later; its documented OpenGL/x264
qualification and Metal limitations remain. Both Mac packages use Developer ID
signing, camera provisioning, notarization and stapling. New virtual-camera
installations still require normal macOS approval.

Linux retains its existing engine-less distribution scope; this release does
not add native Linux capture/broadcast parity. Windows installers remain
unsigned by Authenticode. Updater payloads for every distributed platform
must pass signature verification against Producer's pinned updater key before
the shared update is published.

Automated compilation, browser regressions, installed-engine checks and
artifact verification are separate from physical camera/microphone, two-machine
audio and recording/performance checks. Existing beta limitations still apply.
