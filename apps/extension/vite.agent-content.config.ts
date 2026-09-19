import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { buildTargetDefine, resolveBuildTarget } from "./build-target.ts";

const rootDir = dirname(fileURLToPath(import.meta.url));

/**
 * The agent build's declared content script, built on its own (004/T107).
 *
 * Separate from `vite.content-runtime.config.ts` because Vite's library mode takes one entry per
 * IIFE bundle, and separate from `vite.config.ts` because a declared content script must be a
 * classic self-contained script - it cannot import a chunk.
 */
export default defineConfig(({ mode: target }) => {
  const resolved = resolveBuildTarget(target);
  return {
    root: rootDir,
    publicDir: false,
    define: buildTargetDefine(resolved),
    build: {
      outDir: resolve(rootDir, "dist", resolved.outDir),
      emptyOutDir: false,
      sourcemap: false,
      minify: false,
      target: "chrome120",
      lib: {
        entry: resolve(rootDir, "src/content-runtime/agent-entry.ts"),
        formats: ["iife" as const],
        name: "PocAgentContent",
        fileName: () => "agent-content.js",
      },
    },
  };
});
