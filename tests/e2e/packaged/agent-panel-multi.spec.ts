import type { BrowserContext, Page } from "@playwright/test";
import { lookup } from "../../../apps/extension/src/locales/catalog.js";
import { startMcpClient, type McpHarnessClient } from "../../harness/mcp-client.js";
import { pairWithFirstCall } from "../fixtures/agent-pairing.js";
import { copyFor, localeFromEnv, openSidePanel, waitForAgentPanel } from "../fixtures/side-panel-driver.js";
import { expect, test } from "../fixtures/packaged-extension.js";

const locale = localeFromEnv();
const copy = copyFor(locale);
const ui = (key: string): string => lookup(key, locale);

const SITE = "https://127.0.0.1:19443";

/**
 * 2026-09-16 "blind panel" — two side-panel documents connected to one worker, both alive.
 *
 * Chrome shows one side panel per window, so an owner with two windows has two panel documents;
 * a tab-scoped panel can keep its own document beside the window's as well. The worker used to
 * keep only the most recently connected one, and the other kept a live port that was never written
 * to again: its cards froze, the consent card never appeared, and the agent's call timed out with
 * `no-answer` while the owner looked at a panel with nothing to answer - three times on 2026-09-16,
 * each "fixed" by closing and reopening the panel (which made it the newest again).
 *
 * The claim: every connected panel gets every projection, and the owner can answer from any of
 * them. The older panel is the one under test throughout, because it is the one that went blind.
 */
test.describe("agent panel: two panel documents at once", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT,
    "attach mode only: the native-messaging host is a machine install, so the browser under test " +
      "must be one the runner started and pointed at the installed host (HALLPASS_CDP_ENDPOINT).",
  );

  test("the older panel keeps receiving projections and the consent card, and its answer counts", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(300_000);

    const ownerPage = extensionContext.pages()[0] ?? (await extensionContext.newPage());
    await ownerPage.goto(`${SITE}/waiting`);
    await ownerPage.bringToFront();
    const ownerTabId = await extensionWorker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined) throw new Error("active-tab-missing");
      return tab.id;
    });

    // Panel A: the first (older) document, in the first window.
    const panelA = await openSidePanel({ context: extensionContext, extensionId, fixturePage: ownerPage, tabId: ownerTabId, copy });
    await waitForAgentPanel(panelA);
    // Every panel target that exists now - A's included - is not the one the second window opens.
    const before = await panelTargetIds(extensionContext, ownerPage, extensionId);
    expect(before.size, "panel A's own target is on record").toBeGreaterThanOrEqual(1);

    let alpha: McpHarnessClient | undefined;
    let secondWindowId: number | undefined;
    try {
      alpha = await startMcpClient({ clientName: "Claude Code" });
      await panelA.clickIfPresent(ui("agent.retry"));
      await pairWithFirstCall(alpha, panelA, { locale, timeoutMs: 45_000 });
      const a = alpha;
      const callOn = async (tool: string, args: Record<string, unknown> = {}): Promise<unknown> => {
        const result = await a.callTool(tool, args);
        expect(result.isError, `${tool} failed: ${result.text}\nstderr:\n${a.stderr()}`).toBe(false);
        return result.json;
      };

      // Panel B: a second window with its own panel document - the newer connection.
      secondWindowId = await extensionWorker.evaluate(async (url: string) => {
        const created = await chrome.windows.create({ url, focused: false, width: 900, height: 700 });
        if (created?.id === undefined) throw new Error("window-not-created");
        return created.id;
      }, `${SITE}/ordinary`);
      const panelB = await openPanelInWindow(extensionContext, ownerPage, extensionId, secondWindowId, before);
      await waitForAgentPanel(panelB);
      await panelB.waitForText(ui("agent.status.connected"));

      // A session's tab appears on BOTH panels - the older one included.
      const tabA = ((await callOn("tabs_create", { url: `${SITE}/ordinary` })) as { tabId: number }).tabId;
      const siteLine = ui("agent.session.holdsOne").replace("{sites}", "127.0.0.1");
      await panelB.waitForText(siteLine);
      await panelA.waitForText(siteLine, 15_000);

      // An effect on an undecided site asks the owner - on BOTH panels - and the older one answers.
      const ref = await refFor(callOn, tabA, "Safe action");
      const asked = a.callTool("click", { tabId: tabA, target: { ref } });
      await panelB.waitForText(ui("agent.promptTitle"));
      await panelA.waitForText(ui("agent.promptTitle"), 15_000);
      await panelA.clickButton(ui("agent.allowOnce"));
      const allowed = await asked;
      expect(allowed.isError, `text: ${allowed.text}\nstderr:\n${a.stderr()}`).toBe(false);
      // Answered once, for both: the card is gone from the newer panel too.
      await expect.poll(() => panelB.panelText().then((text) => text.includes(ui("agent.promptTitle"))), { timeout: 15_000 }).toBe(false);

      // The newer panel goes away; the older one is still the owner's panel.
      await panelB.close();
      const refAgain = await refFor(callOn, tabA, "Safe action");
      const askedAgain = a.callTool("click", { tabId: tabA, target: { ref: refAgain } });
      await panelA.waitForText(ui("agent.promptTitle"), 15_000);
      await panelA.clickButton(ui("agent.allowOnce"));
      const allowedAgain = await askedAgain;
      expect(allowedAgain.isError, `text: ${allowedAgain.text}\nstderr:\n${a.stderr()}`).toBe(false);

      await extensionWorker.evaluate(async (id: number) => {
        await chrome.tabs.remove([id]);
      }, tabA);
    } finally {
      if (secondWindowId !== undefined) {
        await extensionWorker.evaluate(async (id: number) => {
          try {
            await chrome.windows.remove(id);
          } catch {
            /* already gone */
          }
        }, secondWindowId);
      }
      await alpha?.close();
    }
  });
});

