import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BrowserContext, Page } from "@playwright/test";
import { hostDataDirectory } from "@hallpass/agent-host";
import { lookup } from "../../../apps/extension/src/locales/catalog.js";
import { startMcpClient, type McpHarnessClient } from "../../harness/mcp-client.js";
import { pairWithFirstCall } from "../fixtures/agent-pairing.js";
import { copyFor, localeFromEnv, openSidePanel, waitForAgentPanel, type SidePanelDriver } from "../fixtures/side-panel-driver.js";
import { expect, readLiveBrowserRecords, test, type PackagedWorker } from "../fixtures/packaged-extension.js";

/**
 * 019 packaged gate, parts 1-3 (T549, T557, T564): the side panel's own conversation, end to end,
 * with the fake ACP agent (`tests/harness/fake-acp-agent.ts`) standing in for the owner's agent.
 *
 * The browser's relay starts the conversation broker, and the broker - under `HALLPASS_TEST_MODE=1`
 * - runs `HALLPASS_BROKER_TEST_AGENT` (a JSON argv) instead of an installed adapter, and uses
 * `HALLPASS_BROKER_TEST_IDLE_MS` as the idle limit (`packages/agent-host/src/broker/test-mode.ts`).
 * Those, and the fake's own `FAKE_ACP_*` variables, reach the broker only through the browser's
 * environment, so the browser under test is started with them and with the private `LOCALAPPDATA`
 * this runner shares (CLAUDE.md "Browser suites"). This runner needs the same `FAKE_ACP_LOG` and
 * `FAKE_ACP_STORE` values to read what the agent was asked.
 *
 * Every claim is read off the rendered side panel (through its own CDP session), the page, the
 * host's files under the shared `LOCALAPPDATA`, or the fake agent's request log - never off a
 * worker internal.
 *
 * Attach mode only.
 */
const locale = localeFromEnv();
const copy = copyFor(locale);
const ui = (key: string): string => lookup(key, locale);
const SITE = "https://127.0.0.1:19443";
const execFileAsync = promisify(execFile);
const AGENT_NAME = ui("conversation.agent.claude-code");
const FAKE_LOG = process.env.FAKE_ACP_LOG;
const FAKE_STORE = process.env.FAKE_ACP_STORE;
const IDLE_MS = Number(process.env.HALLPASS_BROKER_TEST_IDLE_MS ?? "0");

const configured =
  Boolean(process.env.HALLPASS_CDP_ENDPOINT) &&
  process.env.HALLPASS_TEST_MODE === "1" &&
  Boolean(process.env.HALLPASS_BROKER_TEST_AGENT) &&
  Boolean(FAKE_LOG) &&
  Boolean(FAKE_STORE);
const SKIP_REASON =
  "attach mode with the fake agent: HALLPASS_CDP_ENDPOINT, HALLPASS_TEST_MODE=1, HALLPASS_BROKER_TEST_AGENT, " +
  "FAKE_ACP_LOG and FAKE_ACP_STORE, set alike for the browser under test and this runner";

/**
 * 021 T684: the runner's fake agent follows the agent it is launched for (Hermes, DeepSeek, Codex, Claude
 * Code - `FAKE_ACP_PER_AGENT=1`) and hangs a start at `session/new` while the file `FAKE_ACP_HANG_FLAG`
 * names exists. Without them the 021 cases below are skipped.
 */
const HANG_FLAG = process.env.FAKE_ACP_HANG_FLAG;
const perAgent = process.env.FAKE_ACP_PER_AGENT === "1" && Boolean(HANG_FLAG);
const PER_AGENT_SKIP = "the fake agent per agent: FAKE_ACP_PER_AGENT=1 and FAKE_ACP_HANG_FLAG (.scratch/t602/t602.mjs sets both)";
const agentLabel = (agent: "claude-code" | "codex" | "hermes" | "deepseek"): string => ui(`conversation.agent.${agent}`);

// The next test's broker starts at its fixture reset and reads the index then: leave it nothing.
test.afterEach(async () => {
  if (!configured) return;
  if (HANG_FLAG) await rm(HANG_FLAG, { force: true });
  await stopBrokers();
  await clearHostFiles();
});

type FakeLogLine = {
  method?: string;
  event?: string;
  params?: Record<string, unknown>;
  [key: string]: unknown;
};

type ActionRow = { title: string; kind: string | null; status: string | null; byRule: boolean };

/* ------------------------------------------------------------------------------------------- */
/* Part 1 (T549): tabs, the pinned external card, streaming, actions, Stop, strict cards, modes,  */
/* first use                                                                                     */
/* ------------------------------------------------------------------------------------------- */

