import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  conversationOverviewFrameSchema,
  conversationPageFrameSchema,
  conversationResultFrameSchema,
  type ConversationCommand,
  type ConversationLinkCommand,
  type ConversationEntry,
} from "@hallpass/contracts";
import { AGENT_ADAPTERS, type AgentPorts } from "../src/broker/agents.js";
import { createAgentLauncher, createCommandHandler, fileConsentStore, type ConsentStore } from "../src/broker/commands.js";
import { memoryConversationIndex, memoryFolderList } from "../src/broker/conversation-index.js";
import { ConversationPool } from "../src/broker/conversation.js";
import { createFolderActions, type DialogRun } from "../src/broker/folders.js";
import type { InstallProgress, InstallResult } from "../src/broker/install.js";
import { fakeAgentSpec, killLoggedPids, makeTempDir, readFakeLog, removeDir, waitFor } from "./conversation-harness.js";

/**
 * 019/T540 - the broker's command handler: a `conversation-command` frame from the worker becomes a
 * `conversation-result`, and the list changes go out as `conversation-overview`, the log of an
 * opened conversation as `conversation-page`s (contracts/conversation-frames.md). Each command's
 * refusal path is here, with the error code the panel maps to a sentence.
 *
 * The machine is injected (`AgentPorts`), so "Claude Code is not installed" is a fact of the test,
 * not of the computer running it; a start that reaches an agent runs the fake ACP agent.
 */

const SESSION = "broker-test-session";
const CLI = "C:\\Users\\someone\\.local\\bin\\claude.exe";
const LIVE_PID = process.pid;
let counter = 0;

let dir: string;
let data: string;
let logPath: string;
let sent: Record<string, unknown>[];
let logs: string[];
let pools: ConversationPool[];

beforeEach(async () => {
  dir = await makeTempDir("hallpass-commands-");
  data = join(dir, "data");
  logPath = join(dir, "fake-acp.log");
  sent = [];
  logs = [];
  pools = [];
});

afterEach(async () => {
  for (const pool of pools) await pool.shutdown().catch(() => undefined);
  await killLoggedPids(logPath);
  await removeDir(dir);
});

type Machine = { cli?: boolean; version?: string; adapter?: boolean };

/** What `where.exe`, `--version` and the adapter's package.json say on the test's "machine". */
function machinePorts(machine: Machine): AgentPorts {
  const adapterManifest = (agent: "claude-code" | "codex") =>
    JSON.stringify({ name: AGENT_ADAPTERS[agent].package, version: AGENT_ADAPTERS[agent].version, bin: "dist/index.js" });
  return {
    dataDir: data,
    env: {},
    nodePath: process.execPath,
    codexShimEntry: win32.join(data, "codex-app-server-shim.js"),
    fs: {
      exists: async (path) => machine.cli === true && path === CLI,
      readText: async (path) => {
        if (machine.adapter && path.endsWith(win32.join("claude-agent-acp", "package.json"))) return adapterManifest("claude-code");
        throw new Error("ENOENT");
      },
      writeText: async () => {
        throw new Error("no writes on this machine");
      },
    },
    exec: async (file) => {
      if (file === "where.exe") return machine.cli ? { code: 0, stdout: `${CLI}\r\n`, stderr: "" } : { code: 1, stdout: "", stderr: "" };
      return { code: 0, stdout: machine.version ?? "", stderr: "" };
    },
  };
}

type Setup = {
  machine?: Machine;
  /** The test-mode agent override (the fake), instead of the machine's adapter. */
  agentEnv?: Record<string, string> | false;
  cap?: number;
  install?: (agent: string, onProgress?: (progress: InstallProgress) => void) => Promise<InstallResult>;
  entries?: ConversationEntry[];
  folders?: string[];
  consent?: boolean;
  /** What the folder dialog prints (S7, T562); no test opens the real one. */
  dialog?: { code: number; stdout: string };
  /** The index's list notice (T563), as `index-store.ts` keeps it. */
  listNotice?: () => "index-unreadable" | undefined;
  /** This broker's browser (T558: the consent is kept per browser). */
  browserId?: string;
  /** Runs while the agent is being found (after discovery, before its answer reaches the pool). */
  duringLaunch?: () => Promise<void>;
  /** Stands in for the consent store the handler is given (the setup's own grant uses the file). */
  wrapConsent?: (store: ConsentStore) => ConsentStore;
};

const BROWSER = "chrome-a1";

