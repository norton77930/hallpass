import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PACKAGE_ROOT_ENTRIES } from "../../scripts/package.js";

/**
 * 028 FR-436 (issue #1): the release's install.sh / uninstall.sh, run for real under `dash` (a strict
 * POSIX shell; macOS's /bin/sh where there is none) against a package laid out as the zip is, with a stand-in `host/install.js` that records
 * how it was called. What the installer itself does is unit-tested in packages/agent-host.
 */

const ASSETS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "package");
const posixOnly = describe.runIf(process.platform !== "win32");
/** A strict POSIX shell where there is one (dash on Linux); macOS's own /bin/sh otherwise. */
const SHELL = existsSync("/bin/dash") || existsSync("/usr/bin/dash") ? "dash" : "/bin/sh";

let root: string;
let pkg: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hallpass-install-sh-"));
  pkg = join(root, "hallpass 1.0");
  home = join(root, "home");
  mkdirSync(join(pkg, "host"), { recursive: true });
  mkdirSync(join(pkg, "extension"), { recursive: true });
  mkdirSync(home, { recursive: true });
  for (const script of ["install.sh", "uninstall.sh"]) copyFileSync(join(ASSETS, script), join(pkg, script));
  // The stand-in installer: appends its arguments to calls.log beside it.
  writeFileSync(join(pkg, "host", "install.js"), `require("node:fs").appendFileSync(__dirname + "/calls.log", process.argv.slice(2).join(" ") + "\\n");`);
  writeFileSync(join(pkg, "host", "package.json"), '{ "type": "commonjs" }');
  for (const file of ["native-host.js", "mcp-server.js"]) writeFileSync(join(pkg, "host", file), "");
  writeFileSync(join(pkg, "extension", "manifest.json"), "{}");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const calls = () => readFileSync(join(pkg, "host", "calls.log"), "utf8").trim().split("\n");
const run = (script: string, args: string[] = [], path = `${dirname(process.execPath)}:/usr/bin:/bin`) =>
  spawnSync(SHELL, [join(pkg, script), ...args], { encoding: "utf8", env: { HOME: home, PATH: path } });

describe("028 the release carries install.sh and uninstall.sh", () => {
  it("both are package root entries and executable in the repository", () => {
    expect(PACKAGE_ROOT_ENTRIES).toEqual(expect.arrayContaining(["install.sh", "uninstall.sh"]));
    if (process.platform !== "win32") {
      for (const script of ["install.sh", "uninstall.sh"]) expect(statSync(join(ASSETS, script)).mode & 0o111, script).not.toBe(0);
    }
  });
});

posixOnly("028 install.sh and uninstall.sh under a POSIX shell", () => {
  it("install.sh runs the installer and prints the MCP server definition for this package's path", () => {
    const result = run("install.sh");
    expect(result.status, result.stderr).toBe(0);
    expect(calls()).toEqual(["install"]);
    const server = join(pkg, "host", "mcp-server.js");
    expect(result.stdout).toContain(`{ "command": "node", "args": ["${server}"] }`);
    expect(result.stdout).toContain(join(pkg, "extension"));
  });

  it("install.sh refuses a node older than 24, and runs nothing", () => {
    const bin = join(root, "old-node");
    mkdirSync(bin);
    writeFileSync(join(bin, "node"), `#!/bin/sh\nif [ "$1" = "-v" ]; then echo v22.11.0; exit 0; fi\nexec "${process.execPath}" "$@"\n`);
    chmodSync(join(bin, "node"), 0o755);
    const result = run("install.sh", [], `${bin}:/usr/bin:/bin`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("v22.11.0");
    expect(() => calls()).toThrow();
  });

  it("install.sh refuses a package with a file missing", () => {
    rmSync(join(pkg, "host", "native-host.js"));
    const result = run("install.sh");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("native-host.js");
  });

  it("uninstall.sh runs the uninstaller; --purge also removes the data folder", () => {
    const data = join(home, ".local", "share", "hallpass");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "config.json"), "{}");
    expect(run("uninstall.sh").status).toBe(0);
    expect(calls()).toEqual(["uninstall"]);
    expect(statSync(join(data, "config.json")).isFile()).toBe(true);
    expect(run("uninstall.sh", ["--purge"]).status).toBe(0);
    expect(() => statSync(data)).toThrow();
  });

  it("is valid POSIX sh (dash -n where dash exists)", () => {
    for (const script of ["install.sh", "uninstall.sh"]) execFileSync(SHELL, ["-n", join(ASSETS, script)]);
  });
});
