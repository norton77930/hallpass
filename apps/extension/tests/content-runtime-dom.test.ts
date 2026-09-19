/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { RUNTIME_PROTOCOL_VERSION } from "@hallpass/contracts";
import { executeAction, pageSinkFromGlobal } from "../src/content-runtime/actions.js";
import {
  bindContentRuntime,
  createContentRuntimeContext,
  handleContentMessage,
} from "../src/content-runtime/index.js";
import { TargetRegistry } from "../src/content-runtime/targets.js";
import { TEST_NONCE, TEST_COLLECTION_BOUNDS } from "./helpers/content-frames.js";

function frame(
  type:
    | "content.probe"
    | "content.collect-page"
    | "content.execute-action"
    | "content.set-files"
    | "content.resolve-point",
  payload: Record<string, unknown>,
) {
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

afterEach(() => {
  document.body.innerHTML = "";
  document.documentElement.scrollTop = 0;
});

describe("content-runtime document/window effects", () => {
  it("refuses success when no sink applied an effect", () => {
    const registry = new TargetRegistry();
    expect(executeAction(registry, { capability: "browser.scroll", documentEpoch: "doc-1" }).ok).toBe(false);
  });

  it("bindContentRuntime mutates an injected document scrollTop, click count, and input.value", () => {
    document.body.innerHTML = '<button type="button">Go</button><input type="text" name="nickname" value="start" />';
    const button = document.querySelector("button");
    const input = document.querySelector("input");
    if (!(button instanceof HTMLButtonElement) || !(input instanceof HTMLInputElement)) throw new Error("fixture-missing");
    let clicks = 0;
    button.addEventListener("click", () => {
      clicks += 1;
    });
    const context = createContentRuntimeContext({ documentEpoch: "doc-1", canonicalOrigin: "https://example.test" });
    let handler: ((message: unknown) => unknown) | undefined;
    bindContentRuntime((subscribe) => {
      handler = subscribe;
    }, undefined, context);
    if (!handler) throw new Error("runtime-not-bound");
    handler(frame("content.probe", {}));
    context.registry.issue({
      targetHandle: "tgt-click",
      snapshotId: "snap-1",
      documentEpoch: "doc-1",
      element: button,
      target: { tagName: "BUTTON", type: "button" },
    });
    context.registry.issue({
      targetHandle: "tgt-text",
      snapshotId: "snap-1",
      documentEpoch: "doc-1",
      element: input,
      target: { tagName: "INPUT", type: "text" },
    });
    expect(handler(frame("content.execute-action", {
      action: "browser.scroll",
      arguments: { mode: "viewport", direction: "down", magnitude: "small" },
    }))).toMatchObject({ ok: true, scrollTop: 80 });
    expect(document.documentElement.scrollTop).toBe(80);

    expect(handler(frame("content.execute-action", {
      action: "browser.click",
      arguments: { targetHandle: "tgt-click" },
    }))).toMatchObject({ ok: true, clicks: 1 });
    expect(clicks).toBe(1);

    const typed = handler(frame("content.execute-action", {
      action: "browser.enter-text",
      arguments: { targetHandle: "tgt-text", text: "-more", editMode: "insert" },
    })) as Record<string, unknown>;
    expect(typed).toMatchObject({ ok: true, charactersChanged: 5, valueEchoed: false });
    expect(typed).not.toHaveProperty("value");
    expect(input.value).toBe("start-more");
  });

  it("collects visible text and discloses only ordinary form values under the separate grant", () => {
    document.body.innerHTML =
      '<p>Hello visible page</p><input type="text" name="nickname" value="Ada" />' +
      '<input type="password" name="secret" value="s3cret" />';
    const context = createContentRuntimeContext({ documentEpoch: "doc-1", canonicalOrigin: "https://example.test" });
    handleContentMessage(frame("content.probe", {}), undefined, context);
    const result = handleContentMessage(
      frame("content.collect-page", {
        generalPageReadGrantId: "grant-general",
        bounds: TEST_COLLECTION_BOUNDS,
        formValuesGrantId: "grant-form",
        requestedDataCategories: ["page.visible-text", "page.form-values"],
      }),
      undefined,
      context,
    ) as { visibleText?: string; formValueItems: Array<{ classification: string; value?: string; controlId: string }> };
    expect(result.visibleText).toContain("Hello visible page");
    expect(JSON.stringify(result)).not.toContain("s3cret");
    expect(result.formValueItems.find((item) => item.classification === "withheld-sensitive")).not.toHaveProperty("value");
    expect(result.formValueItems.find((item) => item.classification === "allowed-ordinary")).toMatchObject({
      value: "Ada",
      controlId: "control-1",
    });
  });

  it.each([
    ["iframe-only", '<iframe src="about:blank" title="opaque child"></iframe>'],
    ["closed-shadow-only", "<hallpass-closed-shadow></hallpass-closed-shadow>"],
    ["canvas-only", '<canvas width="100" height="50"></canvas>'],
  ])("reports %s as unsupported without returning page data", (_name, markup) => {
    document.body.innerHTML = markup;
    const context = createContentRuntimeContext({ documentEpoch: "doc-1", canonicalOrigin: "https://example.test" });
    handleContentMessage(frame("content.probe", {}), undefined, context);

    const result = handleContentMessage(
      frame("content.collect-page", {
        generalPageReadGrantId: "grant-general",
        bounds: TEST_COLLECTION_BOUNDS,
        requestedDataCategories: ["page.visible-text", "page.title", "page.structure"],
      }),
      undefined,
      context,
    ) as Record<string, unknown>;

    expect(result).toEqual({
      ok: false,
      reason: "unsupported-page",
      documentEpoch: "doc-1",
      canonicalOrigin: "https://example.test",
      formValueItems: [],
    });
  });

  it("keeps a truly empty top document as an empty successful collection", () => {
    document.body.innerHTML = "";
    const context = createContentRuntimeContext({ documentEpoch: "doc-1", canonicalOrigin: "https://example.test" });
    handleContentMessage(frame("content.probe", {}), undefined, context);
    const result = handleContentMessage(
      frame("content.collect-page", {
        generalPageReadGrantId: "grant-general",
        bounds: TEST_COLLECTION_BOUNDS,
        requestedDataCategories: ["page.visible-text"],
      }),
      undefined,
      context,
    ) as Record<string, unknown>;
    expect(result).toMatchObject({ visibleText: "", formValueItems: [] });
    expect(result).not.toHaveProperty("reason");
  });
});

/**
 * 004/T128 gap 1 — a delivered point that lands on a descendant of the target hit the target.
 *
 * `elementFromPoint` returns the topmost element at the point, which on an ordinary control is very
 * often a child of it - the label span inside a button. Matching the ref's handle exactly would call
 * that a miss: a false refusal on the pages 003 already proved, and the regression the confirmer must
 * not introduce.
 */
describe("content.resolve-point matches a descendant of the target (004/T128)", () => {
  afterEach(() => {
    delete (document as unknown as { elementFromPoint?: unknown }).elementFromPoint;
  });

  it("resolves to the target's own handle when the point hit a child of it", () => {
    document.body.innerHTML = '<button type="button"><span>Save</span></button>';
    const button = document.querySelector("button");
    const span = document.querySelector("span");
    if (!(button instanceof HTMLButtonElement) || !(span instanceof HTMLSpanElement)) {
      throw new Error("fixture-missing");
    }
    const context = createContentRuntimeContext({ documentEpoch: "doc-1", canonicalOrigin: "https://example.test" });
    handleContentMessage(frame("content.probe", {}), undefined, context);
    context.registry.issue({
      targetHandle: "tgt-save",
      snapshotId: "snap-1",
      documentEpoch: "doc-1",
      element: button,
      target: { tagName: "BUTTON", type: "button" },
    });
    // The point that was delivered lands on the label span, not the button - what a real click at
    // the button's centre very often hits.
    (document as unknown as { elementFromPoint: (x: number, y: number) => unknown }).elementFromPoint = () => span;

    const reply = handleContentMessage(
      frame("content.resolve-point", { generalPageReadGrantId: "grant-general", x: 10, y: 10, targetHandle: "tgt-save" }),
      undefined,
      context,
    ) as { ok: boolean; outcome?: string; candidates?: Array<{ targetHandle: string }> };

    expect(reply).toMatchObject({ ok: true, outcome: "resolved" });
    // Not a fresh handle for the span: the same ref the delivery was aimed at.
    expect(reply.candidates?.[0]?.targetHandle).toBe("tgt-save");
  });

  /**
   * 004/T129 - this is a real miss, not an unanswerable one: the check ran and the page can say
   * what was actually under the point. It used to mint a fresh handle for that element and answer
   * `resolved` with a different handle, which the confirmer then had no way to tell apart from a
   * refusal upstream - both collapsed to the same bare `target-missed`. Now it answers `missed`
   * directly, with the role and name a plain read already discloses under the same grant.
   */
  it("answers missed, with what was there, when the point hit something else entirely", () => {
    document.body.innerHTML = '<button type="button">Save</button><a href="/other">Other</a>';
    const button = document.querySelector("button");
    const other = document.querySelector("a");
    if (!(button instanceof HTMLButtonElement) || !(other instanceof HTMLAnchorElement)) {
      throw new Error("fixture-missing");
    }
    const context = createContentRuntimeContext({ documentEpoch: "doc-1", canonicalOrigin: "https://example.test" });
    handleContentMessage(frame("content.probe", {}), undefined, context);
    context.registry.issue({
      targetHandle: "tgt-save",
      snapshotId: "snap-1",
      documentEpoch: "doc-1",
      element: button,
      target: { tagName: "BUTTON", type: "button" },
    });
    (document as unknown as { elementFromPoint: (x: number, y: number) => unknown }).elementFromPoint = () => other;

    const reply = handleContentMessage(
      frame("content.resolve-point", { generalPageReadGrantId: "grant-general", x: 10, y: 10, targetHandle: "tgt-save" }),
      undefined,
      context,
    ) as { ok: boolean; outcome?: string; role?: string; candidates?: Array<{ targetHandle: string }> };

    expect(reply).toMatchObject({ ok: true, outcome: "missed", role: "a" });
    expect(reply.candidates).toBeUndefined();
  });

  /**
   * 004/T168 - a target that its own activation removed is not a miss. YouTube's cued-overlay
   * `Play video` button swaps itself for the player's controls on the click that plays the video;
   * the point then hits the control that replaced it, and "the point resolved to something else"
   * was reported as `target-missed` on a click that landed. A registry element no longer in the
   * document cannot be hit-tested against, so the confirmation says it could not be made
   * (`stale-target`, which the worker reads as `unconfirmed`), never that it observed a miss.
   */
  it("refuses to call a click missed when the target has left the document since (T168)", () => {
    document.body.innerHTML = '<button type="button">Play video</button><div id="controls"><span>Pause</span></div>';
    const button = document.querySelector("button");
    const replacement = document.querySelector("#controls span");
    if (!(button instanceof HTMLButtonElement) || !(replacement instanceof HTMLSpanElement)) {
      throw new Error("fixture-missing");
    }
    const context = createContentRuntimeContext({ documentEpoch: "doc-1", canonicalOrigin: "https://example.test" });
    handleContentMessage(frame("content.probe", {}), undefined, context);
    context.registry.issue({
      targetHandle: "tgt-play",
      snapshotId: "snap-1",
      documentEpoch: "doc-1",
      element: button,
      target: { tagName: "BUTTON", type: "button" },
    });
    // The activation's own effect: the target is gone, something else is under the point now.
    button.remove();
    (document as unknown as { elementFromPoint: (x: number, y: number) => unknown }).elementFromPoint = () => replacement;

    const reply = handleContentMessage(
      frame("content.resolve-point", { generalPageReadGrantId: "grant-general", x: 10, y: 10, targetHandle: "tgt-play" }),
      undefined,
      context,
    );

    expect(reply).toEqual({ ok: false, reason: "stale-target" });
  });

  /**
   * 004/T129 (B83) - a miss's `label` must name what was actually there. `readLiveTarget`'s `name`
   * is the HTML `name` attribute, which an arbitrary control (a player button, say) almost never
   * carries - the answer would come back blank and tell the caller nothing. The collector's own
   * name computation (`read_page`/`find`'s aria-label/title/alt/caption/own-text/name/placeholder
   * chain) is what must run here instead.
   */
  it("answers missed with the collector's aria-label, not the blank name attribute", () => {
    document.body.innerHTML =
      '<button type="button">Save</button><div role="button" aria-label="Play video"></div>';
    const button = document.querySelector("button");
    const other = document.querySelector("div[role=button]");
    if (!(button instanceof HTMLButtonElement) || !(other instanceof HTMLDivElement)) {
      throw new Error("fixture-missing");
    }
    const context = createContentRuntimeContext({ documentEpoch: "doc-1", canonicalOrigin: "https://example.test" });
    handleContentMessage(frame("content.probe", {}), undefined, context);
    context.registry.issue({
      targetHandle: "tgt-save",
      snapshotId: "snap-1",
      documentEpoch: "doc-1",
      element: button,
      target: { tagName: "BUTTON", type: "button" },
    });
    (document as unknown as { elementFromPoint: (x: number, y: number) => unknown }).elementFromPoint = () => other;

    const reply = handleContentMessage(
      frame("content.resolve-point", { generalPageReadGrantId: "grant-general", x: 10, y: 10, targetHandle: "tgt-save" }),
      undefined,
      context,
    ) as { ok: boolean; outcome?: string; role?: string; label?: string };

    expect(reply).toMatchObject({ ok: true, outcome: "missed", role: "button", label: "Play video" });
  });
});

/**
 * 004/T148 (S4 review) - `document.elementFromPoint` never pierces an open shadow root on its own:
 * the browser returns the shadow **host**, an *ancestor* of the target, not the control inside it.
 * `targetElement.contains(element)` is then false, and the reply is `missed` even though the click
 * landed - contradicting the shadow support B92 added to `find`, which can mint a ref for a control
 * `click` can then never confirm.
 */
describe("content.resolve-point reaches a target inside an open shadow root (004/T148)", () => {
  afterEach(() => {
    delete (document as unknown as { elementFromPoint?: unknown }).elementFromPoint;
  });

  it("resolves to the target's own handle when the point hit its shadow host", () => {
    document.body.innerHTML = "<div></div>";
    const host = document.querySelector("div");
    if (!(host instanceof HTMLDivElement)) throw new Error("fixture-missing");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = '<button type="button">Save</button>';
    const button = shadow.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) throw new Error("fixture-missing");

    const context = createContentRuntimeContext({ documentEpoch: "doc-1", canonicalOrigin: "https://example.test" });
    handleContentMessage(frame("content.probe", {}), undefined, context);
    context.registry.issue({
      targetHandle: "tgt-save",
      snapshotId: "snap-1",
      documentEpoch: "doc-1",
      element: button,
      target: { tagName: "BUTTON", type: "button" },
    });
    // What a real browser hands back for a point inside an open shadow root: the host, not the
    // control - the same gap `document.elementFromPoint` leaves for every shadow-hosted target.
    (document as unknown as { elementFromPoint: (x: number, y: number) => unknown }).elementFromPoint = () => host;
    (shadow as unknown as { elementFromPoint: (x: number, y: number) => unknown }).elementFromPoint = () => button;

    const reply = handleContentMessage(
      frame("content.resolve-point", { generalPageReadGrantId: "grant-general", x: 10, y: 10, targetHandle: "tgt-save" }),
      undefined,
      context,
    ) as { ok: boolean; outcome?: string; candidates?: Array<{ targetHandle: string }> };

    expect(reply).toMatchObject({ ok: true, outcome: "resolved" });
    expect(reply.candidates?.[0]?.targetHandle).toBe("tgt-save");
  });

  /**
   * The caveat the brief names explicitly: an unrelated ancestor must still be a miss. A host whose
   * shadow tree genuinely does not contain the target is not this gap - re-hit-testing must not
   * turn every ancestor into a hit.
   */
  it("still answers missed when the shadow host's own tree does not contain the target", () => {
    document.body.innerHTML = "<div></div><button>Save</button>";
    const host = document.querySelector("div");
    const button = document.querySelector("button");
    if (!(host instanceof HTMLDivElement) || !(button instanceof HTMLButtonElement)) {
      throw new Error("fixture-missing");
    }
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = "<span>Unrelated</span>";
    const unrelated = shadow.querySelector("span");
    if (!unrelated) throw new Error("fixture-missing");

    const context = createContentRuntimeContext({ documentEpoch: "doc-1", canonicalOrigin: "https://example.test" });
    handleContentMessage(frame("content.probe", {}), undefined, context);
    context.registry.issue({
      targetHandle: "tgt-save",
      snapshotId: "snap-1",
      documentEpoch: "doc-1",
      element: button,
      target: { tagName: "BUTTON", type: "button" },
    });
    (document as unknown as { elementFromPoint: (x: number, y: number) => unknown }).elementFromPoint = () => host;
    (shadow as unknown as { elementFromPoint: (x: number, y: number) => unknown }).elementFromPoint = () => unrelated;

    const reply = handleContentMessage(
      frame("content.resolve-point", { generalPageReadGrantId: "grant-general", x: 10, y: 10, targetHandle: "tgt-save" }),
      undefined,
      context,
    ) as { ok: boolean; outcome?: string };

    expect(reply).toMatchObject({ ok: true, outcome: "missed" });
  });

  /**
   * 004/T158 (second review) - T148's own fix moved the defect rather than removing it. When the
   * target *is* the shadow host itself (`<vaadin-button role="button">`, Lit, Lightning all put the
   * role on the host), `resolveShadowHit` now descends past it into the shadow tree, and
   * `Node.contains` does not cross that boundary - `host.contains(inner)` is false even though the
   * hit landed exactly where the host said it would. Never written before now: B96 covered "inside
   * an open root" and "unrelated ancestor", never "the target is the host". The same round trip
   * serves `hover`'s confirmation too (`content-broker.ts` sends the identical
   * `content.resolve-point` message for both), so this one fix and this one test cover both gestures.
   */
  it("resolves when the target itself is the shadow host the point landed on", () => {
    document.body.innerHTML = "<div></div>";
    const host = document.querySelector("div");
    if (!(host instanceof HTMLDivElement)) throw new Error("fixture-missing");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = "<span>Save</span>";
    const inner = shadow.querySelector("span");
    if (!inner) throw new Error("fixture-missing");

    const context = createContentRuntimeContext({ documentEpoch: "doc-1", canonicalOrigin: "https://example.test" });
    handleContentMessage(frame("content.probe", {}), undefined, context);
    context.registry.issue({
      targetHandle: "tgt-host",
      snapshotId: "snap-1",
      documentEpoch: "doc-1",
      element: host,
      target: { tagName: "DIV", type: "host" },
    });
    (document as unknown as { elementFromPoint: (x: number, y: number) => unknown }).elementFromPoint = () => host;
    (shadow as unknown as { elementFromPoint: (x: number, y: number) => unknown }).elementFromPoint = () => inner;

    const reply = handleContentMessage(
      frame("content.resolve-point", { generalPageReadGrantId: "grant-general", x: 10, y: 10, targetHandle: "tgt-host" }),
      undefined,
      context,
    ) as { ok: boolean; outcome?: string; candidates?: Array<{ targetHandle: string }> };

    expect(reply).toMatchObject({ ok: true, outcome: "resolved" });
    expect(reply.candidates?.[0]?.targetHandle).toBe("tgt-host");
  });
});

