import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ATTENTION_SENTENCES } from "@hallpass/contracts";
import type { AgentPortLike } from "../src/service-worker/agent-bridge.js";
import { CLOSED_PANEL_TIMEOUT_MS } from "../src/service-worker/agent-tools/prompts.js";
import { composeAgentRuntime, UPLOAD_ROOTS_RECORD_WAIT_MS } from "../src/service-worker/agent-runtime.js";

/**
 * 014/T378 — the worker's half of the directory question (FR-193..195, R-187 §3, §4).
 *
 * The host holds a `file_upload` naming a file nobody allowed, and asks. This file pins the four
 * seams that carry the question back and the answer forward, because each is a place where the
 * host could be perfectly right and the owner still never asked:
 *
 * - the *advertisement*: the host asks only a worker that said it could raise the card, because an
 *   unknown frame is dropped on this link and a call asked of an old worker would simply hang;
 * - the *card*: the request becomes an `ask` of kind `upload-directory` naming the owner's own
 *   paths, and its five endings become the five words the frame carries;
 * - the *list*: the relay's answer becomes the panel's rows, asked for on every established link;
 * - the *revoke*: the row is not taken away on the press, but on the relay's answer - and the press
 *   is made again on the next link if that answer never came (FR-192).
 */

type FakePort = AgentPortLike & { sent: unknown[]; emit(message: unknown): void };

function fakePort(): FakePort {
  const listeners: Array<(message: unknown) => void> = [];
  return {
    sent: [],
    postMessage(message: unknown) {
      this.sent.push(message);
    },
    disconnect() {},
    onMessage: { addListener: (cb: (message: unknown) => void) => void listeners.push(cb) },
    onDisconnect: { addListener: () => undefined },
    emit(message: unknown) {
      for (const listener of listeners) listener(message);
    },
  };
}

const SESSION = "session-u1";
const TAB = 7;
const A = "https://a.test";
const CALL = "host-call-1";
const DOCS = "C:\\Users\\owner\\docs";
const CONFIG = "C:\\Users\\owner\\AppData\\Local\\hallpass\\config.json";
const FILES = [{ path: `${DOCS}\\receipt.txt`, directory: DOCS }];
const HELLO = { type: "hello", sessionId: SESSION, agentId: "agent-1", displayName: "Claude Code" };
const PAIR_REQUEST = {
  type: "pair-request",
  agentId: "agent-1",
  displayName: "Claude Code",
  origin: "stdio:local",
  sessionId: SESSION,
};
const CONSENT_REQUEST = { type: "upload-consent-request", sessionId: SESSION, callId: CALL, files: FILES };

function installChrome(): void {
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  const tabs = [{ id: TAB, url: `${A}/one`, title: "A one", groupId: -1, active: true, windowId: 900 }];
  const area = (store: Record<string, unknown>) => ({
    async get(keys: string[]) {
      const out: Record<string, unknown> = {};
      for (const key of keys) if (key in store) out[key] = store[key];
      return out;
    },
    async set(values: Record<string, unknown>) {
      Object.assign(store, values);
    },
  });
  (globalThis as { chrome?: unknown }).chrome = {
    storage: { local: area(local), session: area(session) },
    alarms: { create() {}, clear: async () => true, onAlarm: { addListener() {} } },
    runtime: { id: "extension-1", onMessage: { addListener() {} } },
    scripting: { async executeScript() {} },
    tabs: {
      async sendMessage() {
        return { documentEpoch: "doc-1", canonicalOrigin: A };
      },
      async get(tabId: number) {
        const tab = tabs.find((candidate) => candidate.id === tabId);
        if (!tab) throw new Error("No tab with id");
        return tab;
      },
      async query() {
        return tabs;
      },
      async ungroup() {},
      async group() {
        return 100;
      },
      onUpdated: { addListener() {}, removeListener() {} },
    },
    tabGroups: {
      async update(groupId: number) {
        return { id: groupId };
      },
    },
    downloads: { onCreated: { addListener: () => undefined }, onChanged: { addListener: () => undefined } },
    debugger: {
      async getTargets() {
        return [];
      },
      async attach() {},
      async detach() {},
      async sendCommand() {
        return {};
      },
      onEvent: { addListener() {} },
      onDetach: { addListener() {} },
    },
  };
}

