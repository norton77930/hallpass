import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { lookup } from "../../../apps/extension/src/locales/catalog.js";
import { startMcpClient, type McpHarnessClient } from "../../harness/mcp-client.js";
import { pairWithFirstCall } from "../fixtures/agent-pairing.js";
import { copyFor, localeFromEnv, openSidePanel, waitForAgentPanel, type SidePanelDriver } from "../fixtures/side-panel-driver.js";
import { expect, test, type PackagedWorker } from "../fixtures/packaged-extension.js";

/**
 * 015 SC-112 (FR-210 - FR-215, contracts/batch-upload.md, T413): uploads are ordinary batch steps.
 *
 * What only a packaged run can show is the whole chain for a batch: the *host* checks every upload
 * step before anything crosses (the same `prepareUpload` a standalone call goes through), asks the
 * owner on their panel when a file is outside their directories, rewrites the steps into bytes, and
 * only then does the *worker* run the batch - so the page's own handlers are the evidence of what
 * ran, and a refusal is proven by a page that was never touched.
 *
 *   1. type + an allowed file + a screenshot taken before the batch + submit: all four land, and
 *      the page's submit handler reports the subject and both files;
 *   2. a file outside the allowed directories: the directory card is raised by the batch; "these
 *      files this time" lets the batch run; the same batch again, refused, answers
 *      `step 2: upload-declined` and step 1 - the typing - never happened;
 *   3. a screenshot taken *inside* the batch cannot be uploaded by the same batch: the id is refused
 *      with the later-call hint, and nothing ran.
 *
 * The owner's list of allowed directories is the machine's (`%LOCALAPPDATA%\hallpass\config.json`),
 * so each journey saves it, writes its own, and puts the owner's file back in `finally` - exactly as
 * agent-upload-directory.spec.ts does.
 *
 * Attach mode only, like every `agent-*` journey. Prerequisites: `npm run build`, `dist/agent`
 * loaded, `npm run agent-host:install` from this checkout, and the fixture services restarted
 * (the `/batch-upload` page is new in 015; a stale fixture server serves the old page list).
 */
const locale = localeFromEnv();
const copy = copyFor(locale);
const ui = (key: string): string => lookup(key, locale);

const SITE = "https://127.0.0.1:19443";
const FIXTURE = `${SITE}/batch-upload`;
/** `BATCH_UPLOAD_HINTS.laterCall` in mcp-server.ts, spelled out: importing that module starts a server. */
const LATER_CALL_HINT = "A screenshot taken inside this batch can be uploaded in a later call.";

type BatchAnswer = { results: Array<{ index: number; outcome: string; reason?: string }> };

