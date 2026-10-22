import { describe, expect, it } from "vitest";
import { AGENT_LINK_PROTOCOL } from "@hallpass/contracts";
import { contractExport, contractSchema, expectAccepted, expectRejected } from "./helpers.js";

/**
 * 019 - a conversation in the side panel: the `hello` additions, the six `conversation-*` link
 * frames plus `relay-gone`, the `ui.conversation.*` panel commands, the panel's conversation part,
 * and the author fields on a site record (contracts/conversation-frames.md, data-model.md,
 * R-312, R-321, R-323, R-328; T519).
 *
 * Every change to an existing shape is optional or a new frame type, so a 0.12.5-shaped frame still
 * parses and the link protocol stays 2 (R-323).
 */

const SESSION = "broker-session-1";
const CONVERSATION = "c0a8f3d2-6b1e-4d7a-9c2f-0d4e5b6a7c81";
const REQUEST = "req-1";
const NOW = "2026-10-19T08:00:00.000Z";

const ERROR_CODES = [
  "agent-missing",
  "agent-version",
  "install-needed",
  "install-failed",
  "folder-missing",
  "cannot-resume",
  "too-many-running",
  "consent-needed",
  "broker-unavailable",
  "agent-exited",
  "in-use-elsewhere",
  // T547 (G3): an unknown conversation, and a message sent while the agent's turn is running.
  "not-found",
  "busy",
  // T563: the folder dialog cannot open here; the panel offers a typed path instead.
  "path-entry",
  // 022 (contracts/attachments.md): a piece or a send with attachments refused.
  "attachment-too-large",
  "attachment-too-many",
  "attachment-type",
  "attachment-order",
  "attachment-unknown",
  "attachment-incomplete",
  "attachment-not-accepted",
  "attachment-folder-gone",
  "attachment-write-failed",
  // 022 T618 follow-up: a readable commandId on a command that did not validate.
  "invalid-command",
  // 021 (contracts/agents.md): a start the owner stopped, and an agent that cannot reach its model.
  "start-cancelled",
  "agent-model-unreachable",
  // 021 D-021-16: a mode change of an agent whose mode is fixed once started.
  "mode-fixed",
];

const VIEW = {
  conversationId: CONVERSATION,
  agent: "claude-code",
  title: "Tidy the invoices",
  folder: { kind: "project", path: "C:\\work\\invoices" },
  mode: "strict",
  createdAt: NOW,
  lastUsedAt: NOW,
  resumable: true,
  state: "idle",
};

const EVENTS = {
  text: { type: "text", role: "agent", text: "Hello" },
  tool: {
    type: "tool",
    toolCallId: "tc-1",
    kind: "edit",
    title: "Edit invoice.txt",
    inputSummary: "invoice.txt",
    status: "running",
  },
  permission: {
    type: "permission",
    requestId: REQUEST,
    toolCallId: "tc-1",
    kind: "execute",
    title: "Run a command",
    detail: "npm test",
  },
  permissionClosed: { type: "permission-closed", requestId: REQUEST, answer: "allow-once" },
  mode: { type: "mode", mode: "agent-review" },
  state: { type: "state", state: "running" },
  notice: { type: "notice", code: "agent-exited", text: "The agent stopped." },
};

const PANEL = {
  paired: [],
  sessions: [],
  tabs: [],
  sites: [],
  bridge: "connected",
};

const HELLO = {
  type: "hello",
  sessionId: SESSION,
  agentId: "claude-code",
  displayName: "Claude Code",
  token: "t".repeat(64),
  protocol: 2,
};

