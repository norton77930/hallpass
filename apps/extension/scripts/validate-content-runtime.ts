import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { resolveBuildTarget } from "../build-target.ts";

const target = resolveBuildTarget(process.argv[2]);

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifact = resolve(extensionRoot, "dist", target.outDir, "content-runtime.js");
const source = readFileSync(artifact, "utf8");

new Script(source, { filename: artifact });

if (/\b(?:import|export)\s*(?:\{|\*|["'])/u.test(source) || /["']\.\/chunks\//u.test(source)) {
  throw new Error("content-runtime must be a self-contained classic script");
}
