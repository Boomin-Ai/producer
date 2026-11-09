# Producer network implementation

## What was already present

Boomin owns brand-to-brand consent: membership, exact-handle discovery,
invitations and active connections. Producer already exposed those connections,
room visibility, live stages, bookings and a guest-seat entry point. Boomin also
already stored network conversations, ordered messages, unread receipts, blocks,
reports and realtime invalidations. Producer had no client for those messages.

The old desktop guest seat used an earlier signaling protocol, captured a raw
webcam/microphone immediately, and opportunistically substituted a virtual camera.
It did not use the newer native guest authority or processed program audio.
The production RTC route selector also omitted network entry: native room
adoption did not by itself coordinate that legacy credential writer.

## Implemented in this branch

- Boomin messaging and official destination invitations use **Boomin Network**
  branding. Manual and independent-server appearances use neutral Producer
  labels. The [architecture proposal](PRODUCER-CONNECTION-ARCHITECTURE.md)
  separates the local studio, portable collaboration and network services.
- Messages opens a light sheet beside the Home icon rail. Conversations use the
  existing authenticated endpoint bridge. Reads are cursor-based and bounded;
  send retries reuse the same message ID. Read receipts require a focused,
  visible selected conversation at the bottom. One ticket-authenticated socket
  invalidates cached observations, with bounded polling when disconnected.
  Hidden/offline panes suspend subscriptions. Workspace changes dispose private
  state. The rail badge is last observed unread state, not background push while
  the sheet is closed.
- Joining an existing network stage confirms the local room and either **My room
  and Set** or **Webcam and microphone** before entering the media seat.
  Concurrent knocks share one request and lost-response retries retain its ID.
  A knock creates no local capture. The host still admits the visitor explicitly.
- **Join a Producer** accepts a room or invitation URL on Boomin or an independent
  server. Boomin share aliases resolve to Boomin's API. Independent links retain
  their issuer and can name a separate guest API. These public capability calls
  omit account credentials and refuse redirects. A self-hosted `producer_ref` is
  display metadata; it does not impersonate a verified Boomin connection.
- Guest seats follow the server-selected transport. Boomin native rooms use the
  existing authority-fenced LiveKit guest adapter, dynamically loaded on demand.
  Legacy/self-hosted rooms use the maintained HostLink and guest conversation
  adapters. Admission, media grants, host lease, authorization generations and
  scoped subscriptions remain server-owned. An arbitrary server cannot issue
  credentials for the pinned Boomin native provider.
- Set sharing restores the selected local room before publishing. Once admitted,
  it leases one shared program capture, clones owned tracks for muting, and uses
  processed mix-minus audio. It never silently substitutes a webcam. Webcam-only
  participation uses a lightweight guest view without restoring an OBS room.
  The local room requires a known host access response, handed from Home into
  the restore path. A separate visiting-mode bootstrap consumes that response
  without starting the local host roster, heartbeat or scene publisher. Set
  module data reads continue; this mode does not host a second guest roster or
  load that local room's saved vote history through the host control channel.
- Native guest recovery replaces a fenced connection ticket after host restart,
  preserving the admitted guest and owned capture. Rejected renewals retire
  stale RTC; missing/revoked admission stays terminal. Consent-gated guest-stage
  spans reuse the existing diagnostic pipeline without tracing poll traffic.
- A missing Set capture may retry once when the exact bound source becomes ready.
  Current output is retained; unrelated errors, hidden output and stale room or
  session operations cannot authorize a retry. This does not detect native source
  recreation with identical observable metadata.

The companion API change requires migration
`0187_live_rtc_network_entry.sql` and its coordinated network-entry adapter. It
checks consent under room/run locks, keeps one guest identity, preserves existing
admission/grants/placement, retires replaced participant credentials, and recovers
lost responses without storing the private invitation code in command receipts.
The backend change and desktop change must be qualified together before release.
Desktop network knocks require the authenticated `network_entry_protocol:1`
capability before posting, so a new client cannot rotate native guest credentials
through an older uncoordinated backend. Room-link invitations use their separate
guest protocol and do not substitute for verified network identity.

## Media and performance boundaries

The sending Producer renders its Set once. The receiver treats that composed
video as an ordinary guest source and can place it in a Set slot; it does not
receive the sender's executable scene, source credentials or duplicate 3D graph.
The current shared capture is capped at 960×540/20fps (540×960 in portrait).
Peers share capture ownership, but individual WebRTC connections can still need
their own encoders. Camera mute only changes that appearance's cloned track.

