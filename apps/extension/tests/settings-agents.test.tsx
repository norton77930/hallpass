import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { settingsStateSchema } from "@hallpass/contracts";
import { prototypeAState } from "./fixtures/settings-prototype-a.js";
import { NOW, agentEntry, okSend, renderSettings, ui, withAgent } from "./fixtures/settings-harness.js";

/**
 * 024 T756 / T772 - the Agents section from the projection alone: each agent's state (R-374), the
 * collapsed row, which cards start open, and the navigation's counts. The data is prototype A's.
 */
afterEach(cleanup);

/** The card's name button - the only one with aria-expanded. */
const disclosure = (cardElement: HTMLElement): HTMLElement => {
  const found = cardElement.querySelector<HTMLElement>("button[aria-expanded]");
  if (found === null) throw new Error("no disclosure button");
  return found;
};
const card = (container: HTMLElement, agent: string): HTMLElement => {
  const found = container.querySelector<HTMLElement>(`[data-agent="${agent}"]`);
  if (found === null) throw new Error(`no card for ${agent}`);
  return found;
};

describe("T756 the fixture is a settings projection", () => {
  it("parses with the contract's own schema", () => {
    expect(() => settingsStateSchema.parse(prototypeAState(NOW))).not.toThrow();
  });
});

describe("T756 state mapping (R-374, D-024-14)", () => {
  it("shows one of five states per agent, read from the overview entry", () => {
    const { container } = renderSettings();
    expect(card(container, "claude-code").getAttribute("data-state")).toBe("ready");
    expect(within(card(container, "claude-code")).getByText(ui("settings.state.ready"))).toBeTruthy();
    expect(card(container, "codex").getAttribute("data-state")).toBe("needsDownload");
    expect(within(card(container, "codex")).getByText(ui("settings.state.needsDownload"))).toBeTruthy();
    expect(card(container, "hermes").getAttribute("data-state")).toBe("readyWarnings");
    expect(within(card(container, "hermes")).getByText(ui("settings.state.readyWarnings"))).toBeTruthy();
    expect(card(container, "deepseek").getAttribute("data-state")).toBe("downloading");
    expect(within(card(container, "deepseek")).getByText(ui("settings.state.downloading"))).toBeTruthy();
  });

  it("maps a program that is not there, or whose version cannot be read, to Not installed", () => {
    const missing = withAgent(prototypeAState(NOW), "claude-code", () => ({ agent: "claude-code", availability: "missing" }));
    const first = renderSettings({ state: missing });
    expect(card(first.container, "claude-code").getAttribute("data-state")).toBe("notInstalled");
    expect(within(card(first.container, "claude-code")).getByText(ui("settings.state.notInstalled"))).toBeTruthy();
    first.unmount();

    const unreadable = withAgent(prototypeAState(NOW), "claude-code", () => ({
      agent: "claude-code",
      availability: "version-problem",
      detail: "Claude Code was found, but `--version` did not print a version number.",
    }));
    const second = renderSettings({ state: unreadable });
    expect(card(second.container, "claude-code").getAttribute("data-state")).toBe("notInstalled");
  });

  it("says Helper missing only for an agent that needs the download; a missing program's prerequisites wait for it", () => {
    const missing = withAgent(prototypeAState(NOW), "claude-code", () => ({ agent: "claude-code", availability: "missing" }));
    const { container } = renderSettings({ state: missing });
    if (disclosure(card(container, "claude-code")).getAttribute("aria-expanded") !== "true") fireEvent.click(disclosure(card(container, "claude-code")));
    const claude = within(card(container, "claude-code"));
    expect(claude.queryByText(ui("settings.check.helperMissing"))).toBeNull();
    expect(claude.getByText(ui("settings.check.afterDownload"))).toBeTruthy();
    expect(within(card(container, "codex")).getByText(ui("settings.check.helperMissing"))).toBeTruthy();
  });

  it("maps a ready agent with a note to Ready with warnings, and one without to Ready", () => {
    const noted = withAgent(prototypeAState(NOW), "claude-code", (entry) => ({ ...entry, notes: ["pre-release"] }));
    const { container } = renderSettings({ state: noted });
    expect(card(container, "claude-code").getAttribute("data-state")).toBe("readyWarnings");
  });

  it("keeps an agent that was switched off in its state, dims it, and shows the switch off (FR-377)", () => {
    const state = prototypeAState(NOW);
    const off = { ...state, choices: { enabled: { ...state.choices.enabled, hermes: false }, default: state.choices.default } };
    const { container } = renderSettings({ state: off });
    const hermes = card(container, "hermes");
    expect(hermes.getAttribute("data-state")).toBe("readyWarnings");
    expect(within(hermes).getByText(ui("settings.state.readyWarnings"))).toBeTruthy();
    expect(hermes.getAttribute("data-enabled")).toBe("false");
    expect(hermes.className).toContain("is-off");
    expect(within(hermes).getByRole("switch", { name: ui("settings.card.enabledLabel", { agent: "Hermes" }) }).getAttribute("aria-checked")).toBe("false");
  });
});

