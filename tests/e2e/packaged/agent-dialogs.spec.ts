import type { BrowserContext, Dialog as PlaywrightDialog, Page } from "@playwright/test";
import { lookup } from "../../../apps/extension/src/locales/catalog.js";
import { startMcpClient, type McpHarnessClient } from "../../harness/mcp-client.js";
import { pairWithFirstCall } from "../fixtures/agent-pairing.js";
import { copyFor, localeFromEnv, openSidePanel, waitForAgentPanel, type SidePanelDriver } from "../fixtures/side-panel-driver.js";
import { expect, test, type PackagedWorker } from "../fixtures/packaged-extension.js";

const locale = localeFromEnv();
const copy = copyFor(locale);
const ui = (key: string): string => lookup(key, locale);

const SITE = "https://127.0.0.1:19443";
const DIALOGS = `${SITE}/dialogs`;

/**
 * 008/T229 — US3 end to end: the page opens a dialog and the run does not stall (FR-110..FR-117).
 *
 * The unit tests pin the rules; only a real browser can settle the four things that make this
 * feature worth having. A dialog is *heard* at all (the page-events domain on the tab's own
 * attachment, D-008-5). A call made while one is open is answered at once rather than after a
 * renderer timeout - measured here, because "immediately" is a number (SC-058: under 500 ms). The
 * chained exemption is a fact about the clock on a real page, where the confirm arrives 300 ms
 * after the click that caused it rather than inside the same turn. And a "leave site?" prompt is
 * answered by policy, so the page keeps the text somebody typed into it.
 *
 * Attach mode only, exactly like every other agent journey: the bridge starts with a machine
 * install of the native-messaging host, which a browser the runner launched is not registered
 * against.
 */

type Dialog = { id: string; type: string; message: string; defaultValue?: string; tabId: number };

type Blocked = { outcome?: string; reason?: string; refusal?: { reason?: string; dialog?: Dialog; url?: string } };

