import { lookup } from "../../../apps/extension/src/locales/catalog.js";
import { startMcpClient, type McpHarnessClient } from "../../harness/mcp-client.js";
import { pairWithFirstCall, unpairAgent } from "../fixtures/agent-pairing.js";
import {
  clickLabelled,
  copyFor,
  localeFromEnv,
  openSidePanel,
  waitForAgentPanel,
  type SidePanelDriver,
} from "../fixtures/side-panel-driver.js";
import { expect, setTransitionTestSwitch, test, type PackagedWorker } from "../fixtures/packaged-extension.js";

const locale = localeFromEnv();
const copy = copyFor(locale);
const ui = (key: string): string => lookup(key, locale);

/** Three origins serving the same page set; every one starts this gate at the default `ask`. */
const A = "https://127.0.0.1:19443";
const B = "https://127.0.0.1:19444";
const C = "https://127.0.0.1:19445";

const PURPOSE = "Compare the ordinary pages on the two test sites";

/** How long "no card appeared" is watched for after a call has already answered. */
const NO_CARD_WINDOW_MS = 1_500;

/**
 * 017/T488 — the session site plan end to end (SC-121 – SC-124, FR-249 – FR-263).
 *
 * The plan is one owner decision standing in for many consent cards, so every claim here is about
 * which cards the *real* side panel shows and which it does not: one site-plan card listing every
 * proposed origin, no consent card for page actions on the approved origins, and every card that a
 * plan must not swallow (page JavaScript, an unlisted origin, another session, a cross-site move)
 * still raised. Decisions are made only by pressing the panel's own controls - never by writing
 * storage - because the claim is that the owner, and only the owner, grants a plan (FR-253).
 *
 * Uploads (`file_upload`, `upload_image`) keep their own consent on an approved site too (FR-255);
 * that leg is proved in the gate unit tests (`decideGate` never reads the plan for them) rather than
 * here, because staging an upload root or a retained screenshot would double this journey's setup
 * for a branch the gate decides without any browser state.
 *
 * Attach mode only, for the reason every agent journey is: the bridge is a machine install.
 *
 * Prerequisites: `npm run build`, `dist/agent` loaded in the attached browser,
 * `npm run agent-host:install`, and the fixture services running (19443-19445).
 */
