import type { Page } from "@playwright/test";
import { lookup } from "../../../apps/extension/src/locales/catalog.js";
import { startMcpClient, type McpHarnessClient } from "../../harness/mcp-client.js";
import { pairWithFirstCall } from "../fixtures/agent-pairing.js";
import { copyFor, localeFromEnv, openSidePanel, waitForAgentPanel, type SidePanelDriver } from "../fixtures/side-panel-driver.js";
import { expect, test } from "../fixtures/packaged-extension.js";

const locale = localeFromEnv();
const copy = copyFor(locale);
const ui = (key: string): string => lookup(key, locale);

const SITE = "https://127.0.0.1:19443";
/** The sibling fixture port `frames.html` frames on a second origin (T129, B71). */
const CROSS_SITE = "https://127.0.0.1:19445";
/**
 * A genuinely different *site* from `SITE`, not just a different origin (T129, B73/B74). `CROSS_SITE`
 * above is the same host (`127.0.0.1`) on a different port - cross-origin, but same-site, and never
 * an out-of-process iframe. `localhost` and `127.0.0.1` are different sites even though both resolve
 * to this one loopback fixture server, which is what makes `frames-oopif.html`'s child a real OOPIF.
 */
const OOPIF_SITE = "https://localhost:19443";

/**
 * 004/T128 — US5 end to end: real input delivery, on the fixtures S4's own probe scenarios were
 * measured against (`hover-menu.html`, `combobox.html`, `frames.html`), in one packaged journey.
 *
 * Five claims, each the thing only a real browser settles:
 *   1. A hover that a page's own `:hover` rule opens a menu under opens that menu for this
 *      extension too, and the menu's own item is then a live target (SC-034).
 *   2. Typing arrives key by key: the fixture's `keydown` counter - which a bulk value assignment
 *      would leave at zero - reaches the full length of what was typed, and the suggestion list its
 *      own per-key handler draws is what proves it (R-113, SC-034's distinguishing claim).
 *   3. A click inside a *nested* child frame lands on that frame's own control, with both frames'
 *      offsets applied (R-114, SC-033's act half - `frames.html` is the S3/S4 shared fixture).
 *   4. A tab Chrome will not let this extension attach to - because something else already holds
 *      the one debugger slot the way DevTools does - answers `input-unavailable` rather than
 *      failing obscurely or falling back to a page-level route (R-113).
 *   5. Under `ask`, every effect is its own prompt: the owner is asked, answers, and is asked again
 *      for the next one - not remembered past the one occurrence it was raised for.
 *
 * Attach mode only, for the same reason every other agent journey is: the bridge starts with a
 * machine install, and a browser this gate launched itself would prove nothing about it.
 *
 * Prerequisites: `npm run build:extension:agent`, `dist/agent` loaded in the attached browser,
 * `npm run agent-host:install`, and the test fixture services running (ports 18786/18787/19443).
 */
