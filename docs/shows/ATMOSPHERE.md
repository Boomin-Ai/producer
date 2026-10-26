# Atmosphere observatory

Atmosphere 2 is a standalone Set. Select it in the editor, bind a saved Open-Meteo weather connection and host camera, then Show on output. No Show is required.

The Weather desk module owns city selection and Now, Today, Hourly and 7 day views. Find a city in the room controls and select a result; this changes only this module instance. Use saved city restores the Integration's default. Previous-city numbers clear immediately and late provider replies are rejected by the location revision. Credentials, units and polling interval remain in Integrations.

The Camera composition module independently selects Hero, Split or Presenter. Each has landscape and portrait layouts, with 700 ms native camera morphs. Weather-driven lighting and atmospheric effects run behind native camera video and crisp text. Day/night backdrops, subtle 3D geometry and glass cards compose as separate layers. These changes use the existing renderer; weather forecasting and location selection are reusable runtime additions.

Current details include apparent temperature, humidity, wind, precipitation, UV and solar times. Today shows daily high/low and precipitation probability; Hourly pages through 24 hours in six-hour groups; Week shows seven daily forecasts. Empty values remain dashes. Stale data retains its previous update time. Open-Meteo supplies model forecasts, not an official severe-weather alert feed. Map, radar and air quality are not included.

The generic observatory artwork does not claim to depict the selected city. Asset files and generation prompts are in [the asset manifest](media/atmosphere-observatory/README.md). Rebuild the authored package with `node scripts/sets-v2/make-atmosphere.mjs`.

Validation: `node scripts/test-atmosphere.mjs`, `node scripts/test-atmosphere-browser.mjs` (Vite 1436 and local Playwright harness), desktop/server type checks, hosted runtime integration tests, and the opt-in isolated native Atmosphere room proof. Browser sample weather is test data; live runtime queries the saved provider connection.
