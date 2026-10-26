import { describe, expect, it } from "vitest";
import { agentLinkFrameSchema, agentPanelCommandSchema, agentPanelMessageSchema } from "./agent-tools.js";
import * as contracts from "./conversation.js";
import {
  CONVERSATION_ERROR_CODES,
  conversationAgentAvailabilitySchema,
  conversationCommandSchema,
  conversationEventSchema,
  conversationPanelCommandSchema,
  conversationResultFrameSchema,
  conversationViewSchema,
} from "./conversation.js";

/**
 * 022 T612 - the attachment additions to the conversation contracts (contracts/attachments.md,
 * R-337, R-343, R-344): `ui.conversation.attach` / `attach-cancel` in the broker, panel and link
 * unions, `send` with attachment ids, the owner text event's attachments, `accepts` in the
 * projection, and the new error codes.
 */

const CONVERSATION = "c0a8f3d2-6b1e-4d7a-9c2f-0d4e5b6a7c81";
const PIECE_MAX = "A".repeat(699_052);

const firstPiece = {
  conversationId: CONVERSATION,
  attachmentId: "att_1-x",
  index: 0,
  final: true,
  kind: "image",
  name: "error.png",
  size: 3,
  mimeType: "image/png",
  thumbnail: "AAAA",
  data: "AAAA",
};

const attach = (payload: Record<string, unknown>) => ({ type: "ui.conversation.attach", payload });
const send = (payload: Record<string, unknown>) => ({ type: "ui.conversation.send", payload });

describe("022 ui.conversation.attach", () => {
  it("is accepted by the broker, panel and link unions", () => {
    expect(conversationCommandSchema.safeParse(attach(firstPiece)).success).toBe(true);
    expect(conversationPanelCommandSchema.safeParse({ ...attach(firstPiece), commandId: "cmd-1" }).success).toBe(true);
    expect(agentPanelCommandSchema.safeParse({ ...attach(firstPiece), commandId: "cmd-1" }).success).toBe(true);
    expect(
      agentLinkFrameSchema.safeParse({ type: "conversation-command", sessionId: "s-1", commandId: "c-1", command: attach(firstPiece) })
        .success,
    ).toBe(true);
  });

  it("takes a tab's address, title and cut flag on its first piece", () => {
    const { mimeType: _mime, thumbnail: _thumb, ...rest } = firstPiece;
    const tab = { ...rest, kind: "tab", tab: { url: "https://example.test/a", title: "A page", cut: true } };
    expect(conversationCommandSchema.safeParse(attach(tab)).success).toBe(true);
  });

  it("takes a later piece with only its id, index, final and data", () => {
    const later = { conversationId: CONVERSATION, attachmentId: "att_1-x", index: 1, final: false, data: PIECE_MAX };
    expect(conversationCommandSchema.safeParse(attach(later)).success).toBe(true);
  });

  it("refuses a piece over 699 052 base64 characters, or data that is not base64", () => {
    expect(conversationCommandSchema.safeParse(attach({ ...firstPiece, data: `${PIECE_MAX}AAAA` })).success).toBe(false);
    expect(conversationCommandSchema.safeParse(attach({ ...firstPiece, data: "not base64!" })).success).toBe(false);
  });

  it("refuses ids outside [A-Za-z0-9_-]{1,64}, a negative index, an unknown kind and an oversized thumbnail", () => {
    for (const bad of [
      { attachmentId: "..\\x" },
      { attachmentId: "" },
      { attachmentId: "a".repeat(65) },
      { index: -1 },
      { kind: "audio" },
      { thumbnail: "A".repeat(12_004) },
      { name: "" },
      { name: "n".repeat(256) },
      { size: -1 },
    ]) {
      expect(conversationCommandSchema.safeParse(attach({ ...firstPiece, ...bad })).success, JSON.stringify(bad).slice(0, 40)).toBe(false);
    }
  });

  it("refuses first-piece fields on a later piece, and a first piece without its kind, name or size", () => {
    expect(conversationCommandSchema.safeParse(attach({ ...firstPiece, index: 1 })).success).toBe(false);
    const { kind: _kind, ...noKind } = firstPiece;
    expect(conversationCommandSchema.safeParse(attach(noKind)).success).toBe(false);
    const { size: _size, ...noSize } = firstPiece;
    expect(conversationCommandSchema.safeParse(attach(noSize)).success).toBe(false);
  });
});

