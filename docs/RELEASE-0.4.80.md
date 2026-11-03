# Producer 0.4.80

Adds room soundboards and the Producer Sounds Stream Deck plugin, including permanent sound libraries, private preview, overlap/loop controls, effects volume and Stop All. Retained Set graphics and prepared views reduce product walkthrough update latency. Includes paired layout navigation, expanded Set authoring and portable integration contracts, and Windows feature parity from PR #118.

The creator library in `assets/creator-library` preserves seven complete importable Sets, all 250 original MP3s (245 unique audio contents), catalogs, the Stream Deck installer and restore instructions. Credentials and device bindings must be configured after restoring.

Local soundboard acceptance: 250 decoded files, no preview leakage into program, silence after Stop All and room exit, 4 ms warmed command response and first audio observed within 122 ms. Controller and plugin protocol checks passed. Physical Stream Deck playback and the newly combined Windows runtime remain separate acceptance checks; plugging in the MK.2 and installing the plugin alone do not prove audio playback.

Combined release builds must complete signing, notarization, payload and updater validation before publication. Native build evidence from the earlier dev build does not substitute for the combined release checks.

Supersedes the unpublished 0.4.79 candidate. Resolves a duplicate native graphics field and counts shared graphics allocations once across active and cached scenes. The exact native Set adapter now has a separate compile gate even when the full engine artifact is unavailable.
