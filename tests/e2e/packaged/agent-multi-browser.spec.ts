import type { BrowserContext, Page } from "@playwright/test";
import { lookup } from "../../../apps/extension/src/locales/catalog.js";
import { startMcpClient, type McpHarnessClient, type ToolCallResult } from "../../harness/mcp-client.js";
import { pairWithFirstCall } from "../fixtures/agent-pairing.js";
import {
  copyFor,
  localeFromEnv,
  openSidePanel,
  waitForAgentPanel,
  type SidePanelDriver,
} from "../fixtures/side-panel-driver.js";
import {
  browserIdOfWorker,
  clearBrowserChoices,
  closeAttachedBrowser,
  expect,
  firstCdpEndpoint,
  readLiveBrowserRecords,
  relaunchAttachedBrowser,
  relaunchProblem,
  secondCdpEndpoint,
  test,
  type PackagedWorker,
  type RelaunchedBrowser,
} from "../fixtures/packaged-extension.js";

const locale = localeFromEnv();
const copy = copyFor(locale);
const ui = (key: string): string => lookup(key, locale);

const SITE = "https://127.0.0.1:19443";

/** What the two "browser goes away" tests need beyond the endpoints (see the header). */
const relaunchMissing = relaunchProblem(secondCdpEndpoint);
const relaunchSkipMessage = (): string =>
  `closing and restarting browser B needs the runner to say how: ${relaunchMissing ?? ""} ` +
  "(HALLPASS_GATE_CHROME, HALLPASS_GATE_PROFILE_<B's port>, optional HALLPASS_GATE_CHROME_ARGS; see this file's header).";

/**
 * 018/T512 - two browsers, one bridge (spec 018 US1-US5, SC-127 to SC-132), on the packaged
 * extension, driven by real `mcp-server.js` clients over stdio and by the rendered side panels.
 *
 * How to run (local only, attach mode, Windows):
 *   1. `npm run build:extension:agent`, the page fixtures (`npm run dev:test-pages`, test TLS
 *      certificate installed) and `npm run agent-host:install`.
 *   2. ONE private LOCALAPPDATA directory, set in the environment of BOTH browsers and of the
 *      runner, so both relays publish into the same `hallpass\browsers\` directory and this run's
 *      `mcp-server.js` processes see both. Start `HALLPASS_FOREIGN_AGENT_SERVERS=allow` (it is
 *      refused with the default LOCALAPPDATA).
 *   3. Two Playwright Chromium instances, each with its OWN `--user-data-dir` (two profiles =
 *      two browser identities), `--remote-debugging-port=9222` and `=9223`, `--no-sandbox`,
 *      `--enable-unsafe-extension-debugging`, and `apps/extension/dist/agent` loaded in both.
 *   4. `HALLPASS_CDP_ENDPOINTS=http://127.0.0.1:9222,http://127.0.0.1:9223 npx playwright test
 *      --config playwright.extension.config.ts tests/e2e/packaged/agent-multi-browser.spec.ts
 *      --reporter=list` (the first endpoint is browser A, the second is B). With fewer than two
 *      endpoints every test here is skipped.
 *
 * Browser A / B are told apart by the identifier their relay published (`browserIdOfWorker`), never
 * by name: the default names depend on connection order. The fixture clears each profile's extension
 * storage per test (a new identity every time), and this spec clears the remembered choices
 * (`hallpass\choices\`) first, because that file outlives a test.
 *
 * The two "a browser goes away" tests (SC-131, US5) close browser B through CDP (`Browser.close`) and
 * start the same executable again on the same profile and port, so its identity (extension storage)
 * survives. They need, in the runner's environment:
 *   HALLPASS_GATE_CHROME=<browser executable>   HALLPASS_GATE_PROFILE_9223=<B's --user-data-dir>
 *   HALLPASS_GATE_CHROME_ARGS="<extra flags of the original launch, e.g. --no-sandbox>"   (optional)
 * and are skipped with a message when the first two are unset. The relaunched browser is detached and
 * keeps running; the next test's fixture starts it again if a failed test left it closed.
 *
 * The in-browser choice card's copy is read from the three locale keys in `CHOICE_KEYS`.
 */
