import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { lookup } from "../../../apps/extension/src/locales/catalog.js";
import { UPLOAD_CONFIG_TEMPLATE } from "../../../packages/agent-host/src/upload-policy.js";
import { startMcpClient, type McpHarnessClient } from "../../harness/mcp-client.js";
import { acceptPairing } from "../fixtures/agent-pairing.js";
import { copyFor, localeFromEnv, openSidePanel, type SidePanelDriver } from "../fixtures/side-panel-driver.js";
import { expect, test, type PackagedWorker } from "../fixtures/packaged-extension.js";

const locale = localeFromEnv();
const copy = copyFor(locale);
const ui = (key: string): string => lookup(key, locale);

const SITE = "https://127.0.0.1:19443";

/**
 * 014/T383 — US4 end to end: a file from a directory nobody allowed (SC-104, SC-105).
 *
 * The claim is a chain of three processes and it cannot be proved anywhere but here: the *host*
 * holds a call it would have refused, asks over the link, the *worker* raises a card on the owner's
 * panel, the owner answers, and only then does anything read a file. Every decision below is made
 * by clicking the panel's own buttons, and every consequence is read where it actually lives - the
 * agent's answer, the page's own `change` handler, and the host's `config.json` on disk.
 *
 * The list of allowed directories is the machine's, so this journey saves it, starts from the
 * empty template the installer writes, and puts the owner's own file back afterwards.
 *
 * Attach mode only, for the reason every agent journey is: the bridge is a machine install.
 *
 * Prerequisites: `npm run build`, `dist/agent` loaded in the attached browser,
 * `npm run agent-host:install` **from this checkout** - the relay Chrome spawns is what answers
 * the panel's directory rows (`upload-roots-list`), so a registration pointing at an older build
 * leaves checks 1 and 6 with no rows to read - and the fixture services running (18786/18787/
 * 19443-19445).
 *
 * `HALLPASS_UPLOAD_CONSENT_BOUND_MS` shortens the host's own wait for the owner's answer, for
 * check 4 alone: the product's bound is 125 s and a journey cannot sit through it.
 */
