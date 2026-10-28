# Atmosphere observatory

Atmosphere 2.1 is a standalone Set. Select it in the editor, bind a saved Open-Meteo weather connection and host camera, then Show on output. No Show is required.

The Weather desk module owns city selection and Now, Today, Hourly and 7 day views. Find a city in the room controls and select a result; this changes only this module instance. Use saved city restores the Integration's default. Previous-city numbers clear immediately and late provider replies are rejected by the location revision. Credentials, units and polling interval remain in Integrations.

The Camera composition module independently selects Hero, Split or Presenter. Each has landscape and portrait layouts, with 760 ms native camera and grouped-panel morphs. Weather-driven lighting and atmospheric effects run behind native camera video and crisp text. Day/night backdrops, subtle moving perimeter reflections and glass cards compose as separate layers. These changes use the existing renderer; weather forecasting and location selection are reusable runtime additions.

Current details include apparent temperature, humidity, wind, precipitation, UV and solar times. Today shows daily high/low and precipitation probability; Hourly pages through 24 hours in six-hour groups; Week shows seven daily forecasts. Empty values remain dashes. Stale data retains its previous update time. Open-Meteo supplies model forecasts, not an official severe-weather alert feed. Map, radar and air quality are not included.

The generic observatory artwork does not claim to depict the selected city. Asset files and generation prompts are in [the asset manifest](media/atmosphere-observatory/README.md). Rebuild the authored package with `node scripts/sets-v2/make-atmosphere.mjs`.

Validation: `node scripts/test-atmosphere.mjs`, `node scripts/test-atmosphere-browser.mjs` (Vite 1436 and local Playwright harness), desktop/server type checks, hosted runtime integration tests, and the opt-in isolated native Atmosphere room proof. Browser sample weather is test data; live runtime queries the saved provider connection.

Local review uses `scripts/sets-v2/local-workspace.mjs`: a fixed server bundle on the Workers runtime, with the existing isolated D1, R2 and Durable Object storage. It does not live-rebuild or run a Wrangler inspector proxy. After server source edits, explicitly restart the local workspace service; desktop UI edits still use Vite. This development service is separate from the hosted production API.

The initial composition is landscape (16:9), with a tall 9:16 host-camera frame. Hero places that camera on the left; Split and Presenter place it on the right, with forecast information on the left. Weather view buttons reuse the same cached city forecast. Recent cities are cached separately, while Refresh weather explicitly requests newer data. Cached timestamps are preserved and outage fallback is marked stale.


The 2.1 visual refresh uses champagne-gold outlines and selection highlights, navy glass cards, and a consistent framed header. The previous 3D platform and orbit are removed. Three.js supplies low-opacity moving perimeter highlights and bounded precipitation accents; native weather shaders provide the continuous rain, snow and cloud motion. The generated observatory photographs remain the architecture. They are generic scenery, not a live picture of the selected city.

Forecast-panel, headline, camera-caption and navigation groups retain authored identity across compositions, so their native placement tracks move whole units rather than changing unrelated text coordinates. Camera pixels remain native. Forecast content changes use a separately authored `animation.transition.contentDurationMs: 260`; layout changes retain a 760 ms morph, without a simultaneous full-frame dissolve. This optional, bounded transition field is reusable by other Sets; omitted fields preserve existing behavior. Browser rehearsal snapshots outgoing preview pixels for the short dissolve without constructing another Three.js context. Native output blends two ready scenes, keeping live camera sources active.

For an opt-in native motion recording, use `VITE_ATMOSPHERE_DESIGN_PROOF=1` in the isolated dev Vite server. It checks three compositions and all four forecast views, rendered revision receipts, transition selection and existing context/cache budgets. Disable the flag before normal review. Nothing is published by this proof.


Atmosphere 2.2 uses reusable `chart@1` layers for Hourly: a gold temperature area curve and blue rain-probability bars, with timezone-aware axes and 650 ms data interpolation. Previous/Next hours shift the visible horizon in six-hour steps. Now, Today and Week retain their summary cards. See [the chart contract](../sets-v2/CHARTS.md).