test.describe("019 side-panel conversation - part 1 (T549)", () => {
  test.skip(!configured, SKIP_REASON);

  test("first use: the card says what it asks; Cancel starts nothing and records nothing (US3.1, US3.2)", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    await resetHostConversationState(extensionWorker);
    const { panel } = await ownerPanel({ extensionContext, extensionId, extensionWorker });
    await expect.poll(() => selectedTab(panel), { timeout: 15_000 }).toBe("conversation");

    // The agent chip offers the agent; with no consent given, sending to it shows the first-use card
    // (020 FR-314: the message is held until the answer).
    await waitForPicker(panel);
    await pickAgent(panel);
    await submitFirstMessage(panel);
    await expect.poll(() => setupCard(panel), { timeout: 15_000 }).toBe("first-use");
    const card = await panelSectionText(panel, "[data-setup=first-use]");
    expect(card).toContain(ui("conversation.firstUse.title").replace("{agent}", AGENT_NAME));
    expect(card).toContain(ui("conversation.firstUse.browser"));
    expect(card).toContain(ui("conversation.firstUse.settings").replace("{agent}", AGENT_NAME));
    expect(await buttonLabels(panel, "[data-setup=first-use]")).toEqual([
      ui("conversation.firstUse.allow"),
      ui("conversation.firstUse.cancel"),
    ]);

    // US3.2: Cancel closes the card; nothing was started, no consent recorded, nothing listed.
    await panel.clickButton(ui("conversation.firstUse.cancel"));
    await expect.poll(() => setupCard(panel), { timeout: 10_000 }).toBeNull();
    await waitForPicker(panel);
    await sleep(1_500);
    expect(await fakeLog(), "Cancel started no agent").toEqual([]);
    expect(await consentFiles(), "Cancel recorded no consent").toEqual([]);
    // 020 FR-321: the list is read in its drawer.
    await showList(panel);
    expect(
      await panel.evaluatePanel("document.querySelectorAll('.agent-conversation-entries li').length"),
      await hostStateForMessage(panel),
    ).toBe(0);
    await hideList(panel);
    expect(await consentSwitchState(panel)).not.toBe("granted");

    // Asked again on the next send (the agent stays unavailable until the owner says yes).
    await pickAgent(panel);
    await submitFirstMessage(panel);
    await expect.poll(() => setupCard(panel), { timeout: 10_000 }).toBe("first-use");
    await panel.clickButton(ui("conversation.firstUse.allow"));
    await expect.poll(() => readConsentFile(), { timeout: 10_000 }).toBe(true);
    // The held message starts the conversation once the consent is given (020 FR-314).
    await waitForOpenConversation(panel);
  });

  test("streamed answer, header, action list, Stop, and the two modes (US1.1, US1.2, US1.4, SC-140)", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(180_000);
    await resetHostConversationState(extensionWorker);
    const { panel } = await ownerPanel({ extensionContext, extensionId, extensionWorker });
    await startConversation(panel);

    // US1.1: the header names the agent, the folder and the mode.
    expect(await headerValues(panel)).toEqual([
      AGENT_NAME,
      ui("conversation.folder.scratch"),
      ui("conversation.mode.strict"),
    ]);

    // US1.1: the answer appears progressively (20 chunks, FAKE_ACP_CHUNK_DELAY_MS apart).
    await sendMessage(panel, "chunks:20");
    await expect.poll(() => logText(panel), { timeout: 20_000, intervals: [50] }).toContain("part-1;");
    const early = await logText(panel);
    expect(early, "the first words are on screen before the last are sent").not.toContain("part-20;");
    await expect.poll(() => logText(panel), { timeout: 30_000 }).toContain("part-20;");
    await expect.poll(() => composerReady(panel), { timeout: 15_000 }).toBe(true);
    expect(await logText(panel)).toContain("chunks:20");

    // US1.2: an action the agent takes is listed with its status.
    await sendMessage(panel, "tool:edit");
    await expect.poll(() => permissionTitles(panel), { timeout: 20_000 }).toHaveLength(1);
    await answerPermission(panel, "allow-once");
    await expect.poll(() => logText(panel), { timeout: 20_000 }).toMatch(/done:call-\d+/);
    const listed = await actionRows(panel);
    expect(listed).toEqual([expect.objectContaining({ title: "Edit src/app.ts", kind: "edit", status: "done" })]);

    // US1.4: Stop - the conversation says so and nothing more of that turn runs.
    await waitComposerReady(panel);
    const before = (await fakeLog()).length;
    await sendMessage(panel, "chunks:2 hang tool:execute");
    // The first turn said `part-2;` too: this turn's is the second.
    await expect.poll(async () => countMatches(await logText(panel), /part-2;/g), { timeout: 20_000 }).toBe(2);
    expect(await panel.clickIfPresent(ui("conversation.stop"))).toBe(true);
    await waitComposerReady(panel);
    await sleep(2_500);
    const after = (await fakeLog()).slice(before);
    expect(after.some((line) => line.method === "session/cancel"), JSON.stringify(after)).toBe(true);
    expect(after.some((line) => line.event === "permission-answer"), "no action of the stopped turn ran").toBe(false);
    expect(await permissionTitles(panel)).toEqual([]);
    expect((await actionRows(panel)).some((row) => row.kind === "execute"), "the turn's later tool never started").toBe(false);
    // US1.4 "the conversation says it was stopped": the state line or a notice after the turn.
    await expect.poll(() => stoppedSaid(panel), { timeout: 10_000, message: "US1.4: the panel says the turn was stopped" }).toBe(true);

    // SC-140, US2.5: exactly two modes are offered, and none approves everything.
    expect(await modeChoices(panel)).toEqual([
      { value: "strict", label: ui("conversation.mode.strict"), checked: true },
      { value: "agent-review", label: ui("conversation.mode.agent-review"), checked: false },
    ]);
  });

  test("strict mode: a card for every change, each answer honoured, and the per-conversation rule (US2.1-2.4)", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(180_000);
    await resetHostConversationState(extensionWorker);
    const { panel } = await ownerPanel({ extensionContext, extensionId, extensionWorker });
    const first = await startConversation(panel);
    expect((await headerValues(panel))[2]).toBe(ui("conversation.mode.strict"));

    // Reject: the change does not happen and the agent is told.
    await sendMessage(panel, "tool:edit");
    await expect.poll(() => permissionTitles(panel), { timeout: 20_000 }).toHaveLength(1);
    const [title] = await permissionTitles(panel);
    expect(title).toBe(ui("conversation.permission.title").replace("{agent}", AGENT_NAME).replace("{title}", "Edit src/app.ts"));
    // 020 T606 (C5, specs/020-chat-ui/tasks.md): the card's order is allow once, allow for this
    // conversation, reject (`PermissionCard.tsx` ANSWER_ORDER).
    expect(await buttonLabels(panel, ".agent-conversation-permission")).toEqual([
      ui("conversation.permission.allow-once"),
      ui("conversation.permission.allow-conversation"),
      ui("conversation.permission.reject"),
    ]);
    await answerPermission(panel, "reject");
    await expect.poll(() => logText(panel), { timeout: 20_000 }).toMatch(/refused:call-\d+/);
    expect(await lastPermissionAnswer()).toMatchObject({ optionKind: "reject_once" });
    await waitComposerReady(panel);

    // Allow once: it runs, and the next change asks again.
    await sendMessage(panel, "tool:edit");
    await expect.poll(() => permissionTitles(panel), { timeout: 20_000 }).toHaveLength(1);
    await answerPermission(panel, "allow-once");
    await expect.poll(async () => countMatches(await logText(panel), /done:call-\d+/g), { timeout: 20_000 }).toBe(1);
    expect(await lastPermissionAnswer()).toMatchObject({ optionKind: "allow_once" });
    await waitComposerReady(panel);

    await sendMessage(panel, "tool:edit");
    await expect.poll(() => permissionTitles(panel), { timeout: 20_000 }).toHaveLength(1);
    await answerPermission(panel, "allow-conversation");
    await expect.poll(async () => countMatches(await logText(panel), /done:call-\d+/g), { timeout: 20_000 }).toBe(2);
    await waitComposerReady(panel);

    // Allowed for this conversation: no card, still listed, marked as allowed by the rule.
    await sendMessage(panel, "tool:edit");
    await expect.poll(async () => countMatches(await logText(panel), /done:call-\d+/g), { timeout: 20_000 }).toBe(3);
    expect(await permissionTitles(panel)).toEqual([]);
    const rows = await actionRows(panel);
    expect(rows.at(-1)).toMatchObject({ kind: "edit", status: "done", byRule: true });
    await waitComposerReady(panel);

    // A new conversation asks again.
    const second = await startAnotherConversation(panel, first);
    expect(second).toBeTruthy();
    await sendMessage(panel, "tool:edit");
    await expect.poll(() => permissionTitles(panel), { timeout: 20_000 }).toHaveLength(1);
    await answerPermission(panel, "reject");
    await expect.poll(() => logText(panel), { timeout: 20_000 }).toMatch(/refused:call-\d+/);
  });

  test("an external agent's consent card is pinned above both tabs while the Conversation tab is shown (US7.1, US7.2)", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(180_000);
    await resetHostConversationState(extensionWorker);
    const { panel } = await ownerPanel({ extensionContext, extensionId, extensionWorker });
    let external: McpHarnessClient | undefined;
    let tabId: number | undefined;
    try {
      // Pairing is read off the Connections tab's status row.
      await chooseTab(panel, "connections");
      external = await startMcpClient({ clientName: "Claude Code" });
      await panel.clickIfPresent(ui("agent.retry"));
      await pairWithFirstCall(external, panel, { locale });
      tabId = ((await ok(external, "tabs_create", { url: `${SITE}/ordinary` })) as { tabId: number }).tabId;
      const ref = await refFor(external, tabId, "Safe action");

      await chooseTab(panel, "conversation");
      const asked = external.callTool("click", { tabId, target: { ref } }, { timeoutMs: 120_000 });
      await expect.poll(() => pinnedPrompt(panel), { timeout: 20_000 }).toEqual({
        prompt: "consent",
        aboveTabs: true,
        inTabpanel: false,
      });
      expect(await selectedTab(panel)).toBe("conversation");
      // US7.2: the other tab counts what waits there.
      expect(await connectionsCount(panel)).toBe("1");
      await panel.clickButton(ui("agent.refuse"));
      const refused = await asked;
      expect(refused.isError).toBe(true);
      expect(refused.json).toMatchObject({ outcome: "denied", reason: "owner-denied" });
      await expect.poll(() => pinnedPrompt(panel), { timeout: 15_000 }).toBeNull();
      expect(await connectionsCount(panel)).toBeNull();
    } finally {
      if (tabId !== undefined) await extensionWorker.evaluate((id: number) => chrome.tabs.remove(id), tabId).catch(() => undefined);
      await external?.close().catch(() => undefined);
    }
  });
});

/* ------------------------------------------------------------------------------------------- */
/* Part 2 (T557): the panel agent uses this browser under the site rules                         */
/* ------------------------------------------------------------------------------------------- */