test.describe("agent input", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT,
    "attach mode only: the native-messaging host is a machine install, so the browser under test " +
      "must be one the runner started and pointed at the installed host (HALLPASS_CDP_ENDPOINT).",
  );

  test("delivers a real hover, per-key typing, a nested-frame click, refuses a DevTools-held tab, and re-asks per effect", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(300_000);

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
      await pairWithFirstCall(live, panel, { locale });

      // ================= 1. hover opens the CSS submenu, and a submenu item is then clickable =================
      const hoverCreated = (await call("tabs_create", { url: `${SITE}/hover-menu` })) as { tabId: number };
      const tabId = hoverCreated.tabId;
      const hoverPage = await agentPage(extensionContext, `${SITE}/hover-menu`);
      // The site appears in the panel's own list only once a tab has visited it - so the mode is
      // set from here, the same order every other agent journey uses.
      await setSiteMode(panel, SITE, "skip-checks");

      const beforeHover = (await call("read_page", { tabId, filter: "interactive" })) as {
        nodes: Array<{ name?: string }>;
      };
      expect(
        beforeHover.nodes.some((node) => node.name === "Release notes"),
        "the submenu link must not be reachable before the trigger is hovered",
      ).toBe(false);

      // The trigger is an `<a href>` inside the `<li>` the page's own `:hover` rule matches
      // (`nav li:hover > ul`), so the target is the pointer position the CSS rule cares about, not
      // a ref - the same point-target route `drag` already uses for an endpoint the tree has no
      // single control for.
      const triggerPoint = await centreOf(hoverPage, "#menu-docs");
      const hovered = await call("hover", { tabId, target: triggerPoint });
      expect(hovered).toMatchObject({ observed: { effect: "hovered", verified: true } });

      const releaseRef = await refFor(call, tabId, "Release notes");
      const submenuClicked = await call("click", { tabId, target: { ref: releaseRef } });
      // The submenu item is an in-page anchor, so the click changes the document (a hash
      // navigation) and post-effect verification is conservative about that - the verdict word is
      // not the strongest evidence a submenu item "is then clickable" has to offer (004/B60). What
      // the page itself does when the item is clicked is: the hash the browser navigates to, which
      // only a genuine click delivery produces. Key the claim on that rather than on `verified`.
      expect(submenuClicked).toMatchObject({ observed: { effect: "activated" } });
      await expect.poll(() => hoverPage.url()).toContain("#release-notes");

      // ================= 2. per-key typing shows the combobox suggestions =================
      await call("navigate", { tabId, url: `${SITE}/combobox` });
      const comboPage = await agentPage(extensionContext, `${SITE}/combobox`);
      const queryRef = await refFor(call, tabId, "Search");
      const typedWord = "apple";
      // The field starts empty (004/T128 follow-up): `mode: "insert"` skips the replace-mode
      // select-all-then-delete `type` sends by default, which is two more real keystrokes the
      // fixture's own counter would otherwise see too - real per the same mechanism this claim is
      // about, but no part of what "typed a word" means here.
      const typed = await call("type", {
        tabId,
        target: { ref: queryRef },
        text: typedWord,
        mode: "insert",
      });
      expect(typed).toMatchObject({
        observed: { effect: "text-entered", verified: true, charactersChanged: typedWord.length },
      });
      // The fixture's own `keydown` counter is the distinguishing evidence (combobox.html's own
      // comment): a value assigned in one event would leave it at 0, so a count equal to the typed
      // word's length is per-key delivery observed from the page's side, not the tool's.
      await expect(comboPage.locator("#keystroke-count")).toHaveText(String(typedWord.length));
      await expect(comboPage.locator("#suggestions li")).toContainText([typedWord]);
      const afterType = (await call("read_page", { tabId, filter: "interactive" })) as {
        nodes: Array<{ role: string; name?: string }>;
      };
      const suggestion = afterType.nodes.find((node) => node.name === typedWord);
      expect(suggestion, `no "${typedWord}" option in the read after typing`).toBeTruthy();
      expect(suggestion?.role).toBe("option");

      // ================= 3. a click inside a child frame lands, with the frame's offset applied =================
      await call("navigate", { tabId, url: `${SITE}/frames` });
      const framesPage = await agentPage(extensionContext, `${SITE}/frames`);
      // The grandchild rather than either direct child: its name is unique on the page (both
      // children share "Child action"), and it proves the offset was applied through two nested
      // frames rather than one.
      const grandchildRef = await refFor(call, tabId, "Grandchild action");
      const framedClick = await call("click", { tabId, target: { ref: grandchildRef } });
      expect(framedClick).toMatchObject({ observed: { effect: "activated", verified: true } });
      const grandchildFrame = framesPage.frames().find((frame) => frame.url().includes("/frames-grandchild"));
      expect(grandchildFrame, "the grandchild frame never loaded").toBeTruthy();
      await expect(grandchildFrame!.locator("#child-echo")).toHaveText("grandchild clicked");

      // ============ 3b. a click inside the *cross-origin* child lands too (T129, B71) ============
      // Both direct children share the name "Child action", so the cross-origin one is picked by
      // frame rather than by (ambiguous) name - the same disambiguation `agent-frames.spec.ts`
      // already uses for reading.
      const structure = (await call("read_page", { tabId, filter: "interactive" })) as {
        frames?: Array<{ frame: string; url: string }>;
        nodes: Array<{ ref?: string; name?: string; frame?: string }>;
      };
      const crossFrameLabel = structure.frames?.find((frame) => frame.url.startsWith(CROSS_SITE))?.frame;
      expect(crossFrameLabel, `no frame on ${CROSS_SITE}: ${JSON.stringify(structure.frames)}`).toBeTruthy();
      const crossBtn = structure.nodes.find(
        (node) => node.name === "Child action" && node.frame === crossFrameLabel,
      );
      expect(crossBtn?.ref, `cross-origin child's button has no ref: ${JSON.stringify(structure.nodes)}`).toBeTruthy();
      const crossClicked = await call("click", { tabId, target: { ref: crossBtn!.ref! } });
      expect(crossClicked).toMatchObject({ observed: { effect: "activated", verified: true } });
      const crossOriginFrame = framesPage.frames().find((frame) => frame.url().startsWith(CROSS_SITE));
      expect(crossOriginFrame, "the cross-origin frame never loaded").toBeTruthy();
      await expect(crossOriginFrame!.locator("#child-echo")).toHaveText("child clicked");

      await call("tabs_close", { tabId });

      // ================= 4. a tab already attached by DevTools answers input-unavailable =================
      const heldCreated = (await call("tabs_create", { url: `${SITE}/ordinary` })) as { tabId: number };
      const heldTabId = heldCreated.tabId;
      // Chrome allows exactly one debugger client per tab, DevTools included, and refuses a second
      // with the same message regardless of who the first one is - so attaching here from the
      // extension's own worker, ahead of the effect, reproduces the identical refusal a real
      // DevTools window open on this tab would (input.ts's `attachFailureReason`).
      await extensionWorker.evaluate(async (id) => {
        await chrome.debugger.attach({ tabId: id }, "1.3");
      }, heldTabId);
      try {
        const heldRef = await refFor(call, heldTabId, "Safe action");
        const refused = await live.callTool("click", { tabId: heldTabId, target: { ref: heldRef } });
        expect(refused.isError, `mcp-server stderr:\n${live.stderr()}`).toBe(true);
        expect(refused.json).toMatchObject({
          outcome: "failed",
          reason: "input-unavailable",
          refusal: { reason: "input-unavailable", unavailableReason: "devtools-open" },
        });
      } finally {
        await extensionWorker.evaluate(async (id) => {
          await chrome.debugger.detach({ tabId: id });
        }, heldTabId);
      }
      await call("tabs_close", { tabId: heldTabId });

      // ================= 5. ask mode still prompts the owner once per effect =================
      await setSiteMode(panel, SITE, "ask");
      const askCreated = (await call("tabs_create", { url: `${SITE}/ordinary` })) as { tabId: number };
      const askTabId = askCreated.tabId;
      const askPage = await agentPage(extensionContext, `${SITE}/ordinary`);

      const firstRef = await refFor(call, askTabId, "Safe action");
      const first = live.callTool("click", { tabId: askTabId, target: { ref: firstRef } });
      await panel.waitForText(ui("agent.promptTitle"));
      await panel.clickButton(ui("agent.allowOnce"));
      const firstResult = await first;
      expect(firstResult.isError, `mcp-server stderr:\n${live.stderr()}`).toBe(false);
      await expect(askPage.locator("#clicked")).not.toHaveText("not clicked yet");

      // The prompt is gone once answered - if it were not asked again below, this would be silent
      // rather than a second, distinguishable prompt.
      expect(await panel.panelText()).not.toContain(ui("agent.promptTitle"));

      const secondRef = await refFor(call, askTabId, "Safe action");
      const second = live.callTool("hover", { tabId: askTabId, target: { ref: secondRef } });
      await panel.waitForText(ui("agent.promptTitle"));
      await panel.clickButton(ui("agent.allowOnce"));
      const secondResult = await second;
      expect(secondResult.isError, `mcp-server stderr:\n${live.stderr()}`).toBe(false);

      await call("tabs_close", { tabId: askTabId });
    } finally {
      await client?.close();
    }
  });

  /**
   * 004/T129 (B74, keyboard closed in B76) - a click and then typing, both inside a genuine
   * cross-site (out-of-process) child frame.
   *
   * `frames.html`'s cross-origin child (3b above) is same host, different port: cross-origin but
   * same *site*, so it has never been an OOPIF and the offset-composition path above already reaches
   * it. `frames-oopif.html` frames a genuinely different site - `localhost` from `127.0.0.1`, same
   * port - which Chrome's site isolation puts in its own process. `chrome.debugger.getTargets()` is
   * asked directly, ahead of the click, as the fixture's own proof that this child really is an
   * OOPIF rather than an assumption about what the two hostnames produce.
   *
   * B75 routed the click through the frame's own CDP session but left keyboard dispatch on the
   * tab's top-level one unconditionally, so a field inside a true OOPIF could be focused but not
   * typed into. The typing half proves the fix the same way the click half proves the session
   * routing: page-authored evidence inside the OOPIF's own document, not a verdict word.
   */
  test("delivers a click and then typing inside a genuine cross-site (out-of-process) child frame (T129)", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(120_000);

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
      await pairWithFirstCall(client, panel, { locale });

      const created = (await call("tabs_create", { url: `${SITE}/frames-oopif` })) as { tabId: number };
      const tabId = created.tabId;
      const oopifPage = await agentPage(extensionContext, `${SITE}/frames-oopif`);
      await setSiteMode(panel, SITE, "skip-checks");

      // ============ the fixture's own proof: Chrome really did put the child out of process ============
      // An ordinary (same-process) iframe - same-origin or cross-origin-same-site, as `frames.html`'s
      // children both are - never appears in this list at all; only the tab's own top-level document
      // does, carrying its `tabId`. A frame Chrome put in its own process shows up here as an
      // independent target with no `tabId` of its own (measured directly: B74 probe against this same
      // fixture), which is the fixture's own proof rather than an assumption about what two hostnames
      // produce.
      await expect
        .poll(() =>
          extensionWorker.evaluate(async (origin) => {
            const targets = (await chrome.debugger.getTargets()) as Array<{ url?: string }>;
            return targets.some((target) => target.url?.startsWith(origin));
          }, OOPIF_SITE),
        )
        .toBe(true);

      const structure = (await call("read_page", { tabId, filter: "interactive" })) as {
        frames?: Array<{ frame: string; url: string }>;
        nodes: Array<{ ref?: string; name?: string; role?: string; frame?: string }>;
      };
      const oopifFrameLabel = structure.frames?.find((frame) => frame.url.startsWith(OOPIF_SITE))?.frame;
      expect(oopifFrameLabel, `no frame on ${OOPIF_SITE}: ${JSON.stringify(structure.frames)}`).toBeTruthy();
      const oopifBtn = structure.nodes.find(
        (node) => node.name === "Child action" && node.frame === oopifFrameLabel,
      );
      expect(oopifBtn?.ref, `OOPIF child's button has no ref: ${JSON.stringify(structure.nodes)}`).toBeTruthy();

      const clicked = await call("click", { tabId, target: { ref: oopifBtn!.ref! } });
      expect(clicked).toMatchObject({ observed: { effect: "activated", verified: true } });
      const oopifFrame = oopifPage.frames().find((frame) => frame.url().startsWith(OOPIF_SITE));
      expect(oopifFrame, "the out-of-process frame never loaded").toBeTruthy();
      // The frame's own page-authored echo, not a verdict word: only a click that actually landed
      // inside that frame's own document sets this.
      await expect(oopifFrame!.locator("#child-echo")).toHaveText("child clicked");

      // ============ typing into a field inside the same out-of-process frame (B76, T129) ============
      // The click above focused an element in the OOPIF's own session; `type` clicks its target
      // first too (deliverKeyboard's own order), so the correlation this proves is the same one -
      // the keys have to follow the click onto that session, not the tab's own top-level one.
      const oopifInput = structure.nodes.find(
        (node) => node.role === "textbox" && node.frame === oopifFrameLabel,
      );
      expect(oopifInput?.ref, `OOPIF child's note field has no ref: ${JSON.stringify(structure.nodes)}`).toBeTruthy();
      const typedWord = "hi";
      const typed = await call("type", {
        tabId,
        target: { ref: oopifInput!.ref! },
        text: typedWord,
        mode: "insert",
      });
      expect(typed).toMatchObject({
        observed: { effect: "text-entered", verified: true, charactersChanged: typedWord.length },
      });
      // The frame's own page-authored echo of the field's value, not a verdict word: only reachable
      // if the keystrokes actually landed inside this frame's own document.
      await expect(oopifFrame!.locator("#child-typed")).toHaveText(`typed: ${typedWord}`);

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
