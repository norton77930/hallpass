import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConversationPanelState } from "@hallpass/contracts";
import { lookup } from "../src/locales/catalog.js";
import { installAgentPort, project, renderShell, uninstallAgentPort, type FakeAgentPort } from "./helpers/agent-shell-harness.js";
import { CONVERSATION_READY, installTabStorage, lastCommandId, withConversation } from "./helpers/conversation-fixtures.js";

/**
 * 020/T608 - the second round of shot-review defects that sit in the Conversation tab: the broker's
 * English where the panel has its own words (the unreadable version, the folder dialog, a typed
 * path that is not a folder, the failed download's log).
 */

const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/side-panel/agent/agent.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rule = (selector: string): string => {
  let declarations = "";
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if ((match[1] ?? "").split(",").some((part) => part.trim() === selector)) declarations += `${match[2] ?? ""};`;
  }
  return declarations;
};

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};
const result = (port: FakeAgentPort, payload: Record<string, unknown>) =>
  act(() => {
    port.emit({ type: "conversation-result", payload });
  });
const chipOf = (kind: string) => document.querySelector<HTMLElement>(`[data-chip=${kind}]`)!;
const notice = () => document.querySelector<HTMLElement>(".agent-conversation-notice")!;

const BROKER_UNREADABLE = "Claude Code was found, but `--version` did not print a version number.";
const UNREADABLE: ConversationPanelState = {
  ...CONVERSATION_READY,
  agents: [
    { agent: "claude-code", availability: "version-problem", detail: BROKER_UNREADABLE },
    { agent: "codex", availability: "ready", version: "0.50.0" },
  ],
};

