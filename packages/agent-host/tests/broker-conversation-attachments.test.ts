import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { readdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  conversationEventSchema,
  conversationOverviewFrameSchema,
  conversationResultFrameSchema,
  type ConversationEvent,
} from "@hallpass/contracts";
import { ATTACHMENTS_FOLDER, type AttachPiece } from "../src/broker/attachments.js";
import { createCommandHandler, type ConsentStore } from "../src/broker/commands.js";
import { CONVERSATION_IDLE_MS } from "../src/broker/conversation.js";
import { ConversationEventLog } from "../src/broker/event-log.js";
import type { FolderActions } from "../src/broker/folders.js";
import { poolHarness, sleep, turnEnded, waitFor } from "./conversation-harness.js";

/**
 * 022 T616 - attachments through a conversation (R-336, R-343, R-344; FR-333, FR-334): what the
 * agent said it accepts at `initialize`, the prompt's blocks in order (text, pictures, the tab as
 * context, one line per file), `attachment-not-accepted`, the owner's bubble with its attachments,
 * a replayed picture, staged data dropped when the conversation stops, exits or is removed, and a
 * text-only message exactly as before.
 *
 * The agent here is an in-process ACP agent behind a stand-in child process, so a test decides what
 * it advertises and reads the blocks it was sent.
 */

type FakeOptions = {
  scenario?: "claude" | "codex";
  promptCapabilities?: acp.PromptCapabilities;
  /** What `session/load` replays before it answers. */
  replay?: acp.SessionNotification["update"][];
  /** Each prompt's answer waits for this (a turn that is still running). */
  hold?: Promise<void>;
};

const MODES = {
  claude: { current: "default", ids: ["default", "auto"] },
  codex: { current: "read-only", ids: ["read-only", "agent"] },
};

/** A child process as far as the broker uses one: stdio, pid, exit, kill. */
class FakeChild extends EventEmitter {
  static next = 4_200_000;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly pid = FakeChild.next++;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private gone = false;

  constructor() {
    super();
    // An ACP agent leaves when its input closes (the broker's stop).
    this.stdin.on("finish", () => this.exit(0));
  }

  kill(): boolean {
    this.exit(null);
    return true;
  }

  exit(code: number | null): void {
    if (this.gone) return;
    this.gone = true;
    if (code === null) this.signalCode = "SIGTERM";
    else this.exitCode = code;
    this.stdout.end();
    setImmediate(() => this.emit("exit", code));
  }
}

function fakeAgents(options: FakeOptions = {}) {
  const scenario = options.scenario ?? "claude";
  const prompts: acp.ContentBlock[][] = [];
  const children: FakeChild[] = [];
  const spawn = (): ChildProcess => {
    const child = new FakeChild();
    children.push(child);
    let connection!: acp.AgentSideConnection;
    const modes = () => ({
      currentModeId: MODES[scenario].current,
      availableModes: MODES[scenario].ids.map((id) => ({ id, name: id })),
    });
    const agent: acp.Agent = {
      initialize: async () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: true,
          ...(options.promptCapabilities === undefined ? {} : { promptCapabilities: options.promptCapabilities }),
        },
      }),
      authenticate: async () => ({}),
      newSession: async () => ({ sessionId: `fake-${child.pid}`, modes: modes() }),
      loadSession: async (params) => {
        for (const update of options.replay ?? []) await connection.sessionUpdate({ sessionId: params.sessionId, update });
        return { modes: modes() };
      },
      setSessionMode: async (params) => {
        await connection.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "current_mode_update", currentModeId: params.modeId } });
        return {};
      },
      prompt: async (params) => {
        prompts.push(params.prompt);
        await options.hold;
        await connection.sessionUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } },
        });
        return { stopReason: "end_turn" };
      },
      cancel: async () => undefined,
    };
    connection = new acp.AgentSideConnection(
      () => agent,
      acp.ndJsonStream(
        Writable.toWeb(child.stdout) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdin) as ReadableStream<Uint8Array>,
      ),
    );
    return child as unknown as ChildProcess;
  };
  return { spawn, prompts, children };
}

type Harness = Awaited<ReturnType<typeof poolHarness>>;
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup();
});

