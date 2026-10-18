# Producer v0.4.72

Based on production v0.4.71, adds the signed portrait-camera pair, native whole-picture virtual-camera mirroring, and portrait set fallback. The mirror preference persists and updates the live camera without restarting it. Matching portrait set layouts stay preferred; landscape-only sets are fitted rather than replaced by room-camera sources. Producer output cameras are excluded from camera input selection to prevent feedback.

The macOS camera plugin and portrait extension are rebuilt from pinned OBS source during release, then signed and notarized with the assembled app. The normal updater remains enabled. The dev isolation feature and synthetic probe are not enabled in production.

Existing platform capabilities remain: Apple Silicon native LiveKit hosting, Windows Live engine, engine-less Intel macOS and Linux. The macOS virtual-camera additions do not add Windows or Linux camera support. Production publishing and installer checks are pending the release run.
