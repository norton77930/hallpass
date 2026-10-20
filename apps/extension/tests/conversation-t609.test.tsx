import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConversationError, ConversationPanelState } from "@hallpass/contracts";
import { lookup } from "../src/locales/catalog.js";
import { installAgentPort, project, renderShell, uninstallAgentPort, type FakeAgentPort } from "./helpers/agent-shell-harness.js";
import { CONVERSATION_OPEN, CONVERSATION_READY, emitEvent, installTabStorage, lastCommandId, withConversation } from "./helpers/conversation-fixtures.js";

/**
 * 020/T609 - the broker's remaining English in the Conversation tab (N3, R1, the sweep) and the
 * backticks in a permission answer's line (V6). Every sentence the broker builds from a fixed
 * template is either said from the locale, its variable part kept as a value, or left out when it
 * only repeats the title; the agent's own words stay as sent.
 */

type Locale = "en-US" | "zh-TW";
const LOCALES: readonly Locale[] = ["en-US", "zh-TW"];

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};
const box = () => document.querySelector<HTMLTextAreaElement>(".agent-conversation-composer textarea")!;
const notice = () => document.querySelector<HTMLElement>(".agent-conversation-notice")!;
const detailOf = (element: HTMLElement) => element.querySelector(".agent-conversation-detail")?.textContent;

const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/side-panel/agent/agent.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rule = (selector: string): string => {
  let declarations = "";
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if ((match[1] ?? "").split(",").some((part) => part.trim() === selector)) declarations += `${match[2] ?? ""};`;
  }
  return declarations;
};

describe("N1 the composer's chips stay on one row", () => {
  // Measured on the R4 sheets at about 400 px: agent + folder + mode chips and Send need ~405 px in
  // en-US, so the row wrapped to two. The folder chip is the one that gives way, with an ellipsis.
  it("does not wrap the chip row", () => {
    expect(rule(".agent-conversation-chips")).not.toMatch(/flex-wrap:\s*wrap/);
    expect(rule(".agent-conversation-chips")).toMatch(/min-width:\s*0/);
  });

  it("lets only the folder chip shrink, ending in an ellipsis", () => {
    const folder = rule('.agent-shell .agent-conversation-chip[data-chip="folder"]');
    expect(folder).toMatch(/flex:\s*0 1 auto/);
    expect(folder).toMatch(/min-width:\s*0/);
    expect(folder).toMatch(/overflow:\s*hidden/);
    expect(rule(".agent-conversation-chip-text")).toMatch(/text-overflow:\s*ellipsis/);
    // The agent and mode chips keep their size.
    expect(rule(".agent-shell .agent-conversation-chip")).toMatch(/flex:\s*0 0 auto/);
    expect(rule('.agent-shell .agent-conversation-chip[data-chip="agent"]')).not.toMatch(/flex:\s*0 1/);
    expect(rule('.agent-shell .agent-conversation-chip[data-chip="mode"]')).not.toMatch(/flex:\s*0 1/);
  });

  // The folder chip's title already carries the whole path (conversation-t607.test.tsx, A1).
});

