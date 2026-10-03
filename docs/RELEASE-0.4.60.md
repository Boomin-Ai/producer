# Producer v0.4.60

Producer can host an interactive audience through its own shareable link without starting an external network stream. Composition and direct video delivery run on the host computer.

- Audience panel adapts to side, top and bottom docks, with compact video settings, raised hands, votes, chat and one copy/share link entry. Share actions support Threads, LinkedIn, X and Facebook.
- Audience playback, chat, votes, reactions and private stage invitations work through the existing room services. Viewer entry does not request a microphone or camera.
- Audience and guest returns reuse one program capture and processed native audio tap. Guest audio is monitored on the host and included in the program; incoming guest voices stay excluded from the guest return bus. Admission remains muted.
- Guest return uses a separate media peer with readiness gating, missed-offer recovery, renewed ICE and an explicit playback-recovery button for phones.
- Publisher reconnects preserve saved settings and connections through permission renewal. The room coordinator orders immediate moderator scene commands and rejects stale versions. Saved votes restore by version and retain cancellation tombstones.
- Native destination health renews the existing brand-profile live-show lease. Recording alone does not declare an external show live.
- Self-hosted backend includes the audience and room coordinator changes; hosted API and web changes are already deployed. The native iOS app is maintained independently at https://github.com/Boomin-Ai/boomin-ios.

## Capacity

Room interactions allow 100 connected audience identities. Direct video defaults to four viewers, capped at eight, and consumes the host computer’s upload and encoding resources. This release adds no automatic relay rental or new Cloudflare product. It does not claim 100 simultaneous video viewers or a load test at that size. Existing application traffic and TURN usage can still incur costs.

## Validation before publication

Producer and self-hosted guest frontend builds and typechecks pass. All 307 backend tests pass. Manager, room lifecycle, publisher renewal, vote restoration, guest readiness/reconnect and grant regressions pass. Native engine audio verification passed earlier, and the physical iPhone rehearsal confirmed guest audio audible on the Mac and Producer output visible on the phone. Distribution signing, notarization, dependency closure and updater signature checks run in the release workflow.