test.describe("agent dialogs", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT,
    "attach mode only: the native-messaging host is a machine install, so the browser under test " +
      "must be one the runner started against the installed host (HALLPASS_CDP_ENDPOINT).",
  );

  /**
   * The three answers that never cost the owner a decision, and the block that is the whole point
   * of hearing a dialog at all (US3 scenarios 1-4, 8; FR-111, FR-112).
   */
  test("hears each dialog, blocks the tab at once, and answers alert, confirm and prompt", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(600_000);
    leaveDialogsToTheExtension(extensionContext);
    const { panel, client, call } = await pairedSession({ extensionContext, extensionId, extensionWorker });
    let live: McpHarnessClient | undefined = client;
    let openTab: number | undefined;
    try {
      const tabId = ((await call("tabs_create", { url: DIALOGS })) as { tabId: number }).tabId;
      openTab = tabId;
      await setSiteMode(panel, SITE, "skip-checks");
      await call("read_page", { tabId, filter: "interactive" });

      // ============= 1. an alert: the answer carries it, and the tab is blocked =============
      const alertRef = await refFor(call, tabId, "Show alert");
      const clicked = (await call("click", { tabId, target: { ref: alertRef } })) as { dialog?: Dialog };
      expect(clicked.dialog, "the click that raised the alert must carry it back").toMatchObject({
        type: "alert",
        message: "Saved 3 orders.",
      });

      // FR-111: any other call on that tab is answered *now*, with the dialog, not after a timeout.
      const at = Date.now();
      const blockedResult = await client.callTool("click", { tabId, target: { ref: alertRef } });
      const blockedMs = Date.now() - at;
      const blocked = blockedResult.json as Blocked;
      // eslint-disable-next-line no-console -- the measurement this gate owes the spec (SC-058).
      console.log(`[T229] blocked in ${blockedMs} ms`);
      expect(blocked.reason).toBe("blocked-by-dialog");
      expect(blocked.refusal?.dialog).toMatchObject({ type: "alert" });
      expect(blockedMs, "a blocked call must answer immediately, not after a renderer timeout").toBeLessThan(500);

      // A read is blocked too; `tabs_context` is not (FR-111's four).
      expect(((await client.callTool("get_page_text", { tabId })).json as Blocked).reason).toBe("blocked-by-dialog");
      expect((await client.callTool("tabs_context", {})).isError).toBe(false);

      // An alert has one button, so neither action ever asks the owner anything.
      const answered = (await call("dialog", { tabId, action: "dismiss" })) as { ok: boolean; type: string };
      expect(answered).toMatchObject({ ok: true, type: "alert" });
      await expect(pageAt(extensionContext, DIALOGS).locator("#result")).toHaveText("alert-closed");
      expect(await panel.panelText()).toContain("Saved 3 orders.");

      // ============= 2. a confirm, dismissed: the page sees Cancel =============
      const confirmRef = await refFor(call, tabId, "Ask to confirm");
      const confirmed = (await call("click", { tabId, target: { ref: confirmRef } })) as { dialog?: Dialog };
      expect(confirmed.dialog).toMatchObject({ type: "confirm", message: "Delete 3 orders? This cannot be undone." });
      await call("dialog", { tabId, action: "dismiss" });
      await expect(pageAt(extensionContext, DIALOGS).locator("#result")).toHaveText("confirm:false");

      // ============= 3. a prompt: the text the agent typed, not the page's default =============
      const promptRef = await refFor(call, tabId, "Ask for a name");
      const prompted = (await call("click", { tabId, target: { ref: promptRef } })) as { dialog?: Dialog };
      expect(prompted.dialog).toMatchObject({ type: "prompt", defaultValue: "hello" });
      await call("dialog", { tabId, action: "accept", promptText: "typed" });
      await expect(pageAt(extensionContext, DIALOGS).locator("#result")).toHaveText("prompt:typed");

      // FR-113: every one of them is on the card, whatever the mode decided.
      const text = await panel.panelText();
      expect(text).toContain("Delete 3 orders? This cannot be undone.");
      expect(text).toContain("What is your name?");
      // No card was ever shown in `skip-checks` (US3 scenario 7).
      expect(text).not.toContain(ui("agent.prompt.dialogAccept").replace("{agent}", "Claude Code"));

      // ============= 4. nothing open: the honest answer, not a wait =============
      expect(((await client.callTool("dialog", { tabId, action: "accept" })).json as Blocked).reason).toBe("no-dialog");

      await call("tabs_close", { tabId });
    } finally {
      // A dialog left open wedges the whole browser for the next connection, so the journey never
      // leaves one behind - whatever it failed on.
      await tidyUp(live, openTab);
      await live?.close();
      live = undefined;
    }
  });

  /**
   * The consent model (US3 scenarios 5, 6; FR-114): a dialog that followed the click the owner just
   * approved is a notice, one that arrives three seconds later is a question, and refusing it
   * dismisses the dialog rather than leaving the page stuck.
   */
  test("shows a notice for a chained accept and a card for an unchained one", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(600_000);
    leaveDialogsToTheExtension(extensionContext);
    const { panel, client, call } = await pairedSession({ extensionContext, extensionId, extensionWorker });
    let live: McpHarnessClient | undefined = client;
    let openTab: number | undefined;
    try {
      const tabId = ((await call("tabs_create", { url: DIALOGS })) as { tabId: number }).tabId;
      openTab = tabId;
      await setSiteMode(panel, SITE, "ask");
      // The read is not an effect, so it does not ask - and it gives the refs the clicks below need.
      await call("read_page", { tabId, filter: "interactive" });
      const chainedRef = await refFor(call, tabId, "Confirm shortly after the click");
      const timerRef = await refFor(call, tabId, "Confirm three seconds later");

      // ============= 5. chained: one decision, not two =============
      const clickedAt = Date.now();
      const chainedClick = client.callTool("click", { tabId, target: { ref: chainedRef } });
      await panel.waitForText(ui("agent.promptTitle"));
      await panel.clickButton(ui("agent.allowOnce"));
      expect((await chainedClick).isError).toBe(false);

      // The page opens its confirm 300 ms after the click; the block is how we know it is there.
      let dialogAt = 0;
      await expect
        .poll(
          async () => {
            const probe = (await client.callTool("get_page_text", { tabId })).json as Blocked;
            if (probe.reason === "blocked-by-dialog" && dialogAt === 0) dialogAt = Date.now();
            return probe.reason ?? "none";
          },
          { timeout: 5_000 },
        )
        .toBe("blocked-by-dialog");
      // eslint-disable-next-line no-console -- the click-to-dialog latency the probe (T237) re-measures.
      console.log(`[T229] chained confirm observed ${dialogAt - clickedAt} ms after the click`);

      const chainedAnswer = (await call("dialog", { tabId, action: "accept" })) as { ok: boolean };
      expect(chainedAnswer.ok).toBe(true);
      // The notice arrives with the next projection push, which is asynchronous to the answer: read
      // until it is there (one read raced the push in a full-suite run), and record how long it took.
      const acceptedAt = Date.now();
      await expect.poll(() => panel.panelText(), { timeout: 5_000 }).toContain(ui("agent.notice.dialogAccepted"));
      // eslint-disable-next-line no-console -- the answer-to-notice latency, watched since 016.
      console.log(`[T229] chained-accept notice on the panel ${Date.now() - acceptedAt} ms after the answer`);
      const afterChained = await panel.panelText();
      // Told, not asked (FR-114): the notice is up and no question was raised.
      expect(afterChained).toContain(ui("agent.notice.dialogAccepted"));
      expect(afterChained).toContain("Also delete the attached invoices?");
      expect(afterChained).not.toContain(ui("agent.prompt.dialogAccept").replace("{agent}", "Claude Code"));
      await expect(pageAt(extensionContext, DIALOGS).locator("#result")).toHaveText("confirm:true");

      // ============= 6. unchained: the owner is asked, with the page's words =============
      const timerClick = client.callTool("click", { tabId, target: { ref: timerRef } });
      await panel.waitForText(ui("agent.promptTitle"));
      await panel.clickButton(ui("agent.allowOnce"));
      expect((await timerClick).isError).toBe(false);
      await expect
        .poll(
          async () => ((await client.callTool("get_page_text", { tabId })).json as Blocked).reason ?? "none",
          { timeout: 10_000 },
        )
        .toBe("blocked-by-dialog");

      const asked = client.callTool("dialog", { tabId, action: "accept" });
      await panel.waitForText(ui("agent.prompt.dialogAccept").replace("{agent}", "Claude Code"));
      expect(await panel.panelText()).toContain("Your session is about to expire. Extend it?");
      await panel.clickButton(ui("agent.allowOnce"));
      expect((await asked).isError).toBe(false);
      await expect(pageAt(extensionContext, DIALOGS).locator("#result")).toHaveText("confirm:true");

      // ============= 7. refuse: the dialog is dismissed, and the agent is told =============
      const secondRound = client.callTool("click", { tabId, target: { ref: timerRef } });
      await panel.waitForText(ui("agent.promptTitle"));
      await panel.clickButton(ui("agent.allowOnce"));
      expect((await secondRound).isError).toBe(false);
      await expect
        .poll(
          async () => ((await client.callTool("get_page_text", { tabId })).json as Blocked).reason ?? "none",
          { timeout: 10_000 },
        )
        .toBe("blocked-by-dialog");
      const refusedCall = client.callTool("dialog", { tabId, action: "accept" });
      await panel.waitForText(ui("agent.prompt.dialogAccept").replace("{agent}", "Claude Code"));
      await panel.clickButton(ui("agent.refuse"));
      expect(((await refusedCall).json as Blocked).reason).toBe("refused");
      await expect(pageAt(extensionContext, DIALOGS).locator("#result")).toHaveText("confirm:false");

      await call("tabs_close", { tabId });
    } finally {
      // A dialog left open wedges the whole browser for the next connection, so the journey never
      // leaves one behind - whatever it failed on.
      await tidyUp(live, openTab);
      await live?.close();
      live = undefined;
    }
  });

  /**
   * "Leave site?" (US3 scenario 10, FR-115): the default is to stay and say so, and forcing past it
   * is a decision the owner makes about work of theirs that is about to be lost.
   */
  test("stays on a page with unsaved work, and leaves it only when the owner allows", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(600_000);
    leaveDialogsToTheExtension(extensionContext);
    const { panel, client, call } = await pairedSession({ extensionContext, extensionId, extensionWorker });
    let live: McpHarnessClient | undefined = client;
    let openTab: number | undefined;
    try {
      const tabId = ((await call("tabs_create", { url: DIALOGS })) as { tabId: number }).tabId;
      openTab = tabId;
      await setSiteMode(panel, SITE, "skip-checks");
      await call("read_page", { tabId, filter: "interactive" });
      const notes = await refFor(call, tabId, "Notes");
      // Typed, not scripted: a browser raises "leave site?" only for a page somebody interacted with.
      await call("type", { tabId, target: { ref: notes }, text: "unsaved work" });

      const at = Date.now();
      const stayed = (await client.callTool("navigate", { tabId, url: `${SITE}/ordinary` })).json as Blocked;
      const stayedMs = Date.now() - at;
      // eslint-disable-next-line no-console -- the 300 ms event-driven budget of FR-115, measured.
      console.log(`[T229] beforeunload answered in ${stayedMs} ms`);
      expect(stayed.reason).toBe("blocked-by-beforeunload");
      expect(stayed.refusal?.url).toContain("/dialogs");
      // Nothing was lost: the page is the one it was, with the text still in it.
      const current = (await call("tabs_context", {})) as Array<{ tabId: number; url: string }>;
      expect(current.find((tab) => tab.tabId === tabId)?.url).toContain("/dialogs");

      // Forced, under `skip-checks`: the owner already said this site may be acted on.
      const forced = (await call("navigate", { tabId, url: `${SITE}/ordinary`, force: true })) as { url: string };
      expect(forced.url).toContain("/ordinary");

      // And under `ask`, the same call is a question in the words of what is lost (FR-115).
      await call("navigate", { tabId, url: DIALOGS });
      await call("read_page", { tabId, filter: "interactive" });
      const notesAgain = await refFor(call, tabId, "Notes");
      await call("type", { tabId, target: { ref: notesAgain }, text: "more unsaved work" });
      await setSiteMode(panel, SITE, "ask");
      const asked = client.callTool("navigate", { tabId, url: `${SITE}/ordinary`, force: true });
      await panel.waitForText(ui("agent.prompt.beforeunloadForce").replace("{site}", SITE));
      await panel.clickButton(ui("agent.allowOnce"));
      expect((await asked).isError).toBe(false);

      await setSiteMode(panel, SITE, "skip-checks");
      await call("tabs_close", { tabId });
    } finally {
      // A dialog left open wedges the whole browser for the next connection, so the journey never
      // leaves one behind - whatever it failed on.
      await tidyUp(live, openTab);
      await live?.close();
      live = undefined;
    }
  });
  /**
   * FR-115's last sentence (T230, S4 review): a "leave site?" prompt the *owner* raised on a held
   * tab is not touched.
   *
   * The worker used to answer every `beforeunload` it heard, whoever caused it - so a person
   * pressing a link on a page an agent happens to hold had their browser's own question answered
   * for them, silently, by an extension. Nothing in the unit tests could see that: only a real
   * browser can produce a prompt the extension did not ask for. So the page takes itself away
   * through its own button, pressed by the runner rather than by any tool, and the evidence that
   * the extension kept its hands off is twofold - Playwright still holds a live, unanswered dialog,
   * and the session's card says nothing about a navigation the agent never made.
   */
  test("leaves a leave-site prompt the owner raised to the owner", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(600_000);
    leaveDialogsToTheExtension(extensionContext);
    const { panel, client, call } = await pairedSession({ extensionContext, extensionId, extensionWorker });
    let live: McpHarnessClient | undefined = client;
    let openTab: number | undefined;
    const raised: PlaywrightDialog[] = [];
    let pressing: Promise<unknown> = Promise.resolve();
    try {
      const tabId = ((await call("tabs_create", { url: DIALOGS })) as { tabId: number }).tabId;
      openTab = tabId;
      await setSiteMode(panel, SITE, "skip-checks");
      await call("read_page", { tabId, filter: "interactive" });
      // Typed by the agent, so the page has been interacted with and its `beforeunload` is armed -
      // exactly the state the journey above leaves it in before *its* navigation.
      await call("type", { tabId, target: { ref: await refFor(call, tabId, "Notes") }, text: "unsaved work" });

      const page = pageAt(extensionContext, DIALOGS);
      page.on("dialog", (dialog) => void raised.push(dialog));
      // The page's own button, pressed through the browser rather than through a tool: no
      // `navigate`, no `tabs_close`, nothing that arms the worker's policy. The click never settles
      // while its own prompt is up, so it is left running and awaited in the teardown.
      pressing = page.click("#leave").catch(() => undefined);

      await expect.poll(() => raised.length, { timeout: 15_000 }).toBe(1);
      expect(raised[0]?.type()).toBe("beforeunload");
      // Long enough that an extension that was going to answer it would have: the unit budget for
      // the armed case is 300 ms.
      await new Promise((resolve) => setTimeout(resolve, 2_000));

      // Still open, and still ours to dismiss - which is only true because nobody answered it.
      const current = (await call("tabs_context", {})) as Array<{ tabId: number; url: string }>;
      expect(current.find((tab) => tab.tabId === tabId)?.url).toContain("/dialogs");
      // And the card is silent: the agent made no navigation, so it is owed no line about one.
      expect(await panel.panelText()).not.toContain(ui("agent.activity.stayed"));

      await raised[0]?.dismiss();
      await pressing;
      await call("tabs_close", { tabId, force: true });
      openTab = undefined;
    } finally {
      // Whatever failed, the prompt does not stay up: an unanswered native dialog wedges the whole
      // browser for the next connection.
      await raised[0]?.dismiss().catch(() => undefined);
      await pressing.catch(() => undefined);
      await tidyUp(live, openTab);
      await live?.close();
      live = undefined;
    }
  });
});

