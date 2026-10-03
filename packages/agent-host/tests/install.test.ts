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
import {
  registerAll,
  removeLegacyRegistrations,
  unregisterAll,
  type RegRunner,
} from "../src/install/registration.js";
import {
  agentIdFilePath,
  bridgeFilePath,
  browserChoicesDirectory,
  browsersDirectory,
  hostDataDirectory,
  hostManifestPath,
  launcherPath,
} from "../src/host-paths.js";

const env = { LOCALAPPDATA: "C:\\Users\\owner\\AppData\\Local" };

/** The four keys the installer must write, in table order - spelled out rather than re-derived. */
const EXPECTED_REGISTRY_KEYS = [
  "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.hallpass.host",
  "HKCU\\Software\\Chromium\\NativeMessagingHosts\\com.hallpass.host",
  "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.hallpass.host",
  "HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\com.hallpass.host",
] as const;

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

  it("runs the installer's own node by absolute path and falls back to PATH node when it is gone", () => {
    const script = createLauncherScript(
      "C:\\repo\\packages\\agent-host\\dist\\native-host.js",
      "C:\\Program Files (x86)\\nodejs\\node.exe",
    );

    expect(script.split("\r\n")).toEqual([
      "@echo off",
      'if not exist "C:\\Program Files (x86)\\nodejs\\node.exe" goto pathnode',
      '"C:\\Program Files (x86)\\nodejs\\node.exe" "C:\\repo\\packages\\agent-host\\dist\\native-host.js" %*',
      "exit /b %errorlevel%",
      ":pathnode",
      'node "C:\\repo\\packages\\agent-host\\dist\\native-host.js" %*',
      "",
    ]);
  });

  it.each(["C:\\data\\100%\\node.exe", "C:\\data\\wow!\\node.exe", 'C:\\data\\"q"\\node.exe'])(
    "writes only the PATH form when the node path holds a character cmd would interpret (%s)",
    (nodePath) => {
      expect(createLauncherScript("C:\\data\\native-host.js", nodePath).split("\r\n")).toEqual([
        "@echo off",
        'node "C:\\data\\native-host.js" %*',
        "",
      ]);
    },
  );
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
  it("registers under the four native-messaging roots in table order", () => {
    expect(NATIVE_MESSAGING_ROOTS).toEqual([
      { browser: "Google Chrome", root: "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts" },
      { browser: "Chromium", root: "HKCU\\Software\\Chromium\\NativeMessagingHosts" },
      { browser: "Microsoft Edge", root: "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts" },
      { browser: "Brave", root: "HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts" },
    ]);
    // The keys are derived from the table, not written out by index, so adding a browser is one row.
    expect(NATIVE_MESSAGING_REGISTRY_KEYS).toEqual(
      NATIVE_MESSAGING_ROOTS.map((row) => `${row.root}\\${AGENT_HOST_NAME}`),
    );
    expect(NATIVE_MESSAGING_REGISTRY_KEYS).toEqual([...EXPECTED_REGISTRY_KEYS]);
  });

  it("writes the manifest path as the key's default value, overwriting an existing registration", () => {
    expect(registryAddArguments(EXPECTED_REGISTRY_KEYS[0], "C:\\d\\com.hallpass.host.json")).toEqual([
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
    expect(registryDeleteArguments(EXPECTED_REGISTRY_KEYS[1])).toEqual([
      "delete",
      "HKCU\\Software\\Chromium\\NativeMessagingHosts\\com.hallpass.host",
      "/f",
    ]);
  });
});

