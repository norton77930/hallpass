import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOW, renderSettings, ui } from "./fixtures/settings-harness.js";
import { PROTOTYPE_A_OUTPUT, prototypeAState } from "./fixtures/settings-prototype-a.js";

/** 024 T785 (US7, FR-387, FR-395, D-024-17): Connection & diagnostics. */

const connection = (): HTMLElement => {
  const found = document.querySelector<HTMLElement>("[data-section-body='connection']");
  if (found === null) throw new Error("the Connection section is not shown");
  return found;
};
const diag = (agent: string): HTMLElement => {
  const found = connection().querySelector<HTMLElement>(`[data-diag="${agent}"]`);
  if (found === null) throw new Error(`no output block for ${agent}`);
  return found;
};

describe("T785 the helper and the versions (FR-395)", () => {
  it("says the helper is connected and the versions match", () => {
    renderSettings({ route: "connection" });
    const section = within(connection());
    expect(section.getByText(ui("settings.connection.helperConnected"))).toBeTruthy();
    expect(section.getByText(ui("settings.connection.versionsMatched", { extension: "0.16.0", helper: "0.16.0" }))).toBeTruthy();
  });

  it("says the helper is not connected when the bridge is down", () => {
    renderSettings({ route: "connection", state: { ...prototypeAState(NOW), bridge: "disconnected" } });
    expect(within(connection()).getByText(ui("settings.connection.helperNotConnected"))).toBeTruthy();
  });

  it("says the helper needs updating when the versions do not match, and shows both", () => {
    const state = { ...prototypeAState(NOW), versions: { extension: "0.16.0", host: "0.15.2", match: false } };
    renderSettings({ route: "connection", state });
    expect(within(connection()).getByText(ui("settings.connection.helperNeedsUpdate"))).toBeTruthy();
    expect(within(connection()).getByText(ui("settings.connection.versionsMismatched", { extension: "0.16.0", helper: "0.15.2" }))).toBeTruthy();
  });

  it("says the helper version is unknown before a helper has greeted", () => {
    const state = { ...prototypeAState(NOW), versions: { extension: "0.16.0", match: false } };
    renderSettings({ route: "connection", state: { ...state, bridge: "disconnected" } });
    expect(within(connection()).getByText(ui("settings.connection.versionsUnknown", { extension: "0.16.0" }))).toBeTruthy();
  });
});

describe("T785 the browsers and the rename (FR-395)", () => {
  it("lists the browsers on this computer and marks this one", () => {
    renderSettings({ route: "connection" });
    const list = within(connection()).getByRole("list", { name: ui("settings.connection.browsers") });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("data-browser-self"))).toEqual(["true", "false"]);
    expect(items[0]!.textContent).toContain("Work Chrome");
    expect(items[0]!.textContent).toContain(ui("settings.connection.thisBrowser"));
    expect(items[1]!.textContent).toContain("Edge");
    expect(items[1]!.textContent).not.toContain(ui("settings.connection.thisBrowser"));
  });

  it("renames this browser with the 018 effect: one ui.agent.browser-rename with the trimmed name", async () => {
    const { commands } = renderSettings({ route: "connection" });
    const input = within(connection()).getByLabelText(ui("settings.connection.browserName")) as HTMLInputElement;
    expect(input.value).toBe("Work Chrome");
    expect(within(connection()).getByText(ui("settings.connection.nameHint"))).toBeTruthy();
    fireEvent.change(input, { target: { value: "  Home laptop  " } });
    await act(async () => {
      fireEvent.click(within(connection()).getByRole("button", { name: ui("settings.connection.rename") }));
    });
    expect(commands()[0]).toMatchObject({ type: "ui.agent.browser-rename", payload: { name: "Home laptop" } });
    expect(screen.getByText(ui("settings.connection.renamed", { name: "Home laptop" }))).toBeTruthy();
  });

  it("refuses an empty or over-long name where it is typed, and sends nothing", () => {
    const { send } = renderSettings({ route: "connection" });
    const input = within(connection()).getByLabelText(ui("settings.connection.browserName")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.click(within(connection()).getByRole("button", { name: ui("settings.connection.rename") }));
    expect(within(connection()).getByRole("alert").textContent).toBe(ui("settings.connection.nameInvalid"));
    expect(input.getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(input, { target: { value: "x".repeat(41) } });
    fireEvent.click(within(connection()).getByRole("button", { name: ui("settings.connection.rename") }));
    expect(within(connection()).getByRole("alert")).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
  });

  it("sends the name when Enter is pressed in the field", async () => {
    const { commands } = renderSettings({ route: "connection" });
    const input = within(connection()).getByLabelText(ui("settings.connection.browserName")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Desk" } });
    await act(async () => {
      fireEvent.submit(input.closest("form") as HTMLFormElement);
    });
    expect(commands()[0]).toMatchObject({ type: "ui.agent.browser-rename", payload: { name: "Desk" } });
  });
});

describe("T785 Copy connection details (D-024-17)", () => {
  const written: string[] = [];
  beforeEach(() => {
    written.length = 0;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async (text: string) => void written.push(text)) },
    });
  });
  afterEach(() => {
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("copies the helper, the versions and the browsers, without any user path", async () => {
    renderSettings({ route: "connection" });
    await act(async () => {
      fireEvent.click(within(connection()).getByRole("button", { name: ui("settings.connection.copy") }));
    });
    expect(written).toHaveLength(1);
    const text = written[0]!;
    expect(text).toContain(ui("settings.connection.helperConnected"));
    expect(text).toContain("0.16.0");
    expect(text).toContain("Work Chrome");
    expect(text).not.toMatch(/C:\\|D:\\|Users|AppData|config\.json/u);
    expect(screen.getByText(ui("settings.toast.copied"))).toBeTruthy();
  });
});

