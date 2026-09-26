import { lookup } from "../../../apps/extension/src/locales/catalog.js";
import { transitionNoticeText } from "@hallpass/contracts";
import { startMcpClient, type McpHarnessClient } from "../../harness/mcp-client.js";
import { acceptPairing, pairWithFirstCall } from "../fixtures/agent-pairing.js";
import { copyFor, localeFromEnv, openSidePanel, type SidePanelDriver } from "../fixtures/side-panel-driver.js";
import { expect, setTransitionTestSwitch, test, type PackagedWorker } from "../fixtures/packaged-extension.js";

const locale = localeFromEnv();
const copy = copyFor(locale);
const ui = (key: string): string => lookup(key, locale);

/** The three origins this gate is about, and the fourth that is a different *site* by one name. */
const A = "https://127.0.0.1:19443";
const B = "https://127.0.0.1:19445";
const C = "https://127.0.0.1:19444";
const D = "https://localhost:19445";

/**
 * 014/T368 — US2 end to end: the tab moved, and the owner is asked once (SC-102, SC-103).
 *
 * The claim is about a *browser*: a click whose server chose the destination, a redirect chain the
 * agent never named, a worker Chrome recycled between the answer and the next call. None of that
 * can be proved in a unit, so the eight checks below use real redirects between real origins, and
 * every answer is read from the agent's side of the link while every decision is made on the
 * panel - never by writing storage, which would prove the rules and not the product.
 *
 * One thing is arranged rather than real: every fixture here is served from `127.0.0.1`, which
 * rule (a) exempts because a page on the owner's own machine is not a site anybody handed them.
 * So check 5 runs *first* with the exemption on - proving it - and the rest of the run sets the
 * gate's switch (`setTransitionTestSwitch`, contracts/transitions.md) so two fixture ports count
 * as the two ordinary origins they are. The switch widens prompting and never privilege; rule (a)
 * as shipped is proved on the owner's branded Chrome against real sites (T390).
 *
 * Attach mode only, for the reason every agent journey is: the bridge is a machine install.
 *
 * Prerequisites: `npm run build`, `dist/agent` loaded in the attached browser,
 * `npm run agent-host:install`, and the fixture services running (18786/18787/19443-19445).
 */
