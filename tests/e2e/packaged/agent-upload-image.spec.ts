import { Buffer } from "node:buffer";
import type { BrowserContext, Page } from "@playwright/test";
import { lookup } from "../../../apps/extension/src/locales/catalog.js";
import { SCREENSHOT_UPLOAD_SENTENCES } from "../../../packages/agent-host/src/screenshot-cache.js";
import { startMcpClient, type McpHarnessClient } from "../../harness/mcp-client.js";
import { pairWithFirstCall } from "../fixtures/agent-pairing.js";
import { copyFor, localeFromEnv, openSidePanel, type SidePanelDriver } from "../fixtures/side-panel-driver.js";
import { expect, test, type PackagedWorker } from "../fixtures/packaged-extension.js";

const locale = localeFromEnv();
const copy = copyFor(locale);
const ui = (key: string): string => lookup(key, locale);

const SITE = "https://127.0.0.1:19443";
const FIXTURE = `${SITE}/upload-image`;

/** The fixture's own geometry (`tests/e2e/fixtures/pages/upload-image.html`), in CSS pixels. */
const ZONE_CENTRE = { x: 120, y: 152 };
/** Inside the child frame's zone, in the *parent's* coordinates: (20, 232) + (120, 80). */
const CHILD_POINT = { x: 140, y: 312 };
const ID_SHAPE = /^img_[a-z0-9]{10}$/;

/**
 * 013/T341 — `upload_image` on the packaged extension (FR-167..FR-177, SC-093..SC-097).
 *
 * The claim this file exists for cannot be made by a unit test: the picture leaves the *host's*
 * memory, crosses native messaging as base64, is turned back into a `File` inside the page's own
 * realm, and is then read back from what the page itself reports. Each of those four steps is a
 * different engine's idea of what bytes are, and a jsdom harness agrees with all of them by
 * construction. So the five journeys here are the five things an owner would check: the picture
 * arrives in a form, it arrives as a drop where it was aimed (including one document down), a
 * picture the host no longer has never reaches the page at all, the site's mode decides as it does
 * for a click, and the retention belongs to the session rather than to the worker.
 *
 * **The two environment overrides.** `HALLPASS_SCREENSHOT_RETENTION_MS` and
 * `HALLPASS_SCREENSHOT_BUDGET_CHARS` are read by the cache factory *only when set* (`mcp-server.ts`
 * `positiveEnv`), and the product's own five minutes and 8 MiB stand otherwise. Journey 3 needs a
 * clock and a budget it can actually reach, so it sets them - on its own `mcp-server` process, not
 * on the run: each MCP session is a process of its own, so the overrides are arguments to one
 * session and every other journey here exercises the shipped numbers. That is also why they are
 * documented here rather than in the README: they are a test's lever, not a setting.
 *
 * Attach mode only, like every sibling `agent-*` journey: the bridge starts with a machine install
 * of the native-messaging host, which a browser the runner launched is not registered against.
 *
 * Prerequisites: `npm run build`, `apps/extension/dist/agent` loaded in the attached browser,
 * `npm run agent-host:install`, and the fixture servers (18786/18787/19443-19445) fresh - a stale
 * page-fixture server serves the page list it was started with, and this page is new in 013.
 */
