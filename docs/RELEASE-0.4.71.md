# Producer 0.4.71

Native LiveKit room commands reuse an independently refreshed, still-current authority snapshot instead of fetching the same authority again before every Admit/Show operation. Missing, expired, unhealthy or mismatched authority falls back to a fresh read. Server-side revision checks, serialized command ownership and post-command verification remain in force, including ambiguous failures.

This release starts from stable 0.4.70 and includes no experimental native media timing, recording, buffering or audio changes. The combined guest browser/API startup is already deployed separately. The native LiveKit optimization applies to Apple Silicon; other platform transport support retains its existing scope. No claim of consistent four-second startup or resolved media continuity is made.