describe("T519 hello additions (R-312, R-321)", () => {
  const frame = () => contractSchema("agentLinkFrameSchema");

  it("still parses a 0.12.5 hello", () => {
    expectAccepted(frame(), HELLO, "a hello with none of the 019 fields");
    expectAccepted(frame(), { ...HELLO, intent: "choose" }, "a 018 choose-only hello");
  });

  it("accepts the broker role with its secret, and a panel token", () => {
    expectAccepted(frame(), { ...HELLO, role: "broker", brokerSecret: "s".repeat(43) }, "a broker hello");
    expectAccepted(frame(), { ...HELLO, panelToken: "p".repeat(32) }, "a panel conversation hello");
  });

  it("holds the length bounds and the one role", () => {
    expectRejected(frame(), { ...HELLO, role: "broker", brokerSecret: "s".repeat(42) }, "a short secret");
    expectRejected(frame(), { ...HELLO, role: "broker", brokerSecret: "s".repeat(129) }, "a long secret");
    expectRejected(frame(), { ...HELLO, role: "admin", brokerSecret: "s".repeat(43) }, "another role");
    expectRejected(frame(), { ...HELLO, panelToken: "p".repeat(31) }, "a short panel token");
    expectRejected(frame(), { ...HELLO, panelToken: "p".repeat(129) }, "a long panel token");
  });
});

