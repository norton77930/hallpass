import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lookup } from "../../../apps/extension/src/locales/catalog.js";
import { startMcpClient, type McpHarnessClient } from "../../harness/mcp-client.js";
import { pairWithFirstCall } from "../fixtures/agent-pairing.js";
import { openSettingsPage } from "../fixtures/settings-page-driver.js";
import {
  cardSelector,
  copyFor,
  localeFromEnv,
  openCard,
  openSidePanel,
  waitForAgentPanel,
  type SidePanelDriver,
} from "../fixtures/side-panel-driver.js";
import { expect, test, type PackagedWorker } from "../fixtures/packaged-extension.js";

const locale = localeFromEnv();
const copy = copyFor(locale);
const ui = (key: string): string => lookup(key, locale);

/**
 * Every fixture origin is loopback (`127.0.0.1`), and none of them has a stored site mode, so the site
 * is at the default `ask` for the whole journey.
 */
const SITE = "https://127.0.0.1:19443";
const HOST = new URL(SITE).host;

/** How long "no card appeared" is watched for after a call has already answered. */
const NO_CARD_WINDOW_MS = 1_500;

/**
 * 043 US2 (FR-623 - FR-628, scenarios 1, 2, 4, 6 of the spec's US2 list; D-043-3) - "this session" for page
 * scripts on a loopback site, in the real built extension.
 *
 * The agent is a real stdio MCP client against the real `dist/mcp-server.js`; the owner is the real side
 * panel, read and pressed through its own DOM and buttons (and the settings page's own checkbox for the
 * diagnostics grant, 024 FR-385). Nothing is set through storage or a worker setter, because the claim is
 * that the *owner's* one press records the grant.
 *
 * One journey, in the order the owner would meet it:
 *   1. `evaluate` on a loopback site at `ask`, diagnostics already granted, raises the effect card, and
 *      the card offers Allow once, This session and Refuse (FR-624) - screenshot.
 *   2. This session: the call answers with the page's value; a second `evaluate` raises no card (FR-625).
 *   3. The session card lists the new "page scripts" grant line (FR-628) - screenshot.
 *   4. A `click` by the same session on the same site still raises a card (FR-626).
 *   5. A second paired session's `evaluate` on that site still raises a card (FR-625: per session).
 *
 * The look-alike hosts of scenario 6 and the grant's end with the session are unit-test claims (SC-283);
 * a browser cannot serve `localhost.example.com` from this fixture rig.
 *
 * Attach mode only, for the reason every agent journey is: the bridge is a machine install.
 *
 * Prerequisites: `npm run build`, `dist/agent` loaded in the attached browser,
 * `npm run agent-host:install`, and the fixture services running (19443).
 */
