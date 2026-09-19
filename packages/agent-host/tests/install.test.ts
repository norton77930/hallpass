import { describe, expect, it } from "vitest";
import {
  AGENT_HOST_ALLOWED_ORIGINS,
  AGENT_HOST_NAME,
  createLauncherScript,
  createNativeHostManifest,
  resolveRelayEntryPath,
} from "../src/install/manifest.js";
import {
  isLegacyRegistration,
  NATIVE_MESSAGING_REGISTRY_KEYS,
  NATIVE_MESSAGING_ROOTS,
  parseRegistrySubkeys,
  registryAddArguments,
  registryDeleteArguments,
  registryListArguments,
} from "../src/install/windows.js";
import { agentIdFilePath, bridgeFilePath, hostDataDirectory, hostManifestPath, launcherPath } from "../src/host-paths.js";

const env = { LOCALAPPDATA: "C:\\Users\\owner\\AppData\\Local" };

describe("native host manifest", () => {
  it("names the host, points Chrome at the launcher, and allows only the extension origin", () => {
    const manifest = createNativeHostManifest("C:\\data\\hallpass\\native-host.cmd");

    expect(manifest).toEqual({
      name: "com.hallpass.host",
      description: expect.any(String),
      path: "C:\\data\\hallpass\\native-host.cmd",
      type: "stdio",
      allowed_origins: ["chrome-extension://adgpccmmbgnchnphfaoabfflfcepbopd/"],
    });
    expect(AGENT_HOST_NAME).toBe("com.hallpass.host");
    expect(AGENT_HOST_ALLOWED_ORIGINS).toEqual(manifest.allowed_origins);
  });

  it("launches the relay through node with the absolute entry path and forwards Chrome's arguments", () => {
    const script = createLauncherScript("C:\\repo\\packages\\agent-host\\dist\\native-host.js");

    expect(script.split(/\r?\n/)).toEqual([
      "@echo off",
      'node "C:\\repo\\packages\\agent-host\\dist\\native-host.js" %*',
      "",
    ]);
  });
});

describe("relay entry resolution", () => {
  const moduleUrl = "file:///C:/pkg/host/install.js";

  it("prefers native-host.js beside the installer, which is the packaged layout (007/T201)", () => {
    const exists = (path: string) => path === "C:\\pkg\\host\\native-host.js";

    expect(resolveRelayEntryPath(moduleUrl, exists)).toBe("C:\\pkg\\host\\native-host.js");
  });

  it("falls back to the parent directory, which is the repo's dist/install layout", () => {
    expect(resolveRelayEntryPath(moduleUrl, () => false)).toBe("C:\\pkg\\native-host.js");
  });
});

describe("windows registration", () => {
  it("registers under both the Chrome and the Chromium native-messaging roots", () => {
    expect(NATIVE_MESSAGING_REGISTRY_KEYS).toEqual([
      "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.hallpass.host",
      "HKCU\\Software\\Chromium\\NativeMessagingHosts\\com.hallpass.host",
    ]);
  });

  it("writes the manifest path as the key's default value, overwriting an existing registration", () => {
    expect(registryAddArguments(NATIVE_MESSAGING_REGISTRY_KEYS[0], "C:\\d\\com.hallpass.host.json")).toEqual([
      "add",
      "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.hallpass.host",
      "/ve",
      "/t",
      "REG_SZ",
      "/d",
      "C:\\d\\com.hallpass.host.json",
      "/f",
    ]);
  });

  it("removes the whole key on uninstall", () => {
    expect(registryDeleteArguments(NATIVE_MESSAGING_REGISTRY_KEYS[1])).toEqual([
      "delete",
      "HKCU\\Software\\Chromium\\NativeMessagingHosts\\com.hallpass.host",
      "/f",
    ]);
  });
});

describe("earlier version's registration (009/FR-126)", () => {
  const ours = ["chrome-extension://adgpccmmbgnchnphfaoabfflfcepbopd/"];

  it("lists a root's subkeys from reg query output and ignores everything else", () => {
    const root = NATIVE_MESSAGING_ROOTS[0];
    expect(registryListArguments(root)).toEqual(["query", root]);
    // reg.exe spells the hive out even when asked with the HKCU alias (seen on the 0.2.0 -> 0.3.0
    // upgrade proof, 2026-09-19); both spellings must be read.
    const longRoot = root.replace("HKCU", "HKEY_CURRENT_USER");
    const output = [
      "",
      `${longRoot}`,
      `${longRoot}\\com.example.other`,
      `${root}\\com.previous.host`,
      "    (Default)    REG_SZ    C:\\x\\y.json",
      "",
    ].join("\r\n");
    expect(parseRegistrySubkeys(root, output)).toEqual(["com.example.other", "com.previous.host"]);
  });

  it("recognises a manifest that allows exactly our extension under a name we no longer register", () => {
    const previous = { name: "com.previous.host", allowed_origins: ours };
    expect(isLegacyRegistration(previous, ours, AGENT_HOST_NAME)).toBe(true);
  });

  it("leaves the current registration, other vendors' hosts and shared hosts alone", () => {
    expect(isLegacyRegistration({ name: AGENT_HOST_NAME, allowed_origins: ours }, ours, AGENT_HOST_NAME)).toBe(false);
    expect(
      isLegacyRegistration({ name: "com.other.vendor", allowed_origins: ["chrome-extension://aaaa/"] }, ours, AGENT_HOST_NAME),
    ).toBe(false);
    expect(
      isLegacyRegistration({ name: "com.shared.host", allowed_origins: [...ours, "chrome-extension://bbbb/"] }, ours, AGENT_HOST_NAME),
    ).toBe(false);
    expect(isLegacyRegistration({ name: "x", allowed_origins: "not-a-list" }, ours, AGENT_HOST_NAME)).toBe(false);
    expect(isLegacyRegistration({}, ours, AGENT_HOST_NAME)).toBe(false);
  });
});

describe("host paths", () => {
  it("keeps every host file in one per-user directory under LOCALAPPDATA", () => {
    expect(hostDataDirectory(env)).toBe("C:\\Users\\owner\\AppData\\Local\\hallpass");
    expect(hostManifestPath(env)).toBe("C:\\Users\\owner\\AppData\\Local\\hallpass\\com.hallpass.host.json");
    expect(launcherPath(env)).toBe("C:\\Users\\owner\\AppData\\Local\\hallpass\\native-host.cmd");
    expect(bridgeFilePath(env)).toBe("C:\\Users\\owner\\AppData\\Local\\hallpass\\bridge.json");
    expect(agentIdFilePath(env)).toBe("C:\\Users\\owner\\AppData\\Local\\hallpass\\agent-id");
  });
});
