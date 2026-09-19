/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { RUNTIME_PROTOCOL_VERSION } from "@hallpass/contracts";
import { createDocumentSink, executeAction, pageSinkFromGlobal } from "../src/content-runtime/actions.js";
import {
  createContentRuntimeContext,
  handleContentMessage,
  type ContentRuntimeContext,
} from "../src/content-runtime/index.js";
import { TargetRegistry } from "../src/content-runtime/targets.js";
import { TEST_NONCE, TEST_COLLECTION_BOUNDS } from "./helpers/content-frames.js";

/**
 * WP4 (review H4/M8/L7, handoff #7): effect-time classification reads the live element and applies
 * the same closed form-value policy as page reading, so a control the read side withholds can never
 * receive text, and a control that turned submit-like, form-associated, hidden, read-only, or
 * disabled after its handle was minted is refused at the effect.
 */
function frame(
  type: "content.probe" | "content.collect-page" | "content.execute-action",
  documentEpoch: string,
  payload: Record<string, unknown>,
) {
  return {
    runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    messageId: "message-" + type + "-" + Math.random().toString(16).slice(2),
    runtimeEpochId: "epoch-1",
    type,
    taskId: "task-1",
    operationId: "operation-" + type + "-" + Math.random().toString(16).slice(2),
    nonce: TEST_NONCE,
    expectedTabId: 7,
    expectedDocumentEpoch: documentEpoch,
    payload,
  };
}

function collectHandle(html: string, label: string): { documentEpoch: string; handle: string } {
  document.body.innerHTML = html;
  const probe = handleContentMessage(frame("content.probe", "probe-unbound", {})) as {
    documentEpoch: string;
  };
  const collected = handleContentMessage(
    frame("content.collect-page", probe.documentEpoch, {
      generalPageReadGrantId: "grant-general-1",
      bounds: TEST_COLLECTION_BOUNDS,
      requestedDataCategories: ["page.visible-text", "page.target-metadata"],
    }),
  ) as { semanticNodes: Array<{ label?: string; targetHandle?: string }> };
  const handle = collected.semanticNodes.find((node) => node.label === label)?.targetHandle;
  expect(handle, label).toBeTruthy();
  return { documentEpoch: probe.documentEpoch, handle: String(handle) };
}

/**
 * A handle for a control the collector would not offer today. The effect-time gate must still
 * refuse it: a handle minted while an element was ordinary outlives the moment the page mutates
 * it, so the refusal cannot rest on the collector having declined to mint one.
 */
function plantedHandle(
  html: string,
  selector: string,
): { documentEpoch: string; handle: string; context: ContentRuntimeContext } {
  document.body.innerHTML = html;
  const context = createContentRuntimeContext({ canonicalOrigin: "https://example.test" });
  handleContentMessage(frame("content.probe", "probe-unbound", {}), undefined, context);
  const element = document.querySelector(selector);
  if (!element) throw new Error("fixture-missing");
  const handle = "tgt-planted-" + Math.random().toString(16).slice(2);
  context.registry.issue({
    targetHandle: handle,
    snapshotId: "snap-planted",
    documentEpoch: context.documentEpoch,
    element,
  });
  return { documentEpoch: context.documentEpoch, handle, context };
}

function enterText(
  documentEpoch: string,
  handle: string,
  context?: ContentRuntimeContext,
): { ok: boolean; reason?: string } {
  return handleContentMessage(
    frame("content.execute-action", documentEpoch, {
      action: "browser.enter-text",
      arguments: { targetHandle: handle, text: "999999", editMode: "replace" },
    }),
    undefined,
    context,
  ) as { ok: boolean; reason?: string };
}

function click(documentEpoch: string, handle: string): { ok: boolean; reason?: string } {
  return handleContentMessage(
    frame("content.execute-action", documentEpoch, {
      action: "browser.click",
      arguments: { targetHandle: handle },
    }),
  ) as { ok: boolean; reason?: string };
}

function inputElement(): HTMLInputElement {
  const element = document.querySelector("input");
  if (!(element instanceof HTMLInputElement)) throw new Error("fixture-missing");
  return element;
}

function buttonElement(): HTMLButtonElement {
  const element = document.querySelector("button");
  if (!(element instanceof HTMLButtonElement)) throw new Error("fixture-missing");
  return element;
}