test.describe("agent: two browsers", () => {
  test.skip(
    !secondCdpEndpoint || !firstCdpEndpoint,
    "two-browser gate: set HALLPASS_CDP_ENDPOINTS=http://127.0.0.1:9222,http://127.0.0.1:9223 (two attached " +
      "browsers sharing one private LOCALAPPDATA, HALLPASS_FOREIGN_AGENT_SERVERS=allow); see this file's header.",
  );

  test.beforeEach(async () => {
    await clearBrowserChoices();
  });

  test("SC-127/SC-128 US1: refused until chosen, then the chosen browser only; two agents, two browsers at once", async ({
    extensionContext,
    extensionContext2,
    extensionId,
    extensionWorker,
    extensionWorker2,
  }) => {
    test.setTimeout(420_000);
    const [a, b] = await openBoth(extensionContext, extensionContext2, extensionWorker, extensionWorker2, extensionId);
    const both = [a.browserId, b.browserId].sort();

    let first: McpHarnessClient | undefined;
    let second: McpHarnessClient | undefined;
    try {
      first = await startClient("Claude Code", [a, b]);

      // --- SC-128: no choice yet, so every browser tool is refused before anything runs. ---
      const attempts: Array<[string, Record<string, unknown>]> = [
        ["tabs_context", {}],
        ["tabs_create", { url: `${SITE}/ordinary` }],
        ["find", { tabId: 1, query: "Safe action" }],
      ];
      for (const [tool, args] of attempts) {
        const refused = await first.callTool(tool, args);
        const refusal = refusalOf(refused);
        expect(refusal, `${tool}: ${refused.text}`).toMatchObject({ outcome: "denied", reason: "browser-not-chosen" });
        expect(idsOf(refusal.refusal?.browsers), `${tool} names every connected browser`).toEqual(both);
        expect(typeof refusal.hint).toBe("string");
      }
      await expectUntouched(a);
      await expectUntouched(b);

      // --- US1.2: the list carries id, name, kind and when it connected; nobody is current yet. ---
      const listed = await listBrowsers(first);
      expect(idsOf(listed)).toEqual(both);
      for (const entry of listed) {
        expect(entry.name.length).toBeGreaterThan(0);
        expect(entry.kind.length).toBeGreaterThan(0);
        expect(Number.isNaN(Date.parse(entry.connectedSince))).toBe(false);
        expect(entry.current).toBe(false);
      }

      // --- US1.3: selecting A runs the agent's calls in A, and in A only. ---
      const picked = await callOk(first, "select_browser", { browserId: a.browserId });
      expect(picked).toMatchObject({ browserId: a.browserId });
      expect((await listBrowsers(first)).filter((entry) => entry.current).map((entry) => entry.browserId)).toEqual([
        a.browserId,
      ]);
      await pairIn(first, a);
      await fullRound(first, a);
      await expectUntouched(b);
      expect(await browserState(a.worker)).toMatchObject({ groups: 1 });

      // --- SC-127: a second agent selects B; both work at the same time, each in its own browser. ---
      // (The remembered choice is now A, so this client names B itself rather than relying on memory.)
      second = await startClient("Codex", [a, b]);
      expect(await callOk(second, "select_browser", { browserId: b.browserId })).toMatchObject({
        browserId: b.browserId,
      });
      await pairIn(second, b);
      await Promise.all([fullRound(first, a), fullRound(second, b)]);

      // Each browser holds exactly its own agent's session group and tabs.
      expect(await browserState(a.worker)).toMatchObject({ groups: 1 });
      expect(await browserState(b.worker)).toMatchObject({ groups: 1 });
      expect((await browserState(a.worker)).tabs - a.baseline.tabs, "A holds its agent's two tabs").toBe(2);
      expect((await browserState(b.worker)).tabs - b.baseline.tabs, "B holds its agent's one tab").toBe(1);
      // The first agent is pinned to A even though the remembered choice is now B.
      expect((await listBrowsers(first)).find((entry) => entry.current)?.browserId).toBe(a.browserId);
      expect((await listBrowsers(second)).find((entry) => entry.current)?.browserId).toBe(b.browserId);
    } finally {
      await first?.close();
      await second?.close();
    }
  });

  test("SC-129: after a choice no tool family reaches the other browser", async ({
    extensionContext,
    extensionContext2,
    extensionId,
    extensionWorker,
    extensionWorker2,
  }) => {
    test.setTimeout(420_000);
    const [a, b] = await openBoth(extensionContext, extensionContext2, extensionWorker, extensionWorker2, extensionId);

    let client: McpHarnessClient | undefined;
    try {
      client = await startClient("Claude Code", [a, b]);
      const call = (tool: string, args: Record<string, unknown>) => callOk(client as McpHarnessClient, tool, args);
      await callOk(client, "select_browser", { browserId: a.browserId });
      await pairIn(client, a);

      const tabId = ((await call("tabs_create", { url: `${SITE}/ordinary` })) as { tabId: number }).tabId;
      // Effects run without a card in A so the sweep below is one uninterrupted pass over the families.
      await setSiteMode(a.panel, SITE, "skip-checks");

      await call("navigate", { tabId, url: `${SITE}/ordinary` });
      await call("read_page", { tabId, filter: "all" });
      await call("get_page_text", { tabId });
      await call("screenshot", { tabId });
      const safe = await refFor(call, tabId, "Safe action");
      await call("click", { tabId, target: { ref: safe } });
      const notesAgain = await refFor(call, tabId, "notes");
      await call("type", { tabId, target: { ref: notesAgain }, text: "only in browser A" });
      await call("scroll", { tabId, direction: "down", amount: "large" });

      // Not one of those reached B: no tab, no group, no pairing card, no session on its panel.
      await expectUntouched(b);
      // Relative to what B held before: its own fixture tab already sits on this origin.
      expect(await tabsMatching(b.worker, SITE)).toBe(b.baseline.siteTabs);
      const inA = await pageAt(a.context, `${SITE}/ordinary`);
      await expect(inA.locator('input[name="notes"]')).toHaveValue("only in browser A");
    } finally {
      await client?.close();
    }
  });

  test("SC-130 US2: a grant in one browser admits nothing in another; the remembered choice does stick", async ({
    extensionContext,
    extensionContext2,
    extensionId,
    extensionWorker,
    extensionWorker2,
  }) => {
    test.setTimeout(420_000);
    const [a, b] = await openBoth(extensionContext, extensionContext2, extensionWorker, extensionWorker2, extensionId);

    let client: McpHarnessClient | undefined;
    let later: McpHarnessClient | undefined;
    try {
      client = await startClient("Claude Code", [a, b]);
      const call = (tool: string, args: Record<string, unknown>) => callOk(client as McpHarnessClient, tool, args);

      // --- In A: paired, and the site is set to act without asking. ---
      await callOk(client, "select_browser", { browserId: a.browserId });
      await pairIn(client, a);
      const tabInA = ((await call("tabs_create", { url: `${SITE}/ordinary` })) as { tabId: number }).tabId;
      await setSiteMode(a.panel, SITE, "skip-checks");
      const refInA = await refFor(call, tabInA, "Safe action");
      await call("click", { tabId: tabInA, target: { ref: refInA } });
      expect(await a.panel.panelText(), "no consent card in A under skip-checks").not.toContain(ui("agent.promptTitle"));

      // --- Selecting B: pairing has to be given again, in B's own panel. ---
      await callOk(client, "select_browser", { browserId: b.browserId });
      const outcome = await pairIn(client, b);
      expect(outcome, "B asks for pairing; A's pairing does not travel").toBe("accepted");
      expect(await a.panel.panelText()).not.toContain(ui("agent.pairingTitle"));

      // A tab id issued in A is not a handle in B (FR-276).
      const foreign = await client.callTool("click", { tabId: tabInA, target: { x: 10, y: 10 } });
      expect(foreign.isError, `a tab id from the other browser must be refused: ${foreign.text}`).toBe(true);

      // --- On the same site, B follows B's own mode: it asks, and a refusal leaves the page alone. ---
      const tabInB = ((await call("tabs_create", { url: `${SITE}/ordinary` })) as { tabId: number }).tabId;
      await b.panel.waitForText(SITE);
      expect(await siteModeOf(b.panel, SITE)).not.toBe("skip-checks");
      const pageInB = await pageAt(b.context, `${SITE}/ordinary`);
      const before = await pageInB.locator("#clicked").textContent();
      const refInB = await refFor(call, tabInB, "Safe action");
      const asked = client.callTool("click", { tabId: tabInB, target: { ref: refInB } });
      await b.panel.waitForText(ui("agent.promptTitle"));
      await b.panel.clickButton(ui("agent.refuse"));
      const denied = await asked;
      expect(denied.isError).toBe(true);
      expect(denied.json).toMatchObject({ outcome: "denied", reason: "owner-denied" });
      expect(await pageInB.locator("#clicked").textContent()).toBe(before);

      // --- US2.1: the next session of this agent goes to the browser chosen last, with no question. ---
      await client.close();
      client = undefined;
      later = await startClient("Claude Code", [a, b]);
      const context = await later.callTool("tabs_context");
      expect(context.isError, `a remembered, connected browser needs no question: ${context.text}`).toBe(false);
      expect((await listBrowsers(later)).find((entry) => entry.current)?.browserId).toBe(b.browserId);
    } finally {
      await client?.close();
      await later?.close();
    }
  });

  test("SC-131: with one browser connected the first call needs no new step", async ({
    extensionContext,
    extensionContext2,
    extensionId,
    extensionWorker,
    extensionWorker2,
  }) => {
    test.skip(relaunchMissing !== undefined, relaunchSkipMessage());
    test.setTimeout(300_000);
    const [a, b] = await openBoth(extensionContext, extensionContext2, extensionWorker, extensionWorker2, extensionId);

    let client: McpHarnessClient | undefined;
    let bClosed = false;
    try {
      await closeAttachedBrowser(b.endpoint);
      bClosed = true;
      await expect.poll(async () => (await readLiveBrowserRecords()).map((r) => r.browserId), { timeout: 20_000 }).toEqual([
        a.browserId,
      ]);

      client = await startClient("Claude Code", [a]);
      // Exactly today's flow: the first call raises the pairing card in the one browser and runs.
      expect(await pairIn(client, a)).toBe("accepted");
      expect((await listBrowsers(client)).map((entry) => entry.browserId)).toEqual([a.browserId]);
      expect((await listBrowsers(client))[0]?.current).toBe(true);
    } finally {
      await client?.close();
      // Whatever happened above, leave B running for the next test.
      if (bClosed) await (await relaunchAttachedBrowser(b.endpoint)).detach();
    }
  });

  test("SC-132 US3: confirming in B selects B, withdraws A's card and answers the agent", async ({
    extensionContext,
    extensionContext2,
    extensionId,
    extensionWorker,
    extensionWorker2,
  }) => {
    test.setTimeout(300_000);
    const choice = choiceCopy();
    const [a, b] = await openBoth(extensionContext, extensionContext2, extensionWorker, extensionWorker2, extensionId);

    let client: McpHarnessClient | undefined;
    try {
      client = await startClient("Claude Code", [a, b]);
      const asked = client.callTool("request_browser_choice", {}, { timeoutMs: 150_000 });

      // One card in each browser, naming the agent.
      await Promise.all([a.panel.waitForText(choice.title), b.panel.waitForText(choice.title)]);
      expect(await a.panel.panelText()).toContain("Claude Code");
      expect(await b.panel.panelText()).toContain("Claude Code");

      const clickedAt = Date.now();
      await b.panel.clickButton(choice.confirm);
      const answer = await asked;
      const elapsed = Date.now() - clickedAt;
      expect(answer.isError, `request_browser_choice: ${answer.text}\nstderr:\n${client.stderr()}`).toBe(false);
      expect(answer.json).toMatchObject({ browserId: b.browserId });
      // SC-132 says one second from the click; the harness adds CDP and stdio round trips of its own.
      expect(elapsed, "answered promptly after the click").toBeLessThan(3_000);

      // A's card is withdrawn, B's is gone with the decision.
      await expect.poll(() => a.panel.panelText().then((text) => text.includes(choice.title)), { timeout: 15_000 }).toBe(false);
      await expect.poll(() => b.panel.panelText().then((text) => text.includes(choice.title)), { timeout: 15_000 }).toBe(false);

      // B is now the agent's browser; the first call there still asks for pairing (D-018-14).
      expect((await listBrowsers(client)).find((entry) => entry.current)?.browserId).toBe(b.browserId);
      expect(await pairIn(client, b)).toBe("accepted");
      await expectUntouched(a);
    } finally {
      await client?.close();
    }
  });

  test("SC-132 US3: declined everywhere ends the request and keeps the earlier choice", async ({
    extensionContext,
    extensionContext2,
    extensionId,
    extensionWorker,
    extensionWorker2,
  }) => {
    test.setTimeout(300_000);
    const choice = choiceCopy();
    const [a, b] = await openBoth(extensionContext, extensionContext2, extensionWorker, extensionWorker2, extensionId);

    let client: McpHarnessClient | undefined;
    try {
      client = await startClient("Claude Code", [a, b]);
      await callOk(client, "select_browser", { browserId: a.browserId });

      const asked = client.callTool("request_browser_choice", {}, { timeoutMs: 150_000 });
      await Promise.all([a.panel.waitForText(choice.title), b.panel.waitForText(choice.title)]);
      await a.panel.clickButton(choice.decline);
      // Tolerant on purpose: whether one decline also withdraws the other card is not part of the contract.
      await b.panel.waitForText(choice.title).catch(() => undefined);
      await b.panel.clickIfPresent(choice.decline);

      const answer = await asked;
      expect(answer.isError, answer.text).toBe(false);
      expect(answer.json).toEqual({ chosen: false });
      expect((await listBrowsers(client)).find((entry) => entry.current)?.browserId, "the earlier choice stands").toBe(
        a.browserId,
      );
    } finally {
      await client?.close();
    }
  });

  test("SC-132 US3: no answer ends the request after the bound (slow: the bound is two minutes)", async ({
    extensionContext,
    extensionContext2,
    extensionId,
    extensionWorker,
    extensionWorker2,
  }) => {
    // The contract's bound is 120 s (AGENT_BROWSER_CHOICE_BOUND_MS) and has no test override.
    test.slow();
    test.setTimeout(420_000);
    const choice = choiceCopy();
    const [a, b] = await openBoth(extensionContext, extensionContext2, extensionWorker, extensionWorker2, extensionId);

    let client: McpHarnessClient | undefined;
    try {
      client = await startClient("Claude Code", [a, b]);
      const startedAt = Date.now();
      const asked = client.callTool("request_browser_choice", {}, { timeoutMs: 200_000 });
      await Promise.all([a.panel.waitForText(choice.title), b.panel.waitForText(choice.title)]);

      const answer = await asked;
      const waited = Date.now() - startedAt;
      expect(answer.isError, answer.text).toBe(false);
      expect(answer.json).toEqual({ chosen: false });
      expect(waited, "the request ran its bound before ending").toBeGreaterThanOrEqual(100_000);
      expect(waited).toBeLessThan(150_000);
      await expect.poll(() => a.panel.panelText().then((text) => text.includes(choice.title)), { timeout: 15_000 }).toBe(false);
      await expect.poll(() => b.panel.panelText().then((text) => text.includes(choice.title)), { timeout: 15_000 }).toBe(false);
    } finally {
      await client?.close();
    }
  });

  test("US5: a browser that goes away is refused by name, the other keeps working, and it works again on return", async ({
    extensionContext,
    extensionContext2,
    extensionId,
    extensionWorker,
    extensionWorker2,
  }) => {
    test.skip(relaunchMissing !== undefined, relaunchSkipMessage());
    test.setTimeout(420_000);
    const [a, b] = await openBoth(extensionContext, extensionContext2, extensionWorker, extensionWorker2, extensionId);

    // B is the browser that goes away (its endpoint is the one the relaunch settings describe); A stays.
    let first: McpHarnessClient | undefined;
    let second: McpHarnessClient | undefined;
    let bClosed = false;
    let returned: RelaunchedBrowser | undefined;
    try {
      first = await startClient("Claude Code", [a, b]);
      await callOk(first, "select_browser", { browserId: b.browserId });
      await pairIn(first, b);
      second = await startClient("Codex", [a, b]);
      await callOk(second, "select_browser", { browserId: a.browserId });
      await pairIn(second, a);

      // --- B goes away while the first agent is bound to it. ---
      await closeAttachedBrowser(b.endpoint);
      bClosed = true;
      await expect.poll(async () => (await readLiveBrowserRecords()).map((r) => r.browserId), { timeout: 20_000 }).toEqual([
        a.browserId,
      ]);
      const aBefore = await browserState(a.worker);

      // US5.1: refused as disconnected (after the attach bound), listing A; nothing runs in A.
      const refused = await first.callTool("tabs_context", {}, { timeoutMs: 60_000 });
      const refusal = refusalOf(refused);
      expect(refusal, refused.text).toMatchObject({ outcome: "denied", reason: "browser-disconnected" });
      expect(refusal.refusal?.browser?.browserId).toBe(b.browserId);
      expect(idsOf(refusal.refusal?.browsers)).toEqual([a.browserId]);
      expect(await browserState(a.worker)).toEqual(aBefore);

      // US5.3: A's own agent is unaffected.
      const stillWorks = await second.callTool("tabs_context");
      expect(stillWorks.isError, stillWorks.text).toBe(false);

      // --- US5.2: B returns (same profile, same identity) and the first agent works there again. ---
      returned = await relaunchAttachedBrowser(b.endpoint);
      bClosed = false;
      const back = await openSide(returned.context, b.endpoint, returned.worker, extensionId);
      expect(back.browserId, "the same profile keeps its browser id").toBe(b.browserId);
      await pairWithFirstCall(first, back.panel, { locale, timeoutMs: 45_000 });
      expect((await listBrowsers(first)).find((entry) => entry.current)?.browserId).toBe(b.browserId);
    } finally {
      await first?.close();
      await second?.close();
      // Whatever happened above, leave B running for the next test.
      if (bClosed) returned = await relaunchAttachedBrowser(b.endpoint);
      await returned?.detach();
    }
  });
});

