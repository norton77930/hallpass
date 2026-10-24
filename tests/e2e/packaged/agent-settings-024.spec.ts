import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BrowserContext, Page } from "@playwright/test";
import { hostDataDirectory } from "@hallpass/agent-host";
import { lookup, type AppLocale } from "../../../apps/extension/src/locales/catalog.js";
import { startMcpClient, type McpHarnessClient } from "../../harness/mcp-client.js";
import { isAgentPaired, pairWithFirstCall, unpairAgent } from "../fixtures/agent-pairing.js";
import {
  openSettingsPage,
  settingsPageDriver,
  settingsPages,
  type SettingsAgent,
  type SettingsPageDriver,
} from "../fixtures/settings-page-driver.js";
import { copyFor, localeFromEnv, openSidePanel, waitForAgentPanel, type SidePanelDriver } from "../fixtures/side-panel-driver.js";
import { expect, test, type PackagedWorker } from "../fixtures/packaged-extension.js";

/**
 * 024 T791 - the settings page's live gates, quickstart L1-L14, on the packaged extension.
 *
 * Every claim is read off what the owner is shown - the settings page (`settings.html`, driven by
 * `settings-page-driver.ts`), the side panel (through its own CDP session), an MCP client's answers -
 * or off the host's files under the `LOCALAPPDATA` the browser and this runner share. Nothing private
 * is imported.
 *
 * The broker side runs the fake ACP agent: under `HALLPASS_TEST_MODE=1` the browser's relay starts the
 * broker with `HALLPASS_BROKER_TEST_AGENT` (a JSON argv) for every agent. Pointing that argv at
 * `tests/harness/fake-acp-agent-switch.ts` with `FAKE_ACP_SWITCH_FILE` lets this runner change the
 * fake's knobs between steps (the file is read at each launch); `FAKE_ACP_COUNT_PROMPTS` names the file
 * the fake appends one line to per model prompt. All of these reach the broker only through the
 * browser's environment, so the browser is started with them (`.scratch/024/s5a/run-gate.sh`).
 *
 * Under the test agent every agent reads `ready` - unless two more seams of the same guard are set
 * (`packages/agent-host/src/broker/test-mode.ts`, `test-machine.ts`), which the agent states and the
 * downloads (L2 four states, L3, L4, L5 partial, L14 hung `--version`) need:
 * - `HALLPASS_BROKER_TEST_MACHINE` names a JSON file, read at every readiness check, that says what
 *   "the machine" holds - which agent programs, what their `--version` prints or that it hangs,
 *   Hermes' MCP component, Git Bash; the broker's own check then runs against it, with the pinned
 *   packages read from the real data folder (so this runner "installs" Claude Code's by writing it);
 * - `HALLPASS_BROKER_TEST_INSTALL` is the argv run in place of `npm ci`:
 *   `tests/harness/fake-acp-agent-install.ts --lockfile`, which grows the install tree from its
 *   lockfile over `FAKE_INSTALL_SECONDS` (from the switch file), so progress, Cancel, the end and an
 *   interrupted download can be watched.
 * Both are honoured only by a 024 broker: these scenarios first read `broker.log` for the codes the
 * serving broker logged at start, and fail naming the cause when it is an older host's broker.
 *
 * Screenshots of the live states it passes go to `.scratch/024/shots/gate/` (not tracked).
 *
 * Attach mode only.
 */