/**
 * The three overnight fixes of 2026-09-16, each proven where its failure would show: on the real
 * extension, driven by the real `mcp-server.js`.
 */
test.describe("overnight fixes of 2026-09-16, live", () => {
  test.skip(!process.env.HALLPASS_CDP_ENDPOINT, "attach mode only (see above)");

  test("resize_window honours the size on a maximized window; the cursor stays between gestures and leaves with the lease; the panel survives a worker restart", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(300_000);

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

    let alpha: McpHarnessClient | undefined;
    try {
      alpha = await startMcpClient({ clientName: "Claude Code" });
      await panel.clickIfPresent(ui("agent.retry"));
      await pairWithFirstCall(alpha, panel, { locale, timeoutMs: 45_000 });
      const a = alpha;
      const callOn = async (tool: string, args: Record<string, unknown> = {}): Promise<unknown> => {
        const result = await a.callTool(tool, args);
        expect(result.isError, `${tool} failed: ${result.text}\nstderr:\n${a.stderr()}`).toBe(false);
        return result.json;
      };
      const tabA = ((await callOn("tabs_create", { url: `${SITE}/ordinary` })) as { tabId: number }).tabId;

      // ---- the page-edge glow while the tab is held (owner's choice, 2026-09-16 morning) ----
      const readGlow = () =>
        extensionWorker.evaluate(async (id: number) => {
          const [result] = await chrome.scripting.executeScript({
            target: { tabId: id },
            func: () => {
              const glow = document.querySelector<HTMLElement>("[data-hallpass-glow]");
              const pill = document.querySelector<HTMLElement>("[data-hallpass-pill]");
              return { glow: glow ? { shadow: glow.style.boxShadow, pointer: glow.style.pointerEvents, fixed: glow.style.position } : null, pill: pill !== null };
            },
          });
          return result?.result as { glow: { shadow: string; pointer: string; fixed: string } | null; pill: boolean };
        }, tabA);
      await expect.poll(() => readGlow().then((r) => r.pill), { timeout: 10_000 }).toBe(true);
      const lit = await readGlow();
      expect(lit.glow, "the glow is on the held page").not.toBeNull();
      expect(lit.glow?.shadow).toContain("inset");
      expect(lit.glow?.pointer).toBe("none");
      expect(lit.glow?.fixed).toBe("fixed");
      // What the owner sees, kept with the run: the held page with its pill and glow.
      const heldPage = extensionContext.pages().find((page) => page.url().startsWith(`${SITE}/ordinary`));
      if (heldPage) {
        await heldPage.bringToFront();
        await heldPage.waitForTimeout(300);
        const shot = test.info().outputPath("held-page-glow.png");
        await heldPage.screenshot({ path: shot });
        await test.info().attach("held-page-glow", { path: shot, contentType: "image/png" });
      }

      // ---- resize_window on a maximized window (5a8e264) ----
      const windowId = await extensionWorker.evaluate(async (id: number) => {
        const tab = await chrome.tabs.get(id);
        await chrome.windows.update(tab.windowId, { state: "maximized" });
        return tab.windowId;
      }, tabA);
      await expect.poll(() => extensionWorker.evaluate(async (id: number) => (await chrome.windows.get(id)).state, windowId), { timeout: 10_000 }).toBe("maximized");
      const resized = (await callOn("resize_window", { tabId: tabA, width: 1000, height: 700 })) as { width: number; height: number };
      expect(resized.width).toBeGreaterThanOrEqual(980);
      expect(resized.width).toBeLessThanOrEqual(1020);
      expect(resized.height).toBeGreaterThanOrEqual(680);
      expect(resized.height).toBeLessThanOrEqual(720);
      expect(await extensionWorker.evaluate(async (id: number) => (await chrome.windows.get(id)).state, windowId)).toBe("normal");

      // ---- the phantom cursor persists between gestures and leaves with the lease (fe904ea) ----
      await setSiteModeViaPanel(panel, SITE, "skip-checks");
      const ref = await refFor(callOn, tabA, "Safe action");
      await callOn("click", { tabId: tabA, target: { ref } });
      const cursorAfterClick = await extensionWorker.evaluate(async (id: number) => {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId: id },
          func: () => {
            const mark = document.querySelector<HTMLElement>("[data-hallpass-cursor]");
            return mark
              ? { present: true, transition: mark.style.transition, transform: mark.style.transform, svg: mark.querySelector("svg") !== null }
              : { present: false };
          },
        });
        return result?.result as { present: boolean; transition?: string; transform?: string; svg?: boolean };
      }, tabA);
      expect(cursorAfterClick.present, "the cursor stays on the page after the gesture").toBe(true);
      expect(cursorAfterClick.transition).toContain("transform");
      expect(cursorAfterClick.transform).toMatch(/translate3d\(/);
      expect(cursorAfterClick.svg).toBe(true);
      await callOn("tabs_release", { tabId: tabA });
      await expect
        .poll(
          () =>
            extensionWorker.evaluate(async (id: number) => {
              const [result] = await chrome.scripting.executeScript({
                target: { tabId: id },
                func: () => document.querySelector("[data-hallpass-cursor]") !== null,
              });
              return result?.result;
            }, tabA),
          { timeout: 10_000 },
        )
        .toBe(false);
      // The glow and the pill leave with the lease, like the pointer.
      await expect.poll(() => readGlow().then((r) => r.glow === null && !r.pill), { timeout: 10_000 }).toBe(true);

      // ---- the panel survives a worker restart (1b4837f / 11557eb) ----
      const cdp = await extensionContext.newCDPSession(ownerPage);
      const targets = await cdp.send("Target.getTargets");
      const worker = targets.targetInfos.find((target) => target.type === "service_worker" && target.url.startsWith(`chrome-extension://${extensionId}/`));
      expect(worker, "worker target").toBeTruthy();
      await cdp.send("Target.closeTarget", { targetId: worker!.targetId });
      await cdp.detach();
      // The bridge re-links first (the fresh worker dials the host again and the relay re-acks it);
      // until it has, a call answers `call-unconfirmed`, which is the relay's honesty, not the
      // panel's. The panel claim starts once a read goes through.
      // (A `tabs_context` that reaches the relay while it is unconfirmed can itself wait out the
      // call bound, so the budget holds several such attempts.)
      await expect
        .poll(async () => (await a.callTool("tabs_context")).isError, { timeout: 120_000, intervals: [1_000] })
        .toBe(false);
      // The panel reconnects on its own; the fresh worker publishes the whole picture on accept,
      // and a new session tab shows up on the very same panel document, never reopened.
      const tabB = ((await callOn("tabs_create", { url: `${SITE}/form` })) as { tabId: number }).tabId;
      await panel.waitForText(ui("agent.session.holdsOne").replace("{sites}", "127.0.0.1"), 30_000);
      // Through the agent, not the worker handle: that handle was bound to the worker just killed.
      await callOn("tabs_close", { tabId: tabB });
      await callOn("tabs_claim", { tabId: tabA });
      await callOn("tabs_close", { tabId: tabA });
    } finally {
      await alpha?.close();
    }
  });
});

