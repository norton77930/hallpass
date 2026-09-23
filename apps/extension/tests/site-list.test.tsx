import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentPanelCommandSchema } from "@hallpass/contracts";
import {
  IDLE,
  installAgentPort,
  project,
  renderShell,
  ui,
  uninstallAgentPort,
  type FakeAgentPort,
} from "./helpers/agent-shell-harness.js";

/**
 * 006/T191 — the site list (FR-086, US2).
 *
 * One row per site the owner has decided about: the site, its mode as a switch among the three,
 * and a revoke that forgets the decision. The permissive mode is marked on the row itself, because
 * "acts without asking" is the one setting the owner should be able to find at a glance.
 */
describe("T191 site list", () => {
  let port: FakeAgentPort;
  const CONFIG = "C:\\Users\\owner\\AppData\\Local\\hallpass\\config.json";
  const ask = { site: "https://fixtures.test:19443", mode: "ask" as const, diagnosticsGranted: false };
  const open = { site: "https://open.test", mode: "skip-checks" as const, diagnosticsGranted: false };

  beforeEach(() => {
    port = installAgentPort();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  it("switches a site's mode with the closed command", () => {
    renderShell();
    project(port, { ...IDLE, sites: [ask] });

    const select = screen.getByLabelText(ui("agent.siteModeLabel").replace("{site}", ask.site)) as HTMLSelectElement;
    expect(select.value).toBe("ask");
    fireEvent.change(select, { target: { value: "follow-a-plan" } });

    expect(port.sent).toEqual([{ type: "ui.agent.site-mode", payload: { site: ask.site, mode: "follow-a-plan" } }]);
    expect(agentPanelCommandSchema.safeParse(port.sent[0]).success).toBe(true);
  });

  it("revokes a site with the closed command, naming only the site", () => {
    renderShell();
    project(port, { ...IDLE, sites: [ask, open] });

    fireEvent.click(screen.getByRole("button", { name: ui("agent.siteRevoke").replace("{site}", open.site) }));

    expect(port.sent).toEqual([{ type: "ui.agent.site-clear", payload: { site: open.site } }]);
    expect(agentPanelCommandSchema.safeParse(port.sent[0]).success).toBe(true);
  });

  it("marks a skip-checks row as permissive and no other", () => {
    renderShell();
    project(port, { ...IDLE, sites: [ask, open] });

    const rows = [...document.querySelectorAll("[data-site]")];
    expect(rows.map((row) => row.getAttribute("data-site"))).toEqual([ask.site, open.site]);
    expect(rows[0]?.classList.contains("permissive")).toBe(false);
    expect(rows[1]?.classList.contains("permissive")).toBe(true);
    expect(rows[1]?.textContent).toContain(ui("agent.sitePermissive"));
    expect(rows[0]?.textContent).not.toContain(ui("agent.sitePermissive"));
  });

  it("keeps the diagnostics grant as its own control on the row (004 US6)", () => {
    renderShell();
    project(port, { ...IDLE, sites: [ask] });

    fireEvent.click(screen.getByLabelText(ui("agent.diagnosticsLabel").replace("{site}", ask.site)));

    expect(port.sent).toEqual([{ type: "ui.agent.set-diagnostics", payload: { site: ask.site, granted: true } }]);
  });

  it("shows one sentence when no site has a decision", () => {
    renderShell();
    project(port, IDLE);

    expect(screen.getByText(ui("agent.sitesNone"))).toBeTruthy();
    expect(document.querySelectorAll("[data-site]")).toHaveLength(0);
  });

  /**
   * 014/T364 — the remembered moves, beside the sites (FR-191, FR-192).
   *
   * One row per ordered pair, with when it was last used, and a revoke: an "always" that could not
   * be taken back would be a permanent yes, which is the one thing this panel exists to prevent.
   * The section appears only when there is something in it - an empty heading is furniture.
   */
  it("lists each remembered pair with its last use, and revokes one by naming both origins", () => {
    renderShell();
    const pair = { from: "https://a.test", to: "https://b.test", allowedAt: "2026-09-20T09:00:00.000Z", lastUsedAt: "2026-09-22T08:30:00.000Z" };
    const unused = { from: "https://c.test", to: "https://d.test", allowedAt: "2026-09-21T09:00:00.000Z" };
    project(port, { ...IDLE, transitions: [pair, unused] });

    const rows = [...document.querySelectorAll("[data-transition]")];
    expect(rows.map((row) => row.getAttribute("data-transition"))).toEqual([
      "https://a.test→https://b.test",
      "https://c.test→https://d.test",
    ]);
    expect(rows[0]?.textContent).toContain(
      ui("agent.transitionRow").replace("{from}", pair.from).replace("{to}", pair.to),
    );
    // A pair nothing has used says so, rather than showing an empty date.
    expect(rows[1]?.textContent).toContain(ui("agent.transitionNeverUsed"));

    fireEvent.click(
      screen.getByRole("button", {
        name: ui("agent.transitionRevoke").replace("{from}", pair.from).replace("{to}", pair.to),
      }),
    );
    expect(port.sent).toEqual([
      { type: "ui.agent.transition-clear", payload: { from: pair.from, to: pair.to } },
    ]);
    expect(agentPanelCommandSchema.safeParse(port.sent[0]).success).toBe(true);
  });

  it("shows no remembered-decisions section when nothing is remembered", () => {
    renderShell();
    project(port, { ...IDLE, transitions: [], uploadRoots: { roots: [], path: CONFIG } });

    expect(screen.queryByText(ui("agent.transitionsTitle"))).toBeNull();
  });

  /**
   * 014/T380 — the upload directories, beside the remembered moves (FR-191, FR-192).
   *
   * They are a standing permission of the same kind - something the owner said yes to once that
   * applies until they take it back - so they are met in the same place, and deliberately not on a
   * settings page (D-014-3). The difference is who owns the list: the host does, so the revoke is
   * a request and the row goes when the host has answered, not when the button was pressed.
   */
  it("lists each allowed directory and keeps a revoked row until the host answers", () => {
    renderShell();
    const docs = "C:\\Users\\owner\\docs";
    project(port, { ...IDLE, uploadRoots: { roots: [docs, "D:\\photos"], path: CONFIG } });

    const rows = [...document.querySelectorAll("[data-upload-root]")];
    expect(rows.map((row) => row.getAttribute("data-upload-root"))).toEqual([docs, "D:\\photos"]);
    // Where the file is, because the owner may want to edit it by hand: a fact about their machine.
    expect(screen.getByText(ui("agent.uploadRootsPath").replace("{path}", CONFIG))).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: ui("agent.uploadRootRevoke").replace("{root}", docs) }));

    expect(port.sent).toEqual([{ type: "ui.agent.upload-root-clear", payload: { root: docs } }]);
    expect(agentPanelCommandSchema.safeParse(port.sent[0]).success).toBe(true);
    // FR-192: the row stands with a note until the host says the directory is gone. A row that
    // vanished on the press would be telling the owner about a write that may never have happened.
    // Found by reading the rows rather than by a selector: a Windows path is full of backslashes,
    // which a CSS attribute selector reads as escapes.
    const pending = [...document.querySelectorAll("[data-upload-root]")].find(
      (row) => row.getAttribute("data-upload-root") === docs,
    );
    expect(pending?.textContent).toContain(ui("agent.uploadRootPending"));

    project(port, { ...IDLE, uploadRoots: { roots: ["D:\\photos"], path: CONFIG } });
    expect([...document.querySelectorAll("[data-upload-root]")].map((row) => row.getAttribute("data-upload-root"))).toEqual([
      "D:\\photos",
    ]);
  });

  /**
   * 014/T384 (S3 review F6) — a note about a press that is over.
   *
   * "Waiting for the local host" was cleared by the row leaving the DOM and by nothing else, so a
   * revoke the host answered *without* removing the row - another session's answer put it back, or
   * the write failed - left the note standing for the life of the panel. It is a fact about one
   * press, and the answer to that press is the next list the host sends.
   */
  it("stops saying it is waiting once the host has answered with a list (F6)", () => {
    renderShell();
    const docs = "C:\\Users\\owner\\docs";
    project(port, { ...IDLE, uploadRoots: { roots: [docs], path: CONFIG } });

    fireEvent.click(screen.getByRole("button", { name: ui("agent.uploadRootRevoke").replace("{root}", docs) }));
    const row = (): Element | undefined =>
      [...document.querySelectorAll("[data-upload-root]")].find(
        (candidate) => candidate.getAttribute("data-upload-root") === docs,
      );
    expect(row()?.textContent).toContain(ui("agent.uploadRootPending"));

    // The host answered, and its list still has the directory. The press is answered either way.
    project(port, { ...IDLE, uploadRoots: { roots: [docs], path: CONFIG } });

    expect(row()?.textContent).not.toContain(ui("agent.uploadRootPending"));
  });

  /**
   * 014/T384 (S3 review F2) — the owner's half of a "from now on" that was not written down.
   *
   * The agent is told `upload-directory-not-recorded`; the owner is the one who can do anything
   * about it, and they were told nothing at all.
   */
  it("says which directory the owner allowed and the host did not keep (F2)", () => {
    renderShell();
    const docs = "C:\\Users\\owner\\docs";
    project(port, { ...IDLE, uploadRoots: { roots: [], path: CONFIG, notRecorded: [docs] } });

    expect(screen.getByText(ui("agent.uploadRootNotRecorded").replace("{root}", docs))).toBeDefined();
  });

  /**
   * 014/T384 (S3 review F4) — where the document nobody could read went.
   *
   * The host keeps one copy beside the file rather than writing over it, and the panel is the only
   * place the owner could learn that: the agent is never told a path of theirs it did not name.
   */
  it("says where the unreadable file was kept, instead of calling the list empty (F4)", () => {
    renderShell();
    project(port, {
      ...IDLE,
      uploadRoots: { roots: ["D:\\photos"], path: CONFIG, malformed: true, preserved: "config.json.invalid" },
    });

    expect(
      screen.getByText(ui("agent.uploadRootsPreserved").replace("{name}", "config.json.invalid")),
    ).toBeDefined();
    // Not the older sentence: it says no directory is allowed, and this list has one.
    expect(screen.queryByText(ui("agent.uploadRootsMalformed"))).toBeNull();
  });

  it("says when the host's file could not be read, rather than showing it as empty", () => {
    renderShell();
    project(port, { ...IDLE, uploadRoots: { roots: [], path: CONFIG, malformed: true } });

    expect(screen.getByText(ui("agent.uploadRootsMalformed"))).toBeDefined();

    // And a relay that has said nothing at all shows no section: "none" and "nobody has told me"
    // are different things, and only the first is a fact about the owner's list.
    project(port, { ...IDLE });
    expect(screen.queryByText(ui("agent.uploadRootsTitle"))).toBeNull();
  });
});
