# Live chart layers

`chart@1` is an opt-in capability of `producer.presentation/2`. A `type: "chart"` node draws a bounded line, area or bar series. It uses native GPU vertex geometry on room output and a trusted canvas renderer in browser rehearsal. No chart creates a browser or Three.js context on native output. Importing a Set cannot supply code, URLs, shaders or unbounded retained history.

```json
{
  "id": "temperature",
  "type": "chart",
  "styles": {"position":"absolute","left":24,"top":70,"width":880,"height":280},
  "chart": {
    "id":"temperature",
    "kind":"area",
    "data":{"get":"modules.sky.temperatureChart"},
    "unit":{"get":"modules.sky.temperatureUnit"},
    "timeZone":{"get":"modules.sky.timezoneLabel"},
    "color":"#f2d3a5",
    "durationMs":650,
    "lineWidth":3,
    "fillOpacity":0.22
  }
}
```

The `data` binding resolves against public presentation fields to JSON text:

```json
{"scope":"city-and-units-generation","points":[{"x":1793102400000,"y":69},{"x":1793106000000,"y":null},{"x":1793109600000,"y":72}]}
```

`x` is a UTC timestamp in milliseconds; labels use the declared IANA time zone (UTC by default). `y:null` is a gap, never a zero reading. Projection sorts timestamps and uses the last occurrence of a duplicate. The strict native boundary requires sorted unique timestamps and independently validates data, dimensions, colors and counts. A scope change starts directly with the new series: changing cities or units cannot blend unrelated values. Forecast data does not claim to be a continuous sensor stream.

Limits: four chart placements per layout/compiled plan; 256 points each; 32 KiB input JSON; 160×100 minimum authored dimensions, 4096×4096 maximum; transition 0–2000 ms; line width 1–8; fill opacity 0–0.5. Chart IDs must be unique per layout. Native IDs include Set definition and instance identity, so unrelated Sets do not morph each other's charts. Optional `yMin`, `yMax` fix an axis; otherwise an axis includes 12% padding. Optional `windowMs` fixes the visible time horizon relative to the latest timestamp. Empty series show dashes.

A trusted adapter can use `ChartSeriesWindow` for append feeds. Generation and revision numbers reject stale deliveries, duplicate timestamps update existing readings, and history is capped at 2–256 points. It publishes snapshots to an existing public module field or Set feed. This helper does not create an API integration or authorize new provider access; ingestion belongs to the existing integration/runtime boundary.

Each prepared native chart is immutable data plus bounded animation state. At a take, the program matches chart IDs, samples the currently displayed curve and domain, copies that state, and releases the old scene through existing ownership. Interruption begins from the displayed state. The presentation clock drives interpolation, scrolling and pause/resume. Stable curves reuse one vertex buffer; no CPU uploads occur once interpolation settles. Changed geometry replaces the buffer, and source destruction frees it. Source and context budgets remain unchanged. Same-layout chart data changes use the chart's animation instead of an additional full-frame content dissolve.

Atmosphere 2.2 replaces the Hourly cards with a temperature area curve and rain-probability bars for the next 24 hours. Previous/Next hours shifts the window in six-hour steps. The city revision and units scope the data. Existing Now, Today and 7 Day cards remain. Open-Meteo updates arrive at the saved polling interval or explicit refresh; chart motion occurs on real data arrival or horizon changes.

Verification: `node scripts/test-charts.mjs`; `node scripts/test-atmosphere-browser.mjs`; Rust native contract tests; native GPU/AddressSanitizer proof (`PRODUCER_PROBE_CHART=1 PRODUCER_PROBE_VISUAL_EFFECTS_ONLY=1`). The native proof checks actual pixels at start/midpoint/end, program-driven data handoff, pause, city fencing, gaps, full 256-point rendering, line/area/bar output, steady buffer reuse and complete chart teardown. Proof summary: `chart-native-proof.json`.

This feature does not resolve the separately tracked intermittent Metal backend crash described in HARDENING-PLAN.md. It remains local Dev work until explicitly released.
