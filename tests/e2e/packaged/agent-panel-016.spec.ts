import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { AGENT_SESSION_COLOURS } from "@hallpass/contracts";
import {
  AGENT_GROUP_TITLE,
  WAITING_GROUP_TITLE,
  WORKING_GROUP_TITLE,
} from "../../../apps/extension/src/chrome-adapters/tab-groups.js";
import { lookup } from "../../../apps/extension/src/locales/catalog.js";
import { startMcpClient, type McpHarnessClient } from "../../harness/mcp-client.js";
import { pairWithFirstCall } from "../fixtures/agent-pairing.js";
import { copyFor, localeFromEnv, openSidePanel, waitForAgentPanel, type SidePanelDriver } from "../fixtures/side-panel-driver.js";
import { expect, test, type PackagedWorker } from "../fixtures/packaged-extension.js";

/**
 * 016 T451 - the readable panel and the marked tab strip, end to end (US1, US2, US4, US5 scenario 1;
 * contracts/panel.md, contracts/tab-group.md, quickstart "Gates").
 *
 * Two real `mcp-server` processes, each spawned in its own scratch folder - `shop-frontend` and
 * `report-tool` - so the label on each card is the one the host derived from its own working
 * directory (FR-226, R-203), not one this gate wrote anywhere. Every claim is read off the rendered
 * panel or off the browser (`chrome.tabGroups` through the extension worker), never off the answer
 * the agent was given:
 *   - the status row counts the sessions and names no agent; the menu names the paired agent;
 *   - each card is titled by its folder, and its stripe colour is its tab group's colour, and the
 *     two differ;
 *   - a session with a call in flight is `working` (interrupt + take back shown) and its group is
 *     `⌛ Hallpass`; a moment after the call answers it is `idle · last action just now` and `Hallpass`;
 *   - a session whose question waits on the owner is `waiting` and its group is `🔔 Hallpass`;
 *   - a keystroke whose keydown handler opens `alert` is answered with the dialog at once (FR-242).
 *
 * Attach mode only, like every agent journey: the bridge starts with a machine install.
 * Needs the fixture server restarted after the `keydown-alert` fixture was added.
 */
const locale = localeFromEnv();
const copy = copyFor(locale);
const ui = (key: string): string => lookup(key, locale);
const SITE = "https://127.0.0.1:19443";
const AGENT = "Claude Code";
const LABEL_A = "shop-frontend";
const LABEL_B = "report-tool";

type CardView = {
  sessionId: string;
  state: string | null;
  title: string;
  label: string | null;
  colour: string | null;
  stateText: string;
  buttons: string[];
  interrupt: { present: boolean; ariaDisabled: string | null };
};

type ListedTab = { tabId: number; holder: "this" | "none" | { sessionId: string } };
type Dialog = { id: string; type: string; message: string; tabId: number };

