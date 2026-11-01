import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPosixLauncherScript } from "../src/install/manifest.js";
import { nativeMessagingFolders, registerPosix, unregisterPosix } from "../src/install/posix.js";
import { makeTempDir, removeDir } from "./conversation-harness.js";

/**
 * 028 (issue #1) FR-434, FR-435: on macOS and Linux the host manifest goes into each installed browser's
 * per-user native-messaging folder, and Chrome starts a shell launcher.
 */

let home: string;

beforeEach(async () => {
  home = await makeTempDir("hallpass-posix-");
});

afterEach(async () => {
  await removeDir(home);
});

describe("028 native-messaging folders", () => {
  it("Linux: under XDG_CONFIG_HOME (default ~/.config), for Chrome, Chromium, Edge and Brave", () => {
    expect(nativeMessagingFolders("linux", { HOME: "/home/owner" })).toEqual([
      { browser: "Chrome", profile: "/home/owner/.config/google-chrome", folder: "/home/owner/.config/google-chrome/NativeMessagingHosts" },
      { browser: "Chromium", profile: "/home/owner/.config/chromium", folder: "/home/owner/.config/chromium/NativeMessagingHosts" },
      { browser: "Edge", profile: "/home/owner/.config/microsoft-edge", folder: "/home/owner/.config/microsoft-edge/NativeMessagingHosts" },
      { browser: "Brave", profile: "/home/owner/.config/BraveSoftware/Brave-Browser", folder: "/home/owner/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts" },
    ]);
    expect(nativeMessagingFolders("linux", { HOME: "/home/owner", XDG_CONFIG_HOME: "/cfg" })[0]?.folder).toBe("/cfg/google-chrome/NativeMessagingHosts");
  });

  it("macOS: under ~/Library/Application Support", () => {
    expect(nativeMessagingFolders("darwin", { HOME: "/Users/owner" }).map((entry) => entry.folder)).toEqual([
      "/Users/owner/Library/Application Support/Google/Chrome/NativeMessagingHosts",
      "/Users/owner/Library/Application Support/Chromium/NativeMessagingHosts",
      "/Users/owner/Library/Application Support/Microsoft Edge/NativeMessagingHosts",
      "/Users/owner/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts",
    ]);
  });
});

describe("028 register and unregister", () => {
  it("FR-434: writes the manifest for each browser whose own folder exists, skips the others; unregister removes them", async () => {
    await mkdir(join(home, ".config", "google-chrome"), { recursive: true });
    await mkdir(join(home, ".config", "chromium", "NativeMessagingHosts"), { recursive: true });
    const folders = nativeMessagingFolders("linux", { HOME: home });
    const manifest = '{"name":"com.hallpass.host"}\n';

    const written = await registerPosix(folders, manifest);
    expect(written.map(({ browser, outcome }) => [browser, outcome])).toEqual([
      ["Chrome", "written"],
      ["Chromium", "written"],
      ["Edge", "skipped"],
      ["Brave", "skipped"],
    ]);
    expect(await readFile(join(home, ".config", "google-chrome", "NativeMessagingHosts", "com.hallpass.host.json"), "utf8")).toBe(manifest);
    // A browser not installed gets no folder at all.
    expect(await readdir(join(home, ".config"))).toEqual(expect.not.arrayContaining(["microsoft-edge"]));

    const removed = await unregisterPosix(folders);
    expect(removed.map(({ browser, outcome }) => [browser, outcome])).toEqual([
      ["Chrome", "removed"],
      ["Chromium", "removed"],
      ["Edge", "absent"],
      ["Brave", "absent"],
    ]);
    expect(await readdir(join(home, ".config", "chromium", "NativeMessagingHosts"))).toEqual([]);
  });
});

describe("028 FR-435 the shell launcher", () => {
  const posixOnly = it.runIf(process.platform !== "win32");

  it("quotes paths for the shell and forwards Chrome's arguments; a bare node is the fallback", () => {
    const script = createPosixLauncherScript("/opt/hall'pass/native-host.js", "/usr/local/bin/node");
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain(`NODE='/usr/local/bin/node'`);
    expect(script).toContain(`exec "$NODE" '/opt/hall'\\''pass/native-host.js' "$@"`);
    expect(script).toContain(`exec node '/opt/hall'\\''pass/native-host.js' "$@"`);
    expect(createPosixLauncherScript("/x/native-host.js")).not.toContain("NODE=");
  });

  posixOnly("runs the installing node when it exists, else node from the path, with the arguments", async () => {
    const entry = join(home, "entry with space.js");
    await writeFile(entry, "process.stdout.write(JSON.stringify(process.argv.slice(2)));", "utf8");
    const launcher = join(home, "native-host.sh");
    await writeFile(launcher, createPosixLauncherScript(entry, process.execPath), "utf8");
    await chmod(launcher, 0o755);
    expect(execFileSync(launcher, ["chrome-extension://abc/", "it's"], { encoding: "utf8" })).toBe(JSON.stringify(["chrome-extension://abc/", "it's"]));

    // The installing node is gone: `node` from the path runs it.
    await writeFile(launcher, createPosixLauncherScript(entry, join(home, "no-such-node")), "utf8");
    const path = `${join(process.execPath, "..")}:${process.env.PATH ?? ""}`;
    expect(execFileSync(launcher, ["a"], { encoding: "utf8", env: { ...process.env, PATH: path } })).toBe(JSON.stringify(["a"]));
  });
});

describe("028 FR-437 no conversation broker outside Windows", () => {
  it("the relay starts a broker on Windows only", async () => {
    const { brokerSupported } = await import("../src/broker-launch.js");
    expect(brokerSupported("win32")).toBe(true);
    expect(brokerSupported("linux")).toBe(false);
    expect(brokerSupported("darwin")).toBe(false);
  });
});
