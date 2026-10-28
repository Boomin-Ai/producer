# Producer 0.4.76

Atmosphere 2 provides three larger host-camera compositions in landscape and portrait, a standalone Weather desk module with room city selection, current details, today's forecast, hourly pages and seven daily forecasts. Generated day/night architecture and restrained GPU 3D lighting are composited behind native video and text.

Weather locations belong to module instances. Forecast results and errors are fenced by location revision; saved Integration credentials, units and defaults remain separate. The provider path is fixed to Open-Meteo, city results and forecast horizons are bounded, and absent values remain dashes.

The cold 3D preparation deadline now accommodates the native renderer's first-paint window. Cached layout changes retain their authored 700 ms transitions.

Validation before publication: desktop/server type checks and desktop build; 339 server tests; 29 presentation checks; 18 module checks; schema/forecast/location tests; six browser compositions and four forecast views; real Open-Meteo geocoding/forecast query; prepared-scene cache and cold-start regression; isolated native acceptance. Release verification receipts are added after the signed platform jobs complete.

See [Atmosphere operation and asset prompts](shows/ATMOSPHERE.md). No Map, radar, air quality, official warning feed or live city skyline is claimed. 3D/native Set output remains supported on macOS Apple Silicon; the platform scope from 0.4.75 is unchanged.

Release candidate update (2026-10-28): Atmosphere is the only production built-in Set. Development retains the authoring catalog. Attention Is Currency is an importable solo-host magazine package with cover, reference and manual growth layouts; it is not a production built-in.

Includes reusable mask/backdrop/chart capability contracts, animated hourly charts, bounded per-city weather caching with explicit refresh and stale metadata, data-connection retry, prepared-view caching, retained graphics leases and native preview placement. The engine lock includes the independently tested Metal swapchain synchronization patch. The open device_begin_frame crash in HARDENING-PLAN remains an unresolved development observation; this release does not claim all native graphics lifetime failures are fixed.