test.describe("016 readable panel", () => {
  test.skip(!process.env.HALLPASS_CDP_ENDPOINT, "attach mode only");

  test("two folder-named sessions: status row, cards, stripes = group colours, working / idle / waiting, menu, and a keydown alert answered with the dialog", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(300_000);
    leaveDialogsToTheExtension(extensionContext);

    const scratch = mkdtempSync(join(tmpdir(), "hallpass-016-"));
    const folderA = join(scratch, LABEL_A);
    const folderB = join(scratch, LABEL_B);
    mkdirSync(folderA);
    mkdirSync(folderB);

    const panel = await ownerPanel({ extensionContext, extensionId, extensionWorker });
    let alpha: McpHarnessClient | undefined;
    let beta: McpHarnessClient | undefined;
    const openTabs: number[] = [];
    try {
      alpha = await startMcpClient({ clientName: AGENT, cwd: folderA });
      await panel.clickIfPresent(ui("agent.retry"));
      await pairWithFirstCall(alpha, panel, { locale });
      // The same agent name: the second session joins on the pairing already granted (pair-once).
      beta = await startMcpClient({ clientName: AGENT, cwd: folderB });
      const a = alpha;
      const b = beta;

      const tabA = ((await ok(a, "tabs_create", { url: `${SITE}/ordinary` })) as { tabId: number }).tabId;
      openTabs.push(tabA);
      const tabB = ((await ok(b, "tabs_create", { url: `${SITE}/ordinary` })) as { tabId: number }).tabId;
      openTabs.push(tabB);
      await setSiteMode(panel, SITE, "skip-checks");

      // Which session is which, as the sessions themselves are told (each names the other's holder).
      const sessionB = holderOf((await ok(a, "tabs_context")) as ListedTab[], tabB);
      const sessionA = holderOf((await ok(b, "tabs_context")) as ListedTab[], tabA);
      expect(sessionA).not.toBe(sessionB);

      // ================= US1: the status row counts sessions, names no agent =================
      await expect
        .poll(() => panel.evaluatePanel("document.querySelectorAll('section[data-session-id]').length"), { timeout: 20_000 })
        .toBe(2);
      const statusExpected = `${ui("agent.status.connected")} · ${ui("agent.status.sessions").replace("{n}", "2")}`;
      await expect.poll(() => statusText(panel), { timeout: 15_000 }).toBe(statusExpected);
      expect(await statusText(panel), "the status row names no agent (FR-223)").not.toContain(AGENT);

      // ================= US2: cards titled by folder, stripe = group colour =================
      await expect.poll(async () => (await cardOf(panel, sessionA))?.label ?? null, { timeout: 15_000 }).toBe(LABEL_A);
      await expect.poll(async () => (await cardOf(panel, sessionB))?.label ?? null, { timeout: 15_000 }).toBe(LABEL_B);
      const cardA = (await cardOf(panel, sessionA))!;
      const cardB = (await cardOf(panel, sessionB))!;
      expect(cardA.title).toBe(`${AGENT} · ${LABEL_A}`);
      expect(cardB.title).toBe(`${AGENT} · ${LABEL_B}`);

      const groupA = await groupOf(extensionWorker, tabA);
      const groupB = await groupOf(extensionWorker, tabB);
      expect(groupA.groupId).toBeGreaterThan(-1);
      expect(groupB.groupId).toBeGreaterThan(-1);
      expect(groupA.groupId).not.toBe(groupB.groupId);
      expect(AGENT_SESSION_COLOURS as readonly string[]).toContain(cardA.colour);
      expect(AGENT_SESSION_COLOURS as readonly string[]).toContain(cardB.colour);
      expect(cardA.colour, "two live sessions get two colours (FR-240)").not.toBe(cardB.colour);
      await expect.poll(async () => (await groupOf(extensionWorker, tabA)).color, { timeout: 10_000 }).toBe(cardA.colour);
      await expect.poll(async () => (await groupOf(extensionWorker, tabB)).color, { timeout: 10_000 }).toBe(cardB.colour);
      // eslint-disable-next-line no-console -- the tab strip cannot be captured from the panel's CDP session.
      console.log(`[T451] groups: ${LABEL_A}=${JSON.stringify(await groupOf(extensionWorker, tabA))} ${LABEL_B}=${JSON.stringify(await groupOf(extensionWorker, tabB))}`);

      // ================= US2 + US4: working while a call is in flight =================
      const inFlight = a.callTool("wait", { tabId: tabA, forMs: 8_000 });
      await expect.poll(async () => (await groupOf(extensionWorker, tabA)).title, { timeout: 5_000, intervals: [200] }).toBe(WORKING_GROUP_TITLE);
      await expect.poll(async () => (await cardOf(panel, sessionA))?.state ?? null, { timeout: 5_000, intervals: [200] }).toBe("working");
      const working = (await cardOf(panel, sessionA))!;
      expect(working.stateText).toBe(ui("agent.session.working"));
      expect(working.interrupt, "interrupt is shown, and actionable, while a call is in flight").toEqual({ present: true, ariaDisabled: "false" });
      expect(working.buttons).toEqual([
        ui("agent.session.stop"),
        ui("agent.session.interrupt"),
        ui("agent.session.takeBack").replace("{n}", "1"),
      ]);
      // The other session, meanwhile, is idle: plain title, end + take back only.
      await expect.poll(async () => (await cardOf(panel, sessionB))?.state ?? null, { timeout: 10_000 }).toBe("idle");
      await expect.poll(async () => (await groupOf(extensionWorker, tabB)).title, { timeout: 5_000, intervals: [200] }).toBe(AGENT_GROUP_TITLE);
      const idleB = (await cardOf(panel, sessionB))!;
      expect(idleB.interrupt.present).toBe(false);
      expect(idleB.buttons).toEqual([ui("agent.session.stop"), ui("agent.session.takeBack").replace("{n}", "1")]);

      const waited = await inFlight;
      expect(waited.isError, `wait: ${waited.text}\nstderr:\n${a.stderr()}`).toBe(false);

      // ================= ...and idle again a moment after it answered =================
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await expect.poll(async () => (await groupOf(extensionWorker, tabA)).title, { timeout: 3_000, intervals: [200] }).toBe(AGENT_GROUP_TITLE);
      await expect.poll(async () => (await cardOf(panel, sessionA))?.state ?? null, { timeout: 3_000, intervals: [200] }).toBe("idle");
      const idleA = (await cardOf(panel, sessionA))!;
      expect(idleA.stateText).toBe(ui("agent.session.idle").replace("{ago}", ui("agent.session.justNow")));
      expect(idleA.interrupt.present).toBe(false);
      expect(idleA.buttons).toEqual([ui("agent.session.stop"), ui("agent.session.takeBack").replace("{n}", "1")]);

      // ================= US2 + US4: waiting on the owner =================
      await setSiteMode(panel, SITE, "ask");
      const askRef = await refFor(b, tabB, "Safe action");
      const asked = b.callTool("click", { tabId: tabB, target: { ref: askRef } });
      await panel.waitForText(ui("agent.promptTitle"), 20_000);
      await expect.poll(async () => (await groupOf(extensionWorker, tabB)).title, { timeout: 10_000, intervals: [200] }).toBe(WAITING_GROUP_TITLE);
      await expect.poll(async () => (await cardOf(panel, sessionB))?.state ?? null, { timeout: 10_000 }).toBe("waiting");
      expect((await cardOf(panel, sessionB))!.stateText).toBe(ui("agent.session.waiting"));
      // The bell is this session's alone: the other group keeps its plain title.
      expect((await groupOf(extensionWorker, tabA)).title).toBe(AGENT_GROUP_TITLE);
      await panel.clickButton(ui("agent.refuse"));
      const refused = await asked;
      expect(refused.isError).toBe(true);
      expect(refused.json).toMatchObject({ outcome: "denied", reason: "owner-denied" });
      await expect.poll(async () => (await groupOf(extensionWorker, tabB)).title, { timeout: 10_000, intervals: [250] }).toBe(AGENT_GROUP_TITLE);
      await setSiteMode(panel, SITE, "skip-checks");

      // ================= US1: the menu names the paired agent =================
      expect(await panel.clickIfPresent(ui("agent.status.menu"))).toBe(true);
      const menu = (await panel.evaluatePanel(
        "[...document.querySelectorAll('[data-status-row] .agent-menu .agent-menu-name')].map((n)=>n.textContent ?? '')",
      )) as string[];
      expect(menu).toContain(AGENT);
      expect(
        await panel.evaluatePanel(
          `[...document.querySelectorAll('[data-status-row] .agent-menu button')].some((b)=>b.getAttribute('aria-label')===${JSON.stringify(ui("agent.status.unpairAgent").replace("{agent}", AGENT))})`,
        ),
      ).toBe(true);
      // Closed again without unpairing anything.
      expect(await panel.clickIfPresent(ui("agent.status.menu"))).toBe(true);

      // ================= US5 scenario 1: a keydown alert answers with the dialog =================
      const KEYDOWN = `${SITE}/keydown-alert`;
      await ok(a, "navigate", { tabId: tabA, url: KEYDOWN });
      const fieldRef = await refFor(a, tabA, "Alerting field");
      const started = Date.now();
      const pressed = await a.callTool("key", { tabId: tabA, target: { ref: fieldRef }, key: "Enter" });
      const elapsed = Date.now() - started;
      // eslint-disable-next-line no-console -- how long the dialog took to come back (FR-242).
      console.log(`[T451] keydown alert answered in ${elapsed} ms`);
      expect(pressed.isError, `key: ${pressed.text}\nstderr:\n${a.stderr()}`).toBe(false);
      const answer = pressed.json as { dialog?: Dialog; reason?: string };
      expect(answer.reason, pressed.text).toBeUndefined();
      expect(answer.dialog, `the key that raised the alert must carry it back: ${pressed.text}`).toMatchObject({
        type: "alert",
        message: "Key Enter pressed.",
      });
      expect(elapsed, "answered before the input deadline, not at it").toBeLessThan(10_000);
      const dismissed = (await ok(a, "dialog", { tabId: tabA, action: "dismiss" })) as { ok: boolean; type: string };
      expect(dismissed).toMatchObject({ ok: true, type: "alert" });
      await expect(pageAt(extensionContext, KEYDOWN).locator("#result")).toHaveText("alert-closed");

      await ok(a, "tabs_close", { tabId: tabA });
      await ok(b, "tabs_close", { tabId: tabB });
      openTabs.length = 0;
    } finally {
      for (const tabId of openTabs) {
        await alpha?.callTool("dialog", { tabId, action: "dismiss" }).catch(() => undefined);
        await extensionWorker.evaluate((id: number) => chrome.tabs.remove(id), tabId).catch(() => undefined);
      }
      await alpha?.close().catch(() => undefined);
      await beta?.close().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

async function ownerPanel(fixtures: {
  extensionContext: BrowserContext;
  extensionId: string;
  extensionWorker: PackagedWorker;
}): Promise<SidePanelDriver> {
  const { extensionContext, extensionId, extensionWorker } = fixtures;
  const permissions = await extensionWorker.evaluate(() => chrome.runtime.getManifest().permissions ?? []);
  expect(
    permissions,
    "the attached browser must have apps/extension/dist/agent loaded (npm run build:extension:agent)",
  ).toContain("tabGroups");
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
  return panel;
}

async function ok(client: McpHarnessClient, tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const result = await client.callTool(tool, args);
  expect(result.isError, `${tool} failed: ${result.text}\nstderr:\n${client.stderr()}`).toBe(false);
  return result.json;
}

function holderOf(listed: ListedTab[], tabId: number): string {
  const holder = listed.find((tab) => tab.tabId === tabId)?.holder;
  expect(holder, `tab ${tabId} is not listed as another session's: ${JSON.stringify(listed)}`).toEqual({ sessionId: expect.any(String) });
  return (holder as { sessionId: string }).sessionId;
}

/** The status row's text, without the menu button beside it. */
async function statusText(panel: SidePanelDriver): Promise<string> {
  const text = await panel.evaluatePanel("document.querySelector('[data-status-row] .agent-status-text')?.textContent ?? ''");
  return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
}

/** One card as rendered: its state attribute, title, stripe colour, state line and controls. */
async function cardOf(panel: SidePanelDriver, sessionId: string): Promise<CardView | undefined> {
  const view = await panel.evaluatePanel(
    `(()=>{const card=document.querySelector('section[data-session-id=${JSON.stringify(sessionId)}]');` +
      `if(!card)return null;const interrupt=card.querySelector('button.agent-interrupt');` +
      `return {sessionId:card.getAttribute('data-session-id'),state:card.getAttribute('data-session-state'),` +
      `title:(card.querySelector('h2')?.textContent??'').replace(/\\s+/g,' ').trim(),` +
      `label:card.querySelector('.agent-session-label')?.getAttribute('title')??null,` +
      `colour:card.querySelector('.agent-session-stripe')?.getAttribute('data-colour')??null,` +
      `stateText:(card.querySelector('.agent-session-state')?.textContent??'').trim(),` +
      `buttons:[...card.querySelectorAll('.agent-session-actions button')].map((b)=>(b.textContent??'').trim()),` +
      `interrupt:{present:interrupt!==null,ariaDisabled:interrupt?.getAttribute('aria-disabled')??null}}})()`,
  );
  return (view ?? undefined) as CardView | undefined;
}

/** A tab's group as the browser has it: id, title and colour. */
async function groupOf(
  worker: PackagedWorker,
  tabId: number,
): Promise<{ groupId: number; title?: string | undefined; color?: string | undefined }> {
  return worker.evaluate(async (id: number) => {
    const tab = await chrome.tabs.get(id);
    const group = tab.groupId === undefined || tab.groupId < 0 ? undefined : await chrome.tabGroups.get(tab.groupId);
    return { groupId: tab.groupId, title: group?.title, color: group?.color };
  }, tabId);
}

async function refFor(client: McpHarnessClient, tabId: number, label: string): Promise<string> {
  const found = await client.callTool("find", { tabId, query: label });
  expect(found.isError, `find '${label}' failed: ${found.text}`).toBe(false);
  const answer = found.json as { outcome: string; matches: Array<{ ref: string; label?: string }> };
  expect(answer.outcome, `find '${label}' answered ${answer.outcome}`).toBe("resolved");
  const match = answer.matches.find((candidate) => candidate.label === label) ?? answer.matches[0];
  expect(match?.ref, `find '${label}' returned no ref: ${found.text}`).toBeTruthy();
  return match!.ref;
}

/** Playwright dismisses dialogs itself unless the page has a listener; leave them to the extension. */
function leaveDialogsToTheExtension(context: BrowserContext): void {
  const arm = (page: Page): void => {
    page.on("dialog", () => undefined);
  };
  for (const page of context.pages()) arm(page);
  context.on("page", arm);
}

function pageAt(context: BrowserContext, url: string): Page {
  const page = context.pages().find((candidate) => candidate.url().startsWith(url));
  if (!page) throw new Error(`no page at ${url}`);
  return page;
}

async function setSiteMode(panel: SidePanelDriver, site: string, mode: string): Promise<void> {
  await panel.waitForText(site);
  const set = await panel.evaluatePanel(
    `(()=>{const sel=document.querySelector('[data-site=${JSON.stringify(site)}] select');` +
      `if(!sel)return false;const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;` +
      `setter.call(sel,${JSON.stringify(mode)});sel.dispatchEvent(new Event('change',{bubbles:true}));return true})()`,
    true,
  );
  expect(set, `the panel offers no mode control for ${site}`).toBe(true);
  await expect
    .poll(() => panel.evaluatePanel(`document.querySelector('[data-site=${JSON.stringify(site)}] select')?.value ?? null`), {
      timeout: 15_000,
    })
    .toBe(mode);
}
