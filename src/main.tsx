import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// Platform marker for CSS that must differ per host (scrollbars: Windows'
// WebView2 paints classic ones, macOS overlays are invisible until scrolled).
document.documentElement.dataset.platform = /Windows/i.test(navigator.userAgent) ? "win" : "mac";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
