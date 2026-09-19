import { describe, expect, it } from "vitest";
import {
  evaluateCondition,
  readLiveTarget,
  resolveDescription,
  TargetRegistry,
} from "../src/content-runtime/targets.js";

/**
 * WP4: the effect-time descriptor is re-derived from the live element. These fakes pin every
 * field the policy consumes so a dropped attribute read or an inverted visibility check cannot
 * pass unnoticed behind the policy tests, which only see hand-built descriptors.
 */
function fake(attrs: Record<string, string>, idl: Record<string, unknown> = {}) {
  return {
    tagName: "BUTTON",
    ...idl,
    getAttribute: (name: string) => (name in attrs ? attrs[name] : null),
    hasAttribute: (name: string) => name in attrs,
  };
}

describe("WP8 live visibility options", () => {
  it("asks the browser about opacity and skipped content, not only display and visibility", () => {
    const asked: Array<Record<string, boolean> | undefined> = [];
    readLiveTarget({
      tagName: "BUTTON",
      type: "button",
      getAttribute: () => null,
      hasAttribute: () => false,
      checkVisibility: (options?: Record<string, boolean>) => {
        asked.push(options);
        return true;
      },
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      checkVisibilityCSS: true,
      visibilityProperty: true,
      opacityProperty: true,
      contentVisibilityAuto: true,
    });
  });

  it("does not let an engine that rejects the options report the element as hidden", () => {
    const target = readLiveTarget({
      tagName: "BUTTON",
      type: "button",
      getAttribute: () => null,
      hasAttribute: () => false,
      checkVisibility: () => {
        throw new TypeError("unsupported option");
      },
    });
    expect(target?.hidden).toBeUndefined();
  });
});

describe("WP4 readLiveTarget re-reads every policy-relevant fact from the live element", () => {
  it("reports aria-hidden, form association, form action, target, and download attributes", () => {
    expect(readLiveTarget(fake({ "aria-hidden": "true" }, { type: "button" }))).toMatchObject({ hidden: true });
    expect(readLiveTarget(fake({ "aria-hidden": "false" }, { type: "button" }))).not.toHaveProperty("hidden");
    expect(readLiveTarget(fake({ form: "checkout" }, { type: "button" }))).toMatchObject({ formAttr: "checkout" });
    expect(readLiveTarget(fake({ formaction: "/submit" }, { type: "button" }))).toMatchObject({
      formAction: "/submit",
    });
    expect(readLiveTarget(fake({ formtarget: "_blank" }, { type: "button" }))).toMatchObject({
      formTarget: "_blank",
    });
    expect(readLiveTarget(fake({ target: "_blank" }, { type: "button" }))).toMatchObject({ formTarget: "_blank" });
    expect(readLiveTarget(fake({ download: "" }, { type: "button" }))).toMatchObject({ download: "" });
    expect(readLiveTarget(fake({}, { type: "button" }))).toEqual({ tagName: "BUTTON", type: "button" });
  });

  it("treats a browser-reported non-rendered element as hidden and a rendered one as visible", () => {
    expect(readLiveTarget(fake({}, { type: "button", checkVisibility: () => false }))).toMatchObject({
      hidden: true,
    });
    expect(readLiveTarget(fake({}, { type: "button", checkVisibility: () => true }))).not.toHaveProperty("hidden");
    expect(readLiveTarget(fake({ hidden: "" }, { type: "button", checkVisibility: () => true }))).toMatchObject({
      hidden: true,
    });
  });

  it("reads name, read-only, and disabled state from IDL or attributes, and :disabled through an ancestor", () => {
    expect(
      readLiveTarget(fake({ readonly: "" }, { tagName: "INPUT", type: "text", name: "nickname" })),
    ).toMatchObject({ readOnly: true, name: "nickname" });
    expect(readLiveTarget(fake({}, { tagName: "INPUT", type: "text", readOnly: true }))).toMatchObject({
      readOnly: true,
    });
    expect(readLiveTarget(fake({}, { tagName: "INPUT", type: "text", disabled: true }))).toMatchObject({
      disabled: true,
    });
    expect(readLiveTarget(fake({ disabled: "" }, { tagName: "INPUT", type: "text" }))).toMatchObject({
      disabled: true,
    });
    expect(
      readLiveTarget(
        fake({}, { tagName: "INPUT", type: "text", matches: (selector: string) => selector === ":disabled" }),
      ),
    ).toMatchObject({ disabled: true });
    expect(readLiveTarget(fake({ name: "attr-name" }, { tagName: "INPUT", type: "text" }))).toMatchObject({
      name: "attr-name",
    });
    expect(readLiveTarget(fake({}, { tagName: "INPUT", type: "text", name: "" }))).not.toHaveProperty("name");
  });

  it("prefers live IDL values over stale attributes and lower-cases type and autocomplete", () => {
    const descriptor = readLiveTarget(
      fake({ type: "text", autocomplete: "OFF" }, { tagName: "INPUT", type: "IMAGE", autocomplete: "CC-Number" }),
    );
    expect(descriptor).toMatchObject({ type: "image", autocomplete: "cc-number" });
  });

  it("does not invent hidden, read-only, or disabled state for a host without attribute access", () => {
    expect(readLiveTarget({ tagName: "BUTTON", type: "button" })).toEqual({ tagName: "BUTTON", type: "button" });
    expect(readLiveTarget({ tagName: "INPUT", type: "text", name: "nickname" })).toEqual({
      tagName: "INPUT",
      type: "text",
      name: "nickname",
    });
  });

  it("ignores a throwing matches() rather than treating it as disabled", () => {
    expect(
      readLiveTarget(
        fake({}, {
          tagName: "INPUT",
          type: "text",
          matches: () => {
            throw new Error("unsupported selector");
          },
        }),
      ),
    ).not.toHaveProperty("disabled");
  });
});