/* ------------------------------------------------------------------------------------------- */

/**
 * The in-browser choice card's copy (018 contracts/browser-tools.md "Panel", prompt kind
 * `browser-choice`). The keys are the card's locale keys; if S5 named them differently, change them
 * here - the check below fails with the key's name rather than letting a run time out on text that
 * can never appear.
 */
const CHOICE_KEYS = {
  title: "agent.browserChoice.title",
  confirm: "agent.browserChoice.confirm",
  decline: "agent.browserChoice.decline",
} as const;

function choiceCopy(): { title: string; confirm: string; decline: string } {
  // `lookup` answers an unknown key with the workspace title, which no card is ever called.
  const unknown = lookup("workspace.title", locale);
  const read = (key: string): string => {
    const text = lookup(key, locale);
    if (text === unknown) throw new Error(`browser-choice-copy-key-missing:${key} (align CHOICE_KEYS with the card's locale keys)`);
    return text;
  };
  // The title carries the agent's name ("Use this browser for {agent}?"); the part before it is the stable text.
  const title = read(CHOICE_KEYS.title).split("{")[0]?.trim() ?? "";
  return { title: title.length > 0 ? title : read(CHOICE_KEYS.title), confirm: read(CHOICE_KEYS.confirm), decline: read(CHOICE_KEYS.decline) };
}