/**
 * Answers anything still on the page and closes the tab, whatever the journey ended on.
 *
 * A native dialog nobody answers is not this test's problem alone: it stops the renderer, and the
 * next `connectOverCDP` sits there until it times out. So the last thing every test does is offer
 * the page a Cancel, and the first failure of a run stays the only failure of a run.
 */
async function tidyUp(client: McpHarnessClient | undefined, tabId: number | undefined): Promise<void> {
  if (!client || tabId === undefined) return;
  await client.callTool("dialog", { tabId, action: "dismiss" }).catch(() => undefined);
  await client.callTool("tabs_close", { tabId, force: true }).catch(() => undefined);
}

/**
 * Leaves the page's dialogs open for the extension to answer.
 *
 * Playwright dismisses every native dialog by itself on a page it controls, *unless* that page has
 * a `dialog` listener - and then it leaves it to the listener. Without this the runner would answer
 * every confirm milliseconds before the worker's own debugger heard it, and this whole journey
 * would be measuring Playwright rather than the extension. The listener deliberately does nothing:
 * answering it is what the `dialog` tool is for. A dialog the extension has already handled makes
 * Playwright's own `Dialog` stale, which is why nothing here ever touches it.
 */
function leaveDialogsToTheExtension(context: BrowserContext): void {
  const arm = (page: Page): void => {
    page.on("dialog", () => undefined);
  };
  for (const page of context.pages()) arm(page);
  context.on("page", arm);
}