function documentSink() {
  const sink = pageSinkFromGlobal();
  if (!sink) throw new Error("sink-missing");
  return sink;
}

const SAFE_BUTTON = '<button type="button" aria-label="Safe">Safe</button>';
const NICKNAME = '<input type="text" name="nickname" aria-label="Nickname" value="start" />';

afterEach(() => {
  document.body.innerHTML = "";
});

describe("WP4 effect-time classification against the live element", () => {
  it("refuses text entry into a control the read policy withholds even though it holds a handle", () => {
    const { documentEpoch, handle, context } = plantedHandle(
      '<input type="text" name="otp" aria-label="One-time code" value="123456" />',
      "input",
    );
    expect(enterText(documentEpoch, handle, context)).toMatchObject({ ok: false, reason: "denied" });
    expect(inputElement().value).toBe("123456");
  });

  it("refuses text entry into an unnamed control", () => {
    const { documentEpoch, handle, context } = plantedHandle(
      '<input type="text" aria-label="Mystery" value="keep" />',
      "input",
    );
    expect(enterText(documentEpoch, handle, context)).toMatchObject({ ok: false, reason: "denied" });
    expect(inputElement().value).toBe("keep");
  });

  /**
   * WP8 claim 9: the collector does not advertise a control it could never act on. A handle is an
   * offer, and offering one for a control the closed form-value policy refuses at effect time
   * claims a capability the product does not have.
   */
  it("does not mint a handle for a control the read policy will never allow", () => {
    document.body.innerHTML =
      '<input type="text" name="otp" aria-label="One-time code" value="123456" />' +
      '<input type="text" aria-label="Mystery" value="keep" />' +
      '<input type="email" name="nickname" aria-label="Mail" />' +
      '<input type="tel" name="nickname" aria-label="Phone" />' +
      '<input type="number" name="nickname" aria-label="Count" />' +
      '<textarea name="secret" aria-label="Secret">keep</textarea>' +
      NICKNAME;
    const probe = handleContentMessage(frame("content.probe", "probe-unbound", {})) as {
      documentEpoch: string;
    };
    const collected = handleContentMessage(
      frame("content.collect-page", probe.documentEpoch, {
        generalPageReadGrantId: "grant-general-1",
        bounds: TEST_COLLECTION_BOUNDS,
        requestedDataCategories: ["page.visible-text", "page.target-metadata"],
      }),
    ) as { semanticNodes: Array<{ label?: string; targetHandle?: string }> };
    const handleFor = (label: string) =>
      collected.semanticNodes.find((node) => node.label === label)?.targetHandle;
    for (const label of ["One-time code", "Mystery", "Mail", "Phone", "Count", "Secret"]) {
      expect(handleFor(label), label).toBeUndefined();
    }
    // The ordinary control is still offered, so the filter removes only what would be refused.
    expect(handleFor("Nickname")).toBeTruthy();
  });

  it("refuses text entry after the control became read-only, disabled, or hidden", () => {
    const readOnly = collectHandle(NICKNAME, "Nickname");
    inputElement().readOnly = true;
    expect(enterText(readOnly.documentEpoch, readOnly.handle)).toMatchObject({ ok: false, reason: "denied" });

    const disabled = collectHandle(NICKNAME, "Nickname");
    inputElement().disabled = true;
    expect(enterText(disabled.documentEpoch, disabled.handle)).toMatchObject({ ok: false, reason: "denied" });

    const hidden = collectHandle(NICKNAME, "Nickname");
    inputElement().setAttribute("hidden", "");
    expect(enterText(hidden.documentEpoch, hidden.handle)).toMatchObject({ ok: false, reason: "denied" });

    const ariaHidden = collectHandle(NICKNAME, "Nickname");
    inputElement().setAttribute("aria-hidden", "true");
    expect(enterText(ariaHidden.documentEpoch, ariaHidden.handle)).toMatchObject({ ok: false, reason: "denied" });
    expect(inputElement().value).toBe("start");
  });

  it("refuses text entry into a control the browser reports as not rendered", () => {
    const { documentEpoch, handle } = collectHandle(NICKNAME, "Nickname");
    const input = inputElement() as HTMLInputElement & { checkVisibility?: () => boolean };
    input.checkVisibility = () => false;
    expect(enterText(documentEpoch, handle)).toMatchObject({ ok: false, reason: "denied" });
    expect(input.value).toBe("start");
  });

  it("refuses text entry into a control disabled through an ancestor fieldset", () => {
    const { documentEpoch, handle } = collectHandle(
      '<fieldset><input type="text" name="nickname" aria-label="Nickname" value="start" /></fieldset>',
      "Nickname",
    );
    document.querySelector("fieldset")?.setAttribute("disabled", "");
    expect(enterText(documentEpoch, handle)).toMatchObject({ ok: false, reason: "denied" });
    expect(inputElement().value).toBe("start");
  });

  it("refuses a textarea the policy withholds and accepts an allow-listed one", () => {
    const withheld = plantedHandle('<textarea name="secret" aria-label="Secret">keep</textarea>', "textarea");
    expect(enterText(withheld.documentEpoch, withheld.handle, withheld.context)).toMatchObject({
      ok: false,
      reason: "denied",
    });
    expect(document.querySelector("textarea")?.value).toBe("keep");

    const ordinary = collectHandle('<textarea name="message" aria-label="Message">old</textarea>', "Message");
    expect(enterText(ordinary.documentEpoch, ordinary.handle)).toMatchObject({ ok: true, effect: "text-entered" });
    expect(document.querySelector("textarea")?.value).toBe("999999");
  });

  it("refuses a contenteditable region even when a record points at it", () => {
    document.body.innerHTML = '<div contenteditable="true" id="editor">draft</div>';
    const editor = document.querySelector("#editor");
    if (!(editor instanceof HTMLElement)) throw new Error("fixture-missing");
    const registry = new TargetRegistry();
    registry.issue({ targetHandle: "tgt-editor", snapshotId: "snap-1", documentEpoch: "doc-1", element: editor });
    const result = executeAction(registry, {
      capability: "browser.enter-text",
      documentEpoch: "doc-1",
      targetHandle: "tgt-editor",
      text: "typed",
      sink: documentSink(),
    });
    expect(result).toMatchObject({ ok: false, reason: "denied" });
    expect(editor.textContent).toBe("draft");
  });

  it("still enters text into an ordinary named control", () => {
    const { documentEpoch, handle } = collectHandle(NICKNAME, "Nickname");
    expect(enterText(documentEpoch, handle)).toMatchObject({
      ok: true,
      effect: "text-entered",
      documentChanged: false,
    });
    expect(inputElement().value).toBe("999999");
  });

  it("refuses a click after the control became a submit image, gained a form action, or was disabled", () => {
    const image = collectHandle('<input type="text" name="nickname" aria-label="Nickname" />', "Nickname");
    inputElement().setAttribute("type", "image");
    expect(click(image.documentEpoch, image.handle)).toMatchObject({ ok: false, reason: "denied" });

    const formAction = collectHandle(SAFE_BUTTON, "Safe");
    buttonElement().setAttribute("formaction", "/submit");
    expect(click(formAction.documentEpoch, formAction.handle)).toMatchObject({ ok: false, reason: "denied" });

    const disabled = collectHandle(SAFE_BUTTON, "Safe");
    buttonElement().disabled = true;
    expect(click(disabled.documentEpoch, disabled.handle)).toMatchObject({ ok: false, reason: "denied" });

    const untouched = collectHandle(SAFE_BUTTON, "Safe");
    expect(click(untouched.documentEpoch, untouched.handle)).toMatchObject({ ok: true, effect: "activated" });
  });

  it("refuses a click after a form association, target, download, or aria-hidden appears, or the browser reports it not rendered", () => {
    for (const [attribute, value] of [
      ["form", "checkout"],
      ["formtarget", "_blank"],
      ["target", "_blank"],
      ["download", ""],
      ["aria-hidden", "true"],
    ] as const) {
      const { documentEpoch, handle } = collectHandle(SAFE_BUTTON, "Safe");
      buttonElement().setAttribute(attribute, value);
      expect(click(documentEpoch, handle), attribute).toMatchObject({ ok: false, reason: "denied" });
    }
    const { documentEpoch, handle } = collectHandle(SAFE_BUTTON, "Safe");
    const button = buttonElement() as HTMLButtonElement & { checkVisibility?: () => boolean };
    button.checkVisibility = () => false;
    expect(click(documentEpoch, handle), "not rendered").toMatchObject({ ok: false, reason: "denied" });
  });
});

