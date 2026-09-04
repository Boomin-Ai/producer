import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// The bundle is served by the Worker's static-assets binding from
// server/public, so `/guest/...` is where the hashed assets live on the
// self-hoster's origin. The Worker returns /guest/index.html for the three
// guest routes (/connect/guest/:code, /connect/guest/room/:code,
// /connect/guest/render/:id) and the page routes on window.location.pathname.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/guest/",
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("../public/guest", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    target: "es2020",
    // Fixed names: the output is committed, and a content hash would turn
    // every rebuild into a rename in git. The Worker serves index.html for
    // the routes, so nothing links to the script by hash anyway.
    rollupOptions: {
      output: {
        entryFileNames: "assets/guest.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
