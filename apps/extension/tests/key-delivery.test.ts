import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentNativeRequest } from "@hallpass/contracts";
import { testSessionContexts } from "./helpers/agent-session-contexts.js";
import { createAgentEffects } from "../src/service-worker/agent-tools/effects.js";
import { createAgentPageBindings } from "../src/service-worker/agent-tools/page-binding.js";
import { createAgentPromptController } from "../src/service-worker/agent-tools/prompts.js";
import { createKeyboardInput, type AgentInputAttachments } from "../src/service-worker/agent-tools/input.js";
import { createSiteModeStore } from "../src/service-worker/site-mode-store.js";
import type { PageExecutionOutcome } from "../src/service-worker/page-ports.js";

/**
 * 004/T122 — typing the page cannot tell from a person's (US5, R-113, G7, FR-064).
 *
 * The load-bearing assertion in this file is the *per-character sequence*, not the value that comes
 * out of it. 003 set the control's value and dispatched one `input` event, and a page that
 * suggests as you type, filters a combobox per key or validates on each keystroke stayed silent
 * through all of it. So the reference's observable behaviour is one key-down/key-up pair per
 * character, in order, each carrying that character's own text - and a test that only asked "does
 * the field hold the string afterwards" would pass against exactly the single value-set this task
 * exists to replace.
 *
 * The final value is asserted as well, against a control simulated from the dispatched events: the
 * sequence is the mechanism, the value is the promise, and a mechanism that does not keep the
 * promise is not a fix.
 */

const AGENT_TAB = 7;
const SITE = "https://fixtures.test:19443";
const PAGE_URL = `${SITE}/ordinary`;
const TARGET_RECT = { x: 100, y: 40, width: 80, height: 20 };

type Command = { tabId: number; method: string; params: Record<string, unknown> };

/** Just the parts of the attachment store keyboard delivery uses, with the traffic recorded. */
function fakeAttachments(): {
  attachments: AgentInputAttachments;
  commands: Command[];
  acquired: Array<{ tabId: number; holder: string }>;
  refuse: { reason: "devtools-open" | "restricted-page" | undefined };
} {
  const commands: Command[] = [];
  const acquired: Array<{ tabId: number; holder: string }> = [];
  const refuse: { reason: "devtools-open" | "restricted-page" | undefined } = { reason: undefined };
  const attachments = {
    async acquire(tabId: number, holder: string) {
      acquired.push({ tabId, holder });
      return refuse.reason === undefined
        ? { ok: true as const }
        : { ok: false as const, unavailableReason: refuse.reason };
    },
    async drop() {},
    async release() {},
    async releaseAll() {},
    async send(tabId: number, method: string, params?: Record<string, unknown>) {
      commands.push({ tabId, method, params: params ?? {} });
      return {};
    },
    attached: () => [],
    state: () => undefined,
    onEvent() {},
    onDetach() {},
    async attachedTabIds() {
      return [];
    },
    async detachStray() {},
  } as unknown as AgentInputAttachments;
  return { attachments, commands, acquired, refuse };
}

/**
 * A text control driven by nothing but the events that were dispatched at it.
 *
 * It is deliberately not told what was typed: it reads the same protocol traffic the browser would
 * and holds whatever that traffic produced, so "the field ends up holding the string" is a claim
 * about the delivery rather than about the caller's intent.
 */
function controlFrom(commands: Command[], startingValue = ""): string {
  let value = startingValue;
  let selected = false;
  const write = (text: string): void => {
    if (selected) {
      value = text;
      selected = false;
      return;
    }
    value += text;
  };
  for (const command of commands) {
    const params = command.params;
    if (command.method === "Input.insertText") {
      write(String(params.text ?? ""));
      continue;
    }
    if (command.method !== "Input.dispatchKeyEvent") continue;
    if (params.type !== "keyDown" && params.type !== "rawKeyDown") continue;
    const commandNames = Array.isArray(params.commands) ? (params.commands as string[]) : [];
    if (commandNames.includes("selectAll")) {
      selected = true;
      continue;
    }
    if (params.key === "Backspace" || params.key === "Delete") {
      if (selected) {
        value = "";
        selected = false;
      } else {
        value = value.slice(0, -1);
      }
      continue;
    }
    const text = typeof params.text === "string" ? params.text : "";
    if (text.length > 0 && text !== "\r") write(text);
  }
  return value;
}

/** The keyboard traffic only, in order, as the pairs a page would see. */
function keys(commands: Command[]): Array<Record<string, unknown>> {
  return commands
    .filter((command) => command.method === "Input.dispatchKeyEvent" || command.method === "Input.insertText")
    .map((command) => {
      const params = command.params;
      if (command.method === "Input.insertText") return { insertText: String(params.text) };
      return {
        type: String(params.type),
        key: params.key,
        code: params.code,
        ...(params.text === undefined ? {} : { text: params.text }),
        ...(params.modifiers === undefined || params.modifiers === 0 ? {} : { modifiers: params.modifiers }),
      };
    });
}

