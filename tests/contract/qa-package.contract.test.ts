import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AGENT_EXTENSION_VERSION } from "../../apps/extension/src/build-config.js";
import {
  bundleHost,
  HOST_ENTRIES,
  listZip,
  PACKAGE_NAME,
  PACKAGE_ROOT_ENTRIES,
  readZipEntry,
  repoRoot,
} from "../../scripts/package.js";

/**
 * 007/T202 — the QA package is self-contained (SC-051).
 *
 * The bundle step runs into a temp directory, not the zip: producing the zip means building the
 * extension too, which `npm run package` does and a contract test must not. The zip's own
 * contents are asserted only when a full run has left one under `release/`.
 */

/**
 * Every module-level `import ... from "x"`, `import "x"` and `export ... from "x"` specifier.
 *
 * Statement-anchored on purpose: the bundled `ajv` carries `require("ajv/...")` *as text* for its
 * standalone-code generator, and the host's own comments quote module names. Neither is an import
 * Node will resolve. A real CommonJS escape hatch would surface as a `createRequire`/`__require`
 * shim, which is asserted separately.
 */
function importSpecifiers(source: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /^import\s+[^"'\n]*?\bfrom\s*["']([^"']+)["']/gm,
    /^import\s*["']([^"']+)["']/gm,
    /^export\s+[^"'\n]*?\bfrom\s*["']([^"']+)["']/gm,
    /^import\(\s*["']([^"']+)["']\s*\)/gm,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      found.add(match[1] ?? "");
    }
  }
  return [...found];
}

const isNodeBuiltin = (specifier: string): boolean =>
  specifier.startsWith("node:") || builtinModules.includes(specifier);