test.describe("agent site plan", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT,
    "attach mode only: the native-messaging host is a machine install, so the browser under test " +
      "must be one the runner started and pointed at the installed host (HALLPASS_CDP_ENDPOINT).",
  );

  test("one card approves a narrowed plan, ten actions then ask nothing, and what a plan must not cover still asks", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(420_000);
    const panel = await ownerPanel(extensionContext, extensionId, extensionWorker);

    let first: McpHarnessClient | undefined;
    let second: McpHarnessClient | undefined;
    try {
      first = await startMcpClient({ clientName: "Claude Code" });
      const live = first;
      const call = callerFor(() => first);
      await panel.clickIfPresent(ui("agent.retry"));
      await pairWithFirstCall(live, panel, { locale });

      // ============ (1) one card, the whole list, the purpose and the warning (FR-251) ============
      const proposing = live.callTool(
        "propose_sites",
        { origins: [A, B, C], purpose: PURPOSE, steps: ["Read both pages", "Press the safe button on each"] },
        { timeoutMs: 120_000 },
      );
      await waitForPrompt(panel, "site-plan");
      expect(await promptCount(panel), "a proposal raised more than one card").toBe(1);
      expect(await planOrigins(panel), "the card does not list every proposed site").toEqual([A, B, C]);
      const cardText = await promptText(panel, "site-plan");
      expect(cardText).toContain(ui("agent.sitePlan.title"));
      expect(cardText).toContain(ui("agent.sitePlan.purpose").replace("{purpose}", PURPOSE));
      expect(cardText).toContain(ui("agent.sitePlan.warning"));
      // Every site starts ticked: the owner narrows rather than builds.
      expect(await planTicks(panel)).toEqual([true, true, true]);

      // SC-124: Approve is usable only while something is ticked.
      for (const origin of [A, B, C]) await togglePlanOrigin(panel, origin);
      expect(await approveDisabled(panel), "Approve was usable with every site unticked").toBe(true);
      await togglePlanOrigin(panel, A);
      await togglePlanOrigin(panel, B);
      expect(await planTicks(panel)).toEqual([true, true, false]);
      expect(await approveDisabled(panel)).toBe(false);
      await clickInPrompt(panel, "site-plan", ui("agent.sitePlan.approve"));

      const proposed = await proposing;
      expect(proposed.isError, `propose_sites: ${proposed.text}\nstderr:\n${live.stderr()}`).toBe(false);
      // An unticked site is never approved (SC-124), and the agent is told which one it lost.
      expect(proposed.json, proposed.text).toMatchObject({ approved: [A, B], leftOut: [C] });
      await expectNoPrompt(panel, "the site-plan card stayed up after Approve");

      // FR-259: the session card says a plan is in force, and FR-263: the activity list says so too.
      await expect.poll(() => sessionIds(panel), { timeout: 15_000 }).toHaveLength(1);
      const sessionId = (await sessionIds(panel))[0] as string;
      await expect
        .poll(() => planSummary(panel, sessionId), { timeout: 15_000 })
        .toBe(ui("agent.session.sitePlan").replace("{n}", "2"));
      await expect
        .poll(() => activityText(panel, sessionId), { timeout: 15_000 })
        .toContain(ui("agent.activity.sitePlan").replace("{n}", "2"));

      // ============ (2) SC-121: ten page actions over the two approved sites, no card ============
      const tabA = ((await call("tabs_create", { url: `${A}/ordinary` })) as { tabId: number }).tabId;
      const tabB = ((await call("tabs_create", { url: `${B}/ordinary` })) as { tabId: number }).tabId;
      const actions: Array<[string, Record<string, unknown>]> = [];
      for (const tabId of [tabA, tabB]) {
        const button = await refFor(call, tabId, (node) => node.role === "button" && node.name === "Safe action");
        const box = await refFor(call, tabId, (node) => node.role === "textbox");
        actions.push(
          ["click", { tabId, target: { ref: button } }],
          ["type", { tabId, target: { ref: box }, text: "planned", mode: "replace" }],
          ["key", { tabId, target: { ref: box }, key: "Tab" }],
          ["scroll", { tabId, direction: "down", amount: "small" }],
          ["scroll", { tabId, direction: "up", amount: "small" }],
        );
      }
      expect(actions).toHaveLength(10);
      for (const [tool, args] of actions) {
        await actWithoutCard(panel, live, tool, args);
      }
      await expectNoPrompt(panel, "a card appeared after the ten planned actions");
      // The clicks really landed: the fixture writes its own marker.
      for (const tabId of [tabA, tabB]) {
        const text = (await call("get_page_text", { tabId })) as { text: string };
        expect(text.text, `tab ${tabId}`).toContain("clicked at");
      }

      // ============ (3) SC-122: what the plan must not cover still asks ============
      // (a) page JavaScript on an approved site keeps its own consent (FR-255). `evaluate` is refused
      // before any card without the diagnostics grant, so the grant is given - mode stays `ask`.
      await setDiagnostics(panel, A, true);
      const script = live.callTool("evaluate", { tabId: tabA, expression: "document.title" });
      await refuseConsent(panel, script, live, "evaluate on an approved site");

      // (b) a press on the origin the owner unticked (FR-256).
      const tabC = ((await call("tabs_create", { url: `${C}/ordinary` })) as { tabId: number }).tabId;
      const buttonC = await refFor(call, tabC, (node) => node.role === "button" && node.name === "Safe action");
      const unlisted = live.callTool("click", { tabId: tabC, target: { ref: buttonC } });
      await refuseConsent(panel, unlisted, live, "click on the unticked site");

      // (c) another session pressing on an approved site (FR-256): the plan is per session.
      second = await startMcpClient({ clientName: "Claude Code" });
      const other = second;
      const callOther = callerFor(() => second);
      await pairWithFirstCall(other, panel, { locale });
      const tabOther = ((await callOther("tabs_create", { url: `${A}/ordinary` })) as { tabId: number }).tabId;
      const buttonOther = await refFor(callOther, tabOther, (node) => node.role === "button" && node.name === "Safe action");
      const foreign = other.callTool("click", { tabId: tabOther, target: { ref: buttonOther } });
      await refuseConsent(panel, foreign, other, "click by a second session on an approved site");

      // And the first session's plan is untouched by all three refusals.
      await actWithoutCard(panel, live, "click", { tabId: tabA, target: { ref: await refFor(call, tabA, safeAction) } });

      for (const tabId of [tabA, tabB, tabC, tabOther]) await closeTab(extensionWorker, tabId);
    } finally {
      await setDiagnostics(panel, A, false).catch(() => undefined);
      await clearSite(panel, A);
      await first?.close();
      await second?.close();
    }
  });

  test("a move off an approved site still raises the 014 transition card (FR-262)", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(300_000);
    const panel = await ownerPanel(extensionContext, extensionId, extensionWorker);

    let client: McpHarnessClient | undefined;
    try {
      client = await startMcpClient({ clientName: "Claude Code" });
      const live = client;
      const call = callerFor(() => client);
      await panel.clickIfPresent(ui("agent.retry"));
      await pairWithFirstCall(live, panel, { locale });
      await approvePlan(panel, live, [A, B]);

      // The fixture origins are all loopback, which rule (a) exempts from transitions; the gate's
      // test switch makes them count as the ordinary sites they stand for (agent-transitions.spec).
      await setTransitionTestSwitch(extensionWorker, true);

      const tab = ((await call("tabs_create", { url: `${A}/transition-a` })) as { tabId: number }).tabId;
      // The click itself is on an approved site, so it asks nothing...
      await actWithoutCard(panel, live, "click", {
        tabId: tab,
        target: { ref: await refFor(call, tab, (node) => node.name === "Go to B") },
      });
      // ...and the server takes the tab to an origin nobody asked for by name.
      await expect.poll(() => urlOf(extensionWorker, tab), { timeout: 30_000 }).toContain(":19445/");

      // The next call on that tab is held behind the transition card exactly as without a plan.
      const held = live.callTool("get_page_text", { tabId: tab });
      await panel.waitForText(ui("agent.prompt.transition").replace("{from}", A).replace("{to}", C));
      expect(await promptKinds(panel), "the plan changed which card a move raises").toEqual(["transition"]);
      await clickInPrompt(panel, "transition", ui("agent.transitionDecline"));
      const declined = await held;
      expect(declined.isError, `text: ${declined.text}\nstderr:\n${live.stderr()}`).toBe(true);
      expect(answerOf(declined), declined.text).toMatchObject({ outcome: "denied", reason: "site-transition-declined" });

      await closeTab(extensionWorker, tab);
    } finally {
      await setTransitionTestSwitch(extensionWorker, false).catch(() => undefined);
      await client?.close();
    }
  });

  test("withdraw, unpair and the end of the session each end the plan; an interrupt keeps it (SC-123)", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(420_000);
    const panel = await ownerPanel(extensionContext, extensionId, extensionWorker);

    let client: McpHarnessClient | undefined;
    let next: McpHarnessClient | undefined;
    let third: McpHarnessClient | undefined;
    try {
      client = await startMcpClient({ clientName: "Claude Code" });
      const live = client;
      const call = callerFor(() => client);
      await panel.clickIfPresent(ui("agent.retry"));
      await pairWithFirstCall(live, panel, { locale });

      const tab =((await call("tabs_create", { url: `${A}/ordinary` })) as { tabId: number }).tabId;
      const press = async (): Promise<Record<string, unknown>> => ({
        tabId: tab,
        target: { ref: await refFor(call, tab, safeAction) },
      });
      await approvePlan(panel, live, [A, B]);
      await expect.poll(() => sessionIds(panel), { timeout: 15_000 }).toHaveLength(1);
      const sessionId = (await sessionIds(panel))[0] as string;
      await actWithoutCard(panel, live, "click", await press());

      // ============ (a) Withdraw on the session card ends it at once (FR-259) ============
      await expect
        .poll(() => planSummary(panel, sessionId), { timeout: 15_000 })
        .toBe(ui("agent.session.sitePlan").replace("{n}", "2"));
      await clickOnCard(panel, sessionId, ui("agent.session.sitePlanWithdraw"));
      await expect.poll(() => planSummary(panel, sessionId), { timeout: 15_000 }).toBeNull();
      await refuseConsent(panel, live.callTool("click", await press()), live, "click after Withdraw");

      // ============ (b) an interrupt ends the step, not the plan (FR-258) ============
      await approvePlan(panel, live, [A, B]);
      const waiting = live.callTool("wait", { tabId: tab, forMs: 15_000 });
      await expect.poll(() => inFlightOnCard(panel, sessionId), { timeout: 15_000 }).toBe(true);
      await clickOnCard(panel, sessionId, ui("agent.session.interrupt"));
      const interrupted = await waiting;
      expect(answerOf(interrupted), `text: ${interrupted.text}\nstderr:\n${live.stderr()}`).toMatchObject({
        outcome: "stopped",
        reason: "owner-interrupted",
      });
      expect(await planSummary(panel, sessionId), "an interrupt took the plan away").toBe(
        ui("agent.session.sitePlan").replace("{n}", "2"),
      );
      await actWithoutCard(panel, live, "click", await press());

      // ============ (c) unpair ends the plan of every session of the agent (FR-258) ============
      // 003 FR-032a: after an unpair the session is answered `denied` without a card until it
      // reconnects, so the check is that the plan went with the pairing - the session asks no card
      // and admits nothing - and that a reconnected session starts with no plan.
      // The target is read before the unpair: afterwards every call of this session, reads included,
      // is refused - which is the point being checked.
      const targetBeforeUnpair = await press();
      await unpairAgent(panel, { locale });
      const afterUnpair = await live.callTool("click", targetBeforeUnpair);
      expect(answerOf(afterUnpair), `text: ${afterUnpair.text}\nstderr:\n${live.stderr()}`).toMatchObject({
        outcome: "denied",
      });
      expect(await planSummary(panel, sessionId), "the plan outlived the unpair").toBeNull();
      await closeTab(extensionWorker, tab);
      await client.close();
      client = undefined;

      next = await startMcpClient({ clientName: "Claude Code" });
      const fresh = next;
      const callNext = callerFor(() => next);
      await pairWithFirstCall(fresh, panel, { locale });
      const tabNext = ((await callNext("tabs_create", { url: `${A}/ordinary` })) as { tabId: number }).tabId;
      const pressNext = async (): Promise<Record<string, unknown>> => ({
        tabId: tabNext,
        target: { ref: await refFor(callNext, tabNext, safeAction) },
      });
      await refuseConsent(
        panel,
        fresh.callTool("click", await pressNext()),
        fresh,
        "click by the reconnected session after the unpair",
      );

      // ============ (d) the end of the session ends the plan ============
      await approvePlan(panel, fresh, [A, B]);
      await actWithoutCard(panel, fresh, "click", await pressNext());
      await closeTab(extensionWorker, tabNext);
      await next.close();
      next = undefined;
      await expect.poll(() => sessionIds(panel), { timeout: 20_000 }).toEqual([]);

      third = await startMcpClient({ clientName: "Claude Code" });
      const last = third;
      const callLast = callerFor(() => third);
      await pairWithFirstCall(last, panel, { locale });
      const tabLast = ((await callLast("tabs_create", { url: `${A}/ordinary` })) as { tabId: number }).tabId;
      await refuseConsent(
        panel,
        last.callTool("click", { tabId: tabLast, target: { ref: await refFor(callLast, tabLast, safeAction) } }),
        last,
        "click by a new session after the planned one ended",
      );
      await closeTab(extensionWorker, tabLast);
    } finally {
      await client?.close();
      await next?.close();
      await third?.close();
    }
  });

  test("a declined proposal grants nothing, and an invalid one is refused before any card", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(240_000);
    const panel = await ownerPanel(extensionContext, extensionId, extensionWorker);

    let client: McpHarnessClient | undefined;
    try {
      client = await startMcpClient({ clientName: "Claude Code" });
      const live = client;
      const call = callerFor(() => client);
      await panel.clickIfPresent(ui("agent.retry"));
      await pairWithFirstCall(live, panel, { locale });

      // ============ Decline: `declined`, and nothing granted (FR-252) ============
      const proposing = live.callTool("propose_sites", { origins: [A, B], purpose: PURPOSE }, { timeoutMs: 120_000 });
      await waitForPrompt(panel, "site-plan");
      await clickInPrompt(panel, "site-plan", ui("agent.sitePlan.decline"));
      const declined = await proposing;
      expect(answerOf(declined), `text: ${declined.text}\nstderr:\n${live.stderr()}`).toMatchObject({ outcome: "declined" });
      await expectNoPrompt(panel, "the site-plan card stayed up after Decline");
      await expect.poll(() => sessionIds(panel), { timeout: 15_000 }).toHaveLength(1);
      const sessionId = (await sessionIds(panel))[0] as string;
      expect(await planSummary(panel, sessionId), "a declined proposal shows a plan").toBeNull();
      const tab = ((await call("tabs_create", { url: `${A}/ordinary` })) as { tabId: number }).tabId;
      await refuseConsent(
        panel,
        live.callTool("click", { tabId: tab, target: { ref: await refFor(call, tab, safeAction) } }),
        live,
        "click after a declined proposal",
      );

      // ============ Invalid: refused naming the entry, and no card (FR-250) ============
      const bad = `${A}/path`;
      const invalid = await live.callTool("propose_sites", { origins: [B, bad], purpose: PURPOSE });
      expect(invalid.isError, `text: ${invalid.text}`).toBe(true);
      expect(answerOf(invalid), `text: ${invalid.text}\nstderr:\n${live.stderr()}`).toMatchObject({
        outcome: "failed",
        reason: "invalid-arguments",
      });
      expect((answerOf(invalid) as { hint?: string }).hint ?? "", "the refusal does not name the entry").toContain(bad);
      await expectNoPrompt(panel, "an invalid proposal raised a card");

      await closeTab(extensionWorker, tab);
    } finally {
      await client?.close();
    }
  });
});