async function setup(options: FakeOptions = {}, extra: Parameters<typeof poolHarness>[0] = {}) {
  const fake = fakeAgents(options);
  const h = await poolHarness({ spawnAgent: fake.spawn, store: false, ...extra });
  harnesses.push(h);
  const id = await h.start(options.scenario === "codex" ? "codex" : "claude-code");
  return { h, fake, id };
}

/** The broker's command handler over a harness's pool, recording what it sends on the link. */
function handlerFor(h: Harness) {
  const sent: Record<string, unknown>[] = [];
  const consent: ConsentStore = { read: async () => "granted", write: async () => undefined };
  const handler = createCommandHandler({
    sessionId: "broker-1",
    send: (frame) => sent.push(frame as Record<string, unknown>) > 0,
    pool: h.pool,
    index: h.index,
    folders: h.folders,
    consent,
    folderActions: {} as FolderActions,
    availability: async (agent) => ({ agent, availability: "ready" }),
    install: async () => ({ ok: false, error: { code: "install-failed", detail: "no installs in this test" } }),
  });
  return { handler, sent };
}

const BOTH = { image: true, embeddedContext: true };
const b64 = (text: string | Buffer) => Buffer.from(text).toString("base64");

const image = (id: string, name = `${id}.png`): AttachPiece => ({
  attachmentId: id,
  index: 0,
  final: true,
  kind: "image",
  name,
  size: 3,
  mimeType: "image/png",
  thumbnail: "AAAA",
  data: b64("img"),
});
const tab = (id: string, text = "visible words"): AttachPiece => ({
  attachmentId: id,
  index: 0,
  final: true,
  kind: "tab",
  name: "A page",
  size: Buffer.byteLength(text),
  tab: { url: "https://example.test/a", title: "A page", cut: true },
  data: b64(text),
});
const file = (id: string, name: string, content: string, final = true): AttachPiece => ({
  attachmentId: id,
  index: 0,
  final,
  kind: "file",
  name,
  size: Buffer.byteLength(content) + (final ? 0 : 10),
  data: b64(content),
});

const ownerTexts = (h: Harness, id: string) =>
  h.rec.of(id).flatMap((entry) => (entry.event.type === "text" && entry.event.role === "owner" ? [entry.event] : []));

async function sendAndWait(h: Harness, id: string, text: string, attachments?: string[]) {
  const from = h.rec.events.length;
  const sent = await h.pool.send(id, text, undefined, undefined, attachments);
  if (sent.ok) await waitFor(() => turnEnded(h.rec.events.slice(from), id), "the end of the turn");
  return sent;
}

describe("022 T616 what the agent accepts (R-336, R-344)", () => {
  it("is read at initialize and reported on the conversation and, last seen, on the agent", async () => {
    const { h, id } = await setup({ promptCapabilities: { image: true, embeddedContext: false } });
    const view = (await h.pool.views()).find((entry) => entry.conversationId === id);
    expect(view?.accepts).toEqual({ image: true, context: false });
    expect(h.pool.agentAccepts("claude-code")).toEqual({ image: true, context: false });
    expect(h.pool.agentAccepts("codex")).toBeUndefined();
  });

  it("is nothing beyond text when the agent says nothing (the ACP default)", async () => {
    const { h, id } = await setup();
    const view = (await h.pool.views()).find((entry) => entry.conversationId === id);
    expect(view?.accepts).toEqual({ image: false, context: false });
  });

  it("reaches the overview's agent entry", async () => {
    const { h } = await setup({ promptCapabilities: BOTH });
    const { handler, sent } = handlerFor(h);
    await handler.sendOverview();
    const overview = conversationOverviewFrameSchema.parse(sent.at(-1));
    expect(overview.agents.find((entry) => entry.agent === "claude-code")?.accepts).toEqual({ image: true, context: true });
    expect(overview.agents.find((entry) => entry.agent === "codex")?.accepts).toBeUndefined();
  });
});