describe("registration outcomes (010/FR-139, FR-140)", () => {
  const manifestPath = "C:\\d\\com.hallpass.host.json";
  const denied = "ERROR: Access is denied.";

  /** A registry runner that never touches the machine: it records its calls and fails on demand. */
  function fakeReg(fails: (args: string[]) => boolean) {
    const calls: string[][] = [];
    return {
      calls,
      reg: async (args: string[]) => {
        calls.push(args);
        return fails(args) ? { ok: false, output: denied } : { ok: true, output: "" };
      },
    };
  }

  it("registerAll writes every root, keeps going after a failure, and returns one outcome per root", async () => {
    const edgeKey = EXPECTED_REGISTRY_KEYS[2];
    const { calls, reg } = fakeReg((args) => args[0] === "add" && args[1] === edgeKey);

    const outcomes = await registerAll(reg, manifestPath);

    expect(calls).toEqual(NATIVE_MESSAGING_REGISTRY_KEYS.map((key) => registryAddArguments(key, manifestPath)));
    expect(outcomes).toEqual([
      { browser: "Google Chrome", key: EXPECTED_REGISTRY_KEYS[0], outcome: "written" },
      { browser: "Chromium", key: EXPECTED_REGISTRY_KEYS[1], outcome: "written" },
      { browser: "Microsoft Edge", key: edgeKey, outcome: "failed", reason: denied },
      { browser: "Brave", key: EXPECTED_REGISTRY_KEYS[3], outcome: "written" },
    ]);
  });

  it("unregisterAll reports removed or absent per root and never fails", async () => {
    // Chrome and Edge hold the entry; Chromium and Brave never had one, which is not a failure.
    const present: string[] = [EXPECTED_REGISTRY_KEYS[0], EXPECTED_REGISTRY_KEYS[2]];
    const { calls, reg } = fakeReg((args) => !present.includes(args[1] ?? ""));

    const outcomes = await unregisterAll(reg);

    expect(calls).toEqual(NATIVE_MESSAGING_REGISTRY_KEYS.map((key) => registryDeleteArguments(key)));
    expect(outcomes).toEqual([
      { browser: "Google Chrome", key: EXPECTED_REGISTRY_KEYS[0], outcome: "removed" },
      { browser: "Chromium", key: EXPECTED_REGISTRY_KEYS[1], outcome: "absent" },
      { browser: "Microsoft Edge", key: EXPECTED_REGISTRY_KEYS[2], outcome: "removed" },
      { browser: "Brave", key: EXPECTED_REGISTRY_KEYS[3], outcome: "absent" },
    ]);
  });

  it("removeLegacyRegistrations visits every root in the table and removes only an earlier version's entry", async () => {
    const legacyManifestPath = "C:\\old\\com.previous.host.json";
    const listed: string[] = [];
    const deleted: string[] = [];
    const reg: RegRunner = async (args) => {
      const [verb, target = ""] = args;
      if (verb === "query" && args.length === 2) {
        listed.push(target);
        // Only the Brave root holds anything: an earlier version's key beside another vendor's host.
        if (target !== NATIVE_MESSAGING_ROOTS[3].root) return { ok: true, output: "" };
        return { ok: true, output: [`${target}\\com.previous.host`, `${target}\\com.other.vendor`].join("\r\n") };
      }
      if (verb === "query") {
        const path = target.endsWith("com.previous.host") ? legacyManifestPath : "C:\\other\\vendor.json";
        return { ok: true, output: `    (Default)    REG_SZ    ${path}\r\n` };
      }
      deleted.push(target);
      return { ok: true, output: "" };
    };
    const readManifest = async (path: string) =>
      path === legacyManifestPath
        ? JSON.stringify({ name: "com.previous.host", allowed_origins: [...AGENT_HOST_ALLOWED_ORIGINS] })
        : JSON.stringify({ name: "com.other.vendor", allowed_origins: ["chrome-extension://aaaa/"] });

    const result = await removeLegacyRegistrations(reg, readManifest);

    expect(listed).toEqual(NATIVE_MESSAGING_ROOTS.map(({ root }) => root));
    expect(deleted).toEqual([`${NATIVE_MESSAGING_ROOTS[3].root}\\com.previous.host`]);
    expect(result).toEqual({ removedKeys: deleted, directories: ["C:\\old"] });
  });
});

describe("earlier version's registration (009/FR-126)", () => {
  const ours = ["chrome-extension://adgpccmmbgnchnphfaoabfflfcepbopd/"];

  it("lists a root's subkeys from reg query output and ignores everything else", () => {
    const root = NATIVE_MESSAGING_ROOTS[0].root;
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

  it("keeps the per-browser records and the remembered choices in their own folders (018 R-266, R-271)", () => {
    expect(browsersDirectory(env)).toBe("C:\\Users\\owner\\AppData\\Local\\hallpass\\browsers");
    expect(browserChoicesDirectory(env)).toBe("C:\\Users\\owner\\AppData\\Local\\hallpass\\choices");
  });
});
