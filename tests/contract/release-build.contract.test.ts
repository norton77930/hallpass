import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_HOST_PERMISSIONS,
  AGENT_PROFILE_PERMISSIONS,
  BUILD_PROFILES,
  TEST_BUILD_EXTENSION_ID,
  createManifest,
  resolveBuildConfig,
} from "../../apps/extension/src/build-config.js";

describe("T081 release build", () => {
  it("names the build profile as an explicit input and builds one of them", () => {
    // The capability profile decides the permission set, so it is a build-time dimension rather
    // than a runtime flag: one artefact can only ever declare one profile's permissions (C-3).
    // 009/T246 leaves one profile; the dimension stays so widening remains a decision recorded in
    // the build config rather than an edit to an existing set.
    expect([...BUILD_PROFILES]).toEqual(["agent"]);
    expect(TEST_BUILD_EXTENSION_ID).toMatch(/^[a-p]{32}$/);
  });

  it("declares the agent profile's permissions and its <all_urls> host permission", () => {
    // 003/R-109: each entry traces to an approved capability: nativeMessaging FR-031,
    // tabs/tabGroups FR-044, alarms FR-033, debugger FR-049, <all_urls> FR-045.
    expect([...AGENT_PROFILE_PERMISSIONS]).toEqual([
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
      // 008/FR-121: the offscreen document that encodes a session recording into a GIF, and
      // nothing else - it speaks only `chrome.runtime` and reaches no tab.
      "offscreen",
    ]);
    // US7 needs no permission of its own: the *host* reads the files, under the owner's allowed
    // roots, and they reach the page as bytes in a native frame (FR-051). `downloads` is here for
    // 005/FR-076 alone - observing the browser's downloads through two listeners.
    expect([...AGENT_HOST_PERMISSIONS]).toEqual(["<all_urls>"]);

    const agent = resolveBuildConfig("agent");
    expect(agent.profile).toBe("agent");
    expect([...agent.permissions]).toEqual([...AGENT_PROFILE_PERMISSIONS]);
    // The build still reaches the local test fixtures.
    expect([...agent.hostPermissions]).toEqual(["<all_urls>", "https://localhost/*"]);
    expect(createManifest(agent).host_permissions).toEqual(["<all_urls>", "https://localhost/*"]);
  });

  /**
   * 006/T193 (FR-089, R-128): the build is "Hallpass". The manifest says `__MSG_extName__`, so the
   * name lives in the artefact's own `_locales` rather than in the manifest writer.
   */
  it("names the build Hallpass in both locales", () => {
    const messages = (locale: string): Record<string, { message: string }> =>
      JSON.parse(
        readFileSync(resolve(`apps/extension/dist/agent/_locales/${locale}/messages.json`), "utf8"),
      );
    const agentManifest = JSON.parse(
      readFileSync(resolve("apps/extension/dist/agent/manifest.json"), "utf8"),
    ) as { name: string };
    expect(agentManifest.name).toBe("__MSG_extName__");
    expect(messages("en_US").extName?.message).toBe("Hallpass");
    expect(messages("zh_TW").extName?.message).toBe("Hallpass 瀏覽器代理橋接");
    expect(messages("en_US").extActionTitle?.message).toContain("Hallpass");
    expect(messages("en_US").extCommandDescription?.message).toContain("Hallpass");
  });

  it("sources the localhost host permission from the build config alone", () => {
    const config = resolveBuildConfig("agent");
    expect([...config.hostPermissions]).toEqual(["<all_urls>", "https://localhost/*"]);
    expect(config.extensionId).toBe(TEST_BUILD_EXTENSION_ID);
  });

  it("keeps no invalid-domain fallback anywhere in the build path", () => {
    // `.invalid` was a stand-in that let a build succeed with nothing configured.
    for (const path of [
      "apps/extension/src/build-config.ts",
      "apps/extension/scripts/write-manifest.ts",
    ]) {
      expect(readFileSync(resolve(path), "utf8"), path).not.toContain(".invalid");
    }
  });
});