test.describe("agent upload directory", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT,
    "attach mode only: the native-messaging host is a machine install, so the browser under test " +
      "must be one the runner started and pointed at the installed host (HALLPASS_CDP_ENDPOINT).",
  );

  test("asks the owner about a file outside their directories, and remembers only what they said", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(600_000);

    const permissions = await extensionWorker.evaluate(() => chrome.runtime.getManifest().permissions ?? []);
    expect(
      permissions,
      "the attached browser must have apps/extension/dist/agent loaded (npm run build)",
    ).toContain("nativeMessaging");

    const dataDir = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "hallpass");
    const configPath = join(dataDir, "config.json");
    const savedConfig = existsSync(configPath) ? await readFile(configPath, "utf8") : undefined;
    /**
     * Every directory resolved, because the host resolves them: the card shows the owner the path
     * `realpath` answers, and Windows hands out a temp directory under the short 8.3 spelling of
     * the profile. A gate comparing the two spellings would be testing the operating system.
     */
    const temp = async (prefix: string): Promise<string> => realpath(await mkdtemp(join(tmpdir(), prefix)));
    /** The one directory the owner has already allowed, for check 5. */
    const allowedRoot = await temp("hallpass-dir-allowed-");
    /** Everything else: outside every root until the owner says otherwise. */
    const privateDir = await temp("hallpass-dir-private-");
    const docsDir = await temp("hallpass-dir-docs-");
    const photosDir = await temp("hallpass-dir-photos-");
    const notesDir = await temp("hallpass-dir-notes-");
    const allowedFile = join(allowedRoot, "allowed.txt");
    const privateFile = join(privateDir, "diary.txt");
    const secondPrivateFile = join(privateDir, "letter.txt");
    const docsFile = join(docsDir, "receipt.txt");
    const docsSibling = join(docsDir, "invoice.txt");
    const photosFile = join(photosDir, "holiday.txt");
    const notesFile = join(notesDir, "list.txt");
    for (const [path, body] of [
      [allowedFile, "allowed-by-the-owner"],
      [privateFile, "not for the agent"],
      [secondPrivateFile, "also not for the agent"],
      [docsFile, "a receipt"],
      [docsSibling, "an invoice"],
      [photosFile, "a holiday"],
      [notesFile, "a list"],
    ] as const) {
      await writeFile(path, body, "utf8");
    }

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
    let impatient: McpHarnessClient | undefined;
    try {
      // Inside the try, because this overwrites a file that belongs to the owner: from here on
      // every exit runs the `finally` that puts their own list back.
      await mkdir(dataDir, { recursive: true });
      // The template the installer writes: an installation nobody has configured allows nothing.
      await writeFile(configPath, UPLOAD_CONFIG_TEMPLATE, "utf8");

      client = await startMcpClient({ clientName: "Claude Code" });
      const live = client;
      await panel.clickIfPresent(ui("agent.retry"));
      await acceptPairing(panel, { locale, timeoutMs: 45_000 });

      const tabId = ((await ok(live, "tabs_create", { url: `${SITE}/form` })) as { tabId: number }).tabId;
      await setSiteMode(panel, SITE, "skip-checks");
      const form = await agentPage(extensionContext, `${SITE}/form`);
      const ref = await fileInputRef(live, tabId);

      // ============ (5) a file inside the list is not asked about at all ============
      await writeFile(configPath, JSON.stringify({ uploadRoots: [allowedRoot] }, null, 2), "utf8");
      const inside = (await ok(live, "file_upload", { tabId, ref, paths: [allowedFile] })) as {
        files: Array<{ name: string; size: number }>;
      };
      expect(inside.files).toEqual([{ name: "allowed.txt", size: 20 }]);
      await expect(form.locator("#uploaded")).toHaveText("allowed.txt:20");
      expect(await directoryCardUp(panel), "a file inside the owner's list raised a card").toBe(false);

      // ============ (4) nobody answers, and that is not a refusal ============
      impatient = await startMcpClient({
        clientName: "Claude Code",
        // The host's own wait, shortened for this check alone (spec header).
        env: { HALLPASS_UPLOAD_CONSENT_BOUND_MS: "6000" },
      });
      const hurried = impatient;
      await acceptPairing(panel, { locale, timeoutMs: 45_000 });
      const hurriedTab = ((await ok(hurried, "tabs_create", { url: `${SITE}/form` })) as { tabId: number }).tabId;
      const hurriedRef = await fileInputRef(hurried, hurriedTab);
      const unanswered = await hurried.callTool("file_upload", {
        tabId: hurriedTab,
        ref: hurriedRef,
        paths: [privateFile],
      });
      expect(unanswered.isError).toBe(true);
      expect(answerOf(unanswered), `text: ${unanswered.text}`).toMatchObject({
        outcome: "denied",
        reason: "upload-not-answered",
      });
      // The card is still on the panel - the *person* was never told the host gave up - so it is
      // answered before the run goes on, exactly as the owner would eventually answer it.
      await panel.clickButton(ui("agent.uploadDecline"));
      await closeTab(extensionWorker, hurriedTab);
      await hurried.close();
      impatient = undefined;

      // ============ (3) 不准 refuses the call in the owner's own word ============
      const declined = live.callTool("file_upload", { tabId, ref, paths: [privateFile] });
      await waitForDirectoryCard(panel, privateFile);
      await panel.clickButton(ui("agent.uploadDecline"));
      const declinedAnswer = await declined;
      expect(declinedAnswer.isError).toBe(true);
      expect(answerOf(declinedAnswer), `text: ${declinedAnswer.text}`).toMatchObject({
        outcome: "denied",
        reason: "upload-declined",
      });
      expect(await rootsInFile(configPath)).toEqual([allowedRoot]);
      // Nothing reached the page: it still holds the file from check 5.
      await expect(form.locator("#uploaded")).toHaveText("allowed.txt:20");

      // ============ (2) 這些檔案這次: this call only, and the list is untouched ============
      const once = live.callTool("file_upload", { tabId, ref, paths: [privateFile] });
      await waitForDirectoryCard(panel, privateFile);
      await panel.clickButton(ui("agent.uploadOnce"));
      const onceAnswer = await once;
      expect(onceAnswer.isError, `text: ${onceAnswer.text}\nstderr:\n${live.stderr()}`).toBe(false);
      await expect(form.locator("#uploaded")).toHaveText("diary.txt:17");
      expect(await rootsInFile(configPath)).toEqual([allowedRoot]);
      // FR-194: a *second* file from the same directory is asked about again - "once" was about
      // the files on the card, not about where they happened to live.
      const neighbour = live.callTool("file_upload", { tabId, ref, paths: [secondPrivateFile] });
      await waitForDirectoryCard(panel, secondPrivateFile);
      await panel.clickButton(ui("agent.uploadDecline"));
      expect((await neighbour).isError).toBe(true);

      // ============ (8) two files from two directories are one question ============
      // On a form that takes both: the question is asked once per call, and a single-file input
      // would refuse the upload for its own reasons before the card proved anything.
      const multiTab = ((await ok(live, "tabs_create", { url: `${SITE}/upload-multi` })) as { tabId: number }).tabId;
      const multiPage = await agentPage(extensionContext, `${SITE}/upload-multi`);
      const multiRef = await fileInputRef(live, multiTab);
      const both = live.callTool("file_upload", { tabId: multiTab, ref: multiRef, paths: [photosFile, notesFile] });
      await waitForDirectoryCard(panel, photosFile);
      await panel.waitForText(notesFile);
      expect(await directoryCardCount(panel), "two files raised more than one card").toBe(1);
      await panel.clickButton(ui("agent.uploadAlways"));
      const bothAnswer = await both;
      expect(bothAnswer.isError, `text: ${bothAnswer.text}\nstderr:\n${live.stderr()}`).toBe(false);
      expect((bothAnswer.json as { files: unknown[] }).files).toHaveLength(2);
      await expect(multiPage.locator("#uploaded")).toHaveText("holiday.txt:9, list.txt:6");
      await closeTab(extensionWorker, multiTab);
      // Both directories, because both were on the card the owner answered.
      await expect.poll(() => rootsInFile(configPath), { timeout: 15_000 }).toEqual([allowedRoot, photosDir, notesDir]);

      // ============ (1) 以後都可以 writes the directory, and the next file is not asked about ====
      const remembered = live.callTool("file_upload", { tabId, ref, paths: [docsFile] });
      // The card names the file in full: a path the owner cannot read is a decision they cannot make.
      await waitForDirectoryCard(panel, docsFile);
      await panel.clickButton(ui("agent.uploadAlways"));
      const rememberedAnswer = await remembered;
      expect(rememberedAnswer.isError, `text: ${rememberedAnswer.text}\nstderr:\n${live.stderr()}`).toBe(false);
      await expect(form.locator("#uploaded")).toHaveText("receipt.txt:9");
      await expect.poll(() => rootsInFile(configPath), { timeout: 15_000 }).toContain(docsDir);
      // FR-191: the owner can see what they allowed, in the panel's own list, without a reload.
      await waitForRootsSection(panel);
      await expect
        .poll(() => rootsOnPanel(panel), { timeout: 20_000 })
        .toEqual(expect.arrayContaining([docsDir, photosDir, notesDir]));
      // And a sibling in that directory now crosses without a question.
      const sibling = await ok(live, "file_upload", { tabId, ref, paths: [docsSibling] });
      expect((sibling as { files: Array<{ name: string }> }).files).toEqual([{ name: "invoice.txt", size: 10 }]);
      expect(await directoryCardUp(panel), "an allowed directory raised a card again").toBe(false);

      // ============ (6) revoking the row makes the next file ask again ============
      await panel.clickButton(ui("agent.uploadRootRevoke").replace("{root}", docsDir));
      // The host is what removes it, so the file on disk is the evidence (FR-192).
      await expect.poll(() => rootsInFile(configPath), { timeout: 20_000 }).not.toContain(docsDir);
      await expect.poll(() => rootsOnPanel(panel), { timeout: 20_000 }).not.toContain(docsDir);
      const asksAgain = live.callTool("file_upload", { tabId, ref, paths: [docsFile] });
      await waitForDirectoryCard(panel, docsFile);
      await panel.clickButton(ui("agent.uploadDecline"));
      expect((await asksAgain).isError).toBe(true);

      // ============ (7) the directory question comes first, and never replaces the site's ======
      await setSiteMode(panel, SITE, "ask");
      const chained = live.callTool("file_upload", { tabId, ref, paths: [privateFile] });
      // The disk first: the call has not crossed the link yet, so the site cannot have been asked.
      await waitForDirectoryCard(panel, privateFile);
      await panel.clickButton(ui("agent.uploadOnce"));
      // Then the page: the same call, now at the worker's own gate (FR-194).
      await panel.waitForText(
        ui("agent.consentBody")
          .replace("{agent}", "Claude Code")
          .replace("{action}", ui("agent.summary.file_upload"))
          .replace("{site}", SITE),
      );
      await panel.clickButton(ui("agent.allowOnce"));
      const chainedAnswer = await chained;
      expect(chainedAnswer.isError, `text: ${chainedAnswer.text}\nstderr:\n${live.stderr()}`).toBe(false);
      await expect(form.locator("#uploaded")).toHaveText("diary.txt:17");

      await closeTab(extensionWorker, tabId);
    } finally {
      await client?.close();
      await impatient?.close();
      if (savedConfig === undefined) await rm(configPath, { force: true });
      else await writeFile(configPath, savedConfig, "utf8");
      for (const directory of [allowedRoot, privateDir, docsDir, photosDir, notesDir]) {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
});