test.describe("agent transitions", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT,
    "attach mode only: the native-messaging host is a machine install, so the browser under test " +
      "must be one the runner started and pointed at the installed host (HALLPASS_CDP_ENDPOINT).",
  );

  test("asks once about a move nobody decided on, remembers what the owner said, and forgets it on request", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(600_000);

    const permissions = await extensionWorker.evaluate(() => chrome.runtime.getManifest().permissions ?? []);
    expect(
      permissions,
      "the attached browser must have apps/extension/dist/agent loaded (npm run build)",
    ).toContain("nativeMessaging");

    const ownerPage = extensionContext.pages()[0] ?? (await extensionContext.newPage());
    await ownerPage.goto(`${A}/tags`);
    await ownerPage.bringToFront();
    const ownerTabId = await extensionWorker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined) throw new Error("active-tab-missing");
      return tab.id;
    });

    const panel = await openSidePanel({
      context: extensionContext,
      extensionId,
      fixturePage: ownerPage,
      tabId: ownerTabId,
      copy,
    });
    await panel.waitForText(ui("agent.appTitle"));

    let alpha: McpHarnessClient | undefined;
    let beta: McpHarnessClient | undefined;
    let gamma: McpHarnessClient | undefined;
    try {
      alpha = await startMcpClient({ clientName: "Claude Code" });
      const first = alpha;
      const call = callerFor(() => alpha);
      await panel.clickIfPresent(ui("agent.retry"));
      await pairWithFirstCall(first, panel, { locale, timeoutMs: 45_000 });

      // ============ (5.1) the switch unset: a loopback destination asks nothing ============
      const loopbackTab = ((await call("tabs_create", { url: `${A}/transition-a` })) as { tabId: number }).tabId;
      await setSiteMode(panel, A, "skip-checks");
      await call("navigate", { tabId: loopbackTab, url: `${A}/go-b` });
      await expect.poll(() => urlOf(extensionWorker, loopbackTab), { timeout: 20_000 }).toContain(":19445/");
      const loopbackRead = await first.callTool("get_page_text", { tabId: loopbackTab });
      expect(loopbackRead.isError, `text: ${loopbackRead.text}`).toBe(false);
      expect(await cardUp(panel), "rule (a) let a loopback move raise a card").toBe(false);
      await closeTab(extensionWorker, loopbackTab);

      // From here the harness's own origins count as ordinary sites (T366).
      await setTransitionTestSwitch(extensionWorker, true);

      // ============ (1) the click's own answer names where the tab went ============
      const tab1 = ((await call("tabs_create", { url: `${A}/transition-a` })) as { tabId: number }).tabId;
      const clicked = await first.callTool("click", { tabId: tab1, target: { ref: await refFor(call, tab1, "Go to B") } });
      expect(clicked.isError, `text: ${clicked.text}\nstderr:\n${first.stderr()}`).toBe(false);
      // The server chose the destination, and the tab is on it.
      await expect.poll(() => urlOf(extensionWorker, tab1), { timeout: 30_000 }).toContain(":19445/");
      // The move is recorded from the browser's own signal, whoever caused it (FR-185).
      await expect.poll(() => pendingOn(extensionWorker, tab1), { timeout: 20_000 }).toEqual({ from: A, to: B });
      // FR-186: the call that was in flight says so, and its own outcome is untouched.
      expect(answerOf(clicked), `text: ${clicked.text}`).toMatchObject({ hint: transitionNoticeText(A, B) });

      // ============ (4) 拒絕 refuses this call, keeps the tab, and lets a navigate leave ============
      const declined = first.callTool("get_page_text", { tabId: tab1 });
      await waitForCard(panel, A, B);
      await panel.clickButton(ui("agent.transitionDecline"));
      const declinedAnswer = await declined;
      expect(declinedAnswer.isError).toBe(true);
      expect(answerOf(declinedAnswer), `text: ${declinedAnswer.text}`).toMatchObject({
        outcome: "denied",
        reason: "site-transition-declined",
      });
      // The session and the tab are exactly as they were: the tab is still this session's.
      expect(await heldTabs(call), "the declined call cost the session its tab").toContain(tab1);
      /**
       * And letting go is always available (owner's ruling, 2026-09-22): on a second tab with the
       * same question standing, handing it back is admitted without a card, exactly as a navigate
       * elsewhere is. Proved on a tab of its own so the checks below still have tab1's question.
       */
      const tabLeave = ((await call("tabs_create", { url: `${A}/transition-a` })) as { tabId: number }).tabId;
      await call("navigate", { tabId: tabLeave, url: `${A}/go-b` });
      await expect.poll(() => pendingOn(extensionWorker, tabLeave), { timeout: 20_000 }).toEqual({ from: A, to: B });
      await call("tabs_release", { tabId: tabLeave });
      expect(await cardUp(panel), "handing a tab back was held behind a card").toBe(false);
      await closeTab(extensionWorker, tabLeave);
      // FR-188: a navigate that leaves is admitted without a card...
      await call("navigate", { tabId: tab1, url: `${A}/transition-a` });
      expect(await cardUp(panel), "a navigate away was held behind a card").toBe(false);
      // ...and (5.4) a return to an origin the session knows clears the question outright.
      await expect.poll(() => pendingOn(extensionWorker, tab1), { timeout: 20_000 }).toBeUndefined();
      const readBack = await first.callTool("get_page_text", { tabId: tab1 });
      expect(readBack.isError, `text: ${readBack.text}`).toBe(false);
      expect(await cardUp(panel), "a tab back where it started raised a card").toBe(false);

      // ============ (6) two moves before the next call are one question ============
      const tab3 = ((await call("tabs_create", { url: `${A}/transition-a` })) as { tabId: number }).tabId;
      await call("click", { tabId: tab3, target: { ref: await refFor(call, tab3, "Go to B then C") } });
      await expect.poll(() => urlOf(extensionWorker, tab3), { timeout: 30_000 }).toContain(":19444/");
      // FR-189: `to` was replaced and `from` was kept - one card, naming where the tab *was*.
      await expect.poll(() => pendingOn(extensionWorker, tab3), { timeout: 20_000 }).toEqual({ from: A, to: C });
      const collapsed = first.callTool("get_page_text", { tabId: tab3 });
      await waitForCard(panel, A, C);
      await panel.clickButton(ui("agent.transitionDecline"));
      expect((await collapsed).isError).toBe(true);

      // ============ (5.2) a destination the owner has a mode for asks nothing ============
      await setSiteMode(panel, C, "follow-a-plan");
      const tabMode = ((await call("tabs_create", { url: `${A}/transition-batch` })) as { tabId: number }).tabId;
      await call("click", { tabId: tabMode, target: { ref: await refFor(call, tabMode, "Leave for C") } });
      await expect.poll(() => urlOf(extensionWorker, tabMode), { timeout: 30_000 }).toContain(":19444/");
      expect(await pendingOn(extensionWorker, tabMode), "a decided site was treated as undecided").toBeUndefined();
      await clearSiteMode(panel, C);
      await closeTab(extensionWorker, tabMode);
      await closeTab(extensionWorker, tab3);

      // ============ (5.3) the origin a navigate asked for is the origin it may arrive at ======
      const tabNav = ((await call("tabs_create", { url: `${A}/transition-a` })) as { tabId: number }).tabId;
      await call("navigate", { tabId: tabNav, url: `${D}/transition-b` });
      expect(await pendingOn(extensionWorker, tabNav), "a navigate's own destination was pending").toBeUndefined();
      const afterNav = await first.callTool("get_page_text", { tabId: tabNav });
      expect(afterNav.isError, `text: ${afterNav.text}`).toBe(false);
      expect(await cardUp(panel), "a navigate's own destination raised a card").toBe(false);
      await closeTab(extensionWorker, tabNav);

      // ============ (2) 繼續 lets the call through, for this session ============
      await call("click", { tabId: tab1, target: { ref: await refFor(call, tab1, "Go to B") } });
      await expect.poll(() => pendingOn(extensionWorker, tab1), { timeout: 20_000 }).toEqual({ from: A, to: B });
      const continued = first.callTool("get_page_text", { tabId: tab1 });
      await waitForCard(panel, A, B);
      await panel.clickButton(ui("agent.transitionContinue"));
      const continuedAnswer = await continued;
      expect(continuedAnswer.isError, `text: ${continuedAnswer.text}\nstderr:\n${first.stderr()}`).toBe(false);
      // The same move, on another tab of the same session: allowed without asking again (FR-188).
      const tab2 = ((await call("tabs_create", { url: `${A}/transition-a` })) as { tabId: number }).tabId;
      await call("navigate", { tabId: tab2, url: `${A}/go-b` });
      await expect.poll(() => urlOf(extensionWorker, tab2), { timeout: 20_000 }).toContain(":19445/");
      const second = await first.callTool("get_page_text", { tabId: tab2 });
      expect(second.isError, `text: ${second.text}`).toBe(false);
      expect(await cardUp(panel), "a second move the session had allowed raised a card").toBe(false);

      // ============ (7) a batch stops before the step whose tab has moved ============
      const tabBatch = ((await call("tabs_create", { url: `${A}/transition-batch` })) as { tabId: number }).tabId;
      const safe = await refFor(call, tabBatch, "Safe action");
      const leave = await refFor(call, tabBatch, "Leave for C");
      const batch = await first.callTool("browser_batch", {
        tabId: tabBatch,
        steps: [
          { tool: "click", args: { target: { ref: safe } } },
          { tool: "click", args: { target: { ref: leave } } },
          { tool: "wait", args: { forMs: 2_000 } },
          { tool: "click", args: { target: { ref: safe } } },
          { tool: "click", args: { target: { ref: safe } } },
        ],
      });
      // The batch convention, as S1 kept it: `ok`, with the step carrying the reason.
      expect(batch.isError, `text: ${batch.text}\nstderr:\n${first.stderr()}`).toBe(false);
      const batchResult = batch.json as {
        results?: Array<{ index: number; outcome: string; reason?: string }>;
        completed?: number[];
        stoppedAt?: number;
        notRun?: number[];
      };
      const stoppedAt = batchResult.stoppedAt;
      // Either the commit landed while the batch was between steps 1 and 2, or during the wait -
      // both are the same fact, and the batch stops at the first step it sees it.
      expect([2, 3], `stoppedAt was ${String(stoppedAt)}`).toContain(stoppedAt);
      expect(batchResult.results?.[stoppedAt as number]).toMatchObject({
        outcome: "stopped",
        reason: "site-transition",
      });
      expect(batchResult.notRun).toEqual(
        batchResult.results?.filter((step) => step.index > (stoppedAt as number)).map((step) => step.index),
      );
      // No card was raised mid-batch: the agent's next single call is what asks.
      expect(await cardUp(panel), "a batch raised a card mid-sequence").toBe(false);
      await closeTab(extensionWorker, tabBatch);
      await closeTab(extensionWorker, tab2);
      await closeTab(extensionWorker, tab1);
      await alpha.close();
      alpha = undefined;

      // ============ (3) 一律允許 outlives the session and the worker ============
      beta = await startMcpClient({ clientName: "Claude Code" });
      const secondSession = beta;
      const callBeta = callerFor(() => beta);
      await pairWithFirstCall(secondSession, panel, { locale, timeoutMs: 45_000 });
      const tabBeta = ((await callBeta("tabs_create", { url: `${A}/transition-a` })) as { tabId: number }).tabId;
      await callBeta("navigate", { tabId: tabBeta, url: `${A}/go-b` });
      await expect.poll(() => urlOf(extensionWorker, tabBeta), { timeout: 20_000 }).toContain(":19445/");
      const remembering = secondSession.callTool("get_page_text", { tabId: tabBeta });
      // A session that was never told 繼續 is asked, however many times another one was (FR-188).
      await waitForCard(panel, A, B);
      await panel.clickButton(ui("agent.transitionAlways"));
      expect((await remembering).isError, `stderr:\n${secondSession.stderr()}`).toBe(false);
      // FR-191: the owner can see what they allowed, and FR-190: only the origins are stored.
      await panel.waitForText(ui("agent.transitionsTitle"));
      expect(await rowsOnPanel(panel)).toContain(`${A}→${B}`);
      expect(await storedAllowances(extensionWorker)).toMatchObject([
        { from: A, to: B, allowedAt: expect.any(String) },
      ]);
      await closeTab(extensionWorker, tabBeta);
      await beta.close();
      beta = undefined;

      // The worker Chrome recycles, and the owner's decision is still theirs.
      await restartWorker(extensionContext, extensionId, ownerPage);
      gamma = await startMcpClient({ clientName: "Claude Code" });
      const thirdSession = gamma;
      const callGamma = callerFor(() => gamma);
      await expect
        .poll(async () => (await thirdSession.callTool("tabs_context")).isError, { timeout: 120_000, intervals: [1_000] })
        .toBe(false);
      await acceptPairing(panel, { locale, timeoutMs: 45_000 });
      const tabGamma = ((await callGamma("tabs_create", { url: `${A}/transition-a` })) as { tabId: number }).tabId;
      await callGamma("navigate", { tabId: tabGamma, url: `${A}/go-b` });
      await expect.poll(() => urlOf(extensionWorker, tabGamma), { timeout: 20_000 }).toContain(":19445/");
      const remembered = await thirdSession.callTool("get_page_text", { tabId: tabGamma });
      expect(remembered.isError, `text: ${remembered.text}\nstderr:\n${thirdSession.stderr()}`).toBe(false);
      expect(await cardUp(panel), "a remembered move asked again").toBe(false);

      // ============ (8) revoking the row makes the next such move ask again ============
      await panel.waitForText(ui("agent.transitionsTitle"));
      await panel.clickButton(ui("agent.transitionRevoke").replace("{from}", A).replace("{to}", B));
      await expect.poll(() => storedAllowances(extensionWorker), { timeout: 15_000 }).toEqual([]);
      const tabAgain = ((await callGamma("tabs_create", { url: `${A}/transition-a` })) as { tabId: number }).tabId;
      await callGamma("navigate", { tabId: tabAgain, url: `${A}/go-b` });
      await expect.poll(() => urlOf(extensionWorker, tabAgain), { timeout: 20_000 }).toContain(":19445/");
      const asksAgain = thirdSession.callTool("get_page_text", { tabId: tabAgain });
      await waitForCard(panel, A, B);
      await panel.clickButton(ui("agent.transitionContinue"));
      expect((await asksAgain).isError, `stderr:\n${thirdSession.stderr()}`).toBe(false);

      await closeTab(extensionWorker, tabAgain);
      await closeTab(extensionWorker, tabGamma);
    } finally {
      await setTransitionTestSwitch(extensionWorker, false).catch(() => undefined);
      await alpha?.close();
      await beta?.close();
      await gamma?.close();
    }
  });
});