describe("T519 conversation link frames (R-323)", () => {
  const frame = () => contractSchema("agentLinkFrameSchema");

  const FRAMES: Record<string, Record<string, unknown>> = {
    "relay-gone": { type: "relay-gone", sessionId: SESSION },
    "conversation-command": {
      type: "conversation-command",
      sessionId: SESSION,
      commandId: "cmd-1",
      command: { type: "ui.conversation.stop", payload: { conversationId: CONVERSATION } },
    },
    "conversation-result": {
      type: "conversation-result",
      sessionId: SESSION,
      commandId: "cmd-1",
      ok: true,
      value: { conversationId: CONVERSATION },
    },
    "conversation-event": {
      type: "conversation-event",
      sessionId: SESSION,
      conversationId: CONVERSATION,
      seq: 7,
      event: EVENTS.text,
    },
    "conversation-overview": {
      type: "conversation-overview",
      sessionId: SESSION,
      conversations: [VIEW],
      agents: [{ agent: "claude-code", availability: "ready" }],
      folders: [{ path: "C:\\work\\invoices", addedAt: NOW }],
    },
    "conversation-page": {
      type: "conversation-page",
      sessionId: SESSION,
      conversationId: CONVERSATION,
      fromSeq: 0,
      events: [{ seq: 0, event: EVENTS.text }],
      more: false,
    },
    "conversation-browser-token": {
      type: "conversation-browser-token",
      sessionId: SESSION,
      conversationId: CONVERSATION,
      token: "k".repeat(43),
      startTabId: 12,
    },
  };

  it.each(Object.keys(FRAMES))("accepts a well-formed %s and refuses an unknown field", (name) => {
    expectAccepted(frame(), FRAMES[name], `a ${name} frame`);
    expectRejected(frame(), { ...FRAMES[name], extra: 1 }, `a ${name} frame with an undeclared field`);
  });

  it.each(Object.keys(FRAMES))("refuses a %s without the broker's session id", (name) => {
    const { sessionId: _sessionId, ...rest } = FRAMES[name]!;
    expectRejected(frame(), rest, `a ${name} frame naming no session`);
  });

  it("refuses unknown fields inside the nested payloads too", () => {
    const f = frame();
    expectRejected(
      f,
      { ...FRAMES["conversation-event"], event: { ...EVENTS.text, extra: 1 } },
      "an event with an undeclared field",
    );
    expectRejected(
      f,
      { ...FRAMES["conversation-overview"], conversations: [{ ...VIEW, extra: 1 }] },
      "a conversation view with an undeclared field",
    );
    expectRejected(
      f,
      { ...FRAMES["conversation-command"], command: { type: "ui.conversation.stop", payload: { conversationId: CONVERSATION, extra: 1 } } },
      "a command with an undeclared payload field",
    );
  });

  it("answers a command with a value or with a coded error, never both", () => {
    const f = frame();
    const base = { type: "conversation-result", sessionId: SESSION, commandId: "cmd-1" };
    expectAccepted(f, { ...base, ok: true }, "a bare success");
    expectAccepted(f, { ...base, ok: false, error: { code: "folder-missing", detail: "The folder is gone." } }, "an error");
    expectRejected(f, { ...base, ok: false }, "a failure without its error");
    expectRejected(
      f,
      { ...base, ok: true, error: { code: "folder-missing", detail: "x" } },
      "a success carrying an error",
    );
    expectRejected(f, { ...base, ok: false, error: { code: "folder-missing" } }, "an error without its detail");
  });

  it("names exactly the twenty-seven ConversationError codes, including in-use-elsewhere, not-found, busy, path-entry, invalid-command and 021's three", () => {
    const f = frame();
    expect(ERROR_CODES).toHaveLength(27);
    for (const code of ERROR_CODES) {
      expectAccepted(
        f,
        { type: "conversation-result", sessionId: SESSION, commandId: "c", ok: false, error: { code, detail: "d" } },
        `error code ${code}`,
      );
    }
    expectRejected(
      f,
      { type: "conversation-result", sessionId: SESSION, commandId: "c", ok: false, error: { code: "other", detail: "d" } },
      "an unlisted error code",
    );
    expect(contractExport<readonly string[]>("CONVERSATION_ERROR_CODES")).toEqual(ERROR_CODES);
  });

  it("names the notices the panel says in its own words (R-317), each carried as a notice event", () => {
    expect(contractExport<readonly string[]>("CONVERSATION_NOTICES")).toEqual(["sandbox-permissions-declined"]);
    const f = frame();
    for (const code of contractExport<readonly string[]>("CONVERSATION_NOTICES")) {
      expectAccepted(f, { ...FRAMES["conversation-event"], event: { type: "notice", code, text: "detail" } }, `notice ${code}`);
    }
  });

  it("accepts every event kind and refuses a made-up one", () => {
    const f = frame();
    for (const [name, event] of Object.entries(EVENTS)) {
      expectAccepted(f, { ...FRAMES["conversation-event"], event }, `a ${name} event`);
    }
    expectRejected(f, { ...FRAMES["conversation-event"], event: { type: "reasoning", text: "x" } }, "an unknown event kind");
  });

  it("keeps the event size limits of the contract", () => {
    const f = frame();
    const at = (event: unknown) => ({ ...FRAMES["conversation-event"], event });
    expectAccepted(f, at({ ...EVENTS.text, text: "x".repeat(16 * 1024) }), "text at 16 KB");
    expectRejected(f, at({ ...EVENTS.text, text: "x".repeat(16 * 1024 + 1) }), "text over 16 KB");
    expectRejected(f, at({ ...EVENTS.text, role: "system" }), "text from another role");
    expectAccepted(f, at({ ...EVENTS.tool, title: "t".repeat(200), inputSummary: "i".repeat(400) }), "tool at its limits");
    expectRejected(f, at({ ...EVENTS.tool, title: "t".repeat(201) }), "tool title over 200");
    expectRejected(f, at({ ...EVENTS.tool, inputSummary: "i".repeat(401) }), "tool summary over 400");
    expectAccepted(f, at({ ...EVENTS.tool, byRule: true, status: "done" }), "a tool event allowed by rule");
    expectRejected(f, at({ ...EVENTS.tool, byRule: false }), "byRule is only ever true");
    for (const status of ["pending", "running", "done", "failed", "refused"]) {
      expectAccepted(f, at({ ...EVENTS.tool, status }), `tool status ${status}`);
    }
    expectRejected(f, at({ ...EVENTS.tool, status: "cancelled" }), "an unlisted tool status");
    expectAccepted(f, at({ ...EVENTS.permission, detail: "d".repeat(2048) }), "permission detail at 2 KB");
    expectRejected(f, at({ ...EVENTS.permission, detail: "d".repeat(2049) }), "permission detail over 2 KB");
  });

  it("closes a permission card with exactly the six answers of the contract", () => {
    const f = frame();
    const answers = ["allow-once", "reject", "allow-conversation", "by-rule", "cancelled", "agent-exited"];
    for (const answer of answers) {
      expectAccepted(
        f,
        { ...FRAMES["conversation-event"], event: { type: "permission-closed", requestId: REQUEST, answer } },
        `permission-closed answer ${answer}`,
      );
    }
    for (const answer of ["allow-always", "allow", "deny", ""]) {
      expectRejected(
        f,
        { ...FRAMES["conversation-event"], event: { type: "permission-closed", requestId: REQUEST, answer } },
        `permission-closed answer '${answer}'`,
      );
    }
  });

  it("states and modes are closed", () => {
    const f = frame();
    const at = (event: unknown) => ({ ...FRAMES["conversation-event"], event });
    expectRejected(f, at({ type: "mode", mode: "full-access" }), "a full-access mode event");
    expectRejected(f, at({ type: "state", state: "paused" }), "an unlisted state");
    for (const state of ["starting", "idle", "running", "waiting-for-owner", "stopped", "crashed", "gone"]) {
      expectAccepted(f, at({ type: "state", state }), `state ${state}`);
    }
  });

  it("revokes a browser token with null, and carries a start tab only with a token", () => {
    const f = frame();
    const base = FRAMES["conversation-browser-token"]!;
    expectAccepted(f, { ...base, token: null, startTabId: undefined }, "a revocation");
    expectRejected(f, { ...base, token: null }, "a revocation naming a start tab");
    expectRejected(f, { ...base, token: "short" }, "a token under 32 characters");
    const { startTabId: _tab, ...noTab } = base;
    expectAccepted(f, noTab, "a token without a start tab");
  });

  it("bounds a page of the log", () => {
    const f = frame();
    const base = FRAMES["conversation-page"]!;
    const big = { type: "text", role: "agent", text: "x".repeat(16 * 1024) };
    const events = Array.from({ length: 17 }, (_, seq) => ({ seq, event: big }));
    expectRejected(f, { ...base, events }, "a page over 256 KB");
    expectAccepted(f, { ...base, events: events.slice(0, 15) }, "a page under 256 KB");
  });
});

