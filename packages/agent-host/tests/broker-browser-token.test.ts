import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { conversationBrowserTokenFrameSchema, type ConversationCommand } from "@hallpass/contracts";
import { browserTokenFrame, createBrowserAccess, mintBrowserToken } from "../src/broker/browser-token.js";
import { createCommandHandler, fileConsentStore, type ConsentState, type ConsentStore } from "../src/broker/commands.js";
import { memoryConversationIndex, memoryFolderList } from "../src/broker/conversation-index.js";
import { CONVERSATION_IDLE_MS, ConversationPool } from "../src/broker/conversation.js";
import { createFolderActions } from "../src/broker/folders.js";
import {
  TestClock,
  fakeAgentSpec,
  killLoggedPids,
  makeTempDir,
  readFakeLog,
  recorder,
  removeDir,
  requests,
  turnEnded,
  waitFor,
} from "./conversation-harness.js";

/**
 * 019/T552, broker half (R-321, R-322): each agent run of a conversation gets its own random token.
 * The worker hears it in a `conversation-browser-token` frame before the agent can start the
 * Hallpass mcp-server; that server reaches the agent as the `hallpass` entry of `session/new` /
 * `session/load` `mcpServers`, every field explicit, the token in its environment. A mode reload
 * keeps the run's token; each message re-sends it with the tab the owner was viewing; the token is
 * revoked when the agent ends, and every live one is handed again to a new relay's worker. It is
 * never logged. The agent is the fake ACP agent as a real stdio process.
 */

const SESSION = "broker-token-session";
const BROWSER = "chrome-7f3a";
const LAUNCH = { command: "C:\\node\\node.exe", args: ["C:\\hallpass\\host\\mcp-server.js"] };
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/u;

type Frame = Record<string, unknown> & { conversationId?: string; token?: string | null; startTabId?: number };
/** A token frame, with the requests the fake agent had logged when it went out. */
type Sent = { frame: Frame; methodsBefore: string[] };

let dir: string;
let logPath: string;
let sent: Sent[];
let logs: string[];
let pools: ConversationPool[];

