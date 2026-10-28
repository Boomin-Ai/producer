# Attention Is Currency

Implemented standalone `producer.presentation/2` Set: `attention-is-currency.json`. Generate with `node scripts/sets-v2/make-attention-is-currency.mjs`. Available in the built-in Set picker. No show rundown or new renderer capability is required.

Version 1.0.1 reverses the original navy/cream palette to cream/black across all six layouts, retaining red accents and the original camera colors. The default portrait composition is a magazine cover: full-canvas native host camera, black ATTN masthead and border on a warm cream canvas, red ON AIR label, SVGL distribution logos, editable cover lines and two-part topic headline. Graphics remain separate from the live camera. No still portrait is embedded in the package. Frame the camera so the host's face sits between masthead and headline; adjust the host slot's crop in Sources. Typography overlays the camera; live person segmentation and head-over-masthead effects are not implemented.

Six layouts: Magazine Cover, Topic / Reference, and Daily Growth, each portrait and landscape. Layout changes use the shared 650 ms geometry morph and 180 ms content dissolve. Choose a layout from the existing Layout control. Portrait is 1080×1920; landscape is 1920×1080. These are authored compositions rather than a portrait cover letterboxed on landscape.

Bind Host camera to your camera source. Bind Topic image / video to an image, video or reaction-player source through the existing source assignment. Switch to Topic / Reference to display it. Set controls edit the headline, headline accent, cover line, categories, host name, issue, reference title and source caption. The reference slot uses a fill crop; adjust framing for the source material. Audio and DJ playback use the existing room mixer/player, not an invented Set audio adapter.

Daily Growth is an optional composition for Threads, Instagram, LinkedIn, YouTube, TikTok and X. Fields initially read NOT CONNECTED. Enter a snapshot such as `12,340 / +120 today` and update the snapshot date. No provider, automatic polling, calculated rate or live audience count is implied; authorized integrations are future work. The cover remains the default, with no growth dashboard forced onto the host view.

Critical cover text has room around the face and lower/right controls, but platform interfaces vary. Test the actual camera crop and exported frame on the intended destination before finalizing typography placement.

Logo source SVGs and recolored transparent PNG derivatives: `media/attention-is-currency/logos/`, attributed in SOURCES.md. They are embedded in the portable JSON. Generated concept images in the same media directory are design references, not runtime assets.

Validation: `node scripts/test-attention-is-currency-browser.mjs` parses the package, compiles all six layouts through compileRoomScene with host/reference bindings, checks an editable headline reaches the output projection, and renders a browser preview. TypeScript checked with `npx tsc --noEmit`. A live-camera visual review in Producer is still needed to tune the crop; no production deployment has been performed.
