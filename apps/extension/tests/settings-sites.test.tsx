import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lookup } from "../src/locales/catalog.js";
import { NOW, renderSettings, ui } from "./fixtures/settings-harness.js";
import { prototypeAState } from "./fixtures/settings-prototype-a.js";

/**
 * 024 T776 (US5, FR-385, D-024-21): Sites & permissions - outside agents, then sites, then upload
 * folders (Remove only); a mode changes at once, a revoke is confirmed and can be undone.
 */

const sites = (): HTMLElement => {
  const found = document.querySelector<HTMLElement>("[data-section-body='sites']");
  if (found === null) throw new Error("the Sites section is not shown");
  return found;
};
const row = (site: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(`[data-site="${site}"]`);
  if (found === null) throw new Error(`no row for ${site}`);
  return found;
};

describe("T776 what the section shows, in order (FR-385)", () => {
  it("shows outside agents, then sites, then upload folders", () => {
    renderSettings({ route: "sites" });
    const headings = within(sites()).getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual([ui("settings.outside.title"), ui("settings.sites.title"), ui("settings.uploads.title")]);
  });

  it("lists a paired outside agent with where it came from and when, and unpairs it", async () => {
    const { commands } = renderSettings({ route: "sites" });
    const outside = within(sites()).getByRole("region", { name: ui("settings.outside.title") });
    expect(within(outside).getByText("Claude Code")).toBeTruthy();
    expect(within(outside).getByText(ui("settings.outside.last", { where: ui("settings.outside.from.terminal"), time: "10:38" }))).toBeTruthy();
    expect(within(outside).getByText(ui("settings.outside.last", { where: ui("settings.outside.from.editor"), time: "yesterday" }))).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(outside).getByRole("button", { name: ui("settings.outside.unpairLabel", { name: "Claude Code" }) }));
    });
    expect(commands()[0]).toMatchObject({ type: "ui.agent.unpair", payload: { agentId: "agent-cc" } });
    expect(screen.getByText(ui("settings.outside.unpaired", { name: "Claude Code" }))).toBeTruthy();
  });

  it("says no outside agent is paired when none is", () => {
    renderSettings({ route: "sites", state: { ...prototypeAState(NOW), paired: [] } });
    expect(screen.getByText(ui("settings.outside.none"))).toBeTruthy();
  });

  it("writes https sites without the scheme and keeps http and ports visible", () => {
    renderSettings({ route: "sites" });
    expect(row("https://github.com").textContent).toContain("github.com");
    expect(row("https://github.com").textContent).not.toContain("https://");
    expect(row("http://localhost:5173").textContent).toContain("http://localhost:5173");
  });
});

describe("T776 changing a mode (FR-385)", () => {
  it("shows the three modes with the current one chosen, and its meaning", () => {
    renderSettings({ route: "sites" });
    const group = within(row("https://docs.example.test")).getByRole("radiogroup", { name: ui("settings.sites.modeFor", { site: "docs.example.test" }) });
    const radios = within(group).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((radio) => [radio.value, radio.checked])).toEqual([
      ["ask", false],
      ["follow-a-plan", true],
      ["skip-checks", false],
    ]);
    expect(within(row("https://docs.example.test")).getByText(ui("settings.mode.follow-a-plan.meaning"))).toBeTruthy();
  });

  it("sends the change at once and says what it did", async () => {
    const { commands } = renderSettings({ route: "sites" });
    await act(async () => {
      fireEvent.click(within(row("https://github.com")).getByRole("radio", { name: ui("settings.mode.skip-checks") }));
    });
    expect(commands()[0]).toMatchObject({ type: "ui.agent.site-mode", payload: { site: "https://github.com", mode: "skip-checks" } });
    expect(screen.getByText(ui("settings.sites.modeChanged", { site: "github.com", mode: ui("settings.mode.skip-checks") }))).toBeTruthy();
  });

  it("sends nothing when the current mode is chosen again", () => {
    const { send } = renderSettings({ route: "sites" });
    fireEvent.click(within(row("https://github.com")).getByRole("radio", { name: ui("settings.mode.ask") }));
    expect(send).not.toHaveBeenCalled();
  });

  it("marks the mode that acts without asking", () => {
    renderSettings({ route: "sites" });
    const skip = within(row("http://localhost:5173")).getByRole("radio", { name: ui("settings.mode.skip-checks") });
    expect(skip.closest("label")?.className).toContain("skip-checks");
  });
});

