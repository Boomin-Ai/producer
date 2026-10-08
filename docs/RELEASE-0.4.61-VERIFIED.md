# Producer v0.4.61 — branded room domains

Verified October 3, 2026.

The show format proposal is saved separately in [SHOW-FORMATS-CONCEPT.md](SHOW-FORMATS-CONCEPT.md). This release implements branded room entrances, not the future show package or timeline engine.

## Behavior

- Producer defaults to `producer.dev` for Boomin-network audience and guest links.
- Settings → App → General → Share links persists a choice of `producer.dev` or `boomin.ai`.
- Both domains use the same room and Boomin backend. Media continues to come from the host computer.
- Room addresses reserve a stable brand/room alias. Renaming a room preserves its existing address; deleted aliases are not reassigned.
- Guest URLs preserve their existing credentials. Copying a cached link respects the current domain setting. Self-hosted endpoints retain their own URLs.
- Existing legacy entry links remain supported.
- Guest entry pages omit credentials from sharing metadata and use no-referrer/noindex. Dedicated public room bundles omit workspace analytics.

Public rehearsal entrances:

- https://producer.dev/kleveland/audience/producer-demo
- https://boomin.ai/kleveland/audience/producer-demo

Entry still requires the host to keep the room open and enable audience access.

## Production and code

- Producer: [PR 102](https://github.com/Boomin-Ai/producer/pull/102), release commit `013a0267afe287071413c7dea8ceb6820fa88a0b`.
- API: [PR 429](https://github.com/Boomin-Ai/api/pull/429), migration `0169_live_room_share_aliases` applied. Deployment fixture collision fixed in [PR 430](https://github.com/Boomin-Ai/api/pull/430). Authored unavailable-room responses recognized by the deployment mount check in [PR 431](https://github.com/Boomin-Ai/api/pull/431).
- Final API production deployment [37152385382](https://github.com/Boomin-Ai/api/actions/runs/37152385382) passed, including seed fixtures, route mounts and the deployed API behavioral smoke check.
- Web: [PR 539](https://github.com/Boomin-Ai/web/pull/539), production deployment [37150020564](https://github.com/Boomin-Ai/web/actions/runs/37150020564) succeeded.
- Producer site: existing `producer-site` Pages project deployed at https://55148d52.producer-site.pages.dev, serving its existing custom domains.
- Release: [v0.4.61](https://github.com/Boomin-Ai/producer/releases/tag/v0.4.61); all four jobs in [37150965408](https://github.com/Boomin-Ai/producer/actions/runs/37150965408) succeeded.

## Validation

- Producer frontend build passed in the isolated release checkout and local preview workspace.
- Domain helper and site route tests passed; Producer platform CI passed.
- API typecheck and 952 tests passed before release.
- Browser checks passed for default domain, durable setting, failed-save feedback, cached guest links and self-hosted URL preservation.
- Web production build, origin checks and actual Pages Functions runtime checks passed.
- Real API checks passed for both public domains, dedicated JS/CSS assets, canonical sharing metadata, stable aliases after rename, collision allocation, guest namespace mismatch, guest-code rotation and closed audience access. Temporary verification rooms were deleted.
- Live mount check passed all 389 route families and 32 pinned Producer routes after the authored-error correction.
- Preview frontend was refreshed through Vite after applying the tested feature patch. Desktop keyboard automation was unavailable, so reload used the dev server's full reload mechanism.
- Downloaded updater artifacts matched their manifest signatures and sidecars on all four platforms. Minisign verified both content and trusted-comment signatures.
- `producer.dev/download/meta.json` reports v0.4.61 with all four platform installers. Release and updater notes describe the new domain switch. Fresh requests to both public room entrances return their respective Producer/Boomin sharing metadata and the dedicated room bundle.
- Apple Silicon DMG was mounted read-only; app passed deep/strict codesign verification, stapled ticket validation and Gatekeeper assessment (`Notarized Developer ID`). The image was then detached.

## Verified updater SHA-256

| Platform | Artifact | SHA-256 |
| --- | --- | --- |
| Apple Silicon | Producer_0.4.61_aarch64.app.tar.gz | `9d533b42f83405b1ac3aaf29c96214a7405d2aa1738de48abf2021de3bd3605c` |
| Intel macOS | Producer_x64.app.tar.gz | `1ed904e31e189c15514fcb49247c5ab363a3c02e5380b435dce86f5047c90979` |
| Linux | Producer_0.4.61_amd64.AppImage | `b370504db9b368718a907e1f4bb9b0c0d1823d716026b30ea653ba35fbb492bb` |
| Windows | Producer_0.4.61_x64-setup.exe | `5496b35da67822632d4eef86f5e2651448095f2944f1c50b4d037d32c4a2df70` |

Apple Silicon and Windows include the native Live engine. Intel macOS and Linux retain their existing engine-less builds. Domain selection does not change the direct-video limit or add a hosted media relay.
