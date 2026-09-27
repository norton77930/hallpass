import { lookup } from "../../../apps/extension/src/locales/catalog.js";
import { startMcpClient, type McpHarnessClient } from "../../harness/mcp-client.js";
import { pairWithFirstCall, isAgentPaired } from "../fixtures/agent-pairing.js";
import { copyFor, localeFromEnv, clickLabelled, openSidePanel, waitForAgentPanel, type SidePanelDriver } from "../fixtures/side-panel-driver.js";
import { expect, test, type PackagedWorker } from "../fixtures/packaged-extension.js";

const locale = localeFromEnv();
const copy = copyFor(locale);
const ui = (key: string): string => lookup(key, locale);

const SITE = "https://127.0.0.1:19443";

/**
 * 006/T194 — the four states of the rebuilt panel, against the real worker and real `mcp-server.js`
 * sessions (SC-044–SC-047).
 *
 * The panel is not a tool, so the paid probe never sees it; this is the one place its states are
 * proven end to end. Each state is read off the shell's `data-agent-state` and its own copy, and
 * each owner control is proven by what the *agent* is answered afterwards: a site switched to `ask`
 * makes the next effect prompt; Stop on one card answers that session's in-flight `wait` with
 * `owner-stopped` and leaves the other's tabs held; Release tabs on the other makes its next read
 * answer `not-yours` while the session stays paired.
 *
 * Two sessions are two `mcp-server` processes on one relay, as in `agent-sessions.spec.ts`; each
 * learns the other's session id from `tabs_context`, which is how a card is found by session.
 */