test.describe("019 side-panel conversation - part 2 (T557)", () => {
  test.skip(!configured, SKIP_REASON);

  test("reads the viewed tab, asks on an 'ask' site, acts there; the site row names the author; withdrawal refuses the next call", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(240_000);
    await resetHostConversationState(extensionWorker);
    const { panel, ownerPage, ownerTabId } = await ownerPanel({ extensionContext, extensionId, extensionWorker, path: "/ordinary" });
    await startConversation(panel);

    // A read, then a click: reads never ask (gate.ts), the click on an "ask" site does.
    await sendMessage(panel, 'mcp:get_page_text:{"tabId":"$this"} mcp:click:{"tabId":"$this","target":"$ref:Safe%20action"}');
    await expect.poll(() => logText(panel), { timeout: 30_000 }).toContain("mcp:get_page_text:ok:");
    expect(await logText(panel)).toContain("Ordinary page");
    await expect.poll(() => pinnedPrompt(panel), { timeout: 30_000 }).toEqual({
      prompt: "consent",
      aboveTabs: true,
      inTabpanel: false,
    });
    // Nothing ran before the answer.
    await expect(ownerPage.locator("#clicked")).toHaveText("not clicked yet");
    expect(await panel.panelText()).toContain(ui("agent.promptTitle"));
    await panel.clickButton(ui("agent.allowAlways"));

    // The answer: the click landed on the tab the owner was viewing, and the agent answered.
    await expect(ownerPage.locator("#clicked")).toHaveText(/^clicked at /, { timeout: 20_000 });
    await expect.poll(() => logText(panel), { timeout: 30_000 }).toContain("mcp:click:ok:");
    const rows = await actionRows(panel);
    expect(rows.map((row) => [row.title, row.status])).toEqual([
      ["hallpass - get_page_text (MCP)", "done"],
      ["hallpass - click (MCP)", "done"],
    ]);
    // FR-306: that tab was placed into the panel session's group without a claim card.
    const calls = (await fakeLog()).filter((line) => line.event === "mcp-call");
    expect(calls.map((line) => [line.tool, line.isError])).toEqual([
      ["tabs_context", false],
      ["get_page_text", false],
      ["tabs_context", false],
      ["find", false],
      ["click", false],
    ]);
    const listed = JSON.parse(String(calls[0]!.text)) as Array<{ tabId: number; holder: unknown }>;
    expect(listed.find((tab) => tab.holder === "this")?.tabId, "the first action is on the viewed tab").toBe(ownerTabId);
    expect((calls[4]!.args as { tabId?: number }).tabId).toBe(ownerTabId);
    expect(await groupIdOf(extensionWorker, ownerTabId)).toBeGreaterThan(-1);

    // FR-308: the site row says who changed it last.
    await chooseTab(panel, "connections");
    await expect
      .poll(() => panel.evaluatePanel(`(()=>{const row=document.querySelector('[data-site=${JSON.stringify(SITE)}]');if(row&&!row.querySelector('.agent-site-more'))row.querySelector('.agent-site-more-button')?.click();return null})() ?? document.querySelector('[data-site=${JSON.stringify(SITE)}] .agent-site-author')?.textContent ?? null`), {
        timeout: 15_000,
      })
      .toBe(ui("agent.siteChangedBy.panel-agent"));

    // FR-309: withdrawal - the next browser call of the running agent is refused.
    expect(await consentSwitchState(panel)).toBe("granted");
    expect(
      await panel.evaluatePanel("(()=>{const s=document.querySelector('.agent-panel-consent input[role=switch]');if(!s)return false;s.click();return true})()", true),
    ).toBe(true);
    await expect.poll(() => consentSwitchState(panel), { timeout: 15_000 }).toBe("withdrawn");
    await expect.poll(() => readConsentFile(), { timeout: 10_000 }).toBe(false);
    await chooseTab(panel, "conversation");
    await waitComposerReady(panel);
    await sendMessage(panel, "mcp:tabs_context");
    await expect.poll(() => logText(panel), { timeout: 30_000 }).toContain("mcp:tabs_context:error:");
    const refused = (await fakeLog()).filter((line) => line.event === "mcp-call").at(-1);
    expect(refused).toMatchObject({ tool: "tabs_context", isError: true });
    expect(JSON.parse(String(refused!.text))).toMatchObject({ outcome: "denied", reason: "not-admitted" });
    expect(await pinnedPrompt(panel), "a refused call raises no card").toBeNull();
  });
});

/* ------------------------------------------------------------------------------------------- */
/* Part 3 (T564): the panel closes, the agent goes idle, the relay restarts, the list            */
/* ------------------------------------------------------------------------------------------- */

