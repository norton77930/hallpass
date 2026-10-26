import { act, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ConversationAgentAvailability } from "@hallpass/contracts";
import { NOW, renderSettings, ui, withAgent } from "./fixtures/settings-harness.js";
import { prototypeAState } from "./fixtures/settings-prototype-a.js";

/**
 * 024 T764 (US2, FR-379, FR-380, FR-299, D-024-9): download, cancel and try again from the card; the
 * progress with its percent and time-left estimate; the lines about what closing does; Hermes' steps.
 */

const card = (container: HTMLElement, agent: string): HTMLElement => {
  const found = container.querySelector<HTMLElement>(`[data-agent="${agent}"]`);
  if (found === null) throw new Error(`no card for ${agent}`);
  return found;
};
const disclosure = (cardElement: HTMLElement): HTMLElement => {
  const found = cardElement.querySelector<HTMLElement>("button[aria-expanded]");
  if (found === null) throw new Error("no disclosure button");
  return found;
};

describe("T764 download from the card (FR-379)", () => {
  it("offers Download helper on a needs-helper card and sends the install command", () => {
    const { container, send, commands } = renderSettings();
    const codex = card(container, "codex");
    const button = within(codex).getByRole("button", { name: ui("settings.action.downloadHelper", { size: "20 MB" }) });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    expect(send).toHaveBeenCalledTimes(1);
    expect(commands()[0]).toMatchObject({ type: "ui.conversation.install", payload: { agent: "codex" } });
  });

  it("explains why a helper is needed, with its size", () => {
    const { container } = renderSettings();
    expect(within(card(container, "codex")).getByText(ui("settings.note.helperWhy", { agent: "Codex", size: "20 MB" }))).toBeTruthy();
  });

  it("names each agent's own download size: Claude Code about 60 MB, Codex about 20 MB", () => {
    const state = withAgent(prototypeAState(NOW), "claude-code", (entry) => {
      const { install: _install, installing: _installing, ...rest } = entry;
      return { ...rest, availability: "needs-install" };
    });
    const { container } = renderSettings({ state });
    const claude = card(container, "claude-code");
    expect(within(claude).getByRole("button", { name: ui("settings.action.downloadHelper", { size: "60 MB" }) })).toBeTruthy();
    expect(within(claude).getByText(ui("settings.note.helperWhy", { agent: "Claude Code", size: "60 MB" }))).toBeTruthy();
    expect(within(card(container, "codex")).getByRole("button", { name: ui("settings.action.downloadHelper", { size: "20 MB" }) })).toBeTruthy();
  });

  it("offers Download and install on a DeepSeek that is not installed", () => {
    const state = withAgent(prototypeAState(NOW), "deepseek", (entry) => {
      const { install: _install, installing: _installing, ...rest } = entry;
      return { ...rest, availability: "needs-install" };
    });
    const { container, commands } = renderSettings({ state });
    const deepseek = card(container, "deepseek");
    expect(within(deepseek).getByText(ui("settings.note.notInstalled", { size: "730 MB", estimate: "5–6" }))).toBeTruthy();
    fireEvent.click(within(deepseek).getByRole("button", { name: ui("settings.action.downloadAgent", { size: "730 MB" }) }));
    expect(commands()[0]).toMatchObject({ type: "ui.conversation.install", payload: { agent: "deepseek" } });
  });

  it("offers no download for Hermes: its steps are the owner's, and Check again is the action", () => {
    const { container } = renderSettings();
    const hermes = card(container, "hermes");
    expect(within(hermes).queryByRole("button", { name: /Download/ })).toBeNull();
    expect(within(hermes).getByRole("button", { name: ui("settings.action.checkAgain") })).toBeTruthy();
  });
});