describe("T609 the Conversation tab", () => {
  let port: FakeAgentPort;

  beforeEach(() => {
    port = installAgentPort();
    installTabStorage();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  async function open(conversation: ConversationPanelState, locale: Locale = "en-US") {
    renderShell(locale);
    project(port, withConversation(conversation));
    await settle();
  }

  /** Sends a first message from the empty conversation and has the worker refuse it with `error`. */
  async function refuse(error: ConversationError, locale: Locale = "en-US") {
    await open(CONVERSATION_READY, locale);
    fireEvent.change(box(), { target: { value: "hello" } });
    fireEvent.click(document.querySelector<HTMLButtonElement>(".agent-conversation-composer button[type=submit]")!);
    const commandId = lastCommandId(port);
    act(() => {
      port.emit({ type: "conversation-result", payload: { commandId, ok: false, error } });
    });
  }

  describe("N3 a conversation the agent no longer has", () => {
    it.each(LOCALES)("in %s says it in the panel's words, the agent kept as a value", async (locale) => {
      await refuse({ code: "cannot-resume", detail: "Claude Code no longer has this conversation." }, locale);
      expect(notice().querySelector("p")?.textContent).toBe(lookup("conversation.error.cannot-resume", locale));
      expect(detailOf(notice())).toBe(lookup("conversation.detail.noLongerHas", locale).replace("{agent}", "Claude Code"));
      if (locale === "zh-TW") expect(notice().textContent).not.toContain("no longer has this conversation");
    });

    it("keeps what the agent itself said when it could not continue", async () => {
      await refuse({ code: "cannot-resume", detail: "Codex could not continue this conversation: session file is corrupt" });
      expect(detailOf(notice())).toBe("Codex could not continue this conversation: session file is corrupt");
    });
  });

  describe("R1 three agents already busy", () => {
    it.each(LOCALES)("in %s is the title and the button, without the broker's repeat of the title", async (locale) => {
      await refuse(
        { code: "too-many-running", detail: "3 conversations are already running or waiting for you; stop one or answer its card first." },
        locale,
      );
      expect(notice().querySelector("p")?.textContent).toBe(lookup("conversation.error.too-many-running", locale));
      expect(notice().querySelector(".agent-conversation-detail")).toBeNull();
      expect(notice().querySelector("button")?.textContent).toBe(lookup("conversation.error.openList", locale));
    });
  });

  describe("the sweep: a refusal's detail the broker builds from a template", () => {
    // [code, the broker's detail, the locale key it is said with (undefined: left out), the values]
    const SAID: readonly (readonly [ConversationError["code"], string, string | undefined, Record<string, string>])[] = [
      ["cannot-resume", "The agent can no longer continue this conversation.", undefined, {}],
      ["folder-missing", "That folder is not in your folder list.", "conversation.detail.folderNotListed", {}],
      ["folder-missing", "The folder D:\\work\\api does not exist any more.", "conversation.detail.folderGone", { path: "D:\\work\\api" }],
      [
        "folder-missing",
        "The folder D:\\work\\api does not exist any more, so this conversation cannot continue.",
        "conversation.detail.folderGone",
        { path: "D:\\work\\api" },
      ],
      ["folder-missing", "This conversation's scratch folder was deleted, so it cannot continue.", undefined, {}],
      ["folder-missing", "The conversation's scratch folder could not be created.", "conversation.detail.scratchFailed", {}],
      ["agent-missing", "Codex was not found on this computer. Install it, sign in once, then try again.", undefined, {}],
      ["agent-missing", "Codex was not found on this computer; install it first.", undefined, {}],
      ["agent-version", "Claude Code was found, but `--version` did not print a version number.", "conversation.version.unreadable", { agent: "Claude Code" }],
      ["agent-version", "The agent did not change its mode: request timed out", "conversation.detail.modeNotChanged", { reason: "request timed out" }],
      ["agent-exited", "The agent did not change its mode: the agent exited (exit 3)", "conversation.detail.modeNotChanged", { reason: "the agent exited (exit 3)" }],
      ["install-needed", "The Codex connector has not been downloaded yet.", undefined, {}],
      ["install-needed", "The Codex connector needs to be downloaded again: ENOENT", "conversation.detail.redownload", { reason: "ENOENT" }],
      ["consent-needed", "Hallpass needs your one-time consent before it starts an agent or downloads its connector.", undefined, {}],
      [
        "consent-needed",
        "You withdrew the side-panel agent's access to this browser; the agent was not started.",
        "conversation.detail.consentWithdrawn",
        {},
      ],
      ["broker-unavailable", "Hallpass is shutting down.", "conversation.detail.shuttingDown", {}],
      ["broker-unavailable", "Hallpass could not continue this conversation.", "conversation.detail.cannotContinue", {}],
      ["broker-unavailable", "Hallpass could not save your answer.", "conversation.detail.answerNotSaved", {}],
      ["broker-unavailable", "Hallpass could not carry this out.", "conversation.detail.notCarriedOut", {}],
      ["broker-unavailable", "The folder dialog was left open too long and was closed; open it again.", "conversation.detail.dialogTimedOut", {}],
      ["broker-unavailable", "The folder dialog could not open.", "conversation.detail.dialogFailed", {}],
      ["broker-unavailable", "The folder dialog could not open (exit 1).", "conversation.detail.dialogExit", { code: "1" }],
      ["broker-unavailable", "The folder dialog could not start: spawn powershell ENOENT", "conversation.detail.dialogStart", { reason: "spawn powershell ENOENT" }],
      ["agent-exited", "Codex the agent exited (exit 1) while starting.", "conversation.notice.agent-exited.exit", { code: "1" }],
      ["agent-exited", "Codex the agent exited while starting.", undefined, {}],
      ["agent-exited", "The agent is not running.", undefined, {}],
      ["agent-exited", "The agent is not running; it starts in strict mode when the conversation continues.", undefined, {}],
      ["agent-exited", "The agent that asked is no longer running.", undefined, {}],
      ["busy", "The agent of this conversation is already running.", undefined, {}],
      ["busy", "The agent is still answering; stop it or wait for the end of its turn.", undefined, {}],
      ["busy", "The agent is still answering; stop it or wait for the end of its turn, then switch the mode.", undefined, {}],
      ["busy", "The agent of this conversation is still starting; send again in a moment.", "conversation.detail.starting", {}],
      ["busy", "The conversation is already switching its mode; try again in a moment.", "conversation.detail.switching", {}],
      ["in-use-elsewhere", "This conversation is running in another browser.", undefined, {}],
      ["not-found", "This conversation is not in the list any more.", undefined, {}],
    ];

    it.each(LOCALES.flatMap((locale) => SAID.map((row) => [locale, ...row] as const)))(
      "in %s: %s - %s",
      async (locale, code, detail, key, values) => {
        await refuse({ code, detail }, locale);
        expect(notice().querySelector("p")?.textContent).toBe(lookup(`conversation.error.${code}`, locale));
        if (key === undefined) {
          expect(notice().querySelector(".agent-conversation-detail")).toBeNull();
          return;
        }
        let said = lookup(key, locale);
        for (const [name, value] of Object.entries(values)) said = said.replace(`{${name}}`, () => value);
        expect(detailOf(notice())).toBe(said);
        expect(said).not.toContain("{");
      },
    );

    it.each([
      ["agent-version", "Tested with Codex 0.50.0, found 0.49.0. The agent said (session/new): unsupported protocol"],
      ["agent-missing", "Codex was not found (tested with Codex 0.50.0). The agent gave no reason at initialize."],
      ["install-failed", "npm ci failed (exit 1): errno -4048"],
      ["busy", "A sentence the panel has no words for"],
    ] as const)("keeps what the agent or the tool said as sent: %s", async (code, detail) => {
      await refuse({ code, detail });
      expect(detailOf(notice()) ?? notice().textContent).toContain(detail);
    });
  });

  describe("the sweep: a notice in the conversation", () => {
    const log = () => screen.getByRole("log");
    const said = (locale: Locale, key: string, reason?: string) => {
      const words = lookup(key, locale);
      return reason === undefined ? words : words.replace("{reason}", () => reason);
    };

    it.each(LOCALES)("in %s says no-once-option, mode-reload-failed and mode-reset-failed in the panel's words", async (locale) => {
      await open(CONVERSATION_OPEN, locale);
      emitEvent(port, 1, {
        type: "notice",
        code: "no-once-option",
        text: "The agent offered no one-time answer for this; Hallpass declined rather than answer for always.",
      });
      emitEvent(port, 2, {
        type: "notice",
        code: "mode-reload-failed",
        text: "Hallpass could not reload the conversation in the new mode (the agent exited (exit 2)); the agent was stopped.",
      });
      emitEvent(port, 3, {
        type: "notice",
        code: "mode-reset-failed",
        text: "Hallpass could not set the mode back (request timed out); the agent was stopped.",
      });
      const text = (code: string) => log().querySelector(`[data-notice-code='${code}']`)?.textContent;
      expect(text("no-once-option")).toBe(said(locale, "conversation.notice.no-once-option"));
      expect(text("mode-reload-failed")).toBe(said(locale, "conversation.notice.mode-reload-failed", "the agent exited (exit 2)"));
      expect(text("mode-reset-failed")).toBe(said(locale, "conversation.notice.mode-reset-failed", "request timed out"));
    });

    it.each(LOCALES)("in %s says why a turn ended early, the agent's stop reason kept as a value", async (locale) => {
      await open(CONVERSATION_OPEN, locale);
      emitEvent(port, 1, { type: "notice", code: "stop-max_tokens", text: "The agent ended its turn: max_tokens." });
      expect(log().querySelector("[data-notice-code='stop-max_tokens']")?.textContent).toBe(said(locale, "conversation.notice.turn-ended", "max_tokens"));
    });

    it("leaves a notice the panel has no words for as the broker sent it", async () => {
      await open(CONVERSATION_OPEN);
      emitEvent(port, 1, { type: "notice", code: "reconnecting", text: "Continuing the conversation" });
      expect(log().querySelector("[data-notice-code='reconnecting']")?.textContent).toBe("Continuing the conversation");
    });

    it("says a notice that is an error code with the same words as a refusal", async () => {
      await open(CONVERSATION_OPEN, "zh-TW");
      emitEvent(port, 1, { type: "notice", code: "cannot-resume", text: "Claude Code no longer has this conversation." });
      const element = log().querySelector<HTMLElement>("[data-notice-code='cannot-resume']")!;
      expect(detailOf(element)).toBe(lookup("conversation.detail.noLongerHas", "zh-TW").replace("{agent}", "Claude Code"));
    });
  });

  describe("V6 a permission answer's line", () => {
    it.each(["reject", "cancelled", "allow-once"] as const)("shows the backtick span of the title as code after %s", async (answer) => {
      await open(CONVERSATION_OPEN);
      emitEvent(port, 1, { type: "permission", requestId: "r-1", toolCallId: "t-9", kind: "execute", title: "Run `npm test`", detail: "" });
      emitEvent(port, 2, { type: "permission-closed", requestId: "r-1", answer });

      const line = document.querySelector<HTMLElement>(".agent-conversation-answer")!;
      expect(line.querySelector("code")?.textContent).toBe("npm test");
      expect(line.textContent).toBe(lookup(`conversation.answered.${answer}`, "en-US").replace("{title}", "Run npm test"));
      expect(line.textContent).not.toContain("`");
    });

    it("keeps a title without backticks, and one whose backticks do not pair up, as written", async () => {
      await open(CONVERSATION_OPEN);
      emitEvent(port, 1, { type: "permission", requestId: "r-1", toolCallId: "t-9", kind: "edit", title: "Write table.csv", detail: "" });
      emitEvent(port, 2, { type: "permission-closed", requestId: "r-1", answer: "reject" });
      emitEvent(port, 3, { type: "permission", requestId: "r-2", toolCallId: "t-10", kind: "execute", title: "Run `npm", detail: "" });
      emitEvent(port, 4, { type: "permission-closed", requestId: "r-2", answer: "reject" });

      const lines = [...document.querySelectorAll<HTMLElement>(".agent-conversation-answer")];
      expect(lines).toHaveLength(2);
      expect(lines[0]?.querySelector("code")).toBeNull();
      expect(lines[1]?.textContent).toBe(lookup("conversation.answered.reject", "en-US").replace("{title}", "Run `npm"));
    });
  });
});