test.describe("043 scripts session grant", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT,
    "attach mode only: the native-messaging host is a machine install, so the browser under test " +
      "must be one the runner started and pointed at the installed host (HALLPASS_CDP_ENDPOINT).",
  );

  test("This session on the evaluate card admits that session's later scripts on that loopback site and nothing else", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(300_000);
    const permissions = await extensionWorker.evaluate(() => chrome.runtime.getManifest().permissions ?? []);
    expect(permissions, "the attached browser must have apps/extension/dist/agent loaded (npm run build)").toContain(
      "nativeMessaging",
    );
    const ownerPage = extensionContext.pages()[0] ?? (await extensionContext.newPage());
    await ownerPage.goto(`${SITE}/waiting`);
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
    await waitForAgentPanel(panel);
    const settings = await openSettingsPage({
      context: extensionContext,
      worker: extensionWorker,
      extensionId,
      locale,
      route: "#sites",
    });

    let first: McpHarnessClient | undefined;
    let second: McpHarnessClient | undefined;
    const tabs: number[] = [];
    try {
      first = await startMcpClient({ clientName: "Claude Code" });
      const live = first;
      await panel.clickIfPresent(ui("agent.retry"));
      await pairWithFirstCall(live, panel, { locale });

      const created = await live.callTool("tabs_create", { url: `${SITE}/ordinary` });
      expect(created.isError, `tabs_create: ${created.text}\nstderr:\n${live.stderr()}`).toBe(false);
      const tab = (created.json as { tabId: number }).tabId;
      tabs.push(tab);

      // The diagnostics grant is the owner's, given as the 031 specs give it; only the effect question remains.
      const startMode = await settings.siteMode(SITE);
      expect(startMode === null || startMode === "ask", `the site must start at ask, not ${String(startMode)}`).toBe(true);
      await settings.setDiagnostics(SITE, true);

      await expect.poll(() => sessionIds(panel), { timeout: 15_000 }).toHaveLength(1);
      const sessionId = (await sessionIds(panel))[0] as string;

      // ============ (1) the card offers Allow once, This session and Refuse (FR-624) ============
      const firstScript = live.callTool("evaluate", { tabId: tab, expression: "document.title" });
      const firstSettled = firstScript.then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      await waitForConsent(panel, firstSettled, live, "the first evaluate");
      const labels = await consentButtons(panel);
      expect(labels, `the evaluate card's buttons\n${await panel.panelText()}`).toEqual(
        expect.arrayContaining([ui("agent.allowOnce"), ui("agent.allowSession"), ui("agent.refuse")]),
      );
      expect(labels[0], "Allow once leads the card").toBe(ui("agent.allowOnce"));
      expect(labels[1], "This session follows it (FR-624)").toBe(ui("agent.allowSession"));
      expect(labels.at(-1), "Refuse closes the card").toBe(ui("agent.refuse"));
      // A fourth button is the card's long-standing "Always allow on ...", which this story does not touch.
      expect(labels, "the card offers nothing but once, session, always and refuse").toHaveLength(4);
      expect(await promptText(panel, "consent"), "the card names the site").toContain(HOST);
      await panelShot(panel, "043-us2-1-evaluate-card.png");

      // ============ (2) This session: answered with the page's value; the second call asks nothing ============
      await clickInPrompt(panel, "consent", ui("agent.allowSession"));
      const ran = await firstScript;
      expect(ran.isError, `evaluate after This session: ${ran.text}\nstderr:\n${live.stderr()}`).toBe(false);
      expect(ran.text, "the first evaluate answered with the page's own value").toContain("Ordinary fixture");
      await expect.poll(() => promptKinds(panel), { timeout: 15_000 }).toEqual([]);

      const again = await runWithoutCard(panel, live, "evaluate", { tabId: tab, expression: "document.title" });
      expect(again.text, "the second evaluate answered with the page's own value").toContain("Ordinary fixture");
      await expectNoPrompt(panel, "a card stayed up after the second evaluate");

      // ============ (3) the session card lists the scripts grant (FR-628) ============
      await openCard(panel, sessionId);
      await expect
        .poll(() => scriptsGrantLine(panel, sessionId), { timeout: 15_000, message: "no page scripts grant line on the session card" })
        .toBe(true);
      await panel.evaluatePanel(
        `document.querySelector(${JSON.stringify(cardSelector(sessionId))} + ' .agent-session-grant')?.scrollIntoView({block:'center'})`,
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      await panelShot(panel, "043-us2-2-session-card-scripts-grant.png");

      // ============ (4) the scripts grant does not admit a page action (FR-626) ============
      const buttonRef = await refFor(live, tab, (node) => node.role === "button" && node.name === "Safe action");
      await refuseConsent(
        panel,
        live.callTool("click", { tabId: tab, target: { ref: buttonRef } }),
        live,
        "click on the site where only a scripts grant stands",
      );

      // ============ (5) the grant is per session (FR-625) ============
      second = await startMcpClient({ clientName: "Claude Code" });
      const other = second;
      await pairWithFirstCall(other, panel, { locale });
      const createdOther = await other.callTool("tabs_create", { url: `${SITE}/ordinary` });
      expect(createdOther.isError, `tabs_create: ${createdOther.text}\nstderr:\n${other.stderr()}`).toBe(false);
      const tabOther = (createdOther.json as { tabId: number }).tabId;
      tabs.push(tabOther);
      await refuseConsent(
        panel,
        other.callTool("evaluate", { tabId: tabOther, expression: "document.title" }),
        other,
        "evaluate by a second session on the site the first session was granted",
      );

      // And the first session's grant is untouched by the refusals.
      await runWithoutCard(panel, live, "evaluate", { tabId: tab, expression: "document.title" });
    } finally {
      // The grant goes back off while a session tab still lists the site's row (024 FR-385).
      await settings.setDiagnostics(SITE, false).catch(() => undefined);
      for (const tabId of tabs) await closeTab(extensionWorker, tabId);
      await first?.close();
      await second?.close();
    }
  });
});

