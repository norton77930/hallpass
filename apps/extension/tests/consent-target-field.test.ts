/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentNativeRequest } from "@hallpass/contracts";
import { createContentRuntimeContext, handleContentMessage } from "../src/content-runtime/index.js";
import { createAgentEffects } from "../src/service-worker/agent-tools/effects.js";
import { createAgentPageBindings } from "../src/service-worker/agent-tools/page-binding.js";
import { createAgentPromptController } from "../src/service-worker/agent-tools/prompts.js";
import { createSiteModeStore } from "../src/service-worker/site-mode-store.js";
import { testSessionContexts } from "./helpers/agent-session-contexts.js";
import { testInputAttachments } from "./helpers/input-attachments.js";
import { oneDocumentAnswer, oneDocumentFocus } from "./helpers/point-site.js";

/**
 * 006 FR-085, change log 2026-11-21, statement 7 of the consent feature: a field is described on
 * the consent card by its name only, never by what is in it.
 *
 * The worker's read is bridged straight to the real content runtime over this document, so the
 * role and name are the production collector's - a filled password field is the target of a gated
 * `click` and `type`, and the question the worker raises is searched for the value.
 */

const AGENT_TAB = 7;
const SITE = "https://fixtures.test:19443";
const PAGE_URL = `${SITE}/login`;
const DOCUMENT_EPOCH = "doc-login-1";
const SECRET = "hunter2-Sup3rSecret";

function installChrome(): void {
  const runtimeContext = createContentRuntimeContext({ documentEpoch: DOCUMENT_EPOCH, canonicalOrigin: SITE });
  const local: Record<string, unknown> = {};
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        async get(keys: string[]) {
          const out: Record<string, unknown> = {};
          for (const key of keys) if (key in local) out[key] = local[key];
          return out;
        },
        async set(values: Record<string, unknown>) {
          Object.assign(local, values);
        },
      },
    },
    // The frame enumeration answers nothing: the page is one document.
    scripting: { async executeScript() {} },
    tabs: {
      async get(tabId: number) {
        if (tabId !== AGENT_TAB) throw new Error("No tab with id");
        return { id: AGENT_TAB, url: PAGE_URL };
      },
      async query() {
        return [{ id: AGENT_TAB, url: PAGE_URL }];
      },
      async sendMessage(_tabId: number, message: unknown) {
        return handleContentMessage(message, undefined, runtimeContext);
      },
    },
  };
}

function runnerOverThisDocument() {
  const prompts = createAgentPromptController({ timeoutMs: 5_000 });
  const input = testInputAttachments();
  const recorded = input.attachments.send.bind(input.attachments);
  input.attachments.send = async (tabId, method, params, sessionId) => {
    const answered = await recorded(tabId, method, params, sessionId);
    return oneDocumentAnswer(method) ?? answered;
  };
  const runner = createAgentEffects({
    context: testSessionContexts(),
    siteModes: createSiteModeStore(),
    bindings: createAgentPageBindings(),
    prompts,
    tabOwnership: async (_sessionId, tabId) => (tabId === AGENT_TAB ? { state: "this" } : { state: "not-yours" }),
    attachments: input.attachments,
    cursor: () => {},
    locate: async () => ({ x: 100, y: 40, width: 80, height: 20 }),
    confirm: async () => ({ outcome: "hit" as const }),
    execute: vi.fn(),
    probe: async () => ({ ok: true, documentEpoch: DOCUMENT_EPOCH, canonicalOrigin: SITE }),
    readFrameFocus: oneDocumentFocus,
    settleMs: 0,
  });
  return { runner, prompts };
}

function request(overrides: Partial<AgentNativeRequest>): AgentNativeRequest {
  return { callId: "call-1", sessionId: "session-h1", tool: "click", tabId: AGENT_TAB, args: {}, ...overrides };
}

