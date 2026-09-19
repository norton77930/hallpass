import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { buildTargetDefine, resolveBuildTarget } from "./build-target.ts";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode: target }) => {
  const resolved = resolveBuildTarget(target);
  const { outDir } = resolved;
  return {
    root: rootDir,
    publicDir: false,
    define: {
      ...buildTargetDefine(resolved),
    },
    build: {
      outDir: resolve(rootDir, "dist", outDir),
      emptyOutDir: false,
      sourcemap: false,
      minify: false,
      target: "chrome120",
      lib: {
        entry: resolve(rootDir, "src/content-runtime/bootstrap.ts"),
        formats: ["iife" as const],
        name: "PocContentRuntime",
        fileName: () => "content-runtime.js",
      },
    },
  };
});