/**
 * 003/B8 — the pointer gestures agree about what a target is.
 *
 * `tripleClick` and `doubleClick` refuse an element they cannot activate; `rightClick` did not, so
 * a node that is only an event target got a full press/release/contextmenu sequence its two
 * neighbours would have refused. The gestures differ in what they *send*, not in what counts as a
 * control.
 */
describe("B8 the right-click gesture applies the same target check its neighbours do", () => {
  it("refuses an element it could not activate", () => {
    const sink = createDocumentSink({ window: {}, document: { documentElement: { scrollTop: 0 } } });
    const dispatched: string[] = [];
    // An event target with no activation behaviour of its own: `dispatchEvent` but no `click`.
    const notAControl = {
      isConnected: true,
      dispatchEvent(event: { type?: string }) {
        dispatched.push(event.type ?? "");
        return true;
      },
    };
    const record = (element: object) =>
      ({ targetHandle: "tgt", snapshotId: "snap-1", documentEpoch: "doc-1", element }) as unknown as Parameters<
        typeof sink.rightClick
      >[0];

    expect(sink.rightClick(record(notAControl))).toEqual({ ok: false, clicks: 0 });
    expect(sink.tripleClick(record(notAControl))).toEqual({ ok: false, clicks: 0 });
    // Nothing was delivered: a refusal that had already fired `contextmenu` would be a refusal in
    // name only.
    expect(dispatched).toEqual([]);
  });
});

