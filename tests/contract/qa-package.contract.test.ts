import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AGENT_EXTENSION_VERSION } from "../../apps/extension/src/build-config.js";
import { NATIVE_MESSAGING_ROOTS, nativeMessagingKey } from "../../packages/agent-host/src/install/windows.js";
import {
  bundleHost,
  HOST_ENTRIES,
  listZip,
  PACKAGE_NAME,
  PACKAGE_ROOT_ENTRIES,
  readZipEntry,
  repoRoot,
  stageHostRuntime,
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

  it("writes exactly the five host files, with no maps or chunks beside them", async () => {
    expect(bundled.map((file) => file.slice(outDir.length + 1)).sort()).toEqual(
      [...HOST_ENTRIES].map((entry) => entry.output).sort(),
    );
    await expect(readdir(outDir)).resolves.toEqual([
      "broker.js",
      "codex-app-server-shim.js",
      "install.js",
      "mcp-server.js",
      "native-host.js",
    ]);
  });

  it("puts the Codex app-server shim beside broker.js, which finds it by its own location (019 SC-135)", async () => {
    const broker = await readFile(resolve(outDir, "broker.js"), "utf8");
    expect(broker).toContain("./codex-app-server-shim.js");
    const shim = await readFile(resolve(outDir, "codex-app-server-shim.js"), "utf8");
    expect(shim).toContain("turn/start");
    expect(shim).toContain("readOnly");
  });

  it("imports nothing but Node built-ins in any of the files, except koffi in broker.js (US1.2, 019 R-327)", async () => {
    for (const file of bundled) {
      const source = await readFile(file, "utf8");
      const specifiers = importSpecifiers(source);
      const allowed = file.endsWith("broker.js") ? ["koffi"] : [];
      const foreign = specifiers.filter((specifier) => !isNodeBuiltin(specifier) && !allowed.includes(specifier));
      expect(specifiers.length, `${file} has no imports at all`).toBeGreaterThan(0);
      expect(foreign, `${file} imports ${foreign.join(", ")}`).toEqual([]);
      expect(source, `${file} carries a CommonJS require shim`).not.toMatch(/\b(createRequire|__require)\b/);
    }
  });

  it("keeps koffi as the one external, used by broker.js alone (019 R-327)", async () => {
    expect(importSpecifiers(await readFile(resolve(outDir, "broker.js"), "utf8"))).toContain("koffi");
    for (const name of ["mcp-server.js", "native-host.js", "install.js", "codex-app-server-shim.js"]) {
      expect(importSpecifiers(await readFile(resolve(outDir, name), "utf8")), name).not.toContain("koffi");
    }
  });

  it("finds its sibling mcp-server.js by its own location, so the broker starts Hallpass's server from host/", async () => {
    const broker = await readFile(resolve(outDir, "broker.js"), "utf8");
    expect(broker).toContain("./mcp-server.js");
    expect(broker).toContain("import.meta.url");
  });

  it("stages koffi's win32-x64 file set and the pinned adapter manifests, and koffi loads from there", () => {
    const staged = stageHostRuntime(outDir).sort();
    expect(staged).toEqual(
      [
        "agents/claude-code/package-lock.json",
        "agents/claude-code/package.json",
        "agents/codex/package-lock.json",
        "agents/codex/package.json",
        // 021 R-345: the DeepSeek agent is fetched from its own pinned manifest and lock.
        "agents/deepseek/package-lock.json",
        "agents/deepseek/package.json",
        "node_modules/@koromix/koffi-win32-x64/index.js",
        "node_modules/@koromix/koffi-win32-x64/package.json",
        "node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node",
        "node_modules/koffi/LICENSE.txt",
        "node_modules/koffi/index.js",
        "node_modules/koffi/package.json",
        "node_modules/koffi/src/koffi/index.js",
        "node_modules/koffi/src/koffi/src/static.js",
      ].sort(),
    );
    // The staged folder alone must be enough: a bare `import "koffi"` from host/ finds it, loads the
    // prebuilt binary and answers a call, the way broker.js does for the job object.
    const answer = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", 'import koffi from "koffi"; process.stdout.write(koffi.version + ":" + koffi.sizeof("int"));'],
      { cwd: outDir, encoding: "utf8" },
    );
    expect(answer).toMatch(/^3\.\d+\.\d+:4$/u);
  });

  it("keeps the installer's own-location resolution, so host/install.js finds its sibling relay", async () => {
    const installer = await readFile(resolve(outDir, "install.js"), "utf8");
    expect(installer).toContain("./native-host.js");
    expect(installer).toContain("import.meta.url");
  });
});

