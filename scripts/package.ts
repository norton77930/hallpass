import { execFileSync, execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

/**
 * `npm run package` — the QA installation package (007, FR-094).
 *
 * One command turns a checkout into `release/hallpass-<version>.zip`: the agent build of
 * the extension, the host bundled into four self-contained files (plus koffi's win32-x64 file set and
 * the pinned adapter manifests for the broker, 019 T568), the two PowerShell scripts and
 * the README. The bundler is Vite's own JS API (already a dependency: it builds the extension), in
 * its server-side mode with nothing externalised except Node's built-ins (and koffi, whose native
 * binary cannot be bundled), which is what makes the host runnable from an extracted folder with no
 * install step beside it (US1.2).
 *
 * This file imports nothing from the repository itself: it runs under `--experimental-strip-types`,
 * which cannot resolve a sibling `.ts` through a `.js` specifier, and the contract test imports
 * `bundleHost` from here to prove the bundle's imports without producing the zip.
 */

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The host entries and the flat names they take inside `host/` (T201; the broker is 019 T568).
 * `broker.js` resolves `./mcp-server.js`, `./codex-app-server-shim.js` (019 SC-135: what Codex's
 * `CODEX_PATH` runs, strict turns made read-only) and the pinned adapter manifests from its own location.
 */
export const HOST_ENTRIES = [
  { entry: "packages/agent-host/src/mcp-server.ts", output: "mcp-server.js" },
  { entry: "packages/agent-host/src/native-host.ts", output: "native-host.js" },
  { entry: "packages/agent-host/src/install/cli.ts", output: "install.js" },
  { entry: "packages/agent-host/src/broker.ts", output: "broker.js" },
  { entry: "packages/agent-host/src/codex-app-server-shim.ts", output: "codex-app-server-shim.js" },
] as const;

/**
 * The one module the bundle does not pull in (019 R-313, R-327): koffi loads a native binary, which
 * cannot live inside a bundled file. `stageHostRuntime` puts it beside the bundles as
 * `host/node_modules/koffi`, where the broker's bare `import "koffi"` finds it.
 */
export const HOST_EXTERNAL_MODULES = ["koffi"] as const;

/**
 * Exactly what koffi 3.x needs to load on win32-x64, relative to `node_modules/` (measured: the
 * broker imports it as ESM, `src/koffi/src/static.js` requires the platform package, which is
 * `@koromix/koffi-win32-x64`). The other platforms' prebuilts, the CommonJS entries, the C++
 * sources, the docs and `index.d.ts` stay out of the zip.
 */
export const KOFFI_PACKAGE_FILES = [
  "koffi/LICENSE.txt",
  "koffi/package.json",
  "koffi/index.js",
  "koffi/src/koffi/index.js",
  "koffi/src/koffi/src/static.js",
  "@koromix/koffi-win32-x64/package.json",
  "@koromix/koffi-win32-x64/index.js",
  "@koromix/koffi-win32-x64/win32_x64/koffi.node",
] as const;

/** The pinned manifests the broker installs from on the owner's consent (R-314; 021 R-345 adds DeepSeek). */
export const AGENT_MANIFEST_FILES = ["package.json", "package-lock.json"] as const;
const AGENT_MANIFEST_DIRECTORIES = ["claude-code", "codex", "deepseek"] as const;

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
          external: [/^node:/, ...HOST_EXTERNAL_MODULES],
          output: { format: "es", entryFileNames: output, chunkFileNames: `${output.replace(/\.js$/, "")}-[hash].js` },
        },
      },
      ssr: { noExternal: true, target: "node" },
    });
    written.push(resolve(outDir, output));
  }
  return written;
}

/**
 * Copy the files the bundles cannot carry into `hostDir`: koffi's win32-x64 file set under
 * `node_modules/` and the adapter manifests under `agents/<agent>/`. Returns the staged paths,
 * relative to `hostDir`, with forward slashes. A missing source is an error: a package without
 * them would install and then fail at the first conversation.
 */
export function stageHostRuntime(hostDir: string): string[] {
  const staged: string[] = [];
  const copy = (from: string, to: string, name: string): void => {
    if (!existsSync(from)) {
      throw new Error(`cannot package ${name}: ${from} does not exist (run npm ci)`);
    }
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to);
    staged.push(name);
  };
  for (const file of KOFFI_PACKAGE_FILES) {
    copy(resolve(repoRoot, "node_modules", file), resolve(hostDir, "node_modules", file), `node_modules/${file}`);
  }
  for (const agent of AGENT_MANIFEST_DIRECTORIES) {
    for (const file of AGENT_MANIFEST_FILES) {
      copy(
        resolve(repoRoot, "packages/agent-host/agents", agent, file),
        resolve(hostDir, "agents", agent, file),
        `agents/${agent}/${file}`,
      );
    }
  }
  return staged;
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
  for (const file of stageHostRuntime(hostDir)) {
    process.stdout.write(`  host/${file}\n`);
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
