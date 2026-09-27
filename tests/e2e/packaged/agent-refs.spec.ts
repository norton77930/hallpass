import type { Page } from "@playwright/test";
import { AGENT_READ_PAGE_MAX_CHARS } from "@hallpass/contracts";
import { lookup } from "../../../apps/extension/src/locales/catalog.js";
import { startMcpClient, type McpHarnessClient } from "../../harness/mcp-client.js";
import { pairWithFirstCall } from "../fixtures/agent-pairing.js";
import { copyFor, localeFromEnv, openSidePanel, waitForAgentPanel, type SidePanelDriver } from "../fixtures/side-panel-driver.js";
import { expect, test } from "../fixtures/packaged-extension.js";

const locale = localeFromEnv();
const copy = copyFor(locale);
const ui = (key: string): string => lookup(key, locale);

const SITE = "https://127.0.0.1:19443";

/**
 * 004/T136 - US6 end to end: a ref survives being re-read, a genuinely removed element answers
 * `stale-reference` rather than resolving to something else, open shadow roots are traversed while
 * closed ones stay invisible, and a long page's text read is cut by the character ceiling and can be
 * raised by the caller within it (`shadow-host.html`, the `long` fixture).
 *
 * Attach mode only, for the same reason every other agent journey is: the bridge starts with a
 * machine install, and a browser this gate launched itself would prove nothing about it.
 */
