# Native set output — development checkpoint

Standalone sets can now be explicitly applied to the room output. Bind existing, visible room sources in Setup → Source slots, then Apply set. Prepared field/layout changes update the composition. Return to room restores the original scene picture. Rehearsal edits never publish to the active composition.

The engine prepares private background/foreground browser sources off-air, obtains bounded layout receipts from a scoped loopback bridge, wraps existing video sources without changing their audio or filters, then atomically replaces the private composition above the original scene. Preparation failures preserve the last good output. Generations and ownership leases fence cancelled or stale updates. Room cuts, source edits and canvas relayout return to the room picture. Saved package/bindings persist; activation does not.

Verified with an isolated native synthetic-source app: actual output pixels changed, Conversation included host and guest, Solo included host only, switching back restored both, Return restored the original pixels and source state, duplicate revisions were rejected, and pending preparation was cancelled by Return. No stream, recording, audience delivery or device capture was exercised by this probe.

Production set output is gated. Live show execution and authoritative participant interactions remain unconnected. Native video slots currently reject transformed/animated/partially transparent ancestors; DOM graphics may use the supported presentation styles. Graphics readiness acknowledges DOM preparation, not a synchronized GPU-frame fence. Stream/recording/audience end-to-end acceptance remains required before release.

Slot framing now supports Fill/Fit and normalized horizontal/vertical crop positions. Signal Desk defaults to Fill. Operator overrides persist with the room's presentation configuration. Native Fill adds a private crop filter before the slot appearance filter; it never crops or filters the original capture. Source dimension changes trigger a fresh composition. Existing JSON without framing retains Fit behavior.