/** Calls a tool and fails loudly with the host's own stderr when it did not answer `ok`. */
async function ok(client: McpHarnessClient, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await client.callTool(tool, args);
  expect(result.isError, `${tool} failed: ${result.text}\nmcp-server stderr:\n${client.stderr()}`).toBe(false);
  return result.json;
}

/** The host answers a call as JSON text; a non-JSON answer is reported as what it was. */
function answerOf(result: { text: string; json?: unknown }): unknown {
  try {
    return JSON.parse(result.text) as unknown;
  } catch {
    return result.json ?? { unparsed: result.text };
  }
}

/** One live ref for the fixture's file input, by role rather than by name (003/C2). */
async function fileInputRef(client: McpHarnessClient, tabId: number): Promise<string> {
  const page = (await ok(client, "read_page", { tabId, filter: "all" })) as {
    nodes: Array<{ ref?: string; role: string }>;
  };
  const input = page.nodes.find((node) => node.role === "file" && node.ref !== undefined);
  expect(input, `read_page offered no ref for the file input: ${JSON.stringify(page.nodes)}`).toBeTruthy();
  return input?.ref as string;
}

/** The owner's list as the *host's* file has it, which is the only authority on it. */
async function rootsInFile(configPath: string): Promise<string[]> {
  const raw = await readFile(configPath, "utf8").catch(() => "{}");
  const parsed = JSON.parse(raw) as { uploadRoots?: unknown };
  return Array.isArray(parsed.uploadRoots) ? (parsed.uploadRoots as string[]) : [];
}