/**
 * 003/B1 — who gets a ref (FR-040).
 *
 * The reviewed walk mints a handle only where the 001/002 review path would let an effect land, so
 * a checkbox, a select and a submit control come back with no way to name them. That is right for a
 * remote caller and wrong for the owner's own agent, whose consent is the site mode; without a ref
 * for those controls half the effect surface is unreachable through the tools. The policy is the
 * caller's, stated in the request, and it changes nothing about the reviewed walk.
 */
describe("B1 collection mint policy", () => {
  const MIXED_CONTROLS =
    '<button type="button">Plain</button>' +
    '<input type="text" name="nickname" value="Ada" />' +
    '<input type="checkbox" name="agree" />' +
    '<input type="radio" name="tier" />' +
    '<select name="country"><option>TW</option></select>' +
    '<select name="tags" multiple><option>a</option></select>' +
    '<button type="submit">Sign in</button>' +
    '<input type="password" name="secret" value="s3cret" />' +
    '<input type="email" name="mail" />' +
    '<a href="https://example.test/next">Next page</a>';

  function collect(mintPolicy?: "reviewed" | "all-controls"): Array<{
    role: string;
    label?: string;
    targetHandle?: string;
    hidden?: boolean;
  }> {
    const context = createContentRuntimeContext({ documentEpoch: "doc-1", canonicalOrigin: "https://example.test" });
    handleContentMessage(frame("content.probe", {}), undefined, context);
    const result = handleContentMessage(
      frame("content.collect-page", {
        generalPageReadGrantId: "grant-general",
        bounds: TEST_COLLECTION_BOUNDS,
        requestedDataCategories: ["page.structure", "page.target-metadata"],
        ...(mintPolicy === undefined ? {} : { mintPolicy }),
      }),
      undefined,
      context,
    ) as { semanticNodes?: Array<{ role: string; label?: string; targetHandle?: string; hidden?: boolean }> };
    return result.semanticNodes ?? [];
  }

  it("mints a ref for every control the owner's agent could act on, and reports each one's real role", () => {
    document.body.innerHTML = MIXED_CONTROLS;

    const reviewed = collect();
    const withRef = (nodes: ReturnType<typeof collect>) =>
      nodes.filter((node) => node.targetHandle !== undefined).map((node) => node.role);
    // Today's remote rule, unchanged: a plain button and an ordinary text control, nothing else.
    expect(withRef(reviewed)).toEqual(["button", "textbox"]);

    const all = collect("all-controls");
    expect(all.map((node) => node.role)).toEqual([
      "button",
      "textbox",
      "checkbox",
      "radio",
      "combobox",
      "listbox",
      "button",
      "textbox",
      "textbox",
      "link",
    ]);
    // Every one of them is nameable, the sensitive field included: the owner's own logins are the
    // point of the agent path (SC-021), and the gate that decides them is the site mode.
    expect(all.every((node) => node.targetHandle !== undefined)).toBe(true);
    expect(all.find((node) => node.role === "link")?.label).toBe("Next page");
  });

  it("never carries a control's value, however the collection was asked for", () => {
    document.body.innerHTML = MIXED_CONTROLS;

    expect(JSON.stringify(collect("all-controls"))).not.toContain("s3cret");
  });

  /**
   * C2 — a handle is an offer to act, and nothing can be delivered to an element that is not on the
   * page. `input[type=hidden]` is not a control at all - it is a form field a page carries state in
   * - and a node the owner cannot see is not something an agent may be told it can click.
   */
  it("marks a control nobody can see, and never names a hidden input at all", () => {
    document.body.innerHTML =
      '<input type="hidden" name="csrf" value="token-value" />' +
      '<div style="display:none"><a href="https://example.test/hidden">Hidden link</a></div>' +
      '<button type="button" style="visibility:hidden">Invisible</button>' +
      '<button type="button" hidden>Marked hidden</button>' +
      '<button type="button">Visible</button>';

    const all = collect("all-controls");
    // A form's hidden state is not an element anybody acts on, so it is not listed as one.
    expect(all.map((node) => node.label ?? node.role)).not.toContain("csrf");
    expect(JSON.stringify(all)).not.toContain("token-value");
    const named = (label: string) => all.find((node) => node.label === label);
    // Not rendered, and said so: the worker keeps these out of the working list, and the executor
    // refuses an effect on one. They keep a handle because a wait for an element to *appear* has to
    // be able to name it first (FR-048).
    expect(named("Hidden link")).toMatchObject({ hidden: true });
    expect(named("Hidden link")?.targetHandle).toBeDefined();
    expect(named("Invisible")).toMatchObject({ hidden: true });
    // The `hidden` attribute is the page saying so itself, and that rule is older than this one: no
    // handle at all, exactly as the remote path has always collected.
    expect(named("Marked hidden")).toMatchObject({ hidden: true });
    expect(named("Marked hidden")?.targetHandle).toBeUndefined();
    expect(named("Visible")?.targetHandle).toBeDefined();
    expect(named("Visible")).not.toHaveProperty("hidden");
  });

  /**
   * C2, the other half: a control with no handle is a control no effect can be aimed at. The agent
   * only ever names an element by a ref this collection minted, so the hidden input is unreachable
   * by construction - and a ref it might invent instead is refused by the registry rather than
   * resolved onto some other element.
   */
  it("cannot type into a hidden input, because the collection never named one", () => {
    document.body.innerHTML =
      '<input type="hidden" name="csrf" value="token-value" />' +
      '<input type="text" name="nickname" value="Ada" />';
    const context = createContentRuntimeContext({ documentEpoch: "doc-1", canonicalOrigin: "https://example.test" });
    handleContentMessage(frame("content.probe", {}), undefined, context);
    handleContentMessage(
      frame("content.collect-page", {
        generalPageReadGrantId: "grant-general",
        bounds: TEST_COLLECTION_BOUNDS,
        requestedDataCategories: ["page.structure", "page.target-metadata"],
        mintPolicy: "all-controls",
      }),
      undefined,
      context,
    );

    const refused = handleContentMessage(
      frame("content.execute-action", {
        action: "browser.enter-text",
        arguments: { targetHandle: "tgt-csrf", text: "forged", editMode: "replace" },
      }),
      undefined,
      context,
    ) as { ok?: boolean };

    expect(refused.ok).toBe(false);
    const hidden = document.querySelector('input[type="hidden"]');
    expect(hidden instanceof HTMLInputElement && hidden.value).toBe("token-value");
  });

  /**
   * C2 — the other side of keeping a handle for what is not rendered: the *effect* is refused. The
   * ref exists so a wait can name the element; delivering a click or a keystroke to something the
   * browser is not showing would be exactly the unobservable effect FR-040 forbids.
   */
  it("refuses an effect on an element the browser is not rendering", () => {
    document.body.innerHTML =
      '<div style="display:none"><input type="text" name="later" value="start" /></div>';
    const input = document.querySelector("input");
    if (!(input instanceof HTMLInputElement)) throw new Error("fixture-missing");
    const context = createContentRuntimeContext({ documentEpoch: "doc-1", canonicalOrigin: "https://example.test" });
    handleContentMessage(frame("content.probe", {}), undefined, context);
    context.registry.issue({
      targetHandle: "tgt-later",
      snapshotId: "snap-1",
      documentEpoch: "doc-1",
      element: input,
      target: { tagName: "INPUT", type: "text" },
    });

    const refused = handleContentMessage(
      frame("content.execute-action", {
        action: "browser.enter-text",
        arguments: { targetHandle: "tgt-later", text: "typed", editMode: "replace" },
      }),
      undefined,
      context,
    ) as { ok?: boolean };

    expect(refused.ok).toBe(false);
    expect(input.value).toBe("start");
  });

  it("names a file input by what it is, so an upload can find its target by role", () => {
    document.body.innerHTML = '<input type="file" name="attachment" />';

    const [node] = collect("all-controls");
    expect(node?.role).toBe("file");
    expect(node?.targetHandle).toBeDefined();
  });
});

