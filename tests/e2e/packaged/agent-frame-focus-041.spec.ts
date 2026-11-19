import type { BrowserContext, Page } from "@playwright/test";
import { lookup } from "../../../apps/extension/src/locales/catalog.js";
import { startMcpClient, type McpHarnessClient } from "../../harness/mcp-client.js";
import { pairWithFirstCall } from "../fixtures/agent-pairing.js";
import { openSettingsPage, type SettingsPageDriver } from "../fixtures/settings-page-driver.js";
import { copyFor, localeFromEnv, openSidePanel, waitForAgentPanel } from "../fixtures/side-panel-driver.js";
import { expect, test, type PackagedWorker } from "../fixtures/packaged-extension.js";

const locale = localeFromEnv();
const copy = copyFor(locale);
const ui = (key: string): string => lookup(key, locale);

/** The page's site: every fixture below is opened here. */
const SITE = "https://127.0.0.1:19443";
/** The second site the fixtures frame (`__OOPIF_ORIGIN__`): another host name on the same server, a real out-of-process frame. */
const SECOND = "https://localhost:19443";

type Fixtures = { extensionContext: BrowserContext; extensionId: string; extensionWorker: PackagedWorker };
type Caller = (tool: string, args: Record<string, unknown>) => Promise<unknown>;
type RawCaller = (tool: string, args: Record<string, unknown>) => Promise<{ isError: boolean; text: string }>;
type Typed = {
  outcome?: string;
  observed?: { effect?: string; verified?: boolean; verdict?: string; charactersChanged?: number };
  hint?: string;
};
type ReadNode = { ref?: string; role?: string; name?: string; frame?: string };
type ReadPage = { frames?: Array<{ frame: string; url: string }>; nodes: ReadNode[] };

/**
 * 041 live checks (SC-263..SC-265): the focus check follows the frame that has focus.
 *
 * - SC-263: after a field inside a frame had focus, `type` naming it is refused `focus-lost` - and nothing
 *   is typed into either input - when the focusing click leaves focus in a top-document input instead
 *   (FR-578). Run for an out-of-process frame (`frame-consent`, second site) and a same-site frame
 *   (`frames`). The page takes the click two ways at once, because the two kinds of frame receive it
 *   differently: an overlay in the top document over the frame (a click on the top session lands on it),
 *   and a click handler in the frame that asks its parent to move focus (a click sent through an
 *   out-of-process frame's own session never reaches the overlay).
 * - SC-264: the same page without the overlay and the handler: the text lands in the frame field, `verified`.
 * - SC-265 (FR-581): `type` at a point on the text of a cross-site frame whose `body` is the editing host
 *   lands and is `verified` with the window in front; the same call with the browser window behind another
 *   window is measured and printed (`[041]` lines), not asserted to land: a refusal there is fail-closed,
 *   a write into another field is not.
 *
 * Attach mode only, like every sibling `agent-*` journey. Prerequisites: `dist/agent` of THIS checkout
 * loaded in the attached browser and the fixture servers started AFTER this change (`/frame-body-041` is new).
 */