async function setup(options: Setup = {}) {
  const index = memoryConversationIndex(options.entries);
  const folders = memoryFolderList((options.folders ?? []).map((path) => ({ path, addedAt: "2026-10-19T00:00:00.000Z" })));
  const consent = fileConsentStore(data, options.browserId ?? BROWSER);
  if (options.consent !== false) await consent.write(true, "2026-10-19T00:00:00.000Z");
  const launcher = createAgentLauncher({
    ports: machinePorts(options.machine ?? { cli: true, version: "2.1.302", adapter: true }),
    ...(options.agentEnv === false
      ? {}
      : { testAgent: fakeAgentSpec({ FAKE_ACP_LOG: logPath, ...(options.agentEnv ?? {}) }) }),
  });
  let handler: ReturnType<typeof createCommandHandler> | undefined;
  const pool = new ConversationPool({
    dataDir: data,
    browserRunId: "run-commands",
    brokerPid: 4_000_002,
    index,
    folders,
    resolveLaunch:
      options.duringLaunch === undefined
        ? launcher.resolveLaunch
        : async (agent) => {
            const launch = await launcher.resolveLaunch(agent);
            await options.duringLaunch!();
            return launch;
          },
    onEvent: () => undefined,
    onChange: () => handler?.scheduleOverview(),
    ...(options.cap === undefined ? {} : { cap: options.cap }),
  });
  pools.push(pool);
  const installs: string[] = [];
  const launched: { command: string; args: readonly string[] }[] = [];
  const runDialog: DialogRun = async () => ({ ...(options.dialog ?? { code: 0, stdout: "CANCEL" }), stderr: "", timedOut: false });
  handler = createCommandHandler({
    sessionId: SESSION,
    send: (frame) => {
      sent.push(frame as Record<string, unknown>);
      return true;
    },
    pool,
    index,
    folders,
    consent: options.wrapConsent === undefined ? consent : options.wrapConsent(consent),
    folderActions: createFolderActions({
      folders,
      runDialog,
      launch: (command, args) => {
        launched.push({ command, args });
      },
    }),
    availability: launcher.availability,
    install: async (agent, onProgress) => {
      installs.push(agent);
      return options.install ? options.install(agent, onProgress) : { ok: true, directory: "x" };
    },
    log: (code, detail) => logs.push(detail === undefined ? code : `${code} ${detail}`),
    ...(options.listNotice === undefined ? {} : { listNotice: options.listNotice }),
  });

  const run = async (command: ConversationLinkCommand) => {
    const commandId = `c-${++counter}`;
    await handler!.handle({ type: "conversation-command", sessionId: SESSION, commandId, command });
    const result = sent.find((frame) => frame.type === "conversation-result" && frame.commandId === commandId);
    expect(result, `a result for ${command.type}`).toBeDefined();
    expect(conversationResultFrameSchema.safeParse(result).success).toBe(true);
    return result as { ok: boolean; error?: { code: string; detail: string }; value?: { conversationId?: string } };
  };
  return { handler, pool, index, folders, consent, run, installs, launched };
}

const ID = "conv-0000000000000001";
const entry = (overrides: Partial<ConversationEntry> = {}): ConversationEntry => ({
  conversationId: ID,
  agent: "claude-code",
  agentSessionId: "agent-session-1",
  title: "An old conversation",
  folder: { kind: "scratch" },
  mode: "strict",
  createdAt: "2026-10-18T00:00:00.000Z",
  lastUsedAt: "2026-10-18T00:00:00.000Z",
  resumable: true,
  ...overrides,
});
const foreignLease = { browserRunId: "run-elsewhere", pid: LIVE_PID, at: "2026-10-19T00:00:00.000Z" };

const refusal = (code: string) => ({ ok: false, error: { code, detail: expect.any(String) } });

