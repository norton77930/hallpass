import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BrowserContext, Page } from "@playwright/test";
import { hostDataDirectory } from "@hallpass/agent-host";
import { lookup, type AppLocale } from "../../../apps/extension/src/locales/catalog.js";
import { copyFor, localeFromEnv, openSidePanel, waitForAgentPanel, type SidePanelDriver } from "../fixtures/side-panel-driver.js";
import { expect, test, type PackagedWorker } from "../fixtures/packaged-extension.js";

/**
 * 025 T823 - the model picker's live gates, quickstart L1-L10, and the screenshots of the six states
 * of the approved variant A (the 24 visual gates), on the packaged extension.
 *
 * Every claim is read off what the owner is shown - the side panel's own document through its own CDP
 * session (`openSidePanel`) - or off the host's files under the `LOCALAPPDATA` the browser and this
 * runner share, or off the fake agent's request log. Nothing private is imported.
 *
 * The broker side runs the fake ACP agent (`tests/harness/fake-acp-agent.ts`): under `HALLPASS_TEST_MODE=1`
 * the browser's relay starts the broker with `HALLPASS_BROKER_TEST_AGENT` (a JSON argv) for every agent.
 * Pointing that argv at `tests/harness/fake-acp-agent-switch.ts` with `FAKE_ACP_SWITCH_FILE` lets this
 * runner choose the fake's knobs - `FAKE_ACP_MODELS` (the shape of what it reports about its models),
 * `FAKE_ACP_SCENARIO` (which agent it stands in for), `FAKE_ACP_MODELS_ERROR` - for each launch;
 * `FAKE_ACP_REQUEST_LOG` names the file it appends one `{ method, params }` line to per request, in the
 * order received (what "every set before the first prompt" is read from) and `FAKE_ACP_STORE` keeps its
 * sessions across launches (a continued conversation). All of these reach the broker only through the
 * browser's environment, so the browser is started with them (`.scratch/025/run-gate.sh`, `env.sh`).
 *
 * The broker must be this checkout's 025 host: a conversation start records the agent's model offer in
 * `agent-models.json` (the host's file), which an older host never writes; the scenarios say so when it
 * does not appear (`expectOfferRemembered`).
 *
 * Two runs, one per idle limit: the scenarios that let a conversation idle-stop (L8 and the sixth state's
 * timeline) need `HALLPASS_BROKER_TEST_IDLE_MS` between 1 and 60 s - they run only then; every other one
 * runs only without it, because a short idle limit stops conversations in the middle of them.
 *
 * Screenshots go to `.scratch/025/shots/` (not tracked): `a<state>-<en|zh>-<light|dark>.png`, the panel
 * document at 380 px, and `L10-<width>-<en|zh>-<theme>.png`. Run once per locale (`HALLPASS_LOCALE`,
 * which the browser's `--lang` must match).
 *
 * Attach mode only.
 */
const locale = localeFromEnv();
const copy = copyFor(locale);
const ui = (key: string, vars: Record<string, string | number> = {}, at: AppLocale = locale): string =>
  lookup(key, at).replace(/\{([a-zA-Z]+)\}/gu, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
const SITE = "https://127.0.0.1:19443";
const SHOTS = join(process.cwd(), ".scratch", "025", "shots");
const LANG = locale === "zh-TW" ? "zh" : "en";
const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];
const execFileAsync = promisify(execFile);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const js = (value: unknown): string => JSON.stringify(value);

const AGENT_CHIP = ".agent-conversation-chips button.agent-conversation-chip[aria-haspopup=menu]";
const MODEL_CHIP = 'button[data-chip="model"]';
const MODEL_POPUP = "div.agent-conversation-model";
const FIRST_MESSAGE = "opening";
const CLAUDE = ui("conversation.agent.claude-code");
const CODEX = ui("conversation.agent.codex");
const HERMES = ui("conversation.agent.hermes");
/** The fake's invented names (`FAKE_ACP_MODELS=config`): what the agent calls its models and efforts. */
const NAMES = { alpha: "Model Alpha", beta: "Model Beta", gamma: "Model Gamma", high: "High", medium: "Medium", low: "Low" } as const;

const attach = Boolean(process.env.HALLPASS_CDP_ENDPOINT);
const SWITCH_FILE = process.env.FAKE_ACP_SWITCH_FILE;
const REQUEST_LOG = process.env.FAKE_ACP_REQUEST_LOG;
const IDLE_MS = Number(process.env.HALLPASS_BROKER_TEST_IDLE_MS ?? "0");
const idleRun = IDLE_MS >= 1_000 && IDLE_MS <= 60_000;
const broker = attach && process.env.HALLPASS_TEST_MODE === "1" && Boolean(process.env.HALLPASS_BROKER_TEST_AGENT) && Boolean(SWITCH_FILE) && Boolean(REQUEST_LOG);
const BROKER_SKIP =
  "the fake agent behind the broker: HALLPASS_TEST_MODE=1, HALLPASS_BROKER_TEST_AGENT, FAKE_ACP_SWITCH_FILE and FAKE_ACP_REQUEST_LOG, " +
  "set alike for the browser under test and this runner (.scratch/025/env.sh with GATE_BROKER=1)";

if (attach) mkdirSync(SHOTS, { recursive: true });

type Fixtures = { extensionContext: BrowserContext; extensionId: string; extensionWorker: PackagedWorker };
type Shape = "none" | "config" | "config-no-effort" | "models" | "refuse" | "effort-moves";
type Scenario = "claude" | "codex" | "hermes";

test.afterEach(async () => {
  if (!broker) return;
  // The next test's broker starts at its fixture reset and reads the files then: leave it nothing.
  await stopBrokers();
  await clearHostFiles();
  await rm(SWITCH_FILE!, { force: true });
});

/* ------------------------------------------------------------------------------------------- */
/* The scenarios that run with the ordinary idle limit                                         */
/* ------------------------------------------------------------------------------------------- */

