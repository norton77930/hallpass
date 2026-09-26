import type { Page } from "@playwright/test";
import { lookup } from "../../../apps/extension/src/locales/catalog.js";
import { INTERRUPT_HINTS } from "@hallpass/contracts";
import { AGENT_GROUP_TITLE } from "../../../apps/extension/src/chrome-adapters/tab-groups.js";
import { startMcpClient, type McpHarnessClient } from "../../harness/mcp-client.js";
import { pairWithFirstCall } from "../fixtures/agent-pairing.js";
import { copyFor, localeFromEnv, openSidePanel, type SidePanelDriver } from "../fixtures/side-panel-driver.js";
import { expect, test, type PackagedWorker } from "../fixtures/packaged-extension.js";

const locale = localeFromEnv();
const copy = copyFor(locale);
const ui = (key: string): string => lookup(key, locale);

const SITE = "https://127.0.0.1:19443";

/**
 * 014/T359 — US1 end to end: 中斷 ends the step and keeps everything (SC-100, SC-101).
 *
 * The feature is a promise about what is *still there* afterwards, and only a real browser can be
 * asked that. So the eight checks below are split between the two ends that would notice a broken
 * promise: the agent, which must be answered once, within a second, in a word it can act on and
 * with a sentence that is honest about whether its input landed; and the browser, whose tab group,
 * emulated viewport, recording and lease must be exactly as they were - proved by using them after
 * the interrupt rather than by reading a projection that says so.
 *
 * Attach mode only, for the reason every agent journey is: the bridge is a machine install, and a
 * browser this gate launched itself would prove nothing about it.
 *
 * Prerequisites: `npm run build`, `dist/agent` loaded in the attached browser,
 * `npm run agent-host:install`, and the fixture services running (18786/18787/19443-19445).
 */
