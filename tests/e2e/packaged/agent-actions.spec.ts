import type { Page } from "@playwright/test";
import { lookup } from "../../../apps/extension/src/locales/catalog.js";
import { startMcpClient, type McpHarnessClient } from "../../harness/mcp-client.js";
import { pairWithFirstCall } from "../fixtures/agent-pairing.js";
import { copyFor, localeFromEnv, openSidePanel, waitForAgentPanel, type SidePanelDriver } from "../fixtures/side-panel-driver.js";
import { expect, test } from "../fixtures/packaged-extension.js";

const locale = localeFromEnv();
const copy = copyFor(locale);
const ui = (key: string): string => lookup(key, locale);

/** The fixture origin, which is also the site the owner's per-site mode is keyed by (R-108). */
const SITE = "https://127.0.0.1:19443";

/**
 * 003/T031 — US3 end to end: every effect tool on the packaged extension, under the owner's
 * per-site consent (FR-040..FR-043).
 *
 * The claims are the ones only a real browser can settle. Each effect is asserted twice: once by
 * what the tool *reported observing*, and once by what the fixture page actually shows afterwards -
 * because FR-040's rule is that an `ok` names something that was observed, and a journey that read
 * only the tool's own answer could not tell the difference between a real effect and a claim.
 *
 * The consent half is asserted the same way: under `ask` the owner is shown the question in the
 * panel, presses Deny, and the page is checked to be exactly as it was (SC-023).
 *
 * Attach mode only, for the same reason the pairing journey is: the bridge starts with a machine
 * install, and a browser this gate launched itself would prove nothing about it.
 *
 * Prerequisites: `npm run build:extension:agent`, `dist/agent` loaded in the attached browser,
 * `npm run agent-host:install`, and the three test services running (ports 18786/18787/19443).
 */
