# Browser guest reconnection — October 9, 2026

Browser guest links previously opened one signaling WebSocket, with no close/retry handler. Media could continue temporarily after a socket loss, while the guest could no longer negotiate with a recreated host render page. Retrying the same signaling URL would also reuse an expiring ticket.

HostLink now retries socket failures with bounded backoff and requests a fresh guest session through the existing session endpoint. It retains the camera/microphone tracks, screen share and peer connections, refreshes ICE configuration, announces the tracks again, and resumes program requests. Pending offers are flushed when signaling opens; an old answer is not replayed into a fresh host peer. Leaving cancels pending retries and prevents a late session response from reopening the socket.

Both browser entry points (GuestJoinPage and GuestRoomPage) supply the credential refresh. Native GuestSeat has its own connection implementation and is unchanged. The guest asset bundle has been rebuilt locally; no production deployment was performed.

Validation:

- Four reconnect tests: credential renewal and media retention, offline retry backoff, teardown during a pending renewal, and correct offer/answer replay.
- Real Chromium browser test decodes video before and after signaling loss plus remote host-peer recreation, with one credential refresh and the original camera track still live. Signaling/session responses are simulated; this is not a WAN/TURN or live-room test.
- 79 server/guest tests pass for guest admission, participant grants, stage authority and mesh mute enforcement.
- Existing seven program return tests pass.
- Guest TypeScript check, guest production bundle build, and whitespace checks pass.

Run `npm run test:guest-reconnect` for unit coverage. Browser verification uses a local Vite server on 1433 and `npm run test:guest-reconnect-browser`; set PLAYWRIGHT_MODULE and optionally PRODUCER_TEST_CHROME when using an existing browser installation.
