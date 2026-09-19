import { execFileSync } from "node:child_process";
import { lookup } from "../../../apps/extension/src/locales/catalog.js";
import { AGENT_GROUP_TITLE } from "../../../apps/extension/src/chrome-adapters/tab-groups.js";
import { startMcpClient, type McpHarnessClient } from "../../harness/mcp-client.js";
import { acceptPairing } from "../fixtures/agent-pairing.js";
import { copyFor, localeFromEnv, openSidePanel } from "../fixtures/side-panel-driver.js";
import { expect, test } from "../fixtures/packaged-extension.js";

const locale = localeFromEnv();
const copy = copyFor(locale);
const ui = (key: string): string => lookup(key, locale);

const SITE = "https://127.0.0.1:19443";

/**
 * 004/T098 — US2 end to end: several agent sessions share one browser (FR-055–FR-058, SC-029, SC-030).
 *
 * The owner's E1 was that a second `claude` session answered `bridge-unavailable` while the first
 * was live, so this journey is E1 inverted, and it is deliberately built out of *two real
 * `mcp-server` processes* rather than two clients of one: the harness spawns one server per client,
 * both dial the relay Chrome spawned, and the relay multiplexes them (R-111). A test that shared one
 * server would prove nothing about the failure the owner hit.
 *
 * One locale is enough here (en-US by default): the only owner-facing copy this journey touches is
 * the pairing prompt, which `agent-pairing.spec.ts` already asserts in both.
 *
 * The last case is the one B7 could not settle in a unit test. A reconnect re-sends `pair-request`
 * for a session id the worker already knows, and the worker must treat that as the *same* session -
 * same tool context, same nonce - or every ref the agent took before the drop silently dies. A unit
 * test passed against the pre-004 code too, so only a real element reference across a real drop is
 * evidence.
 */
