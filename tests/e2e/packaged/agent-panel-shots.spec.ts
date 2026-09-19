import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lookup } from "../../../apps/extension/src/locales/catalog.js";
import { startMcpClient, type McpHarnessClient } from "../../harness/mcp-client.js";
import { acceptPairing } from "../fixtures/agent-pairing.js";
import { copyFor, localeFromEnv, openSidePanel } from "../fixtures/side-panel-driver.js";
import { expect, test } from "../fixtures/packaged-extension.js";

const locale = localeFromEnv();
const copy = copyFor(locale);
const ui = (key: string): string => lookup(key, locale);

const SITE = "https://127.0.0.1:19443";

/**
 * 006/T199 - the screenshots the owner reviews (SC-050). Not a test of behaviour. The real side
 * panel is the only page the worker projects to (`isTrustedControlSender`: no tab, the panel's own
 * url), so the pictures are taken on its CDP session - the colour scheme emulated both ways - for
 * two compositions: paired and idle, and two live sessions with a consent waiting on top. Runs
 * only when asked for (`HALLPASS_PANEL_SHOTS=1`), in attach mode, and writes under
 * `specs/006-side-panel/screenshots/`.
 */
const OUT = join(process.cwd(), "specs", "006-side-panel", "screenshots");

test.describe("agent panel screenshots", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT || !process.env.HALLPASS_PANEL_SHOTS,
    "screenshots are taken on request only (HALLPASS_PANEL_SHOTS=1), in attach mode",
  );

  test("captures paired-idle and two-sessions in light and dark", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(300_000);
    mkdirSync(OUT, { recursive: true });

    const ownerPage = extensionContext.pages()[0] ?? (await extensionContext.newPage());
    await ownerPage.goto(`${SITE}/waiting`);
    await ownerPage.bringToFront();
    const ownerTabId = await extensionWorker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined) throw new Error("active-tab-missing");
      return tab.id;
    });
    const panel = await openSidePanel({ context: extensionContext, extensionId, fixturePage: ownerPage, tabId: ownerTabId, copy });
    await panel.waitForText(ui("agent.appTitle"));

    const shoot = async (name: string): Promise<void> => {
      for (const scheme of ["light", "dark"] as const) {
        await panel.sendToPanel("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
        await ownerPage.waitForTimeout(400);
        const shot = await panel.sendToPanel("Page.captureScreenshot", { format: "png" });
        const data = (shot.result as { data?: string } | undefined)?.data;
        expect(data, JSON.stringify(shot).slice(0, 300)).toBeTruthy();
        writeFileSync(join(OUT, `${name}-${scheme}.png`), Buffer.from(data ?? "", "base64"));
      }
      await panel.sendToPanel("Emulation.setEmulatedMedia", { features: [] });
    };

    let a: McpHarnessClient | undefined;
    let b: McpHarnessClient | undefined;
    try {
      // ---------- pair once, then let the session end: the idle composition ----------
      a = await startMcpClient({ clientName: "Claude Code" });
      await panel.clickIfPresent(ui("agent.retry"));
      const first = a.callTool("tabs_context");
      await acceptPairing(panel, { locale });
      const firstAnswer = await first;
      expect(firstAnswer.isError, `tabs_context: ${firstAnswer.text}\nstderr:\n${a.stderr()}`).toBe(false);
      await a.close();
      a = undefined;
      await expect
        .poll(() => panel.evaluatePanel("document.querySelectorAll('[data-session-id]').length"), { timeout: 20_000 })
        .toBe(0);
      await shoot("idle");

      // ---------- two sessions on real sites, one waiting on a consent ----------
      a = await startMcpClient({ clientName: "Claude Code" });
      b = await startMcpClient({ clientName: "Claude Code" });
      const tabA = ((await ok(a, "tabs_create", { url: "https://github.com/" })) as { tabId: number }).tabId;
      const tabB = ((await ok(b, "tabs_create", { url: "https://en.wikipedia.org/" })) as { tabId: number }).tabId;
      await expect
        .poll(() => panel.evaluatePanel("document.querySelectorAll('[data-session-id]').length"), { timeout: 20_000 })
        .toBe(2);
      // B asks for an effect on a site with no decision: the consent card comes up and B waits.
      // The page may still be committing right after the create; a stale read is retried.
      const read = await expect
        .poll(
          async () => {
            const result = await b!.callTool("read_page", { tabId: tabB, filter: "interactive" });
            return result.isError ? undefined : (result.json as { nodes: Array<{ ref?: string; role: string }> });
          },
          { timeout: 30_000, intervals: [1_000] },
        )
        .toBeTruthy()
        .then(async () => (await ok(b!, "read_page", { tabId: tabB, filter: "interactive" })) as {
          nodes: Array<{ ref?: string; role: string }>;
        });
      const link = read.nodes.find((node) => node.role === "link" && node.ref !== undefined);
      const pending = b.callTool("click", { tabId: tabB, target: { ref: link?.ref } });
      await panel.waitForText(ui("agent.promptTitle"), 20_000);
      await shoot("sessions");
      await panel.clickButton(ui("agent.refuse"));
      await pending;
      await ok(a, "tabs_close", { tabId: tabA });
      await ok(b, "tabs_close", { tabId: tabB });
    } finally {
      await a?.close();
      await b?.close();
    }
  });
});

async function ok(client: McpHarnessClient, tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const result = await client.callTool(tool, args);
  expect(result.isError, `${tool} failed: ${result.text}\nstderr:\n${client.stderr()}`).toBe(false);
  return result.json;
}