test.describe("019 side-panel conversation - part 3 (T564)", () => {
  test.skip(!configured, SKIP_REASON);

  test("close the panel mid-turn, reopen: the stream is complete (US4.1); a card raised while closed waits (US4.2)", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(240_000);
    await resetHostConversationState(extensionWorker);
    const first = await ownerPanel({ extensionContext, extensionId, extensionWorker });
    let panel = first.panel;
    const conversationId = await startConversation(panel);

    // US4.1: 30 chunks; the panel goes away after the first, the agent keeps going.
    await sendMessage(panel, "chunks:30");
    await expect.poll(() => logText(panel), { timeout: 20_000, intervals: [50] }).toContain("part-1;");
    await closeSidePanel(extensionContext, extensionId);
    await sleep(8_000);
    panel = await reopenPanel(extensionContext, extensionId, first.ownerPage, first.ownerTabId);
    expect(await waitForOpenConversation(panel)).toBe(conversationId);
    await expect.poll(() => logText(panel), { timeout: 20_000 }).toContain("part-30;");
    const text = await logText(panel);
    for (let index = 1; index <= 30; index += 1) expect(text).toContain(`part-${index};`);
    await waitComposerReady(panel);

    // US4.2: the card is raised while the panel is closed; on reopen it is there and nothing ran past it.
    const before = (await fakeLog()).length;
    await sendMessage(panel, "tool:edit chunks:3");
    await closeSidePanel(extensionContext, extensionId);
    await sleep(5_000);
    panel = await reopenPanel(extensionContext, extensionId, first.ownerPage, first.ownerTabId);
    expect(await waitForOpenConversation(panel)).toBe(conversationId);
    await expect.poll(() => permissionTitles(panel), { timeout: 20_000 }).toHaveLength(1);
    expect(await stateLine(panel)).toBe(ui("conversation.state.waiting-for-owner"));
    const waited = (await fakeLog()).slice(before);
    expect(waited.some((line) => line.event === "permission-answer"), "nothing ran past the card").toBe(false);
    expect(countMatches(await logText(panel), /part-1;/g), "the turn's later chunks did not run").toBe(1);
    await answerPermission(panel, "allow-once");
    await expect.poll(() => logText(panel), { timeout: 20_000 }).toMatch(/done:call-\d+/);
    await expect.poll(async () => countMatches(await logText(panel), /part-3;/g), { timeout: 20_000 }).toBe(1);
  });

  test("idle past the limit, the next message resumes with its history (US4.3)", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.skip(!(IDLE_MS >= 1_000 && IDLE_MS <= 60_000), "HALLPASS_BROKER_TEST_IDLE_MS (1-60 s) is the gate's fake clock");
    test.setTimeout(180_000);
    await resetHostConversationState(extensionWorker);
    const { panel } = await ownerPanel({ extensionContext, extensionId, extensionWorker });
    await startConversation(panel);
    await sendMessage(panel, "before-idle");
    await expect.poll(() => logText(panel), { timeout: 20_000 }).toContain("echo:before-idle");
    const started = (await fakeLog()).filter((line) => line.event === "start").length;
    const sessionId = String((await fakeLog()).find((line) => line.method === "session/new")?.params?.sessionId ?? "");
    expect(sessionId).not.toBe("");

    // The idle limit passes: the agent is stopped (its state line says so).
    await expect.poll(() => stateLine(panel), { timeout: IDLE_MS + 20_000 }).toBe(ui("conversation.state.stopped"));

    // The next message starts the agent again on the same session, history kept.
    await sendMessage(panel, "after-idle");
    await expect.poll(() => logText(panel), { timeout: 30_000 }).toContain("echo:after-idle");
    const log = await fakeLog();
    expect(log.filter((line) => line.event === "start").length, "a new agent process").toBe(started + 1);
    expect(log.find((line) => line.method === "session/load")?.params?.sessionId).toBe(sessionId);
    expect(await logText(panel)).toContain("echo:before-idle");
  });

  test("a relay restart in the same browser run leaves the conversation running (worker recycle, FR-295)", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(180_000);
    await resetHostConversationState(extensionWorker);
    const { panel } = await ownerPanel({ extensionContext, extensionId, extensionWorker });
    await startConversation(panel);
    const brokerBefore = await brokerPid();
    expect(brokerBefore, "this browser's broker").toBeGreaterThan(0);

    await sendMessage(panel, "chunks:80");
    await expect.poll(() => logText(panel), { timeout: 20_000, intervals: [50] }).toContain("part-1;");
    const relays = await readLiveBrowserRecords();
    expect(relays.length).toBe(1);
    const oldRelay = relays[0]!.relayPid;
    process.kill(oldRelay);
    // A new relay of the same run comes up and the broker is adopted, not replaced.
    await expect.poll(async () => (await readLiveBrowserRecords())[0]?.relayPid ?? oldRelay, { timeout: 30_000 }).not.toBe(oldRelay);
    await expect.poll(() => logText(panel), { timeout: 60_000 }).toContain("part-80;");
    expect(await brokerPid(), "the same broker, adopted by the new relay").toBe(brokerBefore);
    expect((await fakeLog()).filter((line) => line.event === "start").length, "the same agent process throughout").toBe(1);
    await waitComposerReady(panel);
    await sendMessage(panel, "after-recycle");
    await expect.poll(() => logText(panel), { timeout: 30_000 }).toContain("echo:after-recycle");
  });

  test("the list: newest first with agent and folder; remove takes the entry off and deletes nothing else (US6.1, US6.2)", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(180_000);
    await resetHostConversationState(extensionWorker);
    const { panel } = await ownerPanel({ extensionContext, extensionId, extensionWorker });
    const first = await startConversation(panel);
    await sendMessage(panel, "first-conversation");
    await expect.poll(() => logText(panel), { timeout: 20_000 }).toContain("echo:first-conversation");
    await waitComposerReady(panel);
    const second = await startAnotherConversation(panel, first);
    expect(second).not.toBe(first);
    await sendMessage(panel, "second-conversation");
    await expect.poll(() => logText(panel), { timeout: 20_000 }).toContain("echo:second-conversation");
    await waitComposerReady(panel);

    await showList(panel);
    await expect.poll(async () => (await listEntries(panel)).map((entry) => entry.id), { timeout: 15_000 }).toEqual(
      expect.arrayContaining([first, second]),
    );
    const entries = (await listEntries(panel)).filter((entry) => entry.id === first || entry.id === second);
    expect(entries.map((entry) => entry.id), "newest first").toEqual([second, first]);
    for (const entry of entries) {
      expect(entry.meta).toContain(AGENT_NAME);
      expect(entry.meta).toContain(ui("conversation.folder.scratch"));
      expect(entry.hasTime).toBe(true);
    }

    const storeBefore = await fakeStoreSessions();
    const removing = entries.find((entry) => entry.id === first)!;
    // 020 T605 (ConversationDrawer.tsx): the entry's remove button is an icon button whose name is
    // its hidden words, "Remove “{title}” from the list" - found by that name, not an aria-label.
    const removeName = ui("conversation.list.remove").replace("{title}", () => removing.title);
    expect(
      await panel.evaluatePanel(
        `(()=>{const b=[...document.querySelectorAll('.agent-conversation-entries li[data-conversation-id=${JSON.stringify(first)}] button')].find((x)=>(x.textContent??'').trim()===${JSON.stringify(removeName)});if(!b)return false;b.click();return true})()`,
        true,
      ),
    ).toBe(true);
    await expect.poll(async () => (await listEntries(panel)).map((entry) => entry.id), { timeout: 15_000 }).not.toContain(first);
    expect((await listEntries(panel)).map((entry) => entry.id)).toContain(second);
    expect(removing.title.length).toBeGreaterThan(0);
    // Nothing else deleted: the agent's own record and the scratch folder stay.
    expect(await fakeStoreSessions()).toEqual(storeBefore);
    expect(existsSync(join(hostDataDirectory(), "scratch", first)), "the scratch folder stays").toBe(true);
    const index = JSON.parse(await readFile(join(hostDataDirectory(), "conversations.json"), "utf8")) as unknown;
    expect(JSON.stringify(index)).not.toContain(first);
    expect(JSON.stringify(index)).toContain(second);
    await hideList(panel);
  });
});

/* ------------------------------------------------------------------------------------------- */
/* Part 4 (021 T684, T685): Hermes and DeepSeek, Cancel while starting, Claude Code and Codex   */
/* ------------------------------------------------------------------------------------------- */

