import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentPanelCommandSchema, type ConversationPanelState } from "@hallpass/contracts";
import { ConversationTab } from "../src/side-panel/agent/conversation/ConversationTab.js";
import {
  installAgentPort,
  project,
  renderShell,
  ui,
  uninstallAgentPort,
  type FakeAgentPort,
} from "./helpers/agent-shell-harness.js";
import { CONVERSATION_READY, commandsSent, installTabStorage, withConversation } from "./helpers/conversation-fixtures.js";

/**
 * 019/T548 - the first-use card (US3, FR-299 - FR-302, D-019-5, D-019-7, R-314).
 *
 * Nothing is downloaded and nothing is admitted to the browser without the owner's Download: the
 * card says what the download is, about how big, that it is a request to the npm registry, that the
 * agent runs with the owner's own settings, and that it will use this browser under the site rules.
 * Cancel sends nothing. A missing agent gets install guidance instead, never a download.
 *
 * 020 FR-314: the card comes when the owner sends to the agent on the chip (composer first), not
 * when picking an agent; the held message itself is covered in composer.test.tsx.
 */

const FIRST_USE: ConversationPanelState = {
  ...CONVERSATION_READY,
  consent: "unknown",
  agents: [
    { agent: "claude-code", availability: "needs-install", version: "2.1.0" },
    { agent: "codex", availability: "missing" },
  ],
};

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};
/** 020 FR-314: the card comes when the owner sends to the agent on the chip, not when picking one. */
const box = () => document.querySelector<HTMLTextAreaElement>(".agent-conversation-composer textarea")!;
const sendWords = (words = "what is on this page?") => {
  fireEvent.change(box(), { target: { value: words } });
  fireEvent.click(document.querySelector<HTMLButtonElement>(".agent-conversation-composer button[type=submit]")!);
};
const choose = (name: RegExp) => {
  fireEvent.click(screen.getByRole("button", { name: /^Agent: / }));
  fireEvent.click(screen.getByRole("menuitemradio", { name }));
};
const card = () => screen.getByRole("region", { name: ui("conversation.firstUse.title").replace("{agent}", "Claude Code") });

