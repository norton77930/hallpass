import type { BrowserContext } from "@playwright/test";
import { lookup } from "../../../apps/extension/src/locales/catalog.js";
import { scaledMs } from "../../../packages/test-kit/src/time-scale.js";
import {
  alwaysReply,
  repliesInOrder,
  startElicitingClient,
  type ElicitationRecord,
  type ElicitationScript,
  type ElicitingMcpClient,
} from "../../harness/elicitation-mcp-client.js";
import type { ToolCallResult } from "../../harness/mcp-client.js";
import { pairWithFirstCall } from "../fixtures/agent-pairing.js";
import { openSettingsPage, type SettingsPageDriver } from "../fixtures/settings-page-driver.js";
import { copyFor, localeFromEnv, openSidePanel, waitForAgentPanel, type SidePanelDriver } from "../fixtures/side-panel-driver.js";
import { expect, setTransitionTestSwitch, test, type PackagedWorker } from "../fixtures/packaged-extension.js";

/**
 * 032 US1 + US2 (FR-484 - FR-489, contracts/terminal-consent-032.md, T963): the site-transition
 * question and the site-plan question (`propose_sites`) are put to the owner in the agent's own
 * client as well as on the side-panel card, the client may answer only "this session" or "deny", and
 * the first answer in either place decides it.
 *
 * Same rig as the 031 gate (agent-terminal-consent-031.spec.ts): a scripted MCP client talks to the
 * real `dist/mcp-server.js` over stdio and answers `elicitation/create` from a per-test script; the
 * owner's side is the real side panel, read through its DOM. Each claim is read on two surfaces: what
 * the tool answered (the agent's view) and what the panel shows (the owner's view), and a question
 * that must not be asked is read as "the client received nothing and no card stood".
 *
 * **The moved tab.** Both fixture origins are served from 127.0.0.1 (19443 -> 19445 through
 * `/go-b`), and rule (a) of the transition gate exempts loopback, so - like agent-transitions.spec -
 * the run sets the gate's test switch (`setTransitionTestSwitch`) so the two ports count as the two
 * ordinary sites they stand for. The switch widens prompting and never privilege. The first site is
 * set to skip-checks (settings page, as the owner does) so the move itself asks nothing; the
 * destination stays undecided, which is what makes the next call ask about the move.
 *
 * Attach mode only, like every `agent-*` journey. Prerequisites: `npm run build`, `dist/agent`
 * loaded in the attached browser, `npm run agent-host:install` from this checkout, and the page
 * fixtures running (`npm run dev:test-pages`, `https://localhost:19443`..`19445`).
 */
const locale = localeFromEnv();
const copy = copyFor(locale);
const ui = (key: string): string => lookup(key, locale);

/** The site the tab starts on and the site `/go-b` takes it to: two ports of the loopback fixtures. */
const A = "https://127.0.0.1:19443";
const B = "https://127.0.0.1:19445";
const PURPOSE = "Compare the fixture pages";