test.describe("021 Hermes and DeepSeek - part 4 (T684, T685)", () => {
  test.skip(!configured, SKIP_REASON);
  test.skip(!perAgent, PER_AGENT_SKIP);

  test("Hermes strict: an edit raises a card with its title; Reject writes nothing (SC-155)", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(180_000);
    await resetHostConversationState(extensionWorker);
    const { panel } = await ownerPanel({ extensionContext, extensionId, extensionWorker });
    const hermes = agentLabel("hermes");
    const id = await startConversation(panel, hermes);
    expect(await headerValues(panel)).toEqual([hermes, ui("conversation.folder.scratch"), ui("conversation.mode.strict")]);
    // Hermes was started with the managed layer and set to `default` after session/new.
    const log = await fakeLog();
    expect((log.find((line) => line.event === "start")?.launch as Record<string, string> | undefined)?.HERMES_MANAGED_DIR).toContain("managed");
    expect(log.filter((line) => line.method === "session/set_mode").map((line) => line.params?.modeId)).toEqual(["default"]);

    await sendMessage(panel, "tool:edit");
    await expect.poll(() => permissionTitles(panel), { timeout: 20_000 }).toHaveLength(1);
    expect((await permissionTitles(panel))[0]).toBe(
      ui("conversation.permission.title").replace("{agent}", hermes).replace("{title}", "Edit src/app.ts"),
    );
    await answerPermission(panel, "reject");
    await expect.poll(() => logText(panel), { timeout: 20_000 }).toMatch(/refused:call-\d+/);
    expect(await lastPermissionAnswer()).toMatchObject({ optionId: "deny", optionKind: "reject_once" });
    await waitComposerReady(panel);
    // Nothing was written: the fake writes nothing, and the scratch folder holds no file of that name.
    expect(existsSync(join(hostDataDirectory(), "scratch", id, "src", "app.ts")), "Reject wrote nothing").toBe(false);
    // The broker marks an action the owner rejected as `refused`, not `failed` (conversation.ts tool status).
    expect((await actionRows(panel)).map((row) => [row.title, row.status])).toEqual([["Edit src/app.ts", "refused"]]);
  });

  test("DeepSeek strict: the card shows the announced command, offers Allow once and Reject only; a second action asks again (SC-155, SC-157)", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(180_000);
    await resetHostConversationState(extensionWorker);
    const { panel } = await ownerPanel({ extensionContext, extensionId, extensionWorker });
    const deepseek = agentLabel("deepseek");
    await startConversation(panel, deepseek);
    const started = (await fakeLog()).find((line) => line.event === "start");
    expect(started?.launch).toEqual({ DSH_PERMISSION_MODE: "read-only", DSH_TELEMETRY_MODE: "DISABLED" });

    await sendMessage(panel, "tool:execute");
    await expect.poll(() => permissionTitles(panel), { timeout: 20_000 }).toHaveLength(1);
    const card = await panelSectionText(panel, ".agent-conversation-permission");
    expect(card).toContain("npm test");
    expect(card).toContain("Run the tests to check the change");
    expect(card).toContain(ui("conversation.permission.onceOnly"));
    expect(await buttonLabels(panel, ".agent-conversation-permission")).toEqual([
      ui("conversation.permission.allow-once"),
      ui("conversation.permission.reject"),
    ]);
    await answerPermission(panel, "allow-once");
    await expect.poll(async () => countMatches(await logText(panel), /done:call-\d+/g), { timeout: 20_000 }).toBe(1);
    expect(await lastPermissionAnswer()).toMatchObject({ optionId: "allow-once", optionKind: "allow_once" });
    await waitComposerReady(panel);

    // Allowing once keeps no rule: the next action asks again.
    await sendMessage(panel, "tool:execute");
    await expect.poll(() => permissionTitles(panel), { timeout: 20_000 }).toHaveLength(1);
    expect(await buttonLabels(panel, ".agent-conversation-permission")).toEqual([
      ui("conversation.permission.allow-once"),
      ui("conversation.permission.reject"),
    ]);
    await answerPermission(panel, "reject");
    await expect.poll(() => logText(panel), { timeout: 20_000 }).toMatch(/refused:call-\d+/);
    expect((await fakeLog()).filter((line) => line.event === "permission-answer")).toHaveLength(2);
  });

  test("DeepSeek asking about an action it never announced: a card that can only be rejected (SC-155)", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(180_000);
    await resetHostConversationState(extensionWorker);
    const { panel } = await ownerPanel({ extensionContext, extensionId, extensionWorker });
    await startConversation(panel, agentLabel("deepseek"));

    await sendMessage(panel, "tool:unannounced");
    await expect.poll(() => permissionTitles(panel), { timeout: 20_000 }).toHaveLength(1);
    expect(await panelSectionText(panel, ".agent-conversation-permission")).toContain(ui("conversation.permission.rejectOnly"));
    expect(await buttonLabels(panel, ".agent-conversation-permission")).toEqual([ui("conversation.permission.reject")]);
    await answerPermission(panel, "reject");
    await expect.poll(() => logText(panel), { timeout: 20_000 }).toMatch(/refused:call-\d+/);
    expect(await lastPermissionAnswer()).toMatchObject({ optionId: "reject-once", optionKind: "reject_once" });
    await waitComposerReady(panel);
  });

  test("Cancel while starting: the start is listed with Cancel; Cancel ends it, the words return to the box, the agent process is gone within 5 s (SC-159)", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(180_000);
    await resetHostConversationState(extensionWorker);
    const { panel } = await ownerPanel({ extensionContext, extensionId, extensionWorker });
    const deepseek = agentLabel("deepseek");
    const cancelLabel = ui("conversation.state.cancelStartLabel").replace("{agent}", deepseek);
    // The agent's next start never answers session/new.
    await writeFile(HANG_FLAG!, "hang");
    await expect.poll(() => selectedTab(panel), { timeout: 15_000 }).toBe("conversation");
    await pickAgent(panel, deepseek);
    await submitFirstMessage(panel);
    await expect.poll(() => setupCard(panel), { timeout: 15_000 }).toBe("first-use");
    await panel.clickButton(ui("conversation.firstUse.allow"));
    await expect.poll(() => readConsentFile(), { timeout: 10_000 }).toBe(true);

    const cancelButton = `(()=>{const b=[...document.querySelectorAll('.agent-conversation-starting button')].find((x)=>x.getAttribute('aria-label')===${JSON.stringify(cancelLabel)});return b?b:null})()`;
    try {
      await expect
        .poll(() => panel.evaluatePanel(`${cancelButton} !== null`), { timeout: 30_000, message: "the start is listed with Cancel" })
        .toBe(true);
    } catch (error) {
      throw new Error(`${(error as Error).message}\n[cancel] panel: ${await panel.panelText()}\n[cancel] fake log: ${JSON.stringify(await fakeLog())}\n[cancel] ${await hostStateForMessage(panel)}`);
    }
    expect(await panelSectionText(panel, ".agent-conversation-starting")).toContain(ui("conversation.state.starting").replace("{agent}", deepseek));
    // The broker lists the start (and so shows Cancel) before it admits and spawns the agent: wait for the
    // agent to be up and hanging at session/new before cancelling.
    await expect
      .poll(async () => (await fakeLog()).some((line) => line.event === "hang"), {
        timeout: 60_000,
        message: "the agent was started and hangs at session/new",
      })
      .toBe(true);
    const pids = (await fakeLog()).filter((line) => line.event === "start").map((line) => Number(line.pid));
    expect(pids.length, "the hanging agent was started").toBeGreaterThan(0);

    expect(await panel.evaluatePanel(`(()=>{const b=${cancelButton};if(!b)return false;b.click();return true})()`, true)).toBe(true);
    const cancelledAt = Date.now();
    await expect
      .poll(() => panel.evaluatePanel("document.querySelector('[data-notice-code=start-cancelled]')?.textContent ?? null"), { timeout: 15_000 })
      .toContain(ui("conversation.error.start-cancelled"));
    expect(await panel.evaluatePanel("document.querySelector('.agent-conversation-starting') === null")).toBe(true);
    // The held first message is back in the box, and nothing was sent.
    await expect
      .poll(() => panel.evaluatePanel("document.querySelector('.agent-conversation-composer textarea')?.value ?? null"), { timeout: 10_000 })
      .toBe(FIRST_MESSAGE);
    expect((await fakeLog()).some((line) => line.method === "session/prompt")).toBe(false);
    await expect.poll(() => pids.filter(alive).length, { timeout: 5_000, message: "the agent process is gone within 5 s" }).toBe(0);
    expect(Date.now() - cancelledAt).toBeLessThan(20_000);
  });

  test("Claude Code and Codex: the existing cases stand; one strict turn each (T685, SC-162)", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(180_000);
    await resetHostConversationState(extensionWorker);
    const { panel } = await ownerPanel({ extensionContext, extensionId, extensionWorker });
    const claude = agentLabel("claude-code");
    const codex = agentLabel("codex");

    const first = await startConversation(panel, claude);
    expect((await headerValues(panel))[0]).toBe(claude);
    await sendMessage(panel, "tool:edit");
    await expect.poll(() => permissionTitles(panel), { timeout: 20_000 }).toHaveLength(1);
    expect((await permissionTitles(panel))[0]).toBe(
      ui("conversation.permission.title").replace("{agent}", claude).replace("{title}", "Edit src/app.ts"),
    );
    await answerPermission(panel, "reject");
    await expect.poll(() => logText(panel), { timeout: 20_000 }).toMatch(/refused:call-\d+/);
    expect(await lastPermissionAnswer()).toMatchObject({ optionKind: "reject_once" });
    await waitComposerReady(panel);

    await startAnotherConversation(panel, first, codex);
    expect((await headerValues(panel))[0]).toBe(codex);
    await sendMessage(panel, "tool:edit");
    await expect.poll(() => permissionTitles(panel), { timeout: 20_000 }).toHaveLength(1);
    expect((await permissionTitles(panel))[0]).toBe(
      ui("conversation.permission.title").replace("{agent}", codex).replace("{title}", "Edit src/app.ts"),
    );
    await answerPermission(panel, "allow-once");
    await expect.poll(() => logText(panel), { timeout: 20_000 }).toMatch(/done:call-\d+/);
    expect(await lastPermissionAnswer()).toMatchObject({ optionKind: "allow_once" });
    await waitComposerReady(panel);
  });
});