test.describe("015 uploads inside a batch", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT,
    "attach mode only: the native-messaging host is a machine install, so the browser under test " +
      "must be one the runner started and pointed at the installed host (HALLPASS_CDP_ENDPOINT).",
  );

  test("types, uploads an allowed file and a pre-batch screenshot, and submits - in one batch (SC-112)", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(300_000);
    await withUploadRoots(async ({ allowedRoot, configPath }) => {
      const allowedFile = join(allowedRoot, "allowed.txt");
      await writeFile(allowedFile, "allowed-by-the-owner", "utf8");
      await writeFile(configPath, JSON.stringify({ uploadRoots: [allowedRoot] }, null, 2), "utf8");

      const { panel, client, call } = await pairedSession({ extensionContext, extensionId, extensionWorker });
      try {
        const tabId = ((await call("tabs_create", { url: FIXTURE })) as { tabId: number }).tabId;
        await setSiteMode(panel, SITE, "skip-checks");
        const page = await agentPage(extensionContext, FIXTURE);

        // The picture is taken *before* the batch, which is the only way an agent can hold its id.
        const shot = await client.callTool("screenshot", { tabId });
        expect(shot.isError, `screenshot failed: ${shot.text}`).toBe(false);
        const imageId = (shot.json as { imageId: string }).imageId;
        const size = Buffer.from(shot.images[0]!.data, "base64").length;
        const refs = await refsByName(call, tabId);

        const answer = await client.callTool("browser_batch", {
          tabId,
          steps: [
            { tool: "type", args: { target: { ref: refs("Subject") }, text: "batch-typed" } },
            { tool: "file_upload", args: { ref: refs("Attachment"), paths: [allowedFile] } },
            { tool: "upload_image", args: { imageId, ref: refs("Picture") } },
            { tool: "click", args: { target: { ref: refs("Send") } } },
          ],
        });
        expect(answer.isError, `batch failed: ${answer.text}\nstderr:\n${client.stderr()}`).toBe(false);
        const results = (answer.json as BatchAnswer).results;
        expect(results.map((step) => step.outcome), JSON.stringify(results)).toEqual(["ok", "ok", "ok", "ok"]);

        // Read off the page's own handlers: each input's `change`, then the submit, which saw all three.
        await expect(page.locator("#attachment-report")).toHaveText("allowed.txt:20");
        await expect(page.locator("#picture-report")).toHaveText(`screenshot.png:${size}:image/png`);
        await expect(page.locator("#received")).toHaveText(
          `subject=batch-typed; attachment=allowed.txt:20; picture=screenshot.png:${size}`,
        );
        // Inside the owner's list, so nobody was asked.
        expect(await directoryCardUp(panel), "a file inside the owner's list raised a card").toBe(false);

        await closeTab(extensionWorker, tabId);
      } finally {
        await client.close().catch(() => undefined);
      }
    });
  });

  test("asks about a file outside the directories before the batch runs: once runs it, refuse runs nothing (SC-112)", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(300_000);
    await withUploadRoots(async ({ allowedRoot, privateDir, configPath }) => {
      const privateFile = join(privateDir, "diary.txt");
      await writeFile(privateFile, "not for the agent", "utf8");
      await writeFile(configPath, JSON.stringify({ uploadRoots: [allowedRoot] }, null, 2), "utf8");

      const { panel, client, call } = await pairedSession({ extensionContext, extensionId, extensionWorker });
      try {
        const tabId = ((await call("tabs_create", { url: FIXTURE })) as { tabId: number }).tabId;
        await setSiteMode(panel, SITE, "skip-checks");
        const batchOf = (refs: (name: string) => string, text: string): Record<string, unknown> => ({
          tabId,
          steps: [
            { tool: "type", args: { target: { ref: refs("Subject") }, text } },
            { tool: "file_upload", args: { ref: refs("Attachment"), paths: [privateFile] } },
            { tool: "click", args: { target: { ref: refs("Send") } } },
          ],
        });

        // ============ "these files this time": the batch runs, and the list is untouched ============
        let page = await agentPage(extensionContext, FIXTURE);
        const onceBatch = client.callTool("browser_batch", batchOf(await refsByName(call, tabId), "allowed-once"));
        await waitForDirectoryCard(panel, privateFile);
        // Asked before any step ran: the typing is step 1, and the page has not seen it.
        await expect(page.locator('input[name="subject"]')).toHaveValue("");
        await panel.clickButton(ui("agent.uploadOnce"));
        const once = await onceBatch;
        expect(once.isError, `batch failed: ${once.text}\nstderr:\n${client.stderr()}`).toBe(false);
        expect((once.json as BatchAnswer).results.map((step) => step.outcome)).toEqual(["ok", "ok", "ok"]);
        await expect(page.locator("#received")).toHaveText("subject=allowed-once; attachment=diary.txt:17; picture=none");
        expect(await rootsInFile(configPath)).toEqual([allowedRoot]);

        // A fresh copy of the form, so "nothing ran" is read off a page nothing has touched.
        await call("navigate", { tabId, url: FIXTURE });
        page = await agentPage(extensionContext, FIXTURE);
        await expect(page.locator("#received")).toHaveText("nothing submitted yet");

        // ============ refused: the batch answers the step, and no step ran ============
        const refusedBatch = client.callTool("browser_batch", batchOf(await refsByName(call, tabId), "never-typed"));
        // "Once" was about those files on that call: the same file is asked about again (FR-194).
        await waitForDirectoryCard(panel, privateFile);
        await panel.clickButton(ui("agent.uploadDecline"));
        const refused = await refusedBatch;
        expect(refused.isError, `text: ${refused.text}`).toBe(true);
        expect(answerOf(refused), `text: ${refused.text}`).toMatchObject({
          outcome: "denied",
          reason: "step 2: upload-declined",
        });
        await expect(page.locator('input[name="subject"]')).toHaveValue("");
        await expect(page.locator("#attachment-report")).toHaveText("no file chosen");
        await expect(page.locator("#received")).toHaveText("nothing submitted yet");
        expect(await rootsInFile(configPath)).toEqual([allowedRoot]);
        expect(await directoryCardUp(panel), "the answered card is still on the panel").toBe(false);

        await closeTab(extensionWorker, tabId);
      } finally {
        await client.close().catch(() => undefined);
      }
    });
  });

  test("refuses a screenshot id from the same batch with the later-call hint, and runs nothing (SC-112)", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(300_000);
    const { panel, client, call } = await pairedSession({ extensionContext, extensionId, extensionWorker });
    try {
      const tabId = ((await call("tabs_create", { url: FIXTURE })) as { tabId: number }).tabId;
      await setSiteMode(panel, SITE, "skip-checks");
      const page = await agentPage(extensionContext, FIXTURE);
      const refs = await refsByName(call, tabId);

      // The id an agent would *expect* the screenshot step to hand out. It cannot know it, because
      // the step has not run when the host checks the batch - so it is one this session never issued.
      const refused = await client.callTool("browser_batch", {
        tabId,
        steps: [
          { tool: "type", args: { target: { ref: refs("Subject") }, text: "never-typed" } },
          { tool: "screenshot", args: {} },
          { tool: "upload_image", args: { imageId: "img_0123456789", ref: refs("Picture") } },
          { tool: "click", args: { target: { ref: refs("Send") } } },
        ],
      });
      expect(refused.isError, `text: ${refused.text}`).toBe(true);
      const answer = answerOf(refused) as { outcome?: string; reason?: string; hint?: string };
      expect(answer.outcome, `text: ${refused.text}`).toBe("denied");
      expect(answer.reason, `text: ${refused.text}`).toMatch(/^step 3: unknown-image-id/);
      expect(answer.hint ?? "", `text: ${refused.text}`).toContain(LATER_CALL_HINT);
      // Refused before the batch crossed: not even the typing of step 1 reached the page.
      await expect(page.locator('input[name="subject"]')).toHaveValue("");
      await expect(page.locator("#picture-report")).toHaveText("no file chosen");
      await expect(page.locator("#received")).toHaveText("nothing submitted yet");

      await closeTab(extensionWorker, tabId);
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});

