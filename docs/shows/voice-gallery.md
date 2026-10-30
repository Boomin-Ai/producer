# Voice Collection — 15 Studies

Import `voice-gallery.json` as one standalone dev Set. Every study includes the same host camera slot, centered in a circular frame, with its own microphone-reactive visual, palette, headline and background. Bind your host camera once, then switch studies in the layout controls. There are 15 landscape and 15 portrait layouts.

The quick bar exposes Sensitivity, Motion and Glow. Expanded controls group the numbered studies by orientation in groups of five. Collection title is editable. Shared values carry across layouts; switching layouts never changes camera source selection.

| Study | Direction |
| --- | --- |
| 01 Liquid Halo | Flowing aqua and lavender |
| 02 Twin Current | Mint and pale lime |
| 03 Solar Corona | Amber and warm gold |
| 04 Silk Orbit | Soft lilac and ivory |
| 05 Bass Bloom | Pink and deep plum |
| 06 Ripple Pool | Ice blue and navy |
| 07 Magnetic Field | Green and luminous citron |
| 08 Neon Braid | Violet and electric mint |
| 09 Lotus Pulse | Rose and cream |
| 10 Electric Crown | Cobalt and cool white |
| 11 Vinyl Groove | Warm brass and espresso |
| 12 Saturn Drift | Silver blue and peach |
| 13 Heartbeat Loop | Coral and burgundy |
| 14 Ink Aura | Muted lavender and ink |
| 15 Prism Echo | Cyan and pink |

These visuals react to the existing room microphone bus. They do not open a microphone or represent exact PCM waveforms or frequency spectra. Browser previews simulate microphone levels; native output uses the measured microphone bus. The camera sits inside a transparent center, with 110 pixels of surface padding around its circular frame.

Regenerate deterministically with `node scripts/create-voice-gallery.mjs`. Validate all layouts and GPU variants with `node scripts/test-voice-gallery.mjs` (set `PRODUCER_PLAYWRIGHT_MODULE` when Playwright is installed outside the repository). `--schema-only` skips the browser. The package contains no images, embedded assets, network adapters or paid generation calls.

Native verification: dev build passed; native v2 prepare/take with Neon Braid (variant7) reacted to synthetic audio and returned to idle (active pixel delta4.9160, expired0.000209). Shared GPU checks exercise all15 styles, and package/projection checks cover all30 camera layouts. No capture devices were opened by the tests.