/* ------------------------------------------------------------------------------------------- */
/* Helpers                                                                                       */
/* ------------------------------------------------------------------------------------------- */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** What the list was built from, for a failure message. */
async function hostStateForMessage(panel: SidePanelDriver): Promise<string> {
  const data = hostDataDirectory();
  const index = await readFile(join(data, "conversations.json"), "utf8").catch((error: unknown) => String(error));
  const brokers: string[] = [];
  for (const name of await readdir(join(data, "brokers")).catch(() => [] as string[])) {
    brokers.push(`${name}=${await readFile(join(data, "brokers", name), "utf8").catch(() => "?")}`);
  }
  const listed = await panel.evaluatePanel(
    "[...document.querySelectorAll('.agent-conversation-entries li')].map(li=>li.getAttribute('data-conversation-id')+' '+li.textContent).join(' | ')",
  );
  return JSON.stringify({ index, brokers, live: await readLiveBrowserRecords(), listed });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

/**
 * Each test starts with no consent, no list and an empty agent log. The reset fixture clears the
 * extension's storage (a new browser run, so a new broker); the broker's own files live under the
 * shared `LOCALAPPDATA` and are cleared here. An earlier test's broker (another browser identity)
 * is on its way out but may still hold a live conversation and write its index entry back after
 * the files are gone - it is stopped first (a process this gate started, under the private
 * `LOCALAPPDATA`). This test's own broker started at the fixture reset and may already have read
 * the index; `afterEach` therefore clears again once every broker is stopped (measured 2026-10-19:
 * index deleted here, previous test's entry still listed).
 */
async function resetHostConversationState(worker: PackagedWorker): Promise<void> {
  const ownIdentity = () =>
    worker.evaluate(async () => {
      const stored = (await chrome.storage.local.get("agentBrowserIdentity")).agentBrowserIdentity as
        | { browserId?: string }
        | undefined;
      return stored?.browserId ?? null;
    });
  try {
    await expect.poll(ownIdentity, { timeout: 30_000, message: "this browser's identity" }).not.toBeNull();
  } catch (error) {
    throw new Error(`${(error as Error).message}\n${await identityDiagnostics(worker)}`);
  }
  const current = (await ownIdentity())!;
  await expect
    .poll(async () => (await readLiveBrowserRecords()).some((record) => record.browserId === current), {
      timeout: 30_000,
      message: "this browser's relay record",
    })
    .toBe(true);
  await stopBrokers(current);
  await clearHostFiles();
  await writeFile(FAKE_LOG!, "");
}

/**
 * Why no identity was minted, for the failure message: the identity is minted on the worker's first
 * relay ack (018 R-279), so this says which extension targets exist, whether the worker answers a
 * storage read, what it was greeted by, and the relay log's last lines.
 */
async function identityDiagnostics(worker: PackagedWorker): Promise<string> {
  const endpoint = process.env.HALLPASS_CDP_ENDPOINT!;
  const targets = await fetch(`${endpoint}/json/list`)
    .then((reply) => reply.json() as Promise<Array<{ type: string; url: string; id: string }>>)
    .then((list) => list.filter((target) => target.url.startsWith("chrome-extension://")).map((t) => `${t.type} ${t.id} ${t.url}`))
    .catch((error: unknown) => [String(error)]);
  const inWorker = await worker
    .evaluate(async () => {
      const started = Date.now();
      const bounded = <T,>(work: Promise<T>) =>
        Promise.race([work, new Promise<string>((resolve) => setTimeout(() => resolve("no-answer-5s"), 5_000))]);
      const local = await bounded(chrome.storage.local.get(null).then((all) => Object.keys(all)));
      const session = await bounded(chrome.storage.session.get(["agentBridgeGreetings", "agentBridgeDisconnects"]));
      return JSON.stringify({ local, session, ms: Date.now() - started });
    })
    .catch((error: unknown) => String(error));
  const relayLog = await readFile(join(hostDataDirectory(), "relay.log"), "utf8")
    .then((text) => text.split(/\r?\n/u).slice(-15).join("\n"))
    .catch((error: unknown) => String(error));
  return `[identity] targets: ${JSON.stringify(targets)}\n[identity] worker: ${inWorker}\n[identity] relay.log tail:\n${relayLog}`;
}

/**
 * Stops every broker a sidecar names, except `keep`'s; returns once they are gone.
 *
 * A sidecar outlives its broker, and Windows hands a dead broker's pid to the next process: on
 * 2026-10-21 a sidecar left by an earlier run named the pid of the gate's own browser, and killing
 * it closed the browser under test. So a pid is stopped only while its command line is still that
 * broker's: `broker.js --browser-id <the sidecar's name>` (broker-launch.ts `spawnBrokerProcess`).
 */
async function stopBrokers(keep?: string): Promise<void> {
  const data = hostDataDirectory();
  const named = new Map<number, string>();
  for (const name of await readdir(join(data, "brokers")).catch(() => [] as string[])) {
    if (!name.endsWith(".json") || name === `${keep}.json`) continue;
    try {
      const pid = (JSON.parse(await readFile(join(data, "brokers", name), "utf8")) as { pid?: unknown }).pid;
      if (typeof pid === "number" && alive(pid)) named.set(pid, name.slice(0, -".json".length));
    } catch {
      // gone or being rewritten
    }
  }
  const commandLines = await commandLinesOf([...named.keys()]);
  const pids = [...named].filter(([pid, browserId]) => {
    const line = commandLines.get(pid) ?? "";
    return /broker\.js/u.test(line) && line.includes(`--browser-id ${browserId}`);
  }).map(([pid]) => pid);
  for (const pid of pids) {
    try {
      process.kill(pid);
    } catch {
      // already gone
    }
  }
  await expect.poll(() => pids.filter(alive).length, { timeout: 15_000, message: "the stopped brokers exit" }).toBe(0);
}

/** The command lines of the given live pids (Windows, one CIM query); a pid that is gone is absent. */
async function commandLinesOf(pids: number[]): Promise<Map<number, string>> {
  const lines = new Map<number, string>();
  if (pids.length === 0) return lines;
  const filter = pids.map((pid) => `ProcessId=${pid}`).join(" OR ");
  const script = `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { [Console]::Out.WriteLine(('{0}' -f $_.ProcessId) + [char]9 + $_.CommandLine) }`;
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
    timeout: 30_000,
  });
  for (const row of stdout.split(/\r?\n/u)) {
    const tab = row.indexOf("\t");
    if (tab > 0) lines.set(Number(row.slice(0, tab)), row.slice(tab + 1));
  }
  return lines;
}

async function clearHostFiles(): Promise<void> {
  const data = hostDataDirectory();
  for (const name of ["conversation-consent", "conversation-consent.json", "conversations.json", "folders.json"]) {
    await rm(join(data, name), { recursive: true, force: true });
  }
}

/**
 * The broker's record of the panel consent: one file per browser (`conversation-consent\<browserId>.json`,
 * T558) - or the earlier single `conversation-consent.json`. This gate runs one browser.
 */
async function consentFiles(): Promise<string[]> {
  const data = hostDataDirectory();
  const perBrowser = (await readdir(join(data, "conversation-consent")).catch(() => [] as string[]))
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(data, "conversation-consent", name));
  const single = join(data, "conversation-consent.json");
  return existsSync(single) ? [...perBrowser, single] : perBrowser;
}

async function readConsentFile(): Promise<boolean | undefined> {
  for (const path of await consentFiles()) {
    try {
      return (JSON.parse(await readFile(path, "utf8")) as { granted: boolean }).granted;
    } catch {
      // being rewritten
    }
  }
  return undefined;
}

async function fakeLog(): Promise<FakeLogLine[]> {
  const raw = await readFile(FAKE_LOG!, "utf8").catch(() => "");
  return raw
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as FakeLogLine);
}

async function lastPermissionAnswer(): Promise<FakeLogLine | undefined> {
  return (await fakeLog()).filter((line) => line.event === "permission-answer").at(-1);
}

async function fakeStoreSessions(): Promise<string[]> {
  const raw = await readFile(FAKE_STORE!, "utf8").catch(() => "{}");
  return Object.keys(JSON.parse(raw) as Record<string, unknown>).sort();
}

/**
 * The broker pid this browser's sidecar names (`hallpass\brokers\<browserId>.json`). The browser is
 * the one with a live record; the reset gives every test a new identity, so an earlier test's
 * broker may still be on its way out under another id.
 */
async function brokerPid(): Promise<number | undefined> {
  const live = await readLiveBrowserRecords();
  expect(live.length, "one live browser record").toBe(1);
  try {
    const parsed = JSON.parse(await readFile(join(hostDataDirectory(), "brokers", `${live[0]!.browserId}.json`), "utf8")) as {
      pid?: unknown;
    };
    return typeof parsed.pid === "number" ? parsed.pid : undefined;
  } catch {
    return undefined;
  }
}

async function ownerPanel(fixtures: {
  extensionContext: BrowserContext;
  extensionId: string;
  extensionWorker: PackagedWorker;
  path?: string;
}): Promise<{ panel: SidePanelDriver; ownerPage: Page; ownerTabId: number }> {
  const { extensionContext, extensionId, extensionWorker } = fixtures;
  const ownerPage = extensionContext.pages()[0] ?? (await extensionContext.newPage());
  await ownerPage.goto(`${SITE}${fixtures.path ?? "/waiting"}`);
  await ownerPage.bringToFront();
  const ownerTabId = await extensionWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) throw new Error("active-tab-missing");
    return tab.id;
  });
  const panel = await reopenPanel(extensionContext, extensionId, ownerPage, ownerTabId);
  return { panel, ownerPage, ownerTabId };
}