describe("022 ui.conversation.attach-cancel", () => {
  it("names a conversation and an attachment, in every union", () => {
    const cancel = { type: "ui.conversation.attach-cancel", payload: { conversationId: CONVERSATION, attachmentId: "att_1" } };
    expect(conversationCommandSchema.safeParse(cancel).success).toBe(true);
    expect(agentPanelCommandSchema.safeParse({ ...cancel, commandId: "cmd-2" }).success).toBe(true);
    expect(conversationCommandSchema.safeParse({ ...cancel, payload: { ...cancel.payload, extra: 1 } }).success).toBe(false);
  });
});

describe("022 ui.conversation.send with attachments", () => {
  it("still takes a text-only message exactly as before", () => {
    expect(conversationCommandSchema.safeParse(send({ conversationId: CONVERSATION, text: "hello", activeTabId: 3 })).success).toBe(true);
  });

  it("takes empty text only when attachments are named", () => {
    expect(conversationCommandSchema.safeParse(send({ conversationId: CONVERSATION, text: "", attachments: ["a1"] })).success).toBe(true);
    expect(conversationCommandSchema.safeParse(send({ conversationId: CONVERSATION, text: "" })).success).toBe(false);
    expect(conversationPanelCommandSchema.safeParse({ ...send({ conversationId: CONVERSATION, text: "" }), commandId: "c" }).success).toBe(
      false,
    );
  });

  it("names 1 to 11 attachments", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, index) => `a${index}`);
    expect(conversationCommandSchema.safeParse(send({ conversationId: CONVERSATION, text: "x", attachments: ids(11) })).success).toBe(true);
    expect(conversationCommandSchema.safeParse(send({ conversationId: CONVERSATION, text: "x", attachments: ids(12) })).success).toBe(false);
    expect(conversationCommandSchema.safeParse(send({ conversationId: CONVERSATION, text: "x", attachments: [] })).success).toBe(false);
    expect(conversationCommandSchema.safeParse(send({ conversationId: CONVERSATION, text: "x", attachments: ["a/b"] })).success).toBe(false);
  });
});

describe("022 owner text event attachments", () => {
  const image = { kind: "image", name: "error.png", size: 1200, thumbnail: "AAAA" };
  const file = { kind: "file", name: "data (2).csv", size: 3, path: "C:\\work\\hallpass-attachments\\data (2).csv" };
  const tab = { kind: "tab", name: "A page", cut: true };

  it("carries image, file and tab summaries", () => {
    expect(
      conversationEventSchema.safeParse({ type: "text", role: "owner", text: "why?", attachments: [image, file, tab] }).success,
    ).toBe(true);
  });

  it("may have empty text only when it has attachments", () => {
    expect(conversationEventSchema.safeParse({ type: "text", role: "owner", text: "", attachments: [{ kind: "image", name: "image" }] }).success).toBe(
      true,
    );
    expect(conversationEventSchema.safeParse({ type: "text", role: "owner", text: "", attachments: [] }).success).toBe(false);
  });

  it("refuses attachments on the agent's text, a thumbnail over 12 000 characters and more than 11", () => {
    expect(conversationEventSchema.safeParse({ type: "text", role: "agent", text: "x", attachments: [image] }).success).toBe(false);
    expect(
      conversationEventSchema.safeParse({ type: "text", role: "owner", text: "x", attachments: [{ ...image, thumbnail: "A".repeat(12_004) }] })
        .success,
    ).toBe(false);
    expect(
      conversationEventSchema.safeParse({ type: "text", role: "owner", text: "x", attachments: Array.from({ length: 12 }, () => tab) }).success,
    ).toBe(false);
  });
});

describe("022 accepts in the projection", () => {
  const view = {
    conversationId: CONVERSATION,
    agent: "claude-code",
    title: "Tidy",
    folder: { kind: "scratch" },
    mode: "strict",
    createdAt: "2026-10-21T00:00:00.000Z",
    lastUsedAt: "2026-10-21T00:00:00.000Z",
    resumable: true,
    state: "idle",
  };

  it("is optional on a conversation and on an agent entry", () => {
    expect(conversationViewSchema.safeParse(view).success).toBe(true);
    expect(conversationViewSchema.safeParse({ ...view, accepts: { image: true, context: false } }).success).toBe(true);
    expect(
      conversationAgentAvailabilitySchema.safeParse({ agent: "codex", availability: "ready", accepts: { image: false, context: true } }).success,
    ).toBe(true);
    expect(conversationViewSchema.safeParse({ ...view, accepts: { image: true } }).success).toBe(false);
  });
});