beforeEach(async () => {
  dir = await makeTempDir("hallpass-token-");
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

const methodsNow = (): string[] => {
  try {
    return readFileSync(logPath, "utf8")
      .split(/\r?\n/u)
      .filter((line) => line.length > 0)
      .flatMap((line) => {
        const method = (JSON.parse(line) as { method?: string }).method;
        return method === undefined ? [] : [method];
      });
  } catch {
    return [];
  }
};

function setup(options: { store?: boolean } = {}) {
  const clock = new TestClock();
  const rec = recorder(clock);
  const index = memoryConversationIndex();
  const folders = memoryFolderList();
  const pool = new ConversationPool({
    dataDir: join(dir, "data"),
    browserRunId: "run-token",
    brokerPid: process.pid,
    index,
    folders,
    clock,
    onEvent: rec.onEvent,
    resolveLaunch: async (agent) => ({
      ok: true,
      spec: fakeAgentSpec({
        FAKE_ACP_LOG: logPath,
        ...(options.store === false ? {} : { FAKE_ACP_STORE: join(dir, "fake-acp-store.json") }),
        FAKE_ACP_SCENARIO: agent === "codex" ? "codex" : "claude",
      }),
      versions: { agent, tested: "1.0.0", found: "1.0.0" },
    }),
    browser: createBrowserAccess({
      sessionId: SESSION,
      browserId: BROWSER,
      launch: LAUNCH,
      send: (frame) => {
        sent.push({ frame: frame as Frame, methodsBefore: methodsNow() });
        return true;
      },
    }),
    log: (code, detail) => logs.push(detail === undefined ? code : `${code} ${detail}`),
  });
  pools.push(pool);
  const start = async (agent: "claude-code" | "codex" = "claude-code"): Promise<string> => {
    const started = await pool.start(agent, { kind: "scratch" });
    if (!started.ok) throw new Error(`start failed: ${started.error.code} ${started.error.detail}`);
    return started.value!.conversationId!;
  };
  const turn = async (conversationId: string, text: string, activeTabId?: number): Promise<void> => {
    const from = rec.events.length;
    const result = await pool.send(conversationId, text, activeTabId);
    if (!result.ok) throw new Error(`send failed: ${result.error.code} ${result.error.detail}`);
    await waitFor(() => turnEnded(rec.events.slice(from), conversationId), `the turn "${text}" to end`);
  };
  return { clock, rec, index, folders, pool, start, turn };
}

const tokenFrames = (conversationId?: string) =>
  sent.filter((each) => each.frame.type === "conversation-browser-token" && (conversationId === undefined || each.frame.conversationId === conversationId));
const servers = (line: { params?: Record<string, unknown> } | undefined) => line?.params?.servers as unknown[];
const panelEntry = (token: string, conversationId: string) => ({
  name: "hallpass",
  command: LAUNCH.command,
  args: LAUNCH.args,
  env: [
    { name: "HALLPASS_PANEL_TOKEN", value: token },
    { name: "HALLPASS_PANEL_BROWSER", value: BROWSER },
    { name: "HALLPASS_PANEL_CONVERSATION", value: conversationId },
  ],
});

describe("T552 the token and the frame", () => {
  it("mints URL-safe tokens of 32-128 characters, a new one each time", () => {
    const tokens = new Set(Array.from({ length: 20 }, () => mintBrowserToken()));
    expect(tokens.size).toBe(20);
    for (const token of tokens) expect(token).toMatch(TOKEN);
  });

  it("builds frames the contract accepts: a grant, a grant with a start tab, a revocation", () => {
    const token = mintBrowserToken();
    const conversationId = "conv-0000000000000001";
    for (const grant of [{ conversationId, token }, { conversationId, token, startTabId: 12 }, { conversationId, token: null }]) {
      const frame = browserTokenFrame(SESSION, grant);
      expect(conversationBrowserTokenFrameSchema.parse(frame)).toEqual({ type: "conversation-browser-token", sessionId: SESSION, ...grant });
    }
  });
});

describe("T552 a run's token", () => {
  it("goes to the worker before session/new, and the hallpass entry carries it with every field explicit", async () => {
    const h = setup();
    const id = await h.start();

    const grants = tokenFrames(id);
    expect(grants).toHaveLength(1);
    const { frame, methodsBefore } = grants[0]!;
    expect(conversationBrowserTokenFrameSchema.safeParse(frame).success).toBe(true);
    expect(frame).toEqual({ type: "conversation-browser-token", sessionId: SESSION, conversationId: id, token: expect.stringMatching(TOKEN) });
    expect(methodsBefore).not.toContain("session/new");

    const created = requests(await readFakeLog(logPath), "session/new");
    expect(servers(created[0])).toEqual([panelEntry(frame.token!, id)]);
  });

  it("is kept by a mode reload, revoked at the idle stop, and a resumed run gets a new one; none is logged", async () => {
    const h = setup();
    const id = await h.start("claude-code");
    const first = tokenFrames(id)[0]!.frame.token!;

    // D-019-12: Claude's mode switch loads the session again - the same agent, the same token.
    expect((await h.pool.setMode(id, "agent-review")).ok).toBe(true);
    let log = await readFakeLog(logPath);
    expect(servers(requests(log, "session/load")[0])).toEqual([panelEntry(first, id)]);
    expect(tokenFrames(id).map((each) => each.frame.token)).toEqual([first]);

    // The idle stop ends the agent: its token goes with it.
    h.clock.advance(CONVERSATION_IDLE_MS);
    await waitFor(() => h.pool.state(id) === "stopped", "the idle stop");
    await waitFor(() => tokenFrames(id).some((each) => each.frame.token === null), "the revocation");
    const revocation = tokenFrames(id).find((each) => each.frame.token === null)!.frame;
    expect(conversationBrowserTokenFrameSchema.safeParse(revocation).success).toBe(true);
    expect(revocation).toEqual({ type: "conversation-browser-token", sessionId: SESSION, conversationId: id, token: null });

    // The next message resumes it: a new agent, a new token, announced before session/load.
    await h.turn(id, "again");
    const issued = tokenFrames(id).filter((each) => typeof each.frame.token === "string");
    const second = issued.at(-1)!.frame.token!;
    expect(second).not.toBe(first);
    const resumeGrant = issued.find((each) => each.frame.token === second)!;
    expect(resumeGrant.methodsBefore.filter((method) => method === "session/load")).toHaveLength(1);
    log = await readFakeLog(logPath);
    expect(servers(requests(log, "session/load")[1])).toEqual([panelEntry(second, id)]);

    const everything = logs.join("\n");
    expect(everything).not.toContain(first);
    expect(everything).not.toContain(second);
  });

  it("is sent again with each message, with the owner's tab when the panel named one, before the prompt", async () => {
    const h = setup();
    const id = await h.start();
    const token = tokenFrames(id)[0]!.frame.token!;

    await h.turn(id, "hello", 7);
    await h.turn(id, "and again");
    const [, withTab, withoutTab] = tokenFrames(id);
    expect(withTab!.frame).toEqual({ type: "conversation-browser-token", sessionId: SESSION, conversationId: id, token, startTabId: 7 });
    expect(withTab!.methodsBefore).not.toContain("session/prompt");
    expect(withoutTab!.frame).toEqual({ type: "conversation-browser-token", sessionId: SESSION, conversationId: id, token });
    expect(withoutTab!.methodsBefore.filter((method) => method === "session/prompt")).toHaveLength(1);
  });

  it("is revoked when the agent crashes and when the conversation is removed", async () => {
    const h = setup({ store: false });
    const crashed = await h.start();
    await h.pool.send(crashed, "crash");
    await waitFor(() => h.pool.state(crashed) === "crashed", "the crash");
    await waitFor(() => tokenFrames(crashed).at(-1)?.frame.token === null, "the crash's revocation");

    const removed = await h.start();
    expect((await h.pool.remove(removed)).ok).toBe(true);
    expect(tokenFrames(removed).at(-1)!.frame.token).toBeNull();
  });

  it("T558: a mode reload after the withdrawal keeps a `hallpass` entry the worker never admits, so the owner's own stays out", async () => {
    const h = setup();
    const id = await h.start("claude-code");
    const first = tokenFrames(id)[0]!.frame.token!;
    h.pool.revokeBrowserTokens();
    sent.length = 0;

    expect((await h.pool.setMode(id, "agent-review")).ok).toBe(true);
    const loaded = servers(requests(await readFakeLog(logPath), "session/load")[0]) as ReturnType<typeof panelEntry>[];
    expect(loaded).toHaveLength(1);
    const reloaded = loaded[0];
    // Still the session's `hallpass` (the owner's is not loaded), with a token the worker was never handed.
    const inert = reloaded!.env.find((variable) => variable.name === "HALLPASS_PANEL_TOKEN")!.value;
    expect(reloaded).toEqual(panelEntry(inert, id));
    expect(inert).toMatch(TOKEN);
    expect(inert).not.toBe(first);
    expect(tokenFrames()).toEqual([]);
    // Nor later: no message or new relay hands it to the worker.
    await h.turn(id, "after the switch", 3);
    h.pool.regrantBrowserTokens();
    expect(tokenFrames()).toEqual([]);
    expect(logs.join("\n")).not.toContain(inert);
  });

  it("every live token is handed again on request (a new relay's worker knows none); an ended run's is not", async () => {
    const h = setup({ store: false });
    const a = await h.start();
    const b = await h.start("codex");
    const ended = await h.start();
    await h.pool.remove(ended);
    const tokenA = tokenFrames(a)[0]!.frame.token!;
    const tokenB = tokenFrames(b)[0]!.frame.token!;
    sent.length = 0;

    h.pool.regrantBrowserTokens();
    const regranted = tokenFrames().map((each) => each.frame);
    for (const frame of regranted) expect(conversationBrowserTokenFrameSchema.safeParse(frame).success).toBe(true);
    expect(regranted).toHaveLength(2);
    expect(regranted).toEqual(
      expect.arrayContaining([
        { type: "conversation-browser-token", sessionId: SESSION, conversationId: a, token: tokenA },
        { type: "conversation-browser-token", sessionId: SESSION, conversationId: b, token: tokenB },
      ]),
    );
  });
});

describe("T552 through the command handler", () => {
  async function withHandler(h: ReturnType<typeof setup>, store?: ConsentStore) {
    const consent = store ?? fileConsentStore(join(dir, "data"), BROWSER);
    await consent.write(true, "2026-10-19T00:00:00.000Z");
    const frames: Record<string, unknown>[] = [];
    const handler = createCommandHandler({
      sessionId: SESSION,
      send: (frame) => {
        frames.push(frame as Record<string, unknown>);
        return true;
      },
      pool: h.pool,
      index: h.index,
      folders: h.folders,
      consent,
      folderActions: createFolderActions({ folders: h.folders, runDialog: async () => ({ code: 0, stdout: "CANCEL", stderr: "", timedOut: false }) }),
      availability: async (agent) => ({ agent, availability: "ready" }),
      install: async () => ({ ok: true, directory: "x" }),
    });
    let counter = 0;
    const run = async (command: ConversationCommand) => {
      const commandId = `c-${++counter}`;
      await handler.handle({ type: "conversation-command", sessionId: SESSION, commandId, command });
      return frames.find((frame) => frame.commandId === commandId);
    };
    return { run };
  }

  it("ui.conversation.send hands the panel's activeTabId on as the start tab", async () => {
    const h = setup();
    const { run } = await withHandler(h);
    const id = await h.start();
    expect(await run({ type: "ui.conversation.send", payload: { conversationId: id, text: "look", activeTabId: 42 } })).toMatchObject({ ok: true });
    expect(tokenFrames(id).at(-1)!.frame).toMatchObject({ conversationId: id, startTabId: 42, token: expect.stringMatching(TOKEN) });
  });

  it("T558: withdrawn consent revokes every live run's token; neither a message, a new relay nor a new consent hands it back - only a new agent run gets one", async () => {
    const h = setup();
    const { run } = await withHandler(h);
    const a = await h.start();
    const b = await h.start("codex");
    const first = tokenFrames(a)[0]!.frame.token!;
    sent.length = 0;

    expect(await run({ type: "ui.conversation.consent", payload: { granted: false } })).toMatchObject({ ok: true });
    expect(tokenFrames().map((each) => each.frame)).toEqual(
      expect.arrayContaining([
        { type: "conversation-browser-token", sessionId: SESSION, conversationId: a, token: null },
        { type: "conversation-browser-token", sessionId: SESSION, conversationId: b, token: null },
      ]),
    );
    expect(tokenFrames()).toHaveLength(2);

    // The agents keep running, without browser access: no attach, consent or message re-grants.
    sent.length = 0;
    h.pool.regrantBrowserTokens();
    expect(await run({ type: "ui.conversation.consent", payload: { granted: true } })).toMatchObject({ ok: true });
    h.pool.regrantBrowserTokens();
    await h.turn(a, "still here", 7);
    expect(tokenFrames()).toEqual([]);

    // A new agent process (the idle stop, then the next message resumes it) is a new run: a new token.
    h.clock.advance(CONVERSATION_IDLE_MS);
    await waitFor(() => h.pool.state(a) === "stopped", "the idle stop");
    await h.turn(a, "again");
    const issued = tokenFrames(a).filter((each) => typeof each.frame.token === "string");
    expect(issued.length).toBeGreaterThan(0);
    expect(issued[0]!.frame.token).not.toBe(first);
  });

  /**
   * A consent record whose `nth` read from now is held: it answers what the record said when that
   * read began, as a file read that began before the withdrawal's rename does.
   */
  function heldConsent() {
    let state: ConsentState = "unknown";
    let reads = 0;
    let holdAt = 0;
    const held: Array<() => void> = [];
    const store: ConsentStore = {
      read: () => {
        reads += 1;
        const seen = state;
        if (reads !== holdAt) return Promise.resolve(seen);
        return new Promise((resolve) => held.push(() => resolve(seen)));
      },
      write: async (granted) => {
        state = granted ? "granted" : "withdrawn";
      },
    };
    return {
      store,
      held,
      holdRead: (nth: number) => (holdAt = reads + nth),
      release: () => {
        for (const resolve of held.splice(0)) resolve();
      },
    };
  }

  const issuedSince = (mark: number) =>
    sent.slice(mark).filter((each) => each.frame.type === "conversation-browser-token" && typeof each.frame.token === "string");

  it("T579: a withdrawal while a start's consent read is under way hands out no token and starts no agent", async () => {
    const h = setup();
    const consent = heldConsent();
    const { run } = await withHandler(h, consent.store);

    // The handler's own check (1st read) passes; the pool's check right before the launch (2nd) is held.
    consent.holdRead(2);
    const starting = run({ type: "ui.conversation.start", payload: { agent: "claude-code", folder: { kind: "scratch" } } });
    await waitFor(() => consent.held.length === 1, "the start's consent read");
    const mark = sent.length;
    expect(await run({ type: "ui.conversation.consent", payload: { granted: false } })).toMatchObject({ ok: true });
    consent.release();

    expect(await starting).toMatchObject({ ok: false, error: { code: "consent-needed" } });
    expect(issuedSince(mark)).toEqual([]);
    expect(requests(await readFakeLog(logPath), "initialize")).toEqual([]);
  });

  it("T579: a withdrawal while a resume's consent read is under way hands out no token", async () => {
    const h = setup();
    const consent = heldConsent();
    const { run } = await withHandler(h, consent.store);
    const id = await h.start();
    h.clock.advance(CONVERSATION_IDLE_MS);
    await waitFor(() => h.pool.state(id) === "stopped", "the idle stop");

    // `send` to a stopped conversation resumes it; its consent read (the 1st) is held.
    consent.holdRead(1);
    const sending = run({ type: "ui.conversation.send", payload: { conversationId: id, text: "again" } });
    await waitFor(() => consent.held.length === 1, "the resume's consent read");
    const mark = sent.length;
    expect(await run({ type: "ui.conversation.consent", payload: { granted: false } })).toMatchObject({ ok: true });
    consent.release();

    expect(await sending).toMatchObject({ ok: false, error: { code: "consent-needed" } });
    expect(issuedSince(mark)).toEqual([]);
    expect(h.pool.state(id)).toBe("stopped");
  });
});