describe("T776 revoking a site (FR-385)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks first, and Keep sends nothing", () => {
    const { send } = renderSettings({ route: "sites" });
    const github = row("https://github.com");
    fireEvent.click(within(github).getByRole("button", { name: ui("settings.sites.revokeLabel", { site: "github.com" }) }));
    expect(within(github).getByRole("alert").textContent).toContain(ui("settings.sites.revokeConfirm", { site: "github.com" }));
    fireEvent.click(within(github).getByRole("button", { name: ui("settings.sites.keep") }));
    expect(within(github).queryByRole("alert")).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it("revokes on confirmation and offers Undo, which puts the mode back", async () => {
    const harness = renderSettings({ route: "sites" });
    const docs = row("https://docs.example.test");
    fireEvent.click(within(docs).getByRole("button", { name: ui("settings.sites.revokeLabel", { site: "docs.example.test" }) }));
    await act(async () => {
      fireEvent.click(within(docs).getByRole("button", { name: ui("settings.sites.revoke") }));
    });
    expect(harness.commands()[0]).toMatchObject({ type: "ui.agent.site-clear", payload: { site: "https://docs.example.test" } });
    expect(screen.getByText(ui("settings.sites.revoked", { site: "docs.example.test" }))).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: ui("settings.sites.undo") }));
    });
    expect(harness.commands()[1]).toMatchObject({
      type: "ui.agent.site-mode",
      payload: { site: "https://docs.example.test", mode: "follow-a-plan" },
    });
  });

  it("lets the Undo go after a few seconds", async () => {
    renderSettings({ route: "sites" });
    const github = row("https://github.com");
    fireEvent.click(within(github).getByRole("button", { name: ui("settings.sites.revokeLabel", { site: "github.com" }) }));
    await act(async () => {
      fireEvent.click(within(github).getByRole("button", { name: ui("settings.sites.revoke") }));
    });
    expect(screen.getByRole("button", { name: ui("settings.sites.undo") })).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(8_000);
    });
    expect(screen.queryByRole("button", { name: ui("settings.sites.undo") })).toBeNull();
  });
});

/** The fixture with one site's record changed, the rest as they are. */
function withSite(site: string, patch: Record<string, unknown>): ReturnType<typeof prototypeAState> {
  const state = prototypeAState(NOW);
  return { ...state, sites: state.sites.map((record) => (record.site === site ? { ...record, ...patch } : record)) };
}