describe("WP4 the document sink refuses non-text and non-writable controls on its own", () => {
  it("does not write into a button or a read-only input even when asked directly", () => {
    document.body.innerHTML =
      '<button type="button" value="keep">Go</button><input type="text" name="nickname" value="start" readonly />';
    const button = buttonElement();
    const input = inputElement();
    const sink = documentSink();
    const record = (element: unknown) => ({
      targetHandle: "tgt",
      snapshotId: "snap-1",
      documentEpoch: "doc-1",
      element,
    });
    expect(sink.enterText(record(button), "typed", "replace")).toEqual({ ok: false, charactersChanged: 0 });
    expect(button.value).toBe("keep");
    expect(sink.enterText(record(input), "typed", "replace")).toEqual({ ok: false, charactersChanged: 0 });
    expect(input.value).toBe("start");
    input.readOnly = false;
    expect(sink.enterText(record(input), "typed", "replace")).toEqual({ ok: true, charactersChanged: 5 });
    expect(input.value).toBe("typed");
  });
});

/**
 * 002 US3 (T046). A key press is delivered to the focused control as keyboard events and verified by
 * the focused element keeping its identity (R-026). Synthetic events do not trigger the browser's
 * default actions - no implicit submission, no focus move - which is the point: the page's own
 * handlers run, the document does not. The submission guard is applied to the live element, so a
 * search box inside a form with a submit button refuses the confirmation key before any event is
 * dispatched.
 */