test.describe("025 model picker (quickstart L1-L10)", () => {
  test.skip(!attach, "attach mode only (HALLPASS_CDP_ENDPOINT)");
  test.skip(!broker, BROKER_SKIP);
  test.skip(idleRun, "a short idle limit stops conversations in the middle of these; they run without HALLPASS_BROKER_TEST_IDLE_MS");

  /* L1 + visual state 1 */
  test("L1 + a1: first use - the chip says Default and its popup says the list comes once the conversation starts", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(180_000);
    await resetHost({ shape: "config" });
    const panel = await conversationPanel({ extensionContext, extensionId, extensionWorker });
    await expect.poll(() => modelChip(panel), { timeout: 30_000 }).not.toBeNull();
    const chip = (await modelChip(panel))!;
    expect(chip.text).toBe(ui("conversation.model.default"));
    expect(chip.label).toBe(ui("conversation.chip.model", { model: ui("conversation.model.default") }));
    expect(chip.expanded).toBe("false");

    await clickChip(panel);
    await expect.poll(() => popup(panel), { timeout: 10_000 }).not.toBeNull();
    const open = (await popup(panel))!;
    expect(open.groups.map((group) => group.label), "no efforts before a list is known").toEqual([ui("conversation.model.label")]);
    expect(open.groups[0]!.radios, "the one choice is the agent's default").toMatchObject([{ value: "default", checked: true }]);
    expect(open.divider).toBe(false);
    expect(open.hint).toBe(ui("conversation.model.noList"));
    expect((await modelChip(panel))!.expanded).toBe("true");
    await shoot(panel, 1);
  });

  /* L2 + visual state 2 */
  test("L2 + a2: a model and an effort picked before the start - at most three presses, set before the prompt, no change line", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(240_000);
    await resetHost({ shape: "config" });
    const panel = await conversationPanel({ extensionContext, extensionId, extensionWorker });
    await startConversation(panel, { agent: CLAUDE });
    await newConversation(panel);
    await pickAgent(panel, CLAUDE);
    await resetRequests();

    // SC-178: after opening the chip, the model and the effort are two presses more.
    let presses = 0;
    await clickChip(panel);
    presses += 1;
    await chooseRadio(panel, "model", "model-beta");
    presses += 1;
    await chooseRadio(panel, "effort", "high");
    presses += 1;
    expect(presses).toBeLessThanOrEqual(3);
    await expect.poll(async () => (await modelChip(panel))?.text, { timeout: 10_000 }).toBe(chipWords(NAMES.beta, NAMES.high));
    // The popup stays open after a pick, and shows both choices checked.
    const open = (await popup(panel))!;
    expect(open.groups.map((group) => group.label)).toEqual([ui("conversation.model.label"), ui("conversation.model.effortLabel")]);
    expect(open.divider).toBe(true);
    expect(open.groups[0]!.radios.filter((radio) => radio.checked).map((radio) => radio.value)).toEqual(["model-beta"]);
    expect(open.groups[1]!.radios.filter((radio) => radio.checked).map((radio) => radio.value)).toEqual(["high"]);
    expect((await requests()).filter(isModelRequest), "choosing on the chip before a start asks the agent for nothing (SC-182)").toEqual([]);
    await shoot(panel, 2);

    await sendFirstMessage(panel, FIRST_MESSAGE);
    await expect.poll(() => logText(panel), { timeout: 30_000 }).toContain(`echo:${FIRST_MESSAGE}`);
    const log = await requests();
    expect(setsOf(log), "the model, then the effort").toEqual([
      { method: "session/set_config_option", configId: "model", value: "model-beta" },
      { method: "session/set_config_option", configId: "effort", value: "high" },
    ]);
    expectSetsBeforeFirstPrompt(log);
    expect(await changeLines(panel), "a start is not a change").toEqual([]);
    expect((await modelChip(panel))!.text).toBe(chipWords(NAMES.beta, NAMES.high));
  });

  /* L3 */
  test("L3: the next conversation preselects the last choice and applies it without being touched", async ({ extensionContext, extensionId, extensionWorker }) => {
    test.setTimeout(300_000);
    await resetHost({ shape: "config" });
    const panel = await conversationPanel({ extensionContext, extensionId, extensionWorker });
    await startConversation(panel, { agent: CLAUDE });
    await newConversation(panel);
    await pickAgent(panel, CLAUDE);
    await clickChip(panel);
    await chooseRadio(panel, "model", "model-beta");
    await chooseRadio(panel, "effort", "high");
    await sendFirstMessage(panel, FIRST_MESSAGE);
    await expect.poll(() => logText(panel), { timeout: 30_000 }).toContain(`echo:${FIRST_MESSAGE}`);
    await waitComposerReady(panel);

    await newConversation(panel);
    await pickAgent(panel, CLAUDE);
    await expect.poll(async () => (await modelChip(panel))?.text, { timeout: 15_000 }).toBe(chipWords(NAMES.beta, NAMES.high));
    await clickChip(panel);
    const open = (await popup(panel))!;
    expect(open.groups[0]!.radios.filter((radio) => radio.checked).map((radio) => radio.value)).toEqual(["model-beta"]);
    expect(open.groups[1]!.radios.filter((radio) => radio.checked).map((radio) => radio.value)).toEqual(["high"]);
    await clickChip(panel);

    // Sent as it stands, the choice still reaches the agent before the prompt (SC-179).
    await resetRequests();
    await sendFirstMessage(panel, "second");
    await expect.poll(() => logText(panel), { timeout: 30_000 }).toContain("echo:second");
    const log = await requests();
    expect(setsOf(log)).toEqual([
      { method: "session/set_config_option", configId: "model", value: "model-beta" },
      { method: "session/set_config_option", configId: "effort", value: "high" },
    ]);
    expectSetsBeforeFirstPrompt(log);
    expect(await changeLines(panel)).toEqual([]);
  });

  /* L4 */
  test("L4: a change between turns adds exactly one line, and the chip shows it", async ({ extensionContext, extensionId, extensionWorker }) => {
    test.setTimeout(240_000);
    await resetHost({ shape: "config" });
    const panel = await conversationPanel({ extensionContext, extensionId, extensionWorker });
    await startConversation(panel, { agent: CLAUDE });
    expect((await modelChip(panel))!.text).toBe(ui("conversation.model.default"));
    expect(await changeLines(panel)).toEqual([]);
    await resetRequests();

    await clickChip(panel);
    await chooseRadio(panel, "model", "model-gamma");
    await expect.poll(() => changeLines(panel), { timeout: 15_000 }).toEqual([ui("conversation.model.changed", { model: NAMES.gamma })]);
    await expect.poll(async () => (await modelChip(panel))?.text).toBe(NAMES.gamma);
    await sleep(1_500);
    expect(await changeLines(panel), "one change, one line").toHaveLength(1);
    const log = await requests();
    expect(log.filter(isModelRequest), "one request for it").toHaveLength(1);
    expect(setsOf(log)).toEqual([{ method: "session/set_config_option", configId: "model", value: "model-gamma" }]);
    expect(log.some((line) => line.method === "session/prompt"), "opening the chip and choosing asked no model (SC-182)").toBe(false);
  });

  /* L5 */
  test("L5: a model change that moves the effort names the effort the agent now reports", async ({ extensionContext, extensionId, extensionWorker }) => {
    test.setTimeout(240_000);
    await resetHost({ shape: "effort-moves" });
    const panel = await conversationPanel({ extensionContext, extensionId, extensionWorker });
    await startConversation(panel, { agent: CLAUDE });

    await clickChip(panel);
    await chooseRadio(panel, "effort", "high");
    await expect.poll(() => changeLines(panel), { timeout: 15_000 }).toEqual([ui("conversation.model.effortChanged", { effort: NAMES.high })]);

    // Model Gamma offers only Low and Medium: the agent moves High to Medium and says so.
    await chooseRadio(panel, "model", "model-gamma");
    await expect
      .poll(() => changeLines(panel), { timeout: 15_000 })
      .toEqual([
        ui("conversation.model.effortChanged", { effort: NAMES.high }),
        ui("conversation.model.changedEffort", { model: NAMES.gamma, effort: NAMES.medium }),
      ]);
    await expect.poll(async () => (await modelChip(panel))?.text).toBe(chipWords(NAMES.gamma, NAMES.medium));
    const efforts = (await popup(panel))?.groups[1]?.radios.map((radio) => radio.value);
    expect.soft(efforts, "the efforts the popup offers follow the model").toEqual(["low", "medium"]);
  });

  /* L6 */
  test("L6: a refused change says the agent's text, leaves the chip alone and sends one request", async ({ extensionContext, extensionId, extensionWorker }) => {
    test.setTimeout(240_000);
    const AGENT_TEXT = "The requested model is not available right now.";
    await resetHost({ shape: "refuse", error: AGENT_TEXT });
    const panel = await conversationPanel({ extensionContext, extensionId, extensionWorker });
    await startConversation(panel, { agent: CLAUDE });
    await resetRequests();
    const before = (await modelChip(panel))!.text;

    await clickChip(panel);
    await chooseRadio(panel, "model", "model-beta");
    await expect.poll(() => notices(panel, "model-refused"), { timeout: 15_000 }).toHaveLength(1);
    const [said] = await notices(panel, "model-refused");
    expect(said, "the agent's own text is in the notice").toContain(AGENT_TEXT);
    expect(said).toContain(NAMES.beta);
    expect((await modelChip(panel))!.text, "the chip keeps what the agent reports").toBe(before);
    expect(await changeLines(panel), "a refusal leaves no change line").toEqual([]);
    await sleep(2_000);
    const log = await requests();
    expect(setsOf(log), "one set request and no retry").toEqual([{ method: "session/set_config_option", configId: "model", value: "model-beta" }]);
    expect(await notices(panel, "model-refused")).toHaveLength(1);
  });

  /* L7 + visual state 4 */
  test("L7 + a4: while the agent answers the chip is disabled but focusable, says when it can change, and is by keyboard", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(240_000);
    await resetHost({ shape: "config" });
    const panel = await conversationPanel({ extensionContext, extensionId, extensionWorker });
    await startConversation(panel, { agent: CLAUDE });
    await clickChip(panel);
    await chooseRadio(panel, "model", "model-beta");
    await chooseRadio(panel, "effort", "high");
    await expect.poll(async () => (await modelChip(panel))?.text).toBe(chipWords(NAMES.beta, NAMES.high));
    await clickChip(panel);
    await expect.poll(async () => (await modelChip(panel))?.expanded).toBe("false");

    // `hang`: the turn never ends until it is cancelled.
    await sendMessage(panel, "hang");
    try {
      await expect.poll(async () => (await modelChip(panel))?.ariaDisabled, { timeout: 20_000 }).toBe("true");
      const chip = (await modelChip(panel))!;
      expect(chip.disabled, "disabled for pressing, not removed from the keyboard").toBe(false);
      expect(chip.describedBy, "it names why").not.toBeNull();
      expect(chip.note).toBe(ui("conversation.model.busy"));
      expect(chip.text, "it still says the model").toBe(chipWords(NAMES.beta, NAMES.high));
      expect(await panel.evaluatePanel("document.querySelector('p.agent-conversation-model-note') !== null")).toBe(true);

      // A press opens nothing; the keyboard reaches it.
      await clickChip(panel);
      expect(await popup(panel)).toBeNull();
      await keyboardReady(panel);
      await focusComposer(panel);
      const tabs = await tabTo(panel, MODEL_CHIP);
      expect(tabs).toBeLessThanOrEqual(20);
      expect((await modelChip(panel))!.focused).toBe(true);
      await press(panel, "Enter");
      expect(await popup(panel), "Enter opens nothing either").toBeNull();
      await shoot(panel, 4);

      // Once the answer is over the chip opens again.
      await panel.clickButton(ui("conversation.stop"));
      await waitComposerReady(panel);
      await expect.poll(async () => (await modelChip(panel))?.ariaDisabled, { timeout: 20_000 }).toBeNull();
      await clickChip(panel);
      await expect.poll(() => popup(panel), { timeout: 10_000 }).not.toBeNull();
    } finally {
      await panel.clickIfPresent(ui("conversation.stop"));
    }
  });

  /* L9 */
  test("L9: an agent that reports no models has no chip after the start, and none at the next new conversation", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(240_000);
    await resetHost({ shape: "none" });
    const panel = await conversationPanel({ extensionContext, extensionId, extensionWorker });
    // Nothing is known yet: the new conversation's chip says Default.
    await expect.poll(() => modelChip(panel), { timeout: 30_000 }).not.toBeNull();
    await startConversation(panel, { agent: CLAUDE });
    expect(await modelChip(panel), "no chip in the conversation").toBeNull();
    await newConversation(panel);
    await pickAgent(panel, CLAUDE);
    await expect.poll(() => modelChip(panel), { timeout: 15_000 }).toBeNull();
    expect(await panel.evaluatePanel(`document.querySelector(${js(MODEL_POPUP)}) === null`)).toBe(true);
  });

  /* visual state 3 */
  test("a3: a running Codex conversation shows 'model · effort' on its chip (config shape)", async ({ extensionContext, extensionId, extensionWorker }) => {
    test.setTimeout(240_000);
    await resetHost({ shape: "config", scenario: "codex" });
    const panel = await conversationPanel({ extensionContext, extensionId, extensionWorker });
    await startConversation(panel, { agent: CODEX });
    await clickChip(panel);
    await chooseRadio(panel, "model", "model-beta");
    await chooseRadio(panel, "effort", "high");
    await expect.poll(async () => (await modelChip(panel))?.text, { timeout: 15_000 }).toBe(chipWords(NAMES.beta, NAMES.high));
    expect(await changeLines(panel)).toHaveLength(2);
    expect((await popup(panel))?.groups.map((group) => group.label)).toEqual([ui("conversation.model.label"), ui("conversation.model.effortLabel")]);
    await shoot(panel, 3);
  });

  /* visual state 5 */
  test("a5: Hermes (the models shape) offers its list and no effort", async ({ extensionContext, extensionId, extensionWorker }) => {
    test.setTimeout(240_000);
    await resetHost({ shape: "models", scenario: "hermes" });
    const panel = await conversationPanel({ extensionContext, extensionId, extensionWorker });
    await startConversation(panel, { agent: HERMES });
    await newConversation(panel);
    await pickAgent(panel, HERMES);
    await expect.poll(() => modelChip(panel), { timeout: 15_000 }).not.toBeNull();
    await clickChip(panel);
    const open = (await popup(panel))!;
    expect(open.groups.map((group) => group.label), "no effort for the older list").toEqual([ui("conversation.model.label")]);
    expect(open.divider).toBe(false);
    const values = open.groups[0]!.radios.map((radio) => radio.value);
    expect(values.slice(0, 3)).toEqual(["acme:model-one", "acme:model-two", "zenith:model-three"]);
    expect(values, "the fake's whole list, fifteen models").toHaveLength(15);
    expect(open.hint, "a list is known: no first-use line").toBeNull();
    // Visual state 5: a long list scrolls inside the popup, the page itself does not.
    const scrolls = await panel.evaluatePanel(
      // The chip menus share one scrolling frame, `.agent-conversation-popup`, around the menu itself.
      `(()=>{const m=document.querySelector(${js(MODEL_POPUP)});const f=m?.closest('.agent-conversation-popup');const all=m?[...(f?[f]:[]),m,...m.querySelectorAll('*')]:[];` +
        `const s=all.find((el)=>el.scrollHeight>el.clientHeight+1&&getComputedStyle(el).overflowY!=='visible');` +
        `return {inner:Boolean(s),page:document.documentElement.scrollWidth>document.documentElement.clientWidth}})()`,
    );
    expect(scrolls, "the model list scrolls inside the popup and nothing scrolls sideways").toEqual({ inner: true, page: false });
    await shoot(panel, 5);
  });

  /* L10 */
  test("L10: by keyboard alone at 380 and 320 px, light and dark - every control reachable and nothing scrolls sideways", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(300_000);
    await resetHost({ shape: "config" });
    const panel = await conversationPanel({ extensionContext, extensionId, extensionWorker });
    await startConversation(panel, { agent: CLAUDE });
    await newConversation(panel);
    await pickAgent(panel, CLAUDE);
    await keyboardReady(panel);
    try {
      // The chip, the two groups and Escape, with the keys only.
      await focusComposer(panel);
      await tabTo(panel, MODEL_CHIP);
      await press(panel, "Enter");
      await expect.poll(async () => (await modelChip(panel))?.expanded).toBe("true");
      expect(await focusedRadio(panel), "the open menu puts the focus on the checked model").toMatchObject({ group: "model", value: "default" });
      await press(panel, "ArrowDown");
      expect(await focusedRadio(panel), "arrows only move").toMatchObject({ group: "model", value: "model-alpha", checked: false });
      await press(panel, "Enter");
      await expect.poll(async () => (await modelChip(panel))?.text).toBe(NAMES.alpha);
      await press(panel, "Tab");
      expect(await focusedRadio(panel), "Tab goes to the efforts").toMatchObject({ group: "effort", value: "default" });
      await press(panel, "ArrowRight");
      await press(panel, "Space");
      await expect.poll(async () => (await modelChip(panel))?.text).toBe(chipWords(NAMES.alpha, NAMES.low));
      expect((await popup(panel)) !== null, "the popup stays open after a pick").toBe(true);
      await press(panel, "Escape");
      await expect.poll(() => popup(panel)).toBeNull();
      expect((await modelChip(panel))!.focused, "Escape returns the focus to the chip").toBe(true);

      // The same choices open and sit inside the panel at both widths and in both themes.
      for (const width of [380, 320]) {
        await panel.sendToPanel("Emulation.setDeviceMetricsOverride", { width, height: 680, deviceScaleFactor: 1, mobile: false });
        await expect.poll(() => panel.evaluatePanel("window.innerWidth")).toBe(width);
        for (const theme of THEMES) {
          await emulateTheme(panel, theme);
          await focusComposer(panel);
          await tabTo(panel, MODEL_CHIP);
          await press(panel, "Enter");
          await expect.poll(() => popup(panel), { timeout: 10_000 }).not.toBeNull();
          await expectNoSidewaysScroll(panel, `${width} px ${theme}, the new conversation's popup`);
          await capture(panel, `L10-${width}-${LANG}-${theme}.png`);
          await press(panel, "Escape");
          await expect.poll(() => popup(panel)).toBeNull();
        }
      }
      await panel.sendToPanel("Emulation.setDeviceMetricsOverride", { width: 380, height: 680, deviceScaleFactor: 1, mobile: false });
      await emulateTheme(panel, "light");

      // The running conversation's chip, by keyboard, at both widths.
      await sendFirstMessage(panel, FIRST_MESSAGE);
      await expect.poll(() => logText(panel), { timeout: 30_000 }).toContain(`echo:${FIRST_MESSAGE}`);
      await waitComposerReady(panel);
      await resetRequests();
      for (const width of [380, 320]) {
        await panel.sendToPanel("Emulation.setDeviceMetricsOverride", { width, height: 680, deviceScaleFactor: 1, mobile: false });
        await expect.poll(() => panel.evaluatePanel("window.innerWidth")).toBe(width);
        for (const theme of THEMES) {
          await emulateTheme(panel, theme);
          await focusComposer(panel);
          await tabTo(panel, MODEL_CHIP);
          await press(panel, "Enter");
          await expect.poll(() => popup(panel), { timeout: 10_000 }).not.toBeNull();
          await expectNoSidewaysScroll(panel, `${width} px ${theme}, the conversation's popup`);
          await capture(panel, `L10-${width}-${LANG}-${theme}-conversation.png`);
          await press(panel, "Escape");
          await expect.poll(() => popup(panel)).toBeNull();
        }
      }
      const before = (await changeLines(panel)).length;
      await focusComposer(panel);
      await tabTo(panel, MODEL_CHIP);
      await press(panel, "Enter");
      await expect.poll(() => popup(panel), { timeout: 10_000 }).not.toBeNull();
      await press(panel, "ArrowDown");
      await press(panel, "Enter");
      await expect.poll(async () => (await changeLines(panel)).length, { timeout: 15_000 }).toBe(before + 1);
      await press(panel, "Escape");
      expect((await modelChip(panel))!.focused).toBe(true);
    } finally {
      await panel.sendToPanel("Emulation.clearDeviceMetricsOverride").catch(() => undefined);
      await panel.sendToPanel("Emulation.setEmulatedMedia", { features: [] }).catch(() => undefined);
    }
  });
});