describe("T519 ui.conversation.* panel commands (FR-292, SC-140)", () => {
  const command = () => contractSchema("agentPanelCommandSchema");
  const cmd = (name: string, payload: unknown) => ({ type: `ui.conversation.${name}`, payload });

  const COMMANDS: Record<string, unknown> = {
    start: { agent: "codex", folder: { kind: "scratch" } },
    send: { conversationId: CONVERSATION, text: "hello", activeTabId: 3 },
    stop: { conversationId: CONVERSATION },
    answer: { conversationId: CONVERSATION, requestId: REQUEST, answer: "allow-once" },
    "set-mode": { conversationId: CONVERSATION, mode: "agent-review" },
    open: { conversationId: CONVERSATION },
    remove: { conversationId: CONVERSATION },
    "add-folder": {},
    "remove-folder": { path: "C:\\work\\invoices" },
    "open-folder": { conversationId: CONVERSATION },
    install: { agent: "claude-code" },
    consent: { granted: true },
  };

  it.each(Object.keys(COMMANDS))("accepts %s and refuses an undeclared field", (name) => {
    expectAccepted(command(), cmd(name, COMMANDS[name]), `ui.conversation.${name}`);
    expectRejected(
      command(),
      cmd(name, { ...(COMMANDS[name] as object), extra: 1 }),
      `ui.conversation.${name} with an undeclared field`,
    );
  });

  it("starts in the scratch folder or a project folder, for the two agents", () => {
    const c = command();
    expectAccepted(c, cmd("start", { agent: "claude-code", folder: { kind: "project", path: "C:\\work" } }), "a project start");
    expectRejected(c, cmd("start", { agent: "gemini", folder: { kind: "scratch" } }), "an agent that is not offered");
    expectRejected(c, cmd("start", { agent: "codex", folder: { kind: "project" } }), "a project without a path");
    expectRejected(c, cmd("start", { agent: "codex" }), "a start without a folder");
  });

  it("set-mode accepts only strict or agent-review", () => {
    const c = command();
    for (const mode of ["strict", "agent-review"]) {
      expectAccepted(c, cmd("set-mode", { conversationId: CONVERSATION, mode }), `mode ${mode}`);
    }
    for (const mode of ["full-access", "bypass", "auto", "yolo", "", "STRICT"]) {
      expectRejected(c, cmd("set-mode", { conversationId: CONVERSATION, mode }), `mode '${mode}'`);
    }
    expectRejected(c, cmd("set-mode", { conversationId: CONVERSATION }), "set-mode naming no mode");
  });

  it("answer cannot name by-rule, cancelled or an always option", () => {
    const c = command();
    for (const answer of ["allow-once", "reject", "allow-conversation"]) {
      expectAccepted(c, cmd("answer", { conversationId: CONVERSATION, requestId: REQUEST, answer }), `answer ${answer}`);
    }
    for (const answer of ["by-rule", "cancelled", "allow-always", "allow"]) {
      expectRejected(c, cmd("answer", { conversationId: CONVERSATION, requestId: REQUEST, answer }), `answer ${answer}`);
    }
  });

  it("bounds a message at 32 KB and refuses an empty one", () => {
    const c = command();
    expectAccepted(c, cmd("send", { conversationId: CONVERSATION, text: "x".repeat(32 * 1024) }), "text at 32 KB");
    expectRejected(c, cmd("send", { conversationId: CONVERSATION, text: "x".repeat(32 * 1024 + 1) }), "text over 32 KB");
    expectRejected(c, cmd("send", { conversationId: CONVERSATION, text: "" }), "empty text");
    expectRejected(c, cmd("send", { conversationId: CONVERSATION, text: "hi", activeTabId: -1 }), "a negative tab id");
  });

  it("minted ids are 16-64 of letters, digits and hyphens", () => {
    const c = command();
    expectRejected(c, cmd("stop", { conversationId: "short" }), "a short id");
    expectRejected(c, cmd("stop", { conversationId: "a".repeat(65) }), "a long id");
    expectRejected(c, cmd("stop", { conversationId: "..\\..\\evil-id-evil-id" }), "an id with path characters");
  });

  it("keeps the existing ui.agent commands working", () => {
    expectAccepted(command(), { type: "ui.agent.connect", payload: {} }, "ui.agent.connect");
  });
});