type BrowserSummary = { browserId: string; name: string; kind: string };
type ListedBrowser = BrowserSummary & { connectedSince: string; current: boolean };
type Refusal = {
  outcome: string;
  reason: string;
  hint?: string;
  refusal?: { browsers?: BrowserSummary[]; browser?: BrowserSummary };
};

/** One attached browser as the journey sees it. `worker` and `panel` are replaced when the browser comes back. */
type Side = {
  context: BrowserContext;
  endpoint: string;
  worker: PackagedWorker;
  ownerPage: Page;
  ownerTabId: number;
  panel: SidePanelDriver;
  browserId: string;
  /** Tabs and tab groups before the agent did anything: what "untouched" is compared to. */
  baseline: { tabs: number; groups: number; siteTabs: number };
};

async function openBoth(
  contextA: BrowserContext,
  contextB: BrowserContext,
  workerA: PackagedWorker,
  workerB: PackagedWorker,
  extensionId: string,
): Promise<[Side, Side]> {
  const a = await openSide(contextA, firstCdpEndpoint, workerA, extensionId);
  const b = await openSide(contextB, secondCdpEndpoint, workerB, extensionId);
  expect(a.browserId, "the two attached browsers must be two profiles (two identities), not one browser twice").not.toBe(
    b.browserId,
  );
  await expect.poll(async () => (await readLiveBrowserRecords()).length, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  return [a, b];
}

async function openSide(
  context: BrowserContext,
  endpoint: string | undefined,
  worker: PackagedWorker,
  extensionId: string,
): Promise<Side> {
  if (!endpoint) throw new Error("two-browser gate: endpoint missing");
  const permissions = await worker.evaluate(() => chrome.runtime.getManifest().permissions ?? []);
  expect(
    permissions,
    "the attached browser must have apps/extension/dist/agent loaded (npm run build:extension:agent)",
  ).toContain("nativeMessaging");

  const ownerPage = context.pages()[0] ?? (await context.newPage());
  await ownerPage.goto(`${SITE}/waiting`);
  await ownerPage.bringToFront();
  const ownerTabId = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) throw new Error("active-tab-missing");
    return tab.id;
  });
  const panel = await openSidePanel({ context, extensionId, fixturePage: ownerPage, tabId: ownerTabId, copy });
  await waitForAgentPanel(panel);
  const browserId = await browserIdOfWorker(worker);
  const state = await browserState(worker);
  const siteTabs = await tabsMatching(worker, SITE);
  return { context, endpoint, worker, ownerPage, ownerTabId, panel, browserId, baseline: { ...state, siteTabs } };
}