const locale = localeFromEnv();
const copy = copyFor(locale);
const ui = (key: string, vars: Record<string, string | number> = {}, at: AppLocale = locale): string =>
  lookup(key, at).replace(/\{([a-zA-Z]+)\}/gu, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
const SITE = "https://127.0.0.1:19443";
const SHOTS = join(process.cwd(), ".scratch", "024", "shots", "gate");
const AGENTS: readonly SettingsAgent[] = ["claude-code", "codex", "hermes", "deepseek"];
const AGENT_CHIP = ".agent-conversation-chips button.agent-conversation-chip[aria-haspopup=menu]";
const execFileAsync = promisify(execFile);

const attach = Boolean(process.env.HALLPASS_CDP_ENDPOINT);
const broker = attach && process.env.HALLPASS_TEST_MODE === "1" && Boolean(process.env.HALLPASS_BROKER_TEST_AGENT);
const SWITCH_FILE = process.env.FAKE_ACP_SWITCH_FILE;
const COUNT_FILE = process.env.FAKE_ACP_COUNT_PROMPTS;
const BROKER_SKIP =
  "the fake agent behind the broker: HALLPASS_TEST_MODE=1 and HALLPASS_BROKER_TEST_AGENT, set alike for the browser under test and this runner";
const MACHINE_FILE = process.env.HALLPASS_BROKER_TEST_MACHINE;
const seams = broker && Boolean(MACHINE_FILE) && Boolean(process.env.HALLPASS_BROKER_TEST_INSTALL) && Boolean(SWITCH_FILE);
const SEAMS_SKIP =
  `${BROKER_SKIP}, with HALLPASS_BROKER_TEST_MACHINE, HALLPASS_BROKER_TEST_INSTALL and FAKE_ACP_SWITCH_FILE ` +
  "(.scratch/024/s5a/env.sh with GATE_BROKER=1)";
/** The fake agent as a program on the made-up machine (its `--version` knobs: FAKE_ACP_VERSION, FAKE_ACP_VERSION_HANG). */
const FAKE_AGENT_PROGRAM = [process.execPath, "--experimental-strip-types", "--no-warnings", join(process.cwd(), "tests", "harness", "fake-acp-agent.ts")];

mkdirSync(SHOTS, { recursive: true });

/** Set by `useMachine`: this test changed the agent folders, which the next one must not inherit. */
let touchedAgents = false;

test.afterEach(async () => {
  if (!broker) return;
  // Ending the broker ends what it runs (a fake download too: the kill-on-close job, R-313).
  await stopBrokers();
  if (SWITCH_FILE) await rm(SWITCH_FILE, { force: true });
  if (MACHINE_FILE) await rm(MACHINE_FILE, { force: true });
  if (touchedAgents) await resetAgentFolders();
  touchedAgents = false;
});

test.describe("024 settings page (quickstart L1-L14)", () => {
  test.skip(!attach, "attach mode only (HALLPASS_CDP_ENDPOINT)");

  /* ------------------------------------------------------------------------------------------- */
  /* L1 - one page, from three entries                                                           */
  /* ------------------------------------------------------------------------------------------- */

  test("L1: the panel menu, the conversation's not-ready card and Extension options open one settings tab at the routed section", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(240_000);
    const { panel, client } = await pairedPanel({ extensionContext, extensionId, extensionWorker });
    try {
      expect(await settingsTabCount(extensionWorker, extensionId)).toBe(0);

      // (a) The status row's menu holds one item, Settings (FR-392).
      expect(await panel.clickIfPresent(ui("agent.status.menu"))).toBe(true);
      await expect
        .poll(() => panel.evaluatePanel("[...document.querySelectorAll('[data-status-row] [role=menuitem]')].map((b)=>b.textContent?.trim())"))
        .toEqual([ui("agent.status.settings")]);
      expect(await panel.clickIfPresent(ui("agent.status.settings"))).toBe(true);
      await expect.poll(() => settingsTabCount(extensionWorker, extensionId), { timeout: 15_000 }).toBe(1);
      const page = await settingsPage(extensionContext, extensionId);
      const settings = settingsPageDriver(page, locale);
      await settings.waitReady();
      expect(await settings.section()).toBe("agents");
      await settings.screenshot(join(SHOTS, `L1-from-menu-${locale}.png`));

      // (b) Nothing enabled: the conversation's not-ready card says so and offers Open settings, which
      // focuses the same tab (FR-384) rather than opening a second one.
      for (const agent of AGENTS) await settings.setAgentEnabled(agent, false);
      await chooseTab(panel, "conversation");
      await expect.poll(() => setupCard(panel), { timeout: 20_000 }).toBe("not-ready");
      expect(await panel.clickIfPresent(ui("conversation.agentMenu.openSettings"))).toBe(true);
      await expect.poll(() => settingsTabCount(extensionWorker, extensionId), { timeout: 10_000 }).toBe(1);
      await expect.poll(() => settings.section(), { timeout: 10_000 }).toBe("agents");
      for (const agent of AGENTS) await settings.setAgentEnabled(agent, true);
      await chooseTab(panel, "sessions");

      // (c) chrome://extensions -> Details -> Extension options (options_ui, open_in_tab).
      const extensions = await extensionContext.newPage();
      await extensions.goto(`chrome://extensions/?id=${extensionId}`);
      // Playwright's CSS engine pierces the open shadow roots of the extensions page.
      await extensions.locator("#extensionsOptions").click({ timeout: 15_000 });
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(await settingsTabCount(extensionWorker, extensionId), "Extension options reuses the open settings tab").toBe(1);
      await extensions.close();
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  /* ------------------------------------------------------------------------------------------- */
  /* L2 - the overview                                                                            */
  /* ------------------------------------------------------------------------------------------- */

  test("L2: four agent rows readable collapsed, attention cards open, the summary counts the ready ones", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    const settings = await openSettingsPage({ context: extensionContext, worker: extensionWorker, extensionId, locale, route: "#agents" });
    // The states arrive with the first check-agents answer (FR-376, SC-177: within 5 s).
    await expect
      .poll(async () => (await settings.agentCards()).filter((card) => card.state !== null).length, { timeout: 5_000 })
      .toBe(AGENTS.length);
    const cards = await settings.agentCards();
    expect(cards.map((card) => card.agent)).toEqual([...AGENTS]);
    for (const card of cards) {
      expect(card.name, `${card.agent} names itself collapsed`).toBe(ui(`conversation.agent.${card.agent}`));
      // A card that needs the owner opens by itself; a ready one stays shut (FR-377).
      expect(card.open, `${card.agent} (${card.state}) open`).toBe(card.state !== "ready");
    }
    const ready = cards.filter((card) => card.state === "ready").length;
    expect(await settings.summary()).toBe(ui("settings.summary.ready", { ready, total: AGENTS.length }));
    await settings.screenshot(join(SHOTS, `L2-overview-${locale}.png`));
  });

  test("L2: four agents in four different states", async ({ extensionContext, extensionId, extensionWorker }) => {
    test.skip(!seams, SEAMS_SKIP);
    test.setTimeout(180_000);
    // Prototype A's fixture: Claude Code ready, Codex needs its helper, Hermes ready with a warning
    // (its MCP component missing), DeepSeek downloading.
    await useMachine(
      {
        gitBash: true,
        agents: {
          "claude-code": { version: "2.1.302 (Claude Code)" },
          codex: { version: "codex-cli 0.163.0" },
          hermes: { version: "Hermes Agent v0.22.2", mcpComponent: false },
        },
      },
      { FAKE_INSTALL_SECONDS: "600" },
    );
    await installPinnedByHand("claude-code");
    const settings = await freshSettings({ extensionContext, extensionId, extensionWorker });
    await expectSeams(["broker.test-machine", "broker.test-install"]);
    await grantConsent(settings);
    await expect.poll(() => cardStates(settings), { timeout: 20_000 }).toEqual({
      "claude-code": "ready",
      codex: "needsDownload",
      hermes: "readyWarnings",
      deepseek: "needsDownload",
    });
    await settings.pressDownload("deepseek");
    await expect.poll(async () => (await cardStates(settings)).deepseek, { timeout: 20_000 }).toBe("downloading");
    await expect.poll(() => settings.downloadPercent("deepseek"), { timeout: 30_000, message: "the download's percent never showed" }).toBeGreaterThan(0);

    const cards = await settings.agentCards();
    for (const card of cards) expect(card.name, `${card.agent} names itself collapsed`).toBe(agentName(card.agent));
    const open = Object.fromEntries(cards.map((card) => [card.agent, card.open]));
    // A ready card stays shut; the ones that need the owner opened by themselves (FR-377).
    expect(open).toMatchObject({ "claude-code": false, codex: true, hermes: true });
    expect(await settings.cardText("hermes")).toContain(ui("settings.warning.mcpMissing"));
    expect(await settings.summary()).toBe(ui("settings.summary.ready", { ready: 1, total: AGENTS.length }));
    await settings.screenshot(join(SHOTS, `L2-four-states-${locale}.png`));

    await settings.pressCancel("deepseek");
    await expect.poll(async () => (await cardStates(settings)).deepseek, { timeout: 15_000 }).toBe("needsDownload");
  });

  /* ------------------------------------------------------------------------------------------- */
  /* L3, L4 - downloads                                                                          */
  /* ------------------------------------------------------------------------------------------- */

  test("L3: a slow download survives closing the page; Cancel returns Needs a download; the end is told once", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.skip(!seams, SEAMS_SKIP);
    test.setTimeout(240_000);
    const fixtures = { extensionContext, extensionId, extensionWorker };
    await useMachine({ agents: { codex: { version: "codex-cli 0.163.0" } } }, { FAKE_INSTALL_SECONDS: "90" });
    let settings = await freshSettings(fixtures);
    await expectSeams(["broker.test-machine", "broker.test-install"]);
    await grantConsent(settings);
    await expect.poll(async () => (await cardStates(settings)).codex, { timeout: 20_000 }).toBe("needsDownload");
    expect(await settings.downloadLabel("codex")).not.toBe(ui("settings.action.tryAgain"));

    await settings.pressDownload("codex");
    await expect.poll(async () => (await cardStates(settings)).codex, { timeout: 20_000 }).toBe("downloading");
    await expect.poll(() => settings.downloadPercent("codex"), { timeout: 30_000 }).toBeGreaterThan(0);
    const before = (await settings.downloadPercent("codex"))!;
    await settings.screenshot(join(SHOTS, `L3-downloading-${locale}.png`));

    // Closing the page is not cancelling: the download is the broker's, and goes on.
    await settings.close();
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    settings = await openSettingsPage({ context: extensionContext, worker: extensionWorker, extensionId, locale, route: "#agents" });
    await expect.poll(async () => (await cardStates(settings)).codex, { timeout: 20_000 }).toBe("downloading");
    await expect.poll(async () => (await settings.downloadPercent("codex")) ?? 0, { timeout: 30_000, message: "the download stopped while the page was closed" }).toBeGreaterThan(before);

    // Cancel: Needs a download again, and the install's folder is gone (the files are the evidence).
    await settings.pressCancel("codex");
    await expect.poll(async () => (await cardStates(settings)).codex, { timeout: 15_000 }).toBe("needsDownload");
    await expect.poll(() => settings.notice(), { timeout: 10_000 }).toBe(ui("settings.toast.downloadCancelled"));
    await expect.poll(() => installTrees("codex"), { timeout: 15_000 }).toEqual([]);
    await settings.screenshot(join(SHOTS, `L3-cancelled-${locale}.png`));

    // To the end, quickly this time: ready, and told so once.
    await writeFile(SWITCH_FILE!, JSON.stringify({ FAKE_INSTALL_SECONDS: "6" }), "utf8");
    await settings.recordNotices();
    await settings.pressDownload("codex");
    await expect.poll(async () => (await cardStates(settings)).codex, { timeout: 60_000 }).toBe("ready");
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    const done = ui("settings.toast.downloadDone", { agent: agentName("codex") });
    expect((await settings.notices()).filter((text) => text === done), `notices: ${JSON.stringify(await settings.notices())}`).toHaveLength(1);
    await settings.screenshot(join(SHOTS, `L3-done-${locale}.png`));
  });

  test("L4: a download interrupted by the browser closing says so and offers Try again", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.skip(!seams, SEAMS_SKIP);
    test.setTimeout(180_000);
    await useMachine({ agents: { codex: { version: "codex-cli 0.163.0" } } }, { FAKE_INSTALL_SECONDS: "300" });
    let settings = await freshSettings({ extensionContext, extensionId, extensionWorker });
    await expectSeams(["broker.test-machine", "broker.test-install"]);
    await grantConsent(settings);
    await expect.poll(async () => (await cardStates(settings)).codex, { timeout: 20_000 }).toBe("needsDownload");
    await settings.pressDownload("codex");
    await expect.poll(() => settings.downloadPercent("codex"), { timeout: 30_000 }).toBeGreaterThan(0);

    // Attach mode cannot relaunch the browser under test. What closing it does to a download is end
    // its broker, whose kill-on-close job ends the install (R-313, R-377) - so the broker is ended
    // here, and its relay starts this browser's next broker, as a relaunch would.
    await stopBrokers();
    const interrupted = ui("settings.progress.interrupted");
    await expect
      .poll(
        async () => {
          await settings.page.reload();
          settings = settingsPageDriver(settings.page, locale);
          await settings.waitReady();
          return settings.cardText("codex");
        },
        { timeout: 60_000, intervals: [3_000] },
      )
      .toContain(interrupted);
    expect((await cardStates(settings)).codex).toBe("needsDownload");
    expect(await settings.downloadLabel("codex")).toBe(ui("settings.action.tryAgain"));
    await settings.screenshot(join(SHOTS, `L4-interrupted-${locale}.png`));
  });

  /* ------------------------------------------------------------------------------------------- */
  /* L5, L6 - Test                                                                                */
  /* ------------------------------------------------------------------------------------------- */

  test("L5: Test of a working agent passes with its time; of one whose model server is unreachable fails naming it", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.skip(!broker, BROKER_SKIP);
    test.setTimeout(240_000);
    const settings = await openSettingsPage({ context: extensionContext, worker: extensionWorker, extensionId, locale, route: "#agents" });
    // A Test starts an agent process, so the broker asks for the side-panel-agent consent first (FR-299,
    // R-379); a profile that has not given it gets the Test refused.
    await grantConsent(settings);
    await settings.setCardOpen("claude-code", true);
    await settings.pressTest("claude-code");
    await expect.poll(() => settings.testLine("claude-code"), { timeout: 100_000 }).toMatchObject({ outcome: "passed" });
    const passed = (await settings.testLine("claude-code"))!;
    expect(passed.text, "a passed test says how long the answer took").toMatch(/\d/u);
    await settings.screenshot(join(SHOTS, `L5-passed-${locale}.png`));

    test.skip(!SWITCH_FILE, "the failing half needs FAKE_ACP_SWITCH_FILE (tests/harness/fake-acp-agent-switch.ts as the test agent)");
    const MODEL_ERROR = "connect ECONNREFUSED 127.0.0.1:11434 (model server)";
    // The fake as Codex (its read-only mode, which a strict start of Codex needs; without it the Test
    // fails at the start, agent-version), failing at the prompt as an unreachable model server does.
    await writeFile(SWITCH_FILE!, JSON.stringify({ FAKE_ACP_SCENARIO: "codex", FAKE_ACP_FAIL_AT: "prompt", FAKE_ACP_FAIL_MESSAGE: MODEL_ERROR }), "utf8");
    await settings.setCardOpen("codex", true);
    await settings.pressTest("codex");
    await expect.poll(() => settings.testLine("codex"), { timeout: 100_000 }).toMatchObject({ outcome: "failed" });
    // FR-381: the page names what failed in the owner's words (the model server) with what to do; the
    // agent's own words are the result's reason, in the host's last-test.json.
    expect((await settings.testLine("codex"))!.text, "the failure names the model server").toContain(ui("settings.test.failed.model"));
    const lastTest = JSON.parse(await readFile(join(hostDataDirectory(), "agents", "codex", "last-test.json"), "utf8")) as {
      start: string;
      model: { answered: boolean; reason?: string };
    };
    expect(lastTest, "the agent started and its model refused, in the agent's words").toMatchObject({ start: "ok", model: { answered: false } });
    expect(lastTest.model.reason).toContain("11434");
    await settings.screenshot(join(SHOTS, `L5-failed-${locale}.png`));
  });

  test("L5: Hermes without its MCP component is partial, naming the component", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.skip(!seams, SEAMS_SKIP);
    test.setTimeout(240_000);
    // The fake answers the test's prompt as Hermes would; the machine has no MCP component for it.
    await useMachine({ agents: { hermes: { version: "0.22.2", mcpComponent: false } } }, { FAKE_ACP_SCENARIO: "hermes" });
    const settings = await freshSettings({ extensionContext, extensionId, extensionWorker });
    await expectSeams(["broker.test-machine"]);
    await grantConsent(settings);
    await expect.poll(async () => (await cardStates(settings)).hermes, { timeout: 20_000 }).toBe("readyWarnings");
    await settings.setCardOpen("hermes", true);
    await settings.pressTest("hermes");
    await expect.poll(() => settings.testLine("hermes"), { timeout: 100_000 }).toMatchObject({ outcome: "partial" });
    const line = (await settings.testLine("hermes"))!;
    expect(line.text, "the partial result names the missing component").toContain(ui("settings.test.component.mcp"));
    expect(line.text, "it says how long the model took").toMatch(/\d/u);
    await settings.screenshot(join(SHOTS, `L5-partial-${locale}.png`));
  });

  test("L6: a Test while a conversation with the same agent runs leaves that conversation's turn and history alone", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.skip(!broker || !COUNT_FILE, `${BROKER_SKIP}, and FAKE_ACP_COUNT_PROMPTS`);
    test.setTimeout(240_000);
    const { panel } = await ownerPanel({ extensionContext, extensionId, extensionWorker });
    await chooseTab(panel, "conversation");
    await startConversation(panel, ui("conversation.agent.claude-code"));
    const before = await logText(panel);
    const conversationPrompts = (await promptLines()).length;

    const settings = await openSettingsPage({ context: extensionContext, worker: extensionWorker, extensionId, locale, route: "#agents" });
    await settings.setCardOpen("claude-code", true);
    await settings.pressTest("claude-code");
    await expect.poll(() => settings.testLine("claude-code"), { timeout: 100_000 }).toMatchObject({ outcome: "passed" });

    // The test's one prompt went to a session of its own, not the conversation's.
    const lines = await promptLines();
    expect(lines.length).toBe(conversationPrompts + 1);
    expect(new Set(lines.slice(0, conversationPrompts)).has(lines.at(-1)!), "the test prompted the conversation's session").toBe(false);
    expect(await logText(panel), "the conversation's history changed").toBe(before);
    expect(await composerReady(panel), "the conversation's turn changed").toBe(true);
  });

  /* ------------------------------------------------------------------------------------------- */
  /* L7 - which agents the panel offers                                                          */
  /* ------------------------------------------------------------------------------------------- */

  test("L7: switching DeepSeek off, Hermes default, Hermes off - the picker follows and the default moves by order", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.skip(!broker, BROKER_SKIP);
    const { panel } = await ownerPanel({ extensionContext, extensionId, extensionWorker });
    await chooseTab(panel, "conversation");
    const settings = await openSettingsPage({ context: extensionContext, worker: extensionWorker, extensionId, locale, route: "#agents" });
    for (const agent of AGENTS) await settings.setAgentEnabled(agent, true);

    await settings.setAgentEnabled("deepseek", false);
    await expect.poll(() => pickerAgents(panel), { timeout: 15_000 }).toEqual(AGENTS.filter((a) => a !== "deepseek").map(agentName));

    await settings.makeDefault("hermes");
    await expect.poll(() => chipText(panel), { timeout: 15_000 }).toBe(agentName("hermes"));
    await settings.screenshot(join(SHOTS, `L7-hermes-default-${locale}.png`));

    await settings.setAgentEnabled("hermes", false);
    // The default moves to the first enabled agent in order and the page says so (FR-382).
    await expect.poll(() => settings.notice(), { timeout: 15_000 }).toBe(ui("settings.default.moved", { agent: agentName("claude-code") }));
    await expect.poll(async () => (await settings.agentCards()).find((card) => card.isDefault)?.agent ?? null).toBe("claude-code");
    await expect.poll(() => pickerAgents(panel), { timeout: 15_000 }).toEqual([agentName("claude-code"), agentName("codex")]);
    await expect.poll(() => chipText(panel), { timeout: 15_000 }).toBe(agentName("claude-code"));

    for (const agent of AGENTS) await settings.setAgentEnabled(agent, true);
  });

  /* ------------------------------------------------------------------------------------------- */
  /* L8 - Sites & permissions                                                                    */
  /* ------------------------------------------------------------------------------------------- */

  test.describe("L8: an upload folder", () => {
    /**
     * The worker asks the relay for the list on every link (014 FR-194), and the fixture's reset
     * restarts the worker before each test - so the file is written before the test, not in it.
     */
    const configPath = join(hostDataDirectory(), "config.json");
    let ownConfig: string | undefined;
    let folder = "";
    test.beforeAll(async () => {
      ownConfig = await readFile(configPath, "utf8").catch(() => undefined);
      folder = await realpath(await mkdtemp(join(tmpdir(), "hallpass-024-upload-")));
      await writeFile(configPath, JSON.stringify({ uploadRoots: [folder] }, null, 2), "utf8");
    });
    test.afterAll(async () => {
      if (ownConfig === undefined) await rm(configPath, { force: true });
      else await writeFile(configPath, ownConfig, "utf8");
      if (folder) await rm(folder, { recursive: true, force: true });
    });

    test("is listed, and Remove takes it off the host's list at once", async ({ extensionContext, extensionId, extensionWorker }) => {
      const settings = await openSettingsPage({ context: extensionContext, worker: extensionWorker, extensionId, locale, route: "#sites" });
      await expect.poll(() => settings.uploadRoots(), { timeout: 20_000 }).toContain(folder);
      await settings.screenshot(join(SHOTS, `L8-upload-folder-${locale}.png`));
      await settings.removeUploadRoot(folder);
      // The file on disk is the evidence.
      await expect
        .poll(async () => ((JSON.parse(await readFile(configPath, "utf8")) as { uploadRoots?: string[] }).uploadRoots ?? []).includes(folder), {
          timeout: 15_000,
        })
        .toBe(false);
      await expect.poll(() => settings.uploadRoots(), { timeout: 15_000 }).not.toContain(folder);
    });
  });

  test("L8: mode change, revoke and undo, and unpair - each takes effect at once", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(300_000);
    const { panel, client } = await pairedPanel({ extensionContext, extensionId, extensionWorker });
    try {
      const tabId = ((await ok(client, "tabs_create", { url: `${SITE}/ordinary` })) as { tabId: number }).tabId;
      const settings = await openSettingsPage({ context: extensionContext, worker: extensionWorker, extensionId, locale, route: "#sites" });

      // A mode change applies to the next effect: skip-checks acts without a card.
      await settings.setSiteMode(SITE, "skip-checks");
      await expect.poll(() => settings.notice(), { timeout: 10_000 }).toBe(
        ui("settings.sites.modeChanged", { site: "127.0.0.1:19443", mode: ui("settings.mode.skip-checks") }),
      );
      await ok(client, "click", { tabId, target: { ref: await refFor(client, tabId, "Safe action") } });
      expect(await promptUp(panel), "skip-checks still asked").toBe(false);
      await settings.screenshot(join(SHOTS, `L8-sites-${locale}.png`));

      // Revoke (confirmed) - the default asks again; Undo puts the mode back.
      await settings.revokeSite(SITE);
      const asked = client.callTool("click", { tabId, target: { ref: await refFor(client, tabId, "Safe action") } });
      await panel.waitForText(ui("agent.promptTitle"), 20_000);
      await panel.clickButton(ui("agent.refuse"));
      expect((await asked).isError).toBe(true);
      await settings.undoRevoke();
      await expect.poll(() => settings.siteMode(SITE), { timeout: 15_000 }).toBe("skip-checks");
      await ok(client, "click", { tabId, target: { ref: await refFor(client, tabId, "Safe action") } });
      expect(await promptUp(panel), "the undone revoke still asked").toBe(false);

      // Unpair: the panel goes back to not-connected and the session's next call is refused.
      await settings.revokeSite(SITE);
      await unpairAgent(panel, settings, { locale });
      const refused = await client.callTool("tabs_context");
      expect(refused.json).toMatchObject({ outcome: "denied", reason: "not-paired" });
      expect(await isAgentPaired(panel, locale)).toBe(false);
      await expect.poll(() => settings.pairedAgents()).toEqual([]);
      await settings.screenshot(join(SHOTS, `L8-unpaired-${locale}.png`));
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  /* ------------------------------------------------------------------------------------------- */
  /* L9 - from a session card to its site                                                        */
  /* ------------------------------------------------------------------------------------------- */

  test("L9: a session card's Manage link opens Sites with its site marked", async ({ extensionContext, extensionId, extensionWorker }) => {
    test.setTimeout(240_000);
    const { panel, client } = await pairedPanel({ extensionContext, extensionId, extensionWorker });
    try {
      await ok(client, "tabs_create", { url: `${SITE}/ordinary` });
      const settings = await openSettingsPage({ context: extensionContext, worker: extensionWorker, extensionId, locale, route: "#agents" });
      await expect.poll(() => panel.evaluatePanel("document.querySelectorAll('section[data-session-id]').length"), { timeout: 20_000 }).toBe(1);

      const label = ui("agent.session.manageSiteLabel", { site: SITE });
      const manage = `(()=>{const b=[...document.querySelectorAll('button.agent-session-manage')].find((x)=>x.getAttribute('aria-label')===${JSON.stringify(label)});if(!b)return false;b.click();return true})()`;
      await expect
        .poll(() => panel.evaluatePanel(manage, true), {
          timeout: 20_000,
          message: "the session card shows no Manage link for its site (024 FR-393: the card's projection carries no site)",
        })
        .toBe(true);
      // The open page is reused and routed (R-372): one tab, Sites, the row marked.
      await expect.poll(() => settings.section(), { timeout: 10_000 }).toBe("sites");
      expect(await settingsTabCount(extensionWorker, extensionId)).toBe(1);
      await expect.poll(async () => (await settings.markedSite()).site, { timeout: 10_000 }).toBe(SITE);
      expect((await settings.markedSite()).note).toBe(ui("settings.sites.marked", { site: "127.0.0.1:19443" }));
      await settings.screenshot(join(SHOTS, `L9-marked-${locale}.png`));
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  test("L9: #sites?site= marks a listed site, and says a revoked one is no longer in the list", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(240_000);
    const { client } = await pairedPanel({ extensionContext, extensionId, extensionWorker });
    const settings = await openSettingsPage({ context: extensionContext, worker: extensionWorker, extensionId, locale, route: "#sites" });
    try {
      await ok(client, "tabs_create", { url: `${SITE}/ordinary` });
      await settings.setSiteMode(SITE, "follow-a-plan");
    } finally {
      await client.close().catch(() => undefined);
    }
    // No session holds the site now; its row is there because the owner decided about it.
    await settings.goto(`#sites?site=${encodeURIComponent(SITE)}`);
    await expect.poll(async () => (await settings.markedSite()).site, { timeout: 10_000 }).toBe(SITE);
    expect((await settings.markedSite()).note).toBe(ui("settings.sites.marked", { site: "127.0.0.1:19443" }));
    await settings.screenshot(join(SHOTS, `L9-routed-marked-${locale}.png`));

    await settings.revokeSite(SITE);
    await expect(settings.page.locator(`li.site[data-site=${JSON.stringify(SITE)}]`)).toHaveCount(0, { timeout: 15_000 });
    await expect
      .poll(async () => (await settings.markedSite()).note, { timeout: 10_000 })
      .toBe(ui("settings.sites.gone", { site: "127.0.0.1:19443" }));
    await settings.screenshot(join(SHOTS, `L9-gone-${locale}.png`));
  });

  /* ------------------------------------------------------------------------------------------- */
  /* L10 - Browser tools                                                                         */
  /* ------------------------------------------------------------------------------------------- */

  test("L10: Browser tools off - the panel's conversations chat only, an outside agent is unaffected", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.skip(!broker, BROKER_SKIP);
    test.setTimeout(300_000);
    const { panel, client } = await pairedPanel({ extensionContext, extensionId, extensionWorker });
    try {
      await chooseTab(panel, "conversation");
      await startConversation(panel, ui("conversation.agent.claude-code"));
      const settings = await openSettingsPage({ context: extensionContext, worker: extensionWorker, extensionId, locale, route: "#tools" });
      expect(await settings.consent()).toBe("granted");
      await settings.setBrowserTools(false);
      await settings.screenshot(join(SHOTS, `L10-tools-off-${locale}.png`));

      await sendMessage(panel, "mcp:tabs_context");
      await expect.poll(() => logText(panel), { timeout: 30_000 }).toContain("mcp:tabs_context:error:");
      const outside = await client.callTool("tabs_context");
      expect(outside.isError, `an outside agent was refused: ${outside.text}`).toBe(false);

      await settings.setBrowserTools(true);
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  /* ------------------------------------------------------------------------------------------- */
  /* L11 - Connection & diagnostics                                                              */
  /* ------------------------------------------------------------------------------------------- */

  test("L11: rename is what list_browsers says; copied details and last lines name no user path or key", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(240_000);
    const { client } = await pairedPanel({ extensionContext, extensionId, extensionWorker });
    const settings = await openSettingsPage({ context: extensionContext, worker: extensionWorker, extensionId, locale, route: "#connection" });
    const original = await settings.browserName();
    try {
      const name = `Gate ${Date.now() % 100_000}`;
      await settings.renameBrowser(name);
      await expect
        .poll(async () => JSON.stringify((await client.callTool("list_browsers")).json ?? null), { timeout: 15_000 })
        .toContain(name);
      await settings.screenshot(join(SHOTS, `L11-connection-${locale}.png`));

      const details = await settings.copyDetails();
      expect(details.length).toBeGreaterThan(0);
      expect(namesThisAccount(details), `copied details: ${details}`).toBeUndefined();
    } finally {
      if (original) await settings.renameBrowser(original).catch(() => undefined);
      await client.close().catch(() => undefined);
    }
  });

  test("L11: an agent's last lines, shown and copied, name no user path or key", async ({ extensionContext, extensionId, extensionWorker }) => {
    test.skip(!broker || !SWITCH_FILE, `${BROKER_SKIP}, and FAKE_ACP_SWITCH_FILE`);
    test.setTimeout(240_000);
    // The fake writes one stderr line holding the profile path and a made-up key, as a chatty CLI might.
    await writeFile(
      SWITCH_FILE!,
      JSON.stringify({ FAKE_ACP_STDERR_LINES: "1", FAKE_ACP_STDERR_LINE: "loaded {env:USERPROFILE}\\.agent\\config key=sk-gatefake0000000000" }),
      "utf8",
    );
    const { panel } = await ownerPanel({ extensionContext, extensionId, extensionWorker });
    await chooseTab(panel, "conversation");
    await startConversation(panel, ui("conversation.agent.claude-code"));
    const settings = await openSettingsPage({ context: extensionContext, worker: extensionWorker, extensionId, locale, route: "#connection" });
    const lines = await settings.showOutput("claude-code");
    await settings.screenshot(join(SHOTS, `L11-last-lines-${locale}.png`));
    expect(lines, "the agent's line is shown").toContain("loaded");
    expect(namesThisAccount(lines), `shown last lines: ${lines}`).toBeUndefined();
    expect(lines).not.toContain("sk-gatefake");
    const copied = await settings.copyOutput("claude-code");
    expect(namesThisAccount(copied), `copied last lines: ${copied}`).toBeUndefined();
    expect(copied).not.toContain("sk-gatefake");
  });

  /* ------------------------------------------------------------------------------------------- */
  /* L12 - the Sessions tab                                                                      */
  /* ------------------------------------------------------------------------------------------- */

  test("L12: the Sessions tab has no standing-permission control, with a session or without one", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(240_000);
    const { panel, client } = await pairedPanel({ extensionContext, extensionId, extensionWorker });
    let live: McpHarnessClient | undefined = client;
    try {
      await ok(client, "tabs_create", { url: `${SITE}/ordinary` });
      await expect.poll(() => panel.evaluatePanel("document.querySelectorAll('section[data-session-id]').length"), { timeout: 20_000 }).toBe(1);
      expect(await standingControls(panel)).toEqual([]);
      await panelShot(panel, `L12-with-session-${locale}.png`);

      await client.close();
      live = undefined;
      await expect.poll(() => panel.evaluatePanel("document.querySelector('[data-sessions-empty]') !== null"), { timeout: 30_000 }).toBe(true);
      expect(await panel.panelText()).toContain(ui("agent.sessions.empty"));
      expect(await standingControls(panel)).toEqual([]);
      await panelShot(panel, `L12-empty-${locale}.png`);
      expect(await panel.clickIfPresent(ui("agent.sessions.openSettings"))).toBe(true);
      await expect.poll(() => settingsTabCount(extensionWorker, extensionId), { timeout: 15_000 }).toBe(1);
    } finally {
      await live?.close().catch(() => undefined);
    }
  });

  /* ------------------------------------------------------------------------------------------- */
  /* L13 - narrow, keyboard only, both languages and themes                                      */
  /* ------------------------------------------------------------------------------------------- */

  test("L13: at 375 px, by keyboard alone, in en-US and zh-TW, light and dark - every control reachable, nothing scrolls sideways", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(300_000);
    const first = await openSettingsPage({ context: extensionContext, worker: extensionWorker, extensionId, locale, route: "#agents" });
    await first.page.setViewportSize({ width: 375, height: 800 });
    try {
      for (const language of ["en-US", "zh-TW"] as const) {
        const settings = settingsPageDriver(first.page, language);
        for (const theme of ["light", "dark"] as const) {
          await settings.setAppearance({ language, theme });
          for (const section of ["agents", "sites", "tools", "connection"] as const) {
            await settings.goto(`#${section}`);
            const overflow = await settings.evaluateSettings(
              "(()=>{const d=document.scrollingElement;return d.scrollWidth-d.clientWidth})()",
            );
            expect(overflow, `${language} ${theme} #${section} scrolls sideways`).toBeLessThanOrEqual(0);
            const unreached = await keyboardUnreached(first.page);
            expect(unreached, `${language} ${theme} #${section}: not reachable by Tab`).toEqual([]);
            await settings.screenshot(join(SHOTS, `L13-375-${section}-${language}-${theme}.png`));
          }
        }
      }
    } finally {
      await settingsPageDriver(first.page, locale).setAppearance({ language: "system", theme: "system" }).catch(() => undefined);
    }
  });

  /* ------------------------------------------------------------------------------------------- */
  /* L14 - looking costs nothing                                                                 */
  /* ------------------------------------------------------------------------------------------- */

  test("L14: opening the page and every card makes no model call", async ({ extensionContext, extensionId, extensionWorker }) => {
    test.skip(!broker || !COUNT_FILE, `${BROKER_SKIP}, and FAKE_ACP_COUNT_PROMPTS`);
    const before = (await promptLines()).length;
    const started = Date.now();
    const settings = await openSettingsPage({ context: extensionContext, worker: extensionWorker, extensionId, locale, route: "#agents" });
    await expect
      .poll(async () => (await settings.agentCards()).filter((card) => card.state !== null).length, { timeout: 5_000 })
      .toBe(AGENTS.length);
    // eslint-disable-next-line no-console -- SC-177's number.
    console.log(`[L14] states shown ${Date.now() - started} ms after opening`);
    for (const agent of AGENTS) await settings.setCardOpen(agent, true);
    for (const section of ["sites", "tools", "connection", "agents"]) await settings.goto(`#${section}`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect((await promptLines()).length, "the page asked a model").toBe(before);
  });

  test("L14: one agent's hung --version does not hold the others past 5 s", async ({ extensionContext, extensionId, extensionWorker }) => {
    test.skip(!seams || !COUNT_FILE, `${SEAMS_SKIP}, and FAKE_ACP_COUNT_PROMPTS`);
    test.setTimeout(120_000);
    // Codex's program is the fake agent with a `--version` that never answers (FAKE_ACP_VERSION_HANG):
    // really started, and ended by the check's 5 s bound (R-374).
    await useMachine({
      agents: {
        "claude-code": { version: "2.1.302 (Claude Code)" },
        codex: { program: FAKE_AGENT_PROGRAM, env: { FAKE_ACP_VERSION_HANG: "1", FAKE_ACP_COUNT_PROMPTS: COUNT_FILE! } },
        hermes: { version: "0.22.2", mcpComponent: true },
      },
    });
    await installPinnedByHand("claude-code");
    const prompts = (await promptLines()).length;
    const settings = await freshSettings({ extensionContext, extensionId, extensionWorker });
    await expectSeams(["broker.test-machine"]);
    // The page's connect is what asks for the check (check-agents); time it from a reload.
    const started = Date.now();
    await settings.page.reload();
    await settingsPageDriver(settings.page, locale).waitReady();
    await expect
      .poll(() => cardStates(settings), { timeout: 15_000 })
      .toEqual({ "claude-code": "ready", codex: "notInstalled", hermes: "ready", deepseek: "needsDownload" });
    const shownMs = Date.now() - started;
    // eslint-disable-next-line no-console -- SC-177's number with one hung program.
    console.log(`[L14] states shown ${shownMs} ms after opening, one --version hung`);
    // The check of every agent waits for its slowest; the hung one is ended at its bound (5 s) plus the
    // kill, so all four are shown just past 5 s - not after a launch's 15 s, nor never.
    expect(shownMs, "states were held past the 5 s bound").toBeLessThan(8_000);
    await settings.setCardOpen("codex", true);
    // The card words a version problem with no version read as "did not report a version number"
    // (AgentCard: the broker's "did not answer within 5 s" detail is shown only beside a version).
    expect(await settings.cardText("codex")).toContain(ui("settings.warning.versionUnreadable", { agent: agentName("codex") }));
    await settings.screenshot(join(SHOTS, `L14-hung-version-${locale}.png`));
    expect((await promptLines()).length, "the check asked a model").toBe(prompts);
  });
});

/* ------------------------------------------------------------------------------------------- */
/* Helpers                                                                                      */
/* ------------------------------------------------------------------------------------------- */

type Fixtures = { extensionContext: BrowserContext; extensionId: string; extensionWorker: PackagedWorker };

function agentName(agent: SettingsAgent): string {
  return ui(`conversation.agent.${agent}`);
}

/** The owner's tab on the fixture site and its side panel, on the Sessions tab. */
async function ownerPanel(fixtures: Fixtures): Promise<{ panel: SidePanelDriver; ownerPage: Page; ownerTabId: number }> {
  const { extensionContext, extensionId, extensionWorker } = fixtures;
  const ownerPage = extensionContext.pages()[0] ?? (await extensionContext.newPage());
  await ownerPage.goto(`${SITE}/waiting`);
  await ownerPage.bringToFront();
  const ownerTabId = await extensionWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) throw new Error("active-tab-missing");
    return tab.id;
  });
  const panel = await openSidePanel({ context: extensionContext, extensionId, fixturePage: ownerPage, tabId: ownerTabId, copy });
  await waitForAgentPanel(panel);
  return { panel, ownerPage, ownerTabId };
}

