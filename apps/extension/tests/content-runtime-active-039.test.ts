/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { RUNTIME_PROTOCOL_VERSION } from "@hallpass/contracts";
import { createContentRuntimeContext, handleContentMessage } from "../src/content-runtime/index.js";
import { TEST_NONCE } from "./helpers/content-frames.js";

/**
 * 039/T1089 - `content.resolve-active-element` with a `targetHandle` answers whether focus is on
 * the path a placing click took (FR-568, R-547): the element the ref names, an ancestor of it
 * across shadow roots (the editing host of a contenteditable whose text sits in nested spans), or
 * the control of the nearest `<label>` around it. Anything else is a real miss that says what holds
 * focus. Without a `targetHandle` the answer is the ordinary mint, unchanged.
 */

function frame(type: "content.probe" | "content.resolve-active-element", payload: Record<string, unknown>) {
  return {
    runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    messageId: "message-" + type,
    runtimeEpochId: "epoch-1",
    type,
    taskId: "task-1",
    operationId: "operation-" + type,
    nonce: TEST_NONCE,
    expectedTabId: 1,
    expectedDocumentEpoch: type === "content.probe" ? "probe-unbound" : "doc-1",
    payload,
  };
}

type Reply = {
  ok: boolean;
  reason?: string;
  outcome?: string;
  role?: string;
  label?: string;
  candidates?: Array<{ targetHandle: string }>;
  receivedBy?: { role?: string; label?: string };
};

