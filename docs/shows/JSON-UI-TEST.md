# JSON UI Test — Motion & Audience

Choose **JSON UI Test — Motion & Audience** in the dev set library. It is a separate set; Local Host is unchanged. Start rehearsal, assign sources in Set edit, then press Play.

Exactly two segments, each with landscape (1280 × 720) and portrait (720 × 1280) layouts:

| Segment | Try it |
| --- | --- |
| Motion Studio | Switch cool/warm backgrounds, rectangle/circle cameras, name labels, and screen visibility. Play/restart the embedded video. Watch camera geometry, rotating/scaling artwork, floating graphics, Lottie, shader changes, and text animation. |
| Audience Lab | Press Next, simulate votes and reactions, close voting, and reveal the result. Try a tie to exercise reopen, tie-break, and draw controls. Switch to portrait within the same segment. |

Set edit exposes editable headlines, names, question, grayscale, camera opacity, outline width, and a numeric demo level. The sample feed headline is bound through a reusable component with props. Source controls support fill/fit and crop positioning; bind Host, Guest / second host, and Project screen to room sources.

The package demonstrates every supported node category: box, text, native slot, shader, embedded media, and reusable component. It includes text/number/boolean values, a sample feed, `get`/`eq`/`if`/`concat` bindings, conditional visibility, button actions, and text/number fields. Animation covers x/y/width/height/opacity/scale/rotation, easing, repeat/pingpong loops, shader intensity/scale, and a crossfade between segments. The existing transport supplies play/pause, restart, previous/next, and paused animation seeking in Set edit.

The three embedded assets are a PNG, a small WebM video, and a self-contained Lottie animation. Other supported asset formats are JPEG, WebP, GIF, MP4, and WebM. Video is muted; asset audio is not routed to the room mixer. Media settings expose manual/entry start, once/loop, exit reset/pause/continue, and return restart/resume. The video uses manual start with reset/restart; Lottie uses entry start with pause/resume.

The backgrounds use aurora color washes, edge glow, and a soft light sweep. The engine also supports plasma, silk, rings, grid, stars, petals, contours, and prism. This set avoids those patterned presets.

JSON is a bounded composition system, not arbitrary HTML/CSS/JavaScript. Limits include four shader layers per layout, eight source slots, 32 layouts, 16 segments, 40 controls, 12 MB per asset, and 40 MB per package. Reusable components cannot contain shaders; shaders sit directly beneath the layout root. Animate native cameras directly rather than a parent container. Fonts use the renderer's system font. Rehearsal votes and feeds are simulated; this package does not create an external data integration.

Portable package: [json-ui-test.show.json](json-ui-test.show.json). Rebuild and validate it with `node scripts/create-json-ui-test.mjs`. Browser harness: `http://127.0.0.1:1420/scripts/json-ui-test.html` while Vite is running.

Shared styling: `set.tokens` owns the palette and font stacks; `set.styles`
defines display/body/eyebrow presets, selected with `styleId`. Local styles override
presets without flattening exports. The material-light layer demonstrates a
blurred, clipped color surface with screen blending. Graphic effects cannot
wrap native camera or shader layers. Font families use system fallbacks.