test.describe("agent panel states", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT,
    "attach mode only: the native-messaging host is a machine install, so the browser under test " +
      "must be one the runner started and pointed at the installed host (HALLPASS_CDP_ENDPOINT).",
  );

  test("not-paired page, idle status + site list, two session cards with Stop and Release", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(480_000);

    const permissions = await extensionWorker.evaluate(() => chrome.runtime.getManifest().permissions ?? []);
    expect(
      permissions,
      "the attached browser must have apps/extension/dist/agent loaded (npm run build:extension:agent)",
    ).toContain("tabGroups");

    // A pairing a previous run left behind would skip the not-paired page; start from none.
    await extensionWorker.evaluate(async () => {
      await chrome.storage.local.remove(["agentPairings"]);
    });

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

    // ============ SC-044: nothing paired - the not-paired page and no other section ============
    await expect.poll(() => shellState(panel), { timeout: 15_000 }).toBe("not-connected");
    await panel.waitForText(ui("agent.notPaired.title"));
    const notPaired = await panel.panelText();
    expect(notPaired).not.toContain(ui("agent.sitesTitle"));
    expect(notPaired).not.toContain(ui("agent.status.connected"));
    expect(notPaired).not.toContain(ui("agent.session.stop"));
    // Exactly one landmark region: the page itself.
    expect(await panel.evaluatePanel("document.querySelectorAll('section').length")).toBe(1);
    expect(await isAgentPaired(panel, locale)).toBe(false);

    let alpha: McpHarnessClient | undefined;
    let beta: McpHarnessClient | undefined;
    try {
      // ============ SC-047: the pairing card, accepted within the bound ============
      alpha = await startMcpClient({ clientName: "Claude Code" });
      await panel.clickIfPresent(ui("agent.retry"));
      const promptedAt = Date.now();
      await pairWithFirstCall(alpha, panel, { locale, timeoutMs: 45_000 });
      expect(Date.now() - promptedAt).toBeLessThan(45_000);
      const a = alpha;

      const callOn = async (
        client: McpHarnessClient,
        tool: string,
        args: Record<string, unknown> = {},
      ): Promise<unknown> => {
        const result = await client.callTool(tool, args);
        expect(result.isError, `${tool} failed: ${result.text}\nstderr:\n${client.stderr()}`).toBe(false);
        return result.json;
      };

      // ============ SC-045: paired - status row, a session card named by its agent, and the site list ============
      await panel.waitForText(ui("agent.status.connected"));
      expect(await panel.panelText()).not.toContain(ui("agent.notPaired.title"));
      // The session greeted the relay, so its card is up; it holds nothing yet.
      await expect.poll(() => shellState(panel), { timeout: 15_000 }).toBe("sessions");
      await panel.waitForText(ui("agent.session.noSites"));
      // 016 FR-223: the status row names no agent; the card's title does.
      expect(await panel.panelText()).toContain("Claude Code");

      const tabA = ((await callOn(a, "tabs_create", { url: `${SITE}/ordinary` })) as { tabId: number }).tabId;
      // The card names the site it is on, and never the page's title.
      await panel.waitForText(ui("agent.session.holdsOne").replace("{sites}", "127.0.0.1"));

      // --- switching the site to `ask` makes the next effect prompt; the consent card is on top ---
      await setSiteMode(panel, SITE, "skip-checks");
      const refA = await refFor((tool, args) => callOn(a, tool, args), tabA, "Safe action");
      await callOn(a, "click", { tabId: tabA, target: { ref: refA } });
      await setSiteMode(panel, SITE, "ask");
      const refAsk = await refFor((tool, args) => callOn(a, tool, args), tabA, "Safe action");
      const asked = a.callTool("click", { tabId: tabA, target: { ref: refAsk } });
      await panel.waitForText(ui("agent.promptTitle"));
      const consent = await panel.panelText();
      expect(consent).toContain(ui("agent.consentBody").replace("{agent}", "Claude Code").replace("{action}", ui("agent.summary.click")).replace("{site}", SITE));
      // The card whose question this is says so.
      await expect.poll(() => panel.evaluatePanel(`document.querySelector('[data-session-state="waiting"]') !== null`), { timeout: 15_000 }).toBe(true);
      await panel.clickButton(ui("agent.refuse"));
      const denied = await asked;
      expect(denied.isError).toBe(true);
      expect(denied.json).toMatchObject({ outcome: "denied", reason: "owner-denied" });

      // --- SC-047: "always on this site" leaves the site in skip-checks, marked permissive ---
      const refAlways = await refFor((tool, args) => callOn(a, tool, args), tabA, "Safe action");
      const always = a.callTool("click", { tabId: tabA, target: { ref: refAlways } });
      await panel.waitForText(ui("agent.promptTitle"));
      await panel.clickButton(ui("agent.allowAlways"));
      expect((await always).isError, `stderr:\n${a.stderr()}`).toBe(false);
      await expect.poll(() => modeOf(panel, SITE), { timeout: 15_000 }).toBe("skip-checks");
      expect(await panel.evaluatePanel(`document.querySelector('[data-site=${JSON.stringify(SITE)}] select')?.getAttribute('data-permissive') === 'true'`)).toBe(true);

      // --- revoking the site removes the row; the default (ask) applies to the next effect ---
      await clickLabelled(panel, ui("agent.siteRevoke").replace("{site}", SITE));
      await expect.poll(() => storedModeOf(extensionWorker, SITE), { timeout: 15_000 }).toBeUndefined();
      const refDefault = await refFor((tool, args) => callOn(a, tool, args), tabA, "Safe action");
      const askedAgain = a.callTool("click", { tabId: tabA, target: { ref: refDefault } });
      await panel.waitForText(ui("agent.promptTitle"));
      await panel.clickButton(ui("agent.allowOnce"));
      expect((await askedAgain).isError, `stderr:\n${a.stderr()}`).toBe(false);

      // ============ SC-046: two live sessions, two cards ============
      beta = await startMcpClient({ clientName: "Claude Code" });
      const b = beta;
      const tabB = ((await callOn(b, "tabs_create", { url: `${SITE}/form` })) as { tabId: number }).tabId;
      type ListedTab = { tabId: number; holder: "this" | "none" | { sessionId: string } };
      const listedByA = (await callOn(a, "tabs_context")) as ListedTab[];
      const holderOfB = listedByA.find((tab) => tab.tabId === tabB)?.holder;
      expect(holderOfB).toEqual({ sessionId: expect.any(String) });
      const sessionB = (holderOfB as { sessionId: string }).sessionId;
      const listedByB = (await callOn(b, "tabs_context")) as ListedTab[];
      const sessionA = (listedByB.find((tab) => tab.tabId === tabA)?.holder as { sessionId: string }).sessionId;
      await expect.poll(() => panel.evaluatePanel("document.querySelectorAll('[data-session-id]').length"), { timeout: 15_000 }).toBe(2);

      // --- Stop on A: its in-flight wait answers owner-stopped; B is untouched ---
      const waiting = a.callTool("wait", { tabId: tabA, forMs: 15_000 });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await clickOnCard(panel, sessionA, ui("agent.session.stop"));
      const stopped = await waiting;
      // A stopped call is an error result whose text is the outcome and reason as JSON (the host's
      // `toolReply`); the text is in the message so a non-JSON answer says what it was.
      expect(stopped.isError, `text: ${stopped.text}\nstderr:\n${a.stderr()}`).toBe(true);
      const stoppedAnswer = (() => {
        try {
          return JSON.parse(stopped.text) as unknown;
        } catch {
          return { unparsed: stopped.text };
        }
      })();
      expect(stoppedAnswer, `text: ${stopped.text}
stderr:
${a.stderr()}`).toMatchObject({ outcome: "stopped", reason: "owner-stopped" });
      await expect.poll(() => panel.evaluatePanel("document.querySelectorAll('[data-session-id]').length"), { timeout: 15_000 }).toBe(1);
      // A's tab is still open, now the owner's; B still holds its own.
      expect(await extensionWorker.evaluate(async (id: number) => (await chrome.tabs.get(id)).id, tabA)).toBe(tabA);
      const stillHeld = (await callOn(b, "tabs_context")) as ListedTab[];
      expect(stillHeld.find((tab) => tab.tabId === tabB)?.holder).toBe("this");
      expect(stillHeld.find((tab) => tab.tabId === tabA)?.holder).toBe("none");

      // --- Release tabs on B: its next read answers not-yours, and it is still paired ---
      await clickOnCard(panel, sessionB, ui("agent.session.takeBack").replace("{n}", "1"));
      await panel.waitForText(ui("agent.session.noSites"));
      const afterRelease = await b.callTool("get_page_text", { tabId: tabB });
      expect(afterRelease.isError).toBe(true);
      expect(afterRelease.json).toMatchObject({ outcome: "denied", reason: "not-yours" });
      // Still a live, paired session: a call that needs no lease is answered, not refused.
      const stillPaired = await b.callTool("tabs_context");
      expect(stillPaired.isError, `stderr:\n${b.stderr()}`).toBe(false);
      expect(await isAgentPaired(panel, locale)).toBe(true);
      expect(await extensionWorker.evaluate(async (id: number) => (await chrome.tabs.get(id)).id, tabB)).toBe(tabB);

      await extensionWorker.evaluate(async (ids: number[]) => {
        await chrome.tabs.remove(ids);
      }, [tabA, tabB]);
    } finally {
      await alpha?.close();
      await beta?.close();
    }
  });
});

