import type { BrowserContext } from "@playwright/test";
import { lookup } from "../../../apps/extension/src/locales/catalog.js";
import { startMcpClient, type McpHarnessClient } from "../../harness/mcp-client.js";
import { pairWithFirstCall } from "../fixtures/agent-pairing.js";
import { copyFor, localeFromEnv, openSidePanel, waitForAgentPanel, type SidePanelDriver } from "../fixtures/side-panel-driver.js";
import { expect, test, type PackagedWorker } from "../fixtures/packaged-extension.js";

/**
 * 015 SC-110 (FR-204 - FR-205, T399): a page that did not move is never called stale.
 *
 * The 2026-09-25 measurement saw every `find` on a tab answer `stale` after a cross-origin round
 * trip. T398's bisection (research.md R-197) traced that to state a harness accumulates in one
 * browser process, not to a product path, so this gate is the agent-only reproduction the spec
 * names: twenty rounds of a link click out to another origin, a `navigate` back, and reads on both
 * sides - every one of them must answer from the page, and none may say `stale`.
 */
const locale = localeFromEnv();
const copy = copyFor(locale);
const ui = (key: string): string => lookup(key, locale);
const A = "https://127.0.0.1:19443";
const ROUNDS = 20;

test.describe("015 no false stale", () => {
  test.skip(!process.env.HALLPASS_CDP_ENDPOINT, "attach mode only");

  test("twenty cross-origin round trips answer from the page every time (SC-110)", async ({ extensionContext, extensionId, extensionWorker }) => {
    test.setTimeout(600_000);
    const { panel, client, call } = await pairedSession({ extensionContext, extensionId, extensionWorker });
    try {
      const tabId = ((await call("tabs_create", { url: `${A}/origin-change` })) as { tabId: number }).tabId;
      await setSiteMode(panel, A, "skip-checks");
      const urlOf = async (): Promise<string> =>
        extensionWorker.evaluate(async (id: number) => (await chrome.tabs.get(id)).url ?? "", tabId);
      const answers: string[] = [];
      // Away from A the origin is one the session has not been granted, so the answer there may be a
      // refusal - which is honest. What it may never be is `stale`.
      const read = async (label: string, query: string, granted = true): Promise<{ matches: Array<{ ref: string }> }> => {
        const result = await client.callTool("find", { tabId, query });
        answers.push(`${label}: ${result.text.slice(0, 120)}`);
        expect(result.text, `${label} answered stale on an intact page`).not.toMatch(/"outcome":"stale"/);
        if (granted) expect(result.isError, `${label} failed: ${result.text}`).toBe(false);
        return result.json as { matches: Array<{ ref: string }> };
      };
      for (let round = 1; round <= ROUNDS; round += 1) {
        const cross = await read(`r${round} on A`, "unknown origin");
        const press = await client.callTool("click", { tabId, target: { ref: cross.matches[0]?.ref } });
        expect(press.text, `r${round} click answered stale`).not.toMatch(/"outcome":"stale"/);
        await expect.poll(urlOf, { timeout: 10_000 }).not.toContain("19443");
        await read(`r${round} away`, "a", false);
        await call("navigate", { tabId, url: `${A}/origin-change` });
        await expect.poll(urlOf, { timeout: 10_000 }).toBe(`${A}/origin-change`);
      }
      expect(answers).toHaveLength(ROUNDS * 2);
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});

async function pairedSession(fixtures: {
  extensionContext: BrowserContext;
  extensionId: string;
  extensionWorker: PackagedWorker;
}): Promise<{ panel: SidePanelDriver; client: McpHarnessClient; call: (tool: string, args?: Record<string, unknown>) => Promise<unknown> }> {
  const { extensionContext, extensionId, extensionWorker } = fixtures;
  const ownerPage = extensionContext.pages()[0] ?? (await extensionContext.newPage());
  await ownerPage.goto(`${A}/waiting`);
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
    expect(result.isError, `${tool} failed: ${result.text}\nstderr:\n${client.stderr()}`).toBe(false);
    return result.json;
  };
  return { panel, client, call };
}

async function setSiteMode(panel: SidePanelDriver, site: string, mode: string): Promise<void> {
  await panel.waitForText(site);
  const set = await panel.evaluatePanel(
    `(()=>{const site=${JSON.stringify(site)};const rows=[...document.querySelectorAll('li')];` +
      `const row=rows.find((r)=>r.textContent?.includes(site));const sel=row?.querySelector('select');` +
      `if(!sel)return false;const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;` +
      `setter.call(sel,${JSON.stringify(mode)});sel.dispatchEvent(new Event('change',{bubbles:true}));return true})()`,
    true,
  );
  expect(set).toBe(true);
}