describe("T548 the first-use card", () => {
  let port: FakeAgentPort;

  beforeEach(() => {
    port = installAgentPort();
    installTabStorage();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  async function open(conversation: ConversationPanelState = FIRST_USE, locale: "en-US" | "zh-TW" = "en-US") {
    renderShell(locale);
    project(port, withConversation(conversation));
    await settle();
  }

  it("states what, how big, the registry request, the owner's own settings and the site rules", async () => {
    await open();
    sendWords();

    const text = card().textContent ?? "";
    expect(text).toContain(ui("conversation.firstUse.what").replace("{agent}", "Claude Code"));
    expect(text).toContain(ui("conversation.firstUse.size").replace("{size}", ui("conversation.size.claude-code")));
    expect(text).toContain(ui("conversation.firstUse.registry"));
    expect(text).toContain(ui("conversation.firstUse.settings").replace("{agent}", "Claude Code"));
    expect(text).toContain(ui("conversation.firstUse.browser"));
    expect(commandsSent(port)).toEqual([]);
  });

  it("sends the consent, then the install, on Download", async () => {
    await open();
    sendWords();
    fireEvent.click(screen.getByRole("button", { name: ui("conversation.firstUse.download") }));

    expect(commandsSent(port)).toEqual([
      { type: "ui.conversation.consent", payload: { granted: true } },
      { type: "ui.conversation.install", payload: { agent: "claude-code" } },
    ]);
    for (const command of port.sent) expect(agentPanelCommandSchema.safeParse(command).success).toBe(true);
  });

  it("sends only the install when the one-time consent was already given", async () => {
    await open({ ...FIRST_USE, consent: "granted" });
    sendWords();
    fireEvent.click(screen.getByRole("button", { name: ui("conversation.firstUse.download") }));

    expect(commandsSent(port)).toEqual([{ type: "ui.conversation.install", payload: { agent: "claude-code" } }]);
  });

  it("asks for the consent alone, with no download, for an agent already set up", async () => {
    await open({ ...FIRST_USE, agents: [{ agent: "claude-code", availability: "ready" }] });
    sendWords();
    expect(card().textContent).not.toContain(ui("conversation.firstUse.registry"));
    expect(screen.queryByRole("button", { name: ui("conversation.firstUse.download") })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: ui("conversation.firstUse.allow") }));
    expect(commandsSent(port)).toEqual([{ type: "ui.conversation.consent", payload: { granted: true } }]);
  });

  it("sends nothing on Cancel and gives the words back", async () => {
    await open();
    sendWords();
    fireEvent.click(screen.getByRole("button", { name: ui("conversation.firstUse.cancel") }));

    expect(commandsSent(port)).toEqual([]);
    expect(screen.queryByRole("region", { name: /Claude Code/ })).toBeNull();
    expect(box().value).toBe("what is on this page?");
  });

  it("gives install guidance for an agent that is not installed, and offers no download", async () => {
    await open();
    choose(/^Codex/);

    expect(screen.getByRole("heading", { name: ui("conversation.missing.title").replace("{agent}", "Codex") })).toBeTruthy();
    expect(screen.getByText(ui("conversation.missing.codex"))).toBeTruthy();
    expect(screen.queryByRole("button", { name: ui("conversation.firstUse.download") })).toBeNull();
    sendWords();
    expect(commandsSent(port)).toEqual([]);
  });

  it("says which version is installed when it does not work with the connector", async () => {
    await open({ ...FIRST_USE, agents: [{ agent: "claude-code", availability: "version-problem", version: "1.0.0", detail: "needs 2.x" }] });

    expect(screen.getByRole("heading", { name: ui("conversation.version.title").replace("{agent}", "Claude Code") })).toBeTruthy();
    expect(screen.getByText(ui("conversation.version.installed").replace("{version}", "1.0.0"))).toBeTruthy();
    expect(screen.getByText("needs 2.x")).toBeTruthy();
    expect(commandsSent(port)).toEqual([]);
  });

  it("shows the install's phase until the agent is ready", async () => {
    await open();
    sendWords();
    fireEvent.click(screen.getByRole("button", { name: ui("conversation.firstUse.download") }));

    const bar = screen.getByRole("progressbar", { name: ui("conversation.install.label") });
    expect(bar.getAttribute("aria-valuenow")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe(ui("conversation.install.preparing"));

    // T547 (G2): the phase is the broker's word, not inferred from the consent.
    project(port, withConversation({ ...FIRST_USE, consent: "granted" }));
    expect(screen.getByRole("status").textContent).toBe(ui("conversation.install.preparing"));
    project(
      port,
      withConversation({
        ...FIRST_USE,
        consent: "granted",
        agents: [{ agent: "claude-code", availability: "needs-install", installing: "downloading" }],
      }),
    );
    expect(screen.getByRole("status").textContent).toBe(
      ui("conversation.install.downloading").replace("{size}", ui("conversation.size.claude-code")),
    );

    project(port, withConversation({ ...FIRST_USE, consent: "granted", agents: [{ agent: "claude-code", availability: "ready" }] }));
    expect(screen.queryByRole("progressbar")).toBeNull();
    // 020 FR-314: the agent is ready, so the held message's conversation starts.
    expect(commandsSent(port).at(-1)).toEqual({ type: "ui.conversation.start", payload: { agent: "claude-code", folder: { kind: "scratch" } } });
  });

  it("T547 (G2): shows the phase the broker names rather than guessing it", async () => {
    await open({ ...FIRST_USE, consent: "granted" });
    sendWords();
    fireEvent.click(screen.getByRole("button", { name: ui("conversation.firstUse.download") }));
    const installing = (phase: "preparing" | "downloading" | "finishing") =>
      withConversation({
        ...FIRST_USE,
        consent: "granted",
        agents: [{ agent: "claude-code", availability: "needs-install", installing: phase }],
      });

    project(port, installing("preparing"));
    expect(screen.getByRole("status").textContent).toBe(ui("conversation.install.preparing"));
    project(port, installing("downloading"));
    expect(screen.getByRole("status").textContent).toBe(
      ui("conversation.install.downloading").replace("{size}", ui("conversation.size.claude-code")),
    );
    project(port, installing("finishing"));
    expect(screen.getByRole("status").textContent).toBe(ui("conversation.install.finishing"));
  });

  it("says the install failed and retries it on the owner's word", () => {
    const sent: unknown[] = [];
    const view = (lastError?: { code: "install-failed"; detail: string }) => (
      <ConversationTab
        conversation={{ ...FIRST_USE, consent: "granted" }}
        logs={{}}
        locale="en-US"
        send={(command) => sent.push(command)}
        {...(lastError === undefined ? {} : { lastError })}
      />
    );
    const { rerender } = render(view());
    sendWords();
    fireEvent.click(screen.getByRole("button", { name: ui("conversation.firstUse.download") }));
    rerender(view({ code: "install-failed", detail: "network unreachable" }));

    expect(screen.getByText(ui("conversation.install.failed"))).toBeTruthy();
    expect(screen.getByText("network unreachable")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: ui("conversation.install.retry") }));
    expect(sent).toEqual([
      { type: "ui.conversation.install", payload: { agent: "claude-code" } },
      { type: "ui.conversation.install", payload: { agent: "claude-code" } },
    ]);
    expect(screen.getByRole("progressbar")).toBeTruthy();
  });

  it.each(["consent-needed", "broker-unavailable", "agent-missing"] as const)(
    "ends the preparing view with the failed view and Retry when the install is refused with %s",
    (code) => {
      const sent: unknown[] = [];
      const view = (lastError?: { code: typeof code; detail: string }) => (
        <ConversationTab
          conversation={{ ...FIRST_USE, consent: "granted" }}
          logs={{}}
          locale="en-US"
          send={(command) => sent.push(command)}
          {...(lastError === undefined ? {} : { lastError })}
        />
      );
      const { rerender } = render(view());
      sendWords();
      fireEvent.click(screen.getByRole("button", { name: ui("conversation.firstUse.download") }));
      expect(screen.getByRole("progressbar")).toBeTruthy();
      rerender(view({ code, detail: "the helper went away" }));

      expect(screen.getByText(ui("conversation.install.failed"))).toBeTruthy();
      expect(screen.getByText("the helper went away")).toBeTruthy();
      expect(screen.queryByRole("progressbar")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: ui("conversation.install.retry") }));
      expect(sent.at(-1)).toEqual({ type: "ui.conversation.install", payload: { agent: "claude-code" } });
      expect(screen.getByRole("progressbar")).toBeTruthy();
    },
  );

  describe("T576 the conversation starts when the install finishes", () => {
    const READY = { ...FIRST_USE, consent: "granted" as const, agents: [{ agent: "claude-code" as const, availability: "ready" as const }, FIRST_USE.agents[1]!] };
    const starts = (sent: unknown[]) => sent.filter((command) => (command as { type: string }).type === "ui.conversation.start");
    const view = (conversation: ConversationPanelState, sent: unknown[], lastError?: { code: "install-failed"; detail: string }) => (
      <ConversationTab
        conversation={conversation}
        logs={{}}
        locale="en-US"
        send={(command) => sent.push(command)}
        {...(lastError === undefined ? {} : { lastError })}
      />
    );

    it("starts in scratch once, for a message sent with the default folder", () => {
      const sent: unknown[] = [];
      const { rerender } = render(view({ ...FIRST_USE, consent: "granted" }, sent));
      sendWords();
      fireEvent.click(screen.getByRole("button", { name: ui("conversation.firstUse.download") }));
      expect(starts(sent)).toEqual([]);

      rerender(view(READY, sent));
      rerender(view({ ...READY }, sent)); // a later projection of the same ready state starts nothing more
      expect(starts(sent)).toEqual([{ type: "ui.conversation.start", payload: { agent: "claude-code", folder: { kind: "scratch" } } }]);
      expect(screen.queryByRole("progressbar")).toBeNull();
    });

    it("starts in the folder picked on the folder chip", () => {
      const sent: unknown[] = [];
      const withFolder = (conversation: ConversationPanelState) => ({
        ...conversation,
        folders: [{ path: "C:\\work\\proj", addedAt: "2026-10-19T12:00:00.000Z" }],
      });
      const { rerender } = render(view(withFolder({ ...FIRST_USE, consent: "granted" }), sent));
      fireEvent.click(screen.getByRole("button", { name: /^Folder: / }));
      fireEvent.click(screen.getByRole("radio", { name: "C:\\work\\proj" }));
      sendWords();
      fireEvent.click(screen.getByRole("button", { name: ui("conversation.firstUse.download") }));

      rerender(view(withFolder(READY), sent));
      expect(starts(sent)).toEqual([
        { type: "ui.conversation.start", payload: { agent: "claude-code", folder: { kind: "project", path: "C:\\work\\proj" } } },
      ]);
    });

    it("starts nothing after a failed install, Retry keeps the wish, Cancel drops it", () => {
      const sent: unknown[] = [];
      const base = { ...FIRST_USE, consent: "granted" as const };
      const { rerender } = render(view(base, sent));
      sendWords();
      fireEvent.click(screen.getByRole("button", { name: ui("conversation.firstUse.download") }));
      rerender(view(base, sent, { code: "install-failed", detail: "network unreachable" }));
      expect(starts(sent)).toEqual([]);

      fireEvent.click(screen.getByRole("button", { name: ui("conversation.install.retry") }));
      rerender(view(READY, sent));
      expect(starts(sent)).toHaveLength(1);

      cleanup();
      sent.length = 0;
      const second = render(view(base, sent));
      sendWords();
      fireEvent.click(second.getByRole("button", { name: ui("conversation.firstUse.download") }));
      second.rerender(view(base, sent, { code: "install-failed", detail: "network unreachable" }));
      fireEvent.click(second.getByRole("button", { name: ui("conversation.firstUse.cancel") }));
      second.rerender(view(READY, sent));
      expect(starts(sent)).toEqual([]);
    });
  });

  it("reads in zh-TW", async () => {
    await open(FIRST_USE, "zh-TW");
    sendWords();
    expect(screen.getByRole("region", { name: "為側欄設定 Claude Code" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "下載" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "取消" })).toBeTruthy();
  });
});
