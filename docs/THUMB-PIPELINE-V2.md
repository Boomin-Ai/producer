# Thumbnail pipeline v2 — first-principles design for 15–30fps previews

## Why v1 can't go faster

v1 (shipped in 0.4.2/0.4.3): engine-thread tick → `obs_queue_task(GRAPHICS,
wait=true)` → per guest: texrender render → stage copy → **synchronous map**
→ memcpy → back on the engine thread: JPEG → base64 → Tauri JSON event →
webview JSON parse → data-URL img.

Four structural ceilings, in causal order:

1. **The synchronous map is a GPU pipeline bubble.** `gs_stagesurface_map`
   blocks the GRAPHICS THREAD until the GPU finishes the copy just issued.
   That thread is also the compositor. At 7fps×2 guests it's noise; at
   30fps×8 it's 240 bubbles/second in the thread with a 16.6ms frame budget.
2. **`wait=true` couples the engine thread to the graphics thread.** Every
   command (including transform updates mid-drag) queues behind thumbnail
   ticks. Latency you can feel, cost you can't see.
3. **Per-frame allocation + base64 + JSON.** Every frame allocates Vecs,
   inflates 12KB JPEG → 16KB base64, and makes the webview's main thread
   parse it as JSON. ~×120/s at target rates.
4. **Encode on the engine thread.** 1–3ms per guest per frame on the thread
   whose job is command latency.

## v2 architecture

```
graphics thread          encoder thread              webview
──────────────          ──────────────              ───────
every Nth frame          waits on notify             Channel.onmessage
render → stage[k]   ┐    map? NO — already mapped    Blob → objectURL
map stage[k-1] ←────┘    jpeg (reused bufs)          <img> swap (rAF-coalesced)
memcpy → slot, notify    binary frame → Channel
(zero stalls, ~0.2ms)    (no b64, no JSON)
```

1. **Ring staging (K=2 per guest), deferred map.** Frame N stages into
   `surf[N%2]` and maps `surf[(N-1)%2]` — a copy issued one tick ago has
   long completed, so the map returns without waiting. Cost: one frame of
   preview latency (~66ms at 15fps). Nobody can perceive it on a thumbnail.
2. **Capture rides the compositor's own cadence.** No engine tick, no
   queue_task, no wait: a capture step inside the existing graphics-thread
   frame path, self-throttled by frame counter (60/4 → 15fps; 60/2 → 30).
   The engine thread exits the pipeline entirely.
3. **Dedicated encoder thread.** Owns per-guest slot buffers (preallocated,
   reused), wakes on notify, encodes JPEG into reused output buffers, sends.
   Low priority; it can never block graphics or engine.
4. **Binary transport: Tauri `ipc::Channel<Vec<u8>>`,** not JSON events.
   Frame packet: `[u8 id_len][id bytes][jpeg bytes]`. No base64 (−25%
   bytes), no JSON parse (webview gets an ArrayBuffer). UI turns it into a
   Blob/objectURL and swaps the `<img>`, coalesced through
   requestAnimationFrame; previous URL revoked.
5. **Demand control at the source.** New IPC `live_set_thumb_rate(fps)`:
   the UI asks for 15 when the guests panel is visible, 0 when it isn't or
   the room is closed. The engine never pays for pixels nobody is watching.
6. **Lifecycle discipline (the 0.4.2 crash class).** Ring surfaces are
   created/destroyed ONLY on the graphics thread; the capture step addrefs
   each source (`obs_source_get_ref`) around its render; guest add/remove
   marks the ring dirty and the next capture step rebuilds it — no other
   thread ever touches a stage surface.

## Budget (8 guests, 256×144, 15fps)

| Stage | Cost | Where |
|---|---|---|
| render+stage+aged-map+memcpy | ~0.2ms × 120/s ≈ 2.4% of one core, **zero stalls** | graphics |
| JPEG (q62, reused buffers) | ~1.5ms × 120/s ≈ 18% of one core | encoder thread |
| transport | 12KB × 120/s ≈ 1.4MB/s binary | channel |
| UI | 120 blob swaps/s over 8 imgs, rAF-coalesced | webview |

30fps doubles the numbers and still fits. Rate is a config, not a rewrite.

## Phases

- **P1 (engine, the contained upgrade):** ring buffers + graphics-cadence
  capture + encoder thread + `live_set_thumb_rate`. Transport stays events.
  Deliverable: 15fps with zero graphics stalls and the engine thread freed.
- **P2 (transport):** Channel binary path + UI blob pipeline. Deliverable:
  30fps headroom, webview main-thread cost near zero.
- **P3 (later):** generalize to any-source previews — this pipeline is the
  foundation of a real multiview.

## Explicit non-goals

- No change to what renders into the program.
- No per-frame change detection (camera feeds always change; the hash costs
  more than it saves).
- No shared-texture/IOSurface zero-copy path — right answer someday, wrong
  risk profile the week of launch.

## Review questions for the agent

1. Is the K=2 ring sufficient on Metal, or does the copy need K=3 under
   load? (If gs_stagesurface_map on surf[k-1] can still stall when the
   compositor is saturated, triple-buffer.)
2. Source addref/release around render on the graphics thread while the
   ENGINE thread mutates the scene graph — audit graph.rs ownership: is
   there any path where an ExtraItem's source is released off-graphics?
3. Tauri Channel: confirm `ipc::Channel` delivery order + backpressure
   semantics; if unordered or unbounded, packets need a seq byte and the
   UI keeps-latest-only.
4. The encoder thread's shutdown path on engine teardown (process exit vs
   room close) — verify no use-after-free on slot buffers.
