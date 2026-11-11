import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initializePerformanceTrace } from "./lib/performanceTrace";

// Best effort and consent-gated; never delay the application shell.
void initializePerformanceTrace().catch(() => {});

// Platform marker for CSS that must differ per host (scrollbars: Windows'
// WebView2 paints classic ones, macOS overlays are invisible until scrolled).
document.documentElement.dataset.platform = /Windows/i.test(navigator.userAgent) ? "win" : "mac";

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
// Explicit authoring-only native verification. No room or device is started.
if (import.meta.env.DEV && import.meta.env.VITE_PRODUCER_ASSISTANT_WORKBENCH === '1') {
  void import('./features/assistant/AssistantWorkbench').then(({default: Workbench}) => {
    root.render(<React.StrictMode><Workbench/></React.StrictMode>);
  });
} else {
  root.render(<React.StrictMode><App/></React.StrictMode>);
}

// Explicit local native verification only; removed by the production build.
if(import.meta.env.DEV&&['1','review'].includes(import.meta.env.VITE_THREADS_ROOM_PROOF)){
 void import('./features/sets-v2/threadsRoomProof').then(m=>m.threadsRoomProof());
}
// Installs an explicitly initiated, passive tool in allowlisted native dev
// bundles only. Neither loading the app nor enabling the flag starts a run.
if(import.meta.env.DEV&&import.meta.env.VITE_PRODUCER_NETWORK_DIAGNOSTICS==='1'){
 void import('./features/network/networkDiagnosticsProof').then(m=>m.installNetworkDiagnosticsProof()).catch(()=>{});
}
// The paired test still requires an explicit run with a bounded room fixture.
// This flag only installs the driver in the isolated Mac development bundle.
if(import.meta.env.DEV&&import.meta.env.VITE_PRODUCER_NATIVE_PAIR_PROOF==='1'){
 void import('./features/network/nativePairProof').then(m=>m.installNativePairProof()).catch(()=>{});
}
// A separate explicit fixture+nonce is required for an automated local run.
// The launcher consumes that nonce before acting and never retries on reload.
if(import.meta.env.DEV&&import.meta.env.VITE_PRODUCER_NATIVE_PAIR_RUN){
 void import('./features/network/nativePairLaunch').then(m=>m.launchNativePairFromEnvironment()).catch(()=>{});
}