/* ------------------------------------------------------------------------------------------- */
/* The scenarios that let a conversation idle-stop                                              */
/* ------------------------------------------------------------------------------------------- */

test.describe("025 model picker - idle stop (quickstart L8, visual state 6)", () => {
  test.skip(!attach, "attach mode only (HALLPASS_CDP_ENDPOINT)");
  test.skip(!broker, BROKER_SKIP);
  test.skip(!idleRun, "HALLPASS_BROKER_TEST_IDLE_MS (1-60 s) is the gate's fake clock: run with GATE_IDLE_MS (.scratch/025/run-gate.sh)");

  /* L8 */
  test("L8 [idle]: after the idle stop the next message finds the agent on the conversation's model, set before the prompt", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(180_000);
    await resetHost({ shape: "config" });
    const panel = await conversationPanel({ extensionContext, extensionId, extensionWorker });
    await startConversation(panel, { agent: CLAUDE });
    await clickChip(panel);
    await chooseRadio(panel, "model", "model-beta");
    await chooseRadio(panel, "effort", "high");
    await expect.poll(async () => (await modelChip(panel))?.text).toBe(chipWords(NAMES.beta, NAMES.high));
    expect(await changeLines(panel)).toHaveLength(2);

    await expect.poll(() => stateLine(panel), { timeout: IDLE_MS + 30_000 }).toBe(ui("conversation.state.stopped"));
    const stopped = (await modelChip(panel))!;
    expect(stopped.disabled, "a stopped conversation's chip is not offered").toBe(true);
    expect(stopped.text, "it shows the model the conversation was left on").toBe(chipWords(NAMES.beta, NAMES.high));
    await resetRequests();

    await sendMessage(panel, "after-idle");
    await expect.poll(() => logText(panel), { timeout: 60_000 }).toContain("echo:after-idle");
    const log = await requests();
    const opened = log.findIndex((line) => line.method === "session/load" || line.method === "session/resume");
    expect(opened, "the agent was started again on the same session").toBeGreaterThanOrEqual(0);
    expect(setsOf(log), "the model, then the effort, as the conversation had them").toEqual([
      { method: "session/set_config_option", configId: "model", value: "model-beta" },
      { method: "session/set_config_option", configId: "effort", value: "high" },
    ]);
    expectSetsBeforeFirstPrompt(log);
    expect(log.findIndex(isModelRequest), "after the session is open").toBeGreaterThan(opened);
    expect(await changeLines(panel), "a re-apply is not a change").toHaveLength(2);
    expect((await modelChip(panel))!.text).toBe(chipWords(NAMES.beta, NAMES.high));
  });

  /* visual state 6 */
  test("a6 [idle]: the timeline after an accepted change - one line, between a model-unavailable and a model-refused notice", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(240_000);
    const AGENT_TEXT = "The requested model is not available right now.";
    await resetHost({ shape: "config" });
    const panel = await conversationPanel({ extensionContext, extensionId, extensionWorker });
    // A first conversation, so the host holds the agent's offer; then the owner's last choice is made one
    // the agent no longer lists (the file is the host's; it reads it at every start).
    await startConversation(panel, { agent: CLAUDE });
    const retired = "Model Zeta";
    await rememberChoice("claude-code", retired);
    await newConversation(panel);
    await pickAgent(panel, CLAUDE);
    await sendFirstMessage(panel, FIRST_MESSAGE);
    await expect.poll(() => notices(panel, "model-unavailable"), { timeout: 60_000 }).toHaveLength(1);
    expect((await notices(panel, "model-unavailable"))[0]).toContain(retired);
    await expect.poll(() => logText(panel), { timeout: 30_000 }).toContain(`echo:${FIRST_MESSAGE}`);
    await waitComposerReady(panel);

    // An accepted change: one line.
    await clickChip(panel);
    await chooseRadio(panel, "model", "model-beta");
    await expect.poll(() => changeLines(panel), { timeout: 15_000 }).toEqual([ui("conversation.model.changed", { model: NAMES.beta })]);
    await clickChip(panel);

    // The agent is stopped by the idle limit and comes back refusing every model change: the conversation's
    // model is re-applied and refused, in the agent's words.
    await expect.poll(() => stateLine(panel), { timeout: IDLE_MS + 30_000 }).toBe(ui("conversation.state.stopped"));
    await writeFile(SWITCH_FILE!, JSON.stringify({ FAKE_ACP_MODELS: "refuse", FAKE_ACP_MODELS_ERROR: AGENT_TEXT }), "utf8");
    await sendMessage(panel, "after-idle");
    await expect.poll(() => logText(panel), { timeout: 60_000 }).toContain("echo:after-idle");
    await expect.poll(() => notices(panel, "model-refused"), { timeout: 30_000 }).toHaveLength(1);
    expect((await notices(panel, "model-refused"))[0]).toContain(AGENT_TEXT);
    expect(await changeLines(panel), "still the one line").toHaveLength(1);
    await waitComposerReady(panel);
    await shoot(panel, 6);
  });
});

