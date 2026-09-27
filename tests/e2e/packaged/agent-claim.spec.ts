import { lookup } from "../../../apps/extension/src/locales/catalog.js";
import { groupTitle, isAgentGroupTitle } from "../fixtures/agent-group.js";
import { INDICATOR_MARKER_ATTRIBUTE } from "../../../apps/extension/src/content-runtime/indicator-marker.js";
import { startMcpClient, type McpHarnessClient } from "../../harness/mcp-client.js";
import { pairWithFirstCall, unpairAgent } from "../fixtures/agent-pairing.js";
import { copyFor, localeFromEnv, openSidePanel, waitForAgentPanel } from "../fixtures/side-panel-driver.js";
import { expect, test } from "../fixtures/packaged-extension.js";

const locale = localeFromEnv();
const copy = copyFor(locale);
const ui = (key: string): string => lookup(key, locale);

const SITE = "https://127.0.0.1:19443";

/**
 * 004/T110 — US3 end to end: the owner's own tab, claimed (FR-060..FR-062, SC-032).
 *
 * Every other agent journey works on tabs the agent made. This one is about the tab the *owner*
 * opened, which is the whole of US3: the tab is opened here through CDP - a page this test drove
 * the browser to create, never `tabs_create` - so "the agent did not open it" is a fact about how
 * the tab exists rather than a claim in a comment.
 *
 * The last case is the one no unit test can reach. The indicator's control must answer the owner
 * and nobody else, and `isTrusted` is unforgeable by design: the page's own `click()` is driven
 * here through `Runtime.evaluate` and must do nothing, and the same control is then clicked with
 * `Input.dispatchMouseEvent` at its own coordinates - which is what the browser makes when a person
 * presses a mouse button - and must bring the session's main tab forward.
 */