describe("022 error codes", () => {
  const added = [
    "attachment-too-large",
    "attachment-too-many",
    "attachment-type",
    "attachment-order",
    "attachment-unknown",
    "attachment-incomplete",
    "attachment-not-accepted",
    "attachment-folder-gone",
    "attachment-write-failed",
  ];

  it("are accepted in a conversation-result", () => {
    for (const code of added) {
      expect(CONVERSATION_ERROR_CODES).toContain(code);
      expect(
        conversationResultFrameSchema.safeParse({
          type: "conversation-result",
          sessionId: "s",
          commandId: "c",
          ok: false,
          error: { code, detail: "words" },
        }).success,
      ).toBe(true);
    }
  });
});

/**
 * 023 T703 - the additions of contracts/frames.md (R-365, R-367, R-368, R-369): the worker's
 * `conversation-browser-attached`, the notice codes `browser-tools-missing` / `key-env-not-in-browser`
 * on the existing notice event (with the agent and, for the key, a variable *name*), and the panel's
 * `ui.conversation.diagnostics` with its `conversation-diagnostics` reply on the link and to the panel.
 */
describe("023 conversation-browser-attached (worker to broker)", () => {
  const attached = { type: "conversation-browser-attached", sessionId: "s-1", conversationId: CONVERSATION };

  it("is a link frame naming the broker's session and the conversation, nothing else", () => {
    expect(agentLinkFrameSchema.safeParse(attached).success).toBe(true);
    expect(agentLinkFrameSchema.safeParse({ ...attached, token: "x".repeat(43) }).success).toBe(false);
    expect(agentLinkFrameSchema.safeParse({ ...attached, conversationId: "../x" }).success).toBe(false);
  });
});

describe("023 notice codes", () => {
  it("lists browser-tools-missing and key-env-not-in-browser beside the 019 notice", () => {
    expect(contracts.CONVERSATION_NOTICES.slice(0, 3)).toEqual(["sandbox-permissions-declined", "browser-tools-missing", "key-env-not-in-browser"]);
  });

  it("browser-tools-missing names the agent", () => {
    const notice = { type: "notice", code: "browser-tools-missing", text: "", agent: "hermes" };
    expect(conversationEventSchema.safeParse(notice).success).toBe(true);
    expect(conversationEventSchema.safeParse({ ...notice, agent: "other" }).success).toBe(false);
    const { agent: _agent, ...noAgent } = notice;
    expect(conversationEventSchema.safeParse(noAgent).success).toBe(false);
  });

  it("key-env-not-in-browser names the agent and a variable name, never a value", () => {
    const notice = { type: "notice", code: "key-env-not-in-browser", text: "", agent: "hermes", variable: "OPENAI_API_KEY" };
    expect(conversationEventSchema.safeParse(notice).success).toBe(true);
    expect(conversationEventSchema.safeParse({ ...notice, variable: `_${"A".repeat(127)}` }).success).toBe(true);
    for (const variable of ["", "1KEY", "MY-KEY", "KEY=sk-abc", "KEY VALUE", `_${"A".repeat(128)}`]) {
      expect(conversationEventSchema.safeParse({ ...notice, variable }).success, variable.slice(0, 20)).toBe(false);
    }
    const { variable: _variable, ...noVariable } = notice;
    expect(conversationEventSchema.safeParse(noVariable).success).toBe(false);
  });

  it("other notices stay as they were and carry no variable", () => {
    expect(conversationEventSchema.safeParse({ type: "notice", code: "turn-failed", text: "words" }).success).toBe(true);
    expect(conversationEventSchema.safeParse({ type: "notice", code: "turn-failed", text: "words", variable: "KEY" }).success).toBe(false);
  });
});

