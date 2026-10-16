# Combined guest startup prototype

Built and tested against the isolated hosted pilot; not live in production.

`POST /guest/:code/rtc/startup` resolves the invite, verifies accepted status, reads authority, opens the connection and issues the media session in one browser round trip. Existing reservation/finalization SQL fences remain; the response contains no credentials if issuance fails. Browser validation checks authority and session before installing the ticket. A fresh authority read after SDK connect remains mandatory. Old APIs return to the existing flow on 404/405. The browser starts the serial authority owner while queued, replacing its separate three-second status timer; waiting responses never open a connection or mint a provider token. This increases queued check frequency and needs load/cost evaluation before broad rollout.

Four Admit-start-to-native-thumbnail observations: 3.659, 5.897, 3.701 and 4.161 seconds. Three of four were below five seconds. These use the existing isolated hosted API/database, a local browser bundle and the native diagnostic candidate. They are not production percentiles or a controlled speed comparison against the production API. The fourth overlapped regression and type checks. All four recordings failed the full marker gate, so neither media continuity nor complete sync qualification is claimed.

API regression: 1146 tests passed; API typecheck passed. Browser startup and conversation: 11 tests passed; TypeScript checking passed. Tests cover waiting/revoked guests, malformed inputs, concurrent issuance failure, old-server fallback, invalid response rejection, single join ownership, revocation during joining and freshness outage behavior. Startup batching reuses the established session issuance implementation rather than introducing an authorization shortcut.

The isolated pilot Worker was updated (version da9787f8-f709-4ed0-9862-3cb3d492cbdd); production Worker and browser remain unchanged. The existing allowlisted test room is retained; generated guests were revoked by each observer and the native owner closed. Private capability-bearing journals and synthetic recordings remain outside the repository.

Next: measure with a matched baseline on this same hosted target, then locate remaining decoder-to-presentation wait and missing markers. A startup-only win must not be called a complete media fix.
