# Animation foundation

Sets can now define bounded numeric keyframes and layout crossfades in portable JSON. The demo is saved in the local set library at `/Users/klevelandbishop/Documents/boomin/docs/shows/animation-foundation.show.json`, titled **Animation Lab — Native Motion**. Choose it, rehearse, start the show, and use Next to move from Opening to Focus. Both landscape and portrait have their own composition and camera tracks.

```json
{
  "animation": {
    "tracks": [{
      "target": "camera",
      "property": "x",
      "clock": "segment",
      "easing": "easeInOut",
      "keyframes": [
        { "atMs": 0, "value": 900 },
        { "atMs": 1200, "value": 760 }
      ]
    }],
    "transition": { "type": "crossfade", "durationMs": 1000 }
  }
}
```

`animation` belongs to a layout. Targets are authored node IDs within that layout. Supported properties are x, y, width, height, opacity, scale, and rotation. Easing supports linear, easeIn, easeOut, and easeInOut. Tracks can use the show or segment clock, a delay, and none/repeat/pingpong looping. Geometry tracks require absolute positioning; source x/y tracks require numeric base left/top values.

Each layout allows up to 32 tracks, with up to 16 keyframes per track. Keyframes begin at zero, increase strictly, and span at most 60 seconds. Crossfades last up to two seconds. JSON validation rejects unknown targets, duplicate target/property tracks, and unsupported source ancestor animation.

The host sends clock anchors when controls change, rather than sending every frame. Rust samples a monotonic clock and updates private native source placements. Browser graphics evaluate the same bounded tracks locally. Original room sources retain their geometry. Native compositions blend on the actual output, so recordings include their motion and transitions. The two output clocks share control anchors; they are not a frame-locked transaction.

Pause/resume, reset, and segment changes control both paths. In **Set edit → Animation**, pause the show and scrub its segment position. Off-air preparation freezes animation and preserves decoded media for promotion. A transition retains one outgoing composition; another segment change completes the previous blend before proceeding.

This foundation supports direct source geometry and opacity. Framing is prepared for the layout's base geometry; changing aspect ratio during a resize can retain that crop. Animate aspect-preserving dimensions for predictable results. Arbitrary source ancestor transforms, a visual keyframe editor, programmable shaders, and live show execution are separate work.

Bounded GPU preset layers are now available; see [SHADER-LAYERS.md](SHADER-LAYERS.md). Their intensity and scale can use this timeline. Prepared native compositions stage the incoming clock before activation, so promotion does not retain a paused warm-up clock.

Verification completed: Chromium and WebKit rendered movement, pause, seek, reset, and preview crossfades; Rust sampling/clock unit tests; native output pixel checks for camera movement/resizing, pause/seek/reset, landscape crossfade pause/resume, portrait frozen transitions, and unchanged original sources. Native diagnostic artifacts were written to `/private/tmp/producer-animation-CEt8Xj`.