test.describe("agent frame focus (spec 041)", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT,
    "attach mode only: the native-messaging host is a machine install, so the browser under test " +
      "must be one the runner started and pointed at the installed host (HALLPASS_CDP_ENDPOINT).",
  );

  test("SC-263/264: a field in an out-of-process frame - refused when the click leaves focus outside the frame, typed otherwise", async ({ extensionContext, extensionId, extensionWorker }) => {
    test.setTimeout(300_000);
    await withSession({ extensionContext, extensionId, extensionWorker }, async (session) => {
      await frameFieldScenario(session, {
        url: `${SITE}/frame-consent`,
        frame: "#consent-frame",
        field: "#frame-field",
        pickRef: (read) => read.nodes.find((node) => node.ref !== undefined && node.frame !== undefined && node.role === "textbox")?.ref,
      });
    });
  });

  test("SC-263/264: a field in a same-site frame - refused when the click leaves focus outside the frame, typed otherwise", async ({ extensionContext, extensionId, extensionWorker }) => {
    test.setTimeout(300_000);
    await withSession({ extensionContext, extensionId, extensionWorker }, async (session) => {
      await frameFieldScenario(session, {
        url: `${SITE}/frames`,
        frame: "#same-origin-frame",
        field: "#child-input",
        pickRef: (read) => {
          // The same-origin child, not the sibling-port one that carries the same field.
          const frame = read.frames?.find((candidate) => candidate.url === `${SITE}/frames-child`)?.frame;
          return read.nodes.find((node) => node.ref !== undefined && node.frame === frame && node.name === "Child note")?.ref;
        },
      });
    });
  });

  test("SC-265: type at a point on the text of an editable body in an out-of-process frame lands, verified; the window behind another is measured", async ({ extensionContext, extensionId, extensionWorker }) => {
    test.setTimeout(300_000);
    await withSession({ extensionContext, extensionId, extensionWorker }, async (session) => {
      const { call, callRaw } = session;
      const { tabId, page } = await openTab(session, `${SITE}/frame-body-041`);
      const frame = page.frameLocator("#body-frame");
      await expect(frame.locator("body")).toContainText("Draft text");

      // A point on the first line's text: the iframe's box plus the body's padding and half a line.
      const box = await boxOf(page.locator("#body-frame"));
      const point = { x: Math.round(box.x + 40), y: Math.round(box.y + 24) };

      // ===== window in front =====
      const typed = (await call("type", { tabId, target: point, text: " front", mode: "insert" })) as Typed;
      expect(typed, JSON.stringify(typed)).toMatchObject({ observed: { effect: "text-entered", verified: true, verdict: "verified" } });
      await expect.poll(() => frame.locator("body").innerText()).toContain("front");
      await expect(page.locator("#echo")).toContainText("front");

      // ===== window behind another window: measured =====
      const windowOf = (id: number) => extensionWorker.evaluate(async (tab: number) => (await chrome.tabs.get(tab)).windowId, id);
      const agentWindow = await windowOf(tabId);
      const other = await extensionWorker.evaluate(async () => {
        const created = await chrome.windows.create({ url: "about:blank", focused: true });
        return created?.id ?? -1;
      });
      try {
        await expect
          .poll(() => extensionWorker.evaluate(async (id: number) => (await chrome.windows.get(id)).focused, other), { timeout: 10_000 })
          .toBe(true);
        const windows = async () =>
          extensionWorker.evaluate(async () => (await chrome.windows.getAll()).map((entry) => ({ id: entry.id, focused: entry.focused })));
        const state = async (label: string) => {
          const measured = await frame.locator("body").evaluate(() => ({
            hasFocus: document.hasFocus(),
            activeElement: document.activeElement?.tagName ?? null,
            text: document.body.innerText,
          }));
          const top = await page.evaluate(() => ({ hasFocus: document.hasFocus(), activeElement: document.activeElement?.tagName ?? null }));
          // eslint-disable-next-line no-console -- the measurement the coverage notes record (FR-581).
          console.log(`[041] ${label}: child=${JSON.stringify(measured)} top=${JSON.stringify(top)} windows=${JSON.stringify(await windows())} agentWindow=${agentWindow}`);
          return measured;
        };
        await state("behind, before the call");
        const behind = await callRaw("type", { tabId, target: point, text: " behind", mode: "insert" });
        // eslint-disable-next-line no-console -- the measurement the coverage notes record (FR-581).
        console.log(`[041] behind, answer: ${behind.text}`);
        const after = await state("behind, after the call");
        // A refusal is fail-closed; landing is the better answer; text anywhere else would be wrong.
        const landed = after.text.includes("behind");
        const refused = behind.text.includes("focus-lost");
        expect(landed || refused || behind.isError, `neither landed nor refused: ${behind.text}`).toBe(true);
        if (landed) expect(behind.text).toContain("verified");
        expect(await page.locator("#echo").innerText()).not.toBe("");
      } finally {
        await extensionWorker.evaluate(async (id: number) => {
          await chrome.windows.remove(id).catch(() => undefined);
        }, other);
      }
    });
  });
});

/**
 * SC-267 (US3, FR-582, FR-583): the named field's frame is gone by the time the focus check asks. The field's own
 * focus handler moves focus to a top-document input (its text selected) and then removes its frame, or replaces
 * its document. `type` and `key` are refused `focus-unconfirmed` and the top input keeps its text.
 *
 * On 0.26.2 the check could not run and the keys went on: the text replaced the selected text, a Backspace
 * cleared it, and the answers were `verified` and `focus-lost`.
 */