async function startClient(clientName: string, sides: Side[]): Promise<McpHarnessClient> {
  const client = await startMcpClient({ clientName });
  // The worker retries a bridge it could not reach on an alarm; Retry is the owner asking now.
  for (const side of sides) await side.panel.clickIfPresent(ui("agent.retry"));
  return client;
}

async function callOk(client: McpHarnessClient, tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const result = await client.callTool(tool, args);
  expect(result.isError, `${tool} failed: ${result.text}\nmcp-server stderr:\n${client.stderr()}`).toBe(false);
  return result.json;
}

async function listBrowsers(client: McpHarnessClient): Promise<ListedBrowser[]> {
  const answer = (await callOk(client, "list_browsers")) as { browsers: ListedBrowser[] };
  return answer.browsers;
}

function refusalOf(result: ToolCallResult): Refusal {
  expect(result.isError, `expected a refusal, got: ${result.text}`).toBe(true);
  return result.json as Refusal;
}

function idsOf(list: BrowserSummary[] | undefined): string[] {
  return (list ?? []).map((entry) => entry.browserId).sort();
}

/** Pairs the agent in `side` through the first call there, and says whether the card was shown. */
async function pairIn(client: McpHarnessClient, side: Side): Promise<"accepted" | "already-paired"> {
  return pairWithFirstCall(client, side.panel, { locale, timeoutMs: 45_000 });
}