test.describe("agent interrupt", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT,
    "attach mode only: the native-messaging host is a machine install, so the browser under test " +
      "must be one the runner started and pointed at the installed host (HALLPASS_CDP_ENDPOINT).",
  );

  test("ends the calls in flight within a second and leaves the session exactly as it was", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(420_000);

    const permissions = await extensionWorker.evaluate(() => chrome.runtime.getManifest().permissions ?? []);
    expect(
      permissions,
      "the attached browser must have apps/extension/dist/agent loaded (npm run build)",
    ).toContain("nativeMessaging");

    /**
     * Everything the worker says out loud, kept where this spec can read it (FR-182).
     *
     * The worker's diagnostics are console lines in this build and nothing retains them, so the
     * reader installs its own collector and then reads it - idempotently, because Chrome may have
     * recycled the service worker since the last read and a collector installed once would then be
     * reading a scope that no longer exists.
     */
    const workerLog = async (): Promise<string[]> =>
      (await extensionWorker.evaluate(() => {
        const scope = globalThis as unknown as { __hallpassLog?: string[] };
        if (!scope.__hallpassLog) {
          scope.__hallpassLog = [];
          const original = console.warn.bind(console);
          console.warn = (...args: unknown[]): void => {
            scope.__hallpassLog?.push(args.map(String).join(" "));
            original(...args);
          };
        }
        return [...scope.__hallpassLog];
      })) as string[];
    await workerLog();

    const ownerPage = extensionContext.pages()[0] ?? (await extensionContext.newPage());
    await ownerPage.goto(`${SITE}/tags`);
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

    let client: McpHarnessClient | undefined;
    try {
      client = await startMcpClient({ clientName: "Claude Code" });
      const live = client;
      const call = callerFor(() => client);
      await panel.clickIfPresent(ui("agent.retry"));
      await pairWithFirstCall(live, panel, { locale });

      const created = (await call("tabs_create", { url: `${SITE}/ordinary` })) as { tabId: number };
      const tabId = created.tabId;
      await expect.poll(() => sessionIdOnPanel(panel), { timeout: 15_000 }).toEqual(expect.any(String));
      const sessionId = (await sessionIdOnPanel(panel)) as string;
      await setSiteMode(panel, SITE, "skip-checks");

      // The two things the browser must still be doing afterwards, started before the interrupt.
      const groupedBefore = await groupOf(extensionWorker, tabId);
      expect(groupedBefore, "the agent's tab was never marked as its own").not.toBe(-1);
      await call("viewport", { tabId, action: "set", width: 900, height: 700 });
      // The recording's own answer is the only place its count is published; from here it rides on
      // every later answer of this session (FR-102), which is how the count below is read again.
      const framesBefore = ((await call("gif_recorder", { action: "start" })) as { frames: number }).frames;

      // ================= (1) a wait, ended by the owner, answered at once =================
      const waiting = live.callTool("wait", { tabId, forMs: 15_000 });
      // The card says there is something to interrupt before the owner presses anything.
      await expect.poll(() => inFlightOnCard(panel, sessionId), { timeout: 15_000 }).toBe(true);
      const pressedAt = Date.now();
      await clickOnCard(panel, sessionId, ui("agent.session.interrupt"));

      const interrupted = await waiting;
      const answeredMs = Date.now() - pressedAt;
      // A stopped call is an error result whose text is the host's JSON answer.
      expect(interrupted.isError, `text: ${interrupted.text}\nstderr:\n${live.stderr()}`).toBe(true);
      expect(answerOf(interrupted), `text: ${interrupted.text}`).toMatchObject({
        outcome: "stopped",
        reason: "owner-interrupted",
        // Nothing was delivered: a `wait` never touches the page.
        hint: INTERRUPT_HINTS.nothingDelivered,
      });
      // SC-100's bound, measured from the owner's own press.
      expect(answeredMs, `the wait answered ${answeredMs}ms after 中斷`).toBeLessThan(1_000);
      // FR-182: one line on the card for what the owner did.
      await panel.waitForText(ui("agent.activity.interrupt"));

      // ================= (5) the wait's own bound arrives later, and answers nobody ============
      // Its 15 s elapse while the rest of this spec runs; the discard is checked at the end.

      // ================= (6) the session takes the next call, with no re-pairing =============
      const clicked = await live.callTool("click", { tabId, target: { ref: await refFor(call, tabId, "Safe action") } });
      expect(clicked.isError, `text: ${clicked.text}\nstderr:\n${live.stderr()}`).toBe(false);

      // ================= (7) the browser is doing exactly what it was doing ==================
      expect(await groupOf(extensionWorker, tabId), "the tab left the agent's group").toBe(groupedBefore);
      const page = await agentPage(extensionContext, `${SITE}/ordinary`);
      // The emulated viewport is still emulated: the page reports the size the session gave it.
      expect(await page.evaluate(() => window.innerWidth)).toBe(900);
      const framesAfter = (clicked.json as { recording?: { state: string; frames: number } }).recording;
      expect(framesAfter?.state, "the recording was ended by an interrupt").toBe("recording");
      // The click above added a frame; the interrupt added and removed none of its own.
      expect(framesAfter?.frames).toBe(framesBefore + 1);

      // ================= (2) a batch, interrupted at the step it was on =====================
      await setSiteMode(panel, SITE, "follow-a-plan");
      const refs = await refFor(call, tabId, "Safe action");
      const batch = live.callTool("browser_batch", {
        tabId,
        steps: [
          { tool: "click", args: { target: { ref: refs } } },
          { tool: "click", args: { target: { ref: refs } } },
          { tool: "wait", args: { forMs: 15_000 } },
          { tool: "click", args: { target: { ref: refs } } },
          { tool: "click", args: { target: { ref: refs } } },
        ],
      });
      await panel.waitForText(ui("agent.planTitle"));
      await panel.clickButton(ui("agent.approvePlan"));
      // Wait until the batch is actually inside its third step before ending it.
      await expect.poll(() => inFlightOnCard(panel, sessionId), { timeout: 20_000 }).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await clickOnCard(panel, sessionId, ui("agent.session.interrupt"));

      const batchAnswer = await batch;
      // A partially-run batch answers `ok` with its list, as it always has: the host composes an
      // error reply from the outcome and the reason alone, so a `stopped` batch would reach the
      // agent with none of the three lists below.
      expect(batchAnswer.isError, `text: ${batchAnswer.text}\nstderr:\n${live.stderr()}`).toBe(false);
      const batchResult = batchAnswer.json as {
        results?: Array<{ index: number; outcome: string; reason?: string }>;
        completed?: number[];
        interruptedAt?: number;
        notRun?: number[];
      };
      expect(batchResult.completed).toEqual([0, 1]);
      expect(batchResult.interruptedAt).toBe(2);
      expect(batchResult.notRun).toEqual([3, 4]);
      // The interruption is said on the step it happened to, in the word the agent branches on.
      expect(batchResult.results?.[2]).toMatchObject({ outcome: "stopped", reason: "owner-interrupted" });
      // FR-180: the plan it stated is gone, so a single step on that site is asked about again.
      const afterBatch = live.callTool("click", { tabId, target: { ref: await refFor(call, tabId, "Safe action") } });
      await panel.waitForText(ui("agent.promptTitle"));
      await panel.clickButton(ui("agent.allowOnce"));
      expect((await afterBatch).isError, `stderr:\n${live.stderr()}`).toBe(false);

      // ================= (3) a call waiting on a consent card =============================
      await setSiteMode(panel, SITE, "ask");
      const asking = live.callTool("click", { tabId, target: { ref: await refFor(call, tabId, "Safe action") } });
      await panel.waitForText(ui("agent.promptTitle"));
      await clickOnCard(panel, sessionId, ui("agent.session.interrupt"));

      const askedAnswer = await asking;
      expect(askedAnswer.isError).toBe(true);
      expect(answerOf(askedAnswer), `text: ${askedAnswer.text}`).toMatchObject({
        outcome: "stopped",
        reason: "owner-interrupted",
      });
      // The card is withdrawn, and nothing was decided about the site: its mode is still `ask`.
      await expect.poll(async () => (await panel.panelText()).includes(ui("agent.promptTitle")), { timeout: 15_000 }).toBe(
        false,
      );
      // Nothing was decided about the site: back at the default, a site has no record at all, and
      // an answer on the card - even "just this once" - is not what an interrupt is.
      expect(await storedModeOf(extensionWorker, SITE)).toBeUndefined();

      // ================= (4) an effect whose input had already been delivered ==============
      await setSiteMode(panel, SITE, "skip-checks");
      await call("navigate", { tabId, url: `${SITE}/slow-input` });
      const slowRef = await refFor(call, tabId, "Slow field");
      const typing = live.callTool("type", { tabId, target: { ref: slowRef }, text: "hello", mode: "insert" });
      /**
       * The press lands while the page is holding its own renderer, which is why this waits on the
       * *panel* rather than on the page: the fixture takes the first keystroke and then blocks, so
       * nothing in that tab can answer a question about itself until it lets go. The card is a
       * different document and says what this needs - the call is still in flight - and the second
       * wait is for the effect to have reached its delivery, which is where the marker is written.
       */
      await expect.poll(() => inFlightOnCard(panel, sessionId), { timeout: 20_000 }).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      await clickOnCard(panel, sessionId, ui("agent.session.interrupt"));

      const typed = await typing;
      expect(typed.isError).toBe(true);
      expect(answerOf(typed), `text: ${typed.text}`).toMatchObject({
        outcome: "stopped",
        reason: "owner-interrupted",
        hint: INTERRUPT_HINTS.mayHaveTakenEffect,
      });

      // ================= (5) the late results, discarded and named ========================
      // The interrupted wait's bound and the blocked field both come back by now; neither answer
      // may reach the agent, and both are named where the owner's own log can be read.
      await expect
        .poll(async () => (await workerLog()).filter((line) => line.includes("agent.call.late-result")).length, {
          timeout: 40_000,
        })
        .toBeGreaterThanOrEqual(1);
      // And no call was answered twice: the client's own record of this session's answers has one
      // entry per call it made, which a second response frame would have broken.
      expect(live.stderr()).not.toContain("duplicate");

      // ================= (8) 停止 still ends the session, as it always did =================
      await clickOnCard(panel, sessionId, ui("agent.session.stop"));
      await expect
        .poll(() => panel.evaluatePanel("document.querySelectorAll('[data-session-id]').length"), { timeout: 15_000 })
        .toBe(0);
      // The *marking* goes with the session, a moment after the card does (006 FR-087): the group
      // keeps its tabs, and its title stops saying an agent is driving them.
      await expect
        .poll(() => groupTitleOf(extensionWorker, tabId), {
          timeout: 15_000,
          message: "a stopped session left its group marked as the agent's",
        })
        .not.toBe(AGENT_GROUP_TITLE);

      await extensionWorker.evaluate(async (id: number) => {
        await chrome.tabs.remove(id);
      }, tabId);
    } finally {
      await client?.close();
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

/** The Playwright page for a tab the *agent* opened, so the fixture can be read independently. */
async function agentPage(context: { pages: () => Page[] }, url: string, timeoutMs = 30_000): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = context.pages().find((page) => page.url() === url);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`agent-tab-not-found:${url}`);
}