test.describe("agent actions", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT,
    "attach mode only: the native-messaging host is a machine install, so the browser under test " +
      "must be one the runner started and pointed at the installed host (HALLPASS_CDP_ENDPOINT).",
  );

  test("runs each effect under skip-checks, and asks and obeys the owner under ask", async ({
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

    // Deliberately a fixture the agent never visits: every assertion below reads the page at a
    // fixture url, so the owner's own tab must never be sitting on one of them.
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
      const call = callerFor(() => client);
      await panel.clickIfPresent(ui("agent.retry"));
      // T098a: the prompt by its own key, Accept clicked, and pairing confirmed by a signal that
      // is false when nothing is paired - the panel's section heading is on screen either way.
      await pairWithFirstCall(client, panel, { locale });

      // --- The session opens its own tab. It is the only tab any effect below may touch. ---
      const created = await call("tabs_create", { url: `${SITE}/ordinary` });
      const tabId = (created as { tabId: number }).tabId;
      expect(typeof tabId).toBe("number");
      // SC-024: the owner's own tab, which the session did not create, is refused by name. No
      // session holds it, so the reason is "not yours" rather than the name of another holder.
      const foreign = await client.callTool("click", { tabId: ownerTabId, target: { x: 10, y: 10 } });
      expect(foreign.isError).toBe(true);
      expect(foreign.json).toMatchObject({ outcome: "denied", reason: "not-yours" });

      // --- The owner puts this site into skip-checks, from the panel's own site list. ---
      await setSiteMode(panel, SITE, "skip-checks");

      // ================= click =================
      const ordinary = await agentPage(extensionContext, `${SITE}/ordinary`);
      const clickRef = await refFor(call, tabId, "Safe action");
      const clicked = await call("click", { tabId, target: { ref: clickRef } });
      expect(clicked).toMatchObject({ observed: { effect: "activated", verified: true } });
      await expect(ordinary.locator("#clicked")).not.toHaveText("not clicked yet");

      // ================= type =================
      const notesRef = await refFor(call, tabId, "notes");
      const typed = await call("type", { tabId, target: { ref: notesRef }, text: "agent typed here" });
      expect(typed).toMatchObject({ observed: { effect: "text-entered", verified: true } });
      await expect(ordinary.locator('input[name="notes"]')).toHaveValue("agent typed here");

      // ================= scroll =================
      const scrolled = await call("scroll", { tabId, direction: "down", amount: "large" });
      expect(scrolled).toMatchObject({ observed: { effect: "scrolled", verified: true } });
      expect(await ordinary.evaluate(() => window.scrollY)).toBeGreaterThan(0);

      // ================= key, on the tags fixture =================
      const toTags = await call("navigate", { tabId, url: `${SITE}/tags` });
      expect(toTags).toEqual({ url: `${SITE}/tags` });
      const tags = await agentPage(extensionContext, `${SITE}/tags`);
      const tagRef = await refFor(call, tabId, "Tag");
      await call("type", { tabId, target: { ref: tagRef }, text: "kittens" });
      const pressed = await call("key", { tabId, target: { ref: tagRef }, key: "Enter" });
      expect(pressed).toMatchObject({ observed: { effect: "key-pressed", verified: true } });
      await expect(tags.locator("#tags li")).toHaveText(["kittens"]);

      // ================= hover, double_click, drag, on the gestures fixture =================
      await call("navigate", { tabId, url: `${SITE}/gestures` });
      const gestures = await agentPage(extensionContext, `${SITE}/gestures`);
      const menuRef = await refFor(call, tabId, "Menu");
      const hovered = await call("hover", { tabId, target: { ref: menuRef } });
      expect(hovered).toMatchObject({ observed: { effect: "hovered", verified: true } });
      await expect(gestures.locator("#menu-items")).not.toHaveClass(/closed/);

      const doubleRef = await refFor(call, tabId, "Open on double-click");
      const doubled = await call("double_click", { tabId, target: { ref: doubleRef } });
      expect(doubled).toMatchObject({ observed: { effect: "double-activated", verified: true } });
      await expect(gestures.locator("#opened")).toHaveText("opened by double-click");

      // Two endpoints, named as *points* rather than as refs. A `find` re-collects the page, and a
      // collection invalidates every handle the previous one issued, so two finds cannot produce
      // two live refs at once. Points go through `content.resolve-point`, which registers what the
      // browser says is at that coordinate without disturbing the registry - which is the whole
      // reason US3 decision 2 made a point a ref rather than a second addressing scheme.
      const from = await centreOf(gestures, "#alpha button");
      const to = await centreOf(gestures, "#beta button");
      const dragged = await call("drag", { tabId, from, to });
      expect(dragged).toMatchObject({ observed: { effect: "dragged", verified: true } });
      expect(await gestures.locator("#list li").evaluateAll((rows) => rows.map((row) => row.id))).toEqual([
        "beta",
        "alpha",
      ]);

      /*
       * ============ right_click and triple_click, whose only witness is the page (T069) ============
       *
       * Neither gesture leaves anything behind on its own: a right button opens the *browser's*
       * menu, and a triple click selects text. The fixture listens for both, so what is asserted
       * here is the page's own account of what it received, not the tool's.
       */
      const contextRef = await refFor(call, tabId, "Context target");
      const rightClicked = await call("right_click", { tabId, target: { ref: contextRef } });
      expect(rightClicked).toMatchObject({ observed: { effect: "context-activated", verified: true } });
      await expect(gestures.locator("#gesture-log")).toHaveText("context menu requested");

      // A fresh ref: `find` re-collects the page, and a collection invalidates the handles the
      // previous one issued.
      const tripleRef = await refFor(call, tabId, "Context target");
      const tripled = await call("triple_click", { tabId, target: { ref: tripleRef } });
      expect(tripled).toMatchObject({ observed: { effect: "triple-activated", verified: true } });
      await expect(gestures.locator("#gesture-log")).toHaveText("triple click seen");

      // ================= form_input, on the form fixture =================
      await call("navigate", { tabId, url: `${SITE}/form` });
      const form = await agentPage(extensionContext, `${SITE}/form`);
      const nicknameRef = await refFor(call, tabId, "nickname");
      const set = await call("form_input", { tabId, ref: nicknameRef, value: "agent-set-value" });
      expect(set).toMatchObject({ observed: { effect: "value-set", valueMatched: true, verified: true } });
      await expect(form.locator('input[name="nickname"]')).toHaveValue("agent-set-value");

      /**
       * ================= the controls a reviewed collection cannot name (003/B1) =================
       *
       * A checkbox, a select and a submit button. None of them got a ref before this fix - the
       * remote path mints one only where a *reviewed* effect could land - so `form_input`'s boolean
       * and option arms and every click on a submit control were unreachable through the tools. One
       * structural read supplies all three refs, because a read invalidates the previous read's.
       */
      const controls = (await call("read_page", { tabId, filter: "interactive" })) as {
        nodes: Array<{ ref?: string; role: string; name?: string }>;
      };
      const control = (name: string, role: string): string => {
        const node = controls.nodes.find((candidate) => candidate.name === name && candidate.ref !== undefined);
        expect(node, `read_page offered no ${role} named '${name}': ${JSON.stringify(controls.nodes)}`).toBeTruthy();
        expect(node?.role, name).toBe(role);
        return node?.ref as string;
      };

      const ticked = await call("form_input", { tabId, ref: control("agree", "checkbox"), value: true });
      expect(ticked).toMatchObject({ observed: { effect: "value-set", valueMatched: true, verified: true } });
      await expect(form.locator('input[name="agree"]')).toBeChecked();

      const chosen = await call("form_input", { tabId, ref: control("plan", "combobox"), value: "pro" });
      expect(chosen).toMatchObject({ observed: { effect: "value-set", valueMatched: true, verified: true } });
      await expect(form.locator('select[name="plan"]')).toHaveValue("pro");

      const submitted = await call("click", { tabId, target: { ref: control("Sign in", "button") } });
      expect(submitted).toMatchObject({ observed: { effect: "activated", verified: true } });
      // The page's own submit handler ran, on a control the reviewed walk offers no handle for.
      await expect(form.locator("#submitted")).toHaveText("signed in as nobody (agreed)");

      // ================= a ref that outlived its document =================
      await call("navigate", { tabId, url: `${SITE}/ordinary` });
      const stale = await client.callTool("form_input", { tabId, ref: nicknameRef, value: "should not land" });
      expect(stale.isError).toBe(true);
      expect(stale.json).toMatchObject({ outcome: "stale" });

      // ================= two effects on one tab at once =================
      const ordinaryAgain = await agentPage(extensionContext, `${SITE}/ordinary`);
      const raceRef = await refFor(call, tabId, "Safe action");
      const [, second] = await Promise.all([
        client.callTool("click", { tabId, target: { ref: raceRef } }),
        client.callTool("hover", { tabId, target: { ref: raceRef } }),
      ]);
      // FR-043: one call in flight per tab. The loser is told `busy`, not queued and not run twice.
      expect(second.isError).toBe(true);
      expect(second.json).toMatchObject({ outcome: "busy" });

      // ================= ask: the owner is shown the question, and says no (SC-023) =================
      await setSiteMode(panel, SITE, "ask");
      const before = await ordinaryAgain.locator("#clicked").textContent();
      const denyRef = await refFor(call, tabId, "Safe action");
      const asked = client.callTool("click", { tabId, target: { ref: denyRef } });

      await panel.waitForText(ui("agent.promptTitle"));
      expect(await panel.panelText()).toContain(SITE);
      await panel.clickButton(ui("agent.refuse"));

      const denied = await asked;
      expect(denied.isError).toBe(true);
      expect(denied.json).toMatchObject({ outcome: "denied", reason: "owner-denied" });
      // Nothing ran: the page is exactly as the owner left it.
      expect(await ordinaryAgain.locator("#clicked").textContent()).toBe(before);

      // ================= ask: the owner says yes, and it runs =================
      const allowRef = await refFor(call, tabId, "Safe action");
      const allowed = client.callTool("click", { tabId, target: { ref: allowRef } });
      await panel.waitForText(ui("agent.promptTitle"));
      await panel.clickButton(ui("agent.allowOnce"));
      const ran = await allowed;
      expect(ran.isError, `mcp-server stderr:\n${client.stderr()}`).toBe(false);
      expect(await ordinaryAgain.locator("#clicked").textContent()).not.toBe(before);

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

/** The first ref `find` returns for a description, which is how every effect below names a target. */
async function refFor(
  call: (tool: string, args: Record<string, unknown>) => Promise<unknown>,
  tabId: number,
  query: string,
): Promise<string> {
  const found = (await call("find", { tabId, query })) as {
    outcome: string;
    matches: Array<{ ref: string }>;
  };
  expect(found.outcome, `find '${query}' answered ${found.outcome}`).toBe("resolved");
  const first = found.matches[0]?.ref;
  expect(first, `find '${query}' returned no ref`).toBeTruthy();
  return first as string;
}

/** The viewport centre of one element, as the coordinate an agent would point at. */
async function centreOf(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const box = await page.locator(selector).boundingBox();
  expect(box, `no box for ${selector}`).toBeTruthy();
  if (!box) throw new Error(`no-box:${selector}`);
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
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
  // The worker answers with a fresh projection; waiting for it is what makes the next call's mode
  // the one just chosen rather than a race with it.
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