describe("T540 consent", () => {
  it("persists the answer in conversation-consent\\<browserId>.json and answers with an overview", async () => {
    const { run } = await setup({ consent: false });
    expect(await run({ type: "ui.conversation.consent", payload: { granted: true } })).toMatchObject({ ok: true });
    const file = JSON.parse(await readFile(join(data, "conversation-consent", `${BROWSER}.json`), "utf8")) as Record<string, unknown>;
    expect(file).toMatchObject({ granted: true });
    expect(typeof file.at).toBe("string");
    expect(await fileConsentStore(data, BROWSER).read()).toBe("granted");
    const overview = sent.find((frame) => frame.type === "conversation-overview");
    expect(conversationOverviewFrameSchema.safeParse(overview).success).toBe(true);

    expect(await run({ type: "ui.conversation.consent", payload: { granted: false } })).toMatchObject({ ok: true });
    expect(await fileConsentStore(data, BROWSER).read()).toBe("withdrawn");
  });

  it("T558: each browser's broker keeps its own answer - a withdrawal in B leaves A's grant", async () => {
    const a = await setup({ browserId: "chrome-a1" });
    const b = await setup({ browserId: "edge-b2" });
    expect(await b.run({ type: "ui.conversation.consent", payload: { granted: false } })).toMatchObject({ ok: true });
    expect(await fileConsentStore(data, "edge-b2").read()).toBe("withdrawn");
    expect(await fileConsentStore(data, "chrome-a1").read()).toBe("granted");
    await a.handler.sendOverview();
    expect(sent.at(-1)).toMatchObject({ type: "conversation-overview", consent: "granted" });
    await b.handler.sendOverview();
    expect(sent.at(-1)).toMatchObject({ type: "conversation-overview", consent: "withdrawn" });
  });

  it("T558: the old shared conversation-consent.json is not any browser's answer (unknown: asked again) and is left as it is", async () => {
    await mkdir(data, { recursive: true });
    const old = `${JSON.stringify({ granted: true, at: "2026-10-18T00:00:00.000Z" })}\n`;
    await writeFile(join(data, "conversation-consent.json"), old);
    expect(await fileConsentStore(data, BROWSER).read()).toBe("unknown");
    await fileConsentStore(data, BROWSER).write(false, "2026-10-19T00:00:00.000Z");
    expect(await readFile(join(data, "conversation-consent.json"), "utf8")).toBe(old);
  });

  it("T558: a browser id that is not a file name is refused, not written", () => {
    expect(() => fileConsentStore(data, "..\\elsewhere")).toThrow();
    expect(() => fileConsentStore(data, "AUX")).toThrow();
  });

  it("an answer that cannot be written is broker-unavailable", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(data, "a file where the data folder should be");
    const { run } = await setup({ consent: false });
    expect(await run({ type: "ui.conversation.consent", payload: { granted: true } })).toMatchObject(refusal("broker-unavailable"));
  });
});

describe("T540 start", () => {
  const start: ConversationCommand = { type: "ui.conversation.start", payload: { agent: "claude-code", folder: { kind: "scratch" } } };

  it("starts a conversation and lists it", async () => {
    const { run } = await setup();
    const result = await run(start);
    expect(result.ok).toBe(true);
    const id = result.value!.conversationId!;
    await waitFor(
      () =>
        sent.some(
          (frame) =>
            frame.type === "conversation-overview" &&
            (frame.conversations as { conversationId: string }[]).some((view) => view.conversationId === id),
        ),
      "the overview listing it",
    );
  });

  it("refuses without the one-time consent: consent-needed", async () => {
    const { run } = await setup({ consent: false });
    expect(await run(start)).toMatchObject(refusal("consent-needed"));
  });

  it("T572: consent withdrawn while the agent is being found starts nothing: consent-needed", async () => {
    const { run } = await setup({
      duringLaunch: () => fileConsentStore(data, BROWSER).write(false, "2026-10-19T00:00:01.000Z"),
    });
    expect(await run(start)).toMatchObject(refusal("consent-needed"));
    expect((await readFakeLog(logPath)).filter((line) => line.event === "start")).toEqual([]);
  });

  it("refuses an agent that is not installed: agent-missing", async () => {
    const { run } = await setup({ machine: { cli: false }, agentEnv: false });
    expect(await run(start)).toMatchObject(refusal("agent-missing"));
  });

  it("refuses a CLI whose version cannot be read: agent-version", async () => {
    const { run } = await setup({ machine: { cli: true, version: "" }, agentEnv: false });
    expect(await run(start)).toMatchObject(refusal("agent-version"));
  });

  it("refuses when the connector is not downloaded yet: install-needed", async () => {
    const { run } = await setup({ machine: { cli: true, version: "2.1.302", adapter: false }, agentEnv: false });
    expect(await run(start)).toMatchObject(refusal("install-needed"));
  });

  it("maps a refused session/new to agent-version and a missing executable at initialize to agent-missing", async () => {
    const versionProblem = await setup({ agentEnv: { FAKE_ACP_FAIL_AT: "new" } });
    const result = await versionProblem.run(start);
    expect(result).toMatchObject(refusal("agent-version"));
    expect(result.error!.detail).toMatch(/session\/new/u);

    const missing = await setup({
      agentEnv: { FAKE_ACP_FAIL_AT: "initialize", FAKE_ACP_FAIL_MESSAGE: "native binary not found, set CLAUDE_CODE_EXECUTABLE" },
    });
    expect(await missing.run(start)).toMatchObject(refusal("agent-missing"));
  });

  it("refuses a project folder that is not in the owner's list: folder-missing", async () => {
    const { run } = await setup();
    expect(
      await run({ type: "ui.conversation.start", payload: { agent: "codex", folder: { kind: "project", path: dir } } }),
    ).toMatchObject(refusal("folder-missing"));
  });

  it("refuses when every slot is busy: too-many-running", async () => {
    const { run } = await setup({ cap: 0 });
    expect(await run(start)).toMatchObject(refusal("too-many-running"));
  });

  it("refuses once the broker is shutting down: broker-unavailable", async () => {
    const { run, pool } = await setup();
    await pool.shutdown();
    expect(await run(start)).toMatchObject(refusal("broker-unavailable"));
  });
});

