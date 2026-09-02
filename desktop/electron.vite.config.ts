import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

// electron-vite splits the build into three independent bundles — main (Node),
// preload (the bridge), renderer (the thin local launcher; the real UI is the v3
// console loaded over HTTP at runtime). externalizeDepsPlugin keeps node_modules
// out of the main/preload bundles, which run under Node rather than the browser.
//
// EXCEPTION: electron-store v10 and its transitive deps are ESM-only, but the main
// bundle is CommonJS — an externalized `require("electron-store")` throws
// ERR_REQUIRE_ESM at runtime. Excluding them from externalization makes vite BUNDLE
// them into the CJS main output, so nothing requires an ESM package at runtime.
const esmOnly = ["electron-store", "conf", "atomically", "dot-prop", "env-paths"];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: esmOnly })],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/main/index.ts") },
      },
    },
    resolve: {
      alias: { "@shared": resolve(__dirname, "src/shared") },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/preload/index.ts") },
      },
    },
    resolve: {
      alias: { "@shared": resolve(__dirname, "src/shared") },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    resolve: {
      alias: { "@shared": resolve(__dirname, "src/shared") },
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/renderer/index.html") },
      },
    },
  },
});
