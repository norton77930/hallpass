import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConversationAgent } from "@hallpass/contracts";
import {
  AGENT_ADAPTERS,
  AGENT_DESCRIPTIONS,
  adapterDirectory,
  installPointerPath,
  installedAdapterDirectory,
  isAdapterInstalled,
  type AgentPorts,
} from "../src/broker/agents.js";
import {
  NPM_CI_ARGS,
  cleanStaging,
  installAgent,
  shippedManifestsDirectory,
  type InstallPhase,
  type InstallPorts,
} from "../src/broker/install.js";
import { runCommand, type RunResult } from "../src/broker/run-command.js";

/**
 * 019/T532, T533 - the first-use install (R-314): `npm ci` against the lockfile Hallpass ships, in
 * `agents\<agent>\.install-<pid>-<random>`, which stays where it is and becomes the install when the
 * pointer `<version>.installed.json` names it, only when it worked (021 R-362: no rename of the tree).
 *
 * Most cases inject the command runner and stand in for npm by writing the tree a successful
 * `npm ci` would. Two cases run the real npm against a tarball served from the loopback interface
 * (no registry, no outside network): one that installs, one whose lockfile integrity is tampered.
 */

const SHIPPED = resolve(dirname(fileURLToPath(import.meta.url)), "..", "agents");
const AGENT = "claude-code" as const;
const ADAPTER = AGENT_ADAPTERS[AGENT];

let root: string;
let data: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hallpass-install-"));
  data = join(root, "data");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A minimal gzip-compressed ustar archive, so the real-npm cases need no tar program on the machine. */
function tarGz(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0, "utf8");
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write("0", 156);
    header.write("ustar\0" + "00", 257);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
const list = (path: string) => readdir(path).catch(() => [] as string[]);

type Call = { file: string; args: string[]; cwd: string | undefined; staged: string[]; lock: string; timeoutMs: number | undefined };

/** What a successful `npm ci` leaves in the folder it ran in. */
async function writeAdapterTree(cwd: string, version: string = ADAPTER.version) {
  const dir = join(cwd, "node_modules", ...ADAPTER.package.split("/"));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: ADAPTER.package, version, bin: "dist/index.js" }));
}

function ports(
  behave: (cwd: string, call: Call) => Promise<Partial<RunResult>> | Partial<RunResult>,
  extra: Partial<InstallPorts> = {},
): { ports: InstallPorts; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    ports: {
      dataDir: data,
      manifestsDir: SHIPPED,
      nodePath: "C:\\no-such-node\\node.exe",
      randomSuffix: () => "abc123",
      run: async (file, args, options) => {
        const cwd = options?.cwd ?? "";
        const call: Call = {
          file,
          args: [...args],
          cwd: options?.cwd,
          staged: await list(cwd),
          lock: await readFile(join(cwd, "package-lock.json"), "utf8").catch(() => ""),
          timeoutMs: options?.timeoutMs,
        };
        calls.push(call);
        return { code: 0, stdout: "", stderr: "", timedOut: false, ...(await behave(cwd, call)) };
      },
      ...extra,
    },
  };
}

/** What launch and the availability check read the install through: the real file system under `data`. */
const realAgentPorts = (): AgentPorts => ({
  dataDir: data,
  env: {},
  nodePath: process.execPath,
  codexShimEntry: join(root, "no-shim.js"),
  fs: {
    exists,
    readText: (path) => readFile(path, "utf8"),
    writeText: async () => {
      throw new Error("not written in these tests");
    },
  },
  exec: async () => ({ code: 1, stdout: "", stderr: "" }),
});

/** The 0.15.0 location: `agents\<agent>\<version>`, renamed into place whole. */
const installedDir = () => adapterDirectory(data, AGENT);
/** Where an install of this process with the random suffix `suffix` runs `npm ci`, and stays. */
const treeDir = (agent: ConversationAgent = AGENT, suffix = "abc123", pid = process.pid) =>
  join(data, "agents", agent, `.install-${pid}-${suffix}`);