async function reopenPanel(context: BrowserContext, extensionId: string, ownerPage: Page, tabId: number): Promise<SidePanelDriver> {
  const panel = await openSidePanel({ context, extensionId, fixturePage: ownerPage, tabId, copy, tab: "as-remembered" });
  await waitForAgentPanel(panel);
  await expect
    .poll(() => panel.evaluatePanel("document.querySelector('[role=tablist]') !== null"), { timeout: 20_000 })
    .toBe(true);
  return panel;
}

/** Closes every side-panel document (the browser's own way of closing it: its document goes). */
async function closeSidePanel(context: BrowserContext, extensionId: string): Promise<void> {
  const page = context.pages()[0]!;
  const session = await context.newCDPSession(page);
  try {
    const url = `chrome-extension://${extensionId}/side-panel.html`;
    const { targetInfos } = (await session.send("Target.getTargets")) as { targetInfos: Array<{ targetId: string; url: string }> };
    const panels = targetInfos.filter((target) => target.url === url);
    expect(panels.length, "a side panel was open").toBeGreaterThan(0);
    for (const target of panels) await session.send("Target.closeTarget", { targetId: target.targetId });
    await expect
      .poll(
        async () =>
          ((await session.send("Target.getTargets")) as { targetInfos: Array<{ url: string }> }).targetInfos.filter(
            (target) => target.url === url,
          ).length,
        { timeout: 10_000 },
      )
      .toBe(0);
  } finally {
    await session.detach().catch(() => undefined);
  }
}

async function selectedTab(panel: SidePanelDriver): Promise<string | null> {
  return (await panel.evaluatePanel(
    "document.querySelector('[role=tab][aria-selected=true]')?.id?.replace('agent-tab-','') ?? null",
  )) as string | null;
}

async function chooseTab(panel: SidePanelDriver, name: "conversation" | "connections"): Promise<void> {
  expect(await panel.evaluatePanel(`(()=>{const b=document.getElementById('agent-tab-${name}');if(!b)return false;b.click();return true})()`, true)).toBe(
    true,
  );
  await expect.poll(() => selectedTab(panel), { timeout: 10_000 }).toBe(name);
}

async function connectionsCount(panel: SidePanelDriver): Promise<string | null> {
  return (await panel.evaluatePanel("document.querySelector('#agent-tab-connections [data-tab-count]')?.textContent ?? null")) as
    | string
    | null;
}

/** The question slot's card, and whether it sits above the tab bar rather than inside a tab. */
async function pinnedPrompt(panel: SidePanelDriver): Promise<{ prompt: string | null; aboveTabs: boolean; inTabpanel: boolean } | null> {
  return (await panel.evaluatePanel(
    `(()=>{const card=document.querySelector('.agent-prompt');if(!card)return null;const bar=document.querySelector('[role=tablist]');` +
      `return {prompt:card.getAttribute('data-prompt'),aboveTabs:bar!==null&&!!(card.compareDocumentPosition(bar)&Node.DOCUMENT_POSITION_FOLLOWING),` +
      `inTabpanel:card.closest('[role=tabpanel]')!==null}})()`,
  )) as { prompt: string | null; aboveTabs: boolean; inTabpanel: boolean } | null;
}

async function setupCard(panel: SidePanelDriver): Promise<string | null> {
  return (await panel.evaluatePanel("document.querySelector('[data-setup]')?.getAttribute('data-setup') ?? null")) as string | null;
}

