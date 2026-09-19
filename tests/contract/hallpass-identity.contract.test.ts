import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AGENT_EXTENSION_VERSION } from "../../apps/extension/src/build-config.js";
import { messages as enMessages } from "../../apps/extension/src/locales/en-US.js";
import { messages as zhMessages } from "../../apps/extension/src/locales/zh-TW.js";
import { AGENT_HOST_NAME, createNativeHostManifest } from "../../packages/agent-host/src/install/manifest.js";
import { hostDataDirectory, hostManifestPath } from "../../packages/agent-host/src/host-paths.js";
import { SERVER_NAME, SERVER_VERSION } from "../../packages/agent-host/src/tool-offering.js";
import { bundleHost, PACKAGE_NAME, repoRoot } from "../../scripts/package.js";

/**
 * 009/T239 — the product is Hallpass everywhere a user, an agent, the browser or the operating
 * system can see a name (FR-124, R-145), and version 0.3.0 once (FR-136).
 *
 * Source-level names are read from the modules that define them; the shipped shape is read from
 * the bundled host (built here into a temp dir, as the QA-package test does) and from
 * `dist/agent/**` when a build has left one. The scan is the one the snapshot check also runs
 * (R-148): word-bounded, so `epoch` is not a hit, and split so this file does not match itself.
 */

const LEGACY = new RegExp(["\\bp", "oc\\b", "|@p", "oc/|p", "oc-|com\\.p", "oc\\.|PO", "C_"].join(""));

const WORKSPACES = [
  "package.json",
  "apps/extension/package.json",
  "packages/agent-host/package.json",
  "packages/contracts/package.json",
  "packages/domain/package.json",
  "packages/test-kit/package.json",
] as const;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

describe("T239 the product's identity is Hallpass", () => {
  it("names the extension Hallpass in both locales, with the zh-TW subtitle kept", () => {
    expect(enMessages["extName.agent"]).toBe("Hallpass");
    expect(enMessages["agent.appTitle"]).toBe("Hallpass");
    expect(enMessages["extActionTitle.agent"]).toContain("Hallpass");
    expect(enMessages["extCommandDescription.agent"]).toContain("Hallpass");
    expect(zhMessages["extName.agent"]).toBe("Hallpass 瀏覽器代理橋接");
    expect(zhMessages["agent.appTitle"]).toBe("Hallpass 瀏覽器代理橋接");
    expect(zhMessages["extActionTitle.agent"]).toContain("Hallpass");
  });

  it("advertises the MCP server as hallpass at version 0.3.0, the same version the extension carries", () => {
    expect(SERVER_NAME).toBe("hallpass");
    expect(SERVER_VERSION).toBe("0.3.0");
    expect(AGENT_EXTENSION_VERSION).toBe(SERVER_VERSION);
  });

  it("registers the native host as com.hallpass.host under %LOCALAPPDATA%\\hallpass", () => {
    expect(AGENT_HOST_NAME).toBe("com.hallpass.host");
    expect(createNativeHostManifest("C:\\x\\native-host.cmd").name).toBe("com.hallpass.host");
    expect(createNativeHostManifest("C:\\x\\native-host.cmd").description).not.toMatch(LEGACY);
    const env = { LOCALAPPDATA: "C:\\Users\\someone\\AppData\\Local" };
    expect(hostDataDirectory(env)).toBe("C:\\Users\\someone\\AppData\\Local\\hallpass");
    expect(hostManifestPath(env)).toBe("C:\\Users\\someone\\AppData\\Local\\hallpass\\com.hallpass.host.json");
  });

  it("names the package and every workspace after the product", () => {
    expect(PACKAGE_NAME).toBe("hallpass");
    const names = WORKSPACES.map((file) => (JSON.parse(readFileSync(resolve(repoRoot, file), "utf8")) as { name: string }).name);
    expect(names[0]).toBe("hallpass");
    for (const name of names.slice(1)) {
      expect(name, `${name} is scoped to the product`).toMatch(/^@hallpass\//);
    }
    for (const name of names) expect(name).not.toMatch(LEGACY);
  });
});

describe("T239 no legacy identifier reaches a shipped file", () => {
  let outDir = "";
  let bundled: string[] = [];

  beforeAll(async () => {
    outDir = await mkdtemp(join(tmpdir(), "hallpass-identity-"));
    bundled = await bundleHost(outDir);
  }, 120_000);

  afterAll(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it("keeps the bundled host free of the legacy names", async () => {
    expect(bundled.length).toBeGreaterThan(0);
    for (const file of bundled) {
      const source = await readFile(file, "utf8");
      const hit = source.match(LEGACY);
      expect(hit, `${file} carries ${hit?.[0] ?? ""}`).toBeNull();
    }
  });

  const dist = resolve(repoRoot, "apps/extension/dist/agent");
  it.skipIf(!existsSync(dist))("keeps the built extension free of the legacy names (when a build exists)", () => {
    for (const file of walk(dist)) {
      if (!/\.(js|json|html|css)$/.test(file)) continue;
      const source = readFileSync(file, "utf8");
      const hit = source.match(LEGACY);
      expect(hit, `${file} carries ${hit?.[0] ?? ""}`).toBeNull();
    }
  });
});
