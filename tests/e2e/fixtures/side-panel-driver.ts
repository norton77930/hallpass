import { expect, type BrowserContext, type Page } from "@playwright/test";
import { lookup, type AppLocale } from "../../../apps/extension/src/locales/catalog.js";

/**
 * The real packaged side-panel driver. It attaches to the actual
 * `chrome-extension://<id>/side-panel.html` target through CDP and only ever touches rendered
 * DOM: no private module, domain function, or worker internal is imported here, so every journey
 * built on it remains observable packaged-extension evidence.
 */
export type SidePanelDriver = {
  evaluatePanel(expression: string, userGesture?: boolean): Promise<unknown>;
  /** Any CDP command on the panel's own session (006/T199: `Page.captureScreenshot`, `Emulation.*`). */
  sendToPanel(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  panelText(): Promise<string>;
  waitForText(expected: string, timeoutMs?: number): Promise<void>;
  /** The worker's stable name for how the task ended, when a terminal is on screen. */
  terminalReasonCode(): Promise<string | undefined>;
  clickButton(label: string): Promise<void>;
  /** Clicks only if the control is still shown. Returns whether it was. */
  clickIfPresent(label: string): Promise<boolean>;
  submitTask(request: string): Promise<void>;
  acknowledgeSafety(): Promise<void>;
  allowPageRead(): Promise<void>;
};

export type PanelCopy = ReturnType<typeof copyFor>;

export function localeFromEnv(): AppLocale {
  return process.env.HALLPASS_LOCALE === "zh-TW" ? "zh-TW" : "en-US";
}

export function copyFor(locale: AppLocale) {
  const ui = (key: string) => lookup(key, locale);
  return {
    locale,
    signIn: ui("auth.begin"),
    signedIn: ui("workspace.signedIn").replace("{account}", "Test User"),
    submit: ui("task.submit"),
    safety: ui("safety.disclosureTitle"),
    continue: ui("safety.continue"),
    pageConsent: ui("consent.pageReadTitle"),
    formConsent: ui("consent.formValuesTitle"),
    actionConsent: ui("consent.actionTitle"),
    allowRead: ui("consent.allowPageRead"),
    allowFormValues: ui("consent.allowFormValues"),
    allowAction: ui("consent.allowAction"),
    deny: ui("consent.deny"),
    stop: ui("task.stop"),
    completed: ui("status.success"),
    failed: ui("status.failure"),
    denied: ui("status.denial"),
    stopped: ui("status.cancellation"),
    planTitle: ui("plan.title"),
    approvePlan: ui("plan.approve"),
    excludeStep: ui("plan.step.exclude"),
    excludedOnTerminal: ui("terminal.excluded"),
    runCompleted: ui("run.completed"),
    runStopped: ui("run.stopped"),
    runEffectUnverified: ui("run.reason.effect-unverified"),
    // 002 US6: a wait step on the plan card, and the reason a run that outlasted its bound stopped.
    runWaitBoundReached: ui("run.reason.wait-bound-reached"),
    scroll: ui("action.scroll"),
    click: ui("action.click"),
    enterText: ui("action.enterText"),
    keyPress: ui("action.keyPress"),
    hover: ui("action.hover"),
    doubleClick: ui("action.doubleClick"),
    drag: ui("action.drag"),
    wait: ui("action.wait"),
    /** What a wait step actually says on the card: the condition, about the element it names. */
    waitConditionPresent: ui("wait.condition.present"),
    resolvedFrom: ui("field.resolvedFrom"),
    targetValue: ui("argument.targetValue"),
    unsupported:
      locale === "zh-TW"
        ? "這個頁面無法讀取。請切換到一般 HTTPS 網頁後再試一次。"
        : "This page cannot be read. Switch to a regular HTTPS page and try again.",
    pageFinished: locale === "zh-TW" ? "頁面讀取完成" : "Page read finished",
    actionFinished: locale === "zh-TW" ? "動作完成" : "Action finished",
    planFinished: locale === "zh-TW" ? "計畫完成" : "Plan finished",
  };
}

export async function openSidePanel(input: {
  context: BrowserContext;
  extensionId: string;
  fixturePage: Page;
  tabId: number;
  copy: PanelCopy;
}): Promise<SidePanelDriver> {
  const { context, extensionId, fixturePage, tabId, copy } = input;
  const launcher = await context.newPage();
  await launcher.goto(`chrome-extension://${extensionId}/side-panel.html?launcher=1`);
  const launcherCdp = await context.newCDPSession(launcher);
  const evaluation = await launcherCdp.send("Runtime.evaluate", {
    expression: `chrome.sidePanel.open({tabId:${tabId}})`,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  expect(evaluation.exceptionDetails).toBeUndefined();
  await fixturePage.waitForTimeout(1_000);
  const afterOpen = await launcherCdp.send("Target.getTargets");
  const panelTarget = afterOpen.targetInfos.find(
    (target) => target.url === `chrome-extension://${extensionId}/side-panel.html`,
  );
  expect(panelTarget, JSON.stringify({ evaluation, targetInfos: afterOpen.targetInfos }, null, 2)).toBeTruthy();
  if (!panelTarget) throw new Error("side-panel-target-missing");
  const controlCdp = await context.newCDPSession(fixturePage);
  const attached = await controlCdp.send("Target.attachToTarget", {
    targetId: panelTarget.targetId,
    flatten: false,
  });
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
    await controlCdp.send("Target.sendMessageToTarget", {
      sessionId: attached.sessionId,
      message: JSON.stringify({ id, method, params }),
    });
    // Without a bound, a stalled CDP channel silently consumes the whole test timeout instead of
    // reporting where it stopped.
    return Promise.race([
      response,
      new Promise<Record<string, unknown>>((_, reject) =>
        setTimeout(() => reject(new Error("side-panel-evaluation-timeout")), 20_000),
      ),
    ]);
  };
  const evaluatePanel = async (expression: string, userGesture = false): Promise<unknown> => {
    const message = await sendToPanel("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture });
    const result = message.result as
      | { result?: { value?: unknown }; exceptionDetails?: unknown }
      | undefined;
    if (message.error || result?.exceptionDetails) {
      throw new Error("side-panel-evaluation-failed");
    }
    return result?.result?.value;
  };
  const panelText = async (): Promise<string> => {
    const text = await evaluatePanel("document.body.innerText");
    return typeof text === "string" ? text : "";
  };
  const waitForText = async (expected: string, timeoutMs = 30_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    let lastText = "";
    while (Date.now() < deadline) {
      const text = await evaluatePanel("document.body.innerText");
      if (typeof text === "string") {
        lastText = text;
        if (text.includes(expected)) return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("side-panel-text-timeout:" + expected + ":" + lastText);
  };
  /**
   * The worker's stable name for how the task ended, read off the terminal announcement. A packaged
   * journey asserts the ending it expected with this rather than with the summary, which is copy
   * written for the user and localized.
   */
  const terminalReasonCode = async (): Promise<string | undefined> => {
    const code = await evaluatePanel(
      `document.querySelector('.terminal-state')?.getAttribute('data-reason-code') ?? null`,
    );
    return typeof code === "string" ? code : undefined;
  };
  const clickButton = async (label: string): Promise<void> => {
    const clicked = await evaluatePanel(
      `(()=>{const b=[...document.querySelectorAll('button')].find((x)=>x.textContent?.trim()===${JSON.stringify(label)});if(!b)return false;b.click();return true})()`,
      true,
    );
    expect(clicked).toBe(true);
  };
  const clickIfPresent = async (label: string): Promise<boolean> => {
    const clicked = await evaluatePanel(
      `(()=>{const b=[...document.querySelectorAll('button')].find((x)=>x.textContent?.trim()===${JSON.stringify(label)});if(!b)return false;b.click();return true})()`,
      true,
    );
    return clicked === true;
  };
  const submitTask = async (request: string): Promise<void> => {
    const filled = await evaluatePanel(
      `(()=>{const e=document.querySelector('textarea[name="request"]');if(!e)return false;e.value=${JSON.stringify(request)};e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`,
    );
    expect(filled).toBe(true);
    await clickButton(copy.submit);
  };
  const acknowledgeSafety = async (): Promise<void> => {
    await waitForText(copy.safety);
    await clickButton(copy.continue);
  };
  const allowPageRead = async (): Promise<void> => {
    await waitForText(copy.pageConsent);
    await clickButton(copy.allowRead);
  };

  await launcher.close();
  await fixturePage.bringToFront();

  return {
    evaluatePanel,
    sendToPanel,
    panelText,
    waitForText,
    terminalReasonCode,
    clickButton,
    clickIfPresent,
    submitTask,
    acknowledgeSafety,
    allowPageRead,
  };
}
