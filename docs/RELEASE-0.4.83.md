# Producer 0.4.83

Set preparation now retries a first-frame timeout once before reporting failure, while retaining the current room output and enforcing the same first-pixel checks. Persistent failures identify whether browser startup, WebGL, imported pixels, media dimensions, or capture dimensions are pending and are recorded in the diagnostic log.

Updates now acknowledge installation immediately, show restart progress, prevent duplicate installation clicks, and expose installation/relaunch errors with safe retry. A settings indicator appears when an update is available.

Validation: frontend build and native app build with production guest RTC; browser regressions for first-frame recovery, persistent failure, unchanged output and updater retries; native Atmosphere preparation and repeated cached takes across six layouts using synthetic capture. The original production timeout was not reproduced in the isolated test; no claim is made that the underlying hardware/renderer stall is eliminated.
