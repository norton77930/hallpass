import { describe, expect, it } from "vitest";
import {
  classifyActionRisk,
  classifyClick,
  classifyDrag,
  classifyKeyPress,
  classifyTextEntry,
} from "./action-policy.js";

describe("T063 action policy", () => {
  it("denies anchors, forms, file controls, and sensitive text", () => {
    expect(classifyClick({ tagName: "A", href: "https://example.test" })).toBe("deny");
    expect(classifyClick({ tagName: "BUTTON", type: "submit" })).toBe("deny");
    expect(classifyClick({ tagName: "INPUT", type: "file" })).toBe("deny");
    expect(classifyClick({ tagName: "BUTTON", type: "button" })).toBe("allow");
    expect(classifyTextEntry({ tagName: "INPUT", type: "password", name: "nickname" })).toBe("deny");
    expect(classifyTextEntry({ tagName: "INPUT", type: "text", name: "nickname" })).toBe("allow");
  });

  it("denies text entry into payment and hidden controls at effect time, matching the collection filter", () => {
    for (const autocomplete of [
      "cc-number",
      "section-checkout shipping cc-number",
      "credit-card",
      "card-number",
      "cc-csc",
      "cvc",
      "cvv",
    ]) {
      expect(
        classifyTextEntry({ tagName: "INPUT", type: "text", name: "nickname", autocomplete }),
        autocomplete,
      ).toBe("deny");
    }
    expect(classifyTextEntry({ tagName: "INPUT", type: "hidden", name: "nickname" })).toBe("deny");
    expect(
      classifyTextEntry({ tagName: "INPUT", type: "text", name: "nickname", autocomplete: "nickname" }),
    ).toBe("allow");
  });
});

describe("WP4 effect-time classification follows the closed form-value policy", () => {
  it("refuses text entry into every control the read policy withholds", () => {
    for (const name of ["otp", "cvv", "ssn", "pin", "password", "api-key", "token", "email", "username"]) {
      expect(classifyTextEntry({ tagName: "INPUT", type: "text", name }), name).toBe("deny");
    }
    expect(classifyTextEntry({ tagName: "INPUT", type: "text" }), "unnamed control").toBe("deny");
    expect(classifyTextEntry({ tagName: "INPUT", type: "text", name: "favourite" }), "unlisted name").toBe("deny");
    expect(classifyTextEntry({ tagName: "INPUT", type: "tel", name: "nickname" }), "tel type").toBe("deny");
    expect(classifyTextEntry({ tagName: "INPUT", type: "email", name: "nickname" }), "email type").toBe("deny");
  });

  it("refuses hidden, read-only, disabled, and non-text targets", () => {
    const ordinary = { tagName: "INPUT", type: "text", name: "nickname" };
    expect(classifyTextEntry({ ...ordinary, hidden: true })).toBe("deny");
    expect(classifyTextEntry({ ...ordinary, readOnly: true })).toBe("deny");
    expect(classifyTextEntry({ ...ordinary, disabled: true })).toBe("deny");
    expect(classifyTextEntry({ tagName: "BUTTON", type: "button", name: "nickname" })).toBe("deny");
    expect(classifyTextEntry({ tagName: "DIV" }), "contenteditable region").toBe("deny");
    expect(classifyTextEntry({ tagName: "SELECT", name: "country" })).toBe("deny");
    expect(classifyTextEntry({ type: "text", name: "nickname" }), "no tag name").toBe("deny");
  });

  it("allows ordinary textareas and search fields", () => {
    expect(classifyTextEntry({ tagName: "TEXTAREA", name: "message" })).toBe("allow");
    expect(classifyTextEntry({ tagName: "INPUT", type: "search", name: "query" })).toBe("allow");
  });

  it("denies clicks on submit-like, form-associated, navigating, hidden, and disabled targets", () => {
    expect(classifyClick({ tagName: "INPUT", type: "image" })).toBe("deny");
    expect(classifyClick({ tagName: "BUTTON", type: "button", formAction: "/submit" })).toBe("deny");
    expect(classifyClick({ tagName: "BUTTON", type: "button", formAttr: "checkout" })).toBe("deny");
    expect(classifyClick({ tagName: "BUTTON", type: "button", formTarget: "_blank" })).toBe("deny");
    expect(classifyClick({ tagName: "BUTTON", type: "button", download: "" })).toBe("deny");
    expect(classifyClick({ tagName: "OPTION" })).toBe("deny");
    expect(classifyClick({ tagName: "SELECT" })).toBe("deny");
    expect(classifyClick({ tagName: "LABEL" })).toBe("deny");
    expect(classifyClick({ tagName: "BUTTON", type: "button", hidden: true })).toBe("deny");
    expect(classifyClick({ tagName: "BUTTON", type: "button", disabled: true })).toBe("deny");
    expect(classifyClick({ tagName: "BUTTON" }), "button without an explicit type is a submit button").toBe("deny");
    expect(classifyClick({ tagName: "INPUT", type: "text", name: "nickname" })).toBe("allow");
  });
});