test.describe("agent upload image", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT,
    "attach mode only: the native-messaging host is a machine install, so the browser under test " +
      "must be one the runner started against the installed host (HALLPASS_CDP_ENDPOINT).",
  );

  /**
   * 1/5 (SC-093): the id an agent is given, and the two file inputs it can spend it on - the one on
   * the page and the one the page hides behind a button of its own.
   */
  test("gives a screenshot an id and puts that picture into a visible and a hidden file input", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(300_000);

    const { panel, client, call } = await pairedSession({ extensionContext, extensionId, extensionWorker });
    let live: McpHarnessClient | undefined = client;
    try {
      const tabId = ((await call("tabs_create", { url: FIXTURE })) as { tabId: number }).tabId;
      const page = await fixturePage(extensionContext);
      await setSiteMode(panel, SITE, "skip-checks");

      // ============= the answer an agent reads: a picture, an id, and what to do with it =============
      const shot = await client.callTool("screenshot", { tabId });
      expect(shot.isError, `screenshot failed: ${shot.text}`).toBe(false);
      expect(shot.images).toHaveLength(1);
      const shotAnswer = shot.json as { imageId: string; upload: string };
      expect(shotAnswer.imageId).toMatch(ID_SHAPE);
      expect(shotAnswer.upload).toBe(SCREENSHOT_UPLOAD_SENTENCES.retained);
      // The bytes the *agent* was handed. Everything below is checked against this number, which is
      // what makes "the file in the page is the picture the agent got" an assertion rather than a
      // hope: the page reports the size it decoded, the host never sent it.
      const size = Buffer.from(shot.images[0]!.data, "base64").length;
      // eslint-disable-next-line no-console -- the picture's size is what the fixture's numbers mean.
      console.log(`[T341] screenshot ${shotAnswer.imageId}: ${size} bytes (${shot.images[0]!.data.length} base64 chars)`);

      const nodes = await readNodes(call, tabId);
      const visible = nodeFor(nodes, "Visible attachment");
      const hidden = nodeFor(nodes, "Hidden attachment");
      /**
       * That the second input is genuinely the one no pointer could reach (FR-170), read off the
       * product rather than off the fixture's stylesheet: the working list leaves it out - which is
       * what the worker does with an element the browser is not rendering (003/C2) - and the `all`
       * read above still offered a ref for it. A `hidden` flag is not asserted because the read
       * does not carry one to the agent; it decides with it and does not say so (`reads.ts:305`).
       */
      const working = (await call("read_page", { tabId, filter: "interactive" })) as { nodes: ReadNode[] };
      expect(working.nodes.map((node) => node.name)).toContain("Visible attachment");
      expect(working.nodes.map((node) => node.name)).not.toContain("Hidden attachment");

      // ============= 1/2: the visible input =============
      const intoVisible = await call("upload_image", { tabId, imageId: shotAnswer.imageId, ref: visible.ref });
      expect(intoVisible).toEqual({ delivery: "input", file: { name: "screenshot.png", size } });
      // Read off the page's own `change` handler: the name, the decoded size, the type - and the
      // word the handler writes only when it actually ran.
      await expect(page.locator("#report-visible")).toHaveText(`screenshot.png:${size}:image/png changed`);
      // Both events, in order (FR-173). A page that heard only `change` is a different fact.
      expect(await page.locator("#report-visible").getAttribute("data-events")).toBe("input,change");

      // ============= 2/2: the hidden input, under a name the agent chose =============
      const intoHidden = await call("upload_image", {
        tabId,
        imageId: shotAnswer.imageId,
        ref: hidden.ref,
        filename: "page-shot.png",
      });
      expect(intoHidden).toEqual({ delivery: "input", file: { name: "page-shot.png", size } });
      await expect(page.locator("#report-hidden")).toHaveText(`page-shot.png:${size}:image/png changed`);
      expect(await page.locator("#report-hidden").getAttribute("data-events")).toBe("input,change");
      // The same id twice: the picture is kept for the five minutes the sentence promises, not spent
      // by the first upload (FR-168).

      await call("tabs_close", { tabId });
    } finally {
      await live?.close();
      live = undefined;
    }
  });

  /**
   * 2/5 (SC-094): the drop - at a point the agent named, at a ref's own centre, and one same-origin
   * document down, where the agent's coordinate has to be translated into the child's.
   */
  test("drops the picture at a point, at a ref's centre, and inside a same-origin child frame", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(300_000);

    const { panel, client, call } = await pairedSession({ extensionContext, extensionId, extensionWorker });
    let live: McpHarnessClient | undefined = client;
    try {
      const tabId = ((await call("tabs_create", { url: FIXTURE })) as { tabId: number }).tabId;
      const page = await fixturePage(extensionContext);
      await setSiteMode(panel, SITE, "skip-checks");

      const shot = await client.callTool("screenshot", { tabId });
      expect(shot.isError, shot.text).toBe(false);
      const imageId = (shot.json as { imageId: string }).imageId;
      const size = Buffer.from(shot.images[0]!.data, "base64").length;
      const dropped = `dragenter,dragover,drop|screenshot.png:${size}:image/png`;

      // ============= 1/3: a coordinate, which is how a position-aiming agent works =============
      await reset(page);
      const atPoint = await call("upload_image", { tabId, imageId, coordinate: ZONE_CENTRE });
      expect(atPoint).toEqual({ delivery: "drop", file: { name: "screenshot.png", size }, point: ZONE_CENTRE });
      // The three events a browser sends, in that order, sharing one file (FR-173). No `dragleave`:
      // the zone records one if it hears it, and it must not.
      await expect(page.locator("#report-zone")).toHaveText(dropped);

      // ============= 2/3: a ref, delivered at the element's own centre =============
      await reset(page);
      const zone = nodeFor(await readNodes(call, tabId), "Drop zone");
      const atRef = await call("upload_image", { tabId, imageId, ref: zone.ref });
      // The answer says *where* it landed, which for a ref is the element's centre - the same point
      // the coordinate case named, so the two paths are shown to agree.
      expect(atRef).toEqual({ delivery: "drop", file: { name: "screenshot.png", size }, point: ZONE_CENTRE });
      await expect(page.locator("#report-zone")).toHaveText(dropped);

      // ============= 3/3: one level down, into a document the agent never named =============
      await reset(page);
      const inChild = await call("upload_image", { tabId, imageId, coordinate: CHILD_POINT });
      expect(inChild).toEqual({ delivery: "drop", file: { name: "screenshot.png", size }, point: CHILD_POINT });
      // The child's own zone heard it and said so through `postMessage`, and the parent's zone -
      // which the point passed over on its way in - heard nothing.
      await expect(page.locator("#report-child")).toHaveText(dropped);
      await expect(page.locator("#report-zone")).toHaveText("none");

      await call("tabs_close", { tabId });
    } finally {
      await live?.close();
      live = undefined;
    }
  });

  /**
   * 3/5 (SC-095): the three pictures the host will not hand over, each refused before the browser is
   * touched at all - so the page is asked to prove it saw nothing.
   *
   * Two sessions, because a bound is read when a session's cache is built: one with a retention it
   * can outlive, one with a budget a second screenshot exceeds. The foreign-session case (another
   * agent's id) is a unit test on two cache instances (T327 f) - there is no second agent here.
   */
  test("refuses an id it never issued, one that expired, and one it evicted, without touching the page", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(600_000);

    const retentionMs = 2_000;
    let sizeChars = 0;

    // ---------- session 1: an id nobody issued, and an id this session let go of ----------
    {
      const { panel, client, call } = await pairedSession(
        { extensionContext, extensionId, extensionWorker },
        { HALLPASS_SCREENSHOT_RETENTION_MS: String(retentionMs) },
      );
      let live: McpHarnessClient | undefined = client;
      try {
        const tabId = ((await call("tabs_create", { url: FIXTURE })) as { tabId: number }).tabId;
        const page = await fixturePage(extensionContext);
        await setSiteMode(panel, SITE, "skip-checks");
        await reset(page);
        const visible = nodeFor(await readNodes(call, tabId), "Visible attachment");

        // ============= 1/3: an id of the right shape that was never minted =============
        const unknown = await client.callTool("upload_image", {
          tabId,
          imageId: "img_zzzzzzzzzz",
          ref: visible.ref,
        });
        expect(unknown.isError).toBe(true);
        expect(unknown.json).toMatchObject({ outcome: "denied" });
        expect(String((unknown.json as { reason: string }).reason)).toContain("unknown-image-id");
        await expect(page.locator("#report-visible")).toHaveText("none");

        // ============= 2/3: a picture this session kept for two seconds =============
        const shot = await client.callTool("screenshot", { tabId });
        expect(shot.isError, shot.text).toBe(false);
        const shotAnswer = shot.json as { imageId: string; upload: string };
        expect(shotAnswer.upload).toBe(SCREENSHOT_UPLOAD_SENTENCES.retained);
        // Measured here for the eviction session below: the budget has to be a number *this* page's
        // screenshots actually reach, and only a real one of them can say what that is.
        sizeChars = shot.images[0]!.data.length;
        await new Promise((resolve) => setTimeout(resolve, retentionMs + 500));

        const expired = await client.callTool("upload_image", { tabId, imageId: shotAnswer.imageId, ref: visible.ref });
        expect(expired.isError).toBe(true);
        expect(expired.json).toMatchObject({ outcome: "denied" });
        expect(String((expired.json as { reason: string }).reason)).toContain("image-no-longer-available (expired)");
        await expect(page.locator("#report-visible")).toHaveText("none");
        expect(client.stderr()).toContain("agent.upload-image.refused");

        await call("tabs_close", { tabId });
      } finally {
        await live?.close();
        live = undefined;
      }
    }

    // ---------- session 2: a budget one more screenshot does not fit in ----------
    {
      // One and a half pictures: the first fits, the second does not fit beside it, and the cache
      // gives up the oldest to make room (oldest-first, stop when it fits).
      const budgetChars = Math.ceil(sizeChars * 1.5);
      expect(sizeChars, "no screenshot was measured in the first session").toBeGreaterThan(0);
      const { panel, client, call } = await pairedSession(
        { extensionContext, extensionId, extensionWorker },
        { HALLPASS_SCREENSHOT_BUDGET_CHARS: String(budgetChars) },
      );
      let live: McpHarnessClient | undefined = client;
      try {
        const tabId = ((await call("tabs_create", { url: FIXTURE })) as { tabId: number }).tabId;
        const page = await fixturePage(extensionContext);
        await setSiteMode(panel, SITE, "skip-checks");
        await reset(page);
        const visible = nodeFor(await readNodes(call, tabId), "Visible attachment");

        const first = await client.callTool("screenshot", { tabId });
        expect(first.isError, first.text).toBe(false);
        const firstAnswer = first.json as { imageId: string; upload: string };
        const second = await client.callTool("screenshot", { tabId });
        expect(second.isError, second.text).toBe(false);
        const secondAnswer = second.json as { imageId: string; upload: string };
        // Both were *kept* when they were taken: without this the refusal below could as well be
        // the oversize one, which is a different fact about a different bound.
        expect(firstAnswer.upload, `budget ${budgetChars} chars`).toBe(SCREENSHOT_UPLOAD_SENTENCES.retained);
        expect(secondAnswer.upload, `budget ${budgetChars} chars`).toBe(SCREENSHOT_UPLOAD_SENTENCES.retained);

        // ============= 3/3: the older picture is the one that went =============
        const evicted = await client.callTool("upload_image", { tabId, imageId: firstAnswer.imageId, ref: visible.ref });
        expect(evicted.isError).toBe(true);
        expect(String((evicted.json as { reason: string }).reason)).toContain("image-no-longer-available (evicted)");
        await expect(page.locator("#report-visible")).toHaveText("none");

        // And the newer one is still there, which is what makes the line above eviction rather than
        // a session that simply lost both.
        const kept = await call("upload_image", { tabId, imageId: secondAnswer.imageId, ref: visible.ref });
        expect(kept).toMatchObject({ delivery: "input", file: { name: "screenshot.png" } });
        await expect(page.locator("#report-visible")).toContainText("screenshot.png:");

        await call("tabs_close", { tabId });
      } finally {
        await live?.close();
        live = undefined;
      }
    }
  });

  /**
   * 4/5 (SC-096): the site's mode decides, exactly as it does for a click - and the card says what
   * is about to happen to the owner's page in the owner's own words, never an id.
   */
  test("asks the owner on an ask site, delivers nothing when refused, and notes one line when allowed", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(300_000);

    const { panel, client, call } = await pairedSession({ extensionContext, extensionId, extensionWorker });
    let live: McpHarnessClient | undefined = client;
    try {
      const tabId = ((await call("tabs_create", { url: FIXTURE })) as { tabId: number }).tabId;
      const page = await fixturePage(extensionContext);
      // The read has to happen before the site is put in `ask`: a read is not an effect either way,
      // and this keeps the one card of this journey the upload's own.
      await setSiteMode(panel, SITE, "skip-checks");
      const visible = nodeFor(await readNodes(call, tabId), "Visible attachment");
      await reset(page);
      const shot = await client.callTool("screenshot", { tabId });
      expect(shot.isError, shot.text).toBe(false);
      const imageId = (shot.json as { imageId: string }).imageId;
      const size = Buffer.from(shot.images[0]!.data, "base64").length;

      await setSiteMode(panel, SITE, "ask");

      // ============= refused: the page is untouched and the agent is told who said no =============
      const refusedCall = client.callTool("upload_image", { tabId, imageId, ref: visible.ref });
      await panel.waitForText(ui("agent.promptTitle"));
      /**
       * The owner's sentence, in the owner's language: a picture *the agent took*, going into this
       * page. It is the panel's own per-tool string rather than the worker's summary of the
       * arguments - by design (`agent-panel-keys.ts` TOOL_SUMMARY_KEYS: what is shown comes from the
       * reviewed tables, so no English written for an agent reaches a card), which is why the
       * delivery-specific wording `summariseToolCall` produces is pinned in the unit test instead.
       * No id, no file name, nothing of the page's own words either way.
       *
       * 014/T385: the sentence is now the one for *this* delivery (FR-196). The card is told which
       * of the two acts it is about - a file field here, a point on the page for a drop - because
       * they are not the same decision, and the panel still picks reviewed copy from a key.
       */
      expect(await panel.panelText()).toContain(
        ui("agent.consentBody")
          .replace("{agent}", "Claude Code")
          .replace("{site}", SITE)
          .replace("{action}", ui("agent.summary.upload_image.input")),
      );
      await panel.clickButton(ui("agent.refuse"));
      const refused = await refusedCall;
      expect(refused.isError).toBe(true);
      expect(refused.json).toMatchObject({ outcome: "denied", reason: "owner-denied" });
      await expect(page.locator("#report-visible")).toHaveText("none");
      expect(await page.locator("#report-visible").getAttribute("data-events")).toBe("");

      // ============= allowed: the picture arrives, and the card keeps a line about it =============
      const allowedCall = client.callTool("upload_image", { tabId, imageId, ref: visible.ref });
      await panel.waitForText(ui("agent.promptTitle"));
      await panel.clickButton(ui("agent.allowOnce"));
      const allowed = await allowedCall;
      expect(allowed.isError, allowed.text).toBe(false);
      expect(allowed.json).toEqual({ delivery: "input", file: { name: "screenshot.png", size } });
      await expect(page.locator("#report-visible")).toHaveText(`screenshot.png:${size}:image/png changed`);

      // FR-174: one line on the session's card, written from pieces by the panel - the delivery the
      // page reported decides which of the two sentences it is.
      const uploadLine = ui("agent.activity.uploadInput").replace("{site}", SITE);
      await panel.waitForText(uploadLine);
      const panelText = await panel.panelText();
      expect(panelText.split(uploadLine).length - 1, `expected exactly one activity line:\n${panelText}`).toBe(1);
      expect(panelText).toContain(ui("agent.activity.delivered"));
      // The refused upload left no line: the list is what a session *did*, not what it asked.
      expect(panelText).not.toContain(ui("agent.activity.uploadDrop").replace("{site}", SITE));

      await setSiteMode(panel, SITE, "skip-checks");
      await call("tabs_close", { tabId });
    } finally {
      await live?.close();
      live = undefined;
    }
  });

  /**
   * 5/5, first half (SC-097, FR-168's last sentence): a worker recycling is invisible to the
   * retention, because the bytes were never in the browser.
   *
   * Written as its own journey rather than as a step of the next one so that the two halves of
   * SC-097 are two results: they are different claims about different ends of the link.
   */
  test("keeps a picture across a worker restart", async ({ extensionContext, extensionId, extensionWorker }) => {
    test.setTimeout(600_000);

    const { panel, client, call } = await pairedSession({ extensionContext, extensionId, extensionWorker });
    let live: McpHarnessClient | undefined = client;
    let tabId = 0;
    try {
      tabId = ((await call("tabs_create", { url: FIXTURE })) as { tabId: number }).tabId;
      const page = await fixturePage(extensionContext);
      await setSiteMode(panel, SITE, "skip-checks");
      await reset(page);

      const shot = await client.callTool("screenshot", { tabId });
      expect(shot.isError, shot.text).toBe(false);
      const imageId = (shot.json as { imageId: string }).imageId;
      const size = Buffer.from(shot.images[0]!.data, "base64").length;

      // ============= the worker goes, exactly as `agent-panel-multi` kills it =============
      const ownerPage = extensionContext.pages()[0] ?? (await extensionContext.newPage());
      const cdp = await extensionContext.newCDPSession(ownerPage);
      const targets = await cdp.send("Target.getTargets");
      const worker = targets.targetInfos.find(
        (target) => target.type === "service_worker" && target.url.startsWith(`chrome-extension://${extensionId}/`),
      );
      expect(worker, "worker target").toBeTruthy();
      await cdp.send("Target.closeTarget", { targetId: worker!.targetId });
      await cdp.detach();
      // The fresh worker re-links before any call is answered; that wait is the bridge's own
      // honesty and has nothing to do with the picture.
      await expect
        .poll(async () => (await live!.callTool("tabs_context")).isError, { timeout: 120_000, intervals: [1_000] })
        .toBe(false);

      // A coordinate rather than a ref: a ref is a fact about a page the new worker has not read
      // yet, and what is under test is the *picture*, not the registry.
      const afterRestart = await client.callTool("upload_image", { tabId, imageId, coordinate: ZONE_CENTRE });
      expect(
        afterRestart.isError,
        `the picture did not outlive the worker: ${afterRestart.text}\nmcp-server stderr:\n${client.stderr()}`,
      ).toBe(false);
      expect(afterRestart.json).toEqual({ delivery: "drop", file: { name: "screenshot.png", size }, point: ZONE_CENTRE });
      await expect(page.locator("#report-zone")).toHaveText(
        `dragenter,dragover,drop|screenshot.png:${size}:image/png`,
      );
    } finally {
      await live?.close();
      live = undefined;
      if (tabId) await extensionWorker.evaluate(async (id: number) => chrome.tabs.remove(id), tabId);
    }
  });

  /**
   * 5/5, second half (SC-097): the session's end is the end of the picture, because the cache dies
   * with the process that minted the id - the next session cannot even say what became of it.
   */
  test("forgets a picture when the session ends", async ({ extensionContext, extensionId, extensionWorker }) => {
    test.setTimeout(600_000);

    const { panel, client, call } = await pairedSession({ extensionContext, extensionId, extensionWorker });
    let live: McpHarnessClient | undefined = client;
    let tabId = 0;
    try {
      tabId = ((await call("tabs_create", { url: FIXTURE })) as { tabId: number }).tabId;
      const page = await fixturePage(extensionContext);
      await setSiteMode(panel, SITE, "skip-checks");
      await reset(page);

      const shot = await client.callTool("screenshot", { tabId });
      expect(shot.isError, shot.text).toBe(false);
      const imageId = (shot.json as { imageId: string }).imageId;

      await live.close();
      live = undefined;

      const next = await startMcpClient({ clientName: "Claude Code" });
      live = next;
      await panel.clickIfPresent(ui("agent.retry"));
      await pairWithFirstCall(next, panel, { locale });
      const stale = await next.callTool("upload_image", { tabId, imageId, coordinate: ZONE_CENTRE });
      expect(stale.isError).toBe(true);
      // Not `expired` and not `evicted`: the new session never minted this id, so it cannot say
      // what became of the picture - and it refuses before the tab is even looked at.
      expect(String((stale.json as { reason: string }).reason)).toContain("unknown-image-id");
      // The tab was never touched: the zone heard nothing at all.
      await expect(page.locator("#report-zone")).toHaveText("none");
    } finally {
      await live?.close();
      live = undefined;
      if (tabId) await extensionWorker.evaluate(async (id: number) => chrome.tabs.remove(id), tabId);
    }
  });
});

