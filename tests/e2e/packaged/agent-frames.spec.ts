import { lookup } from "../../../apps/extension/src/locales/catalog.js";
import { startMcpClient, type McpHarnessClient } from "../../harness/mcp-client.js";
import { pairWithFirstCall } from "../fixtures/agent-pairing.js";
import { copyFor, localeFromEnv, openSidePanel } from "../fixtures/side-panel-driver.js";
import { expect, test } from "../fixtures/packaged-extension.js";

const locale = localeFromEnv();
const copy = copyFor(locale);
const ui = (key: string): string => lookup(key, locale);

const SITE = "https://127.0.0.1:19443";
/** The sibling fixture port `frames.html` frames: a *real* second origin, not a second path. */
const CROSS_SITE = "https://127.0.0.1:19445";

/**
 * 004/T116 — a framed page is one page (US4 read half, R-114, FR-063).
 *
 * The unit tests model the frame tree; only a real browser settles whether the three read tools
 * actually reach a document Chrome keeps behind an origin boundary. `frames.html` is the shape the
 * gap was found on: a same-origin child that itself frames a grandchild, and a child on a second
 * origin, which is what the claude.ai artifact page is - the content the owner opened the page for,
 * in a frame the top document cannot see into.
 *
 * What is asserted is the read half only. Acting inside a frame is S4's; nothing here clicks.
 *
 * **A frame the browser forbids is not asserted here, and the reason is the fixture's.** A web page
 * cannot frame a `chrome://` url - Chrome refuses to load it and no frame with that url ever
 * exists - and this extension declares no web-accessible resources, so it cannot frame one of its
 * own pages either; the narrow manifest is the point of that. Manufacturing either would be a
 * fixture that lies about what a browser does. The `not-allowed` listing is settled at unit level
 * instead (`frame-merge.test.ts`: a forbidden scheme is listed unreadable *before* it is asked, and
 * the page still answers with every other frame).
 */
test.describe("agent frames", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT,
    "attach mode only: the native-messaging host is a machine install, so the browser under test " +
      "must be one the runner started and pointed at the installed host (HALLPASS_CDP_ENDPOINT).",
  );

  test("reads every frame of a framed page, cross-origin child included", async ({
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
    await panel.waitForText(ui("agent.appTitle"));

    let client: McpHarnessClient | undefined;
    try {
      client = await startMcpClient({ clientName: "Claude Code" });
      const live = client;
      await panel.clickIfPresent(ui("agent.retry"));
      await pairWithFirstCall(client, panel, { locale });

      const call = async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
        const result = await live.callTool(tool, args);
        expect(result.isError, `${tool} failed: ${result.text}\nstderr:\n${live.stderr()}`).toBe(false);
        return result.json;
      };

      const created = (await call("tabs_create", { url: `${SITE}/frames` })) as { tabId: number };
      const tabId = created.tabId;

      // ================= 1. read_page lists every frame, and every frame's controls =================
      const structure = (await call("read_page", { tabId, filter: "interactive" })) as {
        frames?: Array<{ frame: string; parent: string; url: string; readable: boolean; reason?: string }>;
        nodes: Array<{ ref?: string; role: string; name?: string; frame?: string }>;
        truncated: boolean;
      };
      const frames = structure.frames ?? [];
      // Four documents: the top one, the same-origin child, its grandchild, and the cross-origin
      // child. The labels are the answer's own (`0`, `f1`…), never Chrome's frame ids.
      expect(frames.map((frame) => frame.frame), JSON.stringify(frames)).toEqual(
        expect.arrayContaining(["0", "f1", "f2", "f3"]),
      );
      expect(frames.every((frame) => frame.readable), JSON.stringify(frames)).toBe(true);
      const crossFrame = frames.find((frame) => frame.url.startsWith(CROSS_SITE));
      expect(crossFrame, `no frame on the second origin: ${JSON.stringify(frames)}`).toBeTruthy();

      const named = (name: string) => structure.nodes.find((node) => node.name === name);
      // Each child's and the grandchild's controls, each carrying the frame it was found in - the
      // whole capability gap 003 had, in one assertion.
      for (const name of ["Top action", "Child action", "Grandchild action"]) {
        const node = named(name);
        expect(node, `${name} is missing: ${JSON.stringify(structure.nodes)}`).toBeTruthy();
        expect(node?.ref, `${name} has no ref`).toBeTruthy();
      }
      expect(named("Top action")?.frame ?? "0").toBe("0");
      // The same-origin child and the grandchild are different documents and say so.
      expect(named("Child action")?.frame).not.toBe(named("Top action")?.frame ?? "0");
      expect(named("Grandchild action")?.frame).not.toBe(named("Child action")?.frame);
      // The cross-origin child is *read*, not listed as the frame that said nothing.
      const crossAction = named("Child action") && structure.nodes.filter((node) => node.name === "Child action");
      expect(crossAction?.length, "the cross-origin child's button is missing").toBeGreaterThan(1);
      expect(crossFrame?.readable).toBe(true);

      // ================= 2. get_page_text includes the children's text =================
      const text = (await call("get_page_text", { tabId })) as { text: string; truncated: boolean };
      expect(text.text).toContain("Frames fixture");
      expect(text.text, "the same-origin child's text is missing").toContain("Child frame");
      expect(text.text, "the grandchild's text is missing").toContain("Grandchild frame");
      // The result shape is the one it always had: a string and whether it was cut, no frame list.
      expect(Object.keys(text).sort()).toEqual(["text", "truncated"]);

      // ================= 3. find resolves a description only a child frame holds =================
      const found = (await call("find", { tabId, query: "Grandchild action" })) as {
        outcome: string;
        matches: Array<{ ref: string; role?: string; label?: string; frame?: string }>;
      };
      expect(found.outcome, JSON.stringify(found)).toBe("resolved");
      expect(found.matches[0]?.role).toBe("button");
      // The match names the document it lives in, which is what makes the ref usable.
      expect(found.matches[0]?.frame, JSON.stringify(found.matches)).toBe(named("Grandchild action")?.frame);

      // ================= reading never asked the owner anything =================
      expect(await panel.panelText()).not.toContain(ui("agent.promptTitle"));

      await call("tabs_close", { tabId });
    } finally {
      await client?.close();
    }
  });
});