describe("T785 each agent's last lines (FR-387)", () => {
  const output = {
    "claude-code": { readAt: new Date(2026, 9, 24, 11, 59, 30).toISOString(), lines: PROTOTYPE_A_OUTPUT["claude-code"] ?? ["line one", "line two"] },
  };

  it("asks for nothing until Show last lines is pressed", () => {
    const { send } = renderSettings({ route: "connection" });
    expect(send).not.toHaveBeenCalled();
    expect(within(diag("claude-code")).queryByRole("log")).toBeNull();
  });

  it("requests one agent's lines on press and says it is reading", async () => {
    const { commands } = renderSettings({ route: "connection" });
    await act(async () => {
      fireEvent.click(within(diag("codex")).getByRole("button", { name: ui("settings.diag.show") }));
    });
    expect(commands()).toHaveLength(1);
    expect(commands()[0]).toMatchObject({ type: "ui.conversation.diagnostics", payload: { agent: "codex" } });
    expect(within(diag("codex")).getByText(ui("settings.diag.reading"))).toBeTruthy();
  });

  it("shows the lines with the time they were read once they arrive, and Hide closes them", async () => {
    const harness = renderSettings({ route: "connection" });
    await act(async () => {
      fireEvent.click(within(diag("claude-code")).getByRole("button", { name: ui("settings.diag.show") }));
    });
    harness.update({ output });
    const block = diag("claude-code");
    expect(within(block).getByText(ui("settings.diag.readAt", { time: "11:59:30" }))).toBeTruthy();
    const pre = block.querySelector("pre");
    expect(pre?.textContent).toBe(output["claude-code"].lines.join("\n"));
    expect(within(block).getByRole("button", { name: ui("settings.diag.hide") }).getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(within(block).getByRole("button", { name: ui("settings.diag.hide") }));
    expect(block.querySelector("pre")).toBeNull();
  });

  it("says an agent printed nothing when the lines are empty", async () => {
    const harness = renderSettings({ route: "connection" });
    await act(async () => {
      fireEvent.click(within(diag("hermes")).getByRole("button", { name: ui("settings.diag.show") }));
    });
    harness.update({ output: { hermes: { readAt: new Date(2026, 9, 24, 12, 0, 0).toISOString(), lines: [] } } });
    expect(within(diag("hermes")).getByText(ui("settings.diag.none"))).toBeTruthy();
  });

  it("copies the lines it shows", async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async (text: string) => void written.push(text)) },
    });
    const harness = renderSettings({ route: "connection" });
    await act(async () => {
      fireEvent.click(within(diag("claude-code")).getByRole("button", { name: ui("settings.diag.show") }));
    });
    harness.update({ output });
    await act(async () => {
      fireEvent.click(within(diag("claude-code")).getByRole("button", { name: ui("settings.diag.copyLabel", { agent: "Claude Code" }) }));
    });
    expect(written).toEqual([output["claude-code"].lines.join("\n")]);
    Reflect.deleteProperty(navigator, "clipboard");
  });
});

describe("T785 the helper is missing (FR-396)", () => {
  const missing = { ...prototypeAState(NOW), bridge: "disconnected" as const, agents: [], agentsUnavailable: "broker-unavailable" as const, versions: { extension: "0.16.0", match: false } };
  const { uploadRoots: _roots, ...withoutRoots } = missing;

  it("still opens, says what is missing, and keeps the extension-side facts", () => {
    renderSettings({ route: "connection", state: withoutRoots });
    const section = within(connection());
    expect(section.getByText(ui("settings.connection.helperNotConnected"))).toBeTruthy();
    expect(section.getByText(ui("settings.helper.missingBody"))).toBeTruthy();
    // This browser's own name and the extension's version are extension-side: usable without the helper.
    expect(section.getByLabelText(ui("settings.connection.browserName"))).toBeTruthy();
    expect(section.getByText(ui("settings.connection.versionsUnknown", { extension: "0.16.0" }))).toBeTruthy();
    expect(section.queryByRole("button", { name: ui("settings.diag.show") })).toBeNull();
  });

  it("makes the Sites section say upload folders need the helper, and keeps the sites usable", () => {
    renderSettings({ route: "sites", state: withoutRoots });
    expect(screen.getByText(ui("settings.uploads.unavailable"))).toBeTruthy();
    expect(document.querySelector("[data-site='https://github.com']")).not.toBeNull();
  });
});
