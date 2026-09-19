import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { buildTargetDefine, resolveBuildTarget } from "./build-target.ts";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode: target }) => {
  // Vite's `--mode` names the build *target*.
  const resolved = resolveBuildTarget(target);
  const { outDir } = resolved;
  return {
    plugins: [react()],
    root: rootDir,
    publicDir: false,
    define: {
      // The source reads these through `globalThis` so they stay safe under vitest, where no define
      // runs at all. A bare `__HALLPASS_BUILD_MODE__` key does NOT rewrite `globalThis.__HALLPASS_BUILD_MODE__`,
      // which left the identifier in the bundle, made `buildMode()` fall through to "production",
      // and pointed every product fetch at an empty origin.
      ...buildTargetDefine(resolved),
    },
    build: {
      outDir: resolve(rootDir, "dist", outDir),
      emptyOutDir: true,
      sourcemap: false,
      minify: false,
      target: "chrome120",
      rollupOptions: {
        input: {
          /**
           * One artefact, one worker entry. The output name is the key, so the bundle lands at
           * `service-worker.js`, where the manifest names it.
           */
          "service-worker": resolve(rootDir, "src/service-worker/index.ts"),
          "side-panel": resolve(rootDir, "src/side-panel/index.html"),
          /**
           * The recording encoder's document (008/T214, FR-121). Keyed `offscreen` so the script
           * lands at `offscreen.js`; `scripts/write-manifest.ts` moves the emitted document itself
           * up to `offscreen.html`, where `chrome.offscreen.createDocument` names it.
           */
          offscreen: resolve(rootDir, "src/offscreen/index.html"),
        },
        output: {
          entryFileNames: "[name].js",
          chunkFileNames: "chunks/[name].js",
          assetFileNames: "assets/[name][extname]",
        },
      },
    },
  };
});
