import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PanelMcpServerView, SettingsResult, SettingsState } from "@hallpass/contracts";
import { prototypeAState } from "./fixtures/settings-prototype-a.js";
import { NOW, renderSettings, ui } from "./fixtures/settings-harness.js";

/**
 * 027 T850 (D-027-1, D-027-2, FR-425..FR-432) - the Browser tools section's extra MCP servers: the
 * warning before the first one, the add / edit form, each row (variables set or not, agents, the last
 * Check, Codex skipped), Check, Remove behind a confirmation, and nothing when no helper reports the list.
 */

const github: PanelMcpServerView = {
  name: "github",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-github"],
  variables: [
    { name: "GITHUB_TOKEN", set: true },
    { name: "GITHUB_HOST", set: false },
  ],
  agents: ["claude-code", "codex", "hermes"],
};
const withServers = (servers: PanelMcpServerView[], extra: Partial<NonNullable<SettingsState["mcpServers"]>> = {}): SettingsState => ({
  ...prototypeAState(NOW),
  mcpServers: { servers, ...extra },
});
const block = (container: HTMLElement): HTMLElement => {
  const found = container.querySelector<HTMLElement>("[data-section='mcp-servers']");
  if (found === null) throw new Error("no extra servers block");
  return found;
};
const row = (container: HTMLElement, name: string): HTMLElement => {
  const found = block(container).querySelector<HTMLElement>(`[data-server="${name}"]`);
  if (found === null) throw new Error(`no row for ${name}`);
  return found;
};