describe("QA package zip (only when a full run has produced one)", () => {
  // This build's zip, named as `npm run package` names it: `release/` may still hold older ones (T668).
  const zipPath = resolve(repoRoot, "release", `${PACKAGE_NAME}-${AGENT_EXTENSION_VERSION}.zip`);

  it.skipIf(!existsSync(zipPath))("contains exactly the US1.1 root entries and only the host files of 019 R-327", () => {
    const entries = listZip(zipPath);
    const roots = new Set(entries.map((entry) => (entry.includes("/") ? `${entry.split("/")[0]}/` : entry)));
    expect([...roots].sort()).toEqual([...PACKAGE_ROOT_ENTRIES].sort());
    const hostFiles = entries.filter((entry) => entry.startsWith("host/") && !entry.endsWith("/"));
    const isRuntime = (entry: string): boolean => entry.startsWith("host/node_modules/") || entry.startsWith("host/agents/");
    expect(hostFiles.filter((entry) => !isRuntime(entry)).sort()).toEqual([
      "host/broker.js",
      "host/codex-app-server-shim.js",
      "host/install.js",
      "host/mcp-server.js",
      "host/native-host.js",
    ]);
    expect(hostFiles.filter((entry) => entry.startsWith("host/agents/")).sort()).toEqual([
      "host/agents/claude-code/package-lock.json",
      "host/agents/claude-code/package.json",
      "host/agents/codex/package-lock.json",
      "host/agents/codex/package.json",
      "host/agents/deepseek/package-lock.json",
      "host/agents/deepseek/package.json",
    ]);
    // node_modules is koffi and its win32-x64 prebuilt, nothing else (coverage F5).
    const modules = hostFiles.filter((entry) => entry.startsWith("host/node_modules/"));
    expect(modules).toContain("host/node_modules/koffi/index.js");
    expect(modules).toContain("host/node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node");
    expect(modules.filter((entry) => !/^host\/node_modules\/(koffi|@koromix\/koffi-win32-x64)\//u.test(entry))).toEqual([]);
    expect(entries.some((entry) => entry.includes("node_modules") && !entry.startsWith("host/node_modules/"))).toBe(false);
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
    expect(AGENT_EXTENSION_VERSION).toBe("0.16.0");
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
    // 019 R-327: the broker, its koffi dependency and the pinned adapter manifests are required files.
    for (const required of ["broker.js", "codex-app-server-shim.js", "node_modules", "koffi", "agents", "package-lock.json"]) {
      expect(script, `install.ps1 does not check ${required}`).toContain(required);
    }
    // 021 R-345: every shipped agent manifest is a required file, DeepSeek's included.
    for (const agent of ["claude-code", "codex", "deepseek"]) {
      for (const file of ["package.json", "package-lock.json"]) {
        expect(script, `install.ps1 does not check agents\\${agent}\\${file}`).toContain(`agents\\${agent}\\${file}`);
      }
    }
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

  /**
   * 019 R-327 / D-019-8: the uninstaller clears what the panel conversation wrote, but a scratch
   * folder holds the owner's own files - it is kept, and the owner is told where it is.
   */
  it("uninstall.ps1 removes the broker's files, keeps scratch\\ and says so", async () => {
    const script = await readFile(resolve(assetsDir, "uninstall.ps1"), "utf8");
    for (const name of ["conversations.json", "folders.json", "agents", "brokers", "broker.log", "conversation-consent"]) {
      expect(script, `uninstall.ps1 does not remove ${name}`).toContain(name);
    }
    expect(script).toContain("scratch");
    expect(script).toMatch(/scratch[^\n]*(保留|沒有刪)/u);
    // The scratch folder is never itself a removal target.
    expect(script).not.toMatch(/Remove-Item[^\n]*scratch/u);
  });

  /**
   * Restoring a backed-up installation points every browser the installer registers back at it
   * (0.11.1 review follow-up). The list was written when only Chrome and Chromium were registered;
   * since 010 the installer also writes Edge and Brave, and a restore that skipped them left those
   * two browsers with no host at all after an uninstall.
   */
  it("uninstall.ps1 restores the registration of every browser the installer registers", async () => {
    const script = await readFile(resolve(assetsDir, "uninstall.ps1"), "utf8");
    for (const { root } of NATIVE_MESSAGING_ROOTS) {
      expect(script, `uninstall.ps1 does not restore ${root}`).toContain(`"${nativeMessagingKey(root)}"`);
    }
  });
});