const pointerName = (agent: "claude-code" | "codex" | "deepseek" = AGENT) => `${AGENT_DESCRIPTIONS[agent].version}.installed.json`;
const readPointer = async (agent: "claude-code" | "codex" | "deepseek" = AGENT) =>
  JSON.parse(await readFile(installPointerPath(data, agent), "utf8")) as { folder: string };

/** What a real-time file scanner holding a file open makes a read fail with. */
const busy = (path: string) => Object.assign(new Error(`EBUSY: resource busy or locked, open '${path}'`), { code: "EBUSY" });
/** The real files, except that a read `locked` says is held fails as it would under the scanner. */
const lockedReads =
  (locked: (path: string) => boolean) =>
  async (path: string): Promise<string> => {
    if (locked(path)) throw busy(path);
    return readFile(path, "utf8");
  };
/** A read retried without waiting, so these cases stay fast. */
const FAST_RETRY = { attempts: 3, delayMs: 0 };
const pinnedManifest = (tree: string) => join(tree, "node_modules", ...ADAPTER.package.split("/"), "package.json");

describe("installAgent with an injected npm (T532, T533, R-314)", () => {
  it("runs npm ci in .install-<pid>-<random> on the shipped manifest and lock, then points the version at it", async () => {
    const { ports: p, calls } = ports(async (cwd) => {
      await writeAdapterTree(cwd);
      return {};
    });
    const phases: InstallPhase[] = [];
    const result = await installAgent(AGENT, p, (progress) => phases.push(progress.phase));

    expect(result).toEqual({ ok: true, directory: treeDir() });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe("npm.cmd");
    expect(calls[0]!.args).toEqual(["ci", "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund"]);
    expect(NPM_CI_ARGS).toEqual(calls[0]!.args);
    expect(calls[0]!.cwd).toBe(treeDir());
    expect(calls[0]!.staged.sort()).toEqual(["package-lock.json", "package.json"]);
    expect(calls[0]!.lock).toBe(await readFile(join(SHIPPED, AGENT, "package-lock.json"), "utf8"));

    expect(await exists(join(treeDir(), "node_modules", "@agentclientprotocol", "claude-agent-acp", "package.json"))).toBe(true);
    expect((await list(join(data, "agents", AGENT))).sort()).toEqual([`.install-${process.pid}-abc123`, pointerName()].sort());
    expect(await readPointer()).toEqual({ folder: `.install-${process.pid}-abc123` });
    expect(phases).toEqual(["preparing", "downloading", "finishing"]);
  });

  it("021 R-362: a tree npm is still writing is not installed for launch; it is once the pointer names it", async () => {
    let midway: boolean | undefined;
    const { ports: p } = ports(async (cwd) => {
      await writeAdapterTree(cwd);
      midway = await isAdapterInstalled(AGENT, realAgentPorts());
      return {};
    });
    await installAgent(AGENT, p);

    expect(midway).toBe(false);
    expect(await isAdapterInstalled(AGENT, realAgentPorts())).toBe(true);
    expect(await installedAdapterDirectory(data, AGENT, (path) => readFile(path, "utf8"))).toBe(treeDir());
  });

  it("021 R-362: the folder npm ci ran in is the install - the tree is never renamed", async () => {
    const { ports: p, calls } = ports(async (cwd) => {
      await writeAdapterTree(cwd);
      await writeFile(join(cwd, "written-by-npm.txt"), "x");
      return {};
    });
    const result = await installAgent(AGENT, p);

    expect(result).toEqual({ ok: true, directory: calls[0]!.cwd });
    expect(await exists(join(calls[0]!.cwd!, "written-by-npm.txt"))).toBe(true);
  });

  it("uses the npm.cmd next to the running node when there is one", async () => {
    const nodeDir = join(root, "nodejs");
    await mkdir(nodeDir);
    await writeFile(join(nodeDir, "npm.cmd"), "");
    const { ports: p, calls } = ports(
      async (cwd) => {
        await writeAdapterTree(cwd);
        return {};
      },
      { nodePath: join(nodeDir, "node.exe") },
    );
    await installAgent(AGENT, p);
    expect(calls[0]!.file).toBe(join(nodeDir, "npm.cmd"));
  });

  it("leaves no folder when npm exits non-zero, and reports npm's stderr tail redacted", async () => {
    const stderr = [
      "npm error code E500",
      "npm error fetch https://bob:hunter2@registry.example/pkg.tgz failed",
      "npm error token=abc123secret",
      "npm error a long tail ".repeat(60),
    ].join("\n");
    const { ports: p } = ports(async (cwd) => {
      await writeAdapterTree(cwd);
      return { code: 1, stderr };
    });
    const result = await installAgent(AGENT, p);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("install-failed");
    expect(result.error.detail).toContain("exit 1");
    expect(result.error.detail).not.toMatch(/hunter2|abc123secret/);
    expect(result.error.detail.length).toBeLessThanOrEqual(600);
    expect(await list(join(data, "agents", AGENT))).toEqual([]);
  });

  it("leaves no folder when the lockfile integrity does not match (npm's EINTEGRITY exit)", async () => {
    const { ports: p } = ports(() => ({
      code: 1,
      stderr: "npm error code EINTEGRITY\nnpm error sha512-AAAA... integrity checksum failed when using sha512",
    }));
    const result = await installAgent(AGENT, p);
    expect(result).toMatchObject({ ok: false, error: { code: "install-failed" } });
    expect(result.ok ? "" : result.error.detail).toContain("EINTEGRITY");
    expect(await list(join(data, "agents", AGENT))).toEqual([]);
  });

  it("leaves no folder when npm cannot be started or runs out of time", async () => {
    const cannotStart = ports(() => {
      throw new Error("spawn npm.cmd ENOENT");
    });
    const first = await installAgent(AGENT, cannotStart.ports);
    expect(first).toMatchObject({ ok: false, error: { code: "install-failed" } });
    expect(first.ok ? "" : first.error.detail).toContain("ENOENT");

    const timedOut = ports(() => ({ code: null, timedOut: true }));
    const second = await installAgent(AGENT, timedOut.ports);
    expect(second).toMatchObject({ ok: false, error: { code: "install-failed" } });
    expect(second.ok ? "" : second.error.detail).toMatch(/time/i);
    expect(await list(join(data, "agents", AGENT))).toEqual([]);
  });

  it("refuses a tree where the pinned adapter did not land, or landed at another version", async () => {
    const empty = ports(() => ({}));
    expect(await installAgent(AGENT, empty.ports)).toMatchObject({ ok: false, error: { code: "install-failed" } });

    const wrong = ports(async (cwd) => {
      await writeAdapterTree(cwd, "9.9.9");
      return {};
    });
    expect(await installAgent(AGENT, wrong.ports)).toMatchObject({ ok: false, error: { code: "install-failed" } });
    expect(await list(join(data, "agents", AGENT))).toEqual([]);
  });

  it("fails cleanly when the shipped lockfile is not where it should be", async () => {
    const { ports: p, calls } = ports(() => ({}), { manifestsDir: join(root, "nowhere") });
    const result = await installAgent(AGENT, p);
    expect(result).toMatchObject({ ok: false, error: { code: "install-failed" } });
    expect(calls).toHaveLength(0);
    expect(await list(join(data, "agents", AGENT))).toEqual([]);
  });

  it("does nothing when the pinned adapter is already installed", async () => {
    const { ports: first } = ports(async (cwd) => {
      await writeAdapterTree(cwd);
      return {};
    });
    await installAgent(AGENT, first);
    const { ports: p, calls } = ports(() => ({}), { randomSuffix: () => "def456" });
    expect(await installAgent(AGENT, p)).toEqual({ ok: true, directory: treeDir() });
    expect(calls).toHaveLength(0);
  });

  it("021 R-362: keeps an install made by 0.15.0 (<version> folder, no pointer) without npm, for launch too", async () => {
    await writeAdapterTree(installedDir());
    const { ports: p, calls } = ports(() => ({}));
    expect(await installAgent(AGENT, p)).toEqual({ ok: true, directory: installedDir() });
    expect(calls).toHaveLength(0);
    expect(await isAdapterInstalled(AGENT, realAgentPorts())).toBe(true);
    expect(await list(join(data, "agents", AGENT))).toEqual([ADAPTER.version]);
  });

  it("replaces a half-written 0.15.0 adapter folder that is not a valid install", async () => {
    await mkdir(join(installedDir(), "node_modules"), { recursive: true });
    await writeFile(join(installedDir(), "stale.txt"), "x");
    const { ports: p } = ports(async (cwd) => {
      await writeAdapterTree(cwd);
      return {};
    });
    expect(await installAgent(AGENT, p)).toEqual({ ok: true, directory: treeDir() });
    expect(await exists(installedDir())).toBe(false);
  });

  it("021 R-362: replaces a pointer whose tree was damaged since, with the new tree", async () => {
    const damaged = treeDir(AGENT, "old000");
    await mkdir(join(damaged, "node_modules"), { recursive: true });
    await writeFile(installPointerPath(data, AGENT), JSON.stringify({ folder: `.install-${process.pid}-old000` }));
    const { ports: p, calls } = ports(async (cwd) => {
      await writeAdapterTree(cwd);
      return {};
    });
    expect(await installAgent(AGENT, p)).toEqual({ ok: true, directory: treeDir() });
    expect(calls).toHaveLength(1);
    expect(await readPointer()).toEqual({ folder: `.install-${process.pid}-abc123` });
    expect(await isAdapterInstalled(AGENT, realAgentPorts())).toBe(true);
  });

  it("T572: another broker's install in progress is left alone, and the first to finish is the one install", async () => {
    // Another browser's broker is downloading into its own tree right now.
    const other = treeDir(AGENT, "aaa111", 4_000_201);
    await mkdir(join(other, "node_modules"), { recursive: true });
    await writeFile(join(other, "package-lock.json"), "{}");

    const { ports: p } = ports(async (cwd) => {
      // ...and finishes while this one's npm runs: its tree is verified and the pointer names it.
      await writeAdapterTree(other);
      await writeFile(installPointerPath(data, AGENT), JSON.stringify({ folder: `.install-4000201-aaa111` }));
      await writeAdapterTree(cwd);
      return {};
    });
    expect(await installAgent(AGENT, p)).toEqual({ ok: true, directory: other });

    expect(await exists(join(other, "package-lock.json"))).toBe(true);
    expect(await exists(treeDir())).toBe(false);
    expect((await list(join(data, "agents", AGENT))).sort()).toEqual([".install-4000201-aaa111", pointerName()].sort());
    expect(await readPointer()).toEqual({ folder: ".install-4000201-aaa111" });
  });

  it("T572: two installs at once each write their own tree and end with one install both answer with", async () => {
    let release!: () => void;
    const bothRunning = new Promise<void>((resolve) => (release = resolve));
    let running = 0;
    const behave = async (cwd: string) => {
      running += 1;
      if (running === 2) release();
      await bothRunning;
      await writeAdapterTree(cwd);
      return {};
    };
    const a = ports(behave, { randomSuffix: () => "aaa111" });
    const b = ports(behave, { randomSuffix: () => "bbb222" });
    const [first, second] = await Promise.all([installAgent(AGENT, a.ports), installAgent(AGENT, b.ports)]);

    expect(a.calls[0]!.cwd).not.toBe(b.calls[0]!.cwd);
    expect(first).toEqual(second);
    const { folder } = await readPointer();
    expect(first).toEqual({ ok: true, directory: join(data, "agents", AGENT, folder) });
    expect((await list(join(data, "agents", AGENT))).sort()).toEqual([folder, pointerName()].sort());
    expect(await isAdapterInstalled(AGENT, realAgentPorts())).toBe(true);
  });

  it("installs the Codex adapter the same way", async () => {
    const codex = AGENT_ADAPTERS.codex;
    const { ports: p, calls } = ports(async (cwd) => {
      const dir = join(cwd, "node_modules", ...codex.package.split("/"));
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: codex.package, version: codex.version }));
      return {};
    });
    expect(await installAgent("codex", p)).toEqual({ ok: true, directory: treeDir("codex") });
    expect(calls[0]!.cwd).toBe(treeDir("codex"));
    expect(await readPointer("codex")).toEqual({ folder: `.install-${process.pid}-abc123` });
  });
});