describe("027 extra MCP servers on the settings page", () => {
  it("empty: the warning, Add, and that DeepSeek takes none - in both languages", () => {
    for (const language of ["en-US", "zh-TW"] as const) {
      const { container, unmount } = renderSettings({ route: "tools", state: withServers([]), appearance: { theme: "system", language } });
      const here = block(container);
      expect(within(here).getByRole("heading", { name: ui("settings.mcp.title", {}, language) })).toBeTruthy();
      expect(within(here).getByText(ui("settings.mcp.warning", {}, language))).toBeTruthy();
      expect(within(here).getByText(ui("settings.mcp.empty", {}, language))).toBeTruthy();
      expect(within(here).getByText(ui("settings.mcp.deepseek", {}, language))).toBeTruthy();
      expect(within(here).getByRole("button", { name: ui("settings.mcp.add", {}, language) })).toBeTruthy();
      unmount();
    }
  });

  it("Add: every agent ticked by default; arguments one per line; Save sends the server", () => {
    const { container, commands } = renderSettings({ route: "tools", state: withServers([]) });
    fireEvent.click(within(block(container)).getByRole("button", { name: ui("settings.mcp.add") }));
    const form = within(block(container)).getByRole("form", { name: ui("settings.mcp.formTitle") });
    for (const agent of ["Claude Code", "Codex", "Hermes"]) expect((within(form).getByLabelText(agent) as HTMLInputElement).checked).toBe(true);
    fireEvent.change(within(form).getByLabelText(ui("settings.mcp.field.name")), { target: { value: "github" } });
    fireEvent.change(within(form).getByLabelText(ui("settings.mcp.field.command")), { target: { value: "npx" } });
    fireEvent.change(within(form).getByLabelText(ui("settings.mcp.field.args")), { target: { value: "-y\n@modelcontextprotocol/server-github\n" } });
    fireEvent.change(within(form).getByLabelText(ui("settings.mcp.field.variables")), { target: { value: "GITHUB_TOKEN, GITHUB_HOST" } });
    fireEvent.click(within(form).getByLabelText("Codex"));
    fireEvent.click(within(form).getByRole("button", { name: ui("settings.mcp.save") }));
    expect(commands()).toEqual([
      {
        type: "ui.conversation.mcp-server-save",
        payload: {
          server: { name: "github", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], variables: ["GITHUB_TOKEN", "GITHUB_HOST"], agents: ["claude-code", "hermes"] },
        },
        commandId: "t",
      },
    ]);
  });

  it("FR-431: a name starting with hallpass, a duplicate, a bad variable or no agent is refused on the form, nothing sent", () => {
    const { container, commands } = renderSettings({ route: "tools", state: withServers([github]) });
    fireEvent.click(within(block(container)).getByRole("button", { name: ui("settings.mcp.add") }));
    const form = within(block(container)).getByRole("form", { name: ui("settings.mcp.formTitle") });
    const name = within(form).getByLabelText(ui("settings.mcp.field.name"));
    fireEvent.change(within(form).getByLabelText(ui("settings.mcp.field.command")), { target: { value: "npx" } });
    for (const [value, key] of [
      ["hallpass", "settings.mcp.error.reserved"],
      ["GitHub", "settings.mcp.error.duplicate"],
      ["bad name", "settings.mcp.error.name"],
    ] as const) {
      fireEvent.change(name, { target: { value } });
      fireEvent.click(within(form).getByRole("button", { name: ui("settings.mcp.save") }));
      expect(within(form).getByText(ui(key))).toBeTruthy();
    }
    fireEvent.change(name, { target: { value: "db" } });
    fireEvent.change(within(form).getByLabelText(ui("settings.mcp.field.variables")), { target: { value: "1BAD" } });
    fireEvent.click(within(form).getByRole("button", { name: ui("settings.mcp.save") }));
    expect(within(form).getByText(ui("settings.mcp.error.variables"))).toBeTruthy();
    fireEvent.change(within(form).getByLabelText(ui("settings.mcp.field.variables")), { target: { value: "" } });
    for (const agent of ["Claude Code", "Codex", "Hermes"]) fireEvent.click(within(form).getByLabelText(agent));
    fireEvent.click(within(form).getByRole("button", { name: ui("settings.mcp.save") }));
    expect(within(form).getByText(ui("settings.mcp.error.agents"))).toBeTruthy();
    expect(commands()).toEqual([]);
  });

  it("a row: the command, the agents, each variable set or not, the last Check; Check sends the command", () => {
    const works = { ...github, check: { outcome: "works" as const, tools: ["create_issue", "list_issues"], toolCount: 26, at: "2026-10-28T00:00:00.000Z" } };
    const { container, commands } = renderSettings({ route: "tools", state: withServers([works]) });
    const here = row(container, "github");
    expect(within(here).getByText("npx -y @modelcontextprotocol/server-github")).toBeTruthy();
    expect(within(here).getByText("Claude Code · Codex · Hermes")).toBeTruthy();
    expect(within(here).getByText(ui("settings.mcp.variableSet", { name: "GITHUB_TOKEN" }))).toBeTruthy();
    expect(within(here).getByText(ui("settings.mcp.variableUnset", { name: "GITHUB_HOST" }))).toBeTruthy();
    expect(within(here).getByText(ui("settings.mcp.works", { tools: "create_issue, list_issues", count: 26 }))).toBeTruthy();
    fireEvent.click(within(here).getByRole("button", { name: ui("settings.mcp.check") }));
    expect(commands()).toEqual([{ type: "ui.conversation.mcp-server-check", payload: { name: "github" }, commandId: "t" }]);
  });

  it("a failed Check says why; a running one disables Check; Codex skipped is said", () => {
    const failed = { ...github, check: { outcome: "failed" as const, detail: "spawn npx ENOENT", at: "2026-10-28T00:00:00.000Z" }, codexSkipped: true as const };
    const { container, project } = renderSettings({ route: "tools", state: withServers([failed]) });
    expect(within(row(container, "github")).getByText(ui("settings.mcp.failed", { reason: "spawn npx ENOENT" }))).toBeTruthy();
    expect(within(row(container, "github")).getByText(ui("settings.mcp.codexSkipped"))).toBeTruthy();
    project(withServers([{ ...github, checking: true }]));
    const check = within(row(container, "github")).getByRole("button", { name: ui("settings.mcp.checking") }) as HTMLButtonElement;
    expect(check.disabled).toBe(true);
  });

  it("Edit opens the form filled in and saves under previousName; Remove asks first", async () => {
    const { container, commands } = renderSettings({ route: "tools", state: withServers([github]) });
    fireEvent.click(within(row(container, "github")).getByRole("button", { name: ui("settings.mcp.edit") }));
    const form = within(block(container)).getByRole("form", { name: ui("settings.mcp.formTitle") });
    expect((within(form).getByLabelText(ui("settings.mcp.field.variables")) as HTMLInputElement).value).toBe("GITHUB_TOKEN, GITHUB_HOST");
    fireEvent.change(within(form).getByLabelText(ui("settings.mcp.field.name")), { target: { value: "gh" } });
    fireEvent.click(within(form).getByRole("button", { name: ui("settings.mcp.save") }));
    expect(commands()[0]).toMatchObject({ type: "ui.conversation.mcp-server-save", payload: { previousName: "github", server: { name: "gh" } } });
    // The form closes once the helper answers; the row shows again until the next projection renames it.
    await waitFor(() => expect(block(container).querySelector("form")).toBeNull());

    fireEvent.click(within(row(container, "github")).getByRole("button", { name: ui("settings.mcp.remove") }));
    const confirm = within(row(container, "github")).getByRole("alert");
    fireEvent.click(within(confirm).getByRole("button", { name: ui("settings.mcp.keep") }));
    expect(commands()).toHaveLength(1);
    fireEvent.click(within(row(container, "github")).getByRole("button", { name: ui("settings.mcp.remove") }));
    fireEvent.click(within(within(row(container, "github")).getByRole("alert")).getByRole("button", { name: ui("settings.mcp.remove") }));
    expect(commands()[1]).toEqual({ type: "ui.conversation.mcp-server-remove", payload: { name: "github" }, commandId: "t" });
  });

  it("a refusal from the helper is told with its reason", async () => {
    const send = vi.fn(async () => ({ commandId: "t", ok: false, error: { code: "mcp-server-refused", detail: "At most 10 extra servers can be added." } }) as SettingsResult);
    const { container } = renderSettings({ route: "tools", state: withServers([github]), send });
    fireEvent.click(within(row(container, "github")).getByRole("button", { name: ui("settings.mcp.check") }));
    await waitFor(() => expect(screen.getByText("At most 10 extra servers can be added.")).toBeTruthy());
  });

  it("an unreadable list says so; no list at all shows no block", () => {
    const { container, unmount } = renderSettings({ route: "tools", state: withServers([], { unreadable: true }) });
    expect(within(block(container)).getByText(ui("settings.mcp.unreadable"))).toBeTruthy();
    unmount();
    const plain = renderSettings({ route: "tools", state: prototypeAState(NOW) });
    expect(plain.container.querySelector("[data-section='mcp-servers']")).toBeNull();
  });
});