describe("T608 the Conversation tab", () => {
  let port: FakeAgentPort;

  beforeEach(() => {
    port = installAgentPort();
    installTabStorage();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  async function open(conversation: ConversationPanelState, locale: "en-US" | "zh-TW" = "en-US") {
    renderShell(locale);
    project(port, withConversation(conversation));
    await settle();
  }

  describe("M1 an agent whose version cannot be read", () => {
    it.each(["en-US", "zh-TW"] as const)("in %s says so in the panel's words, on the card and in the menu row", async (locale) => {
      await open(UNREADABLE, locale);
      const said = lookup("conversation.version.unreadable", locale).replace("{agent}", lookup("conversation.agent.claude-code", locale));

      fireEvent.click(chipOf("agent"));
      const row = document.querySelector<HTMLElement>("[role=menuitemradio][data-availability=version-problem]")!;
      expect(row.querySelector(".agent-conversation-menu-note")?.textContent).toBe(said);
      expect(row.textContent).not.toContain("--version");

      // Choosing it puts its problem card above the message box.
      fireEvent.click(row);
      const card = document.querySelector<HTMLElement>("[data-setup=version-problem]")!;
      expect(card.querySelector(".agent-conversation-detail")?.textContent).toBe(said);
      expect(card.textContent).not.toContain("--version");
    });

    it("keeps a detail it has no words for", async () => {
      await open({ ...UNREADABLE, agents: [{ agent: "claude-code", availability: "version-problem", version: "1.0.0", detail: "needs 2.x" }] });
      expect(document.querySelector("[data-setup=version-problem] .agent-conversation-detail")?.textContent).toBe("needs 2.x");
    });
  });

  describe("J5/J6 the folder chooser's refusals", () => {
    const BROKER_MODE =
      "PowerShell runs in ConstrainedLanguage mode on this computer, so the folder dialog cannot open; type or paste the folder's path instead.";
    const TYPED = "C:\\no-such-folder\\for-hallpass-shots";

    async function typedPath(locale: "en-US" | "zh-TW") {
      await open(CONVERSATION_READY, locale);
      fireEvent.click(chipOf("folder"));
      fireEvent.click(within(screen.getByRole("region", { name: lookup("conversation.folders.label", locale) })).getByRole("button", { name: lookup("conversation.folders.add", locale) }));
      result(port, { commandId: lastCommandId(port), ok: false, error: { code: "path-entry", detail: BROKER_MODE } });
    }

    it.each(["en-US", "zh-TW"] as const)("J5: in %s the dialog notice is the localized title alone", async (locale) => {
      await typedPath(locale);
      expect(notice().getAttribute("data-notice-code")).toBe("path-entry");
      expect(notice().textContent).toBe(lookup("conversation.error.path-entry", locale));
      expect(notice().querySelector(".agent-conversation-detail")).toBeNull();
    });

    it.each(["en-US", "zh-TW"] as const)("J6: in %s a typed path that is not a folder says so, with the path as a value", async (locale) => {
      await typedPath(locale);
      fireEvent.change(screen.getByRole("textbox", { name: lookup("conversation.folders.pathLabel", locale) }), { target: { value: TYPED } });
      fireEvent.click(screen.getByRole("button", { name: lookup("conversation.folders.addTyped", locale) }));
      result(port, { commandId: lastCommandId(port), ok: false, error: { code: "folder-missing", detail: `${TYPED} is not an existing folder.` } });

      expect(notice().getAttribute("data-notice-code")).toBe("folder-missing");
      expect(notice().textContent).toBe(lookup("conversation.folders.notFound", locale).replace("{path}", TYPED));
      expect(notice().textContent).not.toBe(lookup("conversation.error.folder-missing", locale));
      expect(notice().textContent).not.toContain("is not an existing folder");
    });

    it("J6: keeps the conversation's own wording for a folder that went away", async () => {
      await typedPath("en-US");
      fireEvent.change(screen.getByRole("textbox", { name: lookup("conversation.folders.pathLabel", "en-US") }), { target: { value: "D:\\work" } });
      fireEvent.click(screen.getByRole("button", { name: lookup("conversation.folders.addTyped", "en-US") }));
      result(port, { commandId: lastCommandId(port), ok: false, error: { code: "folder-missing", detail: "The folder D:\\work does not exist any more." } });
      expect(notice().querySelector("p")?.textContent).toBe(lookup("conversation.error.folder-missing", "en-US"));
    });
  });

  describe("L3 a download that failed", () => {
    const NPM_LOG = "npm ci failed (exit 1): errno: -4048, npm warn cleanup code: 'EPERM'";
    const NEEDS: ConversationPanelState = {
      ...CONVERSATION_READY,
      consent: "unknown",
      agents: [
        { agent: "claude-code", availability: "needs-install" },
        { agent: "codex", availability: "missing" },
      ],
    };

    it.each(["en-US", "zh-TW"] as const)("in %s says one line and keeps the raw log behind Technical details", async (locale) => {
      await open(NEEDS, locale);
      fireEvent.change(document.querySelector(".agent-conversation-composer textarea")!, { target: { value: "hello" } });
      fireEvent.click(document.querySelector<HTMLButtonElement>(".agent-conversation-composer button[type=submit]")!);
      fireEvent.click(screen.getByRole("button", { name: lookup("conversation.firstUse.download", locale) }));
      result(port, { commandId: lastCommandId(port), ok: false, error: { code: "install-failed", detail: NPM_LOG } });

      const card = document.querySelector<HTMLElement>("[data-setup=install-failed]")!;
      const visible = card.cloneNode(true) as HTMLElement;
      visible.querySelector("details")?.remove();
      expect(visible.querySelector("p")?.textContent).toBe(lookup("conversation.install.failed", locale));
      expect(visible.textContent).not.toContain("npm ci failed");

      const details = card.querySelector("details")!;
      expect(details.open).toBe(false);
      expect(details.querySelector("summary")?.textContent).toBe(lookup("agent.details.title", locale));
      expect(details.textContent).toContain(NPM_LOG);
    });
  });

  describe("B1 the shell does not scroll for text only a screen reader hears", () => {
    // Measured in headless Chromium at 400 x 420 on an open conversation with a log: the shell's
    // scroll height was 548 against a client height of 420. The elements that reached 548 were
    // `.agent-sr-only` spans (absolutely positioned) inside the log, whose containing block was the
    // log's frame, not the log - so the log, the one scroller, neither scrolled nor clipped them and
    // the shell, the next scroller out, grew a scrollbar for them.
    it("makes the log - the scroller that holds those spans - their containing block", () => {
      expect(rule(".agent-sr-only")).toMatch(/position:\s*absolute/);
      expect(rule(".agent-conversation-log")).toMatch(/overflow-y:\s*auto/);
      expect(rule(".agent-conversation-log")).toMatch(/position:\s*relative/);
    });
  });
});