test.describe("agent refs", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT,
    "attach mode only: the native-messaging host is a machine install, so the browser under test " +
      "must be one the runner started and pointed at the installed host (HALLPASS_CDP_ENDPOINT).",
  );

  test("a first-read ref survives later reads, a removed element goes stale, shadow-root visibility is honest, and a long read is cut and raisable", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(300_000);

    const permissions = await extensionWorker.evaluate(() => chrome.runtime.getManifest().permissions ?? []);
    expect(
      permissions,
      "the attached browser must have apps/extension/dist/agent loaded (npm run build:extension:agent)",
    ).toContain("nativeMessaging");

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

    let client: McpHarnessClient | undefined;
    try {
      client = await startMcpClient({ clientName: "Claude Code" });
      const live = client;
      const call = callerFor(() => client);
      await panel.clickIfPresent(ui("agent.retry"));
      await pairWithFirstCall(client, panel, { locale });

      // ============= 1. a ref from the first of three reads still resolves and clicks =============
      const created = (await call("tabs_create", { url: `${SITE}/ordinary` })) as { tabId: number };
      const tabId = created.tabId;
      const ordinaryPage = await agentPage(extensionContext, `${SITE}/ordinary`);
      await setSiteMode(panel, SITE, "skip-checks");

      const firstRead = (await call("read_page", { tabId, filter: "interactive" })) as {
        nodes: Array<{ ref?: string; name?: string }>;
      };
      const firstRef = firstRead.nodes.find((node) => node.name === "Safe action")?.ref;
      expect(firstRef, `no ref for "Safe action" in the first read: ${JSON.stringify(firstRead.nodes)}`).toBeTruthy();

      await call("read_page", { tabId, filter: "interactive" });
      await call("read_page", { tabId, filter: "interactive" });

      const clicked = await call("click", { tabId, target: { ref: firstRef! } });
      expect(clicked).toMatchObject({ observed: { effect: "activated" } });
      // The fixture's own echo, not the tool's verdict word: only a click that actually landed sets it.
      await expect(ordinaryPage.locator("#clicked")).not.toHaveText("not clicked yet");

      // ============= 3. an open shadow root is traversed, a closed one is not =============
      const shadowCreated = (await call("tabs_create", { url: `${SITE}/shadow-host` })) as { tabId: number };
      const shadowTabId = shadowCreated.tabId;
      const shadowPage = await agentPage(extensionContext, `${SITE}/shadow-host`);
      await setSiteMode(panel, SITE, "skip-checks");

      const shadowRead = (await call("read_page", { tabId: shadowTabId, filter: "interactive" })) as {
        nodes: Array<{ ref?: string; name?: string }>;
      };
      const openRef = shadowRead.nodes.find((node) => node.name === "Open shadow action")?.ref;
      expect(openRef, `the open root's button is missing: ${JSON.stringify(shadowRead.nodes)}`).toBeTruthy();
      // Absence is the point, not a gap: a control behind a closed root is indistinguishable from
      // one that does not exist, so it must be positively missing from the list.
      expect(
        shadowRead.nodes.some((node) => node.name === "Closed shadow action"),
        `the closed root's button must not be listed: ${JSON.stringify(shadowRead.nodes)}`,
      ).toBe(false);

      const shadowClicked = await call("click", { tabId: shadowTabId, target: { ref: openRef! } });
      // Both halves of the claim: the page's own echo (a click that actually landed) and the
      // tool's verdict (T148 — a shadow-hosted hit must not read as `target-missed`).
      expect(shadowClicked).toMatchObject({ observed: { effect: "activated", verified: true } });
      await expect(shadowPage.locator("#shadow-echo")).toHaveText("open shadow clicked");

      await call("tabs_close", { tabId: shadowTabId });

      // ============= 4. a long page's text is cut by the character ceiling, and a smaller =============
      // ============= caller-chosen max_chars carries even less =============
      const longCreated = (await call("tabs_create", { url: `${SITE}/long` })) as { tabId: number };
      const longTabId = longCreated.tabId;

      const atCeiling = (await call("get_page_text", { tabId: longTabId })) as {
        text: string;
        truncated: boolean;
        truncatedBy?: string;
      };
      expect(atCeiling.truncated, JSON.stringify(atCeiling).slice(0, 200)).toBe(true);
      expect(atCeiling.truncatedBy).toBe("chars");
      expect(atCeiling.text.length).toBeLessThanOrEqual(AGENT_READ_PAGE_MAX_CHARS);

      const smaller = (await call("get_page_text", { tabId: longTabId, max_chars: 5_000 })) as {
        text: string;
        truncated: boolean;
        truncatedBy?: string;
      };
      expect(smaller.truncated).toBe(true);
      expect(smaller.text.length).toBeLessThanOrEqual(5_000);
      // Raising the caller's own bound is what carries more of the page, not a second, bigger fixture.
      expect(smaller.text.length).toBeLessThan(atCeiling.text.length);

      await call("tabs_close", { tabId: longTabId });

      // ============= 2. a genuinely removed element answers stale-reference, not a re-read =============
      const beforeRemoval = (await call("read_page", { tabId, filter: "interactive" })) as {
        nodes: Array<{ ref?: string; name?: string }>;
      };
      const notesRef = beforeRemoval.nodes.find((node) => node.name === "notes")?.ref;
      expect(notesRef, `no ref for "notes" before removal: ${JSON.stringify(beforeRemoval.nodes)}`).toBeTruthy();

      // The element is taken out of the document itself - not merely scrolled away or hidden - so
      // the claim is about genuine absence, never about a read simply happening again.
      await ordinaryPage.evaluate(() => {
        document.querySelector('input[name="notes"]')?.remove();
      });

      const refused = await live.callTool("click", { tabId, target: { ref: notesRef! } });
      expect(refused.isError, `mcp-server stderr:\n${live.stderr()}`).toBe(true);
      expect(refused.json, refused.text).toMatchObject({
        outcome: "stale",
        reason: "stale-reference",
        refusal: { reason: "stale-reference" },
      });

      await call("tabs_close", { tabId });
    } finally {
      await client?.close();
    }
  });
});

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

/** The Playwright page for a tab the *agent* opened, so the fixture can be read independently. */
async function agentPage(
  context: { pages: () => Page[] },
  url: string,
  timeoutMs = 30_000,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = context.pages().find((page) => page.url() === url);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`agent-tab-not-found:${url}`);
}

/**
 * Sets one site's mode through the panel's own control (FR-042), never by writing storage: the
 * claim is that the owner can decide from what they are shown, and poking the store behind the
 * panel would prove only that the store works.
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
      async () => panel.evaluatePanel(
        `(()=>{const site=${JSON.stringify(site)};const rows=[...document.querySelectorAll('li')];` +
          `const row=rows.find((r)=>r.textContent?.includes(site));return row?.querySelector('select')?.value ?? null})()`,
      ),
      { timeout: 15_000 },
    )
    .toBe(mode);
}