describe("022 T616 the prompt and the owner's bubble (FR-333, R-343)", () => {
  it("text, then each picture, then the tab as context, then one line per file", async () => {
    const { h, fake, id } = await setup({ promptCapabilities: BOTH });
    for (const piece of [file("f1", "data.csv", "a,b"), image("i1"), tab("t1"), image("i2")]) {
      expect(await h.pool.attach(id, piece)).toEqual({ ok: true });
    }
    expect(await sendAndWait(h, id, "why?", ["f1", "i1", "t1", "i2"])).toEqual({ ok: true });

    // The broker names the file under the folder's real path (realpath, R-339).
    const folder = await realpath(join(h.dir, "data", "scratch", id, ATTACHMENTS_FOLDER));
    const path = join(folder, "data.csv");
    expect(fake.prompts.at(-1)).toEqual([
      { type: "text", text: "why?" },
      { type: "image", data: b64("img"), mimeType: "image/png" },
      { type: "image", data: b64("img"), mimeType: "image/png" },
      { type: "resource", resource: { uri: "https://example.test/a", mimeType: "text/plain", text: "A page\n\nvisible words" } },
      { type: "text", text: `- data.csv: ${path}` },
    ]);
    expect(await readFile(path, "utf8")).toBe("a,b");

    const owner = ownerTexts(h, id).at(-1)!;
    expect(owner).toEqual({
      type: "text",
      role: "owner",
      text: "why?",
      attachments: [
        { kind: "file", name: "data.csv", size: 3, path },
        { kind: "image", name: "i1.png", size: 3, thumbnail: "AAAA" },
        { kind: "tab", name: "A page", cut: true },
        { kind: "image", name: "i2.png", size: 3, thumbnail: "AAAA" },
      ],
    });
    expect(conversationEventSchema.safeParse(owner).success).toBe(true);
  });

  it("the bubble keeps the order the owner added them in; the prompt keeps its own", async () => {
    const { h, fake, id } = await setup({ promptCapabilities: BOTH });
    for (const piece of [image("i1"), file("f1", "data.csv", "a,b"), tab("t1")]) {
      expect(await h.pool.attach(id, piece)).toEqual({ ok: true });
    }
    expect(await sendAndWait(h, id, "why?", ["i1", "f1", "t1"])).toEqual({ ok: true });
    expect(fake.prompts.at(-1)?.map((block) => block.type)).toEqual(["text", "image", "resource", "text"]);
    expect(ownerTexts(h, id).at(-1)?.attachments?.map((attachment) => attachment.kind)).toEqual(["image", "file", "tab"]);
  });

  it("a message of attachments only has no text block, and its bubble has empty text", async () => {
    const { h, fake, id } = await setup({ promptCapabilities: BOTH });
    expect(await h.pool.attach(id, image("i1"))).toEqual({ ok: true });
    expect(await sendAndWait(h, id, "", ["i1"])).toEqual({ ok: true });
    expect(fake.prompts.at(-1)).toEqual([{ type: "image", data: b64("img"), mimeType: "image/png" }]);
    const owner = ownerTexts(h, id).at(-1)!;
    expect(owner).toMatchObject({ text: "", attachments: [{ kind: "image", name: "i1.png" }] });
    expect(conversationEventSchema.safeParse(owner).success).toBe(true);
  });

  it("a text-only message is sent exactly as before", async () => {
    const { h, fake, id } = await setup({ promptCapabilities: BOTH });
    expect(await sendAndWait(h, id, "hello")).toEqual({ ok: true });
    expect(fake.prompts.at(-1)).toEqual([{ type: "text", text: "hello" }]);
    expect(ownerTexts(h, id).at(-1)).toEqual({ type: "text", role: "owner", text: "hello" });
  });

  it("Codex's title turn stays text only; the message after it carries the picture", async () => {
    const { h, fake, id } = await setup({ scenario: "codex", promptCapabilities: BOTH });
    expect(await h.pool.attach(id, image("i1"))).toEqual({ ok: true });
    expect(await sendAndWait(h, id, "look at this", ["i1"])).toEqual({ ok: true });
    expect(fake.prompts).toEqual([
      [{ type: "text", text: "/rename look at this" }],
      [
        { type: "text", text: "look at this" },
        { type: "image", data: b64("img"), mimeType: "image/png" },
      ],
    ]);
  });
});

