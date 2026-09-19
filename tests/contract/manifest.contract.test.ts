import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TEST_EXTENSION_ID } from "../../packages/test-kit/src/build-config.js";
import {
  createManifest,
  extensionPageCsp,
  resolveBuildConfig,
  TEST_BUILD_EXTENSION_ID,
  TEST_BUILD_PUBLIC_KEY,
} from "../../apps/extension/src/build-config.js";

const agentManifestPath = resolve("apps/extension/dist/agent/manifest.json");
const buildConfigPath = resolve("apps/extension/src/build-config.ts");

const REQUIRED_PERMISSIONS = [
  "activeTab",
  "scripting",
  "sidePanel",
  "storage",
  "nativeMessaging",
  "tabs",
  "tabGroups",
  "alarms",
  "debugger",
  "downloads",
  "offscreen",
];
/**
 * Not a list of everything Chrome offers - a list of the permissions that would buy a capability
 * nothing in this artefact has been designed around. `identity` is here because the agent path talks
 * to no remote service and signs nobody in; the rest were never approved for any profile.
 */
const FORBIDDEN_PERMISSIONS = [
  "identity",
  "webNavigation",
  "notifications",
  "declarativeNetRequest",
  "unlimitedStorage",
  "cookies",
  "clipboardRead",
  "clipboardWrite",
];

describe("T011 manifest contract", () => {
  it("keeps the artefact to its approved permission set", () => {
    expect(existsSync(buildConfigPath)).toBe(true);
    // There is no checked-in placeholder to fall back to: the only manifest that exists is the one
    // the build produced from the build config.
    expect(existsSync(agentManifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(agentManifestPath, "utf8")) as {
      permissions?: string[];
      host_permissions?: string[];
      optional_host_permissions?: string[];
      incognito?: string;
    };
    expect(manifest.permissions).toEqual(REQUIRED_PERMISSIONS);
    expect(manifest.optional_host_permissions ?? []).toEqual([]);
    expect(manifest.incognito).toBe("not_allowed");
    for (const permission of FORBIDDEN_PERMISSIONS) {
      expect(manifest.permissions ?? []).not.toContain(permission);
    }
  });

  /**
   * 004/T107 — the content script (FR-062, and S3's frame reading after it).
   *
   * It is declared rather than injected because the indicator has to be on the page from the first
   * paint of every frame, including `about:blank` ones a page writes into itself.
   */
  it("declares the content script at document_start in every frame", async () => {
    const buildConfig = await import("../../apps/extension/src/build-config.js");
    const agent = buildConfig.createManifest(buildConfig.resolveBuildConfig("agent"));

    expect(agent.content_scripts).toEqual([
      {
        matches: ["<all_urls>"],
        js: ["agent-content.js"],
        all_frames: true,
        match_about_blank: true,
        run_at: "document_start",
      },
    ]);
  });

  it("emits a manifest that matches the build config that produced it", () => {
    // The artefact the packaged gate loads is the one this compares, so the freshness check lives
    // here - it needs no environment.
    expect(existsSync(agentManifestPath)).toBe(true);
    expect(JSON.parse(readFileSync(agentManifestPath, "utf8"))).toEqual(
      createManifest(resolveBuildConfig("agent"), { publicKey: TEST_BUILD_PUBLIC_KEY }),
    );
  });

  it("takes the agent host permission plus the one test-only https://localhost/* exception", () => {
    expect(existsSync(agentManifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(agentManifestPath, "utf8")) as {
      permissions?: string[];
      host_permissions?: string[];
    };
    expect(manifest.permissions).toEqual(REQUIRED_PERMISSIONS);
    expect(manifest.host_permissions).toEqual(["<all_urls>", "https://localhost/*"]);
    expect(JSON.stringify(manifest)).not.toContain("127.0.0.1");
  });

  it("pins CSP to packaged code and nothing else", () => {
    // Asserted on what the build actually emitted rather than on the shape of the source text:
    // a wildcard or an `unsafe-*` keyword only matters if it reaches a manifest.
    const csp =
      (
        JSON.parse(readFileSync(agentManifestPath, "utf8")) as {
          content_security_policy?: { extension_pages?: string };
        }
      ).content_security_policy?.extension_pages ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'self'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("*");
    /**
     * The directive set itself is closed, and `connect-src` names no origin at all: the two pinned
     * loopback endpoints were the archived remote service's and went with it (009/T246). The
     * directive is still written, because MV3 leaves `connect-src` unrestricted when it is absent -
     * dropping it would widen an extension page's reach rather than narrow it.
     */
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("localhost:18787");
    expect(extensionPageCsp()).toBe("script-src 'self'; object-src 'self'; connect-src 'self'");
  });

  it("builds against the pinned test Extension ID and writes the manifest from one source", () => {
    const buildConfig = readFileSync(buildConfigPath, "utf8");
    expect(buildConfig).toContain(TEST_EXTENSION_ID);
    expect(TEST_BUILD_EXTENSION_ID).toBe(TEST_EXTENSION_ID);
    expect(resolveBuildConfig("agent").extensionId).toBe(TEST_BUILD_EXTENSION_ID);

    // The manifest has one source. The writer is a script that reads it; it does not keep its own
    // copy of the permissions, the CSP or the endpoints (review H8).
    expect(buildConfig).toMatch(/export function createManifest/);
    const writer = readFileSync(resolve("apps/extension/scripts/write-manifest.ts"), "utf8");
    expect(writer).toMatch(/createManifest\(/);
    expect(writer).not.toMatch(/manifest_version/);
    expect(writer).not.toMatch(/script-src/);
    expect(writer).not.toMatch(/"activeTab"/);
  });
});