/** A read, a card-gated effect answered in the panel, and the call's own answer: one full round of work. */
async function fullRound(client: McpHarnessClient, side: Side): Promise<number> {
  const call = (tool: string, args: Record<string, unknown>) => callOk(client, tool, args);
  const tabId = ((await call("tabs_create", { url: `${SITE}/ordinary` })) as { tabId: number }).tabId;
  const ref = await refFor(call, tabId, "Safe action");
  const clicked = client.callTool("click", { tabId, target: { ref } });
  await side.panel.waitForText(ui("agent.promptTitle"));
  await side.panel.clickButton(ui("agent.allowOnce"));
  const done = await clicked;
  expect(done.isError, `click: ${done.text}\nmcp-server stderr:\n${client.stderr()}`).toBe(false);
  return tabId;
}

async function refFor(
  call: (tool: string, args: Record<string, unknown>) => Promise<unknown>,
  tabId: number,
  query: string,
): Promise<string> {
  const found = (await call("find", { tabId, query })) as { outcome: string; matches: Array<{ ref: string }> };
  expect(found.outcome, `find '${query}' answered ${found.outcome}`).toBe("resolved");
  const ref = found.matches[0]?.ref;
  expect(ref, `find '${query}' returned no ref`).toBeTruthy();
  return ref as string;
}