/** Whether a directory card is on the panel right now. */
async function directoryCardUp(panel: SidePanelDriver): Promise<boolean> {
  return (await panel.evaluatePanel("document.querySelector('[data-prompt=upload-directory]') !== null")) === true;
}

/** How many directory cards are up: one question per call, however many files it named. */
async function directoryCardCount(panel: SidePanelDriver): Promise<number> {
  return (await panel.evaluatePanel("document.querySelectorAll('[data-prompt=upload-directory]').length")) as number;
}

/** The card, naming one of the owner's own paths in full. */
async function waitForDirectoryCard(panel: SidePanelDriver, path: string): Promise<void> {
  await panel.waitForText(ui("agent.prompt.uploadDirectory").replace("{agent}", "Claude Code"));
  await panel.waitForText(path);
}

/**
 * The section itself, with the one diagnosis that is not a product failure.
 *
 * The rows come from the *relay* - the native host Chrome spawned - answering `upload-roots-list`,
 * and that process is whichever build the machine's registration points at. A registration from
 * another checkout drops the request as an unknown frame (`relay.mux.dropped unaddressed
 * type=upload-roots-list` in `relay.log`), and the panel then correctly shows no section at all.
 * Saying so here turns a bare text timeout into the one line that names what to do about it.
 */
async function waitForRootsSection(panel: SidePanelDriver): Promise<void> {
  try {
    await panel.waitForText(ui("agent.uploadRootsTitle"), 20_000);
  } catch (error) {
    throw new Error(
      "no upload-directory rows on the panel: the relay this browser spawned never answered " +
        "`upload-roots-list`. Re-install the host from this checkout (npm run agent-host:install) " +
        `so the registration points at its build. (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/** The allowed directories the panel is showing, by the row key the site list gives them. */
async function rootsOnPanel(panel: SidePanelDriver): Promise<string[]> {
  return (await panel.evaluatePanel(
    "[...document.querySelectorAll('[data-upload-root]')].map((row)=>row.getAttribute('data-upload-root'))",
  )) as string[];
}

/** Sets one site's mode through the panel's own control (FR-042), never by writing storage. */
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
  await expect
    .poll(
      async () =>
        panel.evaluatePanel(
          `(()=>{const site=${JSON.stringify(site)};const rows=[...document.querySelectorAll('li')];` +
            `const row=rows.find((r)=>r.textContent?.includes(site)&&r.querySelector('select'));return row?.querySelector('select')?.value ?? null})()`,
        ),
      { timeout: 15_000 },
    )
    .toBe(mode);
}

/** Tidying up through the browser, as the owner closing their own tab would. */
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