describe("T540 commands on one conversation", () => {
  const target = { conversationId: ID };

  it("send: unknown conversation, another browser's, not resumable, scratch folder gone", async () => {
    expect(await (await setup()).run({ type: "ui.conversation.send", payload: { ...target, text: "hi" } })).toMatchObject(
      refusal("not-found"),
    );
    expect(
      await (await setup({ entries: [entry({ lease: foreignLease })] })).run({
        type: "ui.conversation.send",
        payload: { ...target, text: "hi" },
      }),
    ).toMatchObject(refusal("in-use-elsewhere"));
    expect(
      await (await setup({ entries: [entry({ resumable: false })] })).run({
        type: "ui.conversation.send",
        payload: { ...target, text: "hi" },
      }),
    ).toMatchObject(refusal("cannot-resume"));
    expect(
      await (await setup({ entries: [entry()] })).run({ type: "ui.conversation.send", payload: { ...target, text: "hi" } }),
    ).toMatchObject(refusal("folder-missing"));
  });

  it("send and open that would resume a stopped conversation need this browser's consent: consent-needed, no agent started", async () => {
    for (const answer of ["unknown", "withdrawn"] as const) {
      const { run, consent } = await setup({ consent: false, entries: [entry()] });
      if (answer === "withdrawn") await consent.write(false, "2026-10-19T00:00:00.000Z");
      await mkdir(join(data, "scratch", ID), { recursive: true });
      expect(await run({ type: "ui.conversation.send", payload: { ...target, text: "hi" } })).toMatchObject(refusal("consent-needed"));
      expect(await run({ type: "ui.conversation.open", payload: target })).toMatchObject(refusal("consent-needed"));
    }
    expect(await readFile(logPath, "utf8").catch(() => "")).toBe("");
  });

  it("a live conversation still takes messages after the withdrawal (only a new agent run needs consent)", async () => {
    const { run } = await setup();
    const started = await run({ type: "ui.conversation.start", payload: { agent: "claude-code", folder: { kind: "scratch" } } });
    const conversationId = started.value!.conversationId!;
    expect(await run({ type: "ui.conversation.consent", payload: { granted: false } })).toMatchObject({ ok: true });
    expect(await run({ type: "ui.conversation.send", payload: { conversationId, text: "still here" } })).toMatchObject({ ok: true });
    expect(await run({ type: "ui.conversation.open", payload: { conversationId } })).toMatchObject({ ok: true });
  });

  it("stop: unknown conversation", async () => {
    const { run } = await setup();
    expect(await run({ type: "ui.conversation.stop", payload: target })).toMatchObject(refusal("not-found"));
  });

  it("answer: unknown conversation, and one whose agent is not running", async () => {
    const answer: ConversationCommand = { type: "ui.conversation.answer", payload: { ...target, requestId: "perm-1", answer: "allow-once" } };
    expect(await (await setup()).run(answer)).toMatchObject(refusal("not-found"));
    expect(await (await setup({ entries: [entry()] })).run(answer)).toMatchObject(refusal("agent-exited"));
  });

  it("set-mode: unknown conversation, and one whose agent is not running", async () => {
    const setMode: ConversationCommand = { type: "ui.conversation.set-mode", payload: { ...target, mode: "agent-review" } };
    expect(await (await setup()).run(setMode)).toMatchObject(refusal("not-found"));
    expect(await (await setup({ entries: [entry()] })).run(setMode)).toMatchObject(refusal("agent-exited"));
  });

  // D-021-16: DeepSeek's mode is fixed once its conversation started; it is chosen with the start.
  it("set-mode: a started DeepSeek conversation is refused `mode-fixed`; a start's mode reaches the pool", async () => {
    const setMode: ConversationCommand = { type: "ui.conversation.set-mode", payload: { ...target, mode: "agent-review" } };
    expect(await (await setup({ entries: [entry({ agent: "deepseek" })] })).run(setMode)).toMatchObject(refusal("mode-fixed"));
    // FR-361: the start's mode reaches the pool, for every agent.
    const { run, pool } = await setup();
    const started = await run({ type: "ui.conversation.start", payload: { agent: "claude-code", folder: { kind: "scratch" }, mode: "agent-review" } });
    expect(started).toMatchObject({ ok: true });
    expect((await pool.views()).find((view) => view.conversationId === started.value!.conversationId)?.mode).toBe("agent-review");
  });

  it("open: unknown conversation, another browser's, and a live one answered with its pages", async () => {
    expect(await (await setup()).run({ type: "ui.conversation.open", payload: target })).toMatchObject(refusal("not-found"));
    expect(
      await (await setup({ entries: [entry({ lease: foreignLease })] })).run({ type: "ui.conversation.open", payload: target }),
    ).toMatchObject(refusal("in-use-elsewhere"));

    const { run } = await setup();
    const started = await run({ type: "ui.conversation.start", payload: { agent: "claude-code", folder: { kind: "scratch" } } });
    const conversationId = started.value!.conversationId!;
    sent.length = 0;
    expect(await run({ type: "ui.conversation.open", payload: { conversationId } })).toMatchObject({ ok: true });
    const pages = sent.filter((frame) => frame.type === "conversation-page");
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) expect(conversationPageFrameSchema.safeParse(page).success).toBe(true);
    expect(pages.at(-1)!.more).toBe(false);
    const events = pages.flatMap((page) => page.events as { event: { type: string } }[]);
    expect(events.some((entryOf) => entryOf.event.type === "mode")).toBe(true);
    // The result goes before the pages it announces.
    expect(sent.findIndex((frame) => frame.type === "conversation-result")).toBeLessThan(
      sent.findIndex((frame) => frame.type === "conversation-page"),
    );
  });

  it("remove: unknown conversation, another browser's, and an entry removed from the list", async () => {
    expect(await (await setup()).run({ type: "ui.conversation.remove", payload: target })).toMatchObject(refusal("not-found"));
    expect(
      await (await setup({ entries: [entry({ lease: foreignLease })] })).run({ type: "ui.conversation.remove", payload: target }),
    ).toMatchObject(refusal("in-use-elsewhere"));
    const { run, index } = await setup({ entries: [entry()] });
    expect(await run({ type: "ui.conversation.remove", payload: target })).toMatchObject({ ok: true });
    expect(await index.get(ID)).toBeUndefined();
  });
});