/** The owner's own page for a url the journey opened, so the fixture's `#result` can be read. */
function pageAt(context: BrowserContext, url: string): Page {
  const page = context.pages().find((candidate) => candidate.url().startsWith(url));
  if (!page) throw new Error(`no page at ${url}`);
  return page;
}

async function pairedSession(fixtures: {
  extensionContext: BrowserContext;
  extensionId: string;
  extensionWorker: PackagedWorker;
}): Promise<{
  panel: SidePanelDriver;
  client: McpHarnessClient;
  call: (tool: string, args?: Record<string, unknown>) => Promise<unknown>;
}> {
  const { extensionContext, extensionId, extensionWorker } = fixtures;
  const tools = await extensionWorker.evaluate(() => chrome.runtime.getManifest().permissions ?? []);
  expect(
    tools,
    "the attached browser must have apps/extension/dist/agent loaded (npm run build:extension:agent)",
  ).toContain("debugger");

  const ownerPage = extensionContext.pages()[0] ?? (await extensionContext.newPage());
  await ownerPage.goto(`${SITE}/ordinary`);
  await ownerPage.bringToFront();
  const ownerTabId = await extensionWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) throw new Error("active-tab-missing");
    return tab.id;
  });

  const panel = await openSidePanel({ context: extensionContext, extensionId, fixturePage: ownerPage, tabId: ownerTabId, copy });
  await waitForAgentPanel(panel);

  const client = await startMcpClient({ clientName: "Claude Code" });
  await panel.clickIfPresent(ui("agent.retry"));
  await pairWithFirstCall(client, panel, { locale });

  const call = async (tool: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const result = await client.callTool(tool, args);
    expect(result.isError, `${tool} failed: ${result.text}\nmcp-server stderr:\n${client.stderr()}`).toBe(false);
    return result.json;
  };
  return { panel, client, call };
}

async function refFor(
  call: (tool: string, args: Record<string, unknown>) => Promise<unknown>,
  tabId: number,
  query: string,
): Promise<string> {
  const found = (await call("find", { tabId, query })) as { outcome: string; matches: Array<{ ref: string }> };
  expect(found.outcome, `find '${query}' answered ${found.outcome}`).toBe("resolved");
  const first = found.matches[0]?.ref;
  expect(first, `find '${query}' returned no ref`).toBeTruthy();
  return first as string;
}

/** The same panel-driven site mode the sibling journeys use; never a storage write (FR-042). */
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