type ReadNode = { ref?: string; role?: string; name?: string };

const safeAction = (node: ReadNode): boolean => node.role === "button" && node.name === "Safe action";

/** The owner's tab with the real side panel open on it, ready to be read. */
async function ownerPanel(
  context: Parameters<typeof openSidePanel>[0]["context"],
  extensionId: string,
  worker: PackagedWorker,
): Promise<SidePanelDriver> {
  const permissions = await worker.evaluate(() => chrome.runtime.getManifest().permissions ?? []);
  expect(permissions, "the attached browser must have apps/extension/dist/agent loaded (npm run build)").toContain(
    "nativeMessaging",
  );
  const ownerPage = context.pages()[0] ?? (await context.newPage());
  await ownerPage.goto(`${A}/waiting`);
  await ownerPage.bringToFront();
  const ownerTabId = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) throw new Error("active-tab-missing");
    return tab.id;
  });
  const panel = await openSidePanel({ context, extensionId, fixturePage: ownerPage, tabId: ownerTabId, copy });
  await waitForAgentPanel(panel);
  return panel;
}

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

/** One live ref for a control, from a structural read of the tab. */
async function refFor(
  call: (tool: string, args: Record<string, unknown>) => Promise<unknown>,
  tabId: number,
  match: (node: ReadNode) => boolean,
): Promise<string> {
  const page = (await call("read_page", { tabId, filter: "all" })) as { nodes: ReadNode[] };
  const node = page.nodes.find((candidate) => candidate.ref !== undefined && match(candidate));
  expect(node, `read_page offered no matching ref on tab ${tabId}: ${JSON.stringify(page.nodes)}`).toBeTruthy();
  return node?.ref as string;
}

