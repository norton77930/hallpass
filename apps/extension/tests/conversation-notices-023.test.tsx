import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConversationAgent, ConversationEvent, ConversationPanelState, ConversationView } from "@hallpass/contracts";
import { ConversationTab } from "../src/side-panel/agent/conversation/ConversationTab.js";
import { installAgentPort, project, renderShell, uninstallAgentPort, type FakeAgentPort } from "./helpers/agent-shell-harness.js";
import { CONVERSATION_ID, CONVERSATION_READY, VIEW, emitEvent, installTabStorage, withConversation } from "./helpers/conversation-fixtures.js";

/**
 * 023/T718, T719, T724 (US3 + US4, D-023-2, D-023-6, R-365, R-369, FR-364, FR-369, FR-370, FR-373) -
 * the two notices the broker raises with an agent (and a variable name) attached, said in the panel's
 * own words in both languages: the browser tools an agent did not take, and a key variable the
 * browser cannot see.
 */

const FOUR_READY: ConversationPanelState = {
  ...CONVERSATION_READY,
  agents: [
    { agent: "claude-code", availability: "ready", version: "2.1.0" },
    { agent: "codex", availability: "ready", version: "0.50.0" },
    { agent: "hermes", availability: "ready", version: "0.22.2" },
    { agent: "deepseek", availability: "ready", version: "0.2.1-rc.2", notes: ["pre-release"] },
  ],
};
const withView = (view: Partial<ConversationView>): ConversationPanelState => ({
  ...FOUR_READY,
  conversations: [{ ...VIEW, ...view }],
  active: CONVERSATION_ID,
});

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

const notice = (code: string, agent: ConversationAgent, variable?: string): ConversationEvent =>
  ({ type: "notice", code, text: "The broker's English sentence.", agent, ...(variable === undefined ? {} : { variable }) }) as ConversationEvent;
const noticeBox = (code: string) => document.querySelector<HTMLElement>(`[data-notice-code='${code}']`);

describe("023 notices with an agent attached", () => {
  let port: FakeAgentPort;

  beforeEach(() => {
    port = installAgentPort();
    installTabStorage();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  async function open(agent: ConversationAgent, locale: "en-US" | "zh-TW" = "en-US") {
    renderShell(locale);
    project(port, withConversation(withView({ agent })));
    await settle();
  }

  describe("browser-tools-missing (T718, T719)", () => {
    it("Hermes: says its optional MCP component is missing and what to do", async () => {
      await open("hermes");
      emitEvent(port, 1, notice("browser-tools-missing", "hermes"));

      const box = noticeBox("browser-tools-missing")!;
      expect(box.textContent).toBe(
        "Hermes could not take Hallpass's browser tools: its optional MCP component is missing. Add it to Hermes (the mcp extra), then start a new conversation.",
      );
      expect(box.querySelector("code")?.textContent).toBe("mcp");
      expect(box.textContent).not.toContain("broker's English");
    });

    it("DeepSeek: says it cannot use the browser and what to attach instead", async () => {
      await open("deepseek");
      emitEvent(port, 1, notice("browser-tools-missing", "deepseek"));

      expect(noticeBox("browser-tools-missing")!.textContent).toBe(
        "DeepSeek cannot use the browser by itself. Attach a screenshot or the current tab instead.",
      );
    });

    it("says it in zh-TW", async () => {
      await open("hermes", "zh-TW");
      emitEvent(port, 1, notice("browser-tools-missing", "hermes"));
      expect(noticeBox("browser-tools-missing")!.textContent).toContain("Hermes 沒有取得 Hallpass 的瀏覽器工具");
      expect(document.body.textContent).not.toContain("could not take");
      cleanup();

      renderShell("zh-TW");
      project(port, withConversation(withView({ agent: "deepseek" })));
      await settle();
      emitEvent(port, 1, notice("browser-tools-missing", "deepseek"));
      expect(noticeBox("browser-tools-missing")!.textContent).toContain("DeepSeek 無法自行使用瀏覽器");
    });

    it("an agent with no words of its own still gets a sentence naming it", async () => {
      await open("codex");
      emitEvent(port, 1, notice("browser-tools-missing", "codex"));
      expect(noticeBox("browser-tools-missing")!.textContent).toBe("Codex could not take Hallpass's browser tools.");
    });

    it("sits in the conversation's log, which announces it politely once", async () => {
      await open("hermes");
      emitEvent(port, 1, notice("browser-tools-missing", "hermes"));
      const box = noticeBox("browser-tools-missing")!;
      expect(box.closest("[role='log']")?.getAttribute("aria-live")).toBe("polite");
      expect(box.querySelector("[aria-live], [role='status'], [role='alert']")).toBeNull();
    });
  });

  describe("key-env-not-in-browser (T724)", () => {
    it("names the variable, and says to quit the browser completely and open it again", async () => {
      await open("hermes");
      emitEvent(port, 1, notice("key-env-not-in-browser", "hermes", "OPENROUTER_API_KEY"));

      expect(noticeBox("key-env-not-in-browser")!.textContent).toBe(
        "Hermes' key variable OPENROUTER_API_KEY is set in your Windows user settings, but this browser started before it was set, so Hermes cannot see it. " +
          "Quit the browser completely (including any copy still running in the background) and open it again.",
      );
    });

    it("shows the variable name only - nothing of the broker's text", async () => {
      await open("hermes");
      emitEvent(port, 1, { ...notice("key-env-not-in-browser", "hermes", "OPENROUTER_API_KEY"), text: "sk-or-v1-0123456789abcdef" } as ConversationEvent);

      expect(document.body.textContent).toContain("OPENROUTER_API_KEY");
      expect(document.body.textContent).not.toContain("sk-or-v1");
    });

    it("says it in zh-TW", async () => {
      await open("hermes", "zh-TW");
      emitEvent(port, 1, notice("key-env-not-in-browser", "hermes", "OPENROUTER_API_KEY"));

      const words = noticeBox("key-env-not-in-browser")!.textContent!;
      expect(words).toContain("OPENROUTER_API_KEY");
      expect(words).toContain("完全結束");
      expect(words).not.toContain("Quit the browser");
    });

    // FR-373, R-369: a failed first start carries the hint inside its error detail, in the broker's English.
    it("says the hint inside a failed first start's detail in zh-TW, naming the variable only", () => {
      const detail =
        "Hermes could not reach its model. Check Hermes' own settings; Hallpass never asks for or keeps a key. " +
        "OPENROUTER_API_KEY is set in your Windows user settings, but this browser started before it was, so Hermes did not get it. " +
        "Quit the browser completely (also when it keeps running in the background), then open it again. " +
        "The agent said (session/new): 401 unauthorized";
      render(
        <ConversationTab
          conversation={withView({ agent: "hermes" })}
          logs={{}}
          locale="zh-TW"
          send={() => undefined}
          lastError={{ code: "agent-model-unreachable", detail }}
        />,
      );

      const words = noticeBox("agent-model-unreachable")!.textContent!;
      expect(words).toContain("Hermes 的金鑰變數 OPENROUTER_API_KEY 已設在你的 Windows 使用者設定中");
      expect(words).not.toContain("is set in your Windows user settings");
      expect(words).not.toContain("Quit the browser completely");
      expect(words).toContain("401 unauthorized");
    });
  });
});
