# AI Signal — Vertical Reactions

Version 2.2 is authored exclusively at **1080 × 1920 (9:16)**. One manual
segment contains three operator-controlled modes. The host camera stays connected throughout the 1.1-second transitions; the shared
reaction player retains its playback position between modes.

- **REACT:** large editorial headline, full-width source, full-width reaction camera.
- **HOT TAKE:** oversized statement and dominant camera; a small source reference remains visible.
- **BREAKDOWN:** expanded article/code/video region with a substantial camera underneath.

Electric-blue editorial accents, midnight-blue atmosphere, animated topic identifier
and GPU media/camera glow frames supply motion without covering the picture.
The original Desktop logo.png is embedded in the header with contain sizing. Lighting uses the continuous show clock. Interrupted
mode changes sample the current position before reversing. Pause/resume retains
geometry and shader timing.

Choose portrait output in the room and assign **Host camera**. Use **Load media**
in the fixed reaction player to link MP4, MOV, WebM or an image directly from disk.
Native file links have no embedded upload limit and support long productions with
HTTP byte-range seeking; keep the original file on this computer. Portable browser
imports still embed assets with a 12 MB limit. Loading replaces the same asset
in every mode without resetting the show. **Play/Pause**, **Stop media** (pause
and rewind), and **Restart** control the clip independently of the show transport.
Videos are muted under the current media engine. Content uses contain sizing;
prepare a focused article/code capture rather than an unreadable full desktop.
Camera fill cropping follows its changing aspect ratio.

Editable fields: headline, hot take, topic, source, host name and a manual caption
line. Use deliberate headline breaks (normally two lines, at most three) and short
statements. The caption rail is reserved beneath both videos; it does not perform
speech recognition. Leave its value empty when captions are added in post.

Default safe margins: left 64, right 160, top 96, bottom 240 pixels. No critical
media or text enters the right/bottom UI zones. These are generous starting points,
not a guarantee for every platform's changing overlays. Regenerate with different
safe margins using:

```sh
AI_SIGNAL_SAFE_RIGHT=180 AI_SIGNAL_SAFE_BOTTOM=280 node scripts/create-ai-reaction.mjs
```

Supported ranges: left 48–96, right 120–200, top 72–120, bottom 180–300. The
generator recomposes the regions and exports the actual margins as set tokens;
editing those metadata tokens alone does not recompute geometry.

Generator writes Producer's package and the shared boomin library copy. Tests:
`scripts/test-ai-reaction.mjs`, `scripts/test-layout-transitions.mjs`,
`scripts/test-ai-reaction-transitions.mjs` (Chrome / `--webkit`). Use
`PRODUCER_PLAYWRIGHT_MODULE=<playwright-module>` when Playwright is external.
Native pixel proof is prepared by `scripts/prepare-ai-morph-probe.mjs`.
