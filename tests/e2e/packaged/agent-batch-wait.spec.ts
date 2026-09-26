import type { Page } from "@playwright/test";
import { lookup } from "../../../apps/extension/src/locales/catalog.js";
import { startMcpClient, type McpHarnessClient } from "../../harness/mcp-client.js";
import { pairWithFirstCall } from "../fixtures/agent-pairing.js";
import { copyFor, localeFromEnv, openSidePanel, type SidePanelDriver } from "../fixtures/side-panel-driver.js";
import { expect, test } from "../fixtures/packaged-extension.js";

const locale = localeFromEnv();
const copy = copyFor(locale);
const ui = (key: string): string => lookup(key, locale);

const SITE = "https://127.0.0.1:19443";

/**
 * 003/T052 — US5 end to end: a sequence in one call, and waiting for the page (FR-046..FR-048).
 *
 * This is the journey the feature exists for. A form that took five round trips is one call here,
 * and the claim that matters is a *wall-clock* one (SC-021), so it is measured rather than reasoned
 * about: the batch is timed, and the page is then read to prove every step actually landed.
 *
 * The other three claims are the ones a batch has to get right to be usable at all. A step that
 * fails stops the batch where it stands, and the steps after it are reported as never attempted -
 * checked both in the answer and on the page. A wait ends when the page says so, or at its own
 * bound, and never merely when a guessed delay elapsed. And on a site the owner set to
 * `follow-a-plan`, the whole batch is *one* question in the panel: their Approve runs it, their
 * Refuse runs none of it.
 *
 * Attach mode only, for the same reason the other agent journeys are: the bridge starts with a
 * machine install, and a browser this gate launched itself would prove nothing about it.
 *
 * Prerequisites: `npm run build:extension:agent`, `dist/agent` loaded in the attached browser,
 * `npm run agent-host:install`, and the three test services running (ports 18786/18787/19443).
 */
