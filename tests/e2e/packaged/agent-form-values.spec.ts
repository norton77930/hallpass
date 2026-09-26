import { DEFAULT_BOUNDS } from "@hallpass/contracts";
import { lookup } from "../../../apps/extension/src/locales/catalog.js";
import { startMcpClient, type McpHarnessClient } from "../../harness/mcp-client.js";
import { pairWithFirstCall } from "../fixtures/agent-pairing.js";
import { copyFor, localeFromEnv, openSidePanel } from "../fixtures/side-panel-driver.js";
import { expect, test } from "../fixtures/packaged-extension.js";

const locale = localeFromEnv();
const copy = copyFor(locale);
const ui = (key: string): string => lookup(key, locale);

const SITE = "https://127.0.0.1:19443";

/**
 * 005/T174 - US1 end to end: a read says what each field holds, and hides what it must
 * (FR-072..FR-074, SC-040; `form-values.html`).
 *
 * The unit and contract tests prove the shape; this is the one place the whole path is real - a
 * branded Chrome's own `.value`, `selectedOptions` and `checked`, carried through the content
 * runtime, the broker and the merge to the MCP answer. SC-040 is asserted exactly: the filled
 * password and the filled `cc-number` field are `redacted: true` with no `value`, the filled email
 * carries its value. Nothing is typed first: the fixture is pre-filled, so the read is the claim.
 *
 * Attach mode only, for the same reason every other agent journey is: the bridge starts with a
 * machine install, and a browser this gate launched itself would prove nothing about it.
 */

type FieldNode = {
  ref?: string;
  role: string;
  name?: string;
  type?: string;
  options?: string[];
  value?: string;
  checked?: boolean;
  redacted?: boolean;
  valueTruncated?: boolean;
};

test.describe("agent form values", () => {
  test.skip(
    !process.env.HALLPASS_CDP_ENDPOINT,
    "attach mode only: the native-messaging host is a machine install, so the browser under test " +
      "must be one the runner started and pointed at the installed host (HALLPASS_CDP_ENDPOINT).",
  );

  test("read_page carries each field's state, redacts the secrets, and find says the same", async ({
    extensionContext,
    extensionId,
    extensionWorker,
  }) => {
    test.setTimeout(240_000);

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
    await panel.waitForText(ui("agent.appTitle"));

    let client: McpHarnessClient | undefined;
    try {
      client = await startMcpClient({ clientName: "Claude Code" });
      const live = client;
      await panel.clickIfPresent(ui("agent.retry"));
      await pairWithFirstCall(client, panel, { locale });

      const call = async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
        const result = await live.callTool(tool, args);
        expect(result.isError, `${tool} failed: ${result.text}\nmcp-server stderr:\n${live.stderr()}`).toBe(false);
        return result.json;
      };

      const created = (await call("tabs_create", { url: `${SITE}/form-values` })) as { tabId: number };
      const tabId = created.tabId;

      // ============= 1. read_page: every field's state, as the owner sees it =============
      const read = (await call("read_page", { tabId, filter: "all" })) as { nodes: FieldNode[] };
      // The refs are random hashes, and one of them once spelt the first digits of the card number
      // (`t_4111f7…` in an attach run): they are stripped before any secret is looked for, and the
      // secrets are looked for whole.
      const dump = JSON.stringify(read.nodes, (key, value) => (key === "ref" ? undefined : value));
      const field = (name: string): FieldNode => {
        const node = read.nodes.find((candidate) => candidate.name === name);
        expect(node, `no node named "${name}" in ${dump}`).toBeTruthy();
        return node!;
      };

      // SC-040, exactly: the two secrets are redacted with no value; the email carries its value.
      expect(field("password")).toMatchObject({ type: "password", redacted: true });
      expect(field("password")).not.toHaveProperty("value");
      expect(field("card")).toMatchObject({ redacted: true });
      expect(field("card")).not.toHaveProperty("value");
      expect(field("email")).toMatchObject({ type: "email", value: "ada@example.test" });
      expect(dump).not.toContain("hunter2");
      expect(dump).not.toContain("4111 1111 1111 1111");
      expect(dump).not.toContain("4111111111111111");

      // FR-072 scenarios 1, 4, 5: a text input's live value, a select's shown text beside its
      // options, a multiple select's every selected text, a textarea with its line break kept.
      expect(field("fullname")).toMatchObject({ value: "Ada Lovelace" });
      expect(field("size")).toMatchObject({ options: ["Small", "Medium", "Large"], value: "Large" });
      expect(field("toppings")).toMatchObject({ value: "Bacon, Onion" });
      expect(field("notes")).toMatchObject({ value: "Ring twice.\nLeave at the door." });

      // Scenarios 2 and 3: toggles carry `checked` and never `value`; the chosen radio is the one.
      expect(field("gift")).toMatchObject({ role: "checkbox", checked: true });
      expect(field("newsletter")).toMatchObject({ role: "checkbox", checked: false });
      expect(field("gift")).not.toHaveProperty("value");
      const radios = read.nodes.filter((node) => node.role === "radio" && node.name === "delivery");
      expect(radios.map((node) => node.checked), dump).toEqual([false, true, false]);

      // An empty field carries none of the four (FR-073's rule for every field, not only secrets).
      const empty = field("empty");
      expect(empty).not.toHaveProperty("value");
      expect(empty).not.toHaveProperty("checked");
      expect(empty).not.toHaveProperty("redacted");
      expect(empty).not.toHaveProperty("valueTruncated");

      // Every value the read carried respects the label bound (FR-074).
      for (const node of read.nodes) {
        if (typeof node.value === "string") expect(node.value.length).toBeLessThanOrEqual(DEFAULT_BOUNDS.maxLabelChars);
      }

      // ============= 2. find: the same fields on a match (scenario 8) =============
      const found = (await call("find", { tabId, query: "email" })) as {
        outcome: string;
        matches: FieldNode[];
      };
      expect(found.outcome, JSON.stringify(found)).toBe("resolved");
      const emailMatch = found.matches.find((match) => match.ref === field("email").ref);
      expect(emailMatch, `the email field is not among ${JSON.stringify(found.matches)}`).toBeTruthy();
      expect(emailMatch).toMatchObject({ value: "ada@example.test" });

      await call("tabs_close", { tabId });
    } finally {
      await client?.close();
    }
  });
});