/**
 * 002 US5 (T067). Resolution runs against the handles the last collection minted, matches the
 * description against the label and text the review would show plus a small set of role words, and
 * answers with one of three outcomes. More matches than the bound is too broad - never a truncated
 * list, never a silent choice - and every candidate carries only handle, role and label.
 */
describe("002 US5 description resolution", () => {
  const EPOCH = "doc-1";
  function liveElement(attrs: Record<string, string> = {}, tagName = "BUTTON") {
    return {
      tagName,
      isConnected: true,
      getAttribute: (name: string) => (name in attrs ? attrs[name] : null),
      hasAttribute: (name: string) => name in attrs,
    };
  }
  function registryWith(
    records: Array<{ handle: string; role: string; label?: string; text?: string; element?: unknown; epoch?: string }>,
  ): TargetRegistry {
    const registry = new TargetRegistry();
    for (const record of records) {
      registry.issue({
        targetHandle: record.handle,
        snapshotId: "snap-1",
        documentEpoch: record.epoch ?? EPOCH,
        role: record.role,
        ...(record.label ? { label: record.label } : {}),
        ...(record.text ? { text: record.text } : {}),
        element: record.element ?? liveElement(),
      });
    }
    return registry;
  }

  it("resolves a description that names one element, carrying the handle and nothing else", () => {
    const registry = registryWith([
      { handle: "t_search", role: "textbox", label: "Search", element: liveElement({}, "INPUT") },
      { handle: "t_safe", role: "button", text: "Safe action" },
    ]);
    // The label and the role are what the match is made on, and they stay on this side of the
    // channel: the worker names an element from the metadata it minted itself, so a role or a
    // label travelling back from the page could only describe an element the review never showed.
    expect(resolveDescription(registry, EPOCH, "search box", 5)).toEqual({
      ok: true,
      outcome: "resolved",
      candidates: [{ targetHandle: "t_search" }],
    });
    // A button is found by its visible text, and the noise words around it do not matter.
    expect(resolveDescription(registry, EPOCH, "the Safe Action button", 5)).toEqual({
      ok: true,
      outcome: "resolved",
      candidates: [{ targetHandle: "t_safe" }],
    });
  });

  it("answers no-match for a description nothing matches, and for one made only of noise words", () => {
    const registry = registryWith([{ handle: "t_safe", role: "button", text: "Safe action" }]);
    expect(resolveDescription(registry, EPOCH, "checkout", 5)).toEqual({ ok: true, outcome: "no-match" });
    expect(resolveDescription(registry, EPOCH, "the", 5)).toEqual({ ok: true, outcome: "no-match" });
    // Every word must match: a description half right is not a match.
    expect(resolveDescription(registry, EPOCH, "safe checkout", 5)).toEqual({ ok: true, outcome: "no-match" });
  });

  it("answers too-broad past the bound rather than a truncated list or a silent choice", () => {
    const registry = registryWith(
      Array.from({ length: 6 }, (_, index) => ({ handle: "t_" + index, role: "button", text: "Item " + index })),
    );
    expect(resolveDescription(registry, EPOCH, "item", 5)).toEqual({ ok: true, outcome: "too-broad" });
    const atBound = resolveDescription(registry, EPOCH, "item", 6);
    expect(atBound).toMatchObject({ ok: true, outcome: "resolved" });
    expect((atBound as { candidates: unknown[] }).candidates).toHaveLength(6);
    // A role word alone names every element of that role.
    expect(resolveDescription(registry, EPOCH, "button", 5)).toEqual({ ok: true, outcome: "too-broad" });
  });

  /**
   * 004/T152 (S4 review). `collapseAncestorChains` is an all-pairs `contains` walk -
   * O(matched^2) DOM calls, on the owner's own page thread - and until this fix it ran on every
   * textual match before the too-broad bound was ever consulted. T137 raised the collection's own
   * ceiling from 200 to `AGENT_READ_PAGE_MAX_NODES` (10,000) so `find` could reach a shadow-only
   * control past the old default, which means `matched` can now be thousands long on an ordinary
   * page - a cost this test measures directly, in `contains` calls, rather than by wall clock.
   */
  it("bounds the ancestor-collapse cost instead of walking every matched pair, on a page with thousands of matches (T152)", () => {
    const N = 2000;
    let containsCalls = 0;
    const records = Array.from({ length: N }, (_, index) => {
      const element = {
        tagName: "SPAN",
        isConnected: true,
        getAttribute: () => null,
        hasAttribute: () => false,
        contains(node: unknown) {
          containsCalls += 1;
          return node === element;
        },
      };
      return { handle: "t_" + index, role: "text", text: "Item " + index, element };
    });
    const registry = registryWith(records);
    expect(resolveDescription(registry, EPOCH, "item", 5)).toEqual({ ok: true, outcome: "too-broad" });
    // An all-pairs walk over N matches is N*(N-1) ~= 4,000,000 `contains` calls here. A bounded
    // collapse must stay orders of magnitude below that, not merely somewhat below it.
    expect(containsCalls).toBeLessThan(N * 10);
  });

  /**
   * 004/T128, B64/B65. `find("Release notes")` on a real submenu returned the ancestor `<li>` first
   * - its accessible name concatenates every descendant's text, so it contains the query - ahead of
   * the `link` whose name *is* the query. A caller taking the first match clicked the container,
   * whose box is the trigger's rather than the submenu item's. Three matches where two are ancestors
   * of the third are one element described three ways, not three choices: `too-broad` must not fire
   * for them, and the control - the most specific, exact-naming element - must come first.
   */
  it("ranks the control ahead of an ancestor container that merely contains its name, as one match rather than three (T128/B65)", () => {
    function nestedElements() {
      // outer <li> > inner <li> > <a>Release notes</a>, exactly as the page measured it.
      const link = {
        tagName: "A",
        isConnected: true,
        getAttribute: () => null,
        hasAttribute: () => false,
        contains(node: unknown) {
          return node === link;
        },
      };
      const innerLi = {
        tagName: "LI",
        isConnected: true,
        getAttribute: () => null,
        hasAttribute: () => false,
        contains(node: unknown) {
          return node === innerLi || node === link;
        },
      };
      const outerLi = {
        tagName: "LI",
        isConnected: true,
        getAttribute: () => null,
        hasAttribute: () => false,
        contains(node: unknown) {
          return node === outerLi || node === innerLi || node === link;
        },
      };
      return { outerLi, innerLi, link };
    }
    const { outerLi, innerLi, link } = nestedElements();
    const registry = registryWith([
      {
        handle: "t_outer",
        role: "listitem",
        text: "Documentation Getting started Release notes API reference",
        element: outerLi,
      },
      { handle: "t_inner", role: "listitem", text: "Release notes", element: innerLi },
      { handle: "t_link", role: "link", text: "Release notes", element: link },
    ]);
    expect(resolveDescription(registry, EPOCH, "Release notes", 5)).toEqual({
      ok: true,
      outcome: "resolved",
      candidates: [{ targetHandle: "t_link" }],
    });
  });

  it("considers only elements the bound document still shows", () => {
    const registry = registryWith([
      { handle: "t_hidden", role: "button", text: "Open", element: liveElement({ hidden: "" }) },
      { handle: "t_gone", role: "button", text: "Open", element: { ...liveElement(), isConnected: false } },
      { handle: "t_stale", role: "button", text: "Open", epoch: "doc-0" },
      { handle: "t_open", role: "button", text: "Open" },
    ]);
    expect(resolveDescription(registry, EPOCH, "open", 5)).toEqual({
      ok: true,
      outcome: "resolved",
      candidates: [{ targetHandle: "t_open" }],
    });
  });

  /**
   * 004/T164. `checkVisibility() === false` is final for a naming decision, whatever the layout
   * says. A `visibility:hidden` or `opacity:0` control keeps its box, and so did the Wikipedia
   * search input that a fallback to the bounding box was once added for - measured, that one was
   * `display:none` under the page's own responsive CSS, and a genuinely backgrounded tab still
   * answers `true` for a boxed control. Overturning the browser's answer on a box would offer a
   * handle for something nobody can see (003/C2).
   */
  it("rejects an element checkVisibility says is hidden even when layout still gives it a box (T164)", () => {
    const hiddenButBoxed = {
      ...liveElement({}, "INPUT"),
      checkVisibility: () => false,
      getClientRects: () => ({ length: 1 }),
      getBoundingClientRect: () => ({ width: 120, height: 24 }),
    };
    const registry = registryWith([
      { handle: "t_search", role: "textbox", label: "Search", element: hiddenButBoxed },
    ]);
    expect(resolveDescription(registry, EPOCH, "search box", 5)).toEqual({ ok: true, outcome: "no-match" });
  });

  it("rejects an element that checkVisibility says is hidden and that has no box either (T164)", () => {
    const genuinelyHidden = {
      ...liveElement({}, "INPUT"),
      checkVisibility: () => false,
      getBoundingClientRect: () => ({ width: 0, height: 0 }),
    };
    const registry = registryWith([
      { handle: "t_search", role: "textbox", label: "Search", element: genuinelyHidden },
    ]);
    expect(resolveDescription(registry, EPOCH, "search box", 5)).toEqual({ ok: true, outcome: "no-match" });
  });

  it("matches whole words, not fragments of them", () => {
    const registry = registryWith([
      { handle: "t_discard", role: "button", text: "Discard unsaved changes" },
      { handle: "t_notes", role: "textbox", label: "Notes", element: liveElement({}, "TEXTAREA") },
      { handle: "t_open", role: "button", text: "Open on double-click" },
    ]);
    // "save" is not a word of "unsaved", and "no" is not a word of "Notes".
    expect(resolveDescription(registry, EPOCH, "save button", 5)).toEqual({ ok: true, outcome: "no-match" });
    expect(resolveDescription(registry, EPOCH, "no", 5)).toEqual({ ok: true, outcome: "no-match" });
    // A hyphenated phrase is matched by its words.
    expect(resolveDescription(registry, EPOCH, "double-click", 5)).toMatchObject({
      outcome: "resolved",
      candidates: [{ targetHandle: "t_open" }],
    });
  });

  it("matches role words to the control kind a review would show", () => {
    const registry = registryWith([
      { handle: "t_notes", role: "textbox", label: "Notes", element: liveElement({}, "TEXTAREA") },
      { handle: "t_colour", role: "combobox", label: "Colour", element: liveElement({}, "SELECT") },
    ]);
    expect(resolveDescription(registry, EPOCH, "notes field", 5)).toMatchObject({ outcome: "resolved", candidates: [{ targetHandle: "t_notes" }] });
    expect(resolveDescription(registry, EPOCH, "colour dropdown", 5)).toMatchObject({ outcome: "resolved", candidates: [{ targetHandle: "t_colour" }] });
    expect(resolveDescription(registry, EPOCH, "notes dropdown", 5)).toEqual({ ok: true, outcome: "no-match" });
  });

  /**
   * T074a. The language policy is `matchDescription`'s (pinned in `packages/domain`); what this
   * side still owns is what a description may be matched against and what comes back. A zh-TW
   * description is written without word breaks, so this is also where the two halves are shown to
   * meet: the segmenting matcher answers, and liveness, the bound and the handles-only reply are
   * unchanged by it.
   */
  it("resolves a zh-TW description over the same live elements, and returns the same handles alone", () => {
    const registry = registryWith([
      { handle: "t_safe", role: "button", label: "安全動作", text: "安全動作" },
      { handle: "t_danger", role: "button", label: "危險動作", text: "危險動作" },
      { handle: "t_notes", role: "textbox", label: "備註", element: liveElement({}, "TEXTAREA") },
      { handle: "t_hidden", role: "button", label: "安全動作", element: liveElement({ hidden: "" }) },
    ]);
    expect(resolveDescription(registry, EPOCH, "安全動作按鈕", 5)).toEqual({
      ok: true,
      outcome: "resolved",
      candidates: [{ targetHandle: "t_safe" }],
    });
    expect(resolveDescription(registry, EPOCH, "備註欄位", 5)).toEqual({
      ok: true,
      outcome: "resolved",
      candidates: [{ targetHandle: "t_notes" }],
    });
    expect(resolveDescription(registry, EPOCH, "完全不存在的東西", 5)).toEqual({ ok: true, outcome: "no-match" });
    // A role word alone names every button the document still shows - two of the three here.
    expect(resolveDescription(registry, EPOCH, "按鈕", 1)).toEqual({ ok: true, outcome: "too-broad" });
    // So does part of a label that two of them share: broad is answered as too broad, not narrowed.
    expect(resolveDescription(registry, EPOCH, "動作", 1)).toEqual({ ok: true, outcome: "too-broad" });
    expect(resolveDescription(registry, EPOCH, "動作", 5)).toEqual({
      ok: true,
      outcome: "resolved",
      candidates: [{ targetHandle: "t_safe" }, { targetHandle: "t_danger" }],
    });

    // The wait baseline is not a name: an element is never resolved by text it was never shown under.
    registry.issue({
      targetHandle: "t_baseline",
      snapshotId: "snap-1",
      documentEpoch: EPOCH,
      role: "button",
      visibleText: "隱藏文字",
      element: liveElement(),
    });
    expect(resolveDescription(registry, EPOCH, "隱藏文字", 5)).toEqual({ ok: true, outcome: "no-match" });
  });

  /**
   * T074a. The zh-TW boundary rule names a base word wherever the segmenter says a word begins, so
   * a description that fits several sibling controls fits all of them - "密碼欄位" names "密碼",
   * "確認密碼" and "新密碼" alike. That is not a matching bug to be broken by narrowing: it is what
   * the bound exists for, and the runtime answers too-broad rather than picking whichever handle it
   * happened to walk first.
   */
  it("answers sibling controls a broad zh-TW description covers as too-broad, never narrowed", () => {
    const registry = registryWith([
      { handle: "t_pw", role: "textbox", label: "密碼", element: liveElement({}, "INPUT") },
      { handle: "t_pw_confirm", role: "textbox", label: "確認密碼", element: liveElement({}, "INPUT") },
      { handle: "t_pw_new", role: "textbox", label: "新密碼", element: liveElement({}, "INPUT") },
    ]);
    expect(resolveDescription(registry, EPOCH, "密碼欄位", 1)).toEqual({ ok: true, outcome: "too-broad" });
    expect(resolveDescription(registry, EPOCH, "請點擊密碼欄位", 2)).toEqual({ ok: true, outcome: "too-broad" });
    expect(resolveDescription(registry, EPOCH, "密碼欄位", 5)).toEqual({
      ok: true,
      outcome: "resolved",
      candidates: [{ targetHandle: "t_pw" }, { targetHandle: "t_pw_confirm" }, { targetHandle: "t_pw_new" }],
    });
    // Narrower still names one: "確認" is a segment of its own label and of no other.
    expect(resolveDescription(registry, EPOCH, "確認密碼欄位", 5)).toEqual({
      ok: true,
      outcome: "resolved",
      candidates: [{ targetHandle: "t_pw_confirm" }],
    });
  });
});

