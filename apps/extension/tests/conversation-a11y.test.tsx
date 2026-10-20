import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installAgentPort, project, renderShell, ui, uninstallAgentPort, type FakeAgentPort } from "./helpers/agent-shell-harness.js";
import { CONVERSATION_OPEN, CONVERSATION_READY, emitEvent, installTabStorage, withConversation } from "./helpers/conversation-fixtures.js";

/**
 * 020/T600 - keyboard and screen-reader pass over the new conversation controls (FR-323, the 006
 * bar): the header's list and new buttons, the chips and what they open, the folded steps, the
 * permission card above the message box, and the drawer. Every control has a name a role query
 * finds, keeps its place in the tab order, and says its state; the drawer is the one place the
 * focus is held.
 */

const CONTROL_SELECTOR = "button, input, textarea, select, a[href]";
const CONTROL_ROLES = ["button", "menuitemradio", "radio", "textbox", "searchbox", "checkbox", "link"];

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

function expectNamedAndReachable(root: Element): void {
  const named = new Set<Element>();
  for (const role of CONTROL_ROLES) for (const element of screen.queryAllByRole(role, { name: /\S/ })) named.add(element);
  const controls = [...root.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)];
  expect(controls.length).toBeGreaterThan(0);
  for (const control of controls) {
    const label = `${control.tagName.toLowerCase()} "${control.getAttribute("aria-label") ?? control.textContent?.trim() ?? ""}"`;
    expect(named.has(control), `${label} has no accessible name`).toBe(true);
    expect(control.getAttribute("tabindex"), `${label} is out of the tab order`).not.toBe("-1");
  }
}

const frame = () => document.querySelector(".agent-conversation-frame")!;
const chip = (key: string, value: string) => screen.getByRole("button", { name: ui(key).replace(/\{[a-z]+\}/, value) });

describe("T600 the conversation controls are named, reachable and say their state", () => {
  let port: FakeAgentPort;

  beforeEach(() => {
    port = installAgentPort();
    installTabStorage();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  it("the empty conversation: header, box, chips and each chip's popup", async () => {
    renderShell();
    project(port, withConversation(CONVERSATION_READY));
    await settle();
    expectNamedAndReachable(frame());

    const agent = chip("conversation.chip.agent", "Claude Code");
    expect(agent.getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.click(agent);
    expect(agent.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("menu").id).toBe(agent.getAttribute("aria-controls"));
    expectNamedAndReachable(frame());
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    const mode = chip("conversation.chip.mode", ui("conversation.mode.strict"));
    fireEvent.click(mode);
    expect(mode.getAttribute("aria-expanded")).toBe("true");
    expectNamedAndReachable(frame());
  });

  it("an open conversation: folded steps, the permission card above the box, Stop", async () => {
    renderShell();
    project(port, withConversation(CONVERSATION_OPEN));
    await settle();
    emitEvent(port, 1, { type: "tool", toolCallId: "t-1", kind: "read", title: "Read a.txt", inputSummary: "a.txt", status: "done" });
    emitEvent(port, 2, { type: "tool", toolCallId: "t-2", kind: "read", title: "Read b.txt", inputSummary: "b.txt", status: "done" });
    emitEvent(port, 3, { type: "permission", requestId: "r-1", toolCallId: "t-3", kind: "edit", title: "Write c.txt", detail: "+1 line" });
    expectNamedAndReachable(frame());

    const steps = screen.getByRole("button", { name: ui("conversation.turn.steps").replace("{count}", "2") });
    expect(steps.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(steps);
    expect(steps.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(steps.getAttribute("aria-controls") ?? "")).not.toBeNull();

    const card = screen.getByRole("group", {
      name: ui("conversation.permission.title").replace("{agent}", "Claude Code").replace("{title}", "Write c.txt"),
    });
    const box = screen.getByRole("textbox", { name: ui("conversation.composer.label").replace("{agent}", "Claude Code") });
    expect(card.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("button", { name: ui("conversation.stop") })).toBeTruthy();
  });

  it("the drawer: every control named, Tab held inside, the header button says it is open", async () => {
    renderShell();
    project(port, withConversation(CONVERSATION_OPEN));
    await settle();
    expectNamedAndReachable(frame());

    const list = screen.getByRole("button", { name: ui("conversation.header.list") });
    fireEvent.click(list);
    const drawer = screen.getByRole("dialog", { name: ui("conversation.list.label") });
    expect(list.getAttribute("aria-controls")).toBe(drawer.id);
    expectNamedAndReachable(drawer);
  });
});