describe("installAgent when the file system will not let a file be read (021 R-362, L3)", () => {
  const installedTree = () => treeDir(AGENT, "old000");
  const pointAtInstalled = async () => {
    await writeAdapterTree(installedTree());
    await writeFile(installPointerPath(data, AGENT), JSON.stringify({ folder: `.install-${process.pid}-old000` }));
  };
  const npmWrites = async (cwd: string) => {
    await writeAdapterTree(cwd);
    return {};
  };

  it("does not download because the pointer is held open: it fails, saying so, and leaves the install as it is", async () => {
    await pointAtInstalled();
    const pointer = installPointerPath(data, AGENT);
    const { ports: p, calls } = ports(npmWrites, { readText: lockedReads((path) => path === pointer), readRetry: FAST_RETRY });
    const result = await installAgent(AGENT, p);

    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({ ok: false, error: { code: "install-failed" } });
    expect(result.ok ? "" : result.error.detail).toContain("EBUSY");
    expect(result.ok ? "" : result.error.detail).not.toContain(data);
    expect(await readPointer()).toEqual({ folder: `.install-${process.pid}-old000` });
    expect((await list(join(data, "agents", AGENT))).sort()).toEqual([`.install-${process.pid}-old000`, pointerName()].sort());
  });

  it("reads the pointer again when the hold is brief, and then needs no download", async () => {
    await pointAtInstalled();
    const pointer = installPointerPath(data, AGENT);
    let held = 2;
    const { ports: p, calls } = ports(npmWrites, {
      readText: lockedReads((path) => path === pointer && held-- > 0),
      readRetry: FAST_RETRY,
    });
    expect(await installAgent(AGENT, p)).toEqual({ ok: true, directory: installedTree() });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["the tree the pointer names", async () => (await pointAtInstalled(), installedTree())],
    ["a 0.15.0 <version> folder", async () => (await writeAdapterTree(installedDir()), installedDir())],
  ])("does not download because the pinned package.json in %s is held open, nor remove it", async (_, install) => {
    const installed = await install();
    const { ports: p, calls } = ports(npmWrites, {
      readText: lockedReads((path) => path === pinnedManifest(installed)),
      readRetry: FAST_RETRY,
    });
    const result = await installAgent(AGENT, p);

    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({ ok: false, error: { code: "install-failed" } });
    expect(await exists(pinnedManifest(installed))).toBe(true);
  });

  it("never replaces a pointer another install created because it cannot read it (the pointAt EEXIST path)", async () => {
    const other = treeDir(AGENT, "aaa111", 4_000_201);
    const pointer = installPointerPath(data, AGENT);
    let npmDone = false;
    const { ports: p, calls } = ports(
      async (cwd) => {
        // Another broker's install finishes and creates the pointer while this one's npm runs...
        await writeAdapterTree(other);
        await writeFile(pointer, JSON.stringify({ folder: ".install-4000201-aaa111" }));
        await writeAdapterTree(cwd);
        npmDone = true;
        return {};
      },
      // ...and from then on the pointer is held open.
      { readText: lockedReads((path) => npmDone && path === pointer), readRetry: FAST_RETRY },
    );
    const result = await installAgent(AGENT, p);

    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ ok: false, error: { code: "install-failed" } });
    expect(await readPointer()).toEqual({ folder: ".install-4000201-aaa111" });
    expect(await exists(treeDir())).toBe(false);
  });
});

