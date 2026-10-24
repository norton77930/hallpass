import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConversationEvent, ConversationPanelState, ConversationView } from "@hallpass/contracts";
import { lookup } from "../src/locales/catalog.js";
import { messages as zhMessages } from "../src/locales/zh-TW.js";
import { folderName } from "../src/side-panel/agent/conversation/folder-name.js";
import { shortenPaths } from "../src/side-panel/agent/conversation/inline-code.js";
import type { TurnActionGroup } from "../src/side-panel/agent/conversation/conversation-log.js";
import { TurnActions } from "../src/side-panel/agent/conversation/TurnActions.js";
import { installAgentPort, project, renderShell, ui, uninstallAgentPort, type FakeAgentPort } from "./helpers/agent-shell-harness.js";
import {
  CONVERSATION_OPEN,
  CONVERSATION_READY,
  VIEW,
  emitEvent,
  installTabStorage,
  withConversation,
} from "./helpers/conversation-fixtures.js";

/**
 * 020/T607 - the defects of the full shot review that sit in the Conversation tab: folder names, one
 * name per mode, one word for "ready", the drawer's time, the folder picker's rows, a crashed agent
 * said once and in the panel's language, and long paths in step titles.
 */

const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/side-panel/agent/agent.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
/** The declarations of every rule whose selector list contains `selector` as one of its parts. */
const rule = (selector: string): string => {
  let declarations = "";
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if ((match[1] ?? "").split(",").some((part) => part.trim() === selector)) declarations += `${match[2] ?? ""};`;
  }
  return declarations;
};

const PROJECT = "C:\\Users\\owner\\projects\\storefront";
const settle = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};
const header = () => document.querySelector<HTMLElement>(".agent-conversation-header")!;
const log = () => document.querySelector<HTMLElement>(".agent-conversation-log")!;
const chipOf = (kind: string) => document.querySelector<HTMLElement>(`[data-chip=${kind}]`)!;
const withProject = (patch: Partial<ConversationView> = {}): ConversationView => ({ ...VIEW, folder: { kind: "project", path: PROJECT }, ...patch });
const READY_WITH_FOLDER: ConversationPanelState = { ...CONVERSATION_READY, folders: [{ path: PROJECT, addedAt: "2026-10-19T00:00:00.000Z" }] };