describe("T756 the collapsed row and which cards start open (FR-377)", () => {
  it("starts the cards that need a download or carry warnings open, and the others closed", () => {
    const { container } = renderSettings();
    const open = (agent: string): string | null =>
      disclosure(card(container, agent)).getAttribute("aria-expanded");
    expect(open("codex")).toBe("true");
    expect(open("hermes")).toBe("true");
    expect(open("claude-code")).toBe("false");
    expect(open("deepseek")).toBe("false");
  });

  it("shows on a collapsed row the name, state, default mark, Enabled switch and the download's bar", () => {
    const { container } = renderSettings();
    const claude = card(container, "claude-code");
    expect(within(claude).getByText(ui("settings.card.default"))).toBeTruthy();
    expect(within(claude).getByRole("switch", { name: ui("settings.card.enabledLabel", { agent: "Claude Code" }) }).getAttribute("aria-checked")).toBe("true");
    // Closed: the checks and the actions are not in the page.
    expect(within(claude).queryByText(ui("settings.check.version"))).toBeNull();

    const deepseek = card(container, "deepseek");
    const bar = within(deepseek).getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("42");
    expect(within(deepseek).getByText("42 %")).toBeTruthy();
  });

  it("shows the warning count on a collapsed row that has warnings, in the singular for one", () => {
    const { container } = renderSettings();
    const hermes = card(container, "hermes");
    fireEvent.click(disclosure(hermes));
    expect(within(hermes).getByText(ui("settings.card.warnings", { count: 2 }))).toBeTruthy();

    const one = withAgent(prototypeAState(NOW), "claude-code", (entry) => ({ ...entry, notes: ["pre-release"] }));
    const other = renderSettings({ state: one });
    const claude = card(other.container, "claude-code");
    fireEvent.click(disclosure(claude));
    expect(within(claude).getByText(ui("settings.card.warningsOne", { count: 1 }))).toBeTruthy();
  });

  it("opens a collapsed card when its name is activated, and closes it when activated again", () => {
    const { container } = renderSettings();
    const claude = card(container, "claude-code");
    const name = disclosure(claude);
    fireEvent.click(name);
    expect(name.getAttribute("aria-expanded")).toBe("true");
    expect(within(claude).getByText(ui("settings.check.version"))).toBeTruthy();
    expect(within(claude).getByText(/v2\.1\.4/)).toBeTruthy();
    fireEvent.click(name);
    expect(name.getAttribute("aria-expanded")).toBe("false");
    expect(within(claude).queryByText(ui("settings.check.version"))).toBeNull();
  });

  it("keeps a card the owner opened open when the projection changes", () => {
    const harness = renderSettings();
    const claude = card(harness.container, "claude-code");
    fireEvent.click(disclosure(claude));
    harness.project(withAgent(prototypeAState(NOW), "claude-code", (entry) => ({ ...entry, notes: ["pre-release"] })));
    expect(disclosure(card(harness.container, "claude-code")).getAttribute("aria-expanded")).toBe("true");
  });

  it("opens the card a route names (#agents/<agent>)", () => {
    const { container } = renderSettings({ route: { section: "agents", agent: "deepseek" } });
    expect(disclosure(card(container, "deepseek")).getAttribute("aria-expanded")).toBe("true");
  });
});

