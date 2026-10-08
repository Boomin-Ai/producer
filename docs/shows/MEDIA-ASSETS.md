# Set media assets

Set settings → Media assets → Import media. Import PNG, JPEG, WebP, GIF, MP4, WebM, or self-contained Lottie JSON. Choose Place in layout to add the asset to the currently selected layout. Landscape and portrait placements are independent. The initial placement is a contained rectangle at 10% from the top/left, 40% of the layout size; the agent can adjust its JSON geometry and styling.

Download package with assets produces one portable JSON file. Each file is embedded once in `set.assets` under a stable asset ID. Layouts/components use media nodes referencing that ID. Existing Import JSON and package export preserve the asset library. Maximum 24 assets, 12 MB each, 40 MB total package. These budgets target logos, short clips and accents; large video libraries need a future external asset bundle/cache.

Example:

```json
{
  "id": "logo-placement",
  "type": "media",
  "assetId": "brand-logo",
  "fit": "contain",
  "loop": true,
  "autoplay": true,
  "styles": {"position": "absolute", "left": 40, "top": 40, "width": 240, "height": 140}
}
```

`set.assets.brand-logo` holds `name`, `mime`, and `data` (`data:image/png;base64,...`). Supported media fit is contain or cover. Video and Lottie support loop/autoplay booleans in the authored node. GIF follows its encoded playback behavior. All video is muted in this milestone; room mixer behavior is unchanged. GIF/Lottie may animate, but show timelines, segment playback rules, transport controls, audio routing and set transitions are separate future work. Native set composition rebuilds can restart playback; content changes are not promised to preserve a video's playhead.

Lottie uses vendored lottie-web 5.13.0 light SVG player (MIT, license beside the player). The light build excludes expressions. Import additionally rejects expressions, external file references, and font dependencies; convert text to shapes and embed any PNG/JPEG/WebP image resources. No remote asset fetching or arbitrary scripts are permitted. CSP permits only data images/media in the sandboxed renderer. Missing asset IDs fail validation. Decode errors show an asset error label. Used assets cannot be removed until their nodes are removed.

Set media currently renders in the browser foreground plane: above native camera slots, matching the existing set compositor. It does not add arbitrary interleaving behind/between native camera slots or shared transport synchronization between canvases. Image/GIF/video/Lottie nodes follow declared order within that plane.

Verification: package round-trip, rejected missing IDs/external references/Lottie expressions, Chromium and WebKit rendering and video decoding/playback, media-file import and placement, native embedded media projection and Lottie readback (#33cb99), existing presentation runtime and native bridge tests, frontend/native builds. Native evidence: `/private/tmp/producer-media-native/result.json`.

## Playback rules

An optional `playback` object on a `set.assets` entry controls the asset across layouts:

```json
"playback": {
  "start": "entry",
  "loop": false,
  "exit": "pause",
  "return": "resume",
  "hostControls": true
}
```

`start`: `entry` or `manual`; `exit`: `reset`, `pause`, or `continue`;
`return`: `restart` or `resume`. Without this object, legacy media node
`autoplay` and `loop` settings remain the defaults.

Set edit → Media shows video/Lottie settings for the selected layout. Enabling
host controls adds Play/Pause and Restart inside the active Segment controls
card, alongside audience controls. The minimized show bar keeps compact media controls. Configuration exports with the set; current position and
playing state do not. Configuration changes preserve the running show and
content. Start/return changes take effect on the next segment entry.

The same asset ID shares a timestamp clock across landscape, portrait and
preview, while its geometry remains independent. Decoder scheduling can cause
small frame differences; this is clock synchronization, not frame-locking.
Content edits and native composition rebuilds reconstruct playback at the
current shared position. Pausing the show pauses media that was playing;
resuming restores those assets. Reset and rehearsal boundaries reset playback.
Continuing an asset on exit advances its clock while offscreen; no hidden
video decoder or asset audio remains running.

This transport currently applies to videos and Lottie. Images are static and
GIFs retain their built-in animation. Media remains muted; asset audio mixer
routing is not implemented in this pass. Native video decode readiness can
briefly delay a freshly rebuilt composition.

Validation: `node scripts/test-media-playback.mjs` checks lifecycle/configuration
and actual video playback in Chromium and WebKit. It uses the demo fixture from
`test-media-assets.mjs` and accepts `PRODUCER_PLAYWRIGHT_MODULE`.
