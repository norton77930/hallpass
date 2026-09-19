import { execFileSync, execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

/**
 * `npm run package` — the QA installation package (007, FR-094).
 *
 * One command turns a checkout into `release/hallpass-<version>.zip`: the agent build of
 * the extension, the host bundled into three self-contained files, the two PowerShell scripts and
 * the README. The bundler is Vite's own JS API (already a dependency: it builds the extension), in
 * its server-side mode with nothing externalised except Node's built-ins, which is what makes the
 * host runnable from an extracted folder with no `node_modules` beside it (US1.2).
 *
 * This file imports nothing from the repository itself: it runs under `--experimental-strip-types`,
 * which cannot resolve a sibling `.ts` through a `.js` specifier, and the contract test imports
 * `bundleHost` from here to prove the bundle's imports without producing the zip.
 */

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The three host entries and the flat names they take inside `host/` (T201). */
export const HOST_ENTRIES = [
  { entry: "packages/agent-host/src/mcp-server.ts", output: "mcp-server.js" },
  { entry: "packages/agent-host/src/native-host.ts", output: "native-host.js" },
  { entry: "packages/agent-host/src/install/cli.ts", output: "install.js" },
] as const;

/** What the zip's root holds, exactly (US1.1; the contract test pins it). */
export const PACKAGE_ROOT_ENTRIES = ["extension/", "host/", "install.ps1", "uninstall.ps1", "README.md", "VERSION"] as const;

export const PACKAGE_NAME = "hallpass";

const extensionDistDir = resolve(repoRoot, "apps/extension/dist/agent");
const releaseDir = resolve(repoRoot, "release");
const stageDir = resolve(releaseDir, "stage");
const packageAssetsDir = resolve(repoRoot, "scripts/package");
const smokeTest = "packages/agent-host/tests/bundle-smoke.test.ts";

/**
 * Bundle the three host entries into `outDir`, self-contained.
 *
 * `ssr` selects Vite's node-targeted pipeline; `noExternal: true` pulls every dependency
 * (`@modelcontextprotocol/sdk`, `zod`, `@hallpass/contracts`) into the file; `external: [/^node:/]`
 * leaves the built-ins as the only imports. ES output with no source map and no minification, so a
 * tester's stack trace still names the function that failed.
 */
export async function bundleHost(outDir: string): Promise<string[]> {
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  for (const { entry, output } of HOST_ENTRIES) {
    await build({
      configFile: false,
      root: repoRoot,
      logLevel: "warn",
      resolve: { conditions: ["node"] },
      build: {
        ssr: resolve(repoRoot, entry),
        target: "node24",
        outDir,
        emptyOutDir: false,
        minify: false,
        sourcemap: false,
        rolldownOptions: {
          external: [/^node:/],
          output: { format: "es", entryFileNames: output, chunkFileNames: `${output.replace(/\.js$/, "")}-[hash].js` },
        },
      },
      ssr: { noExternal: true, target: "node" },
    });
    written.push(resolve(outDir, output));
  }
  return written;
}

/** The Windows `tar.exe` (bsdtar) writes zip with `-a`; the Git Bash `tar` on PATH is GNU and cannot. */
function windowsTarPath(): string | undefined {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const candidate = join(systemRoot, "System32", "tar.exe");
  return existsSync(candidate) ? candidate : undefined;
}

export function zipDirectory(sourceDir: string, zipPath: string): void {
  rmSync(zipPath, { force: true });
  const tar = windowsTarPath();
  if (tar) {
    execFileSync(tar, ["-a", "-cf", zipPath, "-C", sourceDir, "."], { stdio: "inherit" });
    return;
  }
  execFileSync(
    "powershell",
    ["-NoProfile", "-Command", `Compress-Archive -Path '${join(sourceDir, "*")}' -DestinationPath '${zipPath}' -Force`],
    { stdio: "inherit" },
  );
}

/** List a zip's entries the way the contract test does, through the same `tar.exe`. */
export function listZip(zipPath: string): string[] {
  const tar = windowsTarPath() ?? "tar";
  return execFileSync(tar, ["-tf", zipPath], { encoding: "utf8" })
    .split(/\r?\n/)
    .map((line) => line.replace(/^\.\//, ""))
    .filter((line) => line.length > 0 && line !== ".");
}

/**
 * One entry of a zip as text, through the same `tar.exe` `listZip` uses.
 *
 * `bsdtar` names the members of a zip written from `-C <dir> .` with a leading `./`, so the caller
 * can pass either spelling and get the file it meant.
 */
export function readZipEntry(zipPath: string, entry: string): string {
  const tar = windowsTarPath() ?? "tar";
  const member = entry.startsWith("./") ? entry : `./${entry}`;
  return execFileSync(tar, ["-xOf", zipPath, member], { encoding: "utf8" });
}

function readExtensionVersion(): string {
  const manifest = JSON.parse(readFileSync(resolve(extensionDistDir, "manifest.json"), "utf8")) as { version?: string };
  if (typeof manifest.version !== "string") {
    throw new Error(`${extensionDistDir}/manifest.json has no version`);
  }
  return manifest.version;
}

function step(title: string): void {
  process.stdout.write(`\n== ${title}\n`);
}

export async function buildPackage(): Promise<string> {
  step("build agent extension");
  // A command string, not args: `npm`/`npx` are `.cmd` shims on Windows, which need a shell, and
  // Node 24 warns when args meet `shell: true`. Nothing here comes from outside this file.
  execSync("npm run build:extension", { cwd: repoRoot, stdio: "inherit" });
  const version = readExtensionVersion();

  step(`stage ${PACKAGE_NAME}-${version}`);
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  cpSync(extensionDistDir, resolve(stageDir, "extension"), { recursive: true });
  for (const asset of ["install.ps1", "uninstall.ps1", "README.md"]) {
    cpSync(resolve(packageAssetsDir, asset), resolve(stageDir, asset));
  }
  writeFileSync(resolve(stageDir, "VERSION"), `${version}\n`, "utf8");

  step("bundle host");
  const hostDir = resolve(stageDir, "host");
  const bundled = await bundleHost(hostDir);
  for (const file of bundled) {
    process.stdout.write(`  ${file} (${statSync(file).size} bytes)\n`);
  }

  step("smoke-test the bundled mcp-server (T203)");
  execSync(`npx vitest run --project unit ${smokeTest}`, {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, HALLPASS_HOST_BUNDLE: resolve(hostDir, "mcp-server.js") },
  });

  step("zip");
  const zipPath = resolve(releaseDir, `${PACKAGE_NAME}-${version}.zip`);
  zipDirectory(stageDir, zipPath);
  rmSync(stageDir, { recursive: true, force: true });
  process.stdout.write(`  ${zipPath} (${statSync(zipPath).size} bytes)\n`);
  return zipPath;
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  await buildPackage();
}
