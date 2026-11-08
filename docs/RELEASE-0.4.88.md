# Producer 0.4.88

This Windows patch is delivered as a manual installer. Download the attached Windows setup executable to update. The shared automatic-update release remains [Producer 0.4.87](https://github.com/Boomin-Ai/producer/releases/tag/v0.4.87).

Windows Window Share now uses the selected window title when the operating system supplies no application owner, and captures the selected native window through Windows Graphics Capture. Studio Mode captures Producer's own window through the same Windows backend.

Reopening a room reads its latest saved settings. This fixes a quick exit and re-entry restoring an older scene and overwriting the saved Studio state.

Verified on Windows with a visible test window, real program pixels, repeated Studio toggles, and room re-entry with Studio enabled or Window Share active. Capture sources were released after each room visit.
