import { describe, expect, it } from "vitest";
import { ACTION_LABEL_MAX_CHARS, describeAction, REDACTED_TEXT } from "../src/service-worker/recording/action-label.js";

/**
 * 008/T220 — what a frame says the agent did (FR-105, FR-106, design-notes §2).
 *
 * Two rules and one table. The first is that the label is finished *here*: cut to 40 characters and
 * masked before it leaves the worker, so the offscreen document never sees the full text of
 * anything. The second is FR-106: text typed into a field 005 calls redacted is `••••` and never
 * the characters - and because the worker cannot ask the page what kind of field it was at the
 * moment the action landed, an unknown field is treated as a secret one. A label that showed a
 * password because the ref was not in the read that preceded it is exactly the failure the rule
 * exists to prevent; a label that says `••••` about an ordinary search box is a worse picture and
 * not a leak.
 */

describe("describeAction", () => {
  it("names the tool and the target's own name", () => {
    expect(
      describeAction({
        tool: "click",
        args: { tabId: 1, target: { ref: "r1" } },
        target: { name: "Sign in", role: "button" },
        point: { x: 120, y: 40 },
      }),
    ).toEqual({ tool: "click", label: 'click "Sign in"', point: { x: 120, y: 40 } });
  });

  it("keeps a click with no known target to the tool alone", () => {
    expect(describeAction({ tool: "click", args: { tabId: 1, target: { ref: "r1" } } })).toEqual({
      tool: "click",
      label: "click",
    });
  });

  it("shows text typed into a field the last read said is ordinary", () => {
    expect(
      describeAction({
        tool: "type",
        args: { tabId: 1, target: { ref: "r1" }, text: "hello world" },
        target: { name: "Search", type: "text" },
      }),
    ).toEqual({ tool: "type", label: 'type "hello world"' });
  });

  it("masks text typed into a password field", () => {
    expect(
      describeAction({
        tool: "type",
        args: { tabId: 1, target: { ref: "r1" }, text: "hunter2" },
        target: { name: "Password", type: "password" },
      }),
    ).toEqual({ tool: "type", label: `type "${REDACTED_TEXT}"`, redacted: true });
  });

  it("masks text typed into a field whose autocomplete names a one-time code", () => {
    const action = describeAction({
      tool: "type",
      args: { tabId: 1, target: { ref: "r1" }, text: "123456" },
      target: { name: "Code", type: "text", autocomplete: "one-time-code" },
    });

    expect(action.redacted).toBe(true);
    expect(action.label).toBe(`type "${REDACTED_TEXT}"`);
  });

  it("masks text typed at a target nothing is known about", () => {
    const action = describeAction({ tool: "type", args: { tabId: 1, text: "hunter2" } });

    expect(action).toEqual({ tool: "type", label: `type "${REDACTED_TEXT}"`, redacted: true });
  });

  it("masks a value set into a field the page marked redacted", () => {
    expect(
      describeAction({
        tool: "form_input",
        args: { tabId: 1, ref: "r1", value: "4111111111111111" },
        target: { name: "Card number", redacted: true },
        point: { x: 10, y: 20 },
      }),
    ).toEqual({
      tool: "form_input",
      label: `form_input "${REDACTED_TEXT}"`,
      redacted: true,
      point: { x: 10, y: 20 },
    });
  });

  it("says what a toggle was set to", () => {
    expect(
      describeAction({
        tool: "form_input",
        args: { tabId: 1, ref: "r1", value: true },
        target: { name: "Remember me", type: "checkbox" },
      }),
    ).toEqual({ tool: "form_input", label: "form_input true" });
  });

  it("names the host a navigation went to", () => {
    expect(describeAction({ tool: "navigate", args: { tabId: 1, url: "https://example.com/a/b?c=d" } })).toEqual({
      tool: "navigate",
      label: "navigate example.com",
    });
  });

  it("names the direction a history navigation took", () => {
    expect(describeAction({ tool: "navigate", args: { tabId: 1, direction: "back" } })).toEqual({
      tool: "navigate",
      label: "navigate back",
    });
  });

  it("names the combination a key press sent", () => {
    expect(describeAction({ tool: "key", args: { tabId: 1, key: "Tab", modifiers: ["Shift"] } })).toEqual({
      tool: "key",
      label: "key Shift+Tab",
    });
  });

  it("says screenshot and nothing else", () => {
    expect(describeAction({ tool: "screenshot", args: { tabId: 1 } })).toEqual({
      tool: "screenshot",
      label: "screenshot",
    });
  });

  it("carries a drag's two ends", () => {
    expect(
      describeAction({
        tool: "drag",
        args: { tabId: 1, from: { ref: "a" }, to: { ref: "b" } },
        from: { x: 5, y: 6 },
        to: { x: 70, y: 80 },
      }),
    ).toEqual({ tool: "drag", label: "drag", from: { x: 5, y: 6 }, to: { x: 70, y: 80 } });
  });

  it("takes a computer action's own point from its arguments", () => {
    expect(describeAction({ tool: "computer", args: { tabId: 1, action: "left_click", x: 300, y: 400 } })).toEqual({
      tool: "computer",
      label: "computer left_click",
      point: { x: 300, y: 400 },
    });
  });

  /**
   * 014/T385 — the size a page was laid out at, on the frame that shows it (FR-196).
   *
   * A recording that jumps from a desktop layout to a phone one with nothing said about it is a
   * film of a page that changed for no reason; the size is the whole action, and a `reset` has no
   * size to name at all - what it did was give the page back its own.
   */
  it("names the size an emulated viewport was set to, and says cleared for a reset", () => {
    expect(describeAction({ tool: "viewport", args: { tabId: 1, action: "set", width: 375, height: 812 } })).toEqual({
      tool: "viewport",
      label: "viewport 375x812",
    });
    expect(describeAction({ tool: "viewport", args: { tabId: 1, action: "reset" } })).toEqual({
      tool: "viewport",
      label: "viewport cleared",
    });
  });

  it("cuts a long label at forty characters with an ellipsis", () => {
    const action = describeAction({
      tool: "click",
      args: { tabId: 1, target: { ref: "r1" } },
      target: { name: "A button whose accessible name goes on and on and on" },
    });

    expect(action.label).toHaveLength(ACTION_LABEL_MAX_CHARS);
    expect(action.label.endsWith("…")).toBe(true);
    expect(action.label.startsWith('click "A button whose')).toBe(true);
  });
});