describe("023 diagnostics", () => {
  const request = { type: "ui.conversation.diagnostics", payload: { conversationId: CONVERSATION } };
  const lines = (count: number, length = 10) => Array.from({ length: count }, () => "x".repeat(length));

  it("the request is a command in the broker, panel and link unions", () => {
    expect(conversationCommandSchema.safeParse(request).success).toBe(true);
    expect(conversationPanelCommandSchema.safeParse({ ...request, commandId: "cmd-1" }).success).toBe(true);
    expect(agentPanelCommandSchema.safeParse({ ...request, commandId: "cmd-1" }).success).toBe(true);
    expect(
      agentLinkFrameSchema.safeParse({ type: "conversation-command", sessionId: "s-1", commandId: "c-1", command: request }).success,
    ).toBe(true);
    expect(conversationCommandSchema.safeParse({ ...request, payload: { conversationId: CONVERSATION, all: true } }).success).toBe(false);
  });

  it("the reply carries at most 50 lines of at most 500 characters, on the link and to the panel", () => {
    const frame = { type: "conversation-diagnostics", sessionId: "s-1", conversationId: CONVERSATION, lines: lines(50, 500) };
    expect(agentLinkFrameSchema.safeParse(frame).success).toBe(true);
    expect(agentLinkFrameSchema.safeParse({ ...frame, lines: [] }).success).toBe(true);
    expect(agentLinkFrameSchema.safeParse({ ...frame, lines: lines(51) }).success).toBe(false);
    expect(agentLinkFrameSchema.safeParse({ ...frame, lines: lines(1, 501) }).success).toBe(false);
    const message = { type: "conversation-diagnostics", payload: { conversationId: CONVERSATION, lines: lines(50, 500) } };
    expect(agentPanelMessageSchema.safeParse(message).success).toBe(true);
    expect(agentPanelMessageSchema.safeParse({ ...message, payload: { ...message.payload, lines: lines(51) } }).success).toBe(false);
    expect((contracts as Record<string, unknown>).CONVERSATION_DIAGNOSTIC_LINES_MAX).toBe(50);
    expect((contracts as Record<string, unknown>).CONVERSATION_DIAGNOSTIC_LINE_MAX_CHARS).toBe(500);
  });
});

/**
 * 024 T739 - the host additions of contracts/frames.md (R-374, R-375, R-377, R-379, R-387): the broker
 * commands `check-agents`, `install-cancel`, `test`, the `{ agent }` form of `diagnostics` with its
 * reply naming `agent` and `readAt`, and the optional overview fields on an agent's availability.
 */
describe("024 broker commands", () => {
  const link = (command: Record<string, unknown>) =>
    agentLinkFrameSchema.safeParse({ type: "conversation-command", sessionId: "s-1", commandId: "c-1", command }).success;

  it("check-agents names one agent or none", () => {
    for (const payload of [{}, { agent: "hermes" }]) {
      const command = { type: "ui.conversation.check-agents", payload };
      expect(conversationCommandSchema.safeParse(command).success).toBe(true);
      expect(link(command)).toBe(true);
    }
    expect(conversationCommandSchema.safeParse({ type: "ui.conversation.check-agents", payload: { agent: "other" } }).success).toBe(false);
    expect(conversationCommandSchema.safeParse({ type: "ui.conversation.check-agents", payload: { all: true } }).success).toBe(false);
  });

  it("install-cancel and test name exactly one agent", () => {
    for (const type of ["ui.conversation.install-cancel", "ui.conversation.test"]) {
      expect(conversationCommandSchema.safeParse({ type, payload: { agent: "codex" } }).success, type).toBe(true);
      expect(link({ type, payload: { agent: "codex" } }), type).toBe(true);
      expect(conversationCommandSchema.safeParse({ type, payload: {} }).success, type).toBe(false);
      expect(conversationCommandSchema.safeParse({ type, payload: { agent: "codex", extra: 1 } }).success, type).toBe(false);
    }
  });

  it("diagnostics takes { agent } as the alternative to { conversationId }, never both", () => {
    const diagnostics = (payload: Record<string, unknown>) => ({ type: "ui.conversation.diagnostics", payload });
    expect(conversationCommandSchema.safeParse(diagnostics({ agent: "deepseek" })).success).toBe(true);
    expect(link(diagnostics({ agent: "deepseek" }))).toBe(true);
    expect(conversationCommandSchema.safeParse(diagnostics({ conversationId: CONVERSATION })).success).toBe(true);
    expect(conversationCommandSchema.safeParse(diagnostics({ agent: "deepseek", conversationId: CONVERSATION })).success).toBe(false);
    expect(conversationCommandSchema.safeParse(diagnostics({})).success).toBe(false);
  });

  it("the new commands are not panel commands", () => {
    for (const type of ["ui.conversation.check-agents", "ui.conversation.install-cancel", "ui.conversation.test"]) {
      expect(agentPanelCommandSchema.safeParse({ type, payload: { agent: "codex" }, commandId: "c" }).success, type).toBe(false);
    }
  });
});

