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
 * 003/T044 — US4 end to end: the agent's own tabs (FR-044..FR-046, SC-024).
 *
 * The group is the boundary and this journey is what proves it is real rather than decorative. The
 * tab the agent created is inside a group Chrome itself titles "Agent" - checked through the browser
 * API, not through the worker that put it there - and a tab the *test* opened beside it is refused
 * by every tool that names a tab, however ordinary the request looks.
 *
 * The last two steps are the ones M4 exists for, and they are deliberately different. Killing the
 * *relay* Chrome spawned drops the link while the agent's MCP session keeps running, and the tab
 * created before the drop is still the session's - a worker that minted a session id per connection
 * would have stranded it (D-M3-3). Closing the *client* ends the agent session itself, and then the
 * group must stop saying "Agent": the tabs are the owner's again.
 */
test.describe("agent tabs", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT,
    "attach mode only: the native-messaging host is a machine install, so the browser under test " +
      "must be one the runner started and pointed at the installed host (HALLPASS_CDP_ENDPOINT).",
  );

  test("creates, navigates, goes back, lists only its own, closes, and survives a reconnect", async ({
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
      await panel.clickIfPresent(ui("agent.retry"));
      // T098a: the prompt by its own key, Accept clicked, and pairing confirmed by a signal that
      // is false when nothing is paired - the panel's section heading is on screen either way.
      await acceptPairing(panel, { locale });

      const call = async (tool: string, args: Record<string, unknown> = {}): Promise<unknown> => {
        const result = await live.callTool(tool, args);
        expect(result.isError, `${tool} failed: ${result.text}\nstderr:\n${live.stderr()}`).toBe(false);
        return result.json;
      };

      // ================= create, in a group the owner can see is the agent's =================
      const created = (await call("tabs_create", { url: `${SITE}/ordinary` })) as { tabId: number };
      const tabId = created.tabId;
      const grouping = await extensionWorker.evaluate(async (id: number) => {
        const tab = await chrome.tabs.get(id);
        const group = tab.groupId === undefined || tab.groupId < 0 ? undefined : await chrome.tabGroups.get(tab.groupId);
        return { groupId: tab.groupId, title: group?.title, url: tab.url };
      }, tabId);
      expect(grouping.groupId).toBeGreaterThan(-1);
      expect(grouping.title).toBe(AGENT_GROUP_TITLE);

      // ================= a blank tab, to prove `url` really is optional =================
      const blank = (await call("tabs_create")) as { tabId: number };
      // Polled, not read once: Chrome's own record says `url: ""` until the blank document commits,
      // which a cold browser does a beat after `tabs.create` resolves (004/T167's shape, seen here
      // on the first family run after a relaunch). The claim is where the tab ends up.
      await expect
        .poll(() => extensionWorker.evaluate(async (id: number) => (await chrome.tabs.get(id)).url, blank.tabId), {
          timeout: 10_000,
        })
        .toBe("about:blank");
      await call("tabs_close", { tabId: blank.tabId });

      // ================= navigate forwards, then back through the tab's own history =================
      const toForm = (await call("navigate", { tabId, url: `${SITE}/form` })) as { url: string };
      expect(toForm).toEqual({ url: `${SITE}/form` });
      const back = (await call("navigate", { tabId, direction: "back" })) as { url: string };
      expect(back).toEqual({ url: `${SITE}/ordinary` });
      const forward = (await call("navigate", { tabId, direction: "forward" })) as { url: string };
      expect(forward).toEqual({ url: `${SITE}/form` });

      // ================= resize the window the tab is in =================
      const resized = (await call("resize_window", { tabId, width: 1000, height: 760 })) as {
        width: number;
        height: number;
      };
      expect(resized.width).toBeGreaterThan(0);
      expect(resized.height).toBeGreaterThan(0);

      // ================= tabs_context names the holder of every tab =================
      const outsider = await extensionContext.newPage();
      await outsider.goto(`${SITE}/tags`);
      const outsiderTabId = await extensionWorker.evaluate(async (url: string) => {
        const [tab] = await chrome.tabs.query({ url });
        if (tab?.id === undefined) throw new Error("outsider-tab-missing");
        return tab.id;
      }, `${SITE}/tags`);

      const listed = (await call("tabs_context")) as Array<{
        tabId: number;
        url: string;
        active: boolean;
        holder: unknown;
      }>;
      /**
       * 004/T105c. This asserted the list *was* the session's own tab, which is not the claim it
       * was making - it was making the claim that the agent can tell its own tab from one it may
       * not touch. B20 moved that fact from the list's membership to each row's `holder`: the list
       * is now every tab in the browser, so an agent can find the owner's page and claim it, and
       * the row says whose each one is.
       */
      const own = listed.find((tab) => tab.tabId === tabId);
      expect(own?.holder).toBe("this");
      expect(own?.url).toBe(`${SITE}/form`);
      expect(typeof own?.active).toBe("boolean");
      // The tab this test opened by hand is listed too, and no session holds it - which is exactly
      // what makes the refusals below "not-yours" rather than "held-by-session".
      const foreign = listed.find((tab) => tab.tabId === outsiderTabId);
      expect(foreign?.holder).toBe("none");

      // ================= SC-024: a tab outside the group is refused by every tool =================
      for (const [tool, args] of [
        ["navigate", { tabId: outsiderTabId, url: `${SITE}/ordinary` }],
        ["resize_window", { tabId: outsiderTabId, width: 800, height: 600 }],
        ["tabs_close", { tabId: outsiderTabId }],
        ["get_page_text", { tabId: outsiderTabId }],
      ] as Array<[string, Record<string, unknown>]>) {
        const refused = await live.callTool(tool, args);
        expect(refused.isError, tool).toBe(true);
        // The outsider tab is one the test opened by hand, so no session holds it: "not yours".
        expect(refused.json, tool).toMatchObject({ outcome: "denied", reason: "not-yours" });
      }
      // Refused means untouched: the tab the test opened is still there, on the page it was on.
      expect(outsider.isClosed()).toBe(false);
      expect(outsider.url()).toBe(`${SITE}/tags`);
      await outsider.close();

      // ================= a relay reconnect keeps the tab owned (M4 Part A) =================
      // The *relay* is the `native-host.js` process Chrome spawned; killing it is exactly what a
      // worker restart or a crashed host looks like from here. The agent's own MCP session - this
      // client, this process - is untouched, which is the distinction M4 Part A turns on: one agent
      // session outlives any number of relay connections (D-M3-3), so the tab it created is still
      // its own afterwards.
      expect(killRelay(), "no relay process was running to kill").toBe(true);
      await panel.clickIfPresent(ui("agent.retry"));

      /**
       * 004/T105c, same restatement as above: the claim is that the tab is *still this session's*
       * after the relay came and went, which the list's length stopped being able to say when B20
       * made `tabs_context` the browser's tabs rather than the session's. The holder says it
       * directly, and a predicate that waited for a length would have burned its whole 45 s.
       */
      const holdsOwnTab = (result: { isError: boolean; json: unknown }): boolean =>
        result.isError === false &&
        Array.isArray(result.json) &&
        (result.json as Array<{ tabId: number; holder?: unknown }>).some(
          (tab) => tab.tabId === tabId && tab.holder === "this",
        );
      const afterReconnect = await pollUntil(() => live.callTool("tabs_context"), holdsOwnTab, 45_000);
      expect(
        (afterReconnect.json as Array<{ tabId: number; url: string; holder?: unknown }>).find(
          (tab) => tab.tabId === tabId,
        ),
        `stderr:
${live.stderr()}`,
      ).toMatchObject({ tabId, url: `${SITE}/form`, holder: "this", active: expect.any(Boolean) });

      // ================= close, and stop listing it =================
      const closed = await live.callTool("tabs_close", { tabId });
      expect(closed.isError, closed.text).toBe(false);
      expect(closed.json).toEqual({ closed: true });
      const empty = await live.callTool("tabs_context");
      // 004/T105c: "the session lists nothing" is now "the session holds nothing" - the closed tab
      // is not in the browser at all, and no other tab became this session's by its closing.
      const rows = empty.json as Array<{ tabId: number; holder?: unknown }>;
      expect(rows.map((tab) => tab.tabId)).not.toContain(tabId);
      expect(rows.filter((tab) => tab.holder === "this")).toEqual([]);

      // ================= FR-044: a tab the owner closed by hand answers stale =================
      const doomed = (await call("tabs_create", { url: `${SITE}/ordinary` })) as { tabId: number };
      await extensionWorker.evaluate(async (id: number) => chrome.tabs.remove(id), doomed.tabId);
      const gone = await live.callTool("navigate", { tabId: doomed.tabId, url: `${SITE}/form` });
      expect(gone.isError).toBe(true);
      expect(gone.json).toMatchObject({ outcome: "stale", reason: "tab-gone" });

      // ================= the session ends: the group stops saying "Agent" (M4 Part A) =================
      const survivor = (await call("tabs_create", { url: `${SITE}/ordinary` })) as { tabId: number };
      const groupOf = await extensionWorker.evaluate(
        async (id: number) => (await chrome.tabs.get(id)).groupId,
        survivor.tabId,
      );
      expect(groupOf).toBeGreaterThan(-1);

      await client.close();
      client = undefined;

      // The agent is gone, so the owner's tab strip must stop claiming one is driving these tabs -
      // and the tabs themselves stay, because they are the owner's now.
      await expect
        .poll(
          async () =>
            extensionWorker.evaluate(async (id: number) => (await chrome.tabGroups.get(id)).title, groupOf),
          { timeout: 30_000 },
        )
        .not.toBe(AGENT_GROUP_TITLE);
      await extensionWorker.evaluate(async (id: number) => chrome.tabs.remove(id), survivor.tabId);
    } finally {
      await client?.close();
    }
  });
});

/**
 * Kills the relay Chrome spawned, without touching the MCP server the agent is talking to.
 *
 * This is the only way to produce a *relay* drop from outside the browser: the port belongs to
 * Chrome, and the extension cannot be asked to drop it. Returns whether anything was killed, so a
 * journey never reports a reconnect it did not actually cause.
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
    await new Promise((resolve) => setTimeout(resolve, 500));
    last = await attempt();
  }
  return last;
}