/** The kinds of every question on the panel right now (`site-plan`, `consent`, `transition`...). */
async function promptKinds(panel: SidePanelDriver): Promise<string[]> {
  return (await panel.evaluatePanel(
    "[...document.querySelectorAll('[data-prompt]')].map((card)=>card.getAttribute('data-prompt'))",
  )) as string[];
}

async function promptCount(panel: SidePanelDriver): Promise<number> {
  return (await promptKinds(panel)).length;
}

async function waitForPrompt(panel: SidePanelDriver, kind: string, timeoutMs = 30_000): Promise<void> {
  await expect
    .poll(() => promptKinds(panel), { timeout: timeoutMs, message: `no ${kind} card appeared` })
    .toContain(kind);
}

/**
 * No card of any kind for a bounded window. A card that does appear is reported with the panel's
 * own text, so the failure says what the owner was asked.
 */
async function expectNoPrompt(panel: SidePanelDriver, why: string, windowMs = NO_CARD_WINDOW_MS): Promise<void> {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    const kinds = await promptKinds(panel);
    if (kinds.length > 0) {
      throw new Error(`${why}: ${kinds.join(",")} card on the panel\n${await panel.panelText()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

async function promptText(panel: SidePanelDriver, kind: string): Promise<string> {
  return (await panel.evaluatePanel(
    `document.querySelector('[data-prompt=${JSON.stringify(kind)}]')?.innerText ?? ''`,
  )) as string;
}

/** A button inside one card, so two cards sharing a word ("Decline") can never be confused. */
async function clickInPrompt(panel: SidePanelDriver, kind: string, label: string): Promise<void> {
  const clicked = await panel.evaluatePanel(
    `(()=>{const card=document.querySelector('[data-prompt=${JSON.stringify(kind)}]');` +
      `const b=card&&[...card.querySelectorAll('button')].find((x)=>x.textContent?.trim()===${JSON.stringify(label)});` +
      `if(!b)return false;b.click();return true})()`,
    true,
  );
  expect(clicked, `no ${label} on the ${kind} card\n${await panel.panelText()}`).toBe(true);
}

/** The origins the site-plan card lists, in its order. */
async function planOrigins(panel: SidePanelDriver): Promise<string[]> {
  return (await panel.evaluatePanel(
    "[...document.querySelectorAll('[data-prompt=site-plan] li[data-origin]')].map((li)=>li.getAttribute('data-origin'))",
  )) as string[];
}

async function planTicks(panel: SidePanelDriver): Promise<boolean[]> {
  return (await panel.evaluatePanel(
    "[...document.querySelectorAll('[data-prompt=site-plan] li[data-origin] input[type=checkbox]')].map((box)=>box.checked)",
  )) as boolean[];
}

async function togglePlanOrigin(panel: SidePanelDriver, origin: string): Promise<void> {
  const before = await planTicks(panel);
  const clicked = await panel.evaluatePanel(
    `(()=>{const box=document.querySelector('[data-prompt=site-plan] li[data-origin=${JSON.stringify(origin)}] input[type=checkbox]');` +
      `if(!box)return false;box.click();return true})()`,
    true,
  );
  expect(clicked, `no tick box for ${origin} on the site-plan card`).toBe(true);
  // React re-renders the box from its own state; wait for that rather than trusting the click.
  await expect.poll(() => planTicks(panel), { timeout: 5_000 }).not.toEqual(before);
}

async function approveDisabled(panel: SidePanelDriver): Promise<boolean | null> {
  const label = ui("agent.sitePlan.approve");
  return (await panel.evaluatePanel(
    `(()=>{const card=document.querySelector('[data-prompt=site-plan]');` +
      `const b=card&&[...card.querySelectorAll('button')].find((x)=>x.textContent?.trim()===${JSON.stringify(label)});` +
      `return b?b.disabled:null})()`,
  )) as boolean | null;
}

/** Proposes `origins`, approves all of them on the card, and requires the agent to hear `ok`. */
async function approvePlan(panel: SidePanelDriver, client: McpHarnessClient, origins: string[]): Promise<void> {
  const proposing = client.callTool("propose_sites", { origins, purpose: PURPOSE }, { timeoutMs: 120_000 });
  await waitForPrompt(panel, "site-plan");
  expect(await planOrigins(panel)).toEqual(origins);
  await clickInPrompt(panel, "site-plan", ui("agent.sitePlan.approve"));
  const answer = await proposing;
  expect(answer.isError, `propose_sites: ${answer.text}\nstderr:\n${client.stderr()}`).toBe(false);
  expect(answer.json, answer.text).toMatchObject({ approved: origins, leftOut: [] });
}

/**
 * Runs one call that must not raise any card, and fails the moment one appears.
 *
 * A card would hold the call until somebody answered it, so waiting for the answer first would turn
 * the failure into a timeout that says nothing. The panel is watched while the call is in flight;
 * a card that shows up is refused - so the call returns - and reported with what it was.
 */
async function actWithoutCard(
  panel: SidePanelDriver,
  client: McpHarnessClient,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string; json: unknown }> {
  let settled = false;
  const pending = client.callTool(tool, args).finally(() => {
    settled = true;
  });
  while (!settled) {
    const kinds = await promptKinds(panel);
    if (kinds.length > 0) {
      const text = await panel.panelText();
      await panel.clickIfPresent(ui("agent.refuse"));
      await pending.catch(() => undefined);
      throw new Error(`${tool} ${JSON.stringify(args)} raised a ${kinds.join(",")} card under the plan\n${text}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const result = await pending;
  expect(result.isError, `${tool} ${JSON.stringify(args)}: ${result.text}\nstderr:\n${client.stderr()}`).toBe(false);
  return result;
}

/** The call must raise a consent card; the owner refuses it, and the agent hears `owner-denied`. */
async function refuseConsent(
  panel: SidePanelDriver,
  pending: Promise<{ isError: boolean; text: string; json: unknown }>,
  client: McpHarnessClient,
  what: string,
): Promise<void> {
  const answered = pending.then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
  try {
    await waitForPrompt(panel, "consent");
  } catch (error) {
    // The call may already have answered without asking - say what it answered.
    const early = await Promise.race([answered, new Promise((resolve) => setTimeout(() => resolve("still pending"), 500))]);
    throw new Error(
      `${what}: no consent card (${String(error)})\ncall: ${JSON.stringify(early)}\nstderr:\n${client.stderr()}`,
    );
  }
  await panel.waitForText(ui("agent.promptTitle"));
  await clickInPrompt(panel, "consent", ui("agent.refuse"));
  const settled = await answered;
  if ("error" in settled) throw new Error(`${what}: ${String(settled.error)}\nstderr:\n${client.stderr()}`);
  expect(settled.result.isError, `${what}: ${settled.result.text}`).toBe(true);
  expect(answerOf(settled.result), `${what}: ${settled.result.text}\nstderr:\n${client.stderr()}`).toMatchObject({
    outcome: "denied",
    reason: "owner-denied",
  });
  await expect.poll(() => promptKinds(panel), { timeout: 15_000 }).toEqual([]);
}

/** Every session card on the panel, by the id the projection gave it. */
async function sessionIds(panel: SidePanelDriver): Promise<string[]> {
  return (await panel.evaluatePanel(
    "[...document.querySelectorAll('[data-session-id]')].map((card)=>card.getAttribute('data-session-id'))",
  )) as string[];
}

/** The plan summary on a session card (FR-259), or `null` when the card shows no plan. */
async function planSummary(panel: SidePanelDriver, sessionId: string): Promise<string | null> {
  return (await panel.evaluatePanel(
    `document.querySelector('[data-session-id=${JSON.stringify(sessionId)}] .agent-session-site-plan summary')?.textContent?.trim() ?? null`,
  )) as string | null;
}

async function activityText(panel: SidePanelDriver, sessionId: string): Promise<string> {
  return (await panel.evaluatePanel(
    `document.querySelector('[data-session-id=${JSON.stringify(sessionId)}] .agent-session-activity')?.textContent ?? ''`,
  )) as string;
}

async function clickOnCard(panel: SidePanelDriver, sessionId: string, label: string): Promise<void> {
  const clicked = await panel.evaluatePanel(
    `(()=>{const card=document.querySelector('[data-session-id=${JSON.stringify(sessionId)}]');` +
      `const b=card&&[...card.querySelectorAll('button')].find((x)=>x.textContent?.trim()===${JSON.stringify(label)});` +
      `if(!b)return false;b.click();return true})()`,
    true,
  );
  expect(clicked, `no ${label} on the card for ${sessionId}\n${await panel.panelText()}`).toBe(true);
}

/** Whether the card says there is anything to interrupt (014 FR-178). */
async function inFlightOnCard(panel: SidePanelDriver, sessionId: string): Promise<boolean> {
  const disabled = await panel.evaluatePanel(
    `(()=>{const card=document.querySelector('[data-session-id=${JSON.stringify(sessionId)}]');` +
      `return card?.querySelector('.agent-interrupt')?.getAttribute('aria-disabled') ?? null})()`,
  );
  return disabled === "false";
}

/**
 * Grants or revokes diagnostics for one site through the site list's own checkbox (004 FR-049),
 * scoped to that site's row so a plan's origin list elsewhere on the panel is never mistaken for it.
 */
async function setDiagnostics(panel: SidePanelDriver, site: string, granted: boolean): Promise<void> {
  const row = `.agent-sites li[data-site=${JSON.stringify(site)}]`;
  await expect
    .poll(() => panel.evaluatePanel(`document.querySelector(${JSON.stringify(row)}) !== null`), {
      timeout: 15_000,
      message: `the site list has no row for ${site}`,
    })
    .toBe(true);
  const clicked = await panel.evaluatePanel(
    `(()=>{const box=document.querySelector(${JSON.stringify(`${row} input[type=checkbox]`)});` +
      `if(!box)return false;if(box.checked===${String(granted)})return true;box.click();return true})()`,
    true,
  );
  expect(clicked, `the panel offers no diagnostics control for ${site}`).toBe(true);
  await expect
    .poll(
      () => panel.evaluatePanel(`document.querySelector(${JSON.stringify(`${row} input[type=checkbox]`)})?.checked ?? null`),
      { timeout: 15_000 },
    )
    .toBe(granted);
}

/** The site list's own revoke, so the next gate starts from an undecided site. Best effort. */
async function clearSite(panel: SidePanelDriver, site: string): Promise<void> {
  const present = await panel
    .evaluatePanel(`document.querySelector(${JSON.stringify(`.agent-sites li[data-site=${JSON.stringify(site)}]`)}) !== null`)
    .catch(() => false);
  if (present !== true) return;
  await clickLabelled(panel, ui("agent.siteRevoke").replace("{site}", site)).catch(() => undefined);
}

/** Where the browser says the tab is; waited on rather than a page load event. */
async function urlOf(worker: PackagedWorker, tabId: number): Promise<string> {
  return worker.evaluate(async (id: number) => (await chrome.tabs.get(id)).url ?? "", tabId);
}

/** Tidying up through the browser: a tab with a question standing holds `tabs_close` too. */
async function closeTab(worker: PackagedWorker, tabId: number): Promise<void> {
  await worker.evaluate(async (id: number) => {
    await chrome.tabs.remove(id).catch(() => undefined);
  }, tabId);
}