describe("022 T617 the command handler routes attach, attach-cancel and send with attachments", () => {
  it("answers each piece and the send with one conversation-result", async () => {
    const { h, fake, id } = await setup({ promptCapabilities: BOTH });
    const { handler, sent } = handlerFor(h);
    let counter = 0;
    const run = async (command: Record<string, unknown>) => {
      const commandId = `cmd-${++counter}`;
      await handler.handle({ type: "conversation-command", sessionId: "worker", commandId, command });
      return sent.find((frame) => frame.type === "conversation-result" && frame.commandId === commandId);
    };
    expect(await run({ type: "ui.conversation.attach", payload: { conversationId: id, ...image("i1") } })).toMatchObject({ ok: true });
    expect(await run({ type: "ui.conversation.attach", payload: { conversationId: id, ...image("i2") } })).toMatchObject({ ok: true });
    expect(await run({ type: "ui.conversation.attach-cancel", payload: { conversationId: id, attachmentId: "i2" } })).toMatchObject({
      ok: true,
    });
    expect(
      await run({ type: "ui.conversation.attach", payload: { conversationId: id, ...image("i3"), mimeType: "image/bmp" } }),
    ).toMatchObject({ ok: false, error: { code: "attachment-type" } });
    const from = h.rec.events.length;
    expect(await run({ type: "ui.conversation.send", payload: { conversationId: id, text: "", attachments: ["i1"] } })).toMatchObject({
      ok: true,
    });
    await waitFor(() => turnEnded(h.rec.events.slice(from), id), "the end of the turn");
    expect(fake.prompts.at(-1)).toEqual([{ type: "image", data: b64("img"), mimeType: "image/png" }]);
  });
});

describe("022 T616 refusals", () => {
  it("attachment-not-accepted for a picture the agent does not take, and the staged data is dropped", async () => {
    const { h, fake, id } = await setup({ promptCapabilities: { image: false, embeddedContext: true } });
    expect(await h.pool.attach(id, image("i1"))).toEqual({ ok: true });
    const sent = await h.pool.send(id, "see", undefined, undefined, ["i1"]);
    expect(sent.ok ? "ok" : sent.error.code).toBe("attachment-not-accepted");
    expect(fake.prompts).toEqual([]);
    const again = await h.pool.send(id, "see", undefined, undefined, ["i1"]);
    expect(again.ok ? "ok" : again.error.code).toBe("attachment-unknown");
  });

  it("attachment-not-accepted for the tab when the agent takes no context, before any file is placed", async () => {
    const { h, fake, id } = await setup({ promptCapabilities: { image: true, embeddedContext: false } });
    expect(await h.pool.attach(id, tab("t1"))).toEqual({ ok: true });
    expect(await h.pool.attach(id, file("f1", "a.txt", "x"))).toEqual({ ok: true });
    const sent = await h.pool.send(id, "see", undefined, undefined, ["t1", "f1"]);
    expect(sent.ok ? "ok" : sent.error.code).toBe("attachment-not-accepted");
    expect(fake.prompts).toEqual([]);
    expect(await readdir(join(h.dir, "data", "scratch", id, ATTACHMENTS_FOLDER))).toEqual([]);
  });

  it("files need no capability: the agent is only told their path", async () => {
    const { h, fake, id } = await setup();
    expect(await h.pool.attach(id, file("f1", "a.txt", "x"))).toEqual({ ok: true });
    expect(await sendAndWait(h, id, "", ["f1"])).toEqual({ ok: true });
    expect(fake.prompts.at(-1)?.[0]).toMatchObject({ type: "text", text: expect.stringMatching(/^- a\.txt: /u) });
  });

  it("an attachment of an unknown conversation is not-found", async () => {
    const { h } = await setup({ promptCapabilities: BOTH });
    const outcome = await h.pool.attach("0000000000000000-none", image("i1"));
    expect(outcome.ok ? "ok" : outcome.error.code).toBe("not-found");
  });
});