describe("T756 the navigation and the summary (FR-376)", () => {
  it("names the four sections, with the ready count, the site count and a mark for a warning", () => {
    renderSettings();
    const nav = screen.getByRole("navigation", { name: ui("settings.nav.label") });
    const agents = within(nav).getByRole("button", { name: new RegExp(ui("settings.nav.agents")) });
    expect(agents.textContent).toContain("1/4");
    expect(within(agents).getByText(ui("settings.nav.warningMark"))).toBeTruthy();
    expect(within(nav).getByRole("button", { name: new RegExp(ui("settings.nav.sites")) }).textContent).toContain("3");
    expect(within(nav).getByRole("button", { name: new RegExp(ui("settings.nav.tools")) })).toBeTruthy();
    expect(within(nav).getByRole("button", { name: new RegExp(ui("settings.nav.connection")) })).toBeTruthy();
    expect(agents.getAttribute("aria-current")).toBe("page");
  });

  it("summarises ready, downloading, needing attention and warned agents", () => {
    renderSettings();
    expect(screen.getByText(ui("settings.summary.ready", { ready: 1, total: 4 }))).toBeTruthy();
    expect(screen.getByText(ui("settings.summary.downloading", { count: 1 }))).toBeTruthy();
    expect(screen.getByText(ui("settings.summary.attention", { count: 1 }))).toBeTruthy();
    expect(screen.getByText(ui("settings.summary.warnings", { count: 1 }))).toBeTruthy();
  });

  it("shows no warning mark when no enabled agent has a warning", () => {
    const state = withAgent(prototypeAState(NOW), "hermes", (entry) => ({
      agent: "hermes",
      availability: "ready",
      ...(entry.version === undefined ? {} : { version: entry.version }),
    }));
    renderSettings({ state });
    expect(screen.queryByText(ui("settings.nav.warningMark"))).toBeNull();
  });

  it("goes to a section when its entry is pressed, and says so in the address", () => {
    const harness = renderSettings();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(ui("settings.nav.tools")) }));
    expect(harness.routes.at(-1)).toEqual({ section: "tools" });
    expect(screen.getByRole("heading", { level: 2, name: ui("settings.nav.tools") })).toBeTruthy();
  });
});

describe("T757 the open card and Check again", () => {
  it("shows the agent's version and, for Hermes, that the owner installed it", () => {
    const { container } = renderSettings();
    expect(within(card(container, "hermes")).getByText(/v0\.22\.2/).textContent).toContain(ui("settings.card.installedByYou"));
  });

  it("sends Check again for Hermes only, and says what happened", async () => {
    const send = okSend();
    const { container } = renderSettings({ send });
    send.mockClear();
    fireEvent.click(within(card(container, "hermes")).getByRole("button", { name: ui("settings.action.checkAgain") }));
    expect(send.mock.calls[0]?.[0]).toEqual({ type: "ui.conversation.check-agents", payload: { agent: "hermes" } });
    expect(await screen.findByText(ui("settings.notice.checked"))).toBeTruthy();
  });
});