/** The host answers a call as JSON text; a non-JSON answer is reported as what it was. */
function answerOf(result: { text: string; json?: unknown }): unknown {
  try {
    return JSON.parse(result.text) as unknown;
  } catch {
    return result.json ?? { unparsed: result.text };
  }
}

/** Calls a tool and fails loudly with the host's own stderr when it did not answer `ok`. */
function callerFor(
  client: () => McpHarnessClient | undefined,
): (tool: string, args: Record<string, unknown>) => Promise<unknown> {
  return async (tool, args) => {
    const live = client();
    if (!live) throw new Error("mcp-client-missing");
    const result = await live.callTool(tool, args);
    expect(result.isError, `${tool} failed: ${result.text}\nmcp-server stderr:\n${live.stderr()}`).toBe(false);
    return result.json;
  };
}

/** One live ref for a named control, from a structural read of the tab. */
async function refFor(
  call: (tool: string, args: Record<string, unknown>) => Promise<unknown>,
  tabId: number,
  name: string,
): Promise<string> {
  const page = (await call("read_page", { tabId, filter: "all" })) as {
    nodes: Array<{ ref?: string; name?: string }>;
  };
  const node = page.nodes.find((candidate) => candidate.name === name && candidate.ref !== undefined);
  expect(node, `read_page offered no ref named '${name}'`).toBeTruthy();
  return node?.ref as string;
}