describe("installAgent per agent (021 T646, R-345, R-346)", () => {
  const DSH = AGENT_DESCRIPTIONS.deepseek;
  const writeDshTree = async (cwd: string) => {
    const dir = join(cwd, "node_modules", ...DSH.package.split("/"));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: DSH.package, version: DSH.version, bin: { dsh: "lib/bin.js" } }));
  };

  it("bounds an adapter's npm ci at 10 minutes", async () => {
    const { ports: p, calls } = ports(async (cwd) => {
      await writeAdapterTree(cwd);
      return {};
    });
    await installAgent(AGENT, p);
    expect(calls[0]!.timeoutMs).toBe(10 * 60 * 1000);
  });

  it("fetches DeepSeek from its shipped manifest and lock with its optional platform bindings kept, bounded at 30 minutes", async () => {
    const { ports: p, calls } = ports(async (cwd) => {
      await writeDshTree(cwd);
      return {};
    });
    expect(await installAgent("deepseek", p)).toEqual({ ok: true, directory: treeDir("deepseek") });
    expect(await exists(installPointerPath(data, "deepseek"))).toBe(true);
    expect(installPointerPath(data, "deepseek")).toBe(join(data, "agents", "deepseek", "0.2.1-rc.2.installed.json"));
    expect(calls).toHaveLength(1);
    // R-357: dsh's native bindings are optionalDependencies; `--omit=optional` left it unable to boot.
    expect(calls[0]!.args).toEqual(["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
    expect(calls[0]!.timeoutMs).toBe(30 * 60 * 1000);
    expect(calls[0]!.lock).toBe(await readFile(join(SHIPPED, "deepseek", "package-lock.json"), "utf8"));
  });

  it("downloads nothing for Hermes, which the owner installs with its own installer", async () => {
    const { ports: p, calls } = ports(() => ({}));
    const result = await installAgent("hermes", p);
    expect(result).toMatchObject({ ok: false, error: { code: "install-failed" } });
    expect(calls).toEqual([]);
    expect(await exists(join(data, "agents", "hermes"))).toBe(false);
  });
});