describe("T764 progress (FR-379, R-376 addendum)", () => {
  it("shows the percent, a time-left estimate and Cancel while downloading", () => {
    const { container, commands } = renderSettings();
    const deepseek = card(container, "deepseek");
    fireEvent.click(disclosure(deepseek));
    const bar = within(deepseek).getByRole("progressbar", { name: ui("settings.progress.agent", { agent: "DeepSeek" }) });
    expect(bar.getAttribute("aria-valuenow")).toBe("42");
    expect(within(deepseek).getByText("42 %")).toBeTruthy();
    // 191 s is about three minutes - and it says it is an estimate.
    expect(within(deepseek).getByText(ui("settings.progress.timeLeft", { minutes: 3 }))).toBeTruthy();
    expect(within(deepseek).getByText(ui("settings.progress.keepsGoing"))).toBeTruthy();
    expect(within(deepseek).getByText(ui("settings.progress.firstDownload", { estimate: "5–6" }))).toBeTruthy();
    expect(within(deepseek).queryByRole("button", { name: /Download/ })).toBeNull();
    fireEvent.click(within(deepseek).getByRole("button", { name: ui("settings.action.cancel") }));
    expect(commands()[0]).toMatchObject({ type: "ui.conversation.install-cancel", payload: { agent: "deepseek" } });
  });

  it("says a cancelled download was cancelled", async () => {
    const { container } = renderSettings();
    const deepseek = card(container, "deepseek");
    fireEvent.click(disclosure(deepseek));
    await act(async () => {
      fireEvent.click(within(deepseek).getByRole("button", { name: ui("settings.action.cancel") }));
    });
    expect(screen.getByText(ui("settings.toast.downloadCancelled"))).toBeTruthy();
  });

  it("says Preparing, with no percent, before the first bytes", () => {
    const state = withAgent(prototypeAState(NOW), "deepseek", (entry) => ({
      ...entry,
      installing: "preparing",
      install: { phase: "preparing", percent: null, etaSeconds: null, startedAt: NOW.toISOString(), browserId: "b1" },
    }));
    const { container } = renderSettings({ state });
    const deepseek = card(container, "deepseek");
    fireEvent.click(disclosure(deepseek));
    const bar = within(deepseek).getByRole("progressbar", { name: ui("settings.progress.agent", { agent: "DeepSeek" }) });
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
    expect(within(deepseek).getAllByText(ui("settings.progress.preparing")).length).toBeGreaterThan(0);
    expect(deepseek.textContent).not.toMatch(/\d+ %/u);
    expect(deepseek.textContent).not.toContain("left");
  });

  it("says under a minute for a short estimate", () => {
    const state = withAgent(prototypeAState(NOW), "deepseek", (entry) => ({
      ...entry,
      install: { phase: "downloading", percent: 95, etaSeconds: 20, startedAt: NOW.toISOString(), browserId: "b1" },
    }));
    const { container } = renderSettings({ state });
    const deepseek = card(container, "deepseek");
    fireEvent.click(disclosure(deepseek));
    expect(within(deepseek).getByText(ui("settings.progress.timeLeftShort"))).toBeTruthy();
  });

  it("shows a small bar and the percent on the collapsed row, which Cancel is not on", () => {
    const { container } = renderSettings();
    const deepseek = card(container, "deepseek");
    // A downloading card starts closed: its row carries the small bar and the percent.
    const sub = deepseek.querySelector(".acard-sub");
    expect(sub).not.toBeNull();
    expect(within(sub as HTMLElement).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("42");
    expect(within(sub as HTMLElement).getByText("42 %")).toBeTruthy();
    expect(within(deepseek).queryByRole("button", { name: ui("settings.action.cancel") })).toBeNull();
    // Opened, the row gives way to the full block.
    fireEvent.click(disclosure(deepseek));
    expect(deepseek.querySelector(".acard-sub")).toBeNull();
    expect(within(deepseek).getByRole("button", { name: ui("settings.action.cancel") })).toBeTruthy();
  });

  it("uses the helper wording for a helper download", () => {
    const state = withAgent(prototypeAState(NOW), "codex", (entry) => ({
      ...entry,
      installing: "downloading",
      install: { phase: "downloading", percent: 60, etaSeconds: 30, startedAt: NOW.toISOString(), browserId: "b1" },
    }));
    const { container } = renderSettings({ state });
    const codex = card(container, "codex");
    fireEvent.click(disclosure(codex));
    expect(within(codex).getByRole("progressbar", { name: ui("settings.progress.helper") })).toBeTruthy();
    expect(within(codex).queryByText(ui("settings.progress.firstDownload", { estimate: "5–6" }))).toBeNull();
  });
});

describe("T764 interrupted, failed and try again (FR-379)", () => {
  const withInstall = (install: NonNullable<ConversationAgentAvailability["install"]>) =>
    withAgent(prototypeAState(NOW), "codex", (entry) => {
      const { installing: _installing, ...rest } = entry;
      return { ...rest, install };
    });

  it("says an interrupted download stopped and offers Try again", () => {
    const state = withInstall({ phase: "interrupted", percent: 30, etaSeconds: null, startedAt: NOW.toISOString(), endedAt: NOW.toISOString(), browserId: "b1" });
    const { container, commands } = renderSettings({ state });
    const codex = card(container, "codex");
    expect(within(codex).getByText(ui("settings.progress.interrupted"))).toBeTruthy();
    fireEvent.click(within(codex).getByRole("button", { name: ui("settings.action.tryAgain") }));
    expect(commands()[0]).toMatchObject({ type: "ui.conversation.install", payload: { agent: "codex" } });
  });

  it("says why a failed download failed and offers Try again", () => {
    const state = withInstall({
      phase: "failed",
      percent: null,
      etaSeconds: null,
      startedAt: NOW.toISOString(),
      endedAt: NOW.toISOString(),
      browserId: "b1",
      error: "The download was cut off.",
    });
    const { container } = renderSettings({ state });
    const codex = card(container, "codex");
    expect(within(codex).getByText(ui("settings.progress.failed", { reason: "The download was cut off." }))).toBeTruthy();
    expect(within(codex).getByText(ui("settings.progress.failedHint"))).toBeTruthy();
    expect(within(codex).getByRole("button", { name: ui("settings.action.tryAgain") })).toBeTruthy();
  });
});

describe("T764 the download toast is shown once (FR-379)", () => {
  it("shows a done toast once and not again on a re-render with the same one", () => {
    const harness = renderSettings();
    harness.update({ toast: { kind: "install-done", agent: "codex", seq: 1 } });
    expect(screen.getAllByText(ui("settings.toast.downloadDone", { agent: "Codex" }))).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: ui("settings.toast.dismiss") }));
    expect(screen.queryByText(ui("settings.toast.downloadDone", { agent: "Codex" }))).toBeNull();
    harness.update({ toast: { kind: "install-done", agent: "codex", seq: 1 } });
    harness.project(prototypeAState(NOW));
    expect(screen.queryByText(ui("settings.toast.downloadDone", { agent: "Codex" }))).toBeNull();
    harness.update({ toast: { kind: "install-failed", agent: "codex", seq: 2 } });
    expect(screen.getByText(ui("settings.toast.downloadFailed", { agent: "Codex" }))).toBeTruthy();
  });
});

