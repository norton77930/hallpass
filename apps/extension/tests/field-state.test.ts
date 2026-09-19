/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from "vitest";
import { fieldState, isRedactedField } from "../src/content-runtime/field-state.js";

/**
 * 005/T170 - what a field holds, as the owner sees it (US1, FR-072..FR-074, R-122).
 *
 * The rules are the reference's, designed as our own predicate (evidence 004 §3d): a text entry
 * carries its live value, a select the text of what it shows, a toggle whether it is on; a
 * password, a hidden input, or anything whose autocomplete names a secret is *redacted* - its value
 * is consulted for emptiness only and never carried, which is why the predicate is a separate
 * export the collector asks first. An empty field says nothing, so a form the owner has not touched
 * reads the way it did before this slice.
 */

const BOUND = 16;

function first<T extends Element>(html: string): T {
  document.body.innerHTML = html;
  return document.body.firstElementChild as T;
}

describe("T170 isRedactedField", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it.each([
    ['<input type="password">', true],
    ['<input type="hidden">', true],
    ['<input type="PASSWORD">', true],
    ['<input type="text" autocomplete="current-password">', true],
    ['<input type="text" autocomplete="new-password">', true],
    ['<input type="text" autocomplete="one-time-code">', true],
    ['<input type="text" autocomplete="cc-number">', true],
    ['<input type="text" autocomplete="cc-csc">', true],
    ['<input type="text" autocomplete="cc-exp">', true],
    ['<input type="text" autocomplete="cc-exp-month">', true],
    ['<input type="text" autocomplete="cc-exp-year">', true],
    // Token match inside the browser's space-separated list, whatever the case.
    ['<input type="text" autocomplete="section-billing CC-Number">', true],
    ['<input type="text" autocomplete="shipping cc-name">', false],
    ['<input type="text" autocomplete="username">', false],
    ['<input type="email">', false],
    ["<textarea></textarea>", false],
    ['<select autocomplete="cc-exp-month"></select>', true],
    ['<button type="password">x</button>', false],
  ])("%s -> %s", (html, expected) => {
    expect(isRedactedField(first(html))).toBe(expected);
  });
});

describe("T170 fieldState", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("carries a text input's live value, not its markup default", () => {
    const input = first<HTMLInputElement>('<input type="text" value="stale">');
    input.value = "Ada";
    expect(fieldState(input, BOUND)).toEqual({ value: "Ada" });
  });

  it("carries an email input's value, and nothing for an empty one", () => {
    const filled = first<HTMLInputElement>('<input type="email">');
    filled.value = "ada@example.test";
    expect(fieldState(filled, BOUND)).toEqual({ value: "ada@example.test" });
    expect(fieldState(first('<input type="email">'), BOUND)).toEqual({});
  });

  it("keeps a textarea's line breaks", () => {
    const area = first<HTMLTextAreaElement>("<textarea></textarea>");
    area.value = "one\ntwo";
    expect(fieldState(area, BOUND)).toEqual({ value: "one\ntwo" });
  });

  it("names a select's shown option by its text, and a multiple select's by every selected text", () => {
    const single = first<HTMLSelectElement>(
      '<select><option value="s">Small</option><option value="l" selected>Large</option></select>',
    );
    expect(fieldState(single, BOUND)).toEqual({ value: "Large" });
    const multiple = first<HTMLSelectElement>(
      "<select multiple><option selected>Red</option><option>Green</option><option selected>Blue</option></select>",
    );
    expect(fieldState(multiple, BOUND)).toEqual({ value: "Red, Blue" });
    // A select with nothing chosen is an empty field.
    const none = first<HTMLSelectElement>("<select multiple><option>Red</option></select>");
    expect(fieldState(none, BOUND)).toEqual({});
  });

  it("reports a toggle as checked or not, never with a value", () => {
    const on = first<HTMLInputElement>('<input type="checkbox" value="yes" checked>');
    const off = first<HTMLInputElement>('<input type="checkbox" value="yes">');
    const radio = first<HTMLInputElement>('<input type="radio" value="large" checked>');
    expect(fieldState(on, BOUND)).toEqual({ checked: true });
    expect(fieldState(off, BOUND)).toEqual({ checked: false });
    expect(fieldState(radio, BOUND)).toEqual({ checked: true });
  });

  it("redacts a filled password or card number and says nothing for an empty one", () => {
    const password = first<HTMLInputElement>('<input type="password">');
    password.value = "hunter2";
    expect(fieldState(password, BOUND)).toEqual({ redacted: true });
    const card = first<HTMLInputElement>('<input type="text" autocomplete="cc-number">');
    card.value = "4111 1111 1111 1111";
    expect(fieldState(card, BOUND)).toEqual({ redacted: true });
    expect(fieldState(first('<input type="password">'), BOUND)).toEqual({});
  });

  it("carries no trace of a redacted field's value, however long it is", () => {
    const password = first<HTMLInputElement>('<input type="password">');
    password.value = "hunter2".repeat(BOUND);
    const state = fieldState(password, BOUND);
    expect(JSON.stringify(state)).not.toContain("hunter2");
    // A redacted field is not a cut field: nothing was carried, so nothing was truncated.
    expect(state).toEqual({ redacted: true });
  });

  it("cuts a long value at the bound and says so", () => {
    const input = first<HTMLInputElement>('<input type="text">');
    input.value = "x".repeat(BOUND + 5);
    expect(fieldState(input, BOUND)).toEqual({ value: "x".repeat(BOUND), valueTruncated: true });
    input.value = "x".repeat(BOUND);
    expect(fieldState(input, BOUND)).toEqual({ value: "x".repeat(BOUND) });
  });

  it("says nothing for an element that is not a field", () => {
    expect(fieldState(first("<button>Save</button>"), BOUND)).toEqual({});
    expect(fieldState(first('<div contenteditable="true">text</div>'), BOUND)).toEqual({});
    expect(fieldState(first('<input type="submit" value="Go">'), BOUND)).toEqual({});
    expect(fieldState(first('<input type="button" value="Go">'), BOUND)).toEqual({});
    expect(fieldState(first('<input type="file">'), BOUND)).toEqual({});
    expect(fieldState(undefined, BOUND)).toEqual({});
  });
});
