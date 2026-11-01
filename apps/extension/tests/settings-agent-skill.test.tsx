import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentSkillState, SettingsResult, SettingsState } from "@hallpass/contracts";
import { prototypeAState } from "./fixtures/settings-prototype-a.js";
import { NOW, renderSettings, ui } from "./fixtures/settings-harness.js";

/**
 * 026 T837 (D-026-2, FR-417..FR-420) - the Agents section's "Skill for your coding agents": each folder
 * with its state, Install / Update on a click, a changed copy replaced only after a confirmation, and
 * the reason when a write fails. No section while no broker of this release reports the folders.
 */

const CLAUDE = "%USERPROFILE%\\.claude\\skills\\hallpass";
const AGENTS = "%USERPROFILE%\\.agents\\skills\\hallpass";
const withSkills = (claude: AgentSkillState["state"], agents: AgentSkillState["state"]): SettingsState => ({
  ...prototypeAState(NOW),
  skills: [
    { location: "claude-code", state: claude, folder: CLAUDE },
    { location: "agents", state: agents, folder: AGENTS },
  ],
});
const section = (container: HTMLElement): HTMLElement => {
  const found = container.querySelector<HTMLElement>("[data-section='agent-skill']");
  if (found === null) throw new Error("no skill section");
  return found;
};
const row = (container: HTMLElement, location: string): HTMLElement => {
  const found = section(container).querySelector<HTMLElement>(`[data-location="${location}"]`);
  if (found === null) throw new Error(`no row for ${location}`);
  return found;
};

describe("026 the skill section", () => {
  it("lists both folders with their state, in both languages", () => {
    for (const language of ["en-US", "zh-TW"] as const) {
      const { container, unmount } = renderSettings({ state: withSkills("not-installed", "up-to-date"), appearance: { theme: "system", language } });
      expect(within(section(container)).getByRole("heading", { name: ui("settings.skill.title", {}, language) })).toBeTruthy();
      const claude = row(container, "claude-code");
      expect(within(claude).getByText(ui("settings.skill.location.claude-code", {}, language))).toBeTruthy();
      expect(within(claude).getByText(CLAUDE)).toBeTruthy();
      expect(claude.getAttribute("data-state")).toBe("not-installed");
      expect(within(claude).getByText(ui("settings.skill.state.not-installed", {}, language))).toBeTruthy();
      const agents = row(container, "agents");
      expect(within(agents).getByText(ui("settings.skill.state.up-to-date", {}, language))).toBeTruthy();
      // Up to date: nothing to press.
      expect(within(agents).queryByRole("button")).toBeNull();
      unmount();
    }
  });

  it("Install and Update send install-skill for that folder, without replaceChanged", () => {
    const { container, commands } = renderSettings({ state: withSkills("not-installed", "update-available") });
    fireEvent.click(within(row(container, "claude-code")).getByRole("button", { name: ui("settings.skill.install") }));
    fireEvent.click(within(row(container, "agents")).getByRole("button", { name: ui("settings.skill.update") }));
    expect(commands()).toEqual([
      { type: "ui.conversation.install-skill", payload: { location: "claude-code" }, commandId: "t" },
      { type: "ui.conversation.install-skill", payload: { location: "agents" }, commandId: "t" },
    ]);
  });

  it("FR-419: a changed copy asks first; Keep sends nothing, Replace sends replaceChanged", () => {
    const { container, commands } = renderSettings({ state: withSkills("up-to-date", "changed") });
    const agents = row(container, "agents");
    expect(within(agents).getByText(ui("settings.skill.state.changed"))).toBeTruthy();
    fireEvent.click(within(agents).getByRole("button", { name: ui("settings.skill.replace") }));
    const confirm = within(agents).getByRole("alert");
    expect(within(confirm).getByText(ui("settings.skill.replaceConfirm"))).toBeTruthy();
    fireEvent.click(within(confirm).getByRole("button", { name: ui("settings.skill.keep") }));
    expect(commands()).toEqual([]);
    fireEvent.click(within(agents).getByRole("button", { name: ui("settings.skill.replace") }));
    fireEvent.click(within(within(agents).getByRole("alert")).getByRole("button", { name: ui("settings.skill.replace") }));
    expect(commands()).toEqual([{ type: "ui.conversation.install-skill", payload: { location: "agents", replaceChanged: true }, commandId: "t" }]);
  });

  it("FR-420: a write that failed is told with its reason", async () => {
    const send = vi.fn(async () => ({ commandId: "t", ok: false, error: { code: "skill-write-failed", detail: "EACCES: permission denied" } }) as SettingsResult);
    const { container } = renderSettings({ state: withSkills("not-installed", "not-installed"), send });
    fireEvent.click(within(row(container, "claude-code")).getByRole("button", { name: ui("settings.skill.install") }));
    await waitFor(() => expect(screen.getByText(ui("settings.skill.writeFailed", { reason: "EACCES: permission denied" }))).toBeTruthy());
  });

  it("an unreadable copy shows why, and offers Replace behind the same confirmation", () => {
    const state = withSkills("unreadable", "not-installed");
    state.skills![0] = { ...state.skills![0]!, detail: "EISDIR: illegal operation on a directory" };
    const { container } = renderSettings({ state });
    const claude = row(container, "claude-code");
    expect(within(claude).getByText("EISDIR: illegal operation on a directory")).toBeTruthy();
    expect(within(claude).getByRole("button", { name: ui("settings.skill.replace") })).toBeTruthy();
  });

  it("no section when the projection has no skills (an older helper, or none)", () => {
    const { container } = renderSettings({ state: prototypeAState(NOW) });
    expect(container.querySelector("[data-section='agent-skill']")).toBeNull();
  });
});

describe("028 FR-437 the Agents section outside Windows", () => {
  it("says side-panel conversations are Windows-only for now, not that the helper needs updating", () => {
    for (const language of ["en-US", "zh-TW"] as const) {
      const state: SettingsState = { ...prototypeAState(NOW), agentsUnavailable: "platform-unsupported" };
      const { container, unmount } = renderSettings({ state, appearance: { theme: "system", language } });
      expect(within(container).getByText(ui("settings.helper.windowsOnlyTitle", {}, language))).toBeTruthy();
      expect(within(container).getByText(ui("settings.helper.windowsOnlyBody", {}, language))).toBeTruthy();
      expect(within(container).queryByText(ui("settings.helper.needsUpdate", {}, language))).toBeNull();
      expect(within(container).queryByRole("button", { name: ui("settings.helper.retry", {}, language) })).toBeNull();
      unmount();
    }
  });
});
