import { lookup } from "../../../apps/extension/src/locales/catalog.js";
import { TEST_EXTENSION_ID } from "../../../packages/test-kit/src/build-config.js";
import { startMcpClient, type McpHarnessClient } from "../../harness/mcp-client.js";
import { unpairAgent } from "../fixtures/agent-pairing.js";
import { copyFor, localeFromEnv, openSidePanel, waitForAgentPanel } from "../fixtures/side-panel-driver.js";
import { expect, test } from "../fixtures/packaged-extension.js";

const locale = localeFromEnv();
const copy = copyFor(locale);
const ui = (key: string): string => lookup(key, locale);

/**
 * 003/T021 — US1 end to end, on the packaged extension, driven by a real MCP client over stdio.
 *
 * This is the only journey in the suite with no launched-mode form. The bridge starts with a
 * machine install: a native-messaging host manifest and two registry keys that Chrome reads when it
 * spawns the host (R-101). A browser this gate launched itself would still read the same machine
 * install, so launching one would prove nothing extra and would hide which install was used.
 *
 * Nothing private is imported: the agent side is the real `dist/mcp-server.js` spoken to over
 * stdio, and the owner side is the rendered side panel reached through CDP.
 *
 * Prerequisites the runner must have done: `npm run build:extension:agent`, the `dist/agent`
 * artefact loaded into the attached browser, and `npm run agent-host:install`.
 */
test.describe("agent pairing", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT,
    "attach mode only: the native-messaging host is a machine install, so the browser under test " +
      "must be one the runner started and pointed at the installed host (HALLPASS_CDP_ENDPOINT).",
  );

  test("pairs once, answers tabs_context, needs no second prompt, and refuses after unpair", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(240_000);
    expect(extensionId).toBe(TEST_EXTENSION_ID);

    // The narrow artefact cannot do any of this; saying so here is clearer than a timeout later.
    const permissions = await extensionWorker.evaluate(() => chrome.runtime.getManifest().permissions ?? []);
    expect(
      permissions,
      "the attached browser must have apps/extension/dist/agent loaded (npm run build:extension:agent)",
    ).toContain("nativeMessaging");

    const fixturePage = extensionContext.pages()[0] ?? (await extensionContext.newPage());
    await fixturePage.goto("https://localhost:19443/ordinary");
    await fixturePage.bringToFront();
    const tabId = await extensionWorker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined) throw new Error("active-tab-missing");
      return tab.id;
    });

    const panel = await openSidePanel({
      context: extensionContext,
      extensionId,
      fixturePage,
      tabId,
      copy,
    });
    const { panelText, waitForText, clickButton, clickIfPresent } = panel;
    await waitForAgentPanel(panel);

    let first: McpHarnessClient | undefined;
    let second: McpHarnessClient | undefined;
    try {
      // --- The agent session starts. The owner has not been asked anything yet. ---
      first = await startMcpClient({ clientName: "Claude Code" });
      expect(await first.listToolNames()).toContain("tabs_context");

      // The worker retries the bridge on an alarm every minute; Retry on the not-connected page is
      // the owner asking for it now, which keeps this journey to seconds rather than to the alarm's
      // period. It is present only while the page is (006 FR-082), so it is clicked if it is there.
      await clickIfPresent(ui("agent.retry"));

      // --- SC-020: the first tool call is what asks the owner (FR-059a: connecting asks nothing). ---
      // Not awaited: it waits on the owner's answer, which is given below.
      const firstCall = first.callTool("tabs_context", {}, { timeoutMs: 120_000 });

      // --- The pairing prompt, with the agent's stated name and the forwarding disclosure. ---
      await waitForText(ui("agent.pairingTitle"));
      const prompt = await panelText();
      expect(prompt).toContain("Claude Code");
      expect(prompt).toContain(ui("agent.forwardingDisclosure"));

      await clickButton(ui("agent.accept"));
      // 006: paired shows as the status row; the card is gone with the decision.
      await waitForText(ui("agent.status.connected"));

      // --- SC-020: the call that raised the prompt now goes all the way through and comes back. ---
      const context = await firstCall;
      expect(context.isError, `mcp-server stderr:\n${first.stderr()}`).toBe(false);
      /**
       * 004/T111, the last of the B20 family. This asserted an empty list, because a session used
       * to be told only about its own tabs. The claim it was making is that the freshly paired
       * session has taken nothing yet - and since B20 the list is the browser's tabs, so that fact
       * lives in each row's `holder` rather than in the list being empty.
       */
      expect(Array.isArray(context.json)).toBe(true);
      expect(
        (context.json as Array<{ holder?: unknown }>).filter((tab) => tab.holder === "this"),
      ).toEqual([]);

      // --- A second session of the same agent: no prompt, and the call just works. ---
      await first.close();
      first = undefined;
      second = await startMcpClient({ clientName: "Claude Code" });
      await clickIfPresent(ui("agent.retry"));

      const secondContext = await pollUntil(
        async () => second?.callTool("tabs_context"),
        (result) => result?.isError === false,
        30_000,
      );
      // Same restatement, same claim: the second session was answered (not refused, and with no
      // second prompt) and it holds nothing of its own either.
      expect(Array.isArray(secondContext?.json), `mcp-server stderr:\n${second.stderr()}`).toBe(
        true,
      );
      expect(
        (secondContext?.json as Array<{ holder?: unknown }>).filter((tab) => tab.holder === "this"),
      ).toEqual([]);
      expect(await panelText()).not.toContain(ui("agent.pairingTitle"));

      // --- SC-026: the owner unpairs, and the open session's next call is refused by name. ---
      await unpairAgent(panel, { locale });

      const refused = await second.callTool("tabs_context");
      expect(refused.isError).toBe(true);
      expect(refused.json).toMatchObject({ outcome: "denied", reason: "not-paired" });
    } finally {
      await first?.close();
      await second?.close();
    }
  });
});

/** Retries a call until it satisfies `accept`, so a reconnect in flight is waited for, not raced. */
async function pollUntil<T>(
  attempt: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await attempt();
  while (!accept(last) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    last = await attempt();
  }
  return last;
}