describe("T772 the Enabled switch, Make default and the default mark (FR-382, FR-383)", () => {
  it("sends the switch as one choices-set with the agent turned the other way", () => {
    const send = okSend();
    const { container } = renderSettings({ send });
    send.mockClear();
    fireEvent.click(within(card(container, "deepseek")).getByRole("switch", { name: ui("settings.card.enabledLabel", { agent: "DeepSeek" }) }));
    expect(send.mock.calls[0]?.[0]).toEqual({ type: "ui.settings.choices-set", payload: { enabled: { deepseek: false } } });
  });

  it("marks the default and offers Make default on a ready, enabled agent that is not it", () => {
    const state = withAgent(prototypeAState(NOW), "hermes", () => ({ agent: "hermes", availability: "ready", version: "0.22.2" }));
    const send = okSend();
    const { container } = renderSettings({ state, send });
    send.mockClear();
    const claude = card(container, "claude-code");
    expect(within(claude).getByText(ui("settings.card.default"))).toBeTruthy();
    expect(within(claude).queryByRole("button", { name: ui("settings.card.makeDefaultLabel", { agent: "Claude Code" }) })).toBeNull();
    const hermes = card(container, "hermes");
    expect(within(hermes).queryByText(ui("settings.card.default"))).toBeNull();
    fireEvent.click(within(hermes).getByRole("button", { name: ui("settings.card.makeDefaultLabel", { agent: "Hermes" }) }));
    expect(send.mock.calls[0]?.[0]).toEqual({ type: "ui.settings.choices-set", payload: { default: "hermes" } });
  });

  it("shows Make default greyed with its reason for an agent that is not ready or not enabled", () => {
    const state = prototypeAState(NOW);
    const off = { ...state, choices: { enabled: { ...state.choices.enabled, hermes: false }, default: state.choices.default } };
    const { container } = renderSettings({ state: off });
    const codex = within(card(container, "codex")).getByRole("button", { name: ui("settings.card.makeDefaultLabel", { agent: "Codex" }) });
    expect((codex as HTMLButtonElement).disabled).toBe(true);
    expect(codex.getAttribute("title")).toBe(ui("settings.card.defaultReason.notReady"));
    expect(document.getElementById(codex.getAttribute("aria-describedby") ?? "")?.textContent).toBe(ui("settings.card.defaultReason.notReady"));
    const hermes = within(card(container, "hermes")).getByRole("button", { name: ui("settings.card.makeDefaultLabel", { agent: "Hermes" }) });
    expect((hermes as HTMLButtonElement).disabled).toBe(true);
    expect(hermes.getAttribute("title")).toBe(ui("settings.card.defaultReason.off"));
  });

  it("tells the owner which agent the default moved to, and that there is none when none can take it", async () => {
    const moved = okSend({ defaultMovedTo: "hermes" });
    const first = renderSettings({ send: moved });
    fireEvent.click(within(card(first.container, "claude-code")).getByRole("switch", { name: ui("settings.card.enabledLabel", { agent: "Claude Code" }) }));
    expect(await screen.findByText(ui("settings.default.moved", { agent: "Hermes" }))).toBeTruthy();
    first.unmount();

    const none = okSend({ defaultMovedTo: null });
    const second = renderSettings({ send: none });
    fireEvent.click(within(card(second.container, "claude-code")).getByRole("switch", { name: ui("settings.card.enabledLabel", { agent: "Claude Code" }) }));
    expect(await screen.findByText(ui("settings.default.none"))).toBeTruthy();
  });

  it("says a command failed in the owner's words", async () => {
    const send = okSend();
    send.mockImplementation(async () => ({ commandId: "t", ok: false, error: { code: "invalid-command" } }));
    const { container } = renderSettings({ send });
    send.mockClear();
    fireEvent.click(within(card(container, "deepseek")).getByRole("switch", { name: ui("settings.card.enabledLabel", { agent: "DeepSeek" }) }));
    expect(await screen.findByText(ui("settings.error.generic"))).toBeTruthy();
  });

  it("reads the default from the owner's choice, not from the entry", () => {
    const state = prototypeAState(NOW);
    const moved = { ...state, choices: { ...state.choices, default: "hermes" as const } };
    const { container } = renderSettings({ state: moved });
    expect(within(card(container, "hermes")).getByText(ui("settings.card.default"))).toBeTruthy();
    expect(agentEntry(moved, "hermes").agent).toBe("hermes");
    expect(within(card(container, "claude-code")).queryByText(ui("settings.card.default"))).toBeNull();
  });
});