describe("T540/T562 folders", () => {
  const addFolder: ConversationCommand = { type: "ui.conversation.add-folder", payload: {} };

  it("add-folder: the dialog's folder joins the list and the overview; cancel changes nothing", async () => {
    const chosen = join(dir, "project");
    await mkdir(chosen);
    const picked = await setup({ dialog: { code: 0, stdout: `PATH:${Buffer.from(chosen, "utf8").toString("base64")}` } });
    expect(await picked.run(addFolder)).toMatchObject({ ok: true });
    expect(await picked.folders.has(chosen)).toBe(true);
    await waitFor(
      () => sent.some((frame) => frame.type === "conversation-overview" && JSON.stringify(frame.folders).includes("project")),
      "an overview with the folder",
    );

    const cancelled = await setup({ dialog: { code: 0, stdout: "CANCEL" } });
    expect(await cancelled.run(addFolder)).toMatchObject({ ok: true });
    expect(await cancelled.folders.list()).toEqual([]);
  });

  it("add-folder: Constrained Language Mode is path-entry; a dialog that fails is a refusal that says why", async () => {
    const constrained = await setup({ dialog: { code: 3, stdout: "MODE:ConstrainedLanguage" } });
    const refused = await constrained.run(addFolder);
    expect(refused).toMatchObject(refusal("path-entry"));
    expect(refused.error?.detail).toMatch(/type or paste/u);

    const failed = await setup({ dialog: { code: 1, stdout: "" } });
    expect(await failed.run(addFolder)).toMatchObject(refusal("broker-unavailable"));
  });

  it("T563 add-folder { path }: a typed folder is checked like a chosen one, and no dialog opens", async () => {
    const typed = join(dir, "typed-project");
    await mkdir(typed);
    // A dialog that would answer something else: the typed path must not open it.
    const { run, folders } = await setup({ dialog: { code: 0, stdout: "CANCEL" } });
    expect(await run({ type: "ui.conversation.add-folder", payload: { path: typed } })).toMatchObject({ ok: true });
    expect(await folders.has(typed)).toBe(true);
    await waitFor(
      () => sent.some((frame) => frame.type === "conversation-overview" && JSON.stringify(frame.folders).includes("typed-project")),
      "an overview with the typed folder",
    );

    expect(await run({ type: "ui.conversation.add-folder", payload: { path: join(dir, "not-there") } })).toMatchObject(
      refusal("folder-missing"),
    );
    expect(await run({ type: "ui.conversation.add-folder", payload: { path: "relative\\folder" } })).toMatchObject(
      refusal("folder-missing"),
    );
    expect((await folders.list()).map((folder) => folder.path)).toEqual([typed]);
  });

  it("remove-folder: a path not in the list is folder-missing; one in it is removed", async () => {
    const path = "D:\\work\\project";
    const { run, folders } = await setup({ folders: [path] });
    expect(await run({ type: "ui.conversation.remove-folder", payload: { path: "D:\\elsewhere" } })).toMatchObject(refusal("folder-missing"));
    expect(await run({ type: "ui.conversation.remove-folder", payload: { path } })).toMatchObject({ ok: true });
    expect(await folders.list()).toEqual([]);
  });

  it("open-folder: unknown conversation, a missing folder, and Explorer on the folder", async () => {
    expect(await (await setup()).run({ type: "ui.conversation.open-folder", payload: { conversationId: ID } })).toMatchObject(
      refusal("not-found"),
    );
    expect(
      await (await setup({ entries: [entry()] })).run({ type: "ui.conversation.open-folder", payload: { conversationId: ID } }),
    ).toMatchObject(refusal("folder-missing"));
    await mkdir(join(data, "scratch", ID), { recursive: true });
    const present = await setup({ entries: [entry()] });
    expect(await present.run({ type: "ui.conversation.open-folder", payload: { conversationId: ID } })).toMatchObject({ ok: true });
    expect(present.launched).toEqual([{ command: "explorer.exe", args: [join(data, "scratch", ID)] }]);
  });
});