describe("T519 panel state and message (R-324)", () => {
  it("carries the conversation part, and a 0.12.5 state still parses", () => {
    const state = contractSchema("agentPanelStateSchema");
    expectAccepted(state, PANEL, "a state without the conversation part");
    const conversation = {
      available: true,
      consent: "granted",
      conversations: [VIEW],
      active: CONVERSATION,
      agents: [{ agent: "codex", availability: "needs-install" }],
      folders: [{ path: "C:\\work\\invoices", addedAt: NOW }],
    };
    expectAccepted(state, { ...PANEL, conversation }, "a state with the conversation part");
    expectAccepted(
      state,
      { ...PANEL, conversation: { ...conversation, available: false, reason: "broker-unavailable", active: undefined } },
      "an unavailable conversation part with its reason",
    );
    for (const consent of ["unknown", "granted", "withdrawn"]) {
      expectAccepted(state, { ...PANEL, conversation: { ...conversation, consent } }, `consent ${consent}`);
    }
    expectRejected(state, { ...PANEL, conversation: { ...conversation, consent: "maybe" } }, "an unlisted consent");
    expectRejected(state, { ...PANEL, conversation: { ...conversation, extra: 1 } }, "an undeclared conversation field");
  });

  it("forwards a broker event to the panel as a conversation-event message", () => {
    const message = contractSchema("agentPanelMessageSchema");
    const event = { type: "conversation-event", payload: { conversationId: CONVERSATION, seq: 3, event: EVENTS.tool } };
    expectAccepted(message, event, "a conversation-event panel message");
    expectRejected(message, { ...event, payload: { ...event.payload, extra: 1 } }, "an undeclared payload field");
    expectAccepted(message, { type: "worker.agent.state", payload: PANEL }, "the existing state message");
  });
});

