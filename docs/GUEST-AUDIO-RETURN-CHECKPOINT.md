# Guest audio and return video — October 3, 2026

Guest audio was present in recordings but silent at the host. Guest/mod browser sources now use OBS monitor-and-output, keep bus 0 for program/recordings, and remain muted on admission. They stay excluded from bus 1 (the guest return). Ending a private cue restores the normal monitoring configuration while leaving the source muted.

The running native preview is `src-tauri/target/guest-audio-preview/Producer.app`. It was rebuilt, signed and verified. Bundled OBS verification passed: monitoring enabled; admission and mute silent; guest audible on bus 0 and absent on bus 1; host on both buses; volume gain respected. The user confirmed hearing the iPhone guest on the Mac after the restart.

The guest's phone then received audio but displayed a blank return video. A fresh live audience viewer decoded Producer's 640×360 video and showed the CNN browser overlay (10,219 of 14,400 sampled pixels were illuminated), establishing that program capture had a visible picture.

Producer's `MonitorSender` now waits for guest readiness before attaching program capture. It accepts earlier untagged/main readiness requests, resends an outstanding offer, and renews ICE for a replacement receiver without acquiring another capture. Regression: `node scripts/test-program-readiness.mjs` passed. Producer's frontend build passed; these frontend changes are served by the current Vite preview and are not a public desktop release.

Boomin web PR [538](https://github.com/Boomin-Ai/web/pull/538) is merged and deployed. Production `/version.json` confirms `e26b20978d009b324464737a96ce129de2d1c261`. Guest pages address readiness to the separate program peer, examine that peer's decoded-video statistics, resume a paused video after React reveals/remounts it, and offer “Watch the show” for playback recovery. Full web build passed. An isolated WebKit test using the actual GuestJoinPage and Producer MonitorSender with real local WebRTC peers passed: five-second iPhone delay, one shared capture, decoded return, hidden-play rejection recovery, manual resume.

The program peer now sends media without an unused data channel or empty video transceiver, so its first media offer contains the actual return tracks. The readiness/reconnect regression and frontend build passed after this change.

Physical verification passed: after reopening Producer Demo and reloading/rejoining the guest page, the user confirmed “Yes, I see Producer’s output.” Together with the earlier confirmation that the iPhone guest is audible on the Mac, both directions now work on the user's devices. This confirms the current rehearsal; it does not establish speaker echo cancellation or audience load capacity.