describe("024 diagnostics reply by agent", () => {
  const frame = { type: "conversation-diagnostics", sessionId: "s-1", agent: "hermes", readAt: "2026-10-24T00:00:00.000Z", lines: ["x"] };

  it("names the agent and when it was read, with or without the run's conversation", () => {
    expect(agentLinkFrameSchema.safeParse(frame).success).toBe(true);
    expect(agentLinkFrameSchema.safeParse({ ...frame, conversationId: CONVERSATION }).success).toBe(true);
    expect(contracts.conversationDiagnosticsFrameSchema.safeParse(frame).success).toBe(true);
  });

  it("an agent reply always carries readAt, and the 023 form still parses", () => {
    const { readAt: _readAt, ...noReadAt } = frame;
    expect(agentLinkFrameSchema.safeParse(noReadAt).success).toBe(false);
    expect(agentLinkFrameSchema.safeParse({ type: "conversation-diagnostics", sessionId: "s-1", conversationId: CONVERSATION, lines: [] }).success).toBe(
      true,
    );
    expect(agentLinkFrameSchema.safeParse({ type: "conversation-diagnostics", sessionId: "s-1", lines: [] }).success).toBe(false);
  });
});

describe("024 overview fields on an agent's availability", () => {
  const base = { agent: "hermes", availability: "ready" };
  const parse = (extra: Record<string, unknown>) => conversationAgentAvailabilitySchema.safeParse({ ...base, ...extra }).success;
  const install = { phase: "downloading", percent: 40, etaSeconds: 12, startedAt: "2026-10-24T00:00:00.000Z", browserId: "b-12345678" };
  const lastTest = {
    outcome: "partial",
    start: "ok",
    model: { answered: true, ms: 1200 },
    browserTools: "missing-component",
    keyHint: "OPENAI_API_KEY",
    ranAt: "2026-10-24T00:00:00.000Z",
  };

  it("still parses an entry without any of them", () => {
    expect(parse({})).toBe(true);
  });

  it("takes checkedAt, a version of at most 64 characters, browserTools and testing", () => {
    expect(parse({ checkedAt: "2026-10-24T00:00:00.000Z", version: "v".repeat(64), browserTools: "needs-helper", testing: true })).toBe(true);
    expect(parse({ version: "v".repeat(65) })).toBe(false);
    for (const browserTools of ["available", "needs-helper", "missing-component", "not-supported"]) expect(parse({ browserTools })).toBe(true);
    expect(parse({ browserTools: "maybe" })).toBe(false);
  });

  it("takes versionTimedOut (R-374: a found program's --version missed the readiness bound), a boolean only", () => {
    expect(parse({ availability: "version-problem", versionTimedOut: true })).toBe(true);
    expect(parse({ versionTimedOut: false })).toBe(true);
    expect(parse({ versionTimedOut: "yes" })).toBe(false);
  });

  it("takes Hermes' setup steps, and only Hermes'", () => {
    const setupSteps = ["git", "hermes", "mcp-component", "key-variable", "browser-restart"].map((step) => ({ step, found: step !== "git" }));
    expect(parse({ setupSteps })).toBe(true);
    expect(parse({ setupSteps: [{ step: "python", found: true }] })).toBe(false);
    expect(conversationAgentAvailabilitySchema.safeParse({ agent: "codex", availability: "ready", setupSteps }).success).toBe(false);
  });

  it("takes an install state without its pid, every phase including interrupted, null percent and time left", () => {
    expect(parse({ install })).toBe(true);
    for (const phase of ["preparing", "downloading", "finishing", "done", "failed", "cancelled", "interrupted"]) {
      expect(parse({ install: { ...install, phase, percent: null, etaSeconds: null } }), phase).toBe(true);
    }
    expect(parse({ install: { ...install, pid: 4242 } })).toBe(false);
    expect(parse({ install: { ...install, phase: "paused" } })).toBe(false);
    expect(parse({ install: { ...install, percent: 100 } })).toBe(false);
    expect(parse({ install: { ...install, phase: "done", percent: 100, endedAt: "2026-10-24T00:01:00.000Z" } })).toBe(true);
    expect(parse({ install: { ...install, phase: "failed", error: "The download stopped." } })).toBe(true);
  });

  it("the host's file form of an install state carries the pid", () => {
    expect(contracts.agentInstallStateFileSchema.safeParse({ ...install, pid: 4242 }).success).toBe(true);
    expect(contracts.agentInstallStateFileSchema.safeParse(install).success).toBe(false);
  });

  it("takes the last test, and refuses one that keeps more than the data model names", () => {
    expect(parse({ lastTest })).toBe(true);
    expect(parse({ lastTest: { ...lastTest, outcome: "failed", start: "agent-missing", model: { answered: false, reason: "not started" } } })).toBe(
      true,
    );
    expect(parse({ lastTest: { ...lastTest, answer: "OK" } })).toBe(false);
    expect(parse({ lastTest: { ...lastTest, keyHint: "KEY=sk-abc" } })).toBe(false);
    expect(parse({ lastTest: { ...lastTest, start: "crashed" } })).toBe(false);
    expect(contracts.agentTestResultSchema.safeParse(lastTest).success).toBe(true);
  });
});