/** The fixture tab as a page handle, which is the one reader a terminated worker cannot take away. */
async function fixturePage(context: BrowserContext): Promise<Page> {
  let found: Page | undefined;
  await expect
    .poll(
      () => {
        found = context.pages().find((page) => page.url().startsWith(FIXTURE));
        return found !== undefined;
      },
      { timeout: 30_000, intervals: [200] },
    )
    .toBe(true);
  if (!found) throw new Error("fixture-tab-missing");
  return found;
}

/** Every report back to `none`, so each delivery below is evidence of its own call. */
async function reset(page: Page): Promise<void> {
  const done = await page.evaluate(() => (window as unknown as { __hallpassReset?: () => boolean }).__hallpassReset?.());
  expect(done, "the upload-image fixture is not the one this spec was written against").toBe(true);
  // The child frame is reset by a message, so the parent's own report of it settles a tick later.
  await expect(page.locator("#report-child")).toHaveText("none");
}

type ReadNode = { ref?: string; role: string; name?: string; hidden?: boolean };

/** The page as the agent reads it, `all` because one of the targets is not rendered at all. */
async function readNodes(
  call: (tool: string, args?: Record<string, unknown>) => Promise<unknown>,
  tabId: number,
): Promise<ReadNode[]> {
  const read = (await call("read_page", { tabId, filter: "all" })) as { nodes: ReadNode[] };
  return read.nodes;
}