type ReadNode = { ref?: string; role?: string; name?: string };

/** One live ref for a control, from a structural read of the tab. */
async function refFor(client: McpHarnessClient, tabId: number, match: (node: ReadNode) => boolean): Promise<string> {
  const read = await client.callTool("read_page", { tabId, filter: "all" });
  expect(read.isError, `read_page: ${read.text}\nstderr:\n${client.stderr()}`).toBe(false);
  const nodes = (read.json as { nodes: ReadNode[] }).nodes;
  const node = nodes.find((candidate) => candidate.ref !== undefined && match(candidate));
  expect(node, `read_page offered no matching ref on tab ${tabId}: ${JSON.stringify(nodes)}`).toBeTruthy();
  return node?.ref as string;
}

/** The host answers a call as JSON text; a non-JSON answer is reported as what it was. */
function answerOf(result: { text: string; json?: unknown }): unknown {
  try {
    return JSON.parse(result.text) as unknown;
  } catch {
    return result.json ?? { unparsed: result.text };
  }
}

/** The kinds of every question on the panel right now (`consent`, `site-plan`, `transition`...). */
async function promptKinds(panel: SidePanelDriver): Promise<string[]> {
  return (await panel.evaluatePanel(
    "[...document.querySelectorAll('[data-prompt]')].map((card)=>card.getAttribute('data-prompt'))",
  )) as string[];
}

async function promptText(panel: SidePanelDriver, kind: string): Promise<string> {
  return (await panel.evaluatePanel(
    `document.querySelector('[data-prompt=${JSON.stringify(kind)}]')?.innerText ?? ''`,
  )) as string;
}

/** The visible text of every button on the consent card, in the card's order. */
async function consentButtons(panel: SidePanelDriver): Promise<string[]> {
  return (await panel.evaluatePanel(
    "[...document.querySelectorAll('[data-prompt=consent] button')].map((b)=>(b.textContent??'').trim())",
  )) as string[];
}

/** A button inside one card, so two cards sharing a word can never be confused. */
async function clickInPrompt(panel: SidePanelDriver, kind: string, label: string): Promise<void> {
  const clicked = await panel.evaluatePanel(
    `(()=>{const card=document.querySelector('[data-prompt=${JSON.stringify(kind)}]');` +
      `const b=card&&[...card.querySelectorAll('button')].find((x)=>x.textContent?.trim()===${JSON.stringify(label)});` +
      `if(!b)return false;b.click();return true})()`,
    true,
  );
  expect(clicked, `no ${label} on the ${kind} card\n${await panel.panelText()}`).toBe(true);
}

type Settled = { result: { isError: boolean; text: string; json: unknown } } | { error: unknown };

/** Waits for a consent card; when the call answered without one, says what it answered. */
async function waitForConsent(
  panel: SidePanelDriver,
  answered: Promise<Settled>,
  client: McpHarnessClient,
  what: string,
): Promise<void> {
  try {
    await expect
      .poll(() => promptKinds(panel), { timeout: 30_000, message: `no consent card appeared` })
      .toContain("consent");
  } catch (error) {
    const early = await Promise.race([answered, new Promise((resolve) => setTimeout(() => resolve("still pending"), 500))]);
    throw new Error(
      `${what}: no consent card (${String(error)})\ncall: ${JSON.stringify(early)}\nstderr:\n${client.stderr()}`,
    );
  }
  await panel.waitForText(ui("agent.promptTitle"));
}