/* ------------------------------------------------------------------------------------------- */
/* Helpers                                                                                      */
/* ------------------------------------------------------------------------------------------- */

/** "Name" or "Name · Effort", as the chip says a model and a chosen effort. */
function chipWords(model: string, effort?: string): string {
  return effort === undefined ? model : `${model} · ${effort}`;
}

/**
 * What a test starts from: the fake's knobs for the launches that follow, an empty request log, and none of
 * the host's files an earlier test left (the model store included).
 */
async function resetHost(knobs: { shape: Shape; scenario?: Scenario; error?: string }): Promise<void> {
  await clearHostFiles();
  await writeFile(
    SWITCH_FILE!,
    JSON.stringify({
      FAKE_ACP_MODELS: knobs.shape,
      FAKE_ACP_SCENARIO: knobs.scenario ?? "claude",
      ...(knobs.error === undefined ? {} : { FAKE_ACP_MODELS_ERROR: knobs.error }),
    }),
    "utf8",
  );
  await resetRequests();
}

async function clearHostFiles(): Promise<void> {
  const data = hostDataDirectory();
  for (const name of ["conversation-consent", "conversation-consent.json", "conversations.json", "folders.json", "agent-models.json"]) {
    await rm(join(data, name), { recursive: true, force: true });
  }
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

/* ---- the fake's request log ------------------------------------------------------------------ */

type Request = { method: string; params: Record<string, unknown> };

async function requests(): Promise<Request[]> {
  const raw = await readFile(REQUEST_LOG!, "utf8").catch(() => "");
  return raw
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Request);
}