describe("T764 Hermes' setup steps (FR-380, D-021-3)", () => {
  it("lists each step as found or not done, and installs nothing", () => {
    const { container } = renderSettings();
    const hermes = card(container, "hermes");
    const steps = Array.from(hermes.querySelectorAll<HTMLElement>("[data-step]"));
    expect(steps.map((step) => [step.dataset.step, step.dataset.found])).toEqual([
      ["git", "true"],
      ["hermes", "true"],
      ["mcp-component", "false"],
      ["key-variable", "true"],
      ["browser-restart", "false"],
    ]);
    expect(within(steps[0]!).getByText(new RegExp(ui("settings.hermes.found")))).toBeTruthy();
    expect(within(steps[2]!).getByText(new RegExp(ui("settings.hermes.notDone")))).toBeTruthy();
    expect(within(hermes).queryByRole("button", { name: /Download|Install/ })).toBeNull();
  });
});

describe("T764 consent not granted (FR-299)", () => {
  it("offers the side-panel-agent switch first and waits for it before the download", () => {
    const state = { ...prototypeAState(NOW), consent: "unknown" as const };
    const { container, commands } = renderSettings({ state });
    const codex = card(container, "codex");
    const download = within(codex).getByRole("button", { name: ui("settings.action.downloadHelper", { size: "20 MB" }) }) as HTMLButtonElement;
    expect(download.disabled).toBe(true);
    fireEvent.click(within(codex).getByRole("switch", { name: ui("settings.tools.switchTitle") }));
    expect(commands()[0]).toMatchObject({ type: "ui.conversation.consent", payload: { granted: true } });
  });

  it("does not show the switch once consent is granted", () => {
    const { container } = renderSettings();
    expect(within(card(container, "codex")).queryByRole("switch", { name: ui("settings.tools.switchTitle") })).toBeNull();
  });
});