test.describe("agent batch and wait", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT,
    "attach mode only: the native-messaging host is a machine install, so the browser under test " +
      "must be one the runner started and pointed at the installed host (HALLPASS_CDP_ENDPOINT).",
  );

  test("runs a five-step form fill in one call, stops at a failed step, waits, and obeys one plan answer", async ({
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

    // A fixture the agent never visits, so every page assertion below reads a tab the agent drove.
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
      client = await startMcpClient({ clientName: "Claude Code" });
      const live = client;
      const call = callerFor(() => client);
      await panel.clickIfPresent(ui("agent.retry"));
      // T098a: the prompt by its own key, Accept clicked, and pairing confirmed by a signal that
      // is false when nothing is paired - the panel's section heading is on screen either way.
      await pairWithFirstCall(client, panel, { locale });

      const created = (await call("tabs_create", { url: `${SITE}/form` })) as { tabId: number };
      const tabId = created.tabId;
      await setSiteMode(panel, SITE, "skip-checks");
      const form = await agentPage(extensionContext, `${SITE}/form`);

      // ================= SC-021: the five-step form fill, as one call =================
      /*
       * Every ref comes from *one* `read_page`, because a collection invalidates the handles the
       * previous one issued - so two `find`s cannot produce two live refs, while one structural read
       * produces as many as the page has controls. This is also why the steps carry refs rather than
       * a `find` of their own: a batch's arguments are fixed when it is sent.
       */
      let refs = await interactiveRefs(call, tabId);
      const startedAt = Date.now();
      const filled = (await call("browser_batch", {
        tabId,
        steps: [
          { tool: "click", args: { target: { ref: refs("nickname") } } },
          { tool: "type", args: { target: { ref: refs("nickname") }, text: "agent-user" } },
          { tool: "click", args: { target: { ref: refs("message") } } },
          { tool: "type", args: { target: { ref: refs("message") }, text: "agent-secret" } },
          // The fixture's real submit control (003/B1). A ref for it exists at all only because the
          // agent's collection names every control; the reviewed walk offers none for a submit.
          { tool: "click", args: { target: { ref: refs("Sign in") } } },
        ],
      })) as { results: Array<{ index: number; outcome: string; reason?: string }> };
      const elapsedMs = Date.now() - startedAt;

      expect(filled.results.map((step) => step.outcome)).toEqual(["ok", "ok", "ok", "ok", "ok"]);
      expect(filled.results.map((step) => step.index)).toEqual([0, 1, 2, 3, 4]);
      // SC-021: the five round trips the same sequence used to cost, inside one ten-second budget.
      expect(elapsedMs, `the five-step batch took ${elapsedMs}ms`).toBeLessThan(10_000);
      // Every step landed on the page itself, not merely in the answer.
      await expect(form.locator('input[name="nickname"]')).toHaveValue("agent-user");
      await expect(form.locator('textarea[name="message"]')).toHaveValue("agent-secret");
      // The submit control was activated and the page's own handler ran: the effect surface a
      // reviewed collection cannot even name is reachable for the owner's own agent.
      await expect(form.locator("#submitted")).not.toHaveText("not submitted yet");

      // ================= a step that fails stops the batch where it stands =================
      refs = await interactiveRefs(call, tabId);
      const stopped = (await call("browser_batch", {
        tabId,
        steps: [
          { tool: "type", args: { target: { ref: refs("nickname") }, text: "second-run" } },
          { tool: "type", args: { target: { ref: refs("message") }, text: "second-run" } },
          // A ref from no document at all: the page cannot resolve it, and the batch ends here.
          { tool: "type", args: { target: { ref: "tgt-does-not-exist" }, text: "never typed" } },
          { tool: "type", args: { target: { ref: refs("nickname") }, text: "not run either" } },
          { tool: "click", args: { target: { ref: refs("Safe action") } } },
        ],
      })) as { results: Array<{ index: number; outcome: string; reason?: string }> };

      // 004/T157 (S4 review, resolved 2026-09-11 by B99 + main session): a ref no frame ever minted
      // used to be expected as `stale`, but T136's split (already implemented on this same keyboard
      // path, via the `locator` wrapper the click family shares) is stale only when a frame reports
      // its own minted element gone; not-located - `failed` / `target-not-located` - when every frame
      // says unknown, which is this case. The expectation was what was wrong, not the code.
      expect(stopped.results.map((step) => step.outcome)).toEqual(["ok", "ok", "failed", "failed", "failed"]);
      expect(stopped.results[2]?.reason).toEqual("target-not-located");
      expect(stopped.results.slice(3).map((step) => step.reason)).toEqual(["not-run", "not-run"]);
      // Not run means not sent: the fourth step's text never reached the field.
      await expect(form.locator('input[name="nickname"]')).toHaveValue("second-run");

      // ================= a wait that ends when the page says so, inside a batch =================
      await call("navigate", { tabId, url: `${SITE}/waiting` });
      const waiting = await agentPage(extensionContext, `${SITE}/waiting`);
      refs = await interactiveRefs(call, tabId);
      const waited = (await call("browser_batch", {
        tabId,
        steps: [
          { tool: "click", args: { target: { ref: refs("Start") } } },
          // The fixture reveals the result 600 ms later, through its own script. A step that guessed
          // a delay would be wrong either way; this one ends exactly when the element is there.
          { tool: "wait", args: { condition: "present", ref: refs("Open result"), maxMs: 5_000 } },
          { tool: "click", args: { target: { ref: refs("Open result") } } },
        ],
      })) as { results: Array<{ index: number; outcome: string; result?: { outcome?: string; waitedMs?: number } }> };

      expect(waited.results.map((step) => step.outcome)).toEqual(["ok", "ok", "ok"]);
      expect(waited.results[1]?.result).toMatchObject({ outcome: "condition-met" });
      expect(waited.results[1]?.result?.waitedMs).toBeGreaterThan(0);
      await expect(waiting.locator("#opened")).toHaveText("result opened");

      // ================= a condition that never holds ends at its bound, and says so =================
      const boundStartedAt = Date.now();
      const never = await live.callTool("wait", {
        tabId,
        condition: "present",
        ref: refs("Never appears"),
        maxMs: 1_500,
      });
      expect(never.isError).toBe(true);
      expect(never.json).toMatchObject({ outcome: "failed", reason: "bound-reached" });
      // It waited for the bound rather than answering immediately, and did not overshoot it either.
      expect(Date.now() - boundStartedAt).toBeGreaterThanOrEqual(1_400);
      expect(Date.now() - boundStartedAt).toBeLessThan(10_000);

      // ================= follow-a-plan: one question for the whole batch =================
      await call("navigate", { tabId, url: `${SITE}/form` });
      const formAgain = await agentPage(extensionContext, `${SITE}/form`);
      await setSiteMode(panel, SITE, "follow-a-plan");
      refs = await interactiveRefs(call, tabId);

      const approvedBatch = live.callTool("browser_batch", {
        tabId,
        steps: [
          { tool: "type", args: { target: { ref: refs("nickname") }, text: "approved-by-owner" } },
          { tool: "click", args: { target: { ref: refs("Safe action") } } },
        ],
      });
      await panel.waitForText(ui("agent.planTitle"));
      const planText = await panel.panelText();
      // The owner is shown the sequence in their own language, and the site it is all on: every
      // step's sentence comes from the locale tables (003/T068), so this reads the same way in
      // zh-TW as it does here.
      expect(planText).toContain(SITE);
      expect(planText).toContain(ui("agent.summary.type"));
      expect(planText).toContain(ui("agent.summary.click"));
      await panel.clickButton(ui("agent.approvePlan"));

      const approved = await approvedBatch;
      expect(approved.isError, `plan batch failed: ${approved.text}\nstderr:\n${live.stderr()}`).toBe(false);
      expect((approved.json as { results: Array<{ outcome: string }> }).results.map((step) => step.outcome)).toEqual([
        "ok",
        "ok",
      ]);
      await expect(formAgain.locator('input[name="nickname"]')).toHaveValue("approved-by-owner");

      // ================= the owner refuses: nothing runs at all =================
      refs = await interactiveRefs(call, tabId);
      const refusedBatch = live.callTool("browser_batch", {
        tabId,
        steps: [
          { tool: "type", args: { target: { ref: refs("nickname") }, text: "refused-by-owner" } },
          { tool: "click", args: { target: { ref: refs("Safe action") } } },
        ],
      });
      await panel.waitForText(ui("agent.planTitle"));
      await panel.clickButton(ui("agent.denyPlan"));

      const refused = await refusedBatch;
      expect(refused.isError).toBe(true);
      expect(refused.json).toMatchObject({ outcome: "denied", reason: "owner-denied" });
      // The page is exactly as the approved batch left it: a refused plan runs no step of itself.
      await expect(formAgain.locator('input[name="nickname"]')).toHaveValue("approved-by-owner");

      await setSiteMode(panel, SITE, "ask");
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

/**
 * Every interactive element's ref from one structural read, looked up by the name the worker minted.
 *
 * One read rather than a `find` per target: a collection invalidates the handles the previous one
 * issued, so refs taken from separate reads cannot all be live at once - and a batch needs all of
 * its refs live when it is sent.
 */
async function interactiveRefs(
  call: (tool: string, args: Record<string, unknown>) => Promise<unknown>,
  tabId: number,
): Promise<(name: string) => string> {
  // `all` rather than the working list, because a wait names an element that has *not* appeared
  // yet: the interactive answer deliberately leaves those out (003/C2), while every node still
  // carries the ref a `wait { condition: "present" }` needs (FR-048).
  const page = (await call("read_page", { tabId, filter: "all" })) as {
    nodes: Array<{ ref?: string; role: string; name?: string }>;
  };
  return (name: string): string => {
    const node = page.nodes.find((candidate) => candidate.name === name && candidate.ref !== undefined);
    expect(node, `read_page offered no ref named '${name}': ${JSON.stringify(page.nodes)}`).toBeTruthy();
    return node?.ref as string;
  };
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
      async () =>
        panel.evaluatePanel(
          `(()=>{const site=${JSON.stringify(site)};const rows=[...document.querySelectorAll('li')];` +
            `const row=rows.find((r)=>r.textContent?.includes(site));return row?.querySelector('select')?.value ?? null})()`,
        ),
      { timeout: 15_000 },
    )
    .toBe(mode);
}