async function resetRequests(): Promise<void> {
  await writeFile(REQUEST_LOG!, "", "utf8");
}

/** A request that sets the model or the effort (the mode is `session/set_mode`, or an option of its own). */
const isModelRequest = (line: Request): boolean =>
  line.method === "session/set_model" || (line.method === "session/set_config_option" && ["model", "effort"].includes(String(line.params.configId)));

/** The model requests, as `{ method, configId, value }` (a `session/set_model`'s value is its `modelId`). */
function setsOf(log: Request[]): Array<{ method: string; configId?: unknown; value: unknown }> {
  return log.filter(isModelRequest).map((line) =>
    line.method === "session/set_model"
      ? { method: line.method, value: line.params.modelId }
      : { method: line.method, configId: line.params.configId, value: line.params.value },
  );
}

/** SC-179: every model request comes before the first prompt that follows the session being opened. */
function expectSetsBeforeFirstPrompt(log: Request[]): void {
  const firstPrompt = log.findIndex((line) => line.method === "session/prompt");
  const lastSet = log.map((line) => isModelRequest(line)).lastIndexOf(true);
  expect(firstPrompt, `a prompt was sent: ${log.map((line) => line.method).join(", ")}`).toBeGreaterThanOrEqual(0);
  expect(lastSet, `a model request was sent: ${log.map((line) => line.method).join(", ")}`).toBeGreaterThanOrEqual(0);
  expect(lastSet, `a model request came after the first prompt: ${log.map((line) => line.method).join(", ")}`).toBeLessThan(firstPrompt);
}