test.describe("032 terminal consent: moves and site plans", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT,
    "attach mode only: the native-messaging host is a machine install, so the browser under test " +
      "must be one the runner started and pointed at the installed host (HALLPASS_CDP_ENDPOINT).",
  );

  test("a moved tab: the client is asked session or deny, session lets the call run and withdraws the card, and the pair is not asked again", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(scaledMs(300_000));
    const rig = await openRig({ extensionContext, extensionId, extensionWorker });
    try {
      const a = await rig.openSession({
        // Held for a few seconds so the card can be read while the client's question is open
        // (FR-484: both are raised at the same time). Only the first question is answered; were the
        // pair asked again the client would sit on it and the call could not complete.
        script: repliesInOrder({ kind: "accept", choice: "session", afterMs: 4_000 }),
      });
      const tab = await a.moveTabAcross();

      const held = a.client.callTool("get_page_text", { tabId: tab }, { timeoutMs: 150_000 });
      held.catch(() => undefined);
      const q = await a.client.waitForElicitation(0);
      expect(q.choices, "FR-485: a move offers only this session and deny").toEqual(["session", "deny"]);
      expect(q.choiceRequired).toBe(true);
      expect(q.message).toContain("Hallpass");
      expect(q.message, "the question names the site the tab came from").toContain(A);
      expect(q.message, "and the site it went to").toContain(B);
      expect(q.state, "the owner has not answered yet").toBe("pending");
      // The card is up at the same time and names the same two sites (FR-484).
      await rig.panel.waitForText(ui("agent.prompt.transition").replace("{from}", A).replace("{to}", B));
      expect(await promptKinds(rig.panel)).toContain("transition");

      const ran = await held;
      if (ran.isError) {
        const state = await extensionWorker.evaluate(async (id: number) => {
          const t = await chrome.tabs.get(id);
          return { status: t.status, url: t.url, discarded: t.discarded, frozen: (t as { frozen?: boolean }).frozen };
        }, tab);
        console.log(`[measure] tab after failed read: ${JSON.stringify(state)}`);
      }
      expect(ran.isError, failure("the call after a move answered 'this session' in the client", ran, a.client)).toBe(false);
      expect(q.state).toBe("answered");
      expect(a.client.stderr()).toContain("agent.consent.answered");
      // First answer wins and withdraws the other place (FR-489, 031 FR-471).
      await expect.poll(() => promptKinds(rig.panel), { timeout: 10_000 }).toEqual([]);

      // Same tab, next call: the move is allowed for the session, so nothing is asked.
      const again = await a.client.callTool("get_page_text", { tabId: tab });
      expect(again.isError, failure("a second call on the allowed move", again, a.client)).toBe(false);
      // Another tab of the same session, the same pair: allowed without asking (the card's Continue does the same).
      const other = await a.moveTabAcross({ alreadyAllowed: true });
      const unasked = await a.client.callTool("get_page_text", { tabId: other });
      expect(unasked.isError, failure("the same pair on a second tab", unasked, a.client)).toBe(false);
      expect(a.client.elicitations(), "the pair was asked exactly once").toHaveLength(1);
      expect(await promptKinds(rig.panel), "and no card was raised for it").toEqual([]);
    } finally {
      await rig.cleanup();
    }
  });

  test("a moved tab: deny refuses the call as declined, nothing is recorded, and the next call asks again", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(scaledMs(300_000));
    const rig = await openRig({ extensionContext, extensionId, extensionWorker });
    try {
      const a = await rig.openSession({ script: alwaysReply({ kind: "accept", choice: "deny", afterMs: 1_500 }) });
      const tab = await a.moveTabAcross();

      const first = a.client.callTool("get_page_text", { tabId: tab }, { timeoutMs: 150_000 });
      first.catch(() => undefined);
      const q1 = await a.client.waitForElicitation(0);
      expect(q1.choices).toEqual(["session", "deny"]);
      expect(q1.message).toContain(A);
      expect(q1.message).toContain(B);
      await rig.panel.waitForText(ui("agent.prompt.transition").replace("{from}", A).replace("{to}", B));
      const denied = await first;
      expect(denied.isError).toBe(true);
      expect(denied.json, failure("a deny chosen in the client", denied, a.client)).toMatchObject({
        outcome: "denied",
        reason: "site-transition-declined",
      });
      await expect.poll(() => promptKinds(rig.panel), { timeout: 10_000 }).toEqual([]);

      // Deny records nothing: the tab is still the session's, the move is still undecided, so the
      // next call on it is asked again, with a question of its own.
      const second = a.client.callTool("get_page_text", { tabId: tab }, { timeoutMs: 150_000 });
      second.catch(() => undefined);
      const q2 = await a.client.waitForElicitation(1);
      expect(q2.choices).toEqual(["session", "deny"]);
      expect(q2.requestId, "a new question has its own identity").not.toBe(q1.requestId);
      const deniedAgain = await second;
      expect(deniedAgain.isError).toBe(true);
      expect(deniedAgain.json, failure("the second deny", deniedAgain, a.client)).toMatchObject({
        outcome: "denied",
        reason: "site-transition-declined",
      });
      expect(a.client.elicitations()).toHaveLength(2);
    } finally {
      await rig.cleanup();
    }
  });

  test("propose_sites: the client is asked to allow the sites for this session, and answering approves every proposed site", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(scaledMs(240_000));
    const rig = await openRig({ extensionContext, extensionId, extensionWorker });
    try {
      const a = await rig.openSession({
        // No tab is needed: the proposal is the first thing the session asks.
        script: alwaysReply({ kind: "accept", choice: "session", afterMs: 4_000 }),
      });
      const proposing = a.client.callTool("propose_sites", { origins: [A, B], purpose: PURPOSE }, { timeoutMs: 150_000 });
      proposing.catch(() => undefined);
      const q = await a.client.waitForElicitation(0);
      expect(q.choices, "FR-486: a plan offers only this session and deny").toEqual(["session", "deny"]);
      expect(q.choiceRequired).toBe(true);
      expect(q.message, "FR-486: the question lists every proposed site").toContain(A);
      expect(q.message).toContain(B);
      expect(q.state).toBe("pending");
      // The card is up at the same time, listing the same sites.
      await expect.poll(() => promptKinds(rig.panel), { timeout: 15_000 }).toContain("site-plan");
      expect(await planOrigins(rig.panel)).toEqual([A, B]);

      const answer = await proposing;
      expect(answer.isError, failure("propose_sites answered 'this session' in the client", answer, a.client)).toBe(false);
      // Exactly what approving the card with every site ticked records: all approved, nothing left out.
      expect(answer.json, answer.text).toMatchObject({ approved: [A, B], leftOut: [] });
      expect(q.state).toBe("answered");
      await expect.poll(() => promptKinds(rig.panel), { timeout: 10_000 }).toEqual([]);
      expect(a.client.elicitations(), "one question for one proposal").toHaveLength(1);
    } finally {
      await rig.cleanup();
    }
  });
});

