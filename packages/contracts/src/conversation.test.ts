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
    expect(contracts.CONVERSATION_NOTICES).toEqual(["sandbox-permissions-declined", "browser-tools-missing", "key-env-not-in-browser"]);
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