/**
 * 002 US6 (T081). A wait condition is decided here, on the live element behind a handle the worker
 * already holds, and answered with one boolean. Nothing about the page travels back: what the
 * runtime can see stays on this side of the channel, and the worker learns only whether the
 * condition holds right now (FR-027, R-024).
 *
 * `display:none` is what the browser reports through `checkVisibility`; this project's unit runs
 * have no layout engine, so the fakes below answer that call the way Chrome does for a class that
 * hides an element - the same path `resolveDescription` already decides "still shown" through.
 */
describe("002 US6 evaluating a wait condition", () => {
  const EPOCH = "doc-1";
  function element(
    options: {
      attrs?: Record<string, string>;
      tagName?: string;
      connected?: boolean;
      rendered?: boolean;
      text?: string;
    } = {},
  ) {
    const attrs = options.attrs ?? {};
    return {
      tagName: options.tagName ?? "BUTTON",
      isConnected: options.connected ?? true,
      textContent: options.text,
      getAttribute: (name: string) => (name in attrs ? attrs[name] : null),
      hasAttribute: (name: string) => name in attrs,
      checkVisibility: () => options.rendered ?? true,
    };
  }
  function registryWith(
    records: Array<{ handle: string; element: unknown; visibleText?: string; epoch?: string }>,
  ): TargetRegistry {
    const registry = new TargetRegistry();
    for (const record of records) {
      registry.issue({
        targetHandle: record.handle,
        snapshotId: "snap-1",
        documentEpoch: record.epoch ?? EPOCH,
        role: "button",
        ...(record.visibleText !== undefined ? { visibleText: record.visibleText } : {}),
        element: record.element,
      });
    }
    return registry;
  }

  it("reports present for a rendered element and absent for one the page is hiding", () => {
    const registry = registryWith([
      { handle: "t_shown", element: element() },
      { handle: "t_hidden", element: element({ rendered: false }) },
      { handle: "t_attr", element: element({ attrs: { hidden: "" } }) },
      { handle: "t_gone", element: element({ connected: false }) },
    ]);
    expect(evaluateCondition(registry, EPOCH, "t_shown", "present")).toEqual({ ok: true, holds: true });
    expect(evaluateCondition(registry, EPOCH, "t_hidden", "present")).toEqual({ ok: true, holds: false });
    expect(evaluateCondition(registry, EPOCH, "t_attr", "present")).toEqual({ ok: true, holds: false });
    expect(evaluateCondition(registry, EPOCH, "t_gone", "present")).toEqual({ ok: true, holds: false });
    // `absent` is the negation of the same observation, decided here rather than by the worker.
    expect(evaluateCondition(registry, EPOCH, "t_shown", "absent")).toEqual({ ok: true, holds: false });
    expect(evaluateCondition(registry, EPOCH, "t_hidden", "absent")).toEqual({ ok: true, holds: true });
    expect(evaluateCondition(registry, EPOCH, "t_gone", "absent")).toEqual({ ok: true, holds: true });
  });

  it("reports enabled only for an element that is both shown and not disabled", () => {
    const registry = registryWith([
      { handle: "t_ready", element: element() },
      { handle: "t_disabled", element: element({ attrs: { disabled: "" } }) },
      { handle: "t_hidden", element: element({ rendered: false }) },
    ]);
    expect(evaluateCondition(registry, EPOCH, "t_ready", "enabled")).toEqual({ ok: true, holds: true });
    expect(evaluateCondition(registry, EPOCH, "t_disabled", "enabled")).toEqual({ ok: true, holds: false });
    // An element nobody can see is not "enabled" in any sense a plan step could depend on.
    expect(evaluateCondition(registry, EPOCH, "t_hidden", "enabled")).toEqual({ ok: true, holds: false });
  });

  it("compares visible text against what it was when the handle was minted", () => {
    const registry = registryWith([
      { handle: "t_same", element: element({ text: "Loading…" }), visibleText: "Loading…" },
      { handle: "t_changed", element: element({ text: "3 results" }), visibleText: "Loading…" },
      { handle: "t_spaced", element: element({ text: "  Loading…  " }), visibleText: "Loading…" },
      { handle: "t_hidden", element: element({ text: "3 results", rendered: false }), visibleText: "Loading…" },
    ]);
    expect(evaluateCondition(registry, EPOCH, "t_same", "visible-text-changed")).toEqual({ ok: true, holds: false });
    expect(evaluateCondition(registry, EPOCH, "t_changed", "visible-text-changed")).toEqual({ ok: true, holds: true });
    // Whitespace around the text is not a change the user would see.
    expect(evaluateCondition(registry, EPOCH, "t_spaced", "visible-text-changed")).toEqual({ ok: true, holds: false });
    // Text nobody can see has not visibly changed.
    expect(evaluateCondition(registry, EPOCH, "t_hidden", "visible-text-changed")).toEqual({ ok: true, holds: false });
  });

  it("refuses a handle it never minted, or one minted for another document", () => {
    const registry = registryWith([
      { handle: "t_here", element: element() },
      { handle: "t_earlier", element: element(), epoch: "doc-0" },
    ]);
    // Not "the condition does not hold": the runtime has nothing to observe, and saying otherwise
    // would let a wait sit out its whole bound on a target that was never there.
    expect(evaluateCondition(registry, EPOCH, "t_unknown", "present")).toEqual({
      ok: false,
      reason: "stale-target",
    });
    expect(evaluateCondition(registry, EPOCH, "t_earlier", "present")).toEqual({
      ok: false,
      reason: "stale-target",
    });
    expect(evaluateCondition(registry, EPOCH, "t_here", "present")).toEqual({ ok: true, holds: true });
  });
});