describe("T547 worker forwarding additions (R-318, R-323)", () => {
  const frame = () => contractSchema("agentLinkFrameSchema");
  const command = () => contractSchema("agentPanelCommandSchema");
  const message = () => contractSchema("agentPanelMessageSchema");
  const commandFrame = (inner: unknown) => ({ type: "conversation-command", sessionId: SESSION, commandId: "cmd-1", command: inner });
  const page = { type: "worker.conversation.page", payload: { conversationId: CONVERSATION, fromSeq: 12 } };
  const resync = { type: "ui.conversation.resync", payload: { conversationId: CONVERSATION, fromSeq: 12 } };

  it("G1: a panel command may carry the commandId the panel minted; a ui.agent command may not", () => {
    const c = command();
    expectAccepted(c, { type: "ui.conversation.stop", payload: { conversationId: CONVERSATION }, commandId: "p-1" }, "a stop with its commandId");
    expectAccepted(c, { type: "ui.conversation.add-folder", payload: {}, commandId: "p-2" }, "add-folder with its commandId");
    expectRejected(c, { type: "ui.conversation.stop", payload: { conversationId: CONVERSATION }, commandId: "" }, "an empty commandId");
    expectRejected(
      c,
      { type: "ui.conversation.stop", payload: { conversationId: CONVERSATION }, commandId: "x".repeat(129) },
      "a commandId over 128",
    );
    expectRejected(c, { type: "ui.agent.connect", payload: {}, commandId: "p-3" }, "a ui.agent command with a commandId");
    // The worker strips it before forwarding: the frame's command has no commandId of its own.
    expectRejected(
      frame(),
      commandFrame({ type: "ui.conversation.stop", payload: { conversationId: CONVERSATION }, commandId: "p-1" }),
      "a forwarded command still carrying the panel's commandId",
    );
  });

  it("G1: a command's result reaches the panel as a conversation-result message", () => {
    const m = message();
    expectAccepted(m, { type: "conversation-result", payload: { commandId: "p-1", ok: true } }, "a bare success");
    expectAccepted(
      m,
      { type: "conversation-result", payload: { commandId: "p-1", ok: true, value: { conversationId: CONVERSATION } } },
      "a success naming the conversation",
    );
    expectAccepted(
      m,
      { type: "conversation-result", payload: { commandId: "p-1", ok: false, error: { code: "busy", detail: "Still answering." } } },
      "a failure",
    );
    expectRejected(m, { type: "conversation-result", payload: { commandId: "p-1", ok: false } }, "a failure without its error");
    expectRejected(
      m,
      { type: "conversation-result", payload: { commandId: "p-1", ok: true, error: { code: "busy", detail: "x" } } },
      "a success carrying an error",
    );
    expectRejected(m, { type: "conversation-result", payload: { commandId: "p-1", ok: true }, extra: 1 }, "an undeclared field");
  });

  it("G2: an agent's availability may say which install phase is under way", () => {
    const f = frame();
    const overview = (agent: unknown) => ({ type: "conversation-overview", sessionId: SESSION, conversations: [], agents: [agent], folders: [] });
    for (const installing of ["preparing", "downloading", "finishing"]) {
      expectAccepted(f, overview({ agent: "codex", availability: "needs-install", installing }), `installing ${installing}`);
    }
    expectRejected(f, overview({ agent: "codex", availability: "needs-install", installing: "unpacking" }), "an unlisted phase");
    expect(contractExport<readonly string[]>("CONVERSATION_INSTALL_PHASES")).toEqual(["preparing", "downloading", "finishing"]);
  });

  it("the overview may carry the broker's consent record, so a new worker knows it", () => {
    const f = frame();
    const base = { type: "conversation-overview", sessionId: SESSION, conversations: [], agents: [], folders: [] };
    for (const consent of ["unknown", "granted", "withdrawn"]) expectAccepted(f, { ...base, consent }, `consent ${consent}`);
    expectRejected(f, { ...base, consent: "maybe" }, "an unlisted consent");
  });

  it("G4: the worker asks the broker for pages from a seq; the panel cannot send that command", () => {
    expectAccepted(frame(), commandFrame(page), "a worker page request");
    expectRejected(frame(), commandFrame({ ...page, payload: { ...page.payload, fromSeq: -1 } }), "a negative seq");
    expectRejected(frame(), commandFrame({ ...page, payload: { ...page.payload, extra: 1 } }), "an undeclared field");
    expectRejected(command(), page, "a page request from the panel port");
  });

  it("G4: a reconnecting panel names the seq it has, and that never travels to the broker", () => {
    expectAccepted(command(), resync, "a resync from the panel");
    expectRejected(command(), { ...resync, payload: { ...resync.payload, fromSeq: 1.5 } }, "a fractional seq");
    expectRejected(command(), { ...resync, payload: { conversationId: CONVERSATION } }, "a resync without its seq");
    expectRejected(frame(), commandFrame(resync), "a resync forwarded as a broker command");
  });
});