describe("004 FR-049: the diagnostics grant on a site's row, a consent of its own (FR-385)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the grant as it stands and sends a grant or a revoke for that site alone", async () => {
    const { commands } = renderSettings({ route: "sites", state: withSite("https://docs.example.test", { diagnosticsGranted: true }) });
    const docs = within(row("https://docs.example.test")).getByRole("checkbox", {
      name: ui("settings.sites.diagnosticsLabel", { site: "docs.example.test" }),
    }) as HTMLInputElement;
    const github = within(row("https://github.com")).getByRole("checkbox", {
      name: ui("settings.sites.diagnosticsLabel", { site: "github.com" }),
    }) as HTMLInputElement;
    expect([docs.checked, github.checked]).toEqual([true, false]);
    expect(row("https://github.com").textContent).toContain(ui("settings.sites.diagnostics"));

    await act(async () => {
      fireEvent.click(github);
    });
    await act(async () => {
      fireEvent.click(docs);
    });
    expect(commands().map(({ type, payload }) => ({ type, payload }))).toEqual([
      { type: "ui.agent.set-diagnostics", payload: { site: "https://github.com", granted: true } },
      { type: "ui.agent.set-diagnostics", payload: { site: "https://docs.example.test", granted: false } },
    ]);
  });

  it("Undo after a revoke gives the grant back when it was on, and only then", async () => {
    const granted = renderSettings({ route: "sites", state: withSite("https://docs.example.test", { diagnosticsGranted: true }) });
    const docs = row("https://docs.example.test");
    fireEvent.click(within(docs).getByRole("button", { name: ui("settings.sites.revokeLabel", { site: "docs.example.test" }) }));
    await act(async () => {
      fireEvent.click(within(docs).getByRole("button", { name: ui("settings.sites.revoke") }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: ui("settings.sites.undo") }));
    });
    expect(granted.commands().map(({ type, payload }) => ({ type, payload }))).toEqual([
      { type: "ui.agent.site-clear", payload: { site: "https://docs.example.test" } },
      { type: "ui.agent.site-mode", payload: { site: "https://docs.example.test", mode: "follow-a-plan" } },
      { type: "ui.agent.set-diagnostics", payload: { site: "https://docs.example.test", granted: true } },
    ]);
    granted.unmount();

    const plain = renderSettings({ route: "sites" });
    const github = row("https://github.com");
    fireEvent.click(within(github).getByRole("button", { name: ui("settings.sites.revokeLabel", { site: "github.com" }) }));
    await act(async () => {
      fireEvent.click(within(github).getByRole("button", { name: ui("settings.sites.revoke") }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: ui("settings.sites.undo") }));
    });
    expect(plain.commands().map((command) => command.type)).toEqual(["ui.agent.site-clear", "ui.agent.site-mode"]);
  });
});

describe("019 FR-308: a site's row says who changed it last (FR-385)", () => {
  it("names the side-panel agent, an outside agent or the owner", () => {
    const state = prototypeAState(NOW);
    const authors = ["panel-agent", "external-agent", "owner"] as const;
    renderSettings({
      route: "sites",
      state: { ...state, sites: state.sites.map((record, index) => (index < authors.length ? { ...record, changedBy: authors[index] } : record)) },
    });
    expect(row("https://github.com").textContent).toContain(ui("settings.sites.changedBy.panel-agent"));
    expect(row("https://docs.example.test").textContent).toContain(ui("settings.sites.changedBy.external-agent"));
    expect(row("http://localhost:5173").textContent).toContain(ui("settings.sites.changedBy.owner"));
  });

  it("names nobody for a record that carries no author", () => {
    renderSettings({ route: "sites" });
    for (const author of ["panel-agent", "external-agent", "owner"]) {
      expect(row("https://github.com").textContent).not.toContain(ui(`settings.sites.changedBy.${author}`));
    }
  });

  it("says the side-panel agent in the words the panel's row used, in both locales (019's gate reads them)", () => {
    for (const locale of ["en-US", "zh-TW"] as const) {
      expect(lookup("settings.sites.changedBy.panel-agent", locale), locale).toBe(lookup("agent.siteChangedBy.panel-agent", locale));
    }
  });
});

describe("T776 the empty state and the deep link (FR-385, R-372)", () => {
  it("says how a site gets here when there are none", () => {
    renderSettings({ route: "sites", state: { ...prototypeAState(NOW), sites: [] } });
    expect(screen.getByText(ui("settings.sites.empty"))).toBeTruthy();
  });

  it("marks the site #sites?site=<origin> names, and scrolls it into view", () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    renderSettings({ route: { section: "sites", site: "https://github.com" } });
    const github = row("https://github.com");
    expect(github.className).toContain("flash");
    expect(github.getAttribute("aria-current")).toBe("true");
    expect(within(sites()).getByText(ui("settings.sites.marked", { site: "github.com" }))).toBeTruthy();
    expect(scroll).toHaveBeenCalled();
    expect(row("https://docs.example.test").className).not.toContain("flash");
  });

  it("says a named site is no longer listed", () => {
    renderSettings({ route: { section: "sites", site: "https://gone.example.test" } });
    expect(within(sites()).getByText(ui("settings.sites.gone", { site: "gone.example.test" }))).toBeTruthy();
  });
});