/** Makes the host's remembered choice for an agent one value (the file is the host's; each start reads it). */
async function rememberChoice(agent: string, model: string): Promise<void> {
  const path = join(hostDataDirectory(), "agent-models.json");
  const file = JSON.parse(await readFile(path, "utf8")) as { version: number; agents: Record<string, { choice?: { model: string } }> };
  const entry = file.agents[agent];
  if (entry === undefined) throw new Error(`agent-models.json holds no offer of ${agent}: ${JSON.stringify(Object.keys(file.agents))}`);
  entry.choice = { model };
  await writeFile(path, JSON.stringify(file), "utf8");
}

/**
 * This checkout's 025 host records an agent's offer in `agent-models.json` at a conversation start; an older
 * host's broker never does, and then none of these scenarios can be evidence - and say why.
 */
async function expectOfferRemembered(agent: string): Promise<void> {
  const path = join(hostDataDirectory(), "agent-models.json");
  const verdict = async (): Promise<string> => {
    try {
      const file = JSON.parse(await readFile(path, "utf8")) as { agents?: Record<string, { offer?: { models?: unknown[] } }> };
      return (file.agents?.[agent]?.offer?.models?.length ?? 0) > 0 ? "ok" : `agent-models.json holds no models of ${agent}`;
    } catch {
      return "no agent-models.json: the serving broker is not this checkout's 025 host (register it with npm run agent-host:install)";
    }
  };
  await expect.poll(verdict, { timeout: 20_000 }).toBe("ok");
}

/* ---- the panel ------------------------------------------------------------------------------- */

/** The owner's tab on the fixture site and its side panel, on the Conversation tab, in this run's language. */
async function conversationPanel(fixtures: Fixtures): Promise<SidePanelDriver> {
  const { extensionContext, extensionId, extensionWorker } = fixtures;
  const ownerPage: Page = extensionContext.pages()[0] ?? (await extensionContext.newPage());
  await ownerPage.goto(`${SITE}/waiting`);
  await ownerPage.bringToFront();
  const ownerTabId = await extensionWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) throw new Error("active-tab-missing");
    return tab.id;
  });
  const panel = await openSidePanel({ context: extensionContext, extensionId, fixturePage: ownerPage, tabId: ownerTabId, copy, tab: "as-remembered" });
  await waitForAgentPanel(panel);
  await expect.poll(() => panel.evaluatePanel("document.querySelector('[role=tablist]') !== null"), { timeout: 20_000 }).toBe(true);
  await ensureLanguage(panel);
  expect(await panel.evaluatePanel(`(()=>{const b=document.getElementById('agent-tab-conversation');if(!b)return false;b.click();return true})()`, true)).toBe(true);
  await expect
    .poll(() => panel.evaluatePanel("document.querySelector('[role=tab][aria-selected=true]')?.id?.replace('agent-tab-','') ?? null"), { timeout: 10_000 })
    .toBe("conversation");
  return panel;
}

/**
 * The panel's copy comes from `chrome.i18n`, which follows the browser's `--lang` (the runner starts it
 * with `HALLPASS_LOCALE`). If the browser speaks the other language, the panel is told this run's.
 */
async function ensureLanguage(panel: SidePanelDriver): Promise<void> {
  if ((await panel.evaluatePanel("document.documentElement.lang")) === locale) return;
  await panel.sendToPanel("Page.enable");
  await panel.sendToPanel("Page.addScriptToEvaluateOnNewDocument", {
    source:
      `(() => { try { Object.defineProperty(chrome.i18n, "getUILanguage", ` +
      `{ value: () => ${js(locale)}, configurable: true, writable: true }); } catch { /* keep the browser's */ } })();`,
  });
  await panel.sendToPanel("Page.reload");
  await sleep(500);
  await waitForAgentPanel(panel);
  await expect.poll(() => panel.evaluatePanel("document.documentElement.lang"), { timeout: 10_000 }).toBe(locale);
}

type ChipState = {
  text: string;
  label: string | null;
  expanded: string | null;
  ariaDisabled: string | null;
  disabled: boolean;
  describedBy: string | null;
  note: string | null;
  focused: boolean;
};

/** The model chip as the owner meets it, or null when the panel shows none. */
async function modelChip(panel: SidePanelDriver): Promise<ChipState | null> {
  return (await panel.evaluatePanel(
    `(()=>{const c=document.querySelector(${js(MODEL_CHIP)});if(!c)return null;const d=c.getAttribute('aria-describedby');const n=d?document.getElementById(d):null;` +
      `return {text:(c.querySelector('.agent-conversation-chip-text')?.textContent??'').trim(),label:c.getAttribute('aria-label'),expanded:c.getAttribute('aria-expanded'),` +
      `ariaDisabled:c.getAttribute('aria-disabled'),disabled:c.disabled,describedBy:d,note:n?(n.textContent??'').trim():null,focused:document.activeElement===c}})()`,
  )) as ChipState | null;
}

/** A press on the model chip (it toggles its popup). */
async function clickChip(panel: SidePanelDriver): Promise<void> {
  await expect
    .poll(() => panel.evaluatePanel(`(()=>{const c=document.querySelector(${js(MODEL_CHIP)});if(!c)return false;c.click();return true})()`, true), { timeout: 20_000 })
    .toBe(true);
}

type PopupState = {
  groups: Array<{ label: string; radios: Array<{ value: string; checked: boolean; name: string }> }>;
  divider: boolean;
  hint: string | null;
};