describe("T540 install", () => {
  const install: ConversationCommand = { type: "ui.conversation.install", payload: { agent: "claude-code" } };

  it("refuses without consent, without the CLI, and passes an install failure on", async () => {
    expect(await (await setup({ consent: false })).run(install)).toMatchObject(refusal("consent-needed"));
    expect(await (await setup({ machine: { cli: false }, agentEnv: false })).run(install)).toMatchObject(refusal("agent-missing"));
    const failed = await setup({
      machine: { cli: true, version: "2.1.302", adapter: false },
      agentEnv: false,
      install: async () => ({ ok: false, error: { code: "install-failed", detail: "npm ci failed (exit 1): E404" } }),
    });
    expect(await failed.run(install)).toMatchObject({ ok: false, error: { code: "install-failed", detail: "npm ci failed (exit 1): E404" } });
  });

  it("runs one install per agent at a time: a second request joins the one in flight", async () => {
    let finish!: (result: InstallResult) => void;
    const gate = new Promise<InstallResult>((done) => (finish = done));
    const { handler, installs } = await setup({
      machine: { cli: true, version: "2.1.302", adapter: false },
      agentEnv: false,
      install: () => gate,
    });
    const first = handler.handle({ type: "conversation-command", sessionId: SESSION, commandId: "i-1", command: install });
    await waitFor(() => installs.length === 1, "the first install");
    // The second click lands while the download runs and the first finishes at once: it must join
    // the download it found, not wait on its own reads and then start another.
    const second = handler.handle({ type: "conversation-command", sessionId: SESSION, commandId: "i-2", command: install });
    finish({ ok: true, directory: "x" });
    await Promise.all([first, second]);
    expect(installs).toEqual(["claude-code"]);
    for (const commandId of ["i-1", "i-2"]) {
      expect(sent.find((frame) => frame.commandId === commandId)).toMatchObject({ ok: true });
    }
  });

  it("T567: the first-use Download's consent and install, arriving together, install (the consent is saved first)", async () => {
    // The panel sends the consent and then the install at once, and the broker handles each frame as
    // it arrives without waiting for the one before: the consent's write (temp + rename) is still
    // under way when the install reads the record.
    let release!: () => void;
    const saving = new Promise<void>((done) => (release = done));
    const { handler, installs } = await setup({
      consent: false,
      machine: { cli: true, version: "2.1.302", adapter: false },
      agentEnv: false,
      wrapConsent: (store) => ({
        read: () => store.read(),
        write: async (granted, at) => {
          await saving;
          await store.write(granted, at);
        },
      }),
    });
    const grant = handler.handle({
      type: "conversation-command",
      sessionId: SESSION,
      commandId: "g-1",
      command: { type: "ui.conversation.consent", payload: { granted: true } },
    });
    const download = handler.handle({ type: "conversation-command", sessionId: SESSION, commandId: "i-1", command: install });
    setTimeout(release, 20);
    await Promise.all([grant, download]);
    expect(sent.find((frame) => frame.commandId === "g-1")).toMatchObject({ ok: true });
    expect(sent.find((frame) => frame.commandId === "i-1")).toMatchObject({ ok: true });
    expect(installs).toEqual(["claude-code"]);
  });
});

describe("T540 the frame itself", () => {
  it("refuses a command that is not valid under its commandId (T618), with a log line; a frame without one gets no reply", async () => {
    const { handler } = await setup();
    await handler.handle({ type: "conversation-command", sessionId: SESSION, commandId: "bad", command: { type: "ui.conversation.start" } });
    await handler.handle({ type: "conversation-command", sessionId: SESSION, commandId: "bad-2", command: { type: "ui.conversation.set-mode", payload: { conversationId: ID, mode: "bypassPermissions" } } });
    await handler.handle({ type: "conversation-command", sessionId: SESSION, command: { type: "ui.conversation.start" } });
    expect(sent.filter((frame) => frame.type === "conversation-result")).toEqual([
      { type: "conversation-result", sessionId: SESSION, commandId: "bad", ok: false, error: { code: "invalid-command", detail: expect.any(String) } },
      { type: "conversation-result", sessionId: SESSION, commandId: "bad-2", ok: false, error: { code: "invalid-command", detail: expect.any(String) } },
    ]);
    expect(logs.filter((line) => line.startsWith("broker.command-invalid"))).toHaveLength(3);
  });
});