describe("022 T616 staged data goes with the conversation (R-340)", () => {
  const parts = async (h: Harness, id: string) => readdir(join(h.dir, "data", "scratch", id, ATTACHMENTS_FOLDER)).catch(() => [] as string[]);

  it("on remove", async () => {
    const { h, id } = await setup({ promptCapabilities: BOTH });
    expect(await h.pool.attach(id, file("f1", "a.txt", "abc", false))).toEqual({ ok: true });
    expect(await parts(h, id)).toEqual([".f1.part"]);
    expect((await h.pool.remove(id)).ok).toBe(true);
    await waitFor(async () => (await parts(h, id)).length === 0, "the part file to go");
  });

  it("on the agent's unexpected exit", async () => {
    const { h, fake, id } = await setup({ promptCapabilities: BOTH });
    expect(await h.pool.attach(id, file("f1", "a.txt", "abc", false))).toEqual({ ok: true });
    fake.children.at(-1)!.exit(3);
    await waitFor(() => h.pool.state(id) === "crashed", "the crash");
    await waitFor(async () => (await parts(h, id)).length === 0, "the part file to go");
  });

  it("on the idle stop", async () => {
    const { h, id } = await setup({ promptCapabilities: BOTH });
    expect(await h.pool.attach(id, image("i1"))).toEqual({ ok: true });
    h.clock.advance(CONVERSATION_IDLE_MS);
    await waitFor(() => h.pool.state(id) === "stopped", "the idle stop");
    await waitFor(async () => {
      const sent = await h.pool.send(id, "x", undefined, undefined, ["i1"]);
      return !sent.ok && sent.error.code === "attachment-unknown";
    }, "the staged picture to be gone");
  });
});

describe("022 T616 the log keeps a bubble's attachments under its cap (R-318)", () => {
  it("never merges an owner message with attachments into another text", () => {
    const log = new ConversationEventLog({ capBytes: 2_000 });
    const withImage: ConversationEvent = { type: "text", role: "owner", text: "look", attachments: [{ kind: "image", name: "a.png" }] };
    log.append(withImage);
    log.append({ type: "text", role: "owner", text: "x".repeat(600) });
    log.append({ type: "text", role: "owner", text: "y".repeat(600) });
    log.append({ type: "text", role: "owner", text: "z".repeat(600) });
    expect(log.bytes).toBeLessThanOrEqual(2_000);
    // The newer texts give way among themselves; the message with its picture stays as it was.
    expect(log.entries[0]?.event).toEqual(withImage);
  });
});