/** The call must raise a consent card; the owner refuses it, and the agent hears `owner-denied`. */
async function refuseConsent(
  panel: SidePanelDriver,
  pending: Promise<{ isError: boolean; text: string; json: unknown }>,
  client: McpHarnessClient,
  what: string,
): Promise<void> {
  const answered: Promise<Settled> = pending.then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
  await waitForConsent(panel, answered, client, what);
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

/**
 * Runs one call that must not raise any card, and fails the moment one appears. A card would hold the
 * call until somebody answered it, so the panel is watched while the call is in flight; a card that shows
 * up is refused - so the call returns - and reported with what it was.
 */
async function runWithoutCard(
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
      throw new Error(`${tool} ${JSON.stringify(args)} raised a ${kinds.join(",")} card under the scripts grant\n${text}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const result = await pending;
  expect(result.isError, `${tool} ${JSON.stringify(args)}: ${result.text}\nstderr:\n${client.stderr()}`).toBe(false);
  return result;
}

/** No card of any kind for a bounded window; a card that does appear is reported with the panel's text. */
async function expectNoPrompt(panel: SidePanelDriver, why: string, windowMs = NO_CARD_WINDOW_MS): Promise<void> {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    const kinds = await promptKinds(panel);
    if (kinds.length > 0) throw new Error(`${why}: ${kinds.join(",")} card on the panel\n${await panel.panelText()}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/** Every session card on the panel, by the id the projection gave it. */
async function sessionIds(panel: SidePanelDriver): Promise<string[]> {
  return (await panel.evaluatePanel(
    "[...document.querySelectorAll('[data-session-id]')].map((card)=>card.getAttribute('data-session-id'))",
  )) as string[];
}

/** Whether the session card's row for the site carries the "page scripts" grant (FR-628), and where it was given. */
async function scriptsGrantLine(panel: SidePanelDriver, sessionId: string): Promise<boolean> {
  const found = await panel.evaluatePanel(
    `(()=>{const card=document.querySelector(${JSON.stringify(cardSelector(sessionId))});if(!card)return false;` +
      `return [...card.querySelectorAll('.agent-session-sites li')].some((li)=>` +
      `(li.querySelector('.agent-session-site-name')?.textContent??'').trim()===${JSON.stringify(HOST)}` +
      `&&[...li.querySelectorAll('.agent-session-grant')].some((g)=>(g.textContent??'').includes(${JSON.stringify(ui("agent.session.grantKind.scripts"))})` +
      `&&g.querySelector('.agent-session-place')!==null))})()`,
  );
  return found === true;
}

/** The panel as the owner sees it, from its own CDP session, into the run's output directory. */
async function panelShot(panel: SidePanelDriver, name: string): Promise<void> {
  const shot = await panel.sendToPanel("Page.captureScreenshot", { format: "png" });
  const data = (shot.result as { data?: string } | undefined)?.data;
  expect(data, JSON.stringify(shot).slice(0, 300)).toBeTruthy();
  const dir = test.info().project.outputDir;
  mkdirSync(dir, { recursive: true });
  const saved = join(dir, name);
  writeFileSync(saved, Buffer.from(data ?? "", "base64"));
  // eslint-disable-next-line no-console -- where the reviewer finds the picture.
  console.log(`[043] ${name} -> ${saved}`);
}

/** Tidying up through the browser: a tab with a question standing holds `tabs_close` too. */
async function closeTab(worker: PackagedWorker, tabId: number): Promise<void> {
  await worker.evaluate(async (id: number) => {
    await chrome.tabs.remove(id).catch(() => undefined);
  }, tabId);
}
