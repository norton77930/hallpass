import { act, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NOW, renderSettings, ui, withAgent } from "./fixtures/settings-harness.js";
import { prototypeAState } from "./fixtures/settings-prototype-a.js";

/** 024 T779 (US6, FR-386, D-024-13): which agents can use the browser tools, and the one switch that is changeable. */

const tools = (): HTMLElement => {
  const found = document.querySelector<HTMLElement>("[data-section-body='tools']");
  if (found === null) throw new Error("the Browser tools section is not shown");
  return found;
};
const rowOf = (agent: string): HTMLElement => {
  const found = tools().querySelector<HTMLElement>(`tr[data-agent="${agent}"]`);
  if (found === null) throw new Error(`no row for ${agent}`);
  return found;
};

describe("T779 the table (FR-386)", () => {
  it("has one row per agent with its status and a reason", () => {
    renderSettings({ route: "tools" });
    const table = within(tools()).getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
      ui("settings.tools.col.agent"),
      ui("settings.tools.col.tools"),
      ui("settings.tools.col.notes"),
    ]);
    expect(within(table).getAllByRole("row")).toHaveLength(5); // header + four agents

    expect(rowOf("claude-code").textContent).toContain(ui("settings.toolStatus.available"));
    expect(rowOf("claude-code").textContent).toContain(ui("settings.tools.note.claude"));
    expect(rowOf("codex").textContent).toContain(ui("settings.toolStatus.afterHelper"));
    expect(rowOf("codex").textContent).toContain(ui("settings.tools.note.codexPending"));
    expect(rowOf("hermes").textContent).toContain(ui("settings.toolStatus.needsComponent"));
    expect(rowOf("hermes").textContent).toContain(ui("settings.tools.note.hermes"));
    expect(rowOf("deepseek").textContent).toContain(ui("settings.toolStatus.notSupported"));
    expect(rowOf("deepseek").textContent).toContain(ui("settings.tools.note.deepseek"));
  });

  it("follows the helper: Codex is available once its helper is there", () => {
    const state = withAgent(prototypeAState(NOW), "codex", (entry) => ({ ...entry, availability: "ready", version: "0.48.0", browserTools: "available" }));
    renderSettings({ route: "tools", state });
    expect(rowOf("codex").textContent).toContain(ui("settings.toolStatus.available"));
    expect(rowOf("codex").textContent).toContain(ui("settings.tools.note.codex"));
  });

  it("says plainly that the table is read-only, and has no control in it", () => {
    renderSettings({ route: "tools" });
    expect(within(tools()).getByText(ui("settings.tools.readOnly"))).toBeTruthy();
    const table = within(tools()).getByRole("table");
    expect(within(table).queryAllByRole("button")).toHaveLength(0);
    expect(within(table).queryAllByRole("switch")).toHaveLength(0);
    expect(within(table).queryAllByRole("checkbox")).toHaveLength(0);
  });
});

describe("T779 the side-panel switch (FR-386)", () => {
  it("is above the table and shows the consent the worker projected", () => {
    renderSettings({ route: "tools" });
    const toggle = within(tools()).getByRole("switch", { name: ui("settings.tools.switchTitle") });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(within(tools()).getByText(ui("settings.tools.switchOn"))).toBeTruthy();
    expect(within(tools()).getByText(ui("settings.tools.switchDesc"))).toBeTruthy();
    expect(toggle.compareDocumentPosition(within(tools()).getByRole("table")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("says Off when withdrawn, and the first-time wording when not yet asked", () => {
    const withdrawn = renderSettings({ route: "tools", state: { ...prototypeAState(NOW), consent: "withdrawn" } });
    expect(within(tools()).getByRole("switch", { name: ui("settings.tools.switchTitle") }).getAttribute("aria-checked")).toBe("false");
    expect(within(tools()).getByText(ui("settings.tools.switchOff"))).toBeTruthy();
    withdrawn.unmount();
    renderSettings({ route: "tools", state: { ...prototypeAState(NOW), consent: "unknown" } });
    expect(within(tools()).getByText(ui("settings.tools.switchUnknown"))).toBeTruthy();
  });

  it("asks to withdraw when it is on, and to grant when it is off, and waits for the projection", async () => {
    const harness = renderSettings({ route: "tools" });
    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: ui("settings.tools.switchTitle") }));
    });
    expect(harness.commands()[0]).toMatchObject({ type: "ui.conversation.consent", payload: { granted: false } });
    // The switch shows what the worker last projected; a press only asks.
    expect(screen.getByRole("switch", { name: ui("settings.tools.switchTitle") }).getAttribute("aria-checked")).toBe("true");
    harness.project({ ...prototypeAState(NOW), consent: "withdrawn" });
    expect(screen.getByRole("switch", { name: ui("settings.tools.switchTitle") }).getAttribute("aria-checked")).toBe("false");
    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: ui("settings.tools.switchTitle") }));
    });
    expect(harness.commands()[1]).toMatchObject({ type: "ui.conversation.consent", payload: { granted: true } });
  });
});

describe("T780 when the helper cannot say (FR-396)", () => {
  it("still shows the switch and says the helper is needed for the table", () => {
    renderSettings({ route: "tools", state: { ...prototypeAState(NOW), agents: [], agentsUnavailable: "broker-unavailable" } });
    expect(within(tools()).getByRole("switch", { name: ui("settings.tools.switchTitle") })).toBeTruthy();
    expect(within(tools()).queryByRole("table")).toBeNull();
    expect(within(tools()).getByText(ui("settings.helper.missingBody"))).toBeTruthy();
  });
});