/**
 * 025 T798 - the model picker's additions (contracts/frames.md, data-model.md, R-398 - R-402): the
 * offer and its entries, the choice, the live state, `model` on start, `ui.conversation.set-model`,
 * the `model` event and the optional fields on availability, view and index entry.
 */
describe("025 model picker contracts", () => {
  const entry = { value: "alpha", name: "Alpha", description: "Fast" };
  const configOffer = {
    source: "config",
    configIds: { model: "model", effort: "effort" },
    models: [{ value: "default", name: "Default" }, entry],
    efforts: [{ value: "low", name: "Low" }],
    defaultModel: "default",
    defaultEffort: "low",
  };
  const modelsOffer = { source: "models", models: [entry], efforts: [] };
  const offerOk = (value: unknown) => contracts.conversationModelOfferSchema.safeParse(value).success;
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ value: `v${i}`, name: `N${i}` }));

  it("takes a model entry with an optional description and refuses every bound", () => {
    const ok = (value: unknown) => contracts.conversationModelEntrySchema.safeParse(value).success;
    expect(ok(entry)).toBe(true);
    expect(ok({ value: "alpha", name: "Alpha" })).toBe(true);
    expect(ok({ value: "", name: "Alpha" })).toBe(false);
    expect(ok({ value: "v".repeat(513), name: "Alpha" })).toBe(false);
    expect(ok({ value: "v".repeat(512), name: "n".repeat(120), description: "d".repeat(300) })).toBe(true);
    expect(ok({ value: "alpha", name: "" })).toBe(false);
    expect(ok({ value: "alpha", name: "n".repeat(121) })).toBe(false);
    expect(ok({ value: "alpha", name: "Alpha", description: "" })).toBe(false);
    expect(ok({ value: "alpha", name: "Alpha", description: "d".repeat(301) })).toBe(false);
    expect(ok({ ...entry, extra: 1 })).toBe(false);
  });

  it("takes an offer from the session options or from the older list, and one that reports none", () => {
    expect(offerOk(configOffer)).toBe(true);
    expect(offerOk({ source: "config", configIds: { model: "model" }, models: [entry], efforts: [] })).toBe(true);
    expect(offerOk(modelsOffer)).toBe(true);
    expect(offerOk({ source: "models", models: [], efforts: [] })).toBe(true);
    expect(offerOk({ ...modelsOffer, defaultModel: "alpha" })).toBe(true);
  });

  it("keeps configIds for the session options only, and no efforts for the older list", () => {
    expect(offerOk({ ...configOffer, configIds: undefined })).toBe(false);
    expect(offerOk({ ...modelsOffer, configIds: { model: "model" } })).toBe(false);
    expect(offerOk({ ...modelsOffer, efforts: [{ value: "low", name: "Low" }] })).toBe(false);
    expect(offerOk({ ...configOffer, source: "other" })).toBe(false);
  });

  it("names defaults that are listed values", () => {
    expect(offerOk({ ...configOffer, defaultModel: "gamma" })).toBe(false);
    expect(offerOk({ ...configOffer, defaultEffort: "high" })).toBe(false);
    expect(offerOk({ ...modelsOffer, defaultModel: "gamma" })).toBe(false);
    expect(offerOk({ ...modelsOffer, defaultEffort: "low" })).toBe(false);
  });

  it("bounds the lists at 64 models and 16 efforts, and the option ids", () => {
    expect(offerOk({ ...modelsOffer, models: many(64) })).toBe(true);
    expect(offerOk({ ...modelsOffer, models: many(65) })).toBe(false);
    expect(offerOk({ source: "config", configIds: { model: "m", effort: "e" }, models: [], efforts: many(16) })).toBe(true);
    expect(offerOk({ source: "config", configIds: { model: "m", effort: "e" }, models: [], efforts: many(17) })).toBe(false);
    expect(offerOk({ ...configOffer, configIds: { model: "" } })).toBe(false);
    expect(offerOk({ ...configOffer, extra: 1 })).toBe(false);
  });

  it("takes a choice of values and refuses anything else", () => {
    const ok = (value: unknown) => contracts.conversationModelChoiceSchema.safeParse(value).success;
    expect(ok({ model: "alpha" })).toBe(true);
    expect(ok({ model: "alpha", effort: "low" })).toBe(true);
    expect(ok({ model: "v".repeat(512), effort: "e".repeat(512) })).toBe(true);
    expect(ok({ model: "" })).toBe(false);
    expect(ok({ model: "v".repeat(513) })).toBe(false);
    expect(ok({ effort: "low" })).toBe(false);
    expect(ok({ model: "alpha", effort: "" })).toBe(false);
    expect(ok({ model: "alpha", name: "Alpha" })).toBe(false);
  });

  it("takes the live state as an offer with what the agent last reported, under the offer's own rules", () => {
    const ok = (value: unknown) => contracts.conversationModelStateSchema.safeParse(value).success;
    expect(ok({ ...configOffer, current: { model: "alpha", effort: "low" } })).toBe(true);
    expect(ok({ ...modelsOffer, current: { model: "alpha" } })).toBe(true);
    expect(ok(configOffer)).toBe(false);
    expect(ok({ ...configOffer, current: { effort: "low" } })).toBe(false);
    expect(ok({ ...modelsOffer, defaultModel: "gamma", current: { model: "alpha" } })).toBe(false);
    expect(ok({ ...modelsOffer, current: { model: "alpha" }, extra: 1 })).toBe(false);
  });

  describe("ui.conversation.start", () => {
    const start = (payload: Record<string, unknown>) => ({ type: "ui.conversation.start", payload });
    const base = { agent: "claude-code", folder: { kind: "scratch" } };

    it("takes the chip's choice, and still starts without one", () => {
      expect(conversationCommandSchema.safeParse(start(base)).success).toBe(true);
      expect(conversationCommandSchema.safeParse(start({ ...base, model: { model: "alpha", effort: "low" } })).success).toBe(true);
      expect(conversationPanelCommandSchema.safeParse({ ...start({ ...base, model: { model: "alpha" } }), commandId: "c-1" }).success).toBe(true);
      expect(agentPanelCommandSchema.safeParse({ ...start({ ...base, model: { model: "alpha" } }), commandId: "c-1" }).success).toBe(true);
    });

    it("takes an effort alone, as set-model does", () => {
      expect(conversationCommandSchema.safeParse(start({ ...base, model: { effort: "high" } })).success).toBe(true);
      expect(conversationPanelCommandSchema.safeParse({ ...start({ ...base, model: { effort: "high" } }), commandId: "c-1" }).success).toBe(true);
      expect(agentPanelCommandSchema.safeParse({ ...start({ ...base, model: { effort: "high" } }), commandId: "c-1" }).success).toBe(true);
    });

    it("refuses a choice that is not values", () => {
      expect(conversationCommandSchema.safeParse(start({ ...base, model: {} })).success).toBe(false);
      expect(conversationCommandSchema.safeParse(start({ ...base, model: { model: "alpha", name: "Alpha" } })).success).toBe(false);
      expect(conversationCommandSchema.safeParse(start({ ...base, model: "alpha" })).success).toBe(false);
    });
  });

  describe("ui.conversation.set-model", () => {
    const setModel = (payload: Record<string, unknown>) => ({ type: "ui.conversation.set-model", payload });
    const okIn = (schema: { safeParse(value: unknown): { success: boolean } }, payload: Record<string, unknown>) =>
      schema.safeParse(setModel(payload)).success;

    it("takes a model, an effort or both, in the broker and panel unions and on the link", () => {
      for (const part of [{ model: "alpha" }, { effort: "low" }, { model: "alpha", effort: "low" }]) {
        const payload = { conversationId: CONVERSATION, ...part };
        expect(okIn(conversationCommandSchema, payload), JSON.stringify(part)).toBe(true);
        expect(conversationPanelCommandSchema.safeParse({ ...setModel(payload), commandId: "c-1" }).success).toBe(true);
        expect(conversationPanelCommandSchema.safeParse(setModel(payload)).success).toBe(true);
        expect(agentPanelCommandSchema.safeParse({ ...setModel(payload), commandId: "c-1" }).success).toBe(true);
        expect(
          agentLinkFrameSchema.safeParse({ type: "conversation-command", sessionId: "s-1", commandId: "c-1", command: setModel(payload) }).success,
        ).toBe(true);
      }
    });

    it("needs at least one of model and effort, and nothing else", () => {
      expect(okIn(conversationCommandSchema, { conversationId: CONVERSATION })).toBe(false);
      expect(okIn(conversationPanelCommandSchema, { conversationId: CONVERSATION })).toBe(false);
      expect(okIn(conversationCommandSchema, { conversationId: CONVERSATION, model: "" })).toBe(false);
      expect(okIn(conversationCommandSchema, { conversationId: CONVERSATION, model: "v".repeat(513) })).toBe(false);
      expect(okIn(conversationCommandSchema, { conversationId: "nope", model: "alpha" })).toBe(false);
      expect(okIn(conversationCommandSchema, { conversationId: CONVERSATION, model: "alpha", mode: "strict" })).toBe(false);
    });
  });

  describe("the model event", () => {
    const ok = (event: Record<string, unknown>) => conversationEventSchema.safeParse({ type: "model", ...event }).success;

    it("names the model, the effort and whether the effort moved", () => {
      expect(ok({ model: "Alpha" })).toBe(true);
      expect(ok({ model: "Alpha", effort: "Low" })).toBe(true);
      expect(ok({ model: "Alpha", effort: "Low", effortChanged: true })).toBe(true);
      expect(ok({ model: "Alpha", effortChanged: false })).toBe(false);
      expect(ok({})).toBe(false);
      expect(ok({ model: "" })).toBe(false);
      expect(ok({ model: "n".repeat(121) })).toBe(false);
      expect(ok({ model: "Alpha", effort: "e".repeat(121) })).toBe(false);
      expect(ok({ model: "Alpha", value: "alpha" })).toBe(false);
    });
  });

  describe("availability, view and entry", () => {
    const view = {
      conversationId: CONVERSATION,
      agent: "claude-code",
      title: "Tidy",
      folder: { kind: "scratch" },
      mode: "strict",
      createdAt: "2026-10-26T00:00:00.000Z",
      lastUsedAt: "2026-10-26T00:00:00.000Z",
      resumable: true,
      state: "idle",
    };
    const { state: _state, ...viewFields } = view;
    const indexEntry = { ...viewFields, agentSessionId: "sess-1" };

    it("carries the remembered offer and the last choice on an agent entry", () => {
      const agent = { agent: "claude-code", availability: "ready" };
      const ok = (extra: Record<string, unknown>) => conversationAgentAvailabilitySchema.safeParse({ ...agent, ...extra }).success;
      expect(ok({})).toBe(true);
      expect(ok({ models: { offer: configOffer } })).toBe(true);
      expect(ok({ models: { offer: configOffer, choice: { model: "alpha", effort: "low" } } })).toBe(true);
      expect(ok({ models: { choice: { model: "alpha" } } })).toBe(false);
      expect(ok({ models: { offer: configOffer, current: { model: "alpha" } } })).toBe(false);
      expect(ok({ models: { offer: { ...configOffer, defaultModel: "gamma" } } })).toBe(false);
    });

    it("carries the live state or the stored choice on a view", () => {
      const ok = (extra: Record<string, unknown>) => conversationViewSchema.safeParse({ ...view, ...extra }).success;
      expect(ok({})).toBe(true);
      expect(ok({ models: { ...configOffer, current: { model: "alpha", effort: "low" } } })).toBe(true);
      expect(ok({ model: { model: "alpha", effort: "low" } })).toBe(true);
      expect(ok({ models: configOffer })).toBe(false);
      expect(ok({ model: { effort: "low" } })).toBe(false);
    });

    it("carries the choice on an index entry", () => {
      const ok = (extra: Record<string, unknown>) => contracts.conversationEntrySchema.safeParse({ ...indexEntry, ...extra }).success;
      expect(ok({})).toBe(true);
      expect(ok({ model: { model: "alpha" } })).toBe(true);
      expect(ok({ model: { model: "alpha", effort: "low" } })).toBe(true);
      expect(ok({ model: { effort: "low" } })).toBe(false);
      expect(ok({ model: "alpha" })).toBe(false);
    });
  });

  it("answers model-unknown and model-refused", () => {
    for (const code of ["model-unknown", "model-refused"]) {
      expect(CONVERSATION_ERROR_CODES).toContain(code);
      expect(
        conversationResultFrameSchema.safeParse({
          type: "conversation-result",
          sessionId: "s-1",
          commandId: "c-1",
          ok: false,
          error: { code, detail: "The agent said no." },
        }).success,
        code,
      ).toBe(true);
    }
  });

  it("names the two notices", () => {
    expect(contracts.CONVERSATION_NOTICES).toEqual(expect.arrayContaining(["model-refused", "model-unavailable"]));
  });
});