/** The panel with an outside MCP agent paired, as the sibling journeys start. */
async function pairedPanel(fixtures: Fixtures): Promise<{ panel: SidePanelDriver; client: McpHarnessClient }> {
  const { panel } = await ownerPanel(fixtures);
  const client = await startMcpClient({ clientName: "Claude Code" });
  await panel.clickIfPresent(ui("agent.retry"));
  await pairWithFirstCall(client, panel, { locale, timeoutMs: 60_000 });
  return { panel, client };
}

/** Settings tabs of this extension, as the browser counts them (whatever opened them). */
async function settingsTabCount(worker: PackagedWorker, extensionId: string): Promise<number> {
  return worker.evaluate(async (prefix: string) => (await chrome.tabs.query({})).filter((tab) => (tab.url ?? tab.pendingUrl ?? "").startsWith(prefix)).length, `chrome-extension://${extensionId}/settings.html`);
}

async function settingsPage(context: BrowserContext, extensionId: string): Promise<Page> {
  await expect.poll(() => settingsPages(context, extensionId).length, { timeout: 15_000 }).toBeGreaterThan(0);
  return settingsPages(context, extensionId)[0]!;
}

async function selectedTab(panel: SidePanelDriver): Promise<string | null> {
  return (await panel.evaluatePanel("document.querySelector('[role=tab][aria-selected=true]')?.id?.replace('agent-tab-','') ?? null")) as
    | string
    | null;
}