describe("T777 upload folders: Remove only (FR-385, D-024-21)", () => {
  it("lists the folders by name with their paths, says when they are added, and has no Add", () => {
    renderSettings({ route: "sites" });
    const uploads = within(sites()).getByRole("region", { name: ui("settings.uploads.title") });
    expect(within(uploads).getByText("shared-assets")).toBeTruthy();
    expect(within(uploads).getByText("D:\\Projects\\test-fixtures")).toBeTruthy();
    expect(within(uploads).getByText(ui("settings.uploads.addedWhenAsked"))).toBeTruthy();
    expect(within(uploads).queryByRole("button", { name: /^Add/ })).toBeNull();
    expect(within(uploads).queryByRole("button", { name: /Choose|Browse/ })).toBeNull();
  });

  it("014 FR-191: says where the list is kept, the file's path as the helper reported it", () => {
    renderSettings({ route: "sites" });
    const uploads = within(sites()).getByRole("region", { name: ui("settings.uploads.title") });
    expect(uploads.textContent).toContain(ui("settings.uploads.listPath", { path: "C:\\Users\\example\\AppData\\Local\\hallpass\\config.json" }));
  });

  it("removes a folder by sending its path", async () => {
    const { commands } = renderSettings({ route: "sites" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: ui("settings.uploads.removeLabel", { folder: "shared-assets" }) }));
    });
    expect(commands()[0]).toMatchObject({ type: "ui.agent.upload-root-clear", payload: { root: "D:\\Projects\\shared-assets" } });
    expect(screen.getByText(ui("settings.uploads.removed", { folder: "shared-assets" }))).toBeTruthy();
  });

  it("says there are none when the list is empty", () => {
    const state = prototypeAState(NOW);
    renderSettings({ route: "sites", state: { ...state, uploadRoots: { ...state.uploadRoots!, roots: [] } } });
    expect(screen.getByText(ui("settings.uploads.empty"))).toBeTruthy();
  });

  it("says the list needs the helper when the helper has not reported it", () => {
    const { uploadRoots: _gone, ...rest } = prototypeAState(NOW);
    renderSettings({ route: "sites", state: rest });
    expect(screen.getByText(ui("settings.uploads.unavailable"))).toBeTruthy();
    // The extension-side parts stay usable.
    expect(row("https://github.com")).toBeTruthy();
  });

  it("tells what the helper could not read or record", () => {
    const state = prototypeAState(NOW);
    renderSettings({
      route: "sites",
      state: { ...state, uploadRoots: { ...state.uploadRoots!, malformed: true, notRecorded: ["D:\\Projects\\later"] } },
    });
    expect(screen.getByText(ui("settings.uploads.malformed"))).toBeTruthy();
    expect(screen.getByText(ui("settings.uploads.notRecorded", { folder: "later" }))).toBeTruthy();
  });
});

describe("T776 remembered decisions (014 FR-191)", () => {
  it("lists a remembered move and forgets it, and shows nothing when there are none", async () => {
    const state = { ...prototypeAState(NOW), transitions: [{ from: "https://github.com", to: "https://docs.example.test", allowedAt: NOW.toISOString() }] };
    const { commands, unmount } = renderSettings({ route: "sites", state });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: ui("settings.transitions.forget", { from: "github.com", to: "docs.example.test" }) }));
    });
    expect(commands()[0]).toMatchObject({
      type: "ui.agent.transition-clear",
      payload: { from: "https://github.com", to: "https://docs.example.test" },
    });
    unmount();
    renderSettings({ route: "sites" });
    expect(screen.queryByText(ui("settings.transitions.title"))).toBeNull();
  });
});