/** What the chip's popup holds, or null when it is closed. */
async function popup(panel: SidePanelDriver): Promise<PopupState | null> {
  return (await panel.evaluatePanel(
    `(()=>{const m=document.querySelector(${js(MODEL_POPUP)});if(!m)return null;` +
      `const groups=[...m.querySelectorAll('[role=radiogroup]')].map((g)=>({label:(document.getElementById(g.getAttribute('aria-labelledby')??'')?.textContent??'').trim(),` +
      `radios:[...g.querySelectorAll('[role=radio]')].map((r)=>({value:r.getAttribute('data-value')??'',checked:r.getAttribute('aria-checked')==='true',name:r.getAttribute('aria-label')??(r.textContent??'').trim()}))}));` +
      `return {groups,divider:m.querySelector('[data-model-divider]')!==null,hint:m.querySelector('.agent-conversation-model-hint')?.textContent??null}})()`,
  )) as PopupState | null;
}

/** A press on one radio of the open popup: the model radiogroup or the effort one, by its accessible name. */
async function chooseRadio(panel: SidePanelDriver, group: "model" | "effort", value: string): Promise<void> {
  const label = ui(group === "model" ? "conversation.model.label" : "conversation.model.effortLabel");
  const pressed = await panel.evaluatePanel(
    `(()=>{const g=[...document.querySelectorAll(${js(`${MODEL_POPUP} [role=radiogroup]`)})].find((x)=>(document.getElementById(x.getAttribute('aria-labelledby')??'')?.textContent??'').trim()===${js(label)});` +
      `const r=g&&[...g.querySelectorAll('[role=radio]')].find((x)=>x.getAttribute('data-value')===${js(value)});if(!r)return false;r.click();return true})()`,
    true,
  );
  expect(pressed, `no ${group} radio ${value} in the open popup: ${JSON.stringify(await popup(panel))}`).toBe(true);
}

/** The accepted changes' lines of the open conversation, as the timeline says them. */
async function changeLines(panel: SidePanelDriver): Promise<string[]> {
  return (await panel.evaluatePanel("[...document.querySelectorAll('[data-model-line]')].map((e)=>(e.textContent??'').trim())")) as string[];
}

/** The texts of the notices of one code. */
async function notices(panel: SidePanelDriver, code: string): Promise<string[]> {
  return (await panel.evaluatePanel(
    `[...document.querySelectorAll(${js(`[data-notice-code=${js(code)}]`)})].map((e)=>(e.textContent??'').replace(/\\s+/g,' ').trim())`,
  )) as string[];
}

async function logText(panel: SidePanelDriver): Promise<string> {
  return String((await panel.evaluatePanel("document.querySelector('.agent-conversation-log')?.innerText ?? ''")) ?? "");
}

async function stateLine(panel: SidePanelDriver): Promise<string | null> {
  return (await panel.evaluatePanel("document.querySelector('.agent-conversation-state')?.textContent ?? null")) as string | null;
}

async function setupCard(panel: SidePanelDriver): Promise<string | null> {
  return (await panel.evaluatePanel("document.querySelector('[data-setup]')?.getAttribute('data-setup') ?? null")) as string | null;
}

async function composerReady(panel: SidePanelDriver): Promise<boolean> {
  return (await panel.evaluatePanel(
    `(()=>{const f=document.querySelector('.agent-conversation-composer');if(!f)return false;` +
      `return ![...f.querySelectorAll('button')].some((b)=>(b.textContent??'').trim()===${js(ui("conversation.stop"))})})()`,
  )) as boolean;
}

async function waitComposerReady(panel: SidePanelDriver): Promise<void> {
  await expect.poll(() => composerReady(panel), { timeout: 30_000 }).toBe(true);
}