async function pairedRuntime(
  options: { adopt?: boolean } = {},
): Promise<{ port: FakePort; runtime: ReturnType<typeof composeAgentRuntime> }> {
  const port = fakePort();
  const runtime = composeAgentRuntime({ connectNative: () => port });
  runtime.start();
  port.emit(HELLO);
  port.emit(PAIR_REQUEST);
  await vi.waitFor(async () => expect((await runtime.pairing.state()).pending).toBeDefined());
  await runtime.pairing.decide("agent-1", true);
  await vi.waitFor(() => expect(port.sent).toHaveLength(1));
  // A session that holds no tab is the one case where the card has no site to belong to, so the
  // suite has to be able to make one.
  if (options.adopt !== false) await runtime.tabs.adopt(SESSION, TAB);
  return { port, runtime };
}

function sentOfType(port: FakePort, type: string): Array<Record<string, unknown>> {
  return port.sent.filter((frame) => (frame as { type?: string }).type === type) as Array<Record<string, unknown>>;
}

async function directoryCard(
  runtime: ReturnType<typeof composeAgentRuntime>,
): Promise<{ promptId: string; kind?: string; site: string; tool: string; files?: unknown }> {
  await vi.waitFor(() => expect(runtime.prompts.current()).toBeDefined(), { timeout: 3_000 });
  return runtime.prompts.current() as never;
}

async function answeredWith(port: FakePort, decision: string): Promise<void> {
  await vi.waitFor(() =>
    expect(sentOfType(port, "upload-consent-result")).toEqual([
      { type: "upload-consent-result", callId: CALL, decision },
    ]),
  );
}