/** The panel's own mode control for one site (the helper `agent-panel-states.spec.ts` carries). */
async function setSiteModeViaPanel(panel: { waitForText(t: string): Promise<void>; evaluatePanel(e: string, g?: boolean): Promise<unknown> }, site: string, mode: string): Promise<void> {
  await panel.waitForText(site);
  const set = await panel.evaluatePanel(
    `(()=>{const sel=document.querySelector('[data-site=${JSON.stringify(site)}] select');` +
      `if(!sel)return false;const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;` +
      `setter.call(sel,${JSON.stringify(mode)});sel.dispatchEvent(new Event('change',{bubbles:true}));return true})()`,
    true,
  );
  expect(set, `the panel offers no mode control for ${site}`).toBe(true);
  await expect
    .poll(() => panel.evaluatePanel(`document.querySelector('[data-site=${JSON.stringify(site)}] select')?.value ?? null`), { timeout: 15_000 })
    .toBe(mode);
}

type PanelHandle = {
  evaluatePanel(expression: string, userGesture?: boolean): Promise<unknown>;
  panelText(): Promise<string>;
  waitForText(expected: string, timeoutMs?: number): Promise<void>;
  clickButton(label: string): Promise<void>;
  close(): Promise<void>;
};

async function panelTargetIds(context: BrowserContext, page: Page, extensionId: string): Promise<Set<string>> {
  const cdp = await context.newCDPSession(page);
  const targets = await cdp.send("Target.getTargets");
  await cdp.detach();
  return new Set(
    targets.targetInfos
      .filter((target) => target.url === `chrome-extension://${extensionId}/side-panel.html`)
      .map((target) => target.targetId),
  );
}

