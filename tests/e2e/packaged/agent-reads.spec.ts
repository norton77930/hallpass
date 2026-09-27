import { Buffer } from "node:buffer";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
 * 003/T038 — US2 end to end: the read tools on the packaged extension (FR-036..FR-039, SC-027).
 *
 * Two claims that only a real browser settles. A ref that `read_page` returned works in `click`,
 * which is what "one way to name an element" means in practice (R-106) - a journey that only
 * checked the shape of the read could not tell whether the two tools agree about what a ref is.
 * And each *kind* of restricted page answers `not-readable` rather than returning something: a
 * browser page, this extension's own page, a `file://` url and a PDF are four different reasons
 * Chrome refuses, and FR-039 says the agent hears one word for all of them.
 *
 * The third claim is the absence: the site is left at its default `ask`, and no prompt ever appears.
 */
test.describe("agent reads", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT,
    "attach mode only: the native-messaging host is a machine install, so the browser under test " +
      "must be one the runner started and pointed at the installed host (HALLPASS_CDP_ENDPOINT).",
  );

  test("reads text, structure and pixels, and calls every restricted page not-readable", async ({
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
      await panel.clickIfPresent(ui("agent.retry"));
      // T098a: the prompt by its own key, Accept clicked, and pairing confirmed by a signal that
      // is false when nothing is paired - the panel's section heading is on screen either way.
      await pairWithFirstCall(live, panel, { locale });

      const call = async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
        const result = await live.callTool(tool, args);
        expect(result.isError, `${tool} failed: ${result.text}\nstderr:\n${live.stderr()}`).toBe(false);
        return result.json;
      };

      const created = (await call("tabs_create", { url: `${SITE}/ordinary` })) as { tabId: number };
      const tabId = created.tabId;

      // ================= get_page_text =================
      const text = (await call("get_page_text", { tabId })) as { text: string; truncated: boolean };
      expect(text.text).toContain("Ordinary page");
      expect(text.text).toContain("A plain document with visible text");
      expect(typeof text.truncated).toBe("boolean");

      // ================= read_page, interactive =================
      const interactive = (await call("read_page", { tabId, filter: "interactive" })) as {
        nodes: Array<{ ref?: string; role: string; name?: string; depth: number }>;
        truncated: boolean;
      };
      // The fixture's own controls: one safe button and one text box, each with a ref and a depth.
      expect(interactive.nodes.map((node) => node.role)).toEqual(
        expect.arrayContaining(["button", "textbox"]),
      );
      const button = interactive.nodes.find((node) => node.role === "button" && node.name === "Safe action");
      expect(button, JSON.stringify(interactive.nodes)).toBeTruthy();
      expect(button?.ref).toBeTruthy();
      expect(button?.depth).toBeGreaterThan(0);

      // ================= a ref from read_page is a ref click understands (R-106) =================
      const ordinary = extensionContext.pages().find((page) => page.url() === `${SITE}/ordinary`);
      expect(ordinary, "the agent's tab is not in this context").toBeTruthy();
      if (!ordinary) throw new Error("agent-tab-missing");
      // The site is still at its default `ask`, so this one call is the *only* thing in the journey
      // that may prompt - and the owner allows it, which is what proves the ref itself was good.
      const clicking = live.callTool("click", { tabId, target: { ref: button?.ref } });
      await panel.waitForText(ui("agent.promptTitle"));
      await panel.clickButton(ui("agent.allowOnce"));
      const clicked = await clicking;
      expect(clicked.isError, clicked.text).toBe(false);
      await expect(ordinary.locator("#clicked")).not.toHaveText("not clicked yet");

      // ================= read_page rooted at a ref, and bounded by depth =================
      const rooted = (await call("read_page", { tabId, filter: "all", ref: button?.ref })) as {
        nodes: Array<{ role: string }>;
      };
      // The button is a leaf, so rooting there is the smallest possible read - never the whole page.
      expect(rooted.nodes.length).toBeLessThan(interactive.nodes.length + 1);
      const shallow = (await call("read_page", { tabId, depth: 1 })) as {
        nodes: Array<{ depth: number }>;
        truncated: boolean;
      };
      expect(shallow.nodes.every((node) => node.depth <= 1)).toBe(true);

      // ================= find still answers with refs, roles and names =================
      const found = (await call("find", { tabId, query: "Safe action" })) as {
        outcome: string;
        matches: Array<{ ref: string; role?: string; label?: string }>;
      };
      expect(found.outcome).toBe("resolved");
      expect(found.matches[0]?.role).toBe("button");

      // ================= screenshot =================
      const shot = await live.callTool("screenshot", { tabId });
      expect(shot.isError, shot.text).toBe(false);
      expect(shot.images).toHaveLength(1);
      expect(shot.images[0]?.mimeType).toBe("image/png");
      // A real PNG, not an empty block: the base64 of the 8-byte PNG signature.
      expect(shot.images[0]?.data.startsWith("iVBORw0KGgo")).toBe(true);

      const cropped = await live.callTool("screenshot", {
        tabId,
        region: { x: 0, y: 0, width: 200, height: 120 },
      });
      expect(cropped.isError, cropped.text).toBe(false);
      expect(cropped.images[0]?.data.length).toBeLessThan(shot.images[0]?.data.length ?? 0);

      // ================= SC-027: every kind of restricted page =================
      const restricted: Array<[string, string]> = [
        ["a browser page", "chrome://version"],
        ["this extension's own page", `chrome-extension://${extensionId}/side-panel.html`],
        ["a file url", fileUrlOfProvenance()],
        ["a pdf", `${SITE}/manual.pdf`],
      ];
      for (const [what, url] of restricted) {
        const opened = (await call("tabs_create", { url })) as { tabId: number };
        const read = await live.callTool("get_page_text", { tabId: opened.tabId });
        expect(read.isError, `${what} (${url}) was read: ${read.text}`).toBe(true);
        expect(read.json, `${what} (${url})`).toMatchObject({ outcome: "not-readable" });
        const structure = await live.callTool("read_page", { tabId: opened.tabId });
        expect(structure.json, `${what} (${url}) structure`).toMatchObject({ outcome: "not-readable" });
        await call("tabs_close", { tabId: opened.tabId });
      }

      // ================= reading never asked the owner anything =================
      // One prompt appeared in this whole journey and it belonged to the single `click` above.
      expect(await panel.panelText()).not.toContain(ui("agent.promptTitle"));

      await call("tabs_close", { tabId });
    } finally {
      await client?.close();
    }
  });

  /**
   * 012/T317 step 6 — the picture an agent asked to be smaller (FR-162, SC-089).
   *
   * Nothing is emulated here: this is the ordinary path every screenshot took before 012, with one
   * argument added, and the claim is that the argument is honoured in the picture's own pixels and
   * reported back. `frame` is the tab's real content area, which is what makes a `region` on this
   * path something the agent can compute - and the reason it rides on every answer, not only on the
   * emulated ones.
   */
  test("takes a plain screenshot at half scale and says what it is a picture of", async ({
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
      await panel.clickIfPresent(ui("agent.retry"));
      await pairWithFirstCall(live, panel, { locale });

      const created = await live.callTool("tabs_create", { url: `${SITE}/ordinary` });
      expect(created.isError, created.text).toBe(false);
      const tabId = (created.json as { tabId: number }).tabId;

      const whole = await live.callTool("screenshot", { tabId });
      expect(whole.isError, whole.text).toBe(false);
      const wholeAnswer = whole.json as { frame: { width: number; height: number }; coverage: string };
      expect(wholeAnswer.coverage).toBe("viewport");
      // The real tab, not an emulated frame: no session gave this tab a viewport.
      expect(wholeAnswer.frame.width).toBeGreaterThan(0);

      const half = await live.callTool("screenshot", { tabId, scale: 0.5 });
      expect(half.isError, half.text).toBe(false);
      expect(half.json).toMatchObject({ scale: 0.5, coverage: "viewport", frame: wholeAnswer.frame });

      const full = pngSize(whole.images[0]?.data ?? "");
      const smaller = pngSize(half.images[0]?.data ?? "");
      expect(smaller).toEqual({
        width: Math.max(Math.round(full.width * 0.5), 1),
        height: Math.max(Math.round(full.height * 0.5), 1),
      });

      await live.callTool("tabs_close", { tabId });
    } finally {
      await client?.close();
    }
  });
});

/** The image's own pixels, from the PNG header: IHDR carries width and height at bytes 16 to 23. */
function pngSize(base64: string): { width: number; height: number } {
  const header = Buffer.from(base64.slice(0, 44), "base64");
  expect(header.length, "a PNG header is 24 bytes").toBeGreaterThanOrEqual(24);
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

/** A file the repository certainly has, as a `file://` url - one of FR-039's restricted kinds. */
function fileUrlOfProvenance(): string {
  const path = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..", "README.md");
  return pathToFileURL(path).href;
}