function setup(target: Element) {
  const context = createContentRuntimeContext({ documentEpoch: "doc-1", canonicalOrigin: "https://example.test" });
  handleContentMessage(frame("content.probe", {}), undefined, context);
  context.registry.issue({
    targetHandle: "tgt-named",
    snapshotId: "snap-1",
    documentEpoch: "doc-1",
    element: target,
    target: { tagName: target.tagName },
  });
  const ask = () =>
    handleContentMessage(
      frame("content.resolve-active-element", { generalPageReadGrantId: "grant-general", targetHandle: "tgt-named" }),
      undefined,
      context,
    ) as Reply;
  return { context, ask };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("content.resolve-active-element with a targetHandle (039/FR-568)", () => {
  it("resolves to the ref when the named element itself holds focus, and names nobody else", () => {
    document.body.innerHTML = '<input type="text" aria-label="Email" />';
    const input = document.querySelector("input") as HTMLInputElement;
    input.focus();
    const { ask } = setup(input);

    const reply = ask();

    expect(reply).toMatchObject({ ok: true, outcome: "resolved", candidates: [{ targetHandle: "tgt-named" }] });
    expect(reply.receivedBy).toBeUndefined();
  });

  it("resolves when focus is on an ancestor of the named element: a contenteditable host, text in nested spans", () => {
    document.body.innerHTML =
      '<div id="editor" contenteditable="true" tabindex="0" aria-label="Notes"><p><span><span id="inner">hello</span></span></p></div>';
    const editor = document.querySelector("#editor") as HTMLElement;
    const inner = document.querySelector("#inner") as HTMLElement;
    editor.focus();
    const { ask } = setup(inner);

    const reply = ask();

    expect(reply).toMatchObject({ ok: true, outcome: "resolved", candidates: [{ targetHandle: "tgt-named" }] });
    // Focus is not on the element named, so the field that holds it is said, by label.
    expect(reply.receivedBy).toMatchObject({ label: "Notes" });
  });

  it("resolves across an open shadow root: the deepest focused element is an ancestor of the named one", () => {
    document.body.innerHTML = "<div id='host'></div>";
    const host = document.querySelector("#host") as HTMLElement;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = '<div id="editor" contenteditable="true" tabindex="0"><span id="inner">hi</span></div>';
    const editor = shadow.querySelector("#editor") as HTMLElement;
    const inner = shadow.querySelector("#inner") as HTMLElement;
    editor.focus();
    // The page's own `document.activeElement` is the host here; the editor is one root down.
    expect(document.activeElement).toBe(host);
    const { ask } = setup(inner);

    const reply = ask();

    expect(reply).toMatchObject({ ok: true, outcome: "resolved", candidates: [{ targetHandle: "tgt-named" }] });
  });

  it("resolves to the ref when focus is on the control of the label the named element sits in", () => {
    document.body.innerHTML =
      '<label for="x"><span id="text">Your name</span></label><input id="x" type="text" aria-label="Full name" />';
    const text = document.querySelector("#text") as HTMLElement;
    const input = document.querySelector("#x") as HTMLInputElement;
    input.focus();
    const { ask } = setup(text);

    const reply = ask();

    expect(reply).toMatchObject({ ok: true, outcome: "resolved", candidates: [{ targetHandle: "tgt-named" }] });
    expect(reply.receivedBy).toMatchObject({ role: "textbox", label: "Full name" });
  });

  it("answers missed, saying what holds focus, when focus is on an unrelated field", () => {
    document.body.innerHTML =
      '<label for="x"><span id="text">Your name</span></label><input id="x" type="text" />' +
      '<input id="other" type="text" aria-label="Coupon code" />';
    const text = document.querySelector("#text") as HTMLElement;
    (document.querySelector("#other") as HTMLInputElement).focus();
    const { ask } = setup(text);

    const reply = ask();

    expect(reply).toMatchObject({ ok: true, outcome: "missed", role: "textbox", label: "Coupon code" });
    expect(reply.candidates).toBeUndefined();
  });

  it("answers missed when nothing holds focus: the body is an ancestor of everything and is not a field", () => {
    document.body.innerHTML = '<p><span id="text">Plain text</span></p>';
    (document.activeElement as HTMLElement | null)?.blur();
    const { ask } = setup(document.querySelector("#text") as HTMLElement);

    expect(ask()).toMatchObject({ ok: true, outcome: "missed" });
  });

  it("answers missed when the label's control is not the one holding focus, even for a wrapping label", () => {
    document.body.innerHTML =
      '<label><span id="text">Inside</span><input id="mine" type="text" /></label><input id="elsewhere" type="text" />';
    (document.querySelector("#elsewhere") as HTMLInputElement).focus();
    const { ask } = setup(document.querySelector("#text") as HTMLElement);

    expect(ask()).toMatchObject({ ok: true, outcome: "missed" });
  });

  it("answers that it could not check, not a miss, when the registry cannot resolve the named handle (041 FR-586)", () => {
    document.body.innerHTML = '<input id="a" type="text" /><input id="b" type="text" />';
    (document.querySelector("#b") as HTMLInputElement).focus();
    const context = createContentRuntimeContext({ documentEpoch: "doc-1", canonicalOrigin: "https://example.test" });
    handleContentMessage(frame("content.probe", {}), undefined, context);

    // No handle was ever issued here: nothing was compared with the focused element.
    const reply = handleContentMessage(
      frame("content.resolve-active-element", { generalPageReadGrantId: "grant-general", targetHandle: "tgt-gone" }),
      undefined,
      context,
    ) as Reply;

    expect(reply).toMatchObject({ ok: false, reason: "stale-target" });
    expect(reply.outcome).toBeUndefined();
  });

  it("still mints the focused element's own handle when no targetHandle is named (003)", () => {
    document.body.innerHTML = '<input id="a" type="text" />';
    (document.querySelector("#a") as HTMLInputElement).focus();
    const context = createContentRuntimeContext({ documentEpoch: "doc-1", canonicalOrigin: "https://example.test" });
    handleContentMessage(frame("content.probe", {}), undefined, context);

    const reply = handleContentMessage(
      frame("content.resolve-active-element", { generalPageReadGrantId: "grant-general" }),
      undefined,
      context,
    ) as Reply;

    expect(reply).toMatchObject({ ok: true, outcome: "resolved" });
    expect(reply.candidates).toHaveLength(1);
  });
});

describe("focus inside a shadow tree or on an editable body (039 review I1, I2)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.removeAttribute("contenteditable");
    document.designMode = "off";
  });

  it("resolves when the ref is an open shadow host and its inner field holds focus (I1)", () => {
    document.body.innerHTML = '<div id="host" role="textbox"></div>';
    const host = document.querySelector("#host") as HTMLElement;
    host.attachShadow({ mode: "open" }).innerHTML = '<input id="inner" />';
    (host.shadowRoot!.querySelector("#inner") as HTMLInputElement).focus();
    const { ask } = setup(host);

    expect(ask()).toMatchObject({ ok: true, outcome: "resolved" });
  });

  it("misses when focus is on another field inside the same shadow tree as a named shadow element (I1 guard)", () => {
    document.body.innerHTML = '<div id="host"></div>';
    const host = document.querySelector("#host") as HTMLElement;
    host.attachShadow({ mode: "open" }).innerHTML = '<input id="a" /><input id="b" />';
    (host.shadowRoot!.querySelector("#b") as HTMLInputElement).focus();
    const { ask } = setup(host.shadowRoot!.querySelector("#a") as HTMLElement);

    expect(ask()).toMatchObject({ ok: true, outcome: "missed" });
  });

  it("resolves when the ref is a light-DOM child of a host whose shadow holds the focused field (I1 slotted)", () => {
    document.body.innerHTML = '<div id="host"><span id="t">label text</span></div>';
    const host = document.querySelector("#host") as HTMLElement;
    host.attachShadow({ mode: "open" }).innerHTML = '<input id="inner" /><slot></slot>';
    (host.shadowRoot!.querySelector("#inner") as HTMLInputElement).focus();
    const { ask } = setup(document.querySelector("#t") as HTMLElement);

    expect(ask()).toMatchObject({ ok: true, outcome: "resolved" });
  });

  it("resolves when the editing host is a contenteditable body and the ref is a paragraph in it (I2a)", () => {
    document.body.setAttribute("contenteditable", "true");
    document.body.innerHTML = '<p id="t">x</p>';
    document.body.focus();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const { ask } = setup(document.querySelector("#t") as HTMLElement);

    expect(ask()).toMatchObject({ ok: true, outcome: "resolved" });
  });

  it("misses when the editable body is only the resting activeElement of a document without focus (re-review I1)", () => {
    document.body.setAttribute("contenteditable", "true");
    document.body.innerHTML = '<p id="t">x</p>';
    document.body.focus();
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const { ask } = setup(document.querySelector("#t") as HTMLElement);

    expect(ask()).toMatchObject({ ok: true, outcome: "missed" });
  });

  it("does not count a contenteditable=false body as an editing host (nit 1)", () => {
    document.body.setAttribute("contenteditable", "false");
    document.body.innerHTML = '<p id="t">x</p>';
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const { ask } = setup(document.querySelector("#t") as HTMLElement);

    expect(ask()).toMatchObject({ ok: true, outcome: "missed" });
  });

  it("counts a body under designMode on as an editing host when the document has focus (nit 1)", () => {
    document.designMode = "on";
    document.body.innerHTML = '<p id="t">x</p>';
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const { ask } = setup(document.querySelector("#t") as HTMLElement);

    expect(ask()).toMatchObject({ ok: true, outcome: "resolved" });
  });

  it("resolves when the ref is the body itself and it holds focus (I2b)", () => {
    document.body.setAttribute("contenteditable", "true");
    document.body.innerHTML = "<p>x</p>";
    document.body.focus();
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const { ask } = setup(document.body);

    expect(ask()).toMatchObject({ ok: true, outcome: "resolved" });
  });

  it("still misses when nothing is focused (the body of an ordinary page) (I2 guard)", () => {
    document.body.innerHTML = '<p id="t">x</p>';
    (document.activeElement as HTMLElement | null)?.blur();
    const { ask } = setup(document.querySelector("#t") as HTMLElement);

    expect(ask()).toMatchObject({ ok: true, outcome: "missed" });
  });
});