/**
 * Opens the side panel in another window and attaches to *that* document: the one panel target
 * that was not there before. The launcher-page trick is the driver's own (a user gesture is needed
 * for `sidePanel.open`), repeated here because the driver always attaches to the first target.
 */
async function openPanelInWindow(
  context: BrowserContext,
  controlPage: Page,
  extensionId: string,
  windowId: number,
  known: Set<string>,
): Promise<PanelHandle> {
  const launcher = await context.newPage();
  await launcher.goto(`chrome-extension://${extensionId}/side-panel.html?launcher=1`);
  const launcherCdp = await context.newCDPSession(launcher);
  const evaluation = await launcherCdp.send("Runtime.evaluate", {
    expression: `chrome.sidePanel.open({windowId:${windowId}})`,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  expect(evaluation.exceptionDetails).toBeUndefined();
  // The new document is the one panel target that was not there before; polled, because how
  // long Chrome takes to create it is the machine's business.
  let fresh: { targetId: string } | undefined;
  let seen: unknown = [];
  const deadline = Date.now() + 15_000;
  while (!fresh && Date.now() < deadline) {
    const after = await launcherCdp.send("Target.getTargets");
    seen = after.targetInfos.filter((t) => t.url.startsWith("chrome-extension://"));
    fresh = after.targetInfos.find(
      (target) => target.url === `chrome-extension://${extensionId}/side-panel.html` && !known.has(target.targetId),
    );
    if (!fresh) await controlPage.waitForTimeout(200);
  }
  expect(fresh, JSON.stringify(seen, null, 2)).toBeTruthy();
  if (!fresh) throw new Error("second-panel-target-missing");
  await launcher.close();

  const controlCdp = await context.newCDPSession(controlPage);
  const attached = await controlCdp.send("Target.attachToTarget", { targetId: fresh.targetId, flatten: false });
  let commandId = 0;
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  controlCdp.on("Target.receivedMessageFromTarget", (event) => {
    if (event.sessionId !== attached.sessionId) return;
    const message = JSON.parse(event.message) as { id?: number } & Record<string, unknown>;
    if (message.id === undefined) return;
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  const sendToPanel = async (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const id = ++commandId;
    const response = new Promise<Record<string, unknown>>((resolve) => pending.set(id, resolve));
    await controlCdp.send("Target.sendMessageToTarget", { sessionId: attached.sessionId, message: JSON.stringify({ id, method, params }) });
    return Promise.race([
      response,
      new Promise<Record<string, unknown>>((_, reject) => setTimeout(() => reject(new Error("second-panel-evaluation-timeout")), 20_000)),
    ]);
  };
  const evaluatePanel = async (expression: string, userGesture = false): Promise<unknown> => {
    const message = await sendToPanel("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture });
    const result = message.result as { result?: { value?: unknown }; exceptionDetails?: unknown } | undefined;
    if (message.error || result?.exceptionDetails) throw new Error("second-panel-evaluation-failed");
    return result?.result?.value;
  };
  const panelText = async (): Promise<string> => {
    const text = await evaluatePanel("document.body.innerText");
    return typeof text === "string" ? text : "";
  };
  const waitForText = async (expected: string, timeoutMs = 30_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    let last = "";
    while (Date.now() < deadline) {
      last = await panelText();
      if (last.includes(expected)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("second-panel-text-timeout:" + expected + ":" + last);
  };
  const clickButton = async (label: string): Promise<void> => {
    const clicked = await evaluatePanel(
      `(()=>{const b=[...document.querySelectorAll('button')].find((x)=>x.textContent?.trim()===${JSON.stringify(label)});if(!b)return false;b.click();return true})()`,
      true,
    );
    expect(clicked).toBe(true);
  };
  const close = async (): Promise<void> => {
    await controlCdp.send("Target.closeTarget", { targetId: fresh.targetId });
    await controlCdp.detach();
  };
  return { evaluatePanel, panelText, waitForText, clickButton, close };
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