describe("T378 the owner's answer about a directory", () => {
  beforeEach(() => {
    installChrome();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("tells the host it can raise the card, on the answer every link carries", async () => {
    const { port } = await pairedRuntime();

    // Beside the browser run 013 added the same way, on the same frame, for the same reason.
    expect(sentOfType(port, "pair-result")).toEqual([
      expect.objectContaining({
        type: "pair-result",
        agentId: "agent-1",
        sessionId: SESSION,
        accepted: true,
        features: ["upload-consent"],
      }),
    ]);
  });

  it("raises a card naming the owner's own paths, and answers 'once' for these files", async () => {
    const { port, runtime } = await pairedRuntime();

    port.emit(CONSENT_REQUEST);

    const card = await directoryCard(runtime);
    expect(card.kind).toBe("upload-directory");
    expect(card.tool).toBe("file_upload");
    expect(card.files).toEqual(FILES);
    // The site is the one the session is on: the question is about the disk, but the card belongs
    // to a session, and the panel shows whose work it is.
    expect(card.site).toBe(A);

    runtime.prompts.decide(card.promptId, true);

    await answeredWith(port, "once");
    // And the list is asked for afterwards: an answer may have changed it, and the panel's rows
    // are a picture of the file rather than of what the panel last did to it.
    await vi.waitFor(() => expect(sentOfType(port, "upload-roots-list")).toEqual([{ type: "upload-roots-list" }]));
  });

  it("answers 'always' only when the owner asked for the directory to be remembered", async () => {
    const { port, runtime } = await pairedRuntime();
    port.emit(CONSENT_REQUEST);
    const card = await directoryCard(runtime);

    runtime.prompts.decide(card.promptId, true, undefined, undefined, true);

    await answeredWith(port, "always");
  });

  it("answers 'deny' for a decline, and 'interrupted' for a step the owner ended", async () => {
    const declining = await pairedRuntime();
    declining.port.emit(CONSENT_REQUEST);
    const first = await directoryCard(declining.runtime);
    declining.runtime.prompts.decide(first.promptId, false);
    await answeredWith(declining.port, "deny");
    // A decline cannot have changed the list, but another session may have: asked for at once.
    await vi.waitFor(() =>
      expect(sentOfType(declining.port, "upload-roots-list")).toEqual([{ type: "upload-roots-list" }]),
    );

    delete (globalThis as { chrome?: unknown }).chrome;
    installChrome();
    const interrupted = await pairedRuntime();
    interrupted.port.emit(CONSENT_REQUEST);
    await directoryCard(interrupted.runtime);

    interrupted.runtime.interruptSession(SESSION);

    // Not a decline: nothing was decided, and the card came down with the step (FR-179).
    await answeredWith(interrupted.port, "interrupted");
    expect(interrupted.runtime.prompts.current()).toBeUndefined();
  });

  /**
   * 014/T384 (S3 review F3) — two things that were never the owner's doing.
   *
   * The worker holds one question at a time, so a second session's card is refused before it is
   * raised; and a session holding no tab has no site to show the card against. Both used to be
   * answered in words that name a decision - `interrupted`, `deny` - and both reached the agent as
   * a sentence about a person who had done nothing of the kind.
   */
  it("answers 'busy' for a card it could not raise over another question (F3)", async () => {
    const { port, runtime } = await pairedRuntime();

    port.emit(CONSENT_REQUEST);
    await directoryCard(runtime);
    // A second session's file, arriving while the first question is still on the screen.
    port.emit({ ...CONSENT_REQUEST, callId: "host-call-2" });

    await vi.waitFor(() =>
      expect(sentOfType(port, "upload-consent-result")).toEqual([
        { type: "upload-consent-result", callId: "host-call-2", decision: "busy" },
      ]),
    );
    // And the owner's first question is untouched: it is still the one on the screen.
    expect(runtime.prompts.current()).toBeDefined();
  });

  it("answers 'interrupted', not a decline, when the session holds no tab to ask about (F3)", async () => {
    const { port } = await pairedRuntime({ adopt: false });

    port.emit(CONSENT_REQUEST);

    // Nobody declined anything: there was no card. `deny` would have told the agent the owner
    // refused their file, and would have been recorded as the owner's decision about it.
    await answeredWith(port, "interrupted");
  });

  /**
   * 014/T384 (S3 review, the minor finding) — a session that ended is not a question nobody answered.
   *
   * The card comes down with the session, and the default word for that was `timed-out`, which the
   * host turns into `upload-not-answered`: an agent told its own session's end was the owner
   * failing to answer in time. Nothing was decided and nothing refused the call, which is exactly
   * what `interrupted` says - and what the host answers as the stop that refused nothing.
   */
  it("answers a card its session ended under as interrupted, not as unanswered", async () => {
    const { port, runtime } = await pairedRuntime();
    port.emit(CONSENT_REQUEST);
    await directoryCard(runtime);

    // The agent's own session ending: the host says so on the link before it goes.
    port.emit({ type: "stop", sessionId: SESSION });

    await answeredWith(port, "interrupted");
  });

  /**
   * 014/T384 (S3 review F1) — the one ending that carries an instruction (011 FR-146).
   *
   * A card raised into a panel nobody has opened waits the long bound and then expires, and the
   * controller hands the sentence that says where to click back with it. Every other question in
   * the product relays that sentence to the agent; this one dropped it on the floor, so the person
   * who could have answered was told nothing at all.
   */
  it("carries where to click on a question that expired with no panel to show it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { port, runtime } = await pairedRuntime();
      // Nobody is looking: the controller takes the long bound and fixes the sentence at the raise.
      runtime.bindPanelPresence({ isConnected: () => false, onPresenceChange: () => undefined });

      port.emit(CONSENT_REQUEST);
      await directoryCard(runtime);

      await vi.advanceTimersByTimeAsync(CLOSED_PANEL_TIMEOUT_MS + 1_000);

      await vi.waitFor(() =>
        expect(sentOfType(port, "upload-consent-result")).toEqual([
          { type: "upload-consent-result", callId: CALL, decision: "timed-out", hint: ATTENTION_SENTENCES.consent },
        ]),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * 014/T384 (S3 review F2) — the owner's half of a "from now on" that was not written down.
   *
   * The agent is told in a word of its own; the owner used to be told nothing, and the next upload
   * from that directory would ask again as though they had never answered. The worker is where the
   * two facts meet: it knows what it answered `always` about, and it asks for the list right after.
   */
  it("says on the panel when a directory the owner allowed did not reach the list (F2)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { port, runtime } = await pairedRuntime();
      port.emit({ type: "relay-started", relayPid: 4242, recordPath: CONFIG });
      await vi.waitFor(() => expect(sentOfType(port, "upload-roots-list")).toHaveLength(1));
      port.emit(CONSENT_REQUEST);
      const card = await directoryCard(runtime);

      runtime.prompts.decide(card.promptId, true, undefined, undefined, true);
      await answeredWith(port, "always");

      // The host could not write, so it never places the call: the worker hears nothing, and asks
      // for the list once the bound has passed - a list read after the host's attempt.
      await vi.advanceTimersByTimeAsync(UPLOAD_ROOTS_RECORD_WAIT_MS + 100);
      expect(sentOfType(port, "upload-roots-list")).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(UPLOAD_ROOTS_RECORD_WAIT_MS * 2);
      expect(sentOfType(port, "upload-roots-list")).toHaveLength(2);

      // The list comes back without it: the host could not record the answer.
      port.emit({ type: "upload-roots", roots: [], path: CONFIG });
      await vi.waitFor(async () =>
        expect((await runtime.projection()).uploadRoots).toEqual({ roots: [], path: CONFIG, notRecorded: [DOCS] }),
      );

      // And a list that does carry it takes the notice away: the file is the truth, not this memory.
      port.emit({ type: "upload-roots", roots: [DOCS], path: CONFIG });
      await vi.waitFor(async () =>
        expect((await runtime.projection()).uploadRoots).toEqual({ roots: [DOCS], path: CONFIG }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The race the packaged gate found on Chrome 153: the host writes the file only after it has the
   * answer, so a list asked for at the moment of answering is read before the write. The call the
   * host places for that same id is the proof the write happened (FR-194), so that is when the
   * list is asked for - and a listing that arrives before it says nothing about the answer.
   */
  it("asks for the list after an 'always' only once the host places the call for it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { port, runtime } = await pairedRuntime();
      port.emit({ type: "relay-started", relayPid: 4242, recordPath: CONFIG });
      await vi.waitFor(() => expect(sentOfType(port, "upload-roots-list")).toHaveLength(1));
      port.emit(CONSENT_REQUEST);
      const card = await directoryCard(runtime);

      runtime.prompts.decide(card.promptId, true, undefined, undefined, true);
      await answeredWith(port, "always");
      // Not at the answer: the host has not written yet.
      expect(sentOfType(port, "upload-roots-list")).toHaveLength(1);

      // A listing read before the write, from the link's own request: not a verdict on the answer.
      port.emit({ type: "upload-roots", roots: [], path: CONFIG });
      await vi.waitFor(async () =>
        expect((await runtime.projection()).uploadRoots).toEqual({ roots: [], path: CONFIG }),
      );

      // The host places the call it held: the write is done, and the list is asked for once.
      port.emit({ callId: CALL, sessionId: SESSION, tool: "tabs_context", args: {} });
      await vi.waitFor(() => expect(sentOfType(port, "upload-roots-list")).toHaveLength(2));
      // And the bound does not ask a second time.
      await vi.advanceTimersByTimeAsync(UPLOAD_ROOTS_RECORD_WAIT_MS * 2);
      expect(sentOfType(port, "upload-roots-list")).toHaveLength(2);

      port.emit({ type: "upload-roots", roots: [DOCS], path: CONFIG });
      await vi.waitFor(async () =>
        expect((await runtime.projection()).uploadRoots).toEqual({ roots: [DOCS], path: CONFIG }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * 014/T384 (S3 review F7 beside F2) — a root the host was never going to write down.
   *
   * The host refuses to remember a drive or a share root and uploads those files once instead, so
   * a list that comes back without such a directory is not a failed write. The worker reads the
   * same rule from the contract; without it the panel would complain about every `always` the
   * owner pressed on a file sitting at a drive root.
   */
  it("says nothing about a drive root the host will never remember (F7)", async () => {
    const { port, runtime } = await pairedRuntime();
    port.emit({ type: "relay-started", relayPid: 4242, recordPath: CONFIG });
    port.emit({
      ...CONSENT_REQUEST,
      files: [{ path: "D:\\holiday.png", directory: "D:\\" }],
    });
    const card = await directoryCard(runtime);

    runtime.prompts.decide(card.promptId, true, undefined, undefined, true);
    await answeredWith(port, "always");

    port.emit({ type: "upload-roots", roots: [], path: CONFIG });
    await vi.waitFor(async () =>
      expect((await runtime.projection()).uploadRoots).toEqual({ roots: [], path: CONFIG }),
    );
  });

  it("asks for the list on every established link and shows what the relay answers", async () => {
    const { port, runtime } = await pairedRuntime();
    // The relay's greeting is what a fresh link is; the worker acknowledges it and asks.
    port.emit({ type: "relay-started", relayPid: 4242, recordPath: CONFIG });

    await vi.waitFor(() => expect(sentOfType(port, "upload-roots-list").length).toBeGreaterThanOrEqual(1));
    // Nothing is shown before the answer: "no directories" and "nobody has told me" are different
    // things, and only the first of them means every upload will be asked about.
    expect((await runtime.projection()).uploadRoots).toBeUndefined();

    port.emit({ type: "upload-roots", roots: [DOCS], path: CONFIG, malformed: true });

    await vi.waitFor(async () =>
      expect((await runtime.projection()).uploadRoots).toEqual({ roots: [DOCS], path: CONFIG, malformed: true }),
    );

    // S3 review F4: and where the host kept a document it could not read, which is the one thing
    // about that file the owner can act on and the agent is never told.
    port.emit({ type: "upload-roots", roots: [DOCS], path: CONFIG, preserved: "config.json.invalid" });

    await vi.waitFor(async () =>
      expect((await runtime.projection()).uploadRoots).toEqual({
        roots: [DOCS],
        path: CONFIG,
        preserved: "config.json.invalid",
      }),
    );
  });

  it("keeps a revoked row until the relay answers, and asks again on the next link", async () => {
    const { port, runtime } = await pairedRuntime();
    port.emit({ type: "relay-started", relayPid: 4242, recordPath: CONFIG });
    port.emit({ type: "upload-roots", roots: [DOCS], path: CONFIG });
    await vi.waitFor(async () => expect((await runtime.projection()).uploadRoots?.roots).toEqual([DOCS]));

    await runtime.clearUploadRoot(DOCS);

    await vi.waitFor(() =>
      expect(sentOfType(port, "upload-roots-remove")).toEqual([{ type: "upload-roots-remove", root: DOCS }]),
    );
    // FR-192: the row is the host's answer, not the panel's press. Until the relay says so it
    // stands, because a row that vanished on a write that never happened would be a lie.
    expect((await runtime.projection()).uploadRoots?.roots).toEqual([DOCS]);

    // A relay that never answered: the press is made again on the link that comes back.
    port.emit({ type: "relay-started", relayPid: 4343, recordPath: CONFIG });
    await vi.waitFor(() => expect(sentOfType(port, "upload-roots-remove")).toHaveLength(2));

    port.emit({ type: "upload-roots", roots: [], path: CONFIG });
    await vi.waitFor(async () => expect((await runtime.projection()).uploadRoots).toEqual({ roots: [], path: CONFIG }));
    // And once it is gone it is not asked about again.
    port.emit({ type: "relay-started", relayPid: 4444, recordPath: CONFIG });
    await vi.waitFor(() => expect(sentOfType(port, "upload-roots-list").length).toBeGreaterThanOrEqual(3));
    expect(sentOfType(port, "upload-roots-remove")).toHaveLength(2);
  });
});