describe("QA package host bundle", () => {
  let outDir = "";
  let bundled: string[] = [];

  beforeAll(async () => {
    outDir = await mkdtemp(join(tmpdir(), "hallpass-qa-bundle-"));
    bundled = await bundleHost(outDir);
  }, 120_000);

  afterAll(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it("writes exactly the three host files, with no maps or chunks beside them", async () => {
    expect(bundled.map((file) => file.slice(outDir.length + 1)).sort()).toEqual(
      [...HOST_ENTRIES].map((entry) => entry.output).sort(),
    );
    await expect(readdir(outDir)).resolves.toEqual(["install.js", "mcp-server.js", "native-host.js"]);
  });

  it("imports nothing but Node built-ins in any of the three files (US1.2)", async () => {
    for (const file of bundled) {
      const source = await readFile(file, "utf8");
      const specifiers = importSpecifiers(source);
      const foreign = specifiers.filter((specifier) => !isNodeBuiltin(specifier));
      expect(specifiers.length, `${file} has no imports at all`).toBeGreaterThan(0);
      expect(foreign, `${file} imports ${foreign.join(", ")}`).toEqual([]);
      expect(source, `${file} carries a CommonJS require shim`).not.toMatch(/(createRequire|__require)/);
    }
  });

  it("keeps the installer's own-location resolution, so host/install.js finds its sibling relay", async () => {
    const installer = await readFile(resolve(outDir, "install.js"), "utf8");
    expect(installer).toContain("./native-host.js");
    expect(installer).toContain("import.meta.url");
  });
});

describe("QA package zip (only when a full run has produced one)", () => {
  const releaseDir = resolve(repoRoot, "release");
  const zips = existsSync(releaseDir)
    ? readdirSync(releaseDir).filter((name) => name.startsWith(`${PACKAGE_NAME}-`) && name.endsWith(".zip"))
    : [];

  it.skipIf(zips.length === 0)("contains exactly the US1.1 root entries and only the three host files", () => {
    const entries = listZip(resolve(releaseDir, zips[0] ?? ""));
    const roots = new Set(entries.map((entry) => (entry.includes("/") ? `${entry.split("/")[0]}/` : entry)));
    expect([...roots].sort()).toEqual([...PACKAGE_ROOT_ENTRIES].sort());
    expect(entries.filter((entry) => entry.startsWith("host/") && entry !== "host/").sort()).toEqual([
      "host/install.js",
      "host/mcp-server.js",
      "host/native-host.js",
    ]);
    expect(entries.some((entry) => entry.includes("node_modules"))).toBe(false);
    expect(entries.filter((entry) => entry.endsWith(".map") || entry.endsWith(".d.ts"))).toEqual([]);
    expect(entries.some((entry) => entry.startsWith("extension/manifest.json"))).toBe(true);
  });
});

/**
 * 008/T235 — the 0.2.0 package carries the off-screen recorder and one version (FR-122, R-142).
 *
 * The zip under test is named from `AGENT_EXTENSION_VERSION` rather than picked off the directory:
 * `release/` is a working folder that may still hold the QA team's older zips, and the claim here is
 * about *this* build. Version is read back from three places that must agree — the zip's name, its
 * `VERSION` file and the packed manifest — because FR-122 says the version is stamped from one
 * literal and drift between them is exactly what a tester would report as "the wrong build".
 */
describe("QA package 0.2.0 zip (only when a full run has produced one)", () => {
  const zipPath = resolve(repoRoot, "release", `${PACKAGE_NAME}-${AGENT_EXTENSION_VERSION}.zip`);
  const built = existsSync(zipPath);

  it.skipIf(!built)("packs the off-screen document beside the worker", () => {
    const entries = listZip(zipPath);
    expect(entries).toContain("extension/offscreen.html");
    expect(entries).toContain("extension/offscreen.js");
  });

  it.skipIf(!built)("stamps one version into the zip name, VERSION and the packed manifest", () => {
    expect(AGENT_EXTENSION_VERSION).toBe("0.11.1");
    expect(readZipEntry(zipPath, "VERSION").trim()).toBe(AGENT_EXTENSION_VERSION);
    const manifest = JSON.parse(readZipEntry(zipPath, "extension/manifest.json")) as { version?: string };
    expect(manifest.version).toBe(AGENT_EXTENSION_VERSION);
    expect(zipPath.endsWith(`${PACKAGE_NAME}-${manifest.version}.zip`)).toBe(true);
  });
});

describe("QA package PowerShell scripts (T204)", () => {
  const assetsDir = resolve(repoRoot, "scripts/package");

  it("install.ps1 checks node >= 24, runs the bundled installer, and copies the definition to the clipboard", async () => {
    const script = await readFile(resolve(assetsDir, "install.ps1"), "utf8");
    expect(script).toContain("Set-StrictMode");
    expect(script).toContain('$ErrorActionPreference = "Stop"');
    expect(script).toContain("$PSScriptRoot");
    expect(script).toContain("node -v");
    expect(script).toMatch(/-lt 24/);
    expect(script).toContain("host\\install.js");
    expect(script).toContain("Set-Clipboard");
    expect(script).toContain("-Register");
    expect(script).toContain("claude mcp add hallpass --scope user -- node");
    expect(script).toContain("Get-Command claude");
    expect(script).toContain("com.hallpass.host.json");
    expect(script).toContain(".bak");
    expect(script).toContain('"uploadRoots": []');
    // FR-097: the JSON form doubles the backslashes of the resolved path.
    expect(script).toMatch(/Replace\("\\", "\\\\"\)/);
  });

  it("uninstall.ps1 removes the host, restores the backup, and keeps config.json unless -Purge", async () => {
    const script = await readFile(resolve(assetsDir, "uninstall.ps1"), "utf8");
    expect(script).toContain("Set-StrictMode");
    expect(script).toContain('$ErrorActionPreference = "Stop"');
    expect(script).toContain("host\\install.js");
    expect(script).toContain("uninstall");
    expect(script).toContain(".bak");
    expect(script).toContain("-Purge");
    expect(script).toContain("config.json");
    expect(script).toContain("chrome://extensions");
  });
});
