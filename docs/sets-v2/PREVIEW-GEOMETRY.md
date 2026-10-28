# Native preview geometry

DOM `getBoundingClientRect()` values are relative to the webview viewport. The native preview was positioned as though those values were relative to the window content view. An inset webview or an intermediate Wry/AppKit container breaks that assumption, leaving native video displaced from the HTML canvas border.

`frame_from_css` now finds the actual WKWebView and converts a viewport rectangle through the NSView hierarchy into the preview's parent coordinates. It handles flipped and non-flipped views and nonzero bounds origins. The no-webview fallback also observes the content view's orientation. The shared shim serves landscape and portrait previews; the rendered set/output geometry is unchanged.

The live development window also used full-size content with a 32-point top safe area. Native WKWebView bounds were 1440×813 points while the JavaScript viewport was 1440×781 CSS pixels. WebKit excluded that top inset from its DOM viewport. The conversion now accounts for the webview safe-area origin as well as the container hierarchy. This is measured native window geometry, not a hardcoded 32-pixel offset.

A window resize explicitly refreshes preview placement even when its DOM rectangle stays identical. The frontend still suppresses ordinary unchanged measurements. The engine no longer discards an explicit native move solely because its CSS values match the previous values: titlebar/container placement can have changed independently.

Validation uses the real AppKit shim and WKWebView inside an offset native container, with flipped, non-flipped and full-size titlebar content views. It tests attachment, an unchanged CSS rectangle after moving its native container, and a subsequent resized rectangle. The original shim fails the coordinate assertion; the repaired shim passes. The full-size fixture explicitly requires a nonzero titlebar safe area, so it cannot silently omit the live-window case. `scripts/test-preview-session.mjs` also checks unchanged-measurement suppression, forced refresh, attachment ordering and recovery.

Native check:

```sh
clang -fobjc-arc -fblocks scripts/test-preview-geometry.m src-tauri/src/live/shim.m \
  -framework AppKit -framework WebKit -framework AVFoundation \
  -framework CoreMediaIO -framework SystemExtensions -framework CoreGraphics \
  -o /private/tmp/producer-preview-geometry-test
/private/tmp/producer-preview-geometry-test
node scripts/test-preview-session.mjs
```

This concerns preview placement in the desktop window. It does not move the authored canvas, camera slots or recorded/streamed output. Page zoom and arbitrary CSS transforms of the viewport are not newly supported by this change.

The rebuilt dev window was visually checked using a window-only capture: the native image and HTML canvas outline now align. The temporary native hierarchy probe and one-off DOM logger were removed from normal operation. Measured geometry and checks are recorded in [preview-geometry-proof.json](preview-geometry-proof.json).