// ======================================================================================
// the rig
// ======================================================================================

type RigFixtures = { extensionContext: BrowserContext; extensionId: string; extensionWorker: PackagedWorker };

type RigSession = {
  client: ElicitingMcpClient;
  /**
   * Opens a tab on A, then takes it to B the way a page does (`navigate` to `/go-b`, which redirects
   * across origins), and waits until the worker holds the move as pending. The next call on the
   * returned tab is the one that is asked. With `alreadyAllowed`, the pair is one this session has
   * allowed, and the move must leave nothing pending.
   */
  moveTabAcross(options?: { alreadyAllowed?: boolean }): Promise<number>;
};

type Rig = {
  panel: SidePanelDriver;
  openSession(options: { script: ElicitationScript }): Promise<RigSession>;
  cleanup(): Promise<void>;
};

async function openRig(fixtures: RigFixtures): Promise<Rig> {
  const { extensionContext, extensionId, extensionWorker } = fixtures;
  const permissions = await extensionWorker.evaluate(() => chrome.runtime.getManifest().permissions ?? []);
  expect(
    permissions,
    "the attached browser must have apps/extension/dist/agent loaded (npm run build:extension:agent)",
  ).toContain("nativeMessaging");

  // A fixture the agent never visits, so the owner's own tab is never one a test reads.
  const ownerPage = extensionContext.pages()[0] ?? (await extensionContext.newPage());
  await ownerPage.goto(`${A}/waiting`);
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
  // 024 FR-385: site modes are on the settings page; opened once and used for set-up and tidy-up.
  const settings = await openSettingsPage({
    context: extensionContext,
    worker: extensionWorker,
    extensionId,
    locale,
    route: "#sites",
  });
  // From here the harness's own origins count as ordinary sites (agent-transitions.spec, T366).
  await setTransitionTestSwitch(extensionWorker, true);

  const clients: ElicitingMcpClient[] = [];
  const tabs: number[] = [];
  let paired = false;
  let modeSet = false;

  async function openSession(options: { script: ElicitationScript }): Promise<RigSession> {
    const client = await startElicitingClient({ clientName: "Claude Code", capability: "form", script: options.script });
    clients.push(client);
    if (!paired) {
      await panel.clickIfPresent(ui("agent.retry"));
      await pairWithFirstCall(client, panel, { locale });
      paired = true;
    }
    return {
      client,
      async moveTabAcross(options) {
        const created = await client.callTool("tabs_create", { url: `${A}/transition-a` });
        expect(created.isError, `tabs_create failed: ${created.text}\nstderr:\n${client.stderr()}`).toBe(false);
        const tabId = (created.json as { tabId: number }).tabId;
        expect(typeof tabId).toBe("number");
        tabs.push(tabId);
        // The site row is listed while a session tab is on it, so the mode is set after the first tab.
        // Skip-checks makes the move's own navigation ask nothing; B stays undecided.
        if (!modeSet) {
          await settings.setSiteMode(A, "skip-checks");
          modeSet = true;
        }
        const moved = await client.callTool("navigate", { tabId, url: `${A}/go-b` });
        expect(moved.isError, `navigate failed: ${moved.text}\nstderr:\n${client.stderr()}`).toBe(false);
        await expect.poll(() => urlOf(extensionWorker, tabId), { timeout: 20_000 }).toContain(":19445/");
        if (options?.alreadyAllowed === true) {
          // The pair is allowed for this session, so the move is judged at once and nothing is held
          // (agent-runtime rule (d): a remembered or session-allowed pair records no pending move).
          expect(await pendingOn(extensionWorker, tabId), "an allowed pair holds no pending move").toBeUndefined();
          return tabId;
        }
        // The move is recorded from the browser's own signal, whoever caused it (FR-185).
        await expect.poll(() => pendingOn(extensionWorker, tabId), { timeout: 20_000 }).toEqual({ from: A, to: B });
        return tabId;
      },
    };
  }

  async function cleanup(): Promise<void> {
    // The site's row is listed only while a session tab is on it, so it is revoked before the tabs go.
    await dropSiteMode(settings).catch(() => undefined);
    // Tidying goes through the browser rather than the agent: a tab with a question standing is held
    // behind its card, and the owner closing their own tab is the honest way out.
    for (const tabId of tabs) await closeTab(extensionWorker, tabId);
    await setTransitionTestSwitch(extensionWorker, false).catch(() => undefined);
    await settings.close().catch(() => undefined);
    for (const client of clients) await client.close().catch(() => undefined);
  }

  return { panel, openSession, cleanup };
}