describe("shippedManifestsDirectory (S9: the package's flat host/ and the dev dist/)", () => {
  it("is the agents folder beside the broker's entry when there is one (host/broker.js + host/agents)", async () => {
    const host = join(root, "host");
    await mkdir(join(host, "agents", "codex"), { recursive: true });
    expect(shippedManifestsDirectory(host)).toBe(join(host, "agents"));
  });

  it("else the one beside the entry's folder (packages/agent-host/dist/broker.js + packages/agent-host/agents)", async () => {
    const dist = join(root, "agent-host", "dist");
    await mkdir(dist, { recursive: true });
    await mkdir(join(root, "agent-host", "agents"), { recursive: true });
    expect(shippedManifestsDirectory(dist)).toBe(join(root, "agent-host", "agents"));
  });
});

describe("cleanStaging (T532: at broker start)", () => {
  it("removes leftover .staging-* folders and nothing else", async () => {
    await mkdir(join(data, "agents", AGENT, ".staging-dead", "node_modules"), { recursive: true });
    await mkdir(join(data, "agents", AGENT, ".staging-beef"), { recursive: true });
    await mkdir(join(data, "agents", AGENT, ADAPTER.version, "node_modules"), { recursive: true });
    await mkdir(join(data, "agents", "codex", ".staging-1"), { recursive: true });
    await mkdir(join(data, "agents", "codex", "keep-me"), { recursive: true });
    await mkdir(join(data, "scratch", ".staging-user-folder"), { recursive: true });

    const removed = await cleanStaging(data);

    expect(removed.sort()).toEqual(
      [
        join(data, "agents", AGENT, ".staging-beef"),
        join(data, "agents", AGENT, ".staging-dead"),
        join(data, "agents", "codex", ".staging-1"),
      ].sort(),
    );
    expect(await list(join(data, "agents", AGENT))).toEqual([ADAPTER.version]);
    expect(await list(join(data, "agents", "codex"))).toEqual(["keep-me"]);
    expect(await exists(join(data, "scratch", ".staging-user-folder"))).toBe(true);
  });

  it("T572: leaves a download another live broker is still running, and removes a dead broker's", async () => {
    const otherBroker = 4_000_101;
    const deadBroker = 4_000_102;
    const self = 4_000_103;
    const alive = new Set([otherBroker, self]);
    await mkdir(join(data, "agents", AGENT, `.staging-${otherBroker}-aaa`), { recursive: true });
    await mkdir(join(data, "agents", AGENT, `.staging-${deadBroker}-bbb`), { recursive: true });
    // This broker's own pid on a leftover is an earlier process's that had it: nothing of this one's yet.
    await mkdir(join(data, "agents", "codex", `.staging-${self}-ccc`), { recursive: true });

    const removed = await cleanStaging(data, { isAlive: (pid) => alive.has(pid), selfPid: self });

    expect(removed.sort()).toEqual(
      [join(data, "agents", AGENT, `.staging-${deadBroker}-bbb`), join(data, "agents", "codex", `.staging-${self}-ccc`)].sort(),
    );
    expect(await list(join(data, "agents", AGENT))).toEqual([`.staging-${otherBroker}-aaa`]);
  });

  it("021 R-362: removes a crashed install's tree and pointer temp, never the tree a pointer names nor a live broker's", async () => {
    const liveBroker = 4_000_301;
    const deadBroker = 4_000_302;
    const crashed = treeDir(AGENT, "dead01", deadBroker);
    const installed = treeDir(AGENT, "done01", deadBroker);
    const downloading = treeDir(AGENT, "live01", liveBroker);
    for (const tree of [crashed, installed, downloading]) await mkdir(join(tree, "node_modules"), { recursive: true });
    await writeAdapterTree(installed);
    await writeFile(`${crashed}.pointer`, "{}");
    await writeFile(installPointerPath(data, AGENT), JSON.stringify({ folder: `.install-${deadBroker}-done01` }));

    const removed = await cleanStaging(data, { isAlive: (pid) => pid === liveBroker, selfPid: 4_000_303 });

    expect(removed.sort()).toEqual([crashed, `${crashed}.pointer`].sort());
    expect((await list(join(data, "agents", AGENT))).sort()).toEqual(
      [`.install-${deadBroker}-done01`, `.install-${liveBroker}-live01`, pointerName()].sort(),
    );
    expect(await isAdapterInstalled(AGENT, realAgentPorts())).toBe(true);
  });

  it("021 R-362: after a crash mid-install, the next start cleans it and the install runs again", async () => {
    const crashed = treeDir(AGENT, "dead02", 4_000_402);
    await mkdir(join(crashed, "node_modules", "half"), { recursive: true });
    await writeAdapterTree(crashed); // npm had already put the pinned package.json down
    expect(await isAdapterInstalled(AGENT, realAgentPorts())).toBe(false);

    await cleanStaging(data, { isAlive: () => false, selfPid: 4_000_403 });
    const { ports: p, calls } = ports(async (cwd) => {
      await writeAdapterTree(cwd);
      return {};
    });
    expect(await installAgent(AGENT, p)).toEqual({ ok: true, directory: treeDir() });
    expect(calls).toHaveLength(1);
    expect((await list(join(data, "agents", AGENT))).sort()).toEqual([`.install-${process.pid}-abc123`, pointerName()].sort());
  });

  it("021 R-362 (L1): keeps a tree whose installer named it and exited between the pointer read and the pid check", async () => {
    const installer = 4_000_501;
    const tree = treeDir(AGENT, "race01", installer);
    await writeAdapterTree(tree);

    const removed = await cleanStaging(data, {
      // The installer creates its pointer and exits just before its pid is looked at.
      isAlive: (pid) => {
        if (pid === installer) writeFileSync(installPointerPath(data, AGENT), JSON.stringify({ folder: `.install-${installer}-race01` }));
        return false;
      },
      selfPid: 4_000_502,
    });

    expect(removed).toEqual([]);
    expect(await isAdapterInstalled(AGENT, realAgentPorts())).toBe(true);
  });

  it("021 R-362 (L3): removes nothing of an agent whose pointer it cannot read", async () => {
    const deadBroker = 4_000_601;
    const installed = treeDir(AGENT, "done03", deadBroker);
    const crashed = treeDir(AGENT, "dead03", deadBroker);
    await writeAdapterTree(installed);
    await mkdir(crashed, { recursive: true });
    const pointer = installPointerPath(data, AGENT);
    await writeFile(pointer, JSON.stringify({ folder: `.install-${deadBroker}-done03` }));

    const removed = await cleanStaging(data, {
      isAlive: () => false,
      selfPid: 4_000_602,
      readText: lockedReads((path) => path === pointer),
      readRetry: FAST_RETRY,
    });

    expect(removed).toEqual([]);
    expect(await exists(installed)).toBe(true);
    expect(await exists(crashed)).toBe(true);
  });

  it.each([
    ["an absolute path", (tree: string) => JSON.stringify({ folder: tree })],
    ["a separator", (tree: string) => JSON.stringify({ folder: `.\\${basename(tree)}` })],
    ["a forward slash", (tree: string) => JSON.stringify({ folder: `./${basename(tree)}` })],
    ["'..'", (tree: string) => JSON.stringify({ folder: `..\\${AGENT}\\${basename(tree)}` })],
    ["junk", () => "not json {"],
    ["null", () => "null"],
    ["an array", (tree: string) => JSON.stringify([basename(tree)])],
    ["a bare string", (tree: string) => JSON.stringify(basename(tree))],
    ["a non-string folder", () => JSON.stringify({ folder: 42 })],
  ])("021 R-362: a pointer holding %s names no tree", async (_, content) => {
    const tree = treeDir(AGENT, "bad001", 4_000_701);
    await writeAdapterTree(tree);
    await writeFile(installPointerPath(data, AGENT), content(tree));

    const removed = await cleanStaging(data, { isAlive: () => false, selfPid: 4_000_702 });

    expect(removed).toEqual([tree]);
    expect(await isAdapterInstalled(AGENT, realAgentPorts())).toBe(false);
  });

  it("is quiet when there is no agents folder yet", async () => {
    expect(await cleanStaging(data)).toEqual([]);
  });
});