async function fillAndSend(panel: SidePanelDriver, text: string): Promise<void> {
  const filled = await panel.evaluatePanel(
    `(()=>{const e=document.querySelector('.agent-conversation-composer textarea');if(!e)return false;` +
      `Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${js(text)});` +
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

/** A message into an open conversation, sent once its box has emptied. */
async function sendMessage(panel: SidePanelDriver, text: string): Promise<void> {
  await fillAndSend(panel, text);
  await expect
    .poll(() => panel.evaluatePanel("document.querySelector('.agent-conversation-composer textarea')?.value ?? null"), { timeout: 15_000 })
    .toBe("");
}

/** The new conversation's Send: the first-use card, when it comes, is answered Allow. */
async function sendFirstMessage(panel: SidePanelDriver, text: string): Promise<void> {
  await fillAndSend(panel, text);
  await expect
    .poll(
      async () => {
        if ((await setupCard(panel)) === "first-use") await panel.clickIfPresent(ui("conversation.firstUse.allow"));
        return panel.evaluatePanel("document.querySelector('.agent-conversation-composer textarea')?.value ?? null");
      },
      { timeout: 60_000 },
    )
    .toBe("");
}

async function waitForPicker(panel: SidePanelDriver): Promise<void> {
  await expect
    .poll(() => panel.evaluatePanel(`(()=>{const c=document.querySelector(${js(AGENT_CHIP)});return !!c&&!c.disabled})()`), { timeout: 30_000 })
    .toBe(true);
}

/** Chooses the agent in the agent chip's menu, once the worker has reported it. */
async function pickAgent(panel: SidePanelDriver, name: string): Promise<void> {
  await waitForPicker(panel);
  await panel.evaluatePanel(`(()=>{const c=document.querySelector(${js(AGENT_CHIP)});if(c&&c.getAttribute('aria-expanded')!=='true')c.click();return true})()`, true);
  await expect
    .poll(
      () =>
        panel.evaluatePanel(
          `(()=>{const b=[...document.querySelectorAll('.agent-conversation-menu-item[role=menuitemradio]')].find((x)=>!x.disabled&&x.querySelector('.agent-conversation-agent-name')?.textContent===${js(name)});if(!b)return false;b.click();return true})()`,
          true,
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
  await expect
    .poll(() =>
      panel.evaluatePanel(`(()=>{const c=document.querySelector(${js(AGENT_CHIP)});return !!c&&c.getAttribute('aria-expanded')==='false'&&(c.textContent??'').trim()===${js(name)}})()`),
    )
    .toBe(true);
}

async function openConversationId(panel: SidePanelDriver): Promise<string | null> {
  return (await panel.evaluatePanel(
    "document.querySelector('section.agent-conversation[data-conversation-id]')?.getAttribute('data-conversation-id') ?? null",
  )) as string | null;
}

/**
 * Consent given on the first-use card, then a scratch conversation with the agent, open and idle after its
 * first turn. Under a shape that reports models the host must have remembered the agent's offer by then.
 */
async function startConversation(panel: SidePanelDriver, input: { agent: string }): Promise<string> {
  const previous = await openConversationId(panel);
  await pickAgent(panel, input.agent);
  await sendFirstMessage(panel, FIRST_MESSAGE);
  await expect
    .poll(async () => {
      const id = await openConversationId(panel);
      return id !== null && id !== previous;
    }, { timeout: 60_000 })
    .toBe(true);
  await expect.poll(() => logText(panel), { timeout: 40_000 }).toContain(`echo:${FIRST_MESSAGE}`);
  await waitComposerReady(panel);
  const shape = JSON.parse(await readFile(SWITCH_FILE!, "utf8")) as { FAKE_ACP_MODELS?: string };
  if (shape.FAKE_ACP_MODELS !== "none") {
    const agent = input.agent === CODEX ? "codex" : input.agent === HERMES ? "hermes" : "claude-code";
    await expectOfferRemembered(agent);
    await expect.poll(() => modelChip(panel), { timeout: 20_000, message: "the running conversation shows its model chip" }).not.toBeNull();
  }
  return (await openConversationId(panel))!;
}

/** "New conversation" over the open one: the empty box, the model chip of the agent on the agent chip. */
async function newConversation(panel: SidePanelDriver): Promise<void> {
  await panel.clickButton(ui("conversation.new"));
  await expect.poll(() => openConversationId(panel), { timeout: 15_000 }).toBeNull();
  await waitForPicker(panel);
}

/* ---- the keyboard ---------------------------------------------------------------------------- */

const KEYS = {
  Tab: { key: "Tab", code: "Tab", vk: 9 },
  Enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  Space: { key: " ", code: "Space", vk: 32, text: " " },
  Escape: { key: "Escape", code: "Escape", vk: 27 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
} as const;

/** The panel's document takes key events as if it had the focus (it is driven through its own CDP session). */
async function keyboardReady(panel: SidePanelDriver): Promise<void> {
  await panel.sendToPanel("Emulation.setFocusEmulationEnabled", { enabled: true });
}

async function press(panel: SidePanelDriver, name: keyof typeof KEYS): Promise<void> {
  const spec = KEYS[name];
  const text = "text" in spec ? spec.text : undefined;
  const base = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk, modifiers: 0 };
  await panel.sendToPanel("Input.dispatchKeyEvent", { type: text === undefined ? "rawKeyDown" : "keyDown", ...base, ...(text === undefined ? {} : { text }) });
  await panel.sendToPanel("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await sleep(150);
}

/**
 * The focus goes into the message box - the start of the keyboard's way to the chips - or, when the box
 * cannot take it, to nowhere (the next Tab then starts from the top of the document).
 */
async function focusComposer(panel: SidePanelDriver): Promise<void> {
  await panel.evaluatePanel(
    "(()=>{const e=document.querySelector('.agent-conversation-composer textarea');if(e&&!e.disabled){e.focus();return true}document.activeElement?.blur();window.scrollTo(0,0);return false})()",
    true,
  );
}

/** Tab until the focus is on an element matching the selector; the number of presses it took. */
async function tabTo(panel: SidePanelDriver, selector: string, max = 20): Promise<number> {
  for (let presses = 1; presses <= max; presses += 1) {
    await press(panel, "Tab");
    if ((await panel.evaluatePanel(`document.activeElement?.matches(${js(selector)}) === true`)) === true) return presses;
  }
  const where = await panel.evaluatePanel("(()=>{const e=document.activeElement;return e?e.tagName+' '+(e.getAttribute('aria-label')??e.textContent??'').trim().slice(0,40):'none'})()");
  throw new Error(`Tab did not reach ${selector} in ${max} presses (the focus is on ${String(where)})`);
}

/** The popup radio that holds the focus: its group (model or effort), value and whether it is checked. */
async function focusedRadio(panel: SidePanelDriver): Promise<{ group: string; value: string; checked: boolean } | null> {
  return (await panel.evaluatePanel(
    `(()=>{const e=document.activeElement;if(!e||e.getAttribute('role')!=='radio')return null;` +
      `return {group:e.classList.contains('agent-conversation-model-pill')?'effort':'model',value:e.getAttribute('data-value')??'',checked:e.getAttribute('aria-checked')==='true'}})()`,
  )) as { group: string; value: string; checked: boolean } | null;
}

/** SC-183: nothing scrolls sideways, and the open popup is inside the panel's width. */
async function expectNoSidewaysScroll(panel: SidePanelDriver, where: string): Promise<void> {
  const measured = (await panel.evaluatePanel(
    `(()=>{const d=document.scrollingElement;const m=document.querySelector(${js(MODEL_POPUP)});const r=m?m.getBoundingClientRect():null;` +
      `return {page:d.scrollWidth-d.clientWidth,body:document.body.scrollWidth-document.body.clientWidth,width:window.innerWidth,left:r?r.left:null,right:r?r.right:null}})()`,
  )) as { page: number; body: number; width: number; left: number | null; right: number | null };
  expect(measured.page, `${where}: the page scrolls sideways (${JSON.stringify(measured)})`).toBeLessThanOrEqual(0);
  expect(measured.body, `${where}: the body scrolls sideways (${JSON.stringify(measured)})`).toBeLessThanOrEqual(0);
  if (measured.left !== null && measured.right !== null) {
    expect(measured.left, `${where}: the popup leaves the panel on the left (${JSON.stringify(measured)})`).toBeGreaterThanOrEqual(-0.5);
    expect(measured.right, `${where}: the popup leaves the panel on the right (${JSON.stringify(measured)})`).toBeLessThanOrEqual(measured.width + 0.5);
  }
}

/* ---- screenshots ----------------------------------------------------------------------------- */

async function emulateTheme(panel: SidePanelDriver, theme: Theme): Promise<void> {
  await panel.sendToPanel("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
  await sleep(400);
}

/** A screenshot of the panel document, through its own CDP session. */
async function capture(panel: SidePanelDriver, name: string): Promise<void> {
  const shot = await panel.sendToPanel("Page.captureScreenshot", { format: "png" });
  const data = (shot.result as { data?: string } | undefined)?.data;
  expect(data, JSON.stringify(shot).slice(0, 300)).toBeTruthy();
  await writeFile(join(SHOTS, name), Buffer.from(data ?? "", "base64"));
}

/** State `state` of variant A, in this run's language, in both themes, at the prototype's 380 px. */
async function shoot(panel: SidePanelDriver, state: number): Promise<void> {
  try {
    await panel.sendToPanel("Emulation.setDeviceMetricsOverride", { width: 380, height: 680, deviceScaleFactor: 1, mobile: false });
    await expect.poll(() => panel.evaluatePanel("window.innerWidth"), { message: "the panel document is 380 px wide for the shot" }).toBe(380);
    for (const theme of THEMES) {
      await emulateTheme(panel, theme);
      await capture(panel, `a${state}-${LANG}-${theme}.png`);
    }
  } finally {
    await panel.sendToPanel("Emulation.setEmulatedMedia", { features: [] }).catch(() => undefined);
    await panel.sendToPanel("Emulation.clearDeviceMetricsOverride").catch(() => undefined);
  }
}
