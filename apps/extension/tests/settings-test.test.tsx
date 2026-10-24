import { act, fireEvent, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ConversationAgentAvailability } from "@hallpass/contracts";
import { NOW, refusedSend, renderSettings, ui, withAgent } from "./fixtures/settings-harness.js";
import { prototypeAState } from "./fixtures/settings-prototype-a.js";

/** 024 T768 (US3, FR-381, D-024-10, R-379): Test says what it costs, shows it is running, and keeps its result. */

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
const testButton = (cardElement: HTMLElement, agent: string): HTMLButtonElement =>
  within(cardElement).getByRole("button", { name: ui("settings.test.label", { agent }) }) as HTMLButtonElement;

const RAN_AT = new Date(2026, 9, 24, 9, 41, 0).toISOString();
const passed = (ranAt = RAN_AT): NonNullable<ConversationAgentAvailability["lastTest"]> => ({
  outcome: "passed",
  start: "ok",
  model: { answered: true, ms: 1800 },
  browserTools: "available",
  ranAt,
});

describe("T768 pressing Test (FR-381)", () => {
  it("says it makes one model call, and sends the test command for that agent", () => {
    const { container, commands } = renderSettings();
    const claude = card(container, "claude-code");
    fireEvent.click(disclosure(claude)); // Claude Code is ready without warnings: closed at first
    expect(within(claude).getByText(ui("settings.test.cost"))).toBeTruthy();
    const button = testButton(claude, "Claude Code");
    expect(button.textContent).toBe(ui("settings.test.button"));
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(commands()[0]).toMatchObject({ type: "ui.conversation.test", payload: { agent: "claude-code" } });
  });

  it("shows Testing and disables the button from the press until the worker reports a result", async () => {
    const harness = renderSettings();
    const claude = card(harness.container, "claude-code");
    fireEvent.click(disclosure(claude));
    await act(async () => {
      fireEvent.click(testButton(claude, "Claude Code"));
    });
    const button = testButton(claude, "Claude Code");
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain(ui("settings.test.running"));
    expect(harness.send).toHaveBeenCalledTimes(1);

    harness.project(withAgent(prototypeAState(NOW), "claude-code", (entry) => ({ ...entry, lastTest: passed() })));
    const after = testButton(card(harness.container, "claude-code"), "Claude Code");
    expect(after.disabled).toBe(false);
    expect(after.textContent).toBe(ui("settings.test.again"));
  });

  it("shows Testing when the worker says a test is running, from another page too", () => {
    const state = withAgent(prototypeAState(NOW), "claude-code", (entry) => ({ ...entry, testing: true }));
    const { container } = renderSettings({ state });
    const claude = card(container, "claude-code");
    fireEvent.click(disclosure(claude));
    const button = testButton(claude, "Claude Code");
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain(ui("settings.test.running"));
  });

  it("lets the owner press again if the command was refused", async () => {
    const { container } = renderSettings({ send: refusedSend() });
    const claude = card(container, "claude-code");
    fireEvent.click(disclosure(claude));
    await act(async () => {
      fireEvent.click(testButton(claude, "Claude Code"));
    });
    expect(testButton(claude, "Claude Code").disabled).toBe(false);
  });
});

describe("T769 the result line (FR-381, R-379)", () => {
  const lastTest = (change: Partial<NonNullable<ConversationAgentAvailability["lastTest"]>>) =>
    withAgent(prototypeAState(NOW), "claude-code", (entry) => ({ ...entry, lastTest: { ...passed(), ...change } }));

  const resultLine = (container: HTMLElement): HTMLElement => {
    const found = card(container, "claude-code").querySelector<HTMLElement>("[data-test-outcome]");
    if (found === null) throw new Error("no result line");
    return found;
  };

  it("says passed, with the model's answer time and the tools", () => {
    const { container } = renderSettings({ state: lastTest({}) });
    fireEvent.click(disclosure(card(container, "claude-code")));
    const line = resultLine(container);
    expect(line.getAttribute("data-test-outcome")).toBe("passed");
    expect(line.textContent).toContain("1800");
    expect(line.textContent).toContain(ui("settings.test.lastTest", { time: "09:41" }));
  });

  it("says partial with what to do next", () => {
    const { container } = renderSettings({ state: lastTest({ outcome: "partial", browserTools: "missing-component" }) });
    fireEvent.click(disclosure(card(container, "claude-code")));
    const line = resultLine(container);
    expect(line.getAttribute("data-test-outcome")).toBe("partial");
    expect(line.textContent).toContain(ui("settings.test.partialHint"));
  });

  it("says failed in words for a program that would not start", () => {
    const { container } = renderSettings({
      state: lastTest({ outcome: "failed", start: "agent-exited", model: { answered: false, reason: "agent-exited" }, browserTools: "not-supported" }),
    });
    fireEvent.click(disclosure(card(container, "claude-code")));
    const line = resultLine(container);
    expect(line.getAttribute("data-test-outcome")).toBe("failed");
    expect(line.textContent).toContain(ui("settings.test.failed.start"));
  });

  it("keeps the result across closing and opening the card", () => {
    const { container } = renderSettings({ state: lastTest({}) });
    const claude = card(container, "claude-code");
    fireEvent.click(disclosure(claude));
    expect(claude.querySelector("[data-test-outcome]")).not.toBeNull();
    fireEvent.click(disclosure(claude));
    expect(claude.querySelector("[data-test-outcome]")).toBeNull();
    fireEvent.click(disclosure(claude));
    expect(resultLine(container).getAttribute("data-test-outcome")).toBe("passed");
  });

  it("keeps the result across a new projection without a new test", () => {
    const harness = renderSettings({ state: lastTest({}) });
    fireEvent.click(disclosure(card(harness.container, "claude-code")));
    harness.project(lastTest({}));
    expect(resultLine(harness.container).getAttribute("data-test-outcome")).toBe("passed");
  });
});

describe("T768 Test when it cannot run (FR-381)", () => {
  it("is greyed with its reason for an agent that is not ready", () => {
    const { container } = renderSettings();
    const codex = card(container, "codex");
    const button = testButton(codex, "Codex");
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toBe(ui("settings.test.unavailable"));
  });

  it("is greyed with its reason for an agent that is switched off", () => {
    const state = { ...prototypeAState(NOW), choices: { ...prototypeAState(NOW).choices, enabled: { ...prototypeAState(NOW).choices.enabled, "claude-code": false } } };
    const { container } = renderSettings({ state });
    const claude = card(container, "claude-code");
    fireEvent.click(disclosure(claude));
    const button = testButton(claude, "Claude Code");
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toBe(ui("settings.test.unavailable"));
  });
});