describe("T547 the gaps S4 left for the panel", () => {
  const start: ConversationCommand = { type: "ui.conversation.start", payload: { agent: "claude-code", folder: { kind: "scratch" } } };

  it("G3: a message while the agent's turn is running is busy, not broker-unavailable", async () => {
    const { run } = await setup({ agentEnv: { FAKE_ACP_CHUNK_DELAY_MS: "50" } });
    const conversationId = (await run(start)).value!.conversationId!;
    expect(await run({ type: "ui.conversation.send", payload: { conversationId, text: "chunks:40" } })).toMatchObject({ ok: true });
    expect(await run({ type: "ui.conversation.send", payload: { conversationId, text: "again" } })).toMatchObject(refusal("busy"));
    await run({ type: "ui.conversation.stop", payload: { conversationId } });
  });

  it("G2: each install phase goes out as an overview naming it, and the finished install names none", async () => {
    let finish!: (result: InstallResult) => void;
    const gate = new Promise<InstallResult>((done) => (finish = done));
    const { handler } = await setup({
      machine: { cli: true, version: "2.1.302", adapter: false },
      agentEnv: false,
      install: (_agent, onProgress) => {
        onProgress?.({ phase: "preparing" });
        setTimeout(() => onProgress?.({ phase: "downloading" }), 20);
        return gate;
      },
    });
    const installing = (phase: string) =>
      sent.some(
        (frame) =>
          frame.type === "conversation-overview" &&
          (frame.agents as { agent: string; installing?: string }[]).some(
            (agent) => agent.agent === "claude-code" && agent.installing === phase,
          ),
      );
    const done = handler.handle({
      type: "conversation-command",
      sessionId: SESSION,
      commandId: "i-1",
      command: { type: "ui.conversation.install", payload: { agent: "claude-code" } },
    });
    await waitFor(() => installing("preparing"), "an overview saying preparing");
    await waitFor(() => installing("downloading"), "an overview saying downloading");
    for (const frame of sent.filter((each) => each.type === "conversation-overview")) {
      expect(conversationOverviewFrameSchema.safeParse(frame).success).toBe(true);
    }
    sent.length = 0;
    finish({ ok: true, directory: "x" });
    await done;
    await waitFor(() => sent.some((frame) => frame.type === "conversation-overview"), "the overview after the install");
    const last = sent.filter((frame) => frame.type === "conversation-overview").at(-1)!;
    expect((last.agents as { installing?: string }[]).every((agent) => agent.installing === undefined)).toBe(true);
  });

  it("the overview carries the broker's consent record", async () => {
    const { handler } = await setup({ consent: false });
    await handler.sendOverview();
    expect(sent.at(-1)).toMatchObject({ type: "conversation-overview", consent: "unknown" });
    await fileConsentStore(data, BROWSER).write(true, "2026-10-19T00:00:00.000Z");
    await handler.sendOverview();
    expect(sent.at(-1)).toMatchObject({ type: "conversation-overview", consent: "granted" });
  });

  it("T563: the overview carries the list notice as a code while the index has one, and none otherwise", async () => {
    let notice: "index-unreadable" | undefined = "index-unreadable";
    const { handler } = await setup({ listNotice: () => notice });
    await handler.sendOverview();
    const withNotice = sent.at(-1)!;
    expect(conversationOverviewFrameSchema.safeParse(withNotice).success).toBe(true);
    expect(withNotice).toMatchObject({ type: "conversation-overview", notice: "index-unreadable" });

    notice = undefined;
    await handler.sendOverview();
    expect(sent.at(-1)).not.toHaveProperty("notice");
  });

  it("G4: the worker's page request is answered with the log from that seq; an unknown conversation is not-found", async () => {
    const { run } = await setup();
    const conversationId = (await run(start)).value!.conversationId!;
    sent.length = 0;
    expect(await run({ type: "worker.conversation.page", payload: { conversationId, fromSeq: 1 } })).toMatchObject({ ok: true });
    const pages = sent.filter((frame) => frame.type === "conversation-page");
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) expect(conversationPageFrameSchema.safeParse(page).success).toBe(true);
    expect(pages[0]!.fromSeq).toBe(1);
    const seqs = pages.flatMap((page) => (page.events as { seq: number }[]).map((each) => each.seq));
    expect(seqs.every((seq) => seq >= 1)).toBe(true);
    expect(pages.at(-1)!.more).toBe(false);
    // The result goes before the pages it announces, as `open`'s does.
    expect(sent.findIndex((frame) => frame.type === "conversation-result")).toBeLessThan(
      sent.findIndex((frame) => frame.type === "conversation-page"),
    );

    expect(await run({ type: "worker.conversation.page", payload: { conversationId: ID, fromSeq: 0 } })).toMatchObject(
      refusal("not-found"),
    );
  });
});