describe("002 US3 a key press reaches the focused control and nothing else", () => {
  // Field names are drawn from the closed ordinary allow-list (form-value policy): the keyboard can
  // reach no control that text entry could not.
  const TAG_FIELD = '<input type="text" name="description" aria-label="Tag" value="alpha" />';
  const SEARCH_FORM =
    '<form><input type="search" name="query" aria-label="Search" value="cats" /><button type="submit">Go</button></form>';
  const BARE_FORM =
    '<form><input type="text" name="nickname" aria-label="First" /><input type="text" name="message" aria-label="Second" /></form>';

  function pressKey(
    documentEpoch: string,
    handle: string,
    key: string,
    modifiers?: string[],
    context?: ContentRuntimeContext,
  ): Record<string, unknown> {
    return handleContentMessage(
      frame("content.execute-action", documentEpoch, {
        action: "browser.key-press",
        arguments: { targetHandle: handle, key, ...(modifiers ? { modifiers } : {}) },
      }),
      undefined,
      context,
    ) as Record<string, unknown>;
  }

  it("delivers the confirmation key to a tag field outside any form and verifies focus stayed", () => {
    const { documentEpoch, handle } = collectHandle(TAG_FIELD, "Tag");
    const input = inputElement();
    const seen: string[] = [];
    input.addEventListener("keydown", (event) => {
      seen.push((event as KeyboardEvent).key);
      // The page's own tag widget: commit the value and clear the field.
      input.value = "";
    });
    const result = pressKey(documentEpoch, handle, "Enter");
    expect(result).toEqual({
      ok: true,
      effect: "key-pressed",
      key: "Enter",
      focusRetained: true,
      valueEchoed: false,
      documentChanged: false,
    });
    expect(seen).toEqual(["Enter"]);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("");
  });

  it("delivers Shift+Tab with the modifier set and no default focus move", () => {
    const { documentEpoch, handle } = collectHandle(TAG_FIELD, "Tag");
    const input = inputElement();
    const seen: Array<{ key: string; shift: boolean }> = [];
    input.addEventListener("keydown", (event) => {
      const keyboard = event as KeyboardEvent;
      seen.push({ key: keyboard.key, shift: keyboard.shiftKey });
    });
    const result = pressKey(documentEpoch, handle, "Tab", ["Shift"]);
    expect(result).toMatchObject({ ok: true, effect: "key-pressed", key: "Tab", focusRetained: true });
    expect(seen).toEqual([{ key: "Tab", shift: true }]);
  });

  it("refuses the confirmation key in a search box whose form would submit, before any event", () => {
    const { documentEpoch, handle } = collectHandle(SEARCH_FORM, "Search");
    const input = inputElement();
    let events = 0;
    input.addEventListener("keydown", () => {
      events += 1;
    });
    expect(pressKey(documentEpoch, handle, "Enter")).toEqual({ ok: false, reason: "submission-guard" });
    expect(events).toBe(0);
    expect(input.value).toBe("cats");
    // The other keys are not qualified: Escape in the same box is delivered.
    expect(pressKey(documentEpoch, handle, "Escape")).toMatchObject({ ok: true, key: "Escape", focusRetained: true });
  });

  it("allows the confirmation key in a form with no submit button and more than one text field", () => {
    const { documentEpoch, handle } = collectHandle(BARE_FORM, "First");
    expect(pressKey(documentEpoch, handle, "Enter")).toMatchObject({ ok: true, key: "Enter", focusRetained: true });
  });

  it("refuses the confirmation key in a single-field form, where implicit submission still fires", () => {
    const { documentEpoch, handle } = collectHandle(
      '<form><input type="text" name="notes" aria-label="Only" /></form>',
      "Only",
    );
    expect(pressKey(documentEpoch, handle, "Enter")).toEqual({ ok: false, reason: "submission-guard" });
  });

  it("refuses the confirmation key where a submit image outside the form is associated with it", () => {
    // An image button is not listed in `form.elements`, and one placed outside the form and tied to
    // it with the `form` attribute is not a descendant either. It still submits the form, so the
    // guard has to find it through its owner form, not through the form's subtree.
    const { documentEpoch, handle } = collectHandle(
      '<form id="owner">' +
        '<input type="text" name="nickname" aria-label="First" />' +
        '<input type="text" name="message" aria-label="Second" />' +
        "</form>" +
        '<input type="image" form="owner" alt="Go" src="go.png" />',
      "First",
    );
    expect(pressKey(documentEpoch, handle, "Enter")).toEqual({ ok: false, reason: "submission-guard" });
  });

  it("refuses any key into a control the read policy withholds, even with a planted handle", () => {
    const { documentEpoch, handle, context } = plantedHandle(
      '<input type="password" name="pw" aria-label="Password" />',
      "input",
    );
    expect(pressKey(documentEpoch, handle, "Tab", undefined, context)).toEqual({ ok: false, reason: "denied" });
  });

  it("reports a key whose handler moved focus as delivered but unverified", () => {
    const { documentEpoch, handle } = collectHandle(
      TAG_FIELD + '<input type="text" name="website" aria-label="Other" />',
      "Tag",
    );
    const inputs = document.querySelectorAll("input");
    const tag = inputs[0] as HTMLInputElement;
    const other = inputs[1] as HTMLInputElement;
    tag.addEventListener("keydown", () => other.focus());
    const result = pressKey(documentEpoch, handle, "Enter");
    // Delivered - the handler ran - but the focused element is no longer the one the key went to,
    // so the evidence R-026 asks for is missing and the worker will report it as uncertain.
    expect(result).toMatchObject({ ok: true, effect: "key-pressed", key: "Enter", focusRetained: false });
    expect(document.activeElement).toBe(other);
  });
});