/**
 * The owner's allowed-directory list for one journey: saved, replaced, and put back.
 *
 * Every directory is resolved, because the host resolves them and shows the owner `realpath`'s
 * spelling on the card (Windows hands out temp directories under the 8.3 short profile name).
 */
async function withUploadRoots(
  body: (dirs: { allowedRoot: string; privateDir: string; configPath: string }) => Promise<void>,
): Promise<void> {
  const dataDir = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "hallpass");
  const configPath = join(dataDir, "config.json");
  const savedConfig = existsSync(configPath) ? await readFile(configPath, "utf8") : undefined;
  const allowedRoot = await realpath(await mkdtemp(join(tmpdir(), "hallpass-batch-allowed-")));
  const privateDir = await realpath(await mkdtemp(join(tmpdir(), "hallpass-batch-private-")));
  try {
    // Inside the try: from the first write on, the owner's own file is restored on every exit.
    await mkdir(dataDir, { recursive: true });
    await body({ allowedRoot, privateDir, configPath });
  } finally {
    if (savedConfig === undefined) await rm(configPath, { force: true });
    else await writeFile(configPath, savedConfig, "utf8");
    for (const directory of [allowedRoot, privateDir]) await rm(directory, { recursive: true, force: true });
  }
}

async function pairedSession(fixtures: {
  extensionContext: BrowserContext;
  extensionId: string;
  extensionWorker: PackagedWorker;
}): Promise<{ panel: SidePanelDriver; client: McpHarnessClient; call: (tool: string, args?: Record<string, unknown>) => Promise<unknown> }> {
  const { extensionContext, extensionId, extensionWorker } = fixtures;
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
  const client = await startMcpClient({ clientName: "Claude Code" });
  await panel.clickIfPresent(ui("agent.retry"));
  await pairWithFirstCall(client, panel, { locale, timeoutMs: 45_000 });
  const call = async (tool: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const result = await client.callTool(tool, args);
    expect(result.isError, `${tool} failed: ${result.text}\nstderr:\n${client.stderr()}`).toBe(false);
    return result.json;
  };
  return { panel, client, call };
}