/** The composition the shell derived from the projection (006 R-125). */
async function shellState(panel: SidePanelDriver): Promise<unknown> {
  return panel.evaluatePanel("document.querySelector('[data-agent-state]')?.getAttribute('data-agent-state') ?? null");
}

/** The mode the panel shows for one site, or `null` when the row is gone. */
async function modeOf(panel: SidePanelDriver, site: string): Promise<unknown> {
  return panel.evaluatePanel(
    `document.querySelector('[data-site=${JSON.stringify(site)}] select')?.value ?? null`,
  );
}

/** The stored decision for one site, read from the worker; `undefined` once revoked. */
async function storedModeOf(worker: PackagedWorker, site: string): Promise<unknown> {
  return worker.evaluate(async (origin: string) => {
    const raw = await chrome.storage.local.get(["agentSiteModes"]);
    const records = (raw.agentSiteModes ?? {}) as Record<string, { mode?: string }>;
    return records[origin]?.mode;
  }, site);
}

/** Presses one of a session card's controls, found by the session the card is about. */
async function clickOnCard(panel: SidePanelDriver, sessionId: string, label: string): Promise<void> {
  const clicked = await panel.evaluatePanel(
    `(()=>{const card=document.querySelector('[data-session-id=${JSON.stringify(sessionId)}]');` +
      `const b=card&&[...card.querySelectorAll('button')].find((x)=>x.textContent?.trim()===${JSON.stringify(label)});` +
      `if(!b)return false;b.click();return true})()`,
    true,
  );
  expect(clicked, `no ${label} on the card for ${sessionId}`).toBe(true);
}

/**
 * Sets one site's mode through the panel's own control, never by writing storage (the same helper
 * `agent-actions.spec.ts` carries): the claim is that the owner can decide from what they are shown.
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
  await expect.poll(() => modeOf(panel, site), { timeout: 15_000 }).toBe(mode);
}

async function refFor(
  call: (tool: string, args: Record<string, unknown>) => Promise<unknown>,
  tabId: number,
  query: string,
): Promise<string> {
  const found = (await call("find", { tabId, query })) as { outcome: string; matches: Array<{ ref: string }> };
  expect(found.outcome, `find '${query}' answered ${found.outcome}`).toBe("resolved");
  const first = found.matches[0]?.ref;
  expect(first, `find '${query}' returned no ref`).toBeTruthy();
  return first as string;
}
