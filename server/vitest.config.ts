// Pin vitest to this directory. Without an explicit config here, vitest
// walks up and tries to load the repo root's vite.config.ts (the Tauri
// app's), which fails in CI where the root workspace isn't installed.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: __dirname,
  },
});