async function browserState(worker: PackagedWorker): Promise<{ tabs: number; groups: number }> {
  return worker.evaluate(async () => ({
    tabs: (await chrome.tabs.query({})).length,
    groups: (await chrome.tabGroups.query({})).length,
  }));
}

async function tabsMatching(worker: PackagedWorker, prefix: string): Promise<number> {
  return worker.evaluate(async (start: string) => {
    const tabs = await chrome.tabs.query({});
    return tabs.filter((tab) => (tab.url ?? "").startsWith(start)).length;
  }, prefix);
}

async function agentState(panel: SidePanelDriver): Promise<unknown> {
  return panel.evaluatePanel("document.querySelector('[data-agent-state]')?.getAttribute('data-agent-state') ?? null");
}

/**
 * The browser took no part: same tabs and groups as before the agent started, a panel still on the
 * not-connected page, and no pairing or consent card on it.
 */
async function expectUntouched(side: Side): Promise<void> {
  expect(await browserState(side.worker)).toEqual({ tabs: side.baseline.tabs, groups: side.baseline.groups });
  expect(await agentState(side.panel)).toBe("not-connected");
  const text = await side.panel.panelText();
  expect(text).not.toContain(ui("agent.pairingTitle"));
  expect(text).not.toContain(ui("agent.promptTitle"));
}