describe("022 T618 review fixes in the pool and the handler", () => {
  const parts = async (h: Harness, id: string) => readdir(join(h.dir, "data", "scratch", id, ATTACHMENTS_FOLDER)).catch(() => [] as string[]);
  const codeOf = (outcome: { ok: boolean; error?: { code: string } }) => (outcome.ok ? "ok" : outcome.error!.code);

  it("shutdown resolves only once the part files are gone", async () => {
    const { h, id } = await setup({ promptCapabilities: BOTH });
    expect(await h.pool.attach(id, file("f1", "a.txt", "abc", false))).toEqual({ ok: true });
    expect(await parts(h, id)).toEqual([".f1.part"]);
    await h.pool.shutdown();
    expect(await parts(h, id)).toEqual([]);
  });

  it("a piece re-arms the 10-minute idle stop", async () => {
    const { h, id } = await setup({ promptCapabilities: BOTH });
    h.clock.advance(CONVERSATION_IDLE_MS - 5_000);
    expect(await h.pool.attach(id, file("f1", "a.txt", "abc", false))).toEqual({ ok: true });
    h.clock.advance(10_000);
    await sleep(100);
    expect(h.pool.state(id)).toBe("idle");
    h.clock.advance(CONVERSATION_IDLE_MS);
    await waitFor(() => h.pool.state(id) === "stopped", "the idle stop");
  });

  it("a new start evicts another idle conversation, not one a piece just reached", async () => {
    const { h, id: receiving } = await setup({ promptCapabilities: BOTH }, { cap: 2 });
    expect(await h.pool.attach(receiving, file("f1", "a.txt", "abc", false))).toEqual({ ok: true });
    h.clock.advance(1_000);
    const other = await h.start();
    h.clock.advance(1_000);
    const third = await h.start();
    await waitFor(() => h.pool.state(other) === "stopped", "the other one's eviction");
    expect(h.pool.state(receiving)).toBe("idle");
    expect(h.pool.state(third)).toBe("idle");
    expect(await parts(h, receiving)).toEqual([".f1.part"]);
  });

  it("with no other to evict, a new start is refused too-many-running while a piece is on its way", async () => {
    const { h, id } = await setup({ promptCapabilities: BOTH }, { cap: 1 });
    expect(await h.pool.attach(id, file("f1", "a.txt", "abc", false))).toEqual({ ok: true });
    expect(codeOf(await h.pool.start("claude-code", { kind: "scratch" }))).toBe("too-many-running");
    expect(h.pool.state(id)).toBe("idle");
    expect(await parts(h, id)).toEqual([".f1.part"]);
  });

  it("a refused send drops only the attachments it named", async () => {
    const { h, id } = await setup({ promptCapabilities: { image: false, embeddedContext: true } });
    expect(await h.pool.attach(id, image("i1"))).toEqual({ ok: true });
    expect(await h.pool.attach(id, file("f1", "a.txt", "x"))).toEqual({ ok: true });
    expect(codeOf(await h.pool.send(id, "see", undefined, undefined, ["i1"]))).toBe("attachment-not-accepted");
    expect(codeOf(await h.pool.send(id, "see", undefined, undefined, ["i1"]))).toBe("attachment-unknown");
    expect(await sendAndWait(h, id, "", ["f1"])).toEqual({ ok: true });
  });

  it("a busy refusal keeps what was staged, so the owner can send it again", async () => {
    let release!: () => void;
    const hold = new Promise<void>((done) => (release = done));
    const { h, fake, id } = await setup({ promptCapabilities: BOTH, hold });
    const from = h.rec.events.length;
    expect(await h.pool.send(id, "first")).toEqual({ ok: true });
    expect(await h.pool.attach(id, image("i1"))).toEqual({ ok: true });
    expect(codeOf(await h.pool.send(id, "see", undefined, undefined, ["i1"]))).toBe("busy");
    release();
    await waitFor(() => turnEnded(h.rec.events.slice(from), id), "the first turn to end");
    expect(await sendAndWait(h, id, "see", ["i1"])).toEqual({ ok: true });
    expect(fake.prompts.at(-1)).toContainEqual({ type: "image", data: b64("img"), mimeType: "image/png" });
  });

  it("answers a command it cannot read with a refusal under its commandId, not silence", async () => {
    const { h, id } = await setup({ promptCapabilities: BOTH });
    const { handler, sent } = handlerFor(h);
    const result = (commandId: string) => sent.find((frame) => frame.type === "conversation-result" && frame.commandId === commandId);
    // One base64 character past the piece bound.
    const tooLong = { conversationId: id, ...image("i1"), size: 600_000, data: b64(Buffer.alloc(524_292)) };
    await handler.handle({ type: "conversation-command", sessionId: "worker", commandId: "big", command: { type: "ui.conversation.attach", payload: tooLong } });
    expect(result("big")).toMatchObject({ ok: false, error: { code: "attachment-too-large" } });
    const { index: _index, ...noIndex } = image("i2");
    await handler.handle({ type: "conversation-command", sessionId: "worker", commandId: "odd", command: { type: "ui.conversation.attach", payload: { conversationId: id, ...noIndex } } });
    expect(result("odd")).toMatchObject({ ok: false, error: { code: "attachment-type" } });
    for (const commandId of ["big", "odd"]) expect(conversationResultFrameSchema.safeParse(result(commandId)).success).toBe(true);
  });
});

describe("022 T616 a replayed picture (R-343)", () => {
  it("becomes an image attachment of the owner's message", async () => {
    const first = await setup({ promptCapabilities: BOTH }, { browserRunId: "run-a" });
    await first.h.pool.shutdown();

    const replay: acp.SessionNotification["update"][] = [
      { sessionUpdate: "user_message_chunk", content: { type: "image", data: b64("img"), mimeType: "image/png" } },
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "what is this?" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a picture" } },
    ];
    const fake = fakeAgents({ promptCapabilities: BOTH, replay });
    const other = await poolHarness({ spawnAgent: fake.spawn, store: false, dir: first.h.dir, index: first.h.index, browserRunId: "run-b" });
    harnesses.push(other);
    expect((await other.pool.open(first.id)).ok).toBe(true);
    await waitFor(() => other.rec.of(first.id).some((entry) => entry.event.type === "text" && entry.event.role === "agent"), "the replay");

    const owner: ConversationEvent[] = ownerTexts(other, first.id);
    const withImage = owner.find((event) => event.type === "text" && event.attachments !== undefined);
    expect(withImage).toMatchObject({ attachments: [{ kind: "image", name: "image" }] });
    expect(owner.map((event) => (event.type === "text" ? event.text : "")).join("")).toBe("what is this?");
    for (const event of owner) expect(conversationEventSchema.safeParse(event).success).toBe(true);
  });
});
