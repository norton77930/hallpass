import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { homedir } from "node:os";
import { join } from "node:path";
import { lookup } from "../../../apps/extension/src/locales/catalog.js";
import { startMcpClient, type McpHarnessClient } from "../../harness/mcp-client.js";
import { pairWithFirstCall } from "../fixtures/agent-pairing.js";
import { copyFor, localeFromEnv, openSidePanel, waitForAgentPanel, type SidePanelDriver } from "../fixtures/side-panel-driver.js";
import { expect, test } from "../fixtures/packaged-extension.js";

const locale = localeFromEnv();
const copy = copyFor(locale);
const ui = (key: string): string => lookup(key, locale);

const SITE = "https://127.0.0.1:19443";

/** Text that exists only on the fixture pages this journey drives, or that it types into them. */
const TYPED = "zqx-privacy-typed-secret";
const PAGE_STRINGS = [
  "Ordinary fixture",
  "Ordinary page",
  "Safe action",
  "ordinary note",
  "This fixture page carries ordinary",
  TYPED,
];

/**
 * 003/T065 — the two files this feature writes carry codes, never page content (SC-025).
 *
 * A full round of agent work happens here - reads, effects, tab management and a batch, all carrying
 * the fixture's own text and a secret typed into its form - and then the relay's `relay.log` and the
 * MCP server's stderr are grepped for every one of those strings. Both carry a line per frame that
 * crossed, so if either logged what it forwarded, the page's words would be sitting on the owner's
 * disk. The strings are proven to have really travelled by checking that the tools returned them.
 *
 * Until 009 this journey also watched a redacting proxy in front of the 001/002 product service and
 * asserted it saw nothing. That service, its proxy, and the CSP entry that let an extension page
 * reach either are gone: nothing in the artefact names a remote origin, so there is no longer a
 * listener that could observe a request or a request that could reach one.
 *
 * Attach mode only, for the same reason the other agent journeys are: the bridge starts with a
 * machine install, and a browser this gate launched itself would prove nothing about it.
 *
 * Prerequisites: `npm run build:extension:agent`, `dist/agent` loaded in the attached browser,
 * `npm run agent-host:install`, and the page fixtures running (`npm run dev:test-pages`).
 */
test.describe("agent privacy", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT,
    "attach mode only: the native-messaging host is a machine install, so the browser under test " +
      "must be one the runner started and pointed at the installed host (HALLPASS_CDP_ENDPOINT).",
  );

  test("does a full round of agent work while the logs carry no page text", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(360_000);

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
      // T098a: the prompt by its own key, Accept clicked, and pairing confirmed by a signal that
      // is false when nothing is paired - the panel's section heading is on screen either way.
      await pairWithFirstCall(live, panel, { locale });

      const created = (await call("tabs_create", { url: `${SITE}/ordinary` })) as { tabId: number };
      const tabId = created.tabId;
      await setSiteMode(panel, SITE, "skip-checks");

      // ================= reads: the page's own words come back =================
      const text = (await call("get_page_text", { tabId })) as { text: string };
      expect(text.text).toContain("Ordinary page");
      const found = (await call("find", { tabId, query: "Safe action" })) as {
        outcome: string;
      };
      expect(found.outcome).toBe("resolved");
      const shot = await live.callTool("screenshot", { tabId });
      expect(shot.isError).toBe(false);

      // ================= effects: a click and a typed secret =================
      // Read last of the reads: every collection invalidates the handles the one before it issued,
      // and `find` is a collection too, so these are the live refs.
      const structure = (await call("read_page", { tabId, filter: "interactive" })) as {
        nodes: Array<{ ref?: string; role: string; name?: string }>;
      };
      const refOf = (name: string): string => {
        const node = structure.nodes.find((candidate) => candidate.name === name && candidate.ref !== undefined);
        expect(node, `read_page offered no ref named '${name}': ${JSON.stringify(structure.nodes)}`).toBeTruthy();
        return node?.ref as string;
      };
      await call("click", { tabId, target: { ref: refOf("Safe action") } });
      await call("type", { tabId, target: { ref: refOf("notes") }, text: TYPED });
      const ordinary = await agentPage(extensionContext, `${SITE}/ordinary`);
      await expect(ordinary.locator('input[name="notes"]')).toHaveValue(TYPED);

      // ================= tab work and a batch =================
      await call("navigate", { tabId, url: `${SITE}/tags` });
      const tags = await agentPage(extensionContext, `${SITE}/tags`);
      const tagNodes = (await call("read_page", { tabId, filter: "interactive" })) as {
        nodes: Array<{ ref?: string; role: string; name?: string }>;
      };
      const tagRef = tagNodes.nodes.find((node) => node.name === "Tag" && node.ref !== undefined)?.ref;
      const batched = (await call("browser_batch", {
        tabId,
        steps: [
          { tool: "type", args: { target: { ref: tagRef }, text: TYPED } },
          { tool: "key", args: { target: { ref: tagRef }, key: "Enter" } },
        ],
      })) as { results: Array<{ outcome: string }> };
      expect(batched.results.map((step) => step.outcome)).toEqual(["ok", "ok"]);
      await expect(tags.locator("#tags li")).toHaveText([TYPED]);

      await call("tabs_close", { tabId });

      // ================= SC-025: the host's own logs carry codes, not content =================
      const relayLog = await readFile(
        join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "hallpass", "relay.log"),
        "utf8",
      );
      // The log is real and was written by this run - otherwise the greps below prove nothing.
      expect(relayLog).toContain("relay.to-chrome");
      const serverStderr = live.stderr();
      expect(serverStderr).toContain("agent.call.completed ok");
      for (const secret of PAGE_STRINGS) {
        expect(relayLog.includes(secret), `relay.log leaked ${JSON.stringify(secret)}`).toBe(false);
        expect(serverStderr.includes(secret), `mcp-server stderr leaked ${JSON.stringify(secret)}`).toBe(false);
      }

      await setSiteMode(panel, SITE, "ask");
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

/** Sets one site's mode through the panel's own control (FR-042), never by writing storage. */
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
      async () => {
        const value = await panel.evaluatePanel(
          `(()=>{const site=${JSON.stringify(site)};const rows=[...document.querySelectorAll('li')];` +
            `const row=rows.find((r)=>r.textContent?.includes(site));return row?.querySelector('select')?.value ?? "forgotten"})()`,
        );
        // Back at the default with no grant, the site is forgotten and leaves the list once no
        // session tab is on it (site-mode-store, 2026-09-16); a vanished row is that answer.
        return value === "forgotten" && mode === "ask" ? "ask" : value;
      },
      { timeout: 15_000 },
    )
    .toBe(mode);
}