/** Which tabs the session holds right now, from its own view of them. */
async function heldTabs(call: (tool: string, args: Record<string, unknown>) => Promise<unknown>): Promise<number[]> {
  const tabs = (await call("tabs_context", {})) as Array<{ tabId: number; holder: unknown }>;
  return tabs.filter((tab) => tab.holder === "this").map((tab) => tab.tabId);
}

/**
 * Tidying up, through the browser rather than through the agent.
 *
 * `tabs_close` names a tab, so on a tab with a question standing it is held behind the card like
 * every other call (FR-187) - which is the product being right and a test being unable to clean up
 * after itself. The owner closing their own tab is the honest way out, and it is also what this
 * gate is simulating between checks.
 */
async function closeTab(worker: PackagedWorker, tabId: number): Promise<void> {
  await worker.evaluate(async (id: number) => {
    await chrome.tabs.remove(id).catch(() => undefined);
  }, tabId);
}

/** Where the browser says the tab is; the gate waits on this rather than on a page load event. */
async function urlOf(worker: PackagedWorker, tabId: number): Promise<string> {
  return worker.evaluate(async (id: number) => (await chrome.tabs.get(id)).url ?? "", tabId);
}

/**
 * The move the worker is holding for that tab, read from its own session storage.
 *
 * The one place this gate reads state rather than behaviour, and it is read-only: it is what makes
 * "the card names A→C rather than B→C" a fact about the record the card is built from, and it lets
 * a wait be on the browser's own signal instead of on a sleep.
 */