/**
 * 021/T645 (R-345, R-351): the launcher starts an agent in the panel mode it is asked for. DeepSeek
 * has no program of the owner's to find; the test agent stands in for every agent's program, while
 * each mode's launch settings (Hermes' managed layer, DeepSeek's environment) still apply.
 */
describe("021 createAgentLauncher: a launch for a panel mode (T645)", () => {
  const DSH = () => win32.join(data, "agents", "deepseek", "0.2.1-rc.2", "node_modules", "@deepseek-ai", "dsh", "package.json");
  const managed = (mode: string) => win32.join(data, "agents", "hermes", "managed", mode);

  function launcherPorts(files: Record<string, string> = {}): AgentPorts & { writes: string[] } {
    const content = { ...files };
    const writes: string[] = [];
    return {
      writes,
      dataDir: data,
      env: {},
      nodePath: process.execPath,
      codexShimEntry: win32.join(data, "codex-app-server-shim.js"),
      fs: {
        exists: async (path) => path in content,
        readText: async (path) => {
          if (!(path in content)) throw new Error("ENOENT");
          return content[path]!;
        },
        writeText: async (path, text) => {
          writes.push(path);
          content[path] = text;
        },
      },
      exec: async () => ({ code: 1, stdout: "", stderr: "" }),
    };
  }

  it("starts DeepSeek, which has no program to find, in the mode it is asked for", async () => {
    const launcher = createAgentLauncher({
      ports: launcherPorts({ [DSH()]: JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.2.1-rc.2", bin: { dsh: "lib/bin.js" } }) }),
    });
    expect(await launcher.resolveLaunch("deepseek")).toMatchObject({
      ok: true,
      spec: { env: { DSH_PERMISSION_MODE: "read-only", DSH_TELEMETRY_MODE: "DISABLED" } },
      versions: { agent: "deepseek", tested: "0.2.1-rc.2", found: "0.2.1-rc.2" },
    });
    expect(await launcher.resolveLaunch("deepseek", "agent-review")).toMatchObject({
      ok: true,
      spec: { env: { DSH_PERMISSION_MODE: "workspace-write", DSH_TELEMETRY_MODE: "DISABLED" } },
    });
  });

  it("says DeepSeek needs its download before its package is there, and Hermes is missing without its program", async () => {
    const launcher = createAgentLauncher({ ports: launcherPorts() });
    expect(await launcher.resolveLaunch("deepseek")).toMatchObject({ ok: false, error: { code: "install-needed" } });
    expect(await launcher.resolveLaunch("hermes")).toMatchObject({ ok: false, error: { code: "agent-missing" } });
  });

  it("keeps the test agent for all four agents, with each mode's launch settings on top", async () => {
    const testAgent = { command: "node", args: ["fake-agent.js"], env: { FAKE_ACP_LOG: "log" } };
    const p = launcherPorts();
    const launcher = createAgentLauncher({ ports: p, testAgent });
    for (const agent of ["claude-code", "codex", "hermes", "deepseek"] as const) {
      expect(await launcher.availability(agent)).toEqual({ agent, availability: "ready", version: "0.0.0-test" });
    }
    expect(await launcher.resolveLaunch("claude-code", "agent-review")).toEqual({
      ok: true,
      spec: testAgent,
      versions: { agent: "claude-code", tested: "2.1.302", found: "0.0.0-test" },
    });
    expect(await launcher.resolveLaunch("codex")).toMatchObject({ ok: true, spec: testAgent });
    expect(await launcher.resolveLaunch("hermes", "agent-review")).toEqual({
      ok: true,
      spec: { ...testAgent, env: { FAKE_ACP_LOG: "log", HERMES_MANAGED_DIR: managed("agent-review") } },
      versions: { agent: "hermes", tested: "0.22.2", found: "0.0.0-test" },
    });
    expect(p.writes).toEqual([win32.join(managed("agent-review"), "config.yaml")]);
    expect(await launcher.resolveLaunch("deepseek")).toMatchObject({
      ok: true,
      spec: { env: { FAKE_ACP_LOG: "log", DSH_PERMISSION_MODE: "read-only", DSH_TELEMETRY_MODE: "DISABLED" } },
    });
  });
});

