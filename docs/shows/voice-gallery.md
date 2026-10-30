# Voice Collection — 15 Compositions

Import `voice-gallery.json` as one standalone dev Set. Its 30 layouts are 15 distinct compositions in landscape and portrait. Every layout contains the same host camera slot. Bind the camera once; layout changes preserve its source. The opening composition is Broadcast Line, with a wide host camera above a full-width waveform.

| Composition | Camera and visual arrangement |
| --- | --- |
| 01 Halo Portrait | Central circular camera with a surrounding halo |
| 02 Broadcast Line | Wide camera above a long waveform strip |
| 03 Twin Towers | Tall pill camera between two narrow waveform columns |
| 04 Sidecar Studio | Large camera left; three stacked waveform strips right |
| 05 Cinema Rails | Wide inset camera between top and bottom waveform rails |
| 06 Sound Below | Camera above a large waveform panel |
| 07 Right of Reply | Tall camera right; large corona left |
| 08 Corner Lights | Square camera with four separate corner halos |
| 09 Lower Third | Small circular camera lower left beside a long waveform |
| 10 Orbital Stack | Small circular camera among three offset overlapping orbits |
| 11 Audio Canopy | Camera below a broad waveform canopy |
| 12 Split Signal | Tall camera left; two waveform columns right |
| 13 Spotlight Badge | Large heartbeat visual left; circular host badge lower right |
| 14 Crossfade | Central camera with staggered waveform panels and upper halo |
| 15 The Sound Desk | Camera left; halo and separate waveform strip right |

Sensitivity, Motion and Glow are shared quick controls. Expanded sections group the numbered layouts by orientation, five at a time. Each design has its own static density, geometry, palette and layer arrangement; the controls carry across layouts. The title is editable. Differences are structural, not merely colors or ring variants.

Visuals follow the existing room microphone bus; browser previews simulate levels. They are not exact PCM waveforms or frequency spectra. No additional microphone is opened. Camera windows use native source appearance clipping, and all effects use existing trusted `voiceBars`/`voiceRing` primitives (at most four per layout).

Regenerate: `node scripts/create-voice-gallery.mjs`.

Validate: `node scripts/test-voice-gallery.mjs` (`--schema-only` skips the browser). Set `PRODUCER_PLAYWRIGHT_MODULE` for an external installation. `--contact-sheet` produces a comparison using the actual landscape geometry and camera shapes; `--monochrome` removes palette differences for structural review. Both sheets use clearly synthetic host silhouettes, never camera capture. Files are written to `target/voice-gallery-contact-sheet.png` and `target/voice-gallery-monochrome.png`.
