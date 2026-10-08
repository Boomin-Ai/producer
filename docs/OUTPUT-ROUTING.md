# Selected output canvas

Landscape and Portrait now select the native video output used by stream and primary recording encoders. Both sends landscape and records a separate portrait file. Changing canvas while streaming or recording is rejected to protect active encoders.

Interactive audience and guest return connections share one canvas video track and processed native audio buses. Portrait frames come directly from the native portrait output through binary JPEG IPC at up to 20 fps, 540 × 960. This avoids the installed macOS virtual camera extension's fixed landscape format. External virtual camera consumers still receive landscape.

Audience and guest media use received video dimensions, contain the full picture, and fit the available viewport. Hiding self preview promotes the show. Boomin guest fullscreen hides the page heading and uses the viewport for media.

Validation: native recordings 720 × 1280 portrait and 1280 × 720 landscape, both with audio; canvas switching blocked while recording; phone-sized audience portrait 350 × 622 and landscape 350 × 197. Two WebKit viewers decode the native portrait feed and processed audio with one shared capture.

## Orientation recovery and full-frame geometry

Orientation switches create a fresh, painted canvas track and replace the video track on each existing guest/audience sender. Audio and peer connections remain intact. Landscape capture is letterboxed if needed rather than stretched. The macOS virtual camera plugin converts its full input into the extension’s advertised 1920 × 1080 frame, instead of sending a smaller buffer under that format. Guest fullscreen overrides inline page headings and stage width/height constraints.

Repeated-switch acceptance: two WebKit viewers, four landscape/portrait changes, advancing video times, processed audio energy, zero sender failures, one shared capture, final release cleanup. Boomin fullscreen deployment: 1910ce8. Local Host 1.2.0: one open-source conversation, four views with independent landscape and portrait compositions, Atlantium original branding.