// ======================================================================================
// small readers
// ======================================================================================

/** The tool's answer and the host's own stderr, for an assertion that failed on the answer. */
function failure(what: string, result: ToolCallResult, client: ElicitingMcpClient): string {
  const asked = client.elicitations().map((record: ElicitationRecord) => `${record.state}:${record.choices.join("/")}`);
  return `${what}: ${result.text}\nquestions received: ${JSON.stringify(asked)}\nmcp-server stderr:\n${client.stderr()}`;
}

/** The kinds of every question card on the panel now (`transition`, `site-plan`, `consent`...); `[]` is no card. */
async function promptKinds(panel: SidePanelDriver): Promise<string[]> {
  return (await panel.evaluatePanel(
    "[...document.querySelectorAll('[data-prompt]')].map((card)=>card.getAttribute('data-prompt'))",
  )) as string[];
}

/** The origins the site-plan card lists, in its order. */
async function planOrigins(panel: SidePanelDriver): Promise<string[]> {
  return (await panel.evaluatePanel(
    "[...document.querySelectorAll('[data-prompt=site-plan] li[data-origin]')].map((li)=>li.getAttribute('data-origin'))",
  )) as string[];
}

/** Where the browser says the tab is; the gate waits on this rather than on a page load event. */
async function urlOf(worker: PackagedWorker, tabId: number): Promise<string> {
  return worker.evaluate(async (id: number) => (await chrome.tabs.get(id)).url ?? "", tabId);
}

/** The move the worker is holding for that tab, read-only, from its own session storage. */
async function pendingOn(worker: PackagedWorker, tabId: number): Promise<{ from: string; to: string } | undefined> {
  return worker.evaluate(async (id: number) => {
    const raw = await chrome.storage.session.get(["agentTransitions"]);
    const states = (raw.agentTransitions ?? {}) as Record<string, { pending?: { from: string; to: string } }>;
    const entry = Object.entries(states).find(([key]) => key.endsWith(`:${id}`))?.[1];
    return entry?.pending === undefined ? undefined : { from: entry.pending.from, to: entry.pending.to };
  }, tabId);
}

async function closeTab(worker: PackagedWorker, tabId: number): Promise<void> {
  await worker.evaluate(async (id: number) => {
    await chrome.tabs.remove(id).catch(() => undefined);
  }, tabId);
}

/** Puts the first site back to the default the way the owner does: revoke its row, when it has one. */
async function dropSiteMode(settings: SettingsPageDriver): Promise<void> {
  if ((await settings.siteMode(A)) !== null) await settings.revokeSite(A);
}