async function chooseTab(panel: SidePanelDriver, name: "conversation" | "sessions"): Promise<void> {
  expect(await panel.evaluatePanel(`(()=>{const b=document.getElementById('agent-tab-${name}');if(!b)return false;b.click();return true})()`, true)).toBe(
    true,
  );
  await expect.poll(() => selectedTab(panel), { timeout: 10_000 }).toBe(name);
}

async function setupCard(panel: SidePanelDriver): Promise<string | null> {
  return (await panel.evaluatePanel("document.querySelector('[data-setup]')?.getAttribute('data-setup') ?? null")) as string | null;
}

/** The names the agent chip's menu offers (enabled agents only, FR-383). */
async function pickerAgents(panel: SidePanelDriver): Promise<string[]> {
  await panel.evaluatePanel(
    `(()=>{const c=document.querySelector(${JSON.stringify(AGENT_CHIP)});if(c&&c.getAttribute('aria-expanded')!=='true')c.click();return true})()`,
    true,
  );
  const names = (await panel.evaluatePanel(
    "[...document.querySelectorAll('.agent-conversation-menu-item[role=menuitemradio] .agent-conversation-agent-name')].map((n)=>n.textContent?.trim())",
  )) as string[];
  await panel.evaluatePanel(
    `(()=>{const c=document.querySelector(${JSON.stringify(AGENT_CHIP)});if(c&&c.getAttribute('aria-expanded')==='true')c.click();return true})()`,
    true,
  );
  return names;
}