This is **not** direct OBS-to-native-RTC publication. Program video still crosses
the virtual-camera/canvas bridge and processed PCM crosses the existing audio
bridge. Virtual Camera must be available for program mode. A direct native
publisher is a subsequent optimization requiring its own frame ownership,
timestamp, backpressure, authorization and echo/mix-minus proofs.

The mix-minus bus excludes received guest audio; it must not be described as an
unqualified full-program audio mix. Multi-room routing with additional local
guests needs an explicit destination-specific mix policy and audible verification.
Host return video is a monitor outside the outgoing Set, never automatically
added as another outgoing source.

Start a program appearance before starting a local stream/recording. This branch
rejects program entry while output is already active instead of assuming that a
newly mounted view has adopted the running room safely. Webcam-only entry does
not change the active OBS graph. Proven adoption of a retained live program is
an additional qualification item.

An opt-in native appearance candidate now exists behind
`PRODUCER_NATIVE_APPEARANCE=1` in the native process. It uses a server-authorized
guest publisher with native 720p30 capture and can attach to the retained running
room controller without restoration. It is not enabled by default or qualified
as a production replacement. The local return preview and end-to-end latency
still require qualification; see [the native appearance acceptance matrix](NATIVE-APPEARANCE-QUALIFICATION.md).

## Independent servers and federation

Guest-link participation works without joining Boomin. The same message client
can use another endpoint that implements the conversation contract, but the
bundled self-hosted server does not yet implement that inbox and displays an
honest unavailable state. Boomin's verified directory/connections do not become
an open federation by accepting a URL. Cross-provider verified identities,
messaging and native RTC need negotiated capabilities and issuer trust; none are
claimed by this implementation.

Native room links retain a server join-intent proof before creating a guest and
recover the same invitation after a lost response. Legacy servers without that
protocol cannot recover an ambiguous first response: the client asks for the
host's direct guest invitation instead of silently creating another guest slot.

## Qualification

Focused checks cover link/issuer validation, no bearer forwarding, duplicate
knocks, retry identity, message cursor/dedupe/read races, safe text, workspace
cleanup, media admission/revocation, stale authority, shared capture ownership,
and native/legacy guest selection. Browser checks use synthetic endpoints and
media; they do not prove a real Mac-to-Windows media connection. The backend
has a disposable PostgreSQL proof for concurrent entry, connection-revocation
races, credential retirement and unchanged admission/placement.

The first real pair is Kleveland on Mac and Atlantium on Windows, using their
existing active Boomin connection. Qualify both directions, visible moving Set
output, audible host/music/guest routing, reconnect after host collapse/reopen,
mute/revoke, and CPU/GPU/encode latency before publishing a production release.
Unit and synthetic browser tests send no real messages or invitations.

On November 8, the authorized native Mac-to-Windows test sent a composed Threads
Set through LiveKit. The user confirmed the complete Set and moving camera on
Windows. The Mac observed about 19 fps outgoing and 31 fps incoming host-program
video; these are instantaneous reported rates, not an end-to-end latency
measurement. Acquiring the shared program took about 589 ms after local restore,
excluding room loading and admission. An already-accepted guest was resumed;
this does not qualify first-time admission. Backend observation confirmed stable
admission, stage placement, host lease and current guest identity after five
minutes. The user also heard audio in both directions; initial Windows silence
was its guest mute/fader setting. Same-run recovery was later observed without a
new network knock. Deliberate host-run restart exposed the fenced-ticket defect;
the corrected final matching clients still need another paired run. Reverse
appearance direction and comparative performance remain separate qualification
items.

The synthetic legacy fixture now preserves the negotiated media order across
recreation of the same logical peer. An earlier 13.6-second run included an
invalid replacement offer and is not a clean production reconnect benchmark.
Matched baseline/candidate observations recover at about 1.65 seconds; a separate
concurrent-load run takes longer. These prove functional continuity and cleanup,
not a measured product performance improvement.

The companion API is deployed at main revision `9ff3e38`, after applying only
migration 0187. Authenticated entry capability returns protocol 1; unauthenticated
requests are refused. Existing conversations, native room preflights and Threads
posts passed post-deployment reads. The network changes have not been published
as a public desktop release.