describe("a focused host and a target inside its own shadow (039 re-review I2)", () => {
  it("resolves when the focusable host itself holds focus and the ref is inside its shadow", () => {
    document.body.innerHTML = '<div id="host" tabindex="0" aria-label="Widget"></div>';
    const host = document.querySelector("#host") as HTMLElement;
    host.attachShadow({ mode: "open" }).innerHTML = '<span id="inner">x</span>';
    host.focus();
    const { ask } = setup(host.shadowRoot!.querySelector("#inner") as HTMLElement);

    expect(ask()).toMatchObject({ ok: true, outcome: "resolved", receivedBy: { label: "Widget" } });
  });
});

describe("the focus check's real-browser editing-host branch (040 FR-576)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.removeAttribute("contenteditable");
  });

  it("trusts a browser's isContentEditable=false over a contenteditable=\"true\" attribute on the body", () => {
    document.body.setAttribute("contenteditable", "true");
    document.body.innerHTML = '<p id="t">x</p>';
    // A browser answers this itself; jsdom does not, so the boolean path is pinned by a stub.
    Object.defineProperty(document.body, "isContentEditable", { value: false, configurable: true });
    document.body.focus();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const { ask } = setup(document.querySelector("#t") as HTMLElement);

    try {
      expect(ask()).toMatchObject({ ok: true, outcome: "missed" });
    } finally {
      delete (document.body as { isContentEditable?: boolean }).isContentEditable;
    }
  });
});

describe("the receiving-field hint names a field by its label (040 FR-573)", () => {
  it("says the label of a wrapped control that holds focus", () => {
    document.body.innerHTML =
      '<label for="x"><span id="text">Your name</span></label><label>Remember me <input id="other" type="checkbox"></label><input id="x" type="text" />';
    (document.querySelector("#other") as HTMLInputElement).focus();
    const { ask } = setup(document.querySelector("#text") as HTMLElement);

    expect(ask()).toMatchObject({ ok: true, outcome: "missed", role: "checkbox", label: "Remember me" });
  });
});