async function pendingOn(worker: PackagedWorker, tabId: number): Promise<{ from: string; to: string } | undefined> {
  return worker.evaluate(async (id: number) => {
    const raw = await chrome.storage.session.get(["agentTransitions"]);
    const states = (raw.agentTransitions ?? {}) as Record<string, { pending?: { from: string; to: string } }>;
    const entry = Object.entries(states).find(([key]) => key.endsWith(`:${id}`))?.[1];
    return entry?.pending === undefined ? undefined : { from: entry.pending.from, to: entry.pending.to };
  }, tabId);
}

/** The owner's remembered pairs, as the store has them. */
async function storedAllowances(worker: PackagedWorker): Promise<unknown[]> {
  return worker.evaluate(async () => {
    const raw = await chrome.storage.local.get(["agentTransitionAllowances"]);
    return (raw.agentTransitionAllowances ?? []) as unknown[];
  });
}

/** Whether a transition card is on the panel right now. */
async function cardUp(panel: SidePanelDriver): Promise<boolean> {
  return (await panel.evaluatePanel("document.querySelector('[data-prompt=transition]') !== null")) === true;
}

/** The card, with the two origins the owner is being asked about. */
async function waitForCard(panel: SidePanelDriver, from: string, to: string): Promise<void> {
  await panel.waitForText(ui("agent.prompt.transition").replace("{from}", from).replace("{to}", to));
}