function installChrome(): void {
  const local: Record<string, unknown> = {};
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        async get(keys_: string[]) {
          const out: Record<string, unknown> = {};
          for (const key of keys_) if (key in local) out[key] = local[key];
          return out;
        },
        async set(values: Record<string, unknown>) {
          Object.assign(local, values);
        },
      },
    },
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
        const frame = message as { type: string };
        if (frame.type === "content.probe") {
          return { documentEpoch: "doc-1", canonicalOrigin: SITE };
        }
        // 004/T128, B65: a key press's own focus check (`content.resolve-active-element`) - the
        // control this file always names, still focused, the way clicking it left it.
        if (frame.type === "content.resolve-active-element") {
          return { ok: true, outcome: "resolved", candidates: [{ targetHandle: "t_search" }] };
        }
        throw new Error(`unexpected frame ${frame.type}`);
      },
    },
  };
}

function harness(overrides: Partial<Parameters<typeof createAgentEffects>[0]> = {}) {
  const fake = fakeAttachments();
  const execute = vi.fn(
    async () => ({ ok: true, effect: "text-entered", charactersChanged: 0, documentChanged: false }) as PageExecutionOutcome,
  );
  const siteModes = createSiteModeStore();
  const runner = createAgentEffects({
    context: testSessionContexts(),
    siteModes,
    bindings: createAgentPageBindings(),
    prompts: createAgentPromptController({ timeoutMs: 60 }),
    tabOwnership: async (_sessionId, tabId) =>
      tabId === AGENT_TAB ? { state: "this" } : { state: "not-yours" },
    attachments: fake.attachments,
    cursor: () => {},
    locate: async () => TARGET_RECT,
    execute,
    probe: async () => ({ ok: true, documentEpoch: "doc-1", canonicalOrigin: SITE }),
    settleMs: 0,
    ...overrides,
  });
  return { runner, siteModes, execute, ...fake };
}

function request(tool: string, args: Record<string, unknown>): AgentNativeRequest {
  return {
    callId: `call-${tool}`,
    sessionId: "session-k1",
    tool: tool as AgentNativeRequest["tool"],
    tabId: AGENT_TAB,
    args: { tabId: AGENT_TAB, ...args },
  };
}

