import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { lookup } from "../../../apps/extension/src/locales/catalog.js";
import { startMcpClient, type McpHarnessClient } from "../../harness/mcp-client.js";
import { acceptPairing } from "../fixtures/agent-pairing.js";
import { copyFor, localeFromEnv, openSidePanel, type SidePanelDriver } from "../fixtures/side-panel-driver.js";
import { expect, test } from "../fixtures/packaged-extension.js";

const locale = localeFromEnv();
const copy = copyFor(locale);
const ui = (key: string): string => lookup(key, locale);

const SITE = "https://127.0.0.1:19443";

/**
 * 003/T064 — US7 end to end: one of the owner's files into a page (FR-051).
 *
 * The claim is the boundary. The agent names a *path*; the host - the owner's own process - decides
 * whether that path is inside a directory the owner listed, reads it there, and sends bytes. So the
 * two halves asserted here are: an allowed file arrives, and the page itself says which file and how
 * big it is; and a path outside every root is refused with nothing read, which is checked through
 * the host's own stable log code rather than through a spy, because the point is that the *host*
 * refused it before opening anything.
 *
 * The configuration is the machine's, so this journey saves it, points the roots at a directory it
 * made, and puts the owner's own file back afterwards.
 *
 * Attach mode only: the bridge is a machine install and a browser this gate launched itself would
 * prove nothing about it.
 *
 * Prerequisites: `npm run build:extension:agent`, `dist/agent` loaded in the attached browser,
 * `npm run agent-host:install`, and the three test services running (ports 18786/18787/19443).
 */
test.describe("agent file upload", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT,
    "attach mode only: the native-messaging host is a machine install, so the browser under test " +
      "must be one the runner started and pointed at the installed host (HALLPASS_CDP_ENDPOINT).",
  );

  test("uploads a file from an allowed root and refuses one from outside every root", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(240_000);

    const permissions = await extensionWorker.evaluate(() => chrome.runtime.getManifest().permissions ?? []);
    expect(
      permissions,
      "the attached browser must have apps/extension/dist/agent loaded (npm run build:extension:agent)",
    ).toContain("nativeMessaging");
    // US7 needs no permission of its own: the host reads the files (FR-051). The `downloads`
    // permission the agent build carries since 005 belongs to download *observation* (005/FR-076,
    // D-005-2) and plays no part in uploading; the release-build contract test pins the exact list.

    const dataDir = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "hallpass");
    const configPath = join(dataDir, "config.json");
    const savedConfig = existsSync(configPath) ? await readFile(configPath, "utf8") : undefined;
    const allowedRoot = await mkdtemp(join(tmpdir(), "hallpass-upload-root-"));
    const privateDir = await mkdtemp(join(tmpdir(), "hallpass-upload-private-"));
    const allowedFile = join(allowedRoot, "receipt.txt");
    const privateFile = join(privateDir, "diary.txt");
    await writeFile(allowedFile, "agent-upload-fixture", "utf8");
    await writeFile(privateFile, "not for the agent", "utf8");

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
      // Inside the try, because this overwrites a file that belongs to the owner (003/C6): from
      // here on, every exit runs the `finally` that puts their own roots back.
      await mkdir(dataDir, { recursive: true });
      await writeFile(configPath, JSON.stringify({ uploadRoots: [allowedRoot] }, null, 2), "utf8");

      client = await startMcpClient({ clientName: "Claude Code" });
      const live = client;
      await panel.clickIfPresent(ui("agent.retry"));
      // T098a: the prompt by its own key, Accept clicked, and pairing confirmed by a signal that
      // is false when nothing is paired - the panel's section heading is on screen either way.
      await acceptPairing(panel, { locale });

      const created = (await ok(live, "tabs_create", { url: `${SITE}/form` })) as { tabId: number };
      const tabId = created.tabId;
      await setSiteMode(panel, SITE, "skip-checks");
      const form = await agentPage(extensionContext, `${SITE}/form`);

      const page = (await ok(live, "read_page", { tabId, filter: "all" })) as {
        nodes: Array<{ ref?: string; role: string; name?: string }>;
      };
      // By role, not by name (003/C2): what the upload needs is a file input, and the read says so
      // in its own word rather than leaving it to look like any other text control.
      const input = page.nodes.find((node) => node.role === "file" && node.ref !== undefined);
      expect(input, `read_page offered no ref for the file input: ${JSON.stringify(page.nodes)}`).toBeTruthy();

      // ================= a file inside the owner's allowed root =================
      const uploaded = (await ok(live, "file_upload", {
        tabId,
        ref: input?.ref,
        paths: [allowedFile],
      })) as { files: Array<{ name: string; size: number }> };

      expect(uploaded.files).toEqual([{ name: "receipt.txt", size: 20 }]);
      // The page itself says so, through its own `change` handler: the answer above is evidence
      // rather than an echo of the request.
      await expect(form.locator("#uploaded")).toHaveText("receipt.txt:20");

      // ================= a file outside every root =================
      const refused = await live.callTool("file_upload", {
        tabId,
        ref: input?.ref,
        paths: [privateFile],
      });

      expect(refused.isError).toBe(true);
      expect(refused.json).toMatchObject({ outcome: "denied", reason: "upload-not-allowed" });
      // The host refused it before opening anything, and said which rule did - a code, never the
      // path, because a log that named the owner's files would be the disclosure this rule prevents.
      expect(live.stderr()).toContain("agent.upload.refused outside-roots");
      expect(live.stderr()).not.toContain("diary");
      // And the page still holds only the file that was allowed.
      await expect(form.locator("#uploaded")).toHaveText("receipt.txt:20");

      await ok(live, "tabs_close", { tabId });
    } finally {
      await client?.close();
      if (savedConfig === undefined) await rm(configPath, { force: true });
      else await writeFile(configPath, savedConfig, "utf8");
      await rm(allowedRoot, { recursive: true, force: true });
      await rm(privateDir, { recursive: true, force: true });
    }
  });
});

/** Calls a tool and fails loudly with the host's own stderr when it did not answer `ok`. */
async function ok(client: McpHarnessClient, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await client.callTool(tool, args);
  expect(result.isError, `${tool} failed: ${result.text}\nmcp-server stderr:\n${client.stderr()}`).toBe(false);
  return result.json;
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
    .poll(async () =>
      panel.evaluatePanel(
        `(()=>{const site=${JSON.stringify(site)};const rows=[...document.querySelectorAll('li')];` +
          `const row=rows.find((r)=>r.textContent?.includes(site));return row?.querySelector('select')?.value ?? null})()`,
      ),
      { timeout: 15_000 },
    )
    .toBe(mode);
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