describe("T607 the Conversation tab", () => {
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

  describe("A1/G2 a project folder is its name", () => {
    it("takes the last segment of a Windows or POSIX path", () => {
      expect(folderName(PROJECT)).toBe("storefront");
      expect(folderName("D:\\work\\shop\\")).toBe("shop");
      expect(folderName("/home/owner/shop")).toBe("shop");
      expect(folderName("C:\\")).toBe("C:\\");
    });

    it("shows the picked folder's name on the composer chip and in the header, the path as their title", async () => {
      await open(READY_WITH_FOLDER);
      fireEvent.click(chipOf("folder"));
      fireEvent.click(document.querySelector<HTMLInputElement>(".agent-conversation-folder-row input[type=radio]")!);

      expect(chipOf("folder").querySelector(".agent-conversation-chip-text")?.textContent).toBe("storefront");
      expect(chipOf("folder").getAttribute("title")).toContain(PROJECT);
      const folder = header().querySelector(".agent-conversation-folder")!;
      expect(folder.textContent).toBe("storefront");
      expect(folder.getAttribute("title")).toBe(PROJECT);
    });

    it("shows the name in an open conversation's header, its fixed chip and its drawer row", async () => {
      await open({ ...CONVERSATION_OPEN, conversations: [withProject()] });

      const folder = header().querySelector(".agent-conversation-folder")!;
      expect(folder.textContent).toBe("storefront");
      expect(folder.getAttribute("title")).toBe(PROJECT);
      expect(chipOf("folder").querySelector(".agent-conversation-chip-text")?.textContent).toBe("storefront");
      expect(chipOf("folder").getAttribute("title")).toContain(PROJECT);

      fireEvent.click(screen.getByRole("button", { name: ui("conversation.header.list") }));
      const row = document.querySelector(".agent-conversation-entry .agent-conversation-folder")!;
      expect(row.textContent).toBe("storefront");
      expect(row.getAttribute("title")).toBe(PROJECT);
    });

    it("keeps the scratch folder's label", async () => {
      await open(CONVERSATION_OPEN);
      expect(header().querySelector(".agent-conversation-folder")?.textContent).toBe(ui("conversation.folder.scratch"));
      expect(chipOf("folder").querySelector(".agent-conversation-chip-text")?.textContent).toBe(ui("conversation.folder.scratch"));
    });

    // T609 (N1): the owner chose one row - the wrap this test once pinned is gone (see conversation-t609.test.tsx).
    it("does not cut the folder chip to a few letters", () => {
      expect(rule('.agent-shell .agent-conversation-chip[data-chip="folder"]')).not.toMatch(/min-width:\s*4em/);
    });
  });

  describe("A2 one name per permission mode", () => {
    it.each(["en-US", "zh-TW"] as const)("in %s the chip and the menu option say the same words", (locale) => {
      for (const mode of ["strict", "agent-review"] as const) {
        expect(lookup(`conversation.mode.short.${mode}`, locale)).toBe(lookup(`conversation.mode.${mode}`, locale));
      }
    });

    it("uses the agreed words", () => {
      expect(ui("conversation.mode.strict")).toBe("Ask first");
      expect(ui("conversation.mode.agent-review")).toBe("Agent review");
      expect(lookup("conversation.mode.strict", "zh-TW")).toBe("變更前先問");
      expect(lookup("conversation.mode.agent-review", "zh-TW")).toBe("agent 自行審查");
    });

    it.each(["claude-code", "codex"] as const)("shows the chip's words as the option's title for %s", async (agent) => {
      await open({ ...CONVERSATION_OPEN, conversations: [{ ...VIEW, agent }] });
      const chip = () => document.querySelector<HTMLElement>("[data-chip=mode]")!;
      expect(chip().querySelector(".agent-conversation-chip-short")?.textContent).toBe("Ask first");
      fireEvent.click(chip());
      const options = [...document.querySelectorAll(".agent-conversation-mode-option label")].map((label) => label.textContent);
      expect(options).toEqual(["Ask first", "Agent review"]);
    });
  });

  describe("A3 ready is one word in zh-TW", () => {
    it("renders no agent's ready state as 就緒", async () => {
      expect(Object.values(zhMessages).filter((words) => words.includes("就緒"))).toEqual([]);
      installTabStorage("codex");
      await open(CONVERSATION_READY, "zh-TW");
      fireEvent.click(chipOf("agent"));
      const states = [...document.querySelectorAll(".agent-conversation-availability")].map((node) => node.textContent);
      expect(states).toEqual(["可以使用", "可以使用"]);
    });
  });

  describe("G1 the drawer row's time is never cut", () => {
    it("keeps the time outside the part that ellipsizes", async () => {
      await open({ ...CONVERSATION_OPEN, conversations: [withProject()] });
      fireEvent.click(screen.getByRole("button", { name: ui("conversation.header.list") }));
      const meta = document.querySelector(".agent-conversation-entry-meta")!;
      const where = meta.querySelector(".agent-conversation-entry-where")!;
      const time = meta.querySelector("time")!;
      expect(where.contains(time)).toBe(false);
      expect(where.textContent).toContain("storefront");
      expect(rule(".agent-conversation-entry-meta")).toMatch(/display:\s*flex/);
      expect(rule(".agent-conversation-entry-where")).toMatch(/text-overflow:\s*ellipsis/);
      expect(rule(".agent-conversation-entry-time")).toMatch(/flex-shrink:\s*0/);
    });
  });

  describe("J1 the folder picker's rows", () => {
    it("puts the name on one line and the path on another, and keeps Remove whole", async () => {
      await open(READY_WITH_FOLDER);
      fireEvent.click(chipOf("folder"));
      const row = document.querySelector(".agent-conversation-folder-row")!;
      expect(row.querySelector(".agent-conversation-folder-name")?.textContent).toBe("storefront");
      const full = row.querySelector(".agent-conversation-folder-full")!;
      expect(full.textContent).toBe(PROJECT);
      expect(full.getAttribute("title")).toBe(PROJECT);
      expect(rule(".agent-conversation-folder-full")).toMatch(/text-overflow:\s*ellipsis/);
      expect(rule(".agent-conversation-folder-full")).toMatch(/white-space:\s*nowrap/);
      expect(rule(".agent-conversation-folder-row button")).toMatch(/white-space:\s*nowrap/);
      expect(rule(".agent-conversation-folder-row button")).toMatch(/flex:\s*none/);
    });
  });

  describe("K1 a crashed agent is said once, in the panel's language", () => {
    const CRASH = "Claude Code ended unexpectedly (exit 3). Send a message to continue.";
    const crash = (seq: number, text = CRASH) => {
      emitEvent(port, seq, { type: "notice", code: "agent-exited", text } as ConversationEvent);
      emitEvent(port, seq + 1, { type: "state", state: "crashed" });
    };

    it.each(["en-US", "zh-TW"] as const)("in %s shows a title and one detail line, the exit code kept as a value", async (locale) => {
      await open(CONVERSATION_OPEN, locale);
      crash(1);
      const t = (key: string) => lookup(key, locale);

      const notice = log().querySelector("[data-notice-code='agent-exited']")!;
      expect(notice.querySelector("p")?.textContent).toBe(t("conversation.error.agent-exited"));
      expect(notice.querySelector(".agent-conversation-detail")?.textContent).toBe(t("conversation.notice.agent-exited.exit").replace("{code}", "3"));
      expect(notice.textContent).not.toContain("ended unexpectedly");
      // Said once on screen: the line under the log does not repeat it.
      const says = [...document.querySelectorAll("p")].filter((node) => node.textContent === t("conversation.error.agent-exited"));
      expect(says).toHaveLength(1);
      expect(document.querySelector(".agent-conversation-state")).toBeNull();
    });

    it("has no detail when the agent was ended by a signal, and still says it once", async () => {
      await open(CONVERSATION_OPEN);
      crash(1, "Claude Code ended unexpectedly. Send a message to continue.");
      const notice = log().querySelector("[data-notice-code='agent-exited']")!;
      expect(notice.querySelector(".agent-conversation-detail")).toBeNull();
      expect(notice.textContent).toBe(ui("conversation.error.agent-exited"));
    });

    it("still says a crash the log does not hold (a reopened panel) with the state line", async () => {
      await open({ ...CONVERSATION_OPEN, conversations: [{ ...VIEW, state: "crashed" }] });
      expect(document.querySelector(".agent-conversation-state")?.textContent).toBe(ui("conversation.state.crashed"));
    });
  });
});