/** One target by the name the page gave it, with the ref the agent would quote. */
function nodeFor(nodes: ReadNode[], name: string): ReadNode & { ref: string } {
  const found = nodes.find((node) => node.name === name && node.ref !== undefined);
  expect(
    found,
    `no ref for '${name}' in: ${JSON.stringify(nodes.filter((node) => node.name !== undefined).map((node) => [node.role, node.name]))}`,
  ).toBeTruthy();
  return found as ReadNode & { ref: string };
}

/**
 * One site's mode through the panel's own control (FR-042), never by writing storage.
 *
 * Addressed by `data-site` rather than by finding the list row whose text contains the site (which
 * is what the older sibling journeys do): once this journey has an *activity* line on the card, that
 * line is an `li` naming the same site and has no mode control in it.
 */
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
    .poll(
      () => panel.evaluatePanel(`document.querySelector('[data-site=${JSON.stringify(site)}] select')?.value ?? null`),
      { timeout: 15_000 },
    )
    .toBe(mode);
}

/**
 * One paired MCP session with the panel open, exactly as the sibling journeys start.
 *
 * `env` reaches the session's own `mcp-server` process and nothing else, which is how journey 3
 * shortens the retention and the budget for itself without changing the run.
 */
async function pairedSession(
  fixtures: {
    extensionContext: BrowserContext;
    extensionId: string;
    extensionWorker: PackagedWorker;
  },
  env: Record<string, string> = {},
): Promise<{
  panel: SidePanelDriver;
  client: McpHarnessClient;
  call: (tool: string, args?: Record<string, unknown>) => Promise<unknown>;
}> {
  const { extensionContext, extensionId, extensionWorker } = fixtures;
  const permissions = await extensionWorker.evaluate(() => chrome.runtime.getManifest().permissions ?? []);
  expect(
    permissions,
    "the attached browser must have apps/extension/dist/agent loaded (npm run build:extension:agent)",
  ).toContain("debugger");

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

  const client = await startMcpClient({ clientName: "Claude Code", ...(Object.keys(env).length === 0 ? {} : { env }) });
  await panel.clickIfPresent(ui("agent.retry"));
  await pairWithFirstCall(client, panel, { locale });

  const call = async (tool: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const result = await client.callTool(tool, args);
    expect(result.isError, `${tool} failed: ${result.text}\nmcp-server stderr:\n${client.stderr()}`).toBe(false);
    return result.json;
  };
  return { panel, client, call };
}