async function chipText(panel: SidePanelDriver): Promise<string | null> {
  return (await panel.evaluatePanel(`document.querySelector(${JSON.stringify(AGENT_CHIP)})?.textContent?.trim() ?? null`)) as string | null;
}

async function fillAndSend(panel: SidePanelDriver, text: string): Promise<void> {
  const filled = await panel.evaluatePanel(
    `(()=>{const e=document.querySelector('.agent-conversation-composer textarea');if(!e)return false;` +
      `Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});` +
      `e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`,
  );
  expect(filled).toBe(true);
  await expect
    .poll(
      () =>
        panel.evaluatePanel(
          "(()=>{const b=document.querySelector('.agent-conversation-composer button[type=submit]');if(!b||b.disabled)return false;b.click();return true})()",
          true,
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
}

async function sendMessage(panel: SidePanelDriver, text: string): Promise<void> {
  await fillAndSend(panel, text);
  await expect
    .poll(() => panel.evaluatePanel("document.querySelector('.agent-conversation-composer textarea')?.value ?? null"), { timeout: 10_000 })
    .toBe("");
}

async function logText(panel: SidePanelDriver): Promise<string> {
  return String((await panel.evaluatePanel("document.querySelector('.agent-conversation-log')?.innerText ?? ''")) ?? "");
}

async function composerReady(panel: SidePanelDriver): Promise<boolean> {
  return (await panel.evaluatePanel(
    `(()=>{const f=document.querySelector('.agent-conversation-composer');if(!f)return false;` +
      `return ![...f.querySelectorAll('button')].some((b)=>(b.textContent??'').trim()===${JSON.stringify(ui("conversation.stop"))})})()`,
  )) as boolean;
}

/** Picks the agent, sends a first message, answers the first-use card if it comes, and waits for the echo. */
async function startConversation(panel: SidePanelDriver, name: string): Promise<void> {
  await expect
    .poll(() => panel.evaluatePanel(`(()=>{const c=document.querySelector(${JSON.stringify(AGENT_CHIP)});return !!c&&!c.disabled})()`), {
      timeout: 30_000,
    })
    .toBe(true);
  await panel.evaluatePanel(
    `(()=>{const c=document.querySelector(${JSON.stringify(AGENT_CHIP)});if(c&&c.getAttribute('aria-expanded')!=='true')c.click();return true})()`,
    true,
  );
  await expect
    .poll(
      () =>
        panel.evaluatePanel(
          `(()=>{const b=[...document.querySelectorAll('.agent-conversation-menu-item[role=menuitemradio]')].find((x)=>!x.disabled&&x.querySelector('.agent-conversation-agent-name')?.textContent===${JSON.stringify(name)});if(!b)return false;b.click();return true})()`,
          true,
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
  await fillAndSend(panel, "opening");
  await expect
    .poll(
      async () => {
        if ((await setupCard(panel)) === "first-use") await panel.clickIfPresent(ui("conversation.firstUse.allow"));
        return logText(panel);
      },
      { timeout: 60_000 },
    )
    .toContain("echo:opening");
  await expect.poll(() => composerReady(panel), { timeout: 30_000 }).toBe(true);
}

/** Whether a consent card is up on the panel. */
async function promptUp(panel: SidePanelDriver): Promise<boolean> {
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  return (await panel.evaluatePanel("document.querySelector('.agent-prompt') !== null")) === true;
}

/** Anything on the Sessions tab that would set a standing permission (FR-392): none is expected. */
async function standingControls(panel: SidePanelDriver): Promise<string[]> {
  return (await panel.evaluatePanel(
    `(()=>{const p=document.querySelector('[role=tabpanel]')??document.body;const out=[];` +
      `for(const e of p.querySelectorAll('[data-site],[data-upload-root],[data-transition],input[type=checkbox],input[type=radio],select,[role=switch]'))out.push(e.outerHTML.slice(0,80));` +
      `for(const b of p.querySelectorAll('button')){const t=(b.textContent??'').trim();if(${JSON.stringify([ui("agent.unpair"), ui("settings.sites.revoke")])}.includes(t))out.push(t)}` +
      `return out})()`,
  )) as string[];
}

/** Every enabled control of the shown section, by Tab from the top; the ones never focused. */
async function keyboardUnreached(page: Page): Promise<string[]> {
  const wanted = (await page.evaluate(() => {
    const root = document.querySelector(".settings-page") ?? document.body;
    return [...root.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea, [tabindex]")]
      .filter((element) => {
        if ((element as HTMLButtonElement).disabled) return false;
        if (element.getAttribute("tabindex") === "-1") return false;
        if (element instanceof HTMLInputElement && element.type === "radio" && !element.checked) return false;
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return style.visibility !== "hidden" && style.display !== "none" && (box.width > 0 || box.height > 0 || element instanceof HTMLInputElement);
      })
      .map((element, index) => {
        element.setAttribute("data-kbd", String(index));
        return String(index);
      });
  })) as string[];
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  const seen = new Set<string>();
  for (let step = 0; step < wanted.length + 10; step += 1) {
    await page.keyboard.press("Tab");
    const id = await page.evaluate(() => document.activeElement?.getAttribute("data-kbd") ?? null);
    if (id !== null) seen.add(id);
  }
  const missing = wanted.filter((id) => !seen.has(id));
  return page.evaluate(
    (ids: string[]) =>
      ids.map((id) => {
        const element = document.querySelector(`[data-kbd="${id}"]`);
        return `${element?.tagName.toLowerCase()} ${element?.getAttribute("aria-label") ?? element?.textContent?.trim().slice(0, 40) ?? ""}`;
      }),
    missing,
  );
}

async function panelShot(panel: SidePanelDriver, name: string): Promise<void> {
  const shot = await panel.sendToPanel("Page.captureScreenshot", { format: "png" });
  const data = (shot.result as { data?: string } | undefined)?.data;
  if (data !== undefined) await writeFile(join(SHOTS, name), Buffer.from(data, "base64"));
}

/** A user path or account name in text the owner copies out (SC-174). */
function namesThisAccount(text: string): string | undefined {
  const haystack = text.toLowerCase();
  return [homedir(), userInfo().username].map((needle) => needle.toLowerCase()).find((needle) => needle.length > 2 && haystack.includes(needle));
}

/** The fake's prompt counter: one session id per model prompt. */
async function promptLines(): Promise<string[]> {
  const raw = await readFile(COUNT_FILE!, "utf8").catch(() => "");
  return raw.split(/\r?\n/u).filter((line) => line.trim() !== "");
}

async function ok(client: McpHarnessClient, tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const result = await client.callTool(tool, args);
  expect(result.isError, `${tool} failed: ${result.text}\nstderr:\n${client.stderr()}`).toBe(false);
  return result.json;
}

async function refFor(client: McpHarnessClient, tabId: number, label: string): Promise<string> {
  const found = await client.callTool("find", { tabId, query: label });
  expect(found.isError, `find '${label}' failed: ${found.text}`).toBe(false);
  const answer = found.json as { outcome: string; matches: Array<{ ref: string; label?: string }> };
  expect(answer.outcome, `find '${label}' answered ${answer.outcome}`).toBe("resolved");
  const match = answer.matches.find((candidate) => candidate.label === label) ?? answer.matches[0];
  expect(match?.ref, `find '${label}' returned no ref`).toBeTruthy();
  return match!.ref;
}

/** Ends this browser's brokers between tests, so the next one starts from the files (as agent-conversation does). */
async function stopBrokers(): Promise<void> {
  const data = hostDataDirectory();
  const pids: number[] = [];
  for (const name of await readdir(join(data, "brokers")).catch(() => [] as string[])) {
    if (!name.endsWith(".json")) continue;
    try {
      const pid = (JSON.parse(await readFile(join(data, "brokers", name), "utf8")) as { pid?: unknown }).pid;
      if (typeof pid === "number") pids.push(pid);
    } catch {
      // gone or being rewritten
    }
  }
  if (pids.length === 0) return;
  const filter = pids.map((pid) => `ProcessId=${pid}`).join(" OR ");
  const script = `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { [Console]::Out.WriteLine(('{0}' -f $_.ProcessId) + [char]9 + $_.CommandLine) }`;
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 30_000 });
  for (const row of stdout.split(/\r?\n/u)) {
    const tab = row.indexOf("\t");
    if (tab <= 0 || !/broker\.js/u.test(row.slice(tab + 1))) continue;
    try {
      process.kill(Number(row.slice(0, tab)));
    } catch {
      // already gone
    }
  }
}

/* ------------------------------------------------------------------------------------------- */
/* The made-up machine and the fake download (HALLPASS_BROKER_TEST_MACHINE / _INSTALL)          */
/* ------------------------------------------------------------------------------------------- */

/** One agent on the made-up machine (`packages/agent-host/src/broker/test-machine.ts`); not listed = not installed. */
type MachineAgent = { version?: string; hang?: boolean; program?: string[]; env?: Record<string, string>; mcpComponent?: boolean };
type Machine = { gitBash?: boolean; agents: Partial<Record<SettingsAgent, MachineAgent>> };

/**
 * The agent folders as a first run has them (nothing downloaded, no install state, no last test),
 * then the machine and the fake's knobs for this test. Both files are read when they are needed (a
 * check, a start), so the page's next connect sees them.
 */
async function useMachine(machine: Machine, switches: Record<string, string> = {}): Promise<void> {
  touchedAgents = true;
  await resetAgentFolders();
  await writeFile(MACHINE_FILE!, JSON.stringify(machine), "utf8");
  await writeFile(SWITCH_FILE!, JSON.stringify(switches), "utf8");
}

async function resetAgentFolders(): Promise<void> {
  for (const agent of AGENTS) {
    await rm(join(hostDataDirectory(), "agents", agent), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

/** An agent's pinned package where a finished 0.15.0-style install leaves it, from the manifest Hallpass ships. */
async function installPinnedByHand(agent: "claude-code" | "codex"): Promise<void> {
  const shipped = JSON.parse(await readFile(join(process.cwd(), "packages", "agent-host", "agents", agent, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  const [name, version] = Object.entries(shipped.dependencies)[0]!;
  const folder = join(hostDataDirectory(), "agents", agent, version, "node_modules", ...name.split("/"));
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "package.json"), JSON.stringify({ name, version }), "utf8");
}

/** The `.install-*` trees of an agent's downloads in the data folder (a cancelled one leaves none). */
async function installTrees(agent: SettingsAgent): Promise<string[]> {
  const names = await readdir(join(hostDataDirectory(), "agents", agent)).catch(() => [] as string[]);
  return names.filter((name) => name.startsWith(".install-") && !name.endsWith(".pointer"));
}

/** The settings page, reloaded so its connect asks the broker for a fresh check of the machine. */
async function freshSettings(fixtures: Fixtures): Promise<SettingsPageDriver> {
  const { extensionContext, extensionId, extensionWorker } = fixtures;
  const opened = await openSettingsPage({ context: extensionContext, worker: extensionWorker, extensionId, locale, route: "#agents" });
  await opened.page.reload();
  const settings = settingsPageDriver(opened.page, locale);
  await settings.waitReady();
  await settings.goto("#agents");
  return settings;
}

/** A download needs the side-panel-agent consent (FR-299): given here when the profile has not given it. */
async function grantConsent(settings: SettingsPageDriver): Promise<void> {
  if ((await settings.consent()) !== "granted") await settings.setBrowserTools(true);
  await settings.goto("#agents");
}

async function cardStates(settings: SettingsPageDriver): Promise<Record<string, string | null>> {
  return Object.fromEntries((await settings.agentCards()).map((card) => [card.agent, card.state]));
}

/**
 * The broker serving this browser honours the 024 seams: it logs what it read at start (`test-mode.ts`
 * codes) in `broker.log`, which this runner shares. An older host's broker (one that predates them)
 * logs `broker.test-agent` and nothing more - then these scenarios cannot be evidence, and say why.
 */
async function expectSeams(codes: string[]): Promise<void> {
  const verdict = async (): Promise<string> => {
    const log = await readFile(join(hostDataDirectory(), "broker.log"), "utf8").catch(() => "");
    const last = log.lastIndexOf(" broker.started ");
    if (last < 0) return "no broker has started for this browser";
    const lines = new Set(
      log
        .slice(last)
        .split(/\r?\n/u)
        .map((line) => line.split(" ")[1] ?? ""),
    );
    if (!lines.has("broker.test-agent")) return "the serving broker is not in test mode (no broker.test-agent yet)";
    const missing = codes.filter((code) => !lines.has(code));
    return missing.length === 0
      ? "ok"
      : `the serving broker did not honour ${missing.join(", ")}: it is not this checkout's 024 host (register it with npm run agent-host:install)`;
  };
  await expect.poll(verdict, { timeout: 20_000 }).toBe("ok");
}