/**
 * 003/T061 — the owner's files reaching a file input (US7, FR-051).
 *
 * What arrives here is bytes and a name, never a path: the host read the file, under the roots the
 * owner allowed, and this side has no idea a file system exists. What goes back is what the input
 * is *holding* - read from the element after the fact - because that is the evidence FR-040 asks
 * for, and echoing the request would report an upload the page may have rejected.
 *
 * `DataTransfer` is the only way to put files on an input, and jsdom does not implement it, so a
 * minimal stand-in is installed here. The real one is exercised by the packaged journey; what this
 * test pins is everything around it - the refusals, the events, and the evidence.
 */
describe("T061 files into a file input", () => {
  class FakeDataTransfer {
    readonly files: unknown[] = [];
    readonly items = {
      add: (file: unknown): void => {
        (this.files as unknown[]).push(file);
      },
    };
  }

  /**
   * A file input as this module sees one. It is a stand-in rather than a real `<input>` because
   * jsdom implements neither `DataTransfer` nor an assignable `files`, and the two are the only way
   * a file gets onto an input at all; the packaged journey drives the real pair. What is pinned here
   * is everything around them: which elements are refused, which events the page is told about, and
   * that the answer is read from the element rather than echoed from the request.
   */
  function fileInput(type = "file", attributes: { multiple?: boolean; accept?: string } = {}) {
    const events: string[] = [];
    return {
      events,
      element: {
        tagName: "INPUT",
        type,
        ...(attributes.multiple === undefined ? {} : { multiple: attributes.multiple }),
        ...(attributes.accept === undefined ? {} : { accept: attributes.accept }),
        files: [] as unknown[],
        dispatchEvent(event: { type?: string }) {
          events.push(event.type ?? "");
          return true;
        },
      },
    };
  }

  function setFiles(
    handle: string,
    element: object,
    files: Array<{ name: string; type: string; bytesBase64: string }>,
  ) {
    const context = createContentRuntimeContext({ documentEpoch: "doc-1", canonicalOrigin: "https://example.test" });
    handleContentMessage(frame("content.probe", {}), undefined, context);
    context.registry.issue({
      targetHandle: "tgt-file",
      snapshotId: "snap-1",
      documentEpoch: "doc-1",
      element,
      target: { tagName: "INPUT", type: "file" },
    });
    const scope = globalThis as { DataTransfer?: unknown };
    scope.DataTransfer = FakeDataTransfer;
    try {
      return handleContentMessage(
        frame("content.set-files", { targetHandle: handle, files }),
        undefined,
        context,
      ) as { ok: boolean; reason?: string; files?: Array<{ name: string; size: number }> };
    } finally {
      delete scope.DataTransfer;
    }
  }

  const RECEIPT = { name: "receipt.txt", type: "text/plain", bytesBase64: "aGVsbG8=" };

  it("sets the files on the input, tells the page, and reports what it is holding", () => {
    const input = fileInput();

    const reply = setFiles("tgt-file", input.element, [RECEIPT]);

    // Both events, in the order a browser sends them: a page that listens for one or the other has
    // to learn about a file it is about to be asked to upload.
    expect(input.events).toEqual(["input", "change"]);
    expect(reply.ok).toBe(true);
    // The size is the file's own, decoded from the bytes the host sent - five characters of "hello".
    expect(reply.files).toEqual([{ name: "receipt.txt", size: 5 }]);
  });

  /**
   * C4 — the input says what it will take, and a page that asked for one file means it. Setting two
   * on it, or a kind it does not accept, is an upload the page will reject the moment it looks -
   * so it is refused here, named, rather than set and reported as an `ok` the form disagrees with.
   */
  it("refuses more files than the input takes, and a kind it does not accept", () => {
    const second = { name: "second.txt", type: "text/plain", bytesBase64: "aGVsbG8=" };
    const single = fileInput();
    expect(setFiles("tgt-file", single.element, [RECEIPT, second])).toEqual({
      ok: false,
      reason: "too-many-files",
    });
    // Nothing was set and the page was never told anything happened.
    expect(single.events).toEqual([]);
    expect(single.element.files).toEqual([]);

    const many = fileInput("file", { multiple: true });
    expect(setFiles("tgt-file", many.element, [RECEIPT, second]).ok).toBe(true);

    const images = fileInput("file", { accept: ".png,image/*" });
    expect(setFiles("tgt-file", images.element, [RECEIPT])).toEqual({
      ok: false,
      reason: "accept-mismatch",
    });
    expect(images.events).toEqual([]);

    // The same input, asked for something it does say it takes.
    const png = { name: "shot.png", type: "image/png", bytesBase64: "aGVsbG8=" };
    expect(setFiles("tgt-file", fileInput("file", { accept: ".png,image/*" }).element, [png]).ok).toBe(true);
  });

  it("refuses an element that is not a file input, and a handle this document never minted", () => {
    expect(setFiles("tgt-file", fileInput("text").element, [RECEIPT])).toEqual({
      ok: false,
      reason: "not-a-file-input",
    });
    expect(setFiles("tgt-nothing", fileInput().element, [RECEIPT])).toEqual({
      ok: false,
      reason: "stale-target",
    });
  });
});