describe("installAgent with the real npm against a loopback tarball (T532)", () => {
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    server = undefined;
  });

  /** A one-package registry-free project: package.json + package-lock.json pointing at 127.0.0.1. */
  async function project(tamper: boolean): Promise<string> {
    const bytes = tarGz({
      "package/package.json": JSON.stringify({
        name: ADAPTER.package,
        version: ADAPTER.version,
        bin: { "claude-agent-acp": "index.js" },
      }),
      "package/index.js": "console.log('adapter');\n",
    });

    server = createServer((_request, response) => response.end(bytes));
    await new Promise<void>((ready) => server!.listen(0, "127.0.0.1", ready));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/adapter.tgz`;
    const integrity = `sha512-${createHash("sha512").update(tamper ? Buffer.concat([bytes, Buffer.from("x")]) : bytes).digest("base64")}`;

    const manifests = join(root, "manifests");
    await mkdir(join(manifests, AGENT), { recursive: true });
    await writeFile(
      join(manifests, AGENT, "package.json"),
      JSON.stringify({ name: "hallpass-agent-test", private: true, dependencies: { [ADAPTER.package]: url } }),
    );
    await writeFile(
      join(manifests, AGENT, "package-lock.json"),
      JSON.stringify({
        name: "hallpass-agent-test",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": { name: "hallpass-agent-test", dependencies: { [ADAPTER.package]: url } },
          [`node_modules/${ADAPTER.package}`]: {
            version: ADAPTER.version,
            resolved: url,
            integrity,
            bin: { "claude-agent-acp": "index.js" },
          },
        },
      }),
    );
    return manifests;
  }

  const real = (manifestsDir: string): InstallPorts => ({
    dataDir: data,
    manifestsDir,
    nodePath: process.execPath,
    // npm retries an integrity failure with back-off (tens of seconds); the test does not wait for that.
    run: (file, args, options) =>
      runCommand(file, args, { ...options, env: { ...process.env, npm_config_fetch_retries: "0" } }),
  });

  it("installs a package whose tarball matches the lockfile integrity", async () => {
    const phases: InstallPhase[] = [];
    const result = await installAgent(AGENT, real(await project(false)), (progress) => phases.push(progress.phase));
    const directory = join(data, "agents", AGENT, (await readPointer()).folder);
    expect(result).toEqual({ ok: true, directory });
    expect(await exists(join(directory, "node_modules", "@agentclientprotocol", "claude-agent-acp", "index.js"))).toBe(true);
    expect(await list(join(data, "agents", AGENT))).toHaveLength(2);
    expect(phases).toEqual(["preparing", "downloading", "finishing"]);
  }, 90_000);

  it("leaves no folder, staging included, when the lockfile integrity is tampered", async () => {
    const result = await installAgent(AGENT, real(await project(true)));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("install-failed");
    expect(result.error.detail).toMatch(/EINTEGRITY|integrity/i);
    expect(await list(join(data, "agents", AGENT))).toEqual([]);
  }, 90_000);
});