test.describe("agent claim", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT,
    "attach mode only: the native-messaging host is a machine install, so the browser under test " +
      "must be one the runner started and pointed at the installed host (HALLPASS_CDP_ENDPOINT).",
  );

  test("lists, claims, reads and releases the owner's tab, and answers its indicator", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(360_000);

    const permissions = await extensionWorker.evaluate(() => chrome.runtime.getManifest().permissions ?? []);
    expect(
      permissions,
      "the attached browser must have apps/extension/dist/agent loaded (npm run build:extension:agent)",
    ).toContain("tabGroups");

    const ownerPage = extensionContext.pages()[0] ?? (await extensionContext.newPage());
    await ownerPage.goto(`${SITE}/waiting`);
    await ownerPage.bringToFront();
    const panelTabId = await extensionWorker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined) throw new Error("active-tab-missing");
      return tab.id;
    });

    const panel = await openSidePanel({
      context: extensionContext,
      extensionId,
      fixturePage: ownerPage,
      tabId: panelTabId,
      copy,
    });
    await waitForAgentPanel(panel);

    let client: McpHarnessClient | undefined;
    let second: McpHarnessClient | undefined;
    let slow: McpHarnessClient | undefined;
    try {
      client = await startMcpClient({ clientName: "Claude Code" });
      const live = client;
      await panel.clickIfPresent(ui("agent.retry"));
      await pairWithFirstCall(live, panel, { locale });

      const call = async (tool: string, args: Record<string, unknown> = {}): Promise<unknown> => {
        const result = await live.callTool(tool, args);
        expect(result.isError, `${tool} failed: ${result.text}\nstderr:\n${live.stderr()}`).toBe(false);
        return result.json;
      };

      // ============ 1. a tab this test opened through CDP is listed, held by nobody ============
      // `newPage` on the attached context is a CDP `Target.createTarget`: the browser makes the tab
      // because this test asked it to, exactly as it would for a person opening one. No tool of the
      // agent's was involved, and the session has never heard of it.
      const ownersOwn = await extensionContext.newPage();
      await ownersOwn.goto(`${SITE}/ordinary`);
      const owned = await extensionWorker.evaluate(async (url: string) => {
        const [tab] = await chrome.tabs.query({ url });
        if (tab?.id === undefined) throw new Error("owner-tab-missing");
        return { tabId: tab.id, title: tab.title ?? "" };
      }, `${SITE}/ordinary`);

      type Row = { tabId: number; url: string; title: string; active: boolean; holder: unknown };
      const listed = (await call("tabs_context")) as Row[];
      const row = listed.find((tab) => tab.tabId === owned.tabId);
      expect(row, `the owner's tab is not in ${JSON.stringify(listed)}`).toBeDefined();
      expect(row?.holder).toBe("none");
      // FR-060's title, and the browser's own record of it - the same string Chrome answers with,
      // never a word read out of the document, which listing takes no lease to do.
      expect(row?.title).toBe(owned.title);
      expect(row?.title.length).toBeGreaterThan(0);

      // ============ 2. the session claims it: it joins the group, and reads and effects work ======
      const claimed = (await call("tabs_claim", { tabId: owned.tabId })) as { tabId: number; groupId: number };
      expect(claimed.tabId).toBe(owned.tabId);
      const grouping = await extensionWorker.evaluate(async (id: number) => {
        const tab = await chrome.tabs.get(id);
        const group = tab.groupId === undefined || tab.groupId < 0 ? undefined : await chrome.tabGroups.get(tab.groupId);
        return { groupId: tab.groupId, title: group?.title };
      }, owned.tabId);
      expect(grouping.groupId).toBe(claimed.groupId);
      // 016 FR-238: "Hallpass", possibly with the working prefix a moment after the call (FR-239).
      await expect
        .poll(async () => isAgentGroupTitle(await groupTitle(extensionWorker, grouping.groupId)), { timeout: 15_000 })
        .toBe(true);

      const text = (await call("get_page_text", { tabId: owned.tabId })) as { text: string };
      expect(text.text.length).toBeGreaterThan(0);
      const navigated = (await call("navigate", { tabId: owned.tabId, url: `${SITE}/form` })) as { url: string };
      expect(navigated).toEqual({ url: `${SITE}/form` });

      // The session's *main* tab must be somewhere else for case 6 to mean anything: a control that
      // brought the tab it is drawn on to the front would pass while doing nothing at all.
      const mainTab = (await call("tabs_create", { url: `${SITE}/ordinary` })) as { tabId: number };

      // ============ 3. a second session's claim is refused, naming the holder ============
      second = await startMcpClient({ clientName: "Claude Code" });
      const other = second;
      await panel.clickIfPresent(ui("agent.retry"));
      const refusedClaim = await pollUntil(
        () => other.callTool("tabs_claim", { tabId: owned.tabId }),
        (result) => result.isError === true,
        45_000,
      );
      expect(refusedClaim.json, `stderr:\n${other.stderr()}`).toMatchObject({
        outcome: "denied",
        reason: "held-by-session",
      });
      // Naming the holder is the point: "somebody has it" is not something an agent can act on.
      expect(refusedClaim.text).toMatch(/sessionId|session/i);

      // ============ 4. reading a tab this session does not hold answers not-yours ============
      const notYours = await live.callTool("get_page_text", { tabId: panelTabId });
      expect(notYours.isError).toBe(true);
      expect(notYours.json).toMatchObject({ outcome: "denied", reason: "not-yours" });

      // ============ 5. the indicator is on the held tab ============
      // Everything the extension drew wears the marker - the banner and, since 2026-09-16, the
      // page-edge glow, which has no text - so the copy is read across all of it.
      const indicatorText = async (): Promise<string | undefined> =>
        ownersOwn.evaluate((marker) => {
          const marked = [...document.querySelectorAll(`[${marker}]`)];
          return marked.length === 0 ? undefined : marked.map((element) => element.textContent ?? "").join(" ");
        }, INDICATOR_MARKER_ATTRIBUTE);
      await expect
        .poll(indicatorText, {
          timeout: 15_000,
          message: "the tab the session holds must say so on the page itself (FR-062)",
        })
        .toContain(ui("agent.indicator.active"));

      // ============ 6. the control answers the owner, and only the owner ============
      await ownersOwn.bringToFront();
      const before = await extensionWorker.evaluate(async (id: number) => (await chrome.tabs.get(id)).active, mainTab.tabId);
      expect(before, "the session's main tab must start in the background").toBe(false);

      // The page's own click, through `Runtime.evaluate`: this is what a hostile page can do to its
      // own document, and it must move nothing. `isTrusted` is false on it by construction.
      const synthetic = await ownersOwn.evaluate((marker) => {
        const control = document.querySelector(`[${marker}] button`);
        if (!(control instanceof HTMLButtonElement)) return "no-control";
        control.click();
        return "clicked";
      }, INDICATOR_MARKER_ATTRIBUTE);
      expect(synthetic).toBe("clicked");
      await ownersOwn.waitForTimeout(1_000);
      expect(
        await extensionWorker.evaluate(async (id: number) => (await chrome.tabs.get(id)).active, mainTab.tabId),
        "a click the page made must not bring the agent's tab forward (R-117)",
      ).toBe(false);

      // The browser's own click, at the control's coordinates. `Input.dispatchMouseEvent` is the
      // protocol Chrome's own input pipeline is fed from, so the event the listener sees is trusted
      // in the same way a person's press is - there is no other way to make one from outside.
      const box = await ownersOwn.evaluate((marker) => {
        const control = document.querySelector(`[${marker}] button`);
        if (!(control instanceof HTMLElement)) return undefined;
        const rect = control.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      }, INDICATOR_MARKER_ATTRIBUTE);
      expect(box, "the indicator's control must be on the page to be clicked").toBeDefined();
      const cdp = await extensionContext.newCDPSession(ownersOwn);
      const point = { x: box?.x ?? 0, y: box?.y ?? 0, button: "left" as const, clickCount: 1 };
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point, clickCount: 0 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point });

      // Within a second (SC-032): the owner pressed a control and the agent's tab comes forward.
      await expect
        .poll(
          async () =>
            extensionWorker.evaluate(async (id: number) => (await chrome.tabs.get(id)).active, mainTab.tabId),
          { timeout: 1_000, intervals: [50, 100, 100, 100, 100, 100] },
        )
        .toBe(true);
      await cdp.detach();

      // ============ 5b. released, the page stops saying an agent is in it ============
      const released = (await call("tabs_release", { tabId: owned.tabId })) as { released: boolean };
      expect(released).toEqual({ released: true });
      await expect
        .poll(indicatorText, { timeout: 15_000, message: "a released tab is the owner's again (FR-062)" })
        .toBeUndefined();
      // Released means released: the next read is refused like any other tab nobody gave it.
      const afterRelease = await live.callTool("get_page_text", { tabId: owned.tabId });
      expect(afterRelease.isError).toBe(true);
      expect(afterRelease.json).toMatchObject({ outcome: "denied", reason: "not-yours" });

      await live.callTool("tabs_close", { tabId: mainTab.tabId });
      await second.close();
      second = undefined;
      await client.close();
      client = undefined;

      // ============ 7. FR-059: an accept twenty seconds late still answers the call ============
      await unpairAgent(panel, { locale });

      slow = await startMcpClient({ clientName: "Claude Code" });
      const waiting = slow;
      await panel.clickIfPresent(ui("agent.retry"));
      // The call is what raises the prompt (004 FR-059a), so it is issued first: this is the call
      // FR-059 is about, and it must be held rather than refused for the whole of the owner's twenty
      // seconds. Its client bound is past the SDK's 60 s default, which the card wait plus the twenty
      // seconds could otherwise reach.
      const held = waiting.callTool("tabs_context", {}, { timeoutMs: 120_000 });
      await panel.waitForText(ui("agent.pairingTitle"), 60_000);
      const promptedAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 20_000 - (Date.now() - promptedAt)));
      // Both sides' logs ride on the failure: a prompt that vanished inside the twenty seconds is the
      // link having dropped, the server says what it saw, and the worker's own record of why its
      // native port closed (`agentBridgeDisconnects`, 004/T169) says what Chrome told it.
      const panelTextAtTwenty = await panel.panelText();
      const drops = await extensionWorker.evaluate(async () => {
        const raw = await chrome.storage.session.get(["agentBridgeDisconnects"]);
        return JSON.stringify(raw.agentBridgeDisconnects ?? []);
      });
      expect(
        panelTextAtTwenty,
        `the pairing prompt left the panel before the accept
worker disconnects: ${drops}
stderr:
${waiting.stderr()}`,
      ).toContain(ui("agent.pairingTitle"));
      await panel.clickButton(ui("agent.accept"));

      const answered = await held;
      expect(Date.now() - promptedAt, "the accept was meant to land at twenty seconds").toBeGreaterThan(19_000);
      expect(answered.isError, `stderr:\n${waiting.stderr()}`).toBe(false);
      expect(Array.isArray(answered.json)).toBe(true);
    } finally {
      await client?.close();
      await second?.close();
      await slow?.close();
    }
  });
});

/** Retries a call until it satisfies `accept`, so a reconnect in flight is waited for, not raced. */
async function pollUntil<T>(attempt: () => Promise<T>, accept: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await attempt();
  while (!accept(last) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    last = await attempt();
  }
  return last;
}