describe("T607 W1 a step with a long path", () => {
  const FULL = "C:\\Users\\owner\\projects\\storefront\\packages\\checkout-service\\src\\payments\\providers\\adyen\\webhooks\\signature-verification.ts";
  const tool = (id: string, title: string, inputSummary = ""): Extract<ConversationEvent, { type: "tool" }> => ({
    type: "tool",
    toolCallId: id,
    title,
    kind: "read",
    status: "done",
    inputSummary,
  });
  const group = (steps: ReturnType<typeof tool>[]): TurnActionGroup => ({ kind: "turn-actions", key: "k", running: false, steps, problems: [] });
  const t = (key: string) => lookup(key, "en-US");

  afterEach(cleanup);

  it("shortens a long path to its tail", () => {
    expect(shortenPaths(`Read ${FULL}`)).toBe("Read …\\webhooks\\signature-verification.ts");
    expect(shortenPaths("Read vite.config.ts")).toBe("Read vite.config.ts");
    expect(shortenPaths("Read src/a/b.ts")).toBe("Read src/a/b.ts");
    expect(shortenPaths("Read D:/work/shop/packages/checkout/src/payments/pay.ts and more")).toBe("Read …/payments/pay.ts and more");
  });

  it("shows the tail on one line, the whole input as the title, and the status in the same place on every row", () => {
    render(<TurnActions group={group([tool("a", "Read vite.config.ts"), tool("b", `Read ${FULL}`)])} t={t} />);
    fireEvent.click(screen.getByRole("button", { name: t("conversation.turn.steps").replace("{count}", "2") }));
    const rows = within(screen.getByRole("list", { name: t("conversation.actions.label") })).getAllByRole("listitem");
    const long = rows[1]!.querySelector(".agent-conversation-action-title")!;
    expect(long.textContent).toBe("Read …\\webhooks\\signature-verification.ts");
    expect(long.getAttribute("title")).toBe(`Read ${FULL}`);
    for (const row of rows) expect(row.querySelector(".agent-conversation-action-status")).not.toBeNull();

    expect(rule(".agent-conversation-actions li")).toMatch(/flex-wrap:\s*nowrap/);
    expect(rule(".agent-conversation-actions .agent-conversation-action-title")).toMatch(/text-overflow:\s*ellipsis/);
    expect(rule(".agent-conversation-actions .agent-conversation-action-status")).toMatch(/margin-inline-start:\s*auto/);
  });

  it("shortens an input that carries the path", () => {
    render(<TurnActions group={group([tool("a", "Read file", FULL)])} t={t} />);
    fireEvent.click(screen.getByRole("button", { name: t("conversation.turn.step") }));
    const input = document.querySelector(".agent-conversation-action-input")!;
    expect(input.textContent).toBe("…\\webhooks\\signature-verification.ts");
    expect(input.getAttribute("title")).toBe(FULL);
  });
});