describe("T519 site record author (R-328)", () => {
  const record = { site: "https://example.com", mode: "skip-checks", diagnosticsGranted: false };

  it("accepts changedBy and changedAt, and an old record unchanged", () => {
    const schema = contractSchema("siteModeRecordSchema");
    expectAccepted(schema, record, "a record without the author");
    for (const changedBy of ["panel-agent", "external-agent", "owner"]) {
      expectAccepted(schema, { ...record, changedBy, changedAt: NOW }, `changedBy ${changedBy}`);
    }
    expectAccepted(schema, { ...record, changedBy: "owner" }, "an author without a time");
    expectRejected(schema, { ...record, changedBy: "agent" }, "an unlisted author");
    expectRejected(schema, { ...record, changedBy: "owner", extra: 1 }, "an undeclared field");
  });
});

describe("T563 typed folder path and list notice (R-320, R-323)", () => {
  const command = () => contractSchema("agentPanelCommandSchema");
  const frame = () => contractSchema("agentLinkFrameSchema");
  const state = () => contractSchema("conversationPanelStateSchema");

  it("add-folder opens the dialog with no path, or adds a typed path", () => {
    const c = command();
    expectAccepted(c, { type: "ui.conversation.add-folder", payload: {} }, "the dialog");
    expectAccepted(c, { type: "ui.conversation.add-folder", payload: { path: "C:\work\invoices" } }, "a typed path");
    expectRejected(c, { type: "ui.conversation.add-folder", payload: { path: "" } }, "an empty path");
    expectRejected(c, { type: "ui.conversation.add-folder", payload: { path: "x".repeat(1025) } }, "a path over 1024");
    expectRejected(c, { type: "ui.conversation.add-folder", payload: { path: "C:\a", extra: 1 } }, "an undeclared field");
  });

  it("the overview and the panel state may say the list could not be read, by code only", () => {
    const f = frame();
    const base = { type: "conversation-overview", sessionId: SESSION, conversations: [], agents: [], folders: [] };
    expectAccepted(f, { ...base, notice: "index-unreadable" }, "the index notice");
    expectRejected(f, { ...base, notice: "something-else" }, "an unlisted notice");
    expectRejected(f, { ...base, notice: { code: "index-unreadable", text: "free text" } }, "broker text");
    const s = state();
    const panel = { available: true, consent: "granted", conversations: [], agents: [], folders: [] };
    expectAccepted(s, panel, "no notice");
    expectAccepted(s, { ...panel, notice: "index-unreadable" }, "the index notice");
    expectRejected(s, { ...panel, notice: "other" }, "an unlisted notice");
    expect(contractExport<readonly string[]>("CONVERSATION_LIST_NOTICES")).toEqual(["index-unreadable"]);
  });
});

describe("T572 broker epoch on the panel state (R-318)", () => {
  const state = () => contractSchema("conversationPanelStateSchema");

  it("names which broker the panel's seqs belong to, optionally", () => {
    const s = state();
    const panel = { available: true, consent: "granted", conversations: [], agents: [], folders: [] };
    expectAccepted(s, panel, "no epoch (a broker not yet greeted, or a 0.13.0-preview worker)");
    expectAccepted(s, { ...panel, epoch: "broker-session-1" }, "the attached broker's session");
    expectRejected(s, { ...panel, epoch: "" }, "an empty epoch");
    expectRejected(s, { ...panel, epoch: "x".repeat(129) }, "an epoch over 128");
  });
});

describe("T519 nothing else moved (R-323)", () => {
  it("keeps the link protocol at 2", () => {
    expect(AGENT_LINK_PROTOCOL).toBe(2);
  });

  it("keeps the tool list as it was in 0.12.5", () => {
    const names = contractExport<readonly string[]>("AGENT_TOOL_NAMES");
    // agent-tools.contract.test.ts pins the names; this only guards that 019 added none (FR-292).
    expect(names).toHaveLength(37);
    expect(names.some((name) => name.includes("conversation"))).toBe(false);
  });
});
