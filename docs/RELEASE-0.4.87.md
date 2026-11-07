# Producer 0.4.87

Preview any sound in Sound settings before connecting it to a room. Previews play only on this device, replace the previous preview, and stop when the picker closes. Cancelling a loading preview prevents it from playing later. Auditioning leaves room assignments and on-air sounds unchanged.

DJ Sets can follow the current track, upcoming tracks, deck state, and transitions. Opt-in music-reactive 3D layers receive bounded DJ analysis and transport updates without rebuilding the Set for every playhead tick. Supported Sets can also show an animated overlay when a room sound plays; headphone previews do not trigger it.

This release adds bold extruded 3D text, control-triggered animation clocks, configurable music visuals, and rounded camera-edge feathering. Both preview canvases retain their aspect ratios and fit the available room area. The development room uses the full dock layout and preserves later layout changes.

Validated on Apple Silicon with real DJ audio, portrait and landscape output, repeated sound triggers, private library audition, preview cancellation, and preservation of live playback. Cross-platform CI and the release workflow qualify the installed Windows runtime. Physical Windows device and guest-session testing remains a follow-up to that automated qualification.

The previously noted guest reconnect limitation remains: guests may need to refresh their browser after the host leaves and reopens the room.