async function panelSectionText(panel: SidePanelDriver, selector: string): Promise<string> {
  return String((await panel.evaluatePanel(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`)) ?? "");
}

async function buttonLabels(panel: SidePanelDriver, selector: string): Promise<string[]> {
  return (await panel.evaluatePanel(
    `[...document.querySelectorAll(${JSON.stringify(`${selector} button`)})].map((b)=>(b.textContent??'').trim())`,
  )) as string[];
}

async function consentSwitchState(panel: SidePanelDriver): Promise<string | null> {
  return (await panel.evaluatePanel("document.querySelector('.agent-panel-consent')?.getAttribute('data-consent') ?? null")) as
    | string
    | null;
}

/** 020 FR-313: the agent is chosen on the agent chip under the message box (a menu button). */
const AGENT_CHIP = ".agent-conversation-chips button.agent-conversation-chip[aria-haspopup=menu]";
/** The open conversation's first message (020 FR-314: a conversation starts with one). */
const FIRST_MESSAGE = "opening";

/** The agent chip is offered: the empty conversation is shown and nothing is held. */
async function waitForPicker(panel: SidePanelDriver): Promise<void> {
  await expect
    .poll(
      () => panel.evaluatePanel(`(()=>{const c=document.querySelector(${JSON.stringify(AGENT_CHIP)});return !!c&&!c.disabled})()`),
      { timeout: 30_000 },
    )
    .toBe(true);
}

/** Chooses the agent in the agent chip's menu, once the worker has reported it. */
async function pickAgent(panel: SidePanelDriver, name: string = AGENT_NAME): Promise<void> {
  await waitForPicker(panel);
  expect(
    await panel.evaluatePanel(
      `(()=>{const c=document.querySelector(${JSON.stringify(AGENT_CHIP)});if(!c)return false;if(c.getAttribute('aria-expanded')!=='true')c.click();return true})()`,
      true,
    ),
  ).toBe(true);
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
  await expect
    .poll(() =>
      panel.evaluatePanel(
        `(()=>{const c=document.querySelector(${JSON.stringify(AGENT_CHIP)});return !!c&&c.getAttribute('aria-expanded')==='false'&&(c.textContent??'').trim()===${JSON.stringify(name)}})()`,
      ),
    )
    .toBe(true);
}

/** Types the message into the box and presses Send, once Send is offered. */
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

/** The empty conversation's Send: the words are held while the start (or a first-use card) is under way. */
async function submitFirstMessage(panel: SidePanelDriver): Promise<void> {
  await fillAndSend(panel, FIRST_MESSAGE);
}

async function openConversationId(panel: SidePanelDriver): Promise<string | null> {
  return (await panel.evaluatePanel(
    "document.querySelector('section.agent-conversation[data-conversation-id]')?.getAttribute('data-conversation-id') ?? null",
  )) as string | null;
}

/** The open conversation's id once one is on screen (other than `not`, when given). */
async function waitForOpenConversation(panel: SidePanelDriver, not?: string): Promise<string> {
  await expect
    .poll(async () => {
      const id = await openConversationId(panel);
      return id !== null && id !== not;
    }, { timeout: 30_000 })
    .toBe(true);
  return (await openConversationId(panel))!;
}

/** Consent given on the first-use card, then a scratch conversation with the agent, open and idle. */
async function startConversation(panel: SidePanelDriver, name: string = AGENT_NAME): Promise<string> {
  await expect.poll(() => selectedTab(panel), { timeout: 15_000 }).toBe("conversation");
  await pickAgent(panel, name);
  await submitFirstMessage(panel);
  await expect.poll(() => setupCard(panel), { timeout: 15_000 }).toBe("first-use");
  await panel.clickButton(ui("conversation.firstUse.allow"));
  await expect.poll(() => readConsentFile(), { timeout: 10_000 }).toBe(true);
  const id = await waitForOpenConversation(panel);
  await firstTurnDone(panel);
  return id;
}

/** 020 FR-315: "New conversation" over the open one, the agent picked, the first message sent. */
async function startAnotherConversation(panel: SidePanelDriver, previous: string, name: string = AGENT_NAME): Promise<string> {
  await panel.clickButton(ui("conversation.new"));
  await pickAgent(panel, name);
  await submitFirstMessage(panel);
  const id = await waitForOpenConversation(panel, previous);
  await firstTurnDone(panel);
  return id;
}

/** The held first message went (the box is empty), the agent answered it, and the turn is over. */
async function firstTurnDone(panel: SidePanelDriver): Promise<void> {
  await expect
    .poll(() => panel.evaluatePanel("document.querySelector('.agent-conversation-composer textarea')?.value ?? null"), { timeout: 20_000 })
    .toBe("");
  await expect.poll(() => logText(panel), { timeout: 20_000 }).toContain(`echo:${FIRST_MESSAGE}`);
  await waitComposerReady(panel);
}

/** 020 FR-321: opens the drawer of conversations (its rows exist only while it is open). */
async function showList(panel: SidePanelDriver): Promise<void> {
  const open = () => panel.evaluatePanel("document.querySelector('.agent-conversation-drawer[role=dialog]') !== null");
  if (!(await open())) await panel.clickButton(ui("conversation.header.list"));
  await expect.poll(open, { timeout: 10_000 }).toBe(true);
}

async function hideList(panel: SidePanelDriver): Promise<void> {
  expect(
    await panel.evaluatePanel(
      "(()=>{const b=document.querySelector('.agent-conversation-drawer-head button');if(!b)return false;b.click();return true})()",
      true,
    ),
  ).toBe(true);
  await expect
    .poll(() => panel.evaluatePanel("document.querySelector('.agent-conversation-drawer[role=dialog]') === null"), { timeout: 10_000 })
    .toBe(true);
}

async function listEntries(panel: SidePanelDriver): Promise<Array<{ id: string; title: string; meta: string; hasTime: boolean }>> {
  return (await panel.evaluatePanel(
    `[...document.querySelectorAll('.agent-conversation-entries li')].map((li)=>({id:li.getAttribute('data-conversation-id'),` +
      `title:(li.querySelector('.agent-conversation-entry-title')?.textContent??'').trim(),` +
      `meta:(li.querySelector('.agent-conversation-entry-meta')?.textContent??'').replace(/\\s+/g,' ').trim(),` +
      `hasTime:li.querySelector('time[datetime]')!==null}))`,
  )) as Array<{ id: string; title: string; meta: string; hasTime: boolean }>;
}

async function composerReady(panel: SidePanelDriver): Promise<boolean> {
  // Ready = no turn under way: no Stop offered and the state line says nothing busy.
  return (await panel.evaluatePanel(
    `(()=>{const f=document.querySelector('.agent-conversation-composer');if(!f)return false;` +
      `const busy=[...f.querySelectorAll('button')].some((b)=>(b.textContent??'').trim()===${JSON.stringify(ui("conversation.stop"))});return !busy})()`,
  )) as boolean;
}

async function waitComposerReady(panel: SidePanelDriver): Promise<void> {
  await expect.poll(() => composerReady(panel), { timeout: 30_000 }).toBe(true);
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

async function stateLine(panel: SidePanelDriver): Promise<string | null> {
  return (await panel.evaluatePanel("document.querySelector('.agent-conversation-state')?.textContent ?? null")) as string | null;
}

/** Whether the panel says the last turn was stopped: the stopped state line, or a notice in the log. */
async function stoppedSaid(panel: SidePanelDriver): Promise<boolean> {
  if ((await stateLine(panel)) === ui("conversation.state.stopped")) return true;
  return (await panel.evaluatePanel(
    "(()=>{const items=[...document.querySelectorAll('.agent-conversation-log > *')];const last=items[items.length-1];" +
      "return !!last&&last.classList.contains('agent-conversation-notice')&&/stop|cancel/i.test(last.textContent??'')})()",
  )) as boolean;
}

/** 020 FR-320: the mode chip of the open conversation (its accessible name is "Mode: {mode}"). */
const MODE_CHIP = `section.agent-conversation .agent-conversation-chips button.agent-conversation-chip[aria-label^=${JSON.stringify(
  ui("conversation.chip.mode").split("{mode}")[0]!,
)}]`;

/** Agent and folder from the header's "agent · folder" line, then the mode, which its chip carries. */
async function headerValues(panel: SidePanelDriver): Promise<string[]> {
  return (await panel.evaluatePanel(
    "[...document.querySelectorAll('.agent-conversation-header .agent-conversation-header-value')].map((d)=>(d.textContent??'').trim())" +
      `.concat([...document.querySelectorAll(${JSON.stringify(`${MODE_CHIP} .agent-conversation-chip-text`)})].map((s)=>(s.textContent??'').trim()))`,
  )) as string[];
}

/**
 * 020 FR-318: a turn's rows are listed once it ended, folded under "N steps" (failed and refused ones
 * apart, always shown). Waits for the turn to end and unfolds every turn before reading.
 *
 * While a turn runs the thread shows one live line (`.agent-conversation-live`, T606 C2: drawn by the
 * message list, so the running turn itself renders no `[data-turn=running]` group and its "N steps"
 * button only appears once it ended) and the composer offers Stop; the turn has ended when neither is.
 */
async function actionRows(panel: SidePanelDriver): Promise<ActionRow[]> {
  await expect
    .poll(
      async () =>
        (await panel.evaluatePanel(
          "document.querySelector('.agent-conversation-live') === null && document.querySelector('.agent-conversation-turn[data-turn=running]') === null",
        )) === true && (await composerReady(panel)),
      { timeout: 20_000 },
    )
    .toBe(true);
  await panel.evaluatePanel(
    "(()=>{for(const b of document.querySelectorAll('button.agent-conversation-steps[aria-expanded=false]'))b.click();return true})()",
    true,
  );
  await expect
    .poll(() => panel.evaluatePanel("document.querySelectorAll('button.agent-conversation-steps[aria-expanded=false]').length"), {
      timeout: 10_000,
    })
    .toBe(0);
  return (await panel.evaluatePanel(
    `[...document.querySelectorAll('.agent-conversation-actions li')].map((li)=>({` +
      `title:(li.querySelector('.agent-conversation-action-title')?.textContent??'').trim(),` +
      `kind:li.getAttribute('data-kind'),status:li.getAttribute('data-status'),` +
      `byRule:li.querySelector('.agent-conversation-action-rule')!==null}))`,
  )) as ActionRow[];
}

async function permissionTitles(panel: SidePanelDriver): Promise<string[]> {
  return (await panel.evaluatePanel(
    "[...document.querySelectorAll('.agent-conversation-permission h3')].map((h)=>(h.textContent??'').trim())",
  )) as string[];
}

async function answerPermission(panel: SidePanelDriver, answer: "allow-once" | "reject" | "allow-conversation"): Promise<void> {
  const label = ui(`conversation.permission.${answer}`);
  const clicked = await panel.evaluatePanel(
    `(()=>{const b=[...document.querySelectorAll('.agent-conversation-permission button')].find((x)=>(x.textContent??'').trim()===${JSON.stringify(label)});if(!b)return false;b.click();return true})()`,
    true,
  );
  expect(clicked).toBe(true);
  await expect.poll(() => permissionTitles(panel), { timeout: 15_000 }).toEqual([]);
}

/** 020 FR-320: the choices the mode chip's menu offers (opened for the read, closed after). */
async function modeChoices(panel: SidePanelDriver): Promise<Array<{ value: string; label: string; checked: boolean }>> {
  const toggle = `(()=>{const c=document.querySelector(${JSON.stringify(MODE_CHIP)});if(!c)return false;c.click();return true})()`;
  const radios = () => panel.evaluatePanel("document.querySelectorAll('.agent-conversation-mode input[type=radio]').length");
  expect(await panel.evaluatePanel(toggle, true)).toBe(true);
  await expect.poll(radios, { timeout: 10_000 }).toBeGreaterThan(0);
  const choices = (await panel.evaluatePanel(
    "[...document.querySelectorAll('.agent-conversation-mode input[type=radio]')].map((i)=>({value:i.value,label:(i.closest('label')?.textContent??'').trim(),checked:i.checked}))",
  )) as Array<{ value: string; label: string; checked: boolean }>;
  expect(await panel.evaluatePanel(toggle, true)).toBe(true);
  await expect.poll(radios, { timeout: 10_000 }).toBe(0);
  return choices;
}

async function groupIdOf(worker: PackagedWorker, tabId: number): Promise<number> {
  return worker.evaluate(async (id: number) => (await chrome.tabs.get(id)).groupId ?? -1, tabId);
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
  const match = answer.matches.find((candidate) => candidate.label === label) ?? answer.matches[0];
  expect(match?.ref, `find '${label}' returned no ref: ${found.text}`).toBeTruthy();
  return match!.ref;
}