/** The remembered pairs the panel is showing, by the row key the site list gives them. */
async function rowsOnPanel(panel: SidePanelDriver): Promise<string[]> {
  return (await panel.evaluatePanel(
    "[...document.querySelectorAll('[data-transition]')].map((row)=>row.getAttribute('data-transition'))",
  )) as string[];
}

/**
 * Sets one site's mode through the panel's own control (FR-042), never by writing storage: the
 * claim is that the owner can decide from what they are shown.
 */
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
  await expect
    .poll(
      async () =>
        panel.evaluatePanel(
          `(()=>{const site=${JSON.stringify(site)};const rows=[...document.querySelectorAll('li')];` +
            `const row=rows.find((r)=>r.textContent?.includes(site));return row?.querySelector('select')?.value ?? null})()`,
        ),
      { timeout: 15_000 },
    )
    .toBe(mode);
}

/** The site list's own revoke, so the next run of this gate starts from an undecided site. */
async function clearSiteMode(panel: SidePanelDriver, site: string): Promise<void> {
  await panel.clickButton(ui("agent.siteRevoke").replace("{site}", site));
}

/**
 * Chrome recycling the worker, as it does on its own schedule (004/T169, 006 panel evidence).
 *
 * Closing the worker target rather than `chrome.runtime.reload()`, which unloads an extension
 * loaded over the command line and does not bring it back.
 */
async function restartWorker(
  context: { newCDPSession(page: unknown): Promise<{ send(method: string, params?: unknown): Promise<any>; detach(): Promise<void> }> },
  extensionId: string,
  page: unknown,
): Promise<void> {
  const cdp = await context.newCDPSession(page);
  const targets = await cdp.send("Target.getTargets");
  const worker = (targets.targetInfos as Array<{ type: string; url: string; targetId: string }>).find(
    (target) => target.type === "service_worker" && target.url.startsWith(`chrome-extension://${extensionId}/`),
  );
  expect(worker, "worker target").toBeTruthy();
  await cdp.send("Target.closeTarget", { targetId: worker?.targetId });
  await cdp.detach();
}