/**
 * 002 US4 (T057 and the delivery of each gesture). A gesture is delivered as the events a page's own
 * handlers listen for - pointer and mouse events for a hover, two activations and a dblclick for a
 * double activation, the HTML drag-and-drop sequence for a drag - and verified by evidence the page
 * cannot fake: the hovered target is still shown, the activation count rose by two, the dragged
 * element's position changed. A document that changes mid-gesture ends the gesture and is reported as
 * changed, never as success. Every endpoint passes the click classification on the live element first.
 */
describe("002 US4 gestures reach their targets and nothing else", () => {
  function collectHandles(html: string, labels: string[]): { documentEpoch: string; handles: Record<string, string> } {
    document.body.innerHTML = html;
    const probe = handleContentMessage(frame("content.probe", "probe-unbound", {})) as { documentEpoch: string };
    const collected = handleContentMessage(
      frame("content.collect-page", probe.documentEpoch, {
        generalPageReadGrantId: "grant-general-1",
        bounds: TEST_COLLECTION_BOUNDS,
        requestedDataCategories: ["page.visible-text", "page.target-metadata"],
      }),
    ) as { semanticNodes: Array<{ label?: string; targetHandle?: string }> };
    const handles: Record<string, string> = {};
    for (const label of labels) {
      const handle = collected.semanticNodes.find((node) => node.label === label)?.targetHandle;
      expect(handle, label).toBeTruthy();
      handles[label] = String(handle);
    }
    return { documentEpoch: probe.documentEpoch, handles };
  }

  function gesture(
    action: string,
    documentEpoch: string,
    args: Record<string, unknown>,
    context?: ContentRuntimeContext,
  ): Record<string, unknown> {
    return handleContentMessage(
      frame("content.execute-action", documentEpoch, { action, arguments: args }),
      undefined,
      context,
    ) as Record<string, unknown>;
  }

  const button = (label: string, extra = "") =>
    `<button type="button" aria-label="${label}"${extra ? " " + extra : ""}>${label}</button>`;

  it("hovers a target with the pointer and mouse events its handlers listen for, and verifies it is still shown", () => {
    const { documentEpoch, handles } = collectHandles(
      button("Menu") + '<div id="items" class="closed">' + button("Open settings") + "</div>",
      ["Menu", "Open settings"],
    );
    const menu = document.querySelector('[aria-label="Menu"]') as HTMLButtonElement;
    const seen: string[] = [];
    for (const type of ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"]) {
      menu.addEventListener(type, () => {
        seen.push(type);
        document.getElementById("items")?.classList.remove("closed");
      });
    }
    const result = gesture("browser.hover", documentEpoch, { targetHandle: handles.Menu });
    expect(result).toEqual({ ok: true, effect: "hovered", targetVisible: true, documentChanged: false });
    expect(seen).toEqual(["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"]);
    expect(document.getElementById("items")?.classList.contains("closed")).toBe(false);
  });

  it("reports a hovered target that its own handler hid as delivered but unverified", () => {
    const { documentEpoch, handles } = collectHandles(button("Vanishing"), ["Vanishing"]);
    const target = document.querySelector("button") as HTMLButtonElement;
    target.addEventListener("pointerenter", () => target.setAttribute("hidden", ""));
    expect(gesture("browser.hover", documentEpoch, { targetHandle: handles.Vanishing })).toMatchObject({
      ok: true,
      effect: "hovered",
      targetVisible: false,
    });
  });

  it("refuses to hover a target the click classification refuses, before any event", () => {
    const { documentEpoch, handle, context } = plantedHandle('<a href="/next" aria-label="Next">Next</a>', "a");
    let events = 0;
    document.querySelector("a")?.addEventListener("pointerenter", () => {
      events += 1;
    });
    expect(gesture("browser.hover", documentEpoch, { targetHandle: handle }, context)).toEqual({ ok: false, reason: "denied" });
    expect(events).toBe(0);
  });

  it("double activates a control: two activations its handlers count, then the dblclick they listen for", () => {
    const { documentEpoch, handles } = collectHandles(button("Open"), ["Open"]);
    const target = document.querySelector("button") as HTMLButtonElement;
    let clicks = 0;
    let doubles = 0;
    target.addEventListener("click", () => {
      clicks += 1;
    });
    target.addEventListener("dblclick", (event) => {
      doubles += 1;
      expect((event as MouseEvent).detail).toBe(2);
    });
    expect(gesture("browser.double-click", documentEpoch, { targetHandle: handles.Open })).toEqual({
      ok: true,
      effect: "double-activated",
      clicks: 2,
      documentChanged: false,
    });
    expect(clicks).toBe(2);
    expect(doubles).toBe(1);
  });

  it("refuses a double activation of a control the click classification refuses", () => {
    const { documentEpoch, handle, context } = plantedHandle('<button type="submit" aria-label="Send">Send</button>', "button");
    expect(gesture("browser.double-click", documentEpoch, { targetHandle: handle }, context)).toEqual({
      ok: false,
      reason: "denied",
    });
  });

  const LIST =
    '<ul id="list">' +
    '<li id="alpha">' + button("Alpha", 'draggable="true"') + "</li>" +
    '<li id="beta">' + button("Beta", 'draggable="true"') + "</li>" +
    '<li id="gamma">' + button("Gamma", 'draggable="true" disabled') + "</li>" +
    "</ul>";

  function reorderOnDrop(options: { acceptDrag?: boolean } = {}) {
    // The page's own reordering: dropping on an item moves the dragged item's row after it. In the
    // browser's model a drop only happens where `dragover` was cancelled - that is how a page says
    // it accepts the drag - so the fixture cancels it unless a test says otherwise.
    let dragged: HTMLElement | undefined;
    for (const item of Array.from(document.querySelectorAll("#list button"))) {
      item.addEventListener("dragstart", () => {
        dragged = item.closest("li") as HTMLElement;
      });
      if (options.acceptDrag !== false) {
        item.addEventListener("dragover", (event) => event.preventDefault());
      }
      item.addEventListener("drop", () => {
        const row = item.closest("li");
        if (dragged && row && row !== dragged) row.after(dragged);
      });
    }
  }

  it("drags one target onto another with the drag-and-drop sequence and verifies the element moved", () => {
    const { documentEpoch, handles } = collectHandles(LIST, ["Alpha", "Beta"]);
    reorderOnDrop();
    const types: string[] = [];
    document.getElementById("list")?.addEventListener("dragstart", (e) => types.push("dragstart@" + (e.target as HTMLElement).getAttribute("aria-label")));
    for (const type of ["dragenter", "dragover", "drop"]) {
      document.getElementById("list")?.addEventListener(type, (e) => types.push(type + "@" + (e.target as HTMLElement).getAttribute("aria-label")));
    }
    document.getElementById("list")?.addEventListener("dragend", (e) => types.push("dragend@" + (e.target as HTMLElement).getAttribute("aria-label")));

    expect(
      gesture("browser.drag", documentEpoch, { targetHandle: handles.Alpha, dropTargetHandle: handles.Beta }),
    ).toEqual({ ok: true, effect: "dragged", moved: true, documentChanged: false });
    expect(types).toEqual(["dragstart@Alpha", "dragenter@Beta", "dragover@Beta", "drop@Beta", "dragend@Alpha"]);
    expect(Array.from(document.querySelectorAll("#list li")).map((li) => li.id)).toEqual(["beta", "alpha", "gamma"]);
  });

  it("delivers no drop where the page did not accept the drag, and reports nothing moved", () => {
    // The drop handler would reorder, but the page never cancelled `dragover`: in a browser that
    // means no drop fires, and the product must not fire one either.
    const { documentEpoch, handles } = collectHandles(LIST, ["Alpha", "Beta"]);
    reorderOnDrop({ acceptDrag: false });
    let drops = 0;
    const leaves: string[] = [];
    document.getElementById("list")?.addEventListener("drop", () => {
      drops += 1;
    });
    document.getElementById("list")?.addEventListener("dragleave", (event) => {
      leaves.push((event.target as HTMLElement).getAttribute("aria-label") ?? "?");
    });
    expect(
      gesture("browser.drag", documentEpoch, { targetHandle: handles.Alpha, dropTargetHandle: handles.Beta }),
    ).toEqual({ ok: true, effect: "dragged", moved: false, documentChanged: false });
    expect(drops).toBe(0);
    // As in the browser, a drag that resolves to nothing leaves the target it entered, so a page
    // that highlights on `dragenter` gets the `dragleave` that clears it.
    expect(leaves).toEqual(["Beta"]);
    expect(Array.from(document.querySelectorAll("#list li")).map((li) => li.id)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("does not mistake a scroll that moved both endpoints for a move, but sees a relative move", () => {
    const sink = createDocumentSink({ window: {}, document: { documentElement: { scrollTop: 0 } } });
    const rect = (top: number, left: number) => ({ top, left, width: 20, height: 20, bottom: top + 20, right: left + 20 });
    let scroll = 0;
    let sourceShift = 0;
    const fake = (own: () => ReturnType<typeof rect>, onDragover?: () => void) => ({
      isConnected: true,
      compareDocumentPosition: () => 4,
      getBoundingClientRect: own,
      dispatchEvent(event: { type?: string }) {
        if (event.type === "dragover") {
          onDragover?.();
          return false; // cancelled: the page accepts the drag
        }
        return true;
      },
    });
    const record = (element: object, targetHandle: string) =>
      ({ targetHandle, snapshotId: "snap-1", documentEpoch: "doc-1", element }) as unknown as Parameters<typeof sink.drag>[0];
    const source = fake(() => rect(10 + scroll + sourceShift, 10));
    const drop = fake(() => rect(100 + scroll, 10), () => {
      scroll = 40; // an autoscroll while dragging: both endpoints shift together
    });
    expect(sink.drag(record(source, "s"), record(drop, "d"), () => false)).toEqual({
      ok: true,
      moved: false,
      documentChanged: false,
    });

    scroll = 0;
    const dropThatMovesSource = fake(() => rect(100 + scroll, 10), () => {
      sourceShift = 95; // the page moved the dragged element itself
    });
    expect(sink.drag(record(source, "s"), record(dropThatMovesSource, "d"), () => false)).toEqual({
      ok: true,
      moved: true,
      documentChanged: false,
    });
  });

  it("reports a drag the page ignored as delivered but unverified", () => {
    const { documentEpoch, handles } = collectHandles(LIST, ["Alpha", "Beta"]);
    expect(
      gesture("browser.drag", documentEpoch, { targetHandle: handles.Alpha, dropTargetHandle: handles.Beta }),
    ).toEqual({ ok: true, effect: "dragged", moved: false, documentChanged: false });
    expect(Array.from(document.querySelectorAll("#list li")).map((li) => li.id)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("refuses a drag when either endpoint fails the click classification, before any event", () => {
    const { documentEpoch, handles } = collectHandles(LIST, ["Alpha", "Beta", "Gamma"]);
    let events = 0;
    document.getElementById("list")?.addEventListener("dragstart", () => {
      events += 1;
    });
    // The drop target is disabled: the stricter endpoint decides.
    expect(
      gesture("browser.drag", documentEpoch, { targetHandle: handles.Alpha, dropTargetHandle: handles.Gamma }),
    ).toEqual({ ok: false, reason: "denied" });
    expect(
      gesture("browser.drag", documentEpoch, { targetHandle: handles.Gamma, dropTargetHandle: handles.Beta }),
    ).toEqual({ ok: false, reason: "denied" });
    // An endpoint the registry never issued cannot be classified at all.
    expect(
      gesture("browser.drag", documentEpoch, { targetHandle: handles.Alpha, dropTargetHandle: "tgt-nowhere" }),
    ).toEqual({ ok: false, reason: "stale-target" });
    expect(events).toBe(0);
  });

  it("ends a drag whose document changes mid-gesture and reports the change, never success (T057)", () => {
    const { documentEpoch, handles } = collectHandles(LIST, ["Alpha", "Beta"]);
    reorderOnDrop();
    let drops = 0;
    document.getElementById("list")?.addEventListener("drop", () => {
      drops += 1;
    });
    // The page navigates within the document while the pointer is over the drop target.
    document.querySelector('[aria-label="Beta"]')?.addEventListener("dragover", () => {
      history.pushState({}, "", "/reordered");
    });
    const result = gesture("browser.drag", documentEpoch, { targetHandle: handles.Alpha, dropTargetHandle: handles.Beta });
    expect(result).toMatchObject({ ok: true, effect: "dragged", moved: false, documentChanged: true });
    // The drop was never delivered: the gesture stopped where the document changed.
    expect(drops).toBe(0);
    expect(Array.from(document.querySelectorAll("#list li")).map((li) => li.id)).toEqual(["alpha", "beta", "gamma"]);
    history.replaceState({}, "", "/");
  });
});