describe("the consent card names a field, never its value (consent statement 7)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it.each([
    ["click", (ref: string) => ({ tabId: AGENT_TAB, target: { ref } })],
    ["type", (ref: string) => ({ tabId: AGENT_TAB, target: { ref }, text: "x", mode: "insert" })],
  ] as const)("a filled password field as the target of %s: its name on the card, its value nowhere", async (tool, argsFor) => {
    document.body.innerHTML = `<form><label for="pw">Account password</label><input id="pw" type="password"></form>`;
    (document.getElementById("pw") as HTMLInputElement).value = SECRET;
    installChrome();
    const { runner, prompts } = runnerOverThisDocument();

    const found = await runner.run(
      request({ callId: "find-1", tool: "find", args: { tabId: AGENT_TAB, query: "Account password", maxCandidates: 3 } }),
    );
    expect(found.outcome).toBe("ok");
    const ref = (found.result as { matches: Array<{ ref: string }> }).matches[0]?.ref ?? "";
    expect(ref).not.toBe("");

    const pending = runner.run(request({ tool, args: argsFor(ref) }));
    await vi.waitFor(() => expect(prompts.current()).toBeDefined());
    const card = prompts.current();

    expect(card).toMatchObject({ targetRole: "textbox", targetLabel: "Account password" });
    expect(JSON.stringify(card)).not.toContain(SECRET);
    prompts.decide(card?.promptId ?? "", false);
    await expect(pending).resolves.toMatchObject({ outcome: "denied", reason: "owner-denied" });
  });
});

/** The card a gated `click` raises on the control `find` gives for `query` in `html`, then refused. */
async function cardForClickOn(html: string, query: string) {
  document.body.innerHTML = html;
  installChrome();
  const { runner, prompts } = runnerOverThisDocument();
  const found = await runner.run(
    request({ callId: "find-1", tool: "find", args: { tabId: AGENT_TAB, query, maxCandidates: 3 } }),
  );
  const ref = (found.result as { matches?: Array<{ ref: string }> } | undefined)?.matches?.[0]?.ref ?? "";
  expect(ref, `find "${query}" answered ${JSON.stringify(found)}`).not.toBe("");
  const pending = runner.run(request({ args: { tabId: AGENT_TAB, target: { ref } } }));
  await vi.waitFor(() => expect(prompts.current()).toBeDefined());
  const card = prompts.current();
  prompts.decide(card?.promptId ?? "", false);
  await pending;
  return card;
}

/**
 * Consent statement 11 (006 change log 2026-11-21, follow-up): the quoted name is the words the
 * owner sees on the control, and its kind matches what it is - through the production collector.
 */
describe("the consent card names an input by what it shows and says what kind it is (consent statement 11)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it.each(["submit", "button", "reset"])(
    "an input type=%s is a button named by the label it shows, never by its name attribute",
    async (type) => {
      const card = await cardForClickOn(`<form><input type="${type}" value="Sign in" name="commit"></form>`, "Sign in");
      expect(card).toMatchObject({ targetRole: "button", targetLabel: "Sign in" });
      expect(JSON.stringify(card)).not.toContain("commit");
    },
  );

  it("an input type=submit with no value is not named by its name attribute", async () => {
    const card = await cardForClickOn(`<form><input type="submit" name="commit"></form>`, "button");
    expect(card?.targetRole).toBe("button");
    expect(JSON.stringify(card)).not.toContain("commit");
  });

  it("an input type=image is named by its alt text", async () => {
    const card = await cardForClickOn(`<form><input type="image" alt="Search the shop" name="go" src="x.png"></form>`, "Search the shop");
    expect(card).toMatchObject({ targetRole: "button", targetLabel: "Search the shop" });
  });

  it("a range input is a slider", async () => {
    const card = await cardForClickOn(`<label>Volume <input type="range" min="0" max="10"></label>`, "Volume");
    expect(card).toMatchObject({ targetRole: "slider", targetLabel: "Volume" });
  });

  it.each(["date", "time", "month", "week", "datetime-local", "color"])(
    "an input type=%s is not called a text field",
    async (type) => {
      const card = await cardForClickOn(`<label>Pick one <input type="${type}"></label>`, "Pick one");
      expect(card?.targetLabel).toBe("Pick one");
      expect(card?.targetRole).not.toBe("textbox");
      expect(card?.targetRole).not.toBe("unreadable");
    },
  );
});
