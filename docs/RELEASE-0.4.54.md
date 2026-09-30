# Producer v0.4.54

## Streaming destinations

- Adds Facebook Live, Instagram Live, Rumble, and TikTok LIVE to the existing streaming destination flow.
- Routes all four through the native RTMP/RTMPS multistream engine; stream keys remain in the OS keychain.
- Adds platform setup links and guidance, including Instagram’s fresh broadcast key and Facebook’s persistent key option.
- Allows server URL and stream key updates directly from Channels.
- Preserves a destination’s armed/disarmed state when editing it.
- Migrates existing destination databases without losing saved destinations, workspace scopes, or keychain references.

TikTok requires account access to streaming-software credentials. Starting the encoder may require a separate Go Live confirmation on the platform.

## Verification

- Frontend production build passed.
- Engine-enabled Rust build passed locally.
- Database upgrade tests passed for both the original schema and the schema containing Instagram/Rumble/TikTok.
- User confirmed the dev changes work before requesting this production release.