describe("T122 keyboard delivery", () => {
  describe("the sequence itself", () => {
    it("sends one key-down/key-up pair per character, in order, each carrying its own text", async () => {
      const fake = fakeAttachments();
      const keyboard = createKeyboardInput({ attachments: fake.attachments });

      await keyboard.type(AGENT_TAB, "Hi!");

      expect(keys(fake.commands)).toEqual([
        { type: "keyDown", key: "H", code: "KeyH", text: "H", modifiers: 8 },
        { type: "keyUp", key: "H", code: "KeyH", modifiers: 8 },
        { type: "keyDown", key: "i", code: "KeyI", text: "i" },
        { type: "keyUp", key: "i", code: "KeyI" },
        { type: "keyDown", key: "!", code: "Digit1", text: "!", modifiers: 8 },
        { type: "keyUp", key: "!", code: "Digit1", modifiers: 8 },
      ]);
    });

    it("inserts a character with no key to press, and keeps going key by key after it", async () => {
      const fake = fakeAttachments();
      const keyboard = createKeyboardInput({ attachments: fake.attachments });

      await keyboard.type(AGENT_TAB, "a\u{1F600}b");

      expect(keys(fake.commands)).toEqual([
        { type: "keyDown", key: "a", code: "KeyA", text: "a" },
        { type: "keyUp", key: "a", code: "KeyA" },
        { insertText: "\u{1F600}" },
        { type: "keyDown", key: "b", code: "KeyB", text: "b" },
        { type: "keyUp", key: "b", code: "KeyB" },
      ]);
    });

    it("leaves the control holding exactly the requested string, emoji and all", async () => {
      const fake = fakeAttachments();
      const keyboard = createKeyboardInput({ attachments: fake.attachments });

      await keyboard.type(AGENT_TAB, "Café 42 \u{1F600}");

      expect(controlFrom(fake.commands)).toBe("Café 42 \u{1F600}");
    });

    it("clears what the control held before it types, when the caller asked to replace", async () => {
      const fake = fakeAttachments();
      const keyboard = createKeyboardInput({ attachments: fake.attachments });

      await keyboard.type(AGENT_TAB, "new", { replace: true });

      expect(controlFrom(fake.commands, "old text")).toBe("new");
    });

    it("adds to what the control held when the caller asked to insert", async () => {
      const fake = fakeAttachments();
      const keyboard = createKeyboardInput({ attachments: fake.attachments });

      await keyboard.type(AGENT_TAB, "!");

      expect(controlFrom(fake.commands, "hi")).toBe("hi!");
    });

    it("presses a named key with its own code, and carries the modifier the call named", async () => {
      const fake = fakeAttachments();
      const keyboard = createKeyboardInput({ attachments: fake.attachments });

      await keyboard.press(AGENT_TAB, "Tab", { modifiers: ["Shift"] });

      expect(keys(fake.commands)).toEqual([
        { type: "rawKeyDown", key: "Tab", code: "Tab", modifiers: 8 },
        { type: "keyUp", key: "Tab", code: "Tab", modifiers: 8 },
      ]);
    });

    it("repeats a key as many times as the call asked for", async () => {
      const fake = fakeAttachments();
      const keyboard = createKeyboardInput({ attachments: fake.attachments });

      await keyboard.press(AGENT_TAB, "ArrowDown", { repeat: 3 });

      expect(keys(fake.commands).filter((event) => event.type === "rawKeyDown")).toEqual([
        { type: "rawKeyDown", key: "ArrowDown", code: "ArrowDown" },
        { type: "rawKeyDown", key: "ArrowDown", code: "ArrowDown" },
        { type: "rawKeyDown", key: "ArrowDown", code: "ArrowDown" },
      ]);
    });
  });

  describe("through the effect tools", () => {
    beforeEach(() => {
      installChrome();
    });

    afterEach(() => {
      delete (globalThis as { chrome?: unknown }).chrome;
    });

    it("types into the target key by key, browser-level, and never through the page", async () => {
      const { runner, siteModes, commands, execute, acquired } = harness();
      await siteModes.set(SITE, { mode: "skip-checks" });

      const response = await runner.run(
        request("type", { target: { ref: "t_search" }, text: "ab", mode: "insert" }),
      );

      expect(response).toMatchObject({
        outcome: "ok",
        result: { observed: { effect: "text-entered", charactersChanged: 2 } },
      });
      expect(keys(commands)).toEqual([
        { type: "keyDown", key: "a", code: "KeyA", text: "a" },
        { type: "keyUp", key: "a", code: "KeyA" },
        { type: "keyDown", key: "b", code: "KeyB", text: "b" },
        { type: "keyUp", key: "b", code: "KeyB" },
      ]);
      expect(controlFrom(commands)).toBe("ab");
      // The page-level executor set the value in one go, which is what left a per-keystroke page
      // silent; a fallback to it would hand the page that same silence back.
      expect(execute).not.toHaveBeenCalled();
      expect(acquired).toEqual([{ tabId: AGENT_TAB, holder: "input" }]);
    });

    it("puts the caret in the named control before the first keystroke", async () => {
      const { runner, siteModes, commands } = harness();
      await siteModes.set(SITE, { mode: "skip-checks" });

      await runner.run(request("type", { target: { ref: "t_search" }, text: "a" }));

      const methods = commands.map((command) => command.method);
      // A key event goes wherever the page's focus is, so the control is clicked first - the way a
      // person reaches a field they are about to type in.
      expect(methods.indexOf("Input.dispatchMouseEvent")).toBeLessThan(
        methods.indexOf("Input.dispatchKeyEvent"),
      );
    });

    it("presses a key through the debugger, as many times as the call asked for", async () => {
      const { runner, siteModes, commands, execute } = harness();
      await siteModes.set(SITE, { mode: "skip-checks" });

      const response = await runner.run(
        request("key", { target: { ref: "t_search" }, key: "ArrowDown", repeat: 3 }),
      );

      expect(response).toMatchObject({
        outcome: "ok",
        result: { observed: { effect: "key-pressed", key: "ArrowDown" } },
      });
      expect(keys(commands).filter((event) => event.type === "rawKeyDown")).toHaveLength(3);
      expect(execute).not.toHaveBeenCalled();
    });

    it("answers input-unavailable when the tab cannot be attached, with no second route", async () => {
      const { runner, siteModes, refuse, commands, execute } = harness();
      refuse.reason = "devtools-open";
      await siteModes.set(SITE, { mode: "skip-checks" });

      const response = await runner.run(request("type", { target: { ref: "t_search" }, text: "ab" }));

      expect(response).toMatchObject({
        outcome: "failed",
        reason: "input-unavailable",
        refusal: { reason: "input-unavailable", unavailableReason: "devtools-open" },
      });
      expect(commands).toEqual([]);
      expect(execute).not.toHaveBeenCalled();
    });
  });
});