test.describe("agent frame focus (spec 041): a check that cannot run sends no keys", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT,
    "attach mode only: the native-messaging host is a machine install, so the browser under test " +
      "must be one the runner started and pointed at the installed host (HALLPASS_CDP_ENDPOINT).",
  );

  for (const mode of ["remove", "replace"] as const) {
    for (const tool of ["type", "key"] as const) {
      test(`SC-267: ${tool} naming a field whose frame the focusing click ${mode}s is refused focus-unconfirmed, nothing delivered`, async ({ extensionContext, extensionId, extensionWorker }) => {
        test.setTimeout(300_000);
        await withSession({ extensionContext, extensionId, extensionWorker }, async (session) => {
          const { call, callRaw } = session;
          const { tabId, page } = await openTab(session, `${SITE}/frame-removal-041`);
          const topField = page.locator("#top-field");

          // A fresh frame with a fresh field, the top input back to its text, and the ref the agent would read.
          await page.evaluate((how) => {
            const w = window as unknown as { hp041Mode: string; hp041Rebuild: () => void };
            w.hp041Mode = how;
            w.hp041Rebuild();
          }, mode);
          await expect(page.frameLocator("#gone-frame").locator("#child-field")).toBeVisible();
          await expect(topField).toHaveValue("keep");
          const read = (await call("read_page", { tabId, filter: "all" })) as ReadPage;
          const ref = read.nodes.find((node) => node.ref !== undefined && node.frame !== undefined && node.name === "Child field")?.ref;
          expect(ref, `read_page offered no ref for the frame field: ${JSON.stringify(read)}`).toBeTruthy();

          const answered =
            tool === "type"
              ? await callRaw("type", { tabId, target: { ref }, text: "secret", mode: "insert" })
              : await callRaw("key", { tabId, target: { ref }, key: "Backspace" });
          // eslint-disable-next-line no-console -- the answer the run saw.
          console.log(`[041] ${mode}, ${tool}, answer: ${answered.text}`);
          console.log(`[041] ${mode}, ${tool}, the top input holds: ${await topField.inputValue()}`);

          // Nothing reached the input that holds focus: not a character, not a deletion.
          expect(await topField.inputValue(), `the ${tool} reached the top-document input`).toBe("keep");
          expect(answered.text, answered.text).toContain("focus-unconfirmed");
          expect(answered.text).toMatch(/"verified":\s*false/);
          expect(answered.text).toMatch(/read the page again/i);
          if (tool === "type") expect(answered.text).toMatch(/"charactersChanged":\s*0/);
          // The focus did move: the top input is where the keys would have gone.
          await expect(topField).toBeFocused();
        });
      });
    }
  }
});

type FieldScenario = {
  url: string;
  /** The iframe holding the field, and the field inside it. */
  frame: string;
  field: string;
  pickRef: (read: ReadPage) => string | undefined;
};

/**
 * One frame field, end to end (SC-263, SC-264): typed into once so the frame has the focus, then a page whose
 * click takes focus out of the frame, then the same page without that.
 */