/**
 * Every ref from one structural read, looked up by name: a batch's refs must all be live when it is
 * sent, and a second read would invalidate the first's (agent-batch-wait.spec.ts).
 */
async function refsByName(
  call: (tool: string, args?: Record<string, unknown>) => Promise<unknown>,
  tabId: number,
): Promise<(name: string) => string> {
  const page = (await call("read_page", { tabId, filter: "all" })) as {
    nodes: Array<{ ref?: string; role: string; name?: string }>;
  };
  return (name: string): string => {
    const node = page.nodes.find((candidate) => candidate.name === name && candidate.ref !== undefined);
    expect(node, `read_page offered no ref named '${name}': ${JSON.stringify(page.nodes)}`).toBeTruthy();
    return node?.ref as string;
  };
}

/** The host answers a call as JSON text; a non-JSON answer is reported as what it was. */
function answerOf(result: { text: string; json?: unknown }): unknown {
  try {
    return JSON.parse(result.text) as unknown;
  } catch {
    return result.json ?? { unparsed: result.text };
  }
}

/** The owner's list as the *host's* file has it, which is the only authority on it. */
async function rootsInFile(configPath: string): Promise<string[]> {
  const raw = await readFile(configPath, "utf8").catch(() => "{}");
  const parsed = JSON.parse(raw) as { uploadRoots?: unknown };
  return Array.isArray(parsed.uploadRoots) ? (parsed.uploadRoots as string[]) : [];
}

async function directoryCardUp(panel: SidePanelDriver): Promise<boolean> {
  return (await panel.evaluatePanel("document.querySelector('[data-prompt=upload-directory]') !== null")) === true;
}

/** The card, naming the owner's own path in full. */
async function waitForDirectoryCard(panel: SidePanelDriver, path: string): Promise<void> {
  await panel.waitForText(ui("agent.prompt.uploadDirectory").replace("{agent}", "Claude Code"));
  await panel.waitForText(path);
}

async function setSiteMode(panel: SidePanelDriver, site: string, mode: string): Promise<void> {
  await panel.waitForText(site);
  const set = await panel.evaluatePanel(
    `(()=>{const site=${JSON.stringify(site)};const rows=[...document.querySelectorAll('li')];` +
      `const row=rows.find((r)=>r.textContent?.includes(site)&&r.querySelector('select'));const sel=row?.querySelector('select');` +
      `if(!sel)return false;const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;` +
      `setter.call(sel,${JSON.stringify(mode)});sel.dispatchEvent(new Event('change',{bubbles:true}));return true})()`,
    true,
  );
  expect(set, `the panel offers no mode control for ${site}`).toBe(true);
}

async function closeTab(worker: PackagedWorker, tabId: number): Promise<void> {
  await worker.evaluate(async (id: number) => {
    await chrome.tabs.remove(id).catch(() => undefined);
  }, tabId);
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