test.describe("agent sessions", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT,
    "attach mode only: the native-messaging host is a machine install, so the browser under test " +
      "must be one the runner started and pointed at the installed host (HALLPASS_CDP_ENDPOINT).",
  );

  test("runs two sessions at once, refuses across them, and survives a relay and a server death", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(600_000);

    const permissions = await extensionWorker.evaluate(() => chrome.runtime.getManifest().permissions ?? []);
    expect(
      permissions,
      "the attached browser must have apps/extension/dist/agent loaded (npm run build:extension:agent)",
    ).toContain("tabGroups");

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
    await panel.waitForText(ui("agent.appTitle"));

    let alpha: McpHarnessClient | undefined;
    let beta: McpHarnessClient | undefined;
    try {
      // ================= two clients, two server processes, one relay =================
      alpha = await startMcpClient({ clientName: "Claude Code" });
      await panel.clickIfPresent(ui("agent.retry"));
      // T098a: the prompt by its own key, Accept clicked, and pairing confirmed by a signal that
      // is false when nothing is paired - the panel's section heading is on screen either way.
      await acceptPairing(panel, { locale });
      // The second session is the same *agent* (the host's id is per machine, not per process), so
      // the owner is asked once and the second session joins on the pairing already granted.
      beta = await startMcpClient({ clientName: "Claude Code" });
      const a = alpha;
      const b = beta;

      const callOn = async (
        client: McpHarnessClient,
        tool: string,
        args: Record<string, unknown> = {},
      ): Promise<unknown> => {
        const result = await client.callTool(tool, args);
        expect(result.isError, `${tool} failed: ${result.text}\nstderr:\n${client.stderr()}`).toBe(false);
        return result.json;
      };

      // ================= case 1: both first calls succeed, neither is refused for existing =======
      // Issued together on purpose: E1 was a *second* session's first call while another was live.
      const [firstA, firstB] = await Promise.all([a.callTool("tabs_context"), b.callTool("tabs_context")]);
      for (const [label, result, client] of [
        ["alpha", firstA, a],
        ["beta", firstB, b],
      ] as Array<[string, Awaited<ReturnType<McpHarnessClient["callTool"]>>, McpHarnessClient]>) {
        expect(result.isError, `${label}: ${result.text}\nstderr:\n${client.stderr()}`).toBe(false);
        expect(result.text, label).not.toContain("bridge-unavailable");
        expect(Array.isArray(result.json), label).toBe(true);
      }

      // ...each in its own tab group, which is what makes them separate sessions to the owner too.
      const tabA = ((await callOn(a, "tabs_create", { url: `${SITE}/ordinary` })) as { tabId: number }).tabId;
      const tabB = ((await callOn(b, "tabs_create", { url: `${SITE}/form` })) as { tabId: number }).tabId;
      const groupOf = async (tabId: number): Promise<{ groupId: number; title?: string | undefined }> =>
        extensionWorker.evaluate(async (id: number) => {
          const tab = await chrome.tabs.get(id);
          const group =
            tab.groupId === undefined || tab.groupId < 0 ? undefined : await chrome.tabGroups.get(tab.groupId);
          return { groupId: tab.groupId, title: group?.title };
        }, tabId);
      const groupA = await groupOf(tabA);
      const groupB = await groupOf(tabB);
      expect(groupA.groupId).toBeGreaterThan(-1);
      expect(groupB.groupId).toBeGreaterThan(-1);
      expect(groupA.groupId, "two live sessions must not share one group").not.toBe(groupB.groupId);
      expect(groupA.title).toBe(AGENT_GROUP_TITLE);
      expect(groupB.title).toBe(AGENT_GROUP_TITLE);

      /**
       * Each session is told which tabs are its own, and only its own (FR-055).
       *
       * 004/T104 turned this list into the whole browser's, so the claim is now carried by
       * `holder` instead of by the list's membership: exactly one tab is "this" for each session,
       * and the other session's tab is named as somebody else's - never "none", which would invite
       * a claim on a tab that is already held.
       */
      type ListedTab = { tabId: number; holder: "this" | "none" | { sessionId: string } };
      const heldBy = async (client: McpHarnessClient): Promise<ListedTab[]> =>
        (await callOn(client, "tabs_context")) as ListedTab[];
      const mine = (listed: ListedTab[]): number[] =>
        listed.filter((tab) => tab.holder === "this").map((tab) => tab.tabId);
      const listedA = await heldBy(a);
      const listedB = await heldBy(b);
      expect(mine(listedA)).toEqual([tabA]);
      expect(mine(listedB)).toEqual([tabB]);
      // ...and each sees the other's tab, held by a session it can name.
      expect(listedA.find((tab) => tab.tabId === tabB)?.holder).toEqual({ sessionId: expect.any(String) });
      expect(listedB.find((tab) => tab.tabId === tabA)?.holder).toEqual({ sessionId: expect.any(String) });

      // ================= case 2: the other session's tab is refused, and left alone =============
      for (const [tool, args] of [
        ["get_page_text", { tabId: tabA }],
        ["navigate", { tabId: tabA, url: `${SITE}/tags` }],
        ["tabs_close", { tabId: tabA }],
      ] as Array<[string, Record<string, unknown>]>) {
        const refused = await b.callTool(tool, args);
        expect(refused.isError, tool).toBe(true);
        // 004/T104-T105: the same refusal, in the words that say *why* - alpha holds it, so beta's
        // move is to wait or ask, not to claim. The session named is a real one and not beta's own.
        expect(refused.json, tool).toMatchObject({
          outcome: "denied",
          reason: "held-by-session",
          refusal: { reason: "held-by-session", sessionId: expect.any(String) },
        });
      }
      // Refused means untouched: alpha's tab is still open, still on the page alpha put it on.
      const untouched = await extensionWorker.evaluate(
        async (id: number) => ({ url: (await chrome.tabs.get(id)).url }),
        tabA,
      );
      expect(untouched.url).toBe(`${SITE}/ordinary`);

      // The element reference case 5 is about, taken *before* the link is dropped.
      const read = (await callOn(a, "read_page", { tabId: tabA, filter: "interactive" })) as {
        nodes: Array<{ ref?: string; role: string; name?: string }>;
      };
      const beforeDrop = read.nodes.find((node) => node.ref !== undefined)?.ref;
      expect(beforeDrop, "read_page must mint at least one ref on the fixture page").toBeTruthy();

      // ================= case 3: the relay dies; both sessions recover, unaided (FR-057) ========
      // The relay is the `native-host.js` process Chrome spawned. Killing it is what a host crash
      // looks like from outside, and it drops *both* server sockets at once - which is also what
      // makes case 5 a real reconnect-while-another-session-is-live.
      expect(killRelay(), "no relay process was running to kill").toBe(true);

      const startedAt = Date.now();
      // Recovered means the session is itself again, not merely that a call went through: it holds
      // exactly the one tab it held before the drop. Since 004/T104 the list is the whole browser's,
      // so the count that matters is of the tabs whose holder is this session.
      const recoveredA = await pollUntil(
        () => a.callTool("tabs_context"),
        (result) => result.isError === false && Array.isArray(result.json) && mine(result.json as ListedTab[]).length === 1,
        180_000,
      );
      const recoveryMs = Date.now() - startedAt;
      expect(recoveredA.isError, `alpha never recovered:\n${alpha?.stderr()}`).toBe(false);
      const recoveredB = await pollUntil(
        () => b.callTool("tabs_context"),
        (result) => result.isError === false && Array.isArray(result.json) && mine(result.json as ListedTab[]).length === 1,
        60_000,
      );
      expect(recoveredB.isError, `beta never recovered:\n${beta?.stderr()}`).toBe(false);
      // FR-057's bound, measured rather than waited for. Soft so that a link that comes back late
      // still reports *how* late and still lets cases 4 and 5 be measured in the same run; a soft
      // failure fails the test exactly as a hard one does.
      expect
        .soft(recoveryMs, `the link came back after ${recoveryMs} ms; FR-057 allows 10 000`)
        .toBeLessThanOrEqual(10_000);

      // Both kept their identity: their own tab - the one tab each still holds out of everything the
      // browser has open (004/T104) - and their own group still marked as the agent's.
      expect(mine(recoveredA.json as ListedTab[])).toEqual([tabA]);
      expect(mine(recoveredB.json as ListedTab[])).toEqual([tabB]);
      expect(await groupOf(tabA)).toEqual(groupA);
      expect(await groupOf(tabB)).toEqual(groupB);

      // ================= case 5: alpha's pre-drop ref still resolves after the reconnect =========
      // Beta was live throughout, so alpha's `pair-request` arrived at a worker already holding
      // another session. If the worker rebuilt alpha's tool context (a fresh nonce, a fresh epoch)
      // this read answers `stale-reference` instead of the element.
      const afterDrop = await a.callTool("read_page", { tabId: tabA, filter: "all", ref: beforeDrop });
      expect(
        afterDrop.text,
        "a reconnect with the same sessionId must not invalidate the session's refs",
      ).not.toContain("stale-reference");
      expect(afterDrop.isError, `${afterDrop.text}\nstderr:\n${a.stderr()}`).toBe(false);
      expect((afterDrop.json as { nodes: unknown[] }).nodes.length).toBeGreaterThan(0);

      // ================= case 4: one server dies; only that session is released (FR-058) ========
      // Closing the client ends the `mcp-server` process it spawned - the transport kills the child
      // - which is what an agent exiting looks like to the relay: one socket closes, one
      // `session-ended` arrives, and nothing tells the worker anything about the other session.
      await b.close();
      beta = undefined;

      await expect
        .poll(async () => (await groupOf(tabB)).title, { timeout: 15_000, intervals: [250] })
        .not.toBe(AGENT_GROUP_TITLE);
      // Beta's tabs are the owner's now, so they stay open.
      expect(await extensionWorker.evaluate(async (id: number) => (await chrome.tabs.get(id)).url, tabB)).toBe(
        `${SITE}/form`,
      );
      // Alpha is untouched by its neighbour's death: same group, same marking, same tab.
      expect(await groupOf(tabA)).toEqual(groupA);
      expect(mine(await heldBy(a))).toEqual([tabA]);
      // ...and beta's tab, released by its session's death, is nobody's now - the owner has it back.
      expect((await heldBy(a)).find((tab) => tab.tabId === tabB)?.holder).toBe("none");

      await extensionWorker.evaluate(async (ids: number[]) => chrome.tabs.remove(ids), [tabA, tabB]);
    } finally {
      await alpha?.close();
      await beta?.close();
    }
  });
});

/**
 * Kills the relay Chrome spawned, without touching either `mcp-server` the clients are talking to.
 *
 * Returns whether anything was killed, so the journey never reports a recovery it did not cause.
 */
function killRelay(): boolean {
  // Narrowed to `node.exe` on purpose: a command-line match alone also matches this test's own
  // shell, and killing that would take the runner down with the relay.
  const script =
    "$ErrorActionPreference='SilentlyContinue'; " +
    "$p = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*native-host.js*' }); " +
    "foreach ($proc in $p) { Stop-Process -Id $proc.ProcessId -Force }; " +
    "if ($p.Count -gt 0) { 'relay-killed' } else { 'relay-absent' }; exit 0";
  const out = execFileSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" });
  return out.includes("relay-killed");
}

/** Retries a call until it satisfies `accept`, so a reconnect in flight is waited for, not raced. */
async function pollUntil<T>(attempt: () => Promise<T>, accept: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await attempt();
  while (!accept(last) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    last = await attempt();
  }
  return last;
}