describe("WP2 review-time risk classification", () => {
  it("classifies each capability against the target kind the worker holds", () => {
    expect(classifyActionRisk({ capability: "browser.scroll" })).toBe("view-only");
    expect(classifyActionRisk({ capability: "browser.scroll", targetKind: "button" })).toBe("view-only");
    expect(classifyActionRisk({ capability: "browser.click", targetKind: "button" })).toBe("activation");
    expect(classifyActionRisk({ capability: "browser.enter-text", targetKind: "text-input" })).toBe(
      "text-entry",
    );
  });

  it("reports unclassified rather than a reassuring label when the kind cannot carry the effect", () => {
    expect(classifyActionRisk({ capability: "browser.click", targetKind: "combobox" })).toBe(
      "unclassified",
    );
    expect(classifyActionRisk({ capability: "browser.click", targetKind: "other" })).toBe("unclassified");
    expect(classifyActionRisk({ capability: "browser.click" })).toBe("unclassified");
    expect(classifyActionRisk({ capability: "browser.enter-text", targetKind: "button" })).toBe(
      "unclassified",
    );
    expect(classifyActionRisk({ capability: "browser.enter-text" })).toBe("unclassified");
  });

  /**
   * 002 Phase 2 (T006/T007). Every capability this feature adds must carry a locally decided risk
   * label (002/FR-029), and the seam has to fail closed on the way there: a capability the classifier
   * does not recognise reports `unclassified`, never a reassuring default. Without this, a story that
   * adds a capability and forgets its risk case would show the user a blank or a borrowed label on
   * the card that authorises the effect.
   */
  it("reports unclassified for a capability it does not recognise", () => {
    // Names that look like members but are not: US3 and US4 named theirs `key-press`,
    // `double-click`, and left secondary activation out entirely (FR-025).
    for (const capability of [
      "browser.press-key",
      "browser.double-activate",
      "browser.context-click",
      "browser.right-click",
      "browser.pinch",
      "",
    ]) {
      expect(classifyActionRisk({ capability }), capability).toBe("unclassified");
      expect(classifyActionRisk({ capability, targetKind: "button" }), capability).toBe("unclassified");
    }
  });
});

/**
 * 002 US3 (T043, T044, T045). FR-024: a key press is refused when the focused element is sensitive,
 * when its classification cannot be established, or when the key is outside the named set; and the
 * confirmation key is refused wherever its default effect would submit a form or navigate, or that
 * cannot be locally established (R-022). Everything else in the set rides on the text-entry
 * classification the page read already trusts.
 *
 * These live with the other policy tests rather than in `action-entry.test.ts` as the task list says:
 * that file covers the toolbar entry point, not the action policy.
 */
describe("002 US3 key press policy", () => {
  // Names come from the closed ordinary allow-list the page read already trusts; a key can reach
  // nothing text could not.
  const ordinary = { tagName: "input", type: "text", name: "description" };
  const submitForm = { hasSubmitAffordance: true, implicitSubmissionBlockers: 1 };
  const bareForm = { hasSubmitAffordance: false, implicitSubmissionBlockers: 2 };
  const oneFieldForm = { hasSubmitAffordance: false, implicitSubmissionBlockers: 1 };

  it("lets the confirmation key commit a value where it cannot submit or navigate", () => {
    expect(classifyKeyPress({ ...ordinary, form: null }, "Enter")).toEqual({ decision: "allow" });
    // A textarea's Enter is a newline, whatever form it sits in.
    expect(classifyKeyPress({ tagName: "textarea", name: "message", form: submitForm }, "Enter")).toEqual({
      decision: "allow",
    });
    // No submit button and more than one field that blocks implicit submission: Enter does nothing.
    expect(classifyKeyPress({ ...ordinary, form: bareForm }, "Enter")).toEqual({ decision: "allow" });
  });

  it("refuses the confirmation key where its default effect would submit a form or navigate", () => {
    expect(classifyKeyPress({ ...ordinary, form: submitForm }, "Enter")).toEqual({
      decision: "deny",
      reason: "submission",
    });
    // The single-field form: no submit button, but implicit submission still fires.
    expect(classifyKeyPress({ ...ordinary, form: oneFieldForm }, "Enter")).toEqual({
      decision: "deny",
      reason: "submission",
    });
    expect(classifyKeyPress({ ...ordinary, type: "search", form: submitForm }, "Enter")).toEqual({
      decision: "deny",
      reason: "submission",
    });
  });

  it("refuses the confirmation key when the submission effect cannot be established", () => {
    // No form fact at all - not "no form", but "unknown" - fails closed.
    expect(classifyKeyPress(ordinary, "Enter")).toEqual({ decision: "deny", reason: "submission" });
  });

  it("qualifies only the confirmation key; the rest of the set rides on text-entry classification", () => {
    for (const key of ["Tab", "Escape", "ArrowDown", "Home", "End", "Backspace", "Delete"]) {
      expect(classifyKeyPress({ ...ordinary, form: submitForm }, key), key).toEqual({ decision: "allow" });
    }
    expect(classifyKeyPress({ ...ordinary, form: submitForm }, "Tab", ["Shift"])).toEqual({ decision: "allow" });
  });

  it("refuses any key into a sensitive, unclassifiable, or non-text target", () => {
    expect(classifyKeyPress({ tagName: "input", type: "password", name: "pw", form: null }, "Tab")).toEqual({
      decision: "deny",
      reason: "target",
    });
    expect(
      classifyKeyPress({ tagName: "input", type: "text", name: "card", autocomplete: "cc-number", form: null }, "Escape"),
    ).toEqual({ decision: "deny", reason: "target" });
    // Unnamed: the closed form-value policy cannot classify it, so it fails closed.
    expect(classifyKeyPress({ tagName: "input", type: "text", form: null }, "Tab")).toEqual({
      decision: "deny",
      reason: "target",
    });
    expect(classifyKeyPress({ tagName: "button", type: "button" }, "Enter")).toEqual({
      decision: "deny",
      reason: "target",
    });
    expect(classifyKeyPress({ tagName: "select", name: "colour" }, "ArrowDown")).toEqual({
      decision: "deny",
      reason: "target",
    });
    expect(classifyKeyPress({ ...ordinary, readOnly: true, form: null }, "Tab")).toEqual({
      decision: "deny",
      reason: "target",
    });
  });

  it("refuses a key outside the named set, and a modifier outside the supported combinations", () => {
    expect(classifyKeyPress({ ...ordinary, form: null }, "F5")).toEqual({ decision: "deny", reason: "key" });
    expect(classifyKeyPress({ ...ordinary, form: null }, "")).toEqual({ decision: "deny", reason: "key" });
    expect(classifyKeyPress({ ...ordinary, form: null }, "Enter", ["Shift"])).toEqual({ decision: "deny", reason: "key" });
    expect(classifyKeyPress({ ...ordinary, form: null }, "Tab", ["Control"])).toEqual({ decision: "deny", reason: "key" });
  });

  it("rates a key press as an activation, and unclassified off a text control (R-023)", () => {
    expect(classifyActionRisk({ capability: "browser.key-press", targetKind: "text-input" })).toBe("activation");
    expect(classifyActionRisk({ capability: "browser.key-press", targetKind: "button" })).toBe("unclassified");
    expect(classifyActionRisk({ capability: "browser.key-press", targetKind: "combobox" })).toBe("unclassified");
    expect(classifyActionRisk({ capability: "browser.key-press" })).toBe("unclassified");
  });
});