async function pageAt(context: BrowserContext, url: string): Promise<Page> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const found = context.pages().find((page) => page.url() === url);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`page-not-found:${url}`);
}

/** The site list's mode control for `site`, as the panel renders it (the owner's own control). */
async function siteModeOf(panel: SidePanelDriver, site: string): Promise<string | null> {
  const value = await panel.evaluatePanel(
    `(()=>{const site=${JSON.stringify(site)};const rows=[...document.querySelectorAll('li')];` +
      `const row=rows.find((r)=>r.textContent?.includes(site));return row?.querySelector('select')?.value ?? null})()`,
  );
  return typeof value === "string" ? value : null;
}

/** As in `agent-actions.spec.ts`: the owner's per-site mode, set through the panel's own control. */
async function setSiteMode(panel: SidePanelDriver, site: string, mode: string): Promise<void> {
  await panel.waitForText(site);
  const set = await panel.evaluatePanel(
    `(()=>{const site=${JSON.stringify(site)};const rows=[...document.querySelectorAll('li')];` +
      `const row=rows.find((r)=>r.textContent?.includes(site));const sel=row?.querySelector('select');` +
      `if(!sel)return false;const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;` +
      `setter.call(sel,${JSON.stringify(mode)});sel.dispatchEvent(new Event('change',{bubbles:true}));return true})()`,
    true,
  );
  expect(set, `the panel offers no mode control for ${site}`).toBe(true);
  await expect.poll(() => siteModeOf(panel, site), { timeout: 15_000 }).toBe(mode);
}