describe("WP1 document sink observation", () => {
  it("reports documentChanged when a real click handler pushes a new URL", () => {
    document.body.innerHTML = '<button type="button" id="nav">Go</button>';
    const button = document.querySelector("#nav");
    if (!(button instanceof HTMLButtonElement)) throw new Error("fixture-missing");
    button.addEventListener("click", () => {
      history.pushState({}, "", "/moved-" + Date.now());
    });
    const context = createContentRuntimeContext({ documentEpoch: "doc-1", canonicalOrigin: location.origin });
    context.registry.issue({
      targetHandle: "tgt-nav",
      snapshotId: "snap-1",
      documentEpoch: "doc-1",
      element: button,
      target: { tagName: "BUTTON", type: "button" },
    });
    const sink = pageSinkFromGlobal();
    if (!sink) throw new Error("sink-missing");
    const result = executeAction(context.registry, {
      capability: "browser.click",
      documentEpoch: "doc-1",
      targetHandle: "tgt-nav",
      sink,
    });
    expect(result).toMatchObject({ ok: true, effect: "activated", documentChanged: true });
  });

  it("scrolls a real element into view and reports whether it is on screen", () => {
    document.body.innerHTML = '<div style="height:3000px"></div><button type="button" id="far">Far</button>';
    const button = document.querySelector("#far");
    if (!(button instanceof HTMLButtonElement)) throw new Error("fixture-missing");
    const scrollCalls: unknown[] = [];
    button.scrollIntoView = ((options: unknown) => {
      scrollCalls.push(options);
      document.documentElement.scrollTop = 2900;
    }) as typeof button.scrollIntoView;
    button.getBoundingClientRect = () =>
      ({ top: 100, bottom: 130, left: 0, right: 40, width: 40, height: 30, x: 0, y: 100, toJSON() {} }) as DOMRect;
    const context = createContentRuntimeContext({ documentEpoch: "doc-1", canonicalOrigin: location.origin });
    context.registry.issue({
      targetHandle: "tgt-far",
      snapshotId: "snap-1",
      documentEpoch: "doc-1",
      element: button,
      target: { tagName: "BUTTON", type: "button" },
    });
    const sink = pageSinkFromGlobal();
    if (!sink) throw new Error("sink-missing");
    const result = executeAction(context.registry, {
      capability: "browser.scroll",
      documentEpoch: "doc-1",
      mode: "target",
      targetHandle: "tgt-far",
      sink,
    });
    expect(scrollCalls).toHaveLength(1);
    expect(result).toMatchObject({ ok: true, effect: "scrolled", scrollTop: 2900, targetVisibility: "visible" });
  });
});