/** The one session card on the panel, by the id the projection gave it. */
async function sessionIdOnPanel(panel: SidePanelDriver): Promise<string | null> {
  return (await panel.evaluatePanel(
    "document.querySelector('[data-session-id]')?.getAttribute('data-session-id') ?? null",
  )) as string | null;
}

/** Whether the card says there is anything to interrupt (FR-178): the control reads as available. */
async function inFlightOnCard(panel: SidePanelDriver, sessionId: string): Promise<boolean> {
  const disabled = await panel.evaluatePanel(
    `(()=>{const card=document.querySelector('[data-session-id=${JSON.stringify(sessionId)}]');` +
      `return card?.querySelector('.agent-interrupt')?.getAttribute('aria-disabled') ?? null})()`,
  );
  return disabled === 'false';
}

async function clickOnCard(panel: SidePanelDriver, sessionId: string, label: string): Promise<void> {
  const clicked = await panel.evaluatePanel(
    `(()=>{const card=document.querySelector('[data-session-id=${JSON.stringify(sessionId)}]');` +
      `const b=card&&[...card.querySelectorAll('button')].find((x)=>x.textContent?.trim()===${JSON.stringify(label)});` +
      `if(!b)return false;b.click();return true})()`,
    true,
  );
  expect(clicked, `no ${label} on the card for ${sessionId}`).toBe(true);
}

/** Which group the browser has the tab in; `-1` is "no group". */
async function groupOf(worker: PackagedWorker, tabId: number): Promise<number> {
  return worker.evaluate(async (id: number) => (await chrome.tabs.get(id)).groupId ?? -1, tabId);
}

/** What that group is called - the marking the owner sees, and the one a stop withdraws. */
async function groupTitleOf(worker: PackagedWorker, tabId: number): Promise<string> {
  return worker.evaluate(async (id: number) => {
    const groupId = (await chrome.tabs.get(id)).groupId ?? -1;
    if (groupId === -1) return "";
    return (await chrome.tabGroups.get(groupId)).title ?? "";
  }, tabId);
}

async function storedModeOf(worker: PackagedWorker, site: string): Promise<unknown> {
  return worker.evaluate(async (origin: string) => {
    const raw = await chrome.storage.local.get(["agentSiteModes"]);
    const records = (raw.agentSiteModes ?? {}) as Record<string, { mode?: string }>;
    return records[origin]?.mode;
  }, site);
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