/**
 * 002 US4 (T055, T056). The gestures ride on the click classification: hover and double activation
 * on their one target, a drag on both of its endpoints, where the stricter decides. Risk labels reuse
 * the closed vocabulary (R-023): hover is view-only, the other two are activations, and any endpoint
 * that cannot be classified makes the whole request unclassified.
 */
describe("002 US4 gesture policy", () => {
  const safeButton = { tagName: "button", type: "button" };
  const link = { tagName: "a", href: "https://example.test/next" };
  const submit = { tagName: "button", type: "submit" };
  const disabled = { tagName: "button", type: "button", disabled: true };

  it("a drag classifies both endpoints and the stricter decides", () => {
    expect(classifyDrag(safeButton, safeButton)).toBe("allow");
    expect(classifyDrag(safeButton, { tagName: "input", type: "text" })).toBe("allow");
    expect(classifyDrag(safeButton, link)).toBe("deny");
    expect(classifyDrag(submit, safeButton)).toBe("deny");
    expect(classifyDrag(safeButton, disabled)).toBe("deny");
  });

  it("refuses a drag when either endpoint cannot be classified", () => {
    expect(classifyDrag({}, safeButton)).toBe("deny");
    expect(classifyDrag(safeButton, {})).toBe("deny");
    expect(classifyDrag({}, {})).toBe("deny");
  });

  it("labels hover view-only and the two activating gestures activation, on a classifiable target", () => {
    expect(classifyActionRisk({ capability: "browser.hover", targetKind: "button" })).toBe("view-only");
    expect(classifyActionRisk({ capability: "browser.double-click", targetKind: "button" })).toBe("activation");
    expect(
      classifyActionRisk({ capability: "browser.drag", targetKind: "button", secondTargetKind: "button" }),
    ).toBe("activation");
    expect(
      classifyActionRisk({ capability: "browser.drag", targetKind: "button", secondTargetKind: "text-input" }),
    ).toBe("activation");
  });

  it("reports unclassified rather than a reassuring label when a target cannot be classified", () => {
    expect(classifyActionRisk({ capability: "browser.hover" })).toBe("unclassified");
    expect(classifyActionRisk({ capability: "browser.hover", targetKind: "other" })).toBe("unclassified");
    expect(classifyActionRisk({ capability: "browser.double-click", targetKind: "combobox" })).toBe("unclassified");
    // A drag needs both endpoints; one alone, or one that cannot be classified, is not enough.
    expect(classifyActionRisk({ capability: "browser.drag", targetKind: "button" })).toBe("unclassified");
    expect(
      classifyActionRisk({ capability: "browser.drag", targetKind: "button", secondTargetKind: "other" }),
    ).toBe("unclassified");
    expect(
      classifyActionRisk({ capability: "browser.drag", targetKind: "other", secondTargetKind: "button" }),
    ).toBe("unclassified");
  });
});