async function frameFieldScenario(session: SessionContext, scenario: FieldScenario): Promise<void> {
  const { call, callRaw } = session;
  const { tabId, page } = await openTab(session, scenario.url);
  const field = page.frameLocator(scenario.frame).locator(scenario.field);
  await expect(field).toBeVisible();

  const readRef = async (): Promise<string> => {
    const read = (await call("read_page", { tabId, filter: "all" })) as ReadPage;
    const ref = scenario.pickRef(read);
    expect(ref, `read_page offered no ref for the frame field: ${JSON.stringify(read)}`).toBeTruthy();
    return ref as string;
  };

  // ===== the frame field has focus, with text in it =====
  const seeded = (await call("type", { tabId, target: { ref: await readRef() }, text: "seed", mode: "replace" })) as Typed;
  expect(seeded, JSON.stringify(seeded)).toMatchObject({ observed: { verified: true, verdict: "verified" } });
  await expect(field).toHaveValue("seed");
  await expect(field).toBeFocused();

  // ===== the page takes the focusing click away from the frame =====
  await page.evaluate(
    ({ frameSelector }) => {
      const topField = document.createElement("input");
      topField.type = "text";
      topField.id = "top-field-041";
      topField.setAttribute("aria-label", "top-field-041");
      document.body.append(topField);
      const holder = document.querySelector(frameSelector) as HTMLElement;
      const rect = holder.getBoundingClientRect();
      const overlay = document.createElement("div");
      overlay.id = "overlay-041";
      overlay.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;z-index:2147483647;background:transparent`;
      overlay.addEventListener("mousedown", (event) => {
        event.preventDefault();
        topField.focus();
      });
      document.body.append(overlay);
      const w = window as unknown as { __hp041Armed?: boolean };
      w.__hp041Armed = true;
      window.addEventListener("message", (event) => {
        if (w.__hp041Armed === true && event.data === "hp041-bounce") topField.focus();
      });
    },
    { frameSelector: scenario.frame },
  );
  // A click on the frame's field asks the page that holds the frame to move focus.
  await field.evaluate((element) => {
    element.addEventListener("click", () => parent.postMessage("hp041-bounce", "*"));
  });
  const topField = page.locator("#top-field-041");

  const refused = await callRaw("type", { tabId, target: { ref: await readRef() }, text: "secret", mode: "replace" });
  // eslint-disable-next-line no-console -- the answer the run saw.
  console.log(`[041] overlay case, answer: ${refused.text}`);
  console.log(
    `[041] overlay case, the frame's own document: ${JSON.stringify(
      await field.evaluate((element) => ({
        activeElement: element.ownerDocument.activeElement?.tagName ?? null,
        fieldIsActive: element.ownerDocument.activeElement === element,
        hasFocus: element.ownerDocument.hasFocus(),
      })),
    )}`,
  );
  expect(await field.inputValue(), "the frame field was typed into after focus left it").toBe("seed");
  expect(await topField.inputValue(), "the top-document input was typed into").toBe("");
  expect(refused.text, refused.text).toContain("focus-lost");

  // ===== the same page without the overlay and the handler: the text lands =====
  await page.evaluate(() => {
    (window as unknown as { __hp041Armed?: boolean }).__hp041Armed = false;
    document.getElementById("overlay-041")?.remove();
  });
  const typed = (await call("type", { tabId, target: { ref: await readRef() }, text: "landed", mode: "replace" })) as Typed;
  expect(typed, JSON.stringify(typed)).toMatchObject({ observed: { effect: "text-entered", verified: true, verdict: "verified" } });
  await expect(field).toHaveValue("landed");
  expect(await topField.inputValue(), "the top-document input was typed into").toBe("");
}

async function boxOf(locator: ReturnType<Page["locator"]>): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("no-box");
  return box;
}

type SessionContext = {
  context: BrowserContext;
  worker: PackagedWorker;
  call: Caller;
  callRaw: RawCaller;
  settings: SettingsPageDriver;
};

/** The pairing, panel and settings plumbing every sibling journey repeats, around one test body. */
async function withSession(fixtures: Fixtures, body: (session: SessionContext) => Promise<void>): Promise<void> {
  const { extensionContext, extensionId, extensionWorker } = fixtures;
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
  const panel = await openSidePanel({ context: extensionContext, extensionId, fixturePage: ownerPage, tabId: ownerTabId, copy });
  await waitForAgentPanel(panel);
  const settings = await openSettingsPage({ context: extensionContext, worker: extensionWorker, extensionId, locale, route: "#sites" });

  let client: McpHarnessClient | undefined;
  try {
    client = await startMcpClient({ clientName: "Claude Code" });
    const live = client;
    await panel.clickIfPresent(ui("agent.retry"));
    await pairWithFirstCall(live, panel, { locale });
    const call: Caller = async (tool, args) => {
      const result = await live.callTool(tool, args);
      expect(result.isError, `${tool} failed: ${result.text}\nmcp-server stderr:\n${live.stderr()}`).toBe(false);
      return result.json;
    };
    // The same call without the success assertion, for a refusal that is the claim under test.
    const callRaw: RawCaller = async (tool, args) => {
      const result = await live.callTool(tool, args);
      return { isError: result.isError, text: result.text };
    };
    await body({ context: extensionContext, worker: extensionWorker, call, callRaw, settings });
  } finally {
    // Both sites go back to the default: agent-frame-consent starts from "the frame's site asks".
    for (const site of [SITE, SECOND]) await settings.revokeSite(site).catch(() => undefined);
    await client?.close();
  }
}

/** Opens one page as a tab of the session, under skip-checks for its site and the frame's, with the tab in front. */
async function openTab(session: SessionContext, url: string): Promise<{ tabId: number; page: Page }> {
  const { context, worker, call, settings } = session;
  // The settings page lists a site once a session tab is on it: the frame's site gets one for a moment.
  const second = (await call("tabs_create", { url: `${SECOND}/ordinary` })) as { tabId: number };
  await agentPage(context, (candidate) => candidate.startsWith(`${SECOND}/ordinary`));
  await settings.setSiteMode(SECOND, "skip-checks");
  await worker.evaluate(async (id: number) => {
    await chrome.tabs.remove(id).catch(() => undefined);
  }, second.tabId);

  const created = (await call("tabs_create", { url })) as { tabId: number };
  const page = await agentPage(context, (candidate) => candidate === url || candidate.startsWith(`${url}/`) || candidate.startsWith(`${url}?`));
  await settings.setSiteMode(SITE, "skip-checks");
  await page.bringToFront();
  return { tabId: created.tabId, page };
}

/** The Playwright page for a tab the *agent* opened, so the fixture can be read independently. */
async function agentPage(
  context: { pages: () => Page[] },
  matches: (url: string) => boolean,
  timeoutMs = 30_000,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = context.pages().find((page) => matches(page.url()));
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("agent-tab-not-found");
}
