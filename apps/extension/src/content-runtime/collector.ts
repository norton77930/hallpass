import { DEFAULT_BOUNDS, type TargetMintPolicy, type TruncationDimension } from "@hallpass/contracts";
import { classifyFormControl, discloseFormValue, type FormControlSnapshot } from "@hallpass/domain";
import { fieldState } from "./field-state.js";
import { INDICATOR_MARKER_ATTRIBUTE } from "./indicator-marker.js";
import {
  isElementRendered,
  TargetRegistry,
  WAIT_TEXT_BASELINE_CHARS,
  type TargetRecord,
} from "./targets.js";

export function collectFormItems(
  controls: readonly FormControlSnapshot[],
  formGrantActive: boolean,
): Array<ReturnType<typeof discloseFormValue> & { controlId: string; controlKind: string }> {
  return controls.map((control, index) => ({
    controlId: "control-" + (index + 1),
    controlKind: control.kind,
    ...discloseFormValue(control, formGrantActive),
  }));
}

export type CollectPageInput = {
  snapshotId: string;
  documentEpoch: string;
  origin: string;
  title?: string;
  selection?: string;
  visibleText?: string;
  controls?: readonly FormControlSnapshot[];
  requested: readonly string[];
  formGrantActive: boolean;
  generalGrantActive: boolean;
  /** Supplied by the worker for this collection; the collector never picks its own limits. */
  bounds: { maxVisibleTextChars: number; maxSemanticNodes: number; maxLabelChars: number };
  registry: TargetRegistry;
  /**
   * A handle from this document, to root the structural part of the snapshot at (003/FR-037).
   *
   * Absent by default, which is the whole document. A handle this document does not know is treated
   * as no root rather than as an error: the caller is asking for a subtree that no longer exists,
   * and answering with the whole page would be a different question, so the collection still
   * happens and the caller's own epoch check is what tells it the handle was stale.
   *
   * 004/T136: this is also the one place "the element is gone" can still be told apart from "this
   * document never minted that handle" - the registry still answers a just-removed element's entry
   * until the prune below retires it, so the result below carries `rootTargetGone` whenever this
   * lookup found a bound entry whose element has already left the document.
   */
  rootTargetHandle?: string;
  /**
   * Brings `rootTargetHandle`'s own element on screen before its rect is measured (004/T128, B67 G5
   * correction).
   *
   * The reference does this before it takes a ref's `getBoundingClientRect()` and we did not - so a
   * target that lays out below an ancestor iframe's own visible box (the grandchild-frame case this
   * fixes) was never reachable, whatever the frame-offset arithmetic composed: the box was real, and
   * off screen. `false`/absent for every caller that only reads - moving the page is the one thing a
   * read must never do - so this is set only by the collection that is about to deliver a coordinate
   * at the rect it is about to measure.
   */
  scrollIntoView?: boolean;
  /**
   * Which controls this collection mints a handle for (003/FR-040, B1).
   *
   * Absent is `reviewed`, which is every frame the 001/002 path has ever sent: a handle exists only
   * where a reviewed remote effect could land. `all-controls` is the local agent's policy - the
   * owner's per-site mode is the consent, so a checkbox, a select, a submit control, a link and
   * the owner's own password field are all nameable. It changes *naming* only; whether an effect
   * may then be delivered is the executor's separate policy decision.
   */
  mintPolicy?: TargetMintPolicy;
};

/**
 * Which elements each policy's walk looks at (003/FR-040, B1).
 *
 * The reviewed walk is untouched - it is the selector the 001/002 collection has always used. The
 * agent's adds the two families a remote review would never be offered and an owner-driven agent
 * cannot work without: links, and the ARIA roles a page uses when it builds its own controls out of
 * plain elements.
 */
const WALK_SELECTORS: Record<TargetMintPolicy, string> = {
  reviewed: "button, input, textarea, select",
  // `iframe`/`frame` are not controls and nothing is ever delivered to one. They are in the agent's
  // walk because a document that embeds another one has to *say so*: the owning element is where
  // the child frame's own answer belongs, and a walk that skipped it would leave the worker with a
  // subtree it could only append at the end of the page (004/T114, R-114).
  //
  // Headings are here for the same kind of reason and not because anything is delivered to one
  // either (004/T117c). A walk of controls alone answers *nothing at all* for a document that is a
  // document - the owner's artifact frame holds 320 elements, six headings and three tables, and
  // not one button - so the structural read reported an empty frame while the text read returned
  // its whole body.
  //
  // The rest of the structure follows for the same reason (004/T117d). The reference builds an
  // accessibility tree; a walk of controls and headings still leaves the prose, the lists, the
  // tables and the described images of a real document invisible, so `filter: "all"` promised the
  // page and delivered a fraction of it with no way for the caller to tell - and "within 10% of the
  // baseline's node count" (SC-036) is not reachable from a list of controls. Each of these carries
  // a role word an agent can act on and, where the element's own text is what identifies it, that
  // text as its name. None of them is interactive, so the default `read_page` is unchanged, and the
  // reviewed walk above stays exactly as the 001/002 collection left it.
  "all-controls":
    "button, input, textarea, select, a[href], iframe, frame, " +
    "h1, h2, h3, h4, h5, h6, " +
    "p, blockquote, pre, " +
    "ul, ol, dl, li, dt, dd, " +
    "table, caption, tr, th, td, " +
    // An `alt` a page left empty is the page saying the image is decoration, and the browser's own
    // tree leaves those out; repeating that judgement is cheaper than a node per spacer GIF.
    'img[alt]:not([alt=""]), ' +
    "main, nav, header, footer, aside, section[aria-label], section[aria-labelledby], article, " +
    "[role=button], [role=link], [role=checkbox], [role=switch], [role=heading], " +
    "[role=paragraph], [role=list], [role=listitem], [role=table], [role=row], " +
    "[role=cell], [role=columnheader], [role=rowheader], [role=img], " +
    "[role=main], [role=navigation], [role=banner], [role=contentinfo], " +
    "[role=complementary], [role=region], [role=search], [role=article]",
};

/**
 * The word each structural element answers to, when the page did not name a role itself (004/T117d).
 *
 * The ARIA words the browser's own tree uses, so an agent reading this list is reading the same
 * vocabulary it would get from the reference. `header`/`footer` are absent on purpose: they are
 * landmarks only at the top of a document, which is a question about ancestors and is answered in
 * `snapshotTarget`.
 */
const STRUCTURAL_ROLES: Record<string, string> = {
  P: "paragraph",
  BLOCKQUOTE: "blockquote",
  PRE: "code",
  UL: "list",
  OL: "list",
  DL: "list",
  LI: "listitem",
  DT: "term",
  DD: "definition",
  TABLE: "table",
  CAPTION: "caption",
  TR: "row",
  TD: "cell",
  // The ARIA word, not the tree's "image": a page that names an image itself writes `role="img"`
  // (claude.ai's own avatar does), and one concept answering to two words is a filter an agent
  // would get wrong.
  IMG: "img",
  MAIN: "main",
  NAV: "navigation",
  ASIDE: "complementary",
  SECTION: "region",
  ARTICLE: "article",
};

/**
 * The elements whose own text is what identifies them (004/T117d).
 *
 * A paragraph, a list item and a table cell *are* their text - an agent naming one has nothing else
 * to name it by. A region is not: its text is the whole subtree under it, so a landmark keeps to
 * the name the page gave it and stays a container the reader can see the shape of.
 */
const TEXT_NAMED_TAGS = new Set(["P", "BLOCKQUOTE", "PRE", "LI", "DT", "DD", "TD", "TH", "CAPTION"]);

/** The sectioning elements that turn a `header`/`footer` into an ordinary container, not a landmark. */
const SECTIONING_ANCESTORS = "article, aside, main, nav, section";

type TargetSnapshot = {
  element: unknown;
  role: string;
  label?: string;
  text?: string;
  /**
   * Whether the element is one nobody can see. It is separate from `actionable` because the two
   * policies disagree about *what* may be named and agree completely about this: a handle for
   * something that is not on the page is an offer no caller could act on.
   */
  hidden: boolean;
  /**
   * The element's own trimmed text as this collection saw it (002/FR-027). It is kept beside the
   * handle in the registry and never projected: it is the baseline a `visible-text-changed` wait
   * compares against, not a name and not something a description is matched on.
   */
  visibleText?: string;
  actionable: boolean;
  /** Whether the browser renders it at all (003/C2). See `snapshotTarget` for why it is separate. */
  unrendered: boolean;
  /**
   * Whether this element holds a child document (004/T114). It is the merge's splice point: the
   * i-th marked node of this document owns the i-th child frame the browser lists under it.
   */
  frameOwner?: boolean;
  /**
   * Where the element is in *this frame's* viewport, in CSS pixels, as the browser measured it.
   *
   * Frame-local and deliberately not corrected: a frame cannot see where it sits on the page, and a
   * document that guessed an offset would hand the worker a number it had no way to undo. Adding
   * the owner's offsets is the worker's job, once, from the top (R-114 act half).
   */
  rect?: { x: number; y: number; width: number; height: number };
  /**
   * How deeply the element sits under the root of the snapshot (003/FR-037).
   *
   * The snapshot is a flat list, so this is what lets a reader see it as a structure without the
   * document's markup ever leaving the page. It is computed from the element's own ancestors, which
   * is a fact about the DOM and not about any caller - the remote path simply never asks for it.
   */
  depth: number;
  /**
   * What the element *is*, beyond its role (004/FR-067, R-116): where a link goes, what a control
   * accepts and what it suggests, and the choices a select offers.
   *
   * They are here because an agent choosing between elements needs them at the moment it chooses:
   * a list of three comboboxes with no options, or of links with no destinations, is a list that
   * costs one more read per decision. None of them is markup - each is a single value the browser
   * already parsed, bounded like every other string a collection carries.
   */
  href?: string;
  controlType?: string;
  placeholder?: string;
  options?: string[];
  /**
   * Whether the element's box lies entirely outside this frame's viewport (004/FR-067).
   *
   * Deliberately not folded into `unrendered`: the browser draws this element, it is simply not on
   * the screen right now. A working list wants what is on screen; `filter: "all"` wants the page.
   * Only the document can answer it, because only it knows the size of its own viewport.
   */
  offscreen?: boolean;
  target: NonNullable<TargetRecord["target"]>;
};

/** The element's element-ancestor count, stopping at `root` when one is given. */
function depthUnder(node: unknown, root: unknown): number {
  let depth = 0;
  let current = (node as { parentElement?: unknown } | undefined)?.parentElement;
  while (current && depth < 64) {
    if (current === root) return depth + 1;
    depth += 1;
    current = (current as { parentElement?: unknown }).parentElement;
  }
  return depth;
}

/**
 * Whether `node` is the extension's own in-page indicator, or sits inside it (004 FR-062).
 *
 * The indicator is furniture this extension put on the page; it is not page content and never
 * belongs in a collection. An agent that read its own indicator back out of `read_page` would be
 * reading its own tail - and its control would be offered as an element to click.
 */
function withinIndicator(node: unknown): boolean {
  let current: unknown = node;
  let steps = 0;
  while (current && steps < 64) {
    const element = current as { getAttribute?: (name: string) => string | null; parentElement?: unknown };
    if (typeof element.getAttribute?.(INDICATOR_MARKER_ATTRIBUTE) === "string") return true;
    current = element.parentElement;
    steps += 1;
  }
  return false;
}

/** Whether `node` is `root` or sits inside it; the whole document when no root is given. */
function withinRoot(node: unknown, root: unknown): boolean {
  if (!root) return true;
  let current: unknown = node;
  let steps = 0;
  while (current && steps < 64) {
    if (current === root) return true;
    current = (current as { parentElement?: unknown }).parentElement;
    steps += 1;
  }
  return false;
}

function ordinaryVisibleText(body: {
  innerText?: string;
  textContent?: string | null;
  cloneNode?: (deep?: boolean) => unknown;
} | null | undefined): string {
  if (!body) return "";
  if (typeof body.cloneNode === "function") {
    const clone = body.cloneNode(true) as {
      textContent?: string | null;
      querySelectorAll?: (selector: string) => ArrayLike<{ remove?: () => void }>;
    };
    const excluded = clone.querySelectorAll?.(
      "input, textarea, select, option, script, style, template, [hidden], " +
        `[aria-hidden="true"], [${INDICATOR_MARKER_ATTRIBUTE}]`,
    );
    if (excluded) {
      for (let index = 0; index < excluded.length; index += 1) excluded[index]?.remove?.();
    }
    return (clone.textContent ?? "").trim();
  }
  return (body.innerText || body.textContent || "").trim();
}

export function classifyDocumentSupport(doc: {
  body?: {
    innerText?: string;
    textContent?: string | null;
    cloneNode?: (deep?: boolean) => unknown;
  } | null;
  querySelectorAll: (selector: string) => ArrayLike<unknown>;
}): "supported" | "unsupported" {
  if (ordinaryVisibleText(doc.body).length > 0) return "supported";
  if (doc.querySelectorAll("button, input, textarea, select").length > 0) return "supported";
  if (doc.querySelectorAll("iframe, canvas, object, embed, svg").length > 0) return "unsupported";
  const elements = doc.querySelectorAll("*");
  for (let index = 0; index < elements.length; index += 1) {
    const tagName = (elements[index] as { tagName?: string } | undefined)?.tagName?.toLowerCase();
    if (tagName?.includes("-")) return "unsupported";
  }
  return "supported";
}


/**
 * Every element of `root` the walk looks at, and - for the agent's walk - of the open shadow roots
 * inside it (004/D-004-5, FR-068).
 *
 * A page that builds its controls out of custom elements keeps them in a shadow root, and
 * `querySelectorAll` stops at the host: without this the answer for such a page is a document with
 * nothing on it. An **open** root is content the page itself published - any script on the page can
 * reach it through `shadowRoot` - so reading it is reading the page.
 *
 * A **closed** root is not. The extension does have an API that would open one anyway
 * (`chrome.dom.openOrClosedShadowRoot`), and this line is where it is deliberately not called: a
 * closed root is the page stating that its inside is not part of what it shows, and an agent that
 * saw in would be seeing something no script on that page can. So a control behind a closed root is
 * absent from the answer entirely - it has no node and no ref, which is the same answer the agent
 * gets for an element that is not there, and the effect tools have nothing to aim at it with.
 *
 * The reviewed walk is left as it was: it is the archived 001/002 collection, and widening what a
 * remote review may be shown is not this slice's decision to make.
 */
function walkElements(
  root: { querySelectorAll: (selector: string) => ArrayLike<unknown> },
  selector: string,
  enterOpenShadowRoots: boolean,
  depth = 0,
): unknown[] {
  const found: unknown[] = Array.from(root.querySelectorAll(selector));
  // A bound on nesting, not on breadth: shadow roots inside shadow roots are ordinary, a hundred
  // levels of them are not, and a walk that recursed without one would be a page's to control.
  if (!enterOpenShadowRoots || depth >= 16) return found;
  let hosts: ArrayLike<unknown>;
  try {
    hosts = root.querySelectorAll("*");
  } catch {
    return found;
  }
  for (let index = 0; index < hosts.length; index += 1) {
    // Open roots answer here and closed ones answer `null`, which is the whole of the policy.
    const shadowRoot = (hosts[index] as { shadowRoot?: unknown } | undefined)?.shadowRoot as
      | { querySelectorAll: (selector: string) => ArrayLike<unknown> }
      | null
      | undefined;
    if (!shadowRoot || typeof shadowRoot.querySelectorAll !== "function") continue;
    found.push(...walkElements(shadowRoot, selector, enterOpenShadowRoots, depth + 1));
  }
  return found;
}

export function snapshotDocument(
  doc: {
    title: string;
    body?: { innerText?: string; textContent?: string | null } | null;
    getSelection?: () => { toString(): string } | null;
    querySelectorAll: (selector: string) => ArrayLike<unknown>;
  },
  origin: string,
  maxLabelChars: number = DEFAULT_BOUNDS.maxLabelChars,
  /**
   * Roots the structural part of the snapshot at one element (003/FR-037). Caller-agnostic and
   * absent by default, which is the whole document - the shape the remote path has always had.
   */
  root?: unknown,
  /** Which controls this walk looks at and may name (003/FR-040, B1). Absent is the reviewed walk. */
  mintPolicy: TargetMintPolicy = "reviewed",
): {
  title: string;
  visibleText: string;
  selection: string;
  origin: string;
  controls: FormControlSnapshot[];
  targets: TargetSnapshot[];
} {
  const body = doc.body;
  const visibleText = ordinaryVisibleText(body);
  const controls: FormControlSnapshot[] = [];
  const targets: TargetSnapshot[] = [];
  const nodes = walkElements(doc, WALK_SELECTORS[mintPolicy], mintPolicy === "all-controls");
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (withinIndicator(node)) continue;
    const control = snapshotControl(node);
    if (control) controls.push(control);
    if (!withinRoot(node, root)) continue;
    const target = snapshotTarget(node, maxLabelChars, depthUnder(node, root));
    if (target) targets.push(target);
  }
  return {
    title: doc.title,
    visibleText,
    selection: doc.getSelection?.()?.toString() ?? "",
    origin,
    controls,
    targets,
  };
}

function snapshotControl(node: unknown): FormControlSnapshot | undefined {
  if (!node || typeof node !== "object") return undefined;
  const element = node as {
    tagName?: string;
    type?: string;
    name?: string;
    value?: string;
    autocomplete?: string;
    selectedOptions?: ArrayLike<{ textContent?: string | null }>;
  };
  const tag = (element.tagName ?? "").toLowerCase();
  if (tag === "textarea") {
    return {
      kind: "textarea",
      ...(element.name ? { name: element.name } : {}),
      ...(element.value !== undefined ? { value: element.value } : {}),
      ...(element.autocomplete ? { autocomplete: element.autocomplete } : {}),
    };
  }
  if (tag === "select") {
    const selectedOptionLabels = element.selectedOptions
      ? Array.from(element.selectedOptions).map((option) => option.textContent ?? "")
      : [];
    return {
      kind: "select",
      ...(element.name ? { name: element.name } : {}),
      selectedOptionLabels,
    };
  }
  if (tag !== "input") return undefined;
  const type = (element.type || "text").toLowerCase();
  if (type === "checkbox" || type === "radio") {
    return {
      kind: type,
      type,
      ...(element.name ? { name: element.name } : {}),
      ...(element.value !== undefined ? { value: element.value } : {}),
      ...(element.autocomplete ? { autocomplete: element.autocomplete } : {}),
    };
  }
  return {
    kind: "input",
    type,
    ...(element.name ? { name: element.name } : {}),
    ...(element.value !== undefined ? { value: element.value } : {}),
    ...(element.autocomplete ? { autocomplete: element.autocomplete } : {}),
  };
}

/**
 * The element's box in the viewport of the document it lives in, or nothing.
 *
 * A DOM without layout answers zero for everything, which is not a position - it is the engine
 * saying it did not measure. Reporting that as `{0,0,0,0}` would be indistinguishable from an
 * element genuinely at the origin with no size, so it is left off instead.
 */
function viewportRect(node: unknown): TargetSnapshot["rect"] {
  const element = node as { getBoundingClientRect?: () => { x?: number; y?: number; left?: number; top?: number; width?: number; height?: number } | undefined };
  let box: { x?: number; y?: number; left?: number; top?: number; width?: number; height?: number } | undefined;
  try {
    box = element.getBoundingClientRect?.();
  } catch {
    return undefined;
  }
  if (!box) return undefined;
  const x = box.x ?? box.left ?? 0;
  const y = box.y ?? box.top ?? 0;
  const width = box.width ?? 0;
  const height = box.height ?? 0;
  if (x === 0 && y === 0 && width === 0 && height === 0) return undefined;
  return { x, y, width, height };
}

/** The most options worth listing; past this a select is a data set, not a set of choices. */
const MAX_SELECT_OPTIONS = 200;

/**
 * The element's accessible name built from its own content (004/T137, B88/B89).
 *
 * The browser's algorithm is a recursive join, not a flat `textContent`: each child's own
 * contribution is computed the same way, an `aria-hidden="true"` child contributes nothing at all
 * (measured live on a GitHub repository page - a heading whose visible counter is duplicated in a
 * hidden `aria-hidden` span named itself with that span's digits pulled in), and a non-empty
 * contribution from one child is joined to the next with a single space the markup itself may not
 * have (a link built from two adjacent `<span>`s with no whitespace between them still reads
 * "Python 53.9%" in the browser's own tree, not "Python53.9%"). Plain `textContent.trim()` does
 * neither of those things, which is why the walk reached both elements and still named them wrong.
 */
function nameFromContent(node: unknown): string {
  const children = (node as { childNodes?: ArrayLike<unknown> } | undefined)?.childNodes;
  if (!children) return "";
  const parts: string[] = [];
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index] as {
      nodeType?: number;
      data?: string;
      getAttribute?: (name: string) => string | null;
    };
    if (child.nodeType === 3 /* Text */) {
      if (child.data) parts.push(child.data);
      continue;
    }
    if (child.nodeType === 1 /* Element */) {
      if (child.getAttribute?.("aria-hidden") === "true") continue;
      const inner = nameFromContent(child);
      if (inner !== "") parts.push(inner);
    }
  }
  return parts.join(" ");
}

/**
 * An element's name taken from an `aria-labelledby` reference, however the page hid the element the
 * id points at (004/T137). An icon button whose whole name is a tooltip popover the page marks
 * `aria-hidden="true"` still has one - the reference is explicit, and `aria-hidden` only withholds a
 * name a *parent* would otherwise inherit from ordinary content, not one asked for by id, which is
 * why `nameFromContent` is called on the referenced element directly rather than being asked to
 * cross into it. Several ids join the way `nameFromContent` joins siblings, because `aria-labelledby`
 * may name more than one element.
 */
function labelledByText(element: {
  getAttribute?: (name: string) => string | null;
  ownerDocument?: { getElementById?: (id: string) => unknown } | null;
}): string | undefined {
  const ids = element.getAttribute?.("aria-labelledby");
  const doc = element.ownerDocument;
  if (!ids || !doc?.getElementById) return undefined;
  const parts = ids
    .split(/\s+/)
    .filter((id) => id !== "")
    .map((id) => nameFromContent(doc.getElementById?.(id)))
    .filter((text) => text !== "");
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/**
 * Whether the element's box lies wholly outside the viewport of its own document (004/FR-067).
 *
 * Only "wholly": an element half on screen is one a person can see and act on, and calling it
 * offscreen would take it out of the working list for a reason the agent could not check. An
 * element with no measured box answers `false` - the engine did not measure, which is not the same
 * as a box somewhere else - and so does a document with no window, which is what a detached DOM is.
 */
function isOffscreen(
  element: { ownerDocument?: { defaultView?: { innerWidth?: number; innerHeight?: number } | null } | null },
  rect: TargetSnapshot["rect"],
): boolean {
  if (!rect) return false;
  const view = element.ownerDocument?.defaultView;
  const width = view?.innerWidth;
  const height = view?.innerHeight;
  if (typeof width !== "number" || typeof height !== "number" || width <= 0 || height <= 0) return false;
  return rect.x + rect.width <= 0 || rect.y + rect.height <= 0 || rect.x >= width || rect.y >= height;
}

export function snapshotTarget(node: unknown, maxLabelChars: number, depth = 0): TargetSnapshot | undefined {
  if (!node || typeof node !== "object") return undefined;
  const element = node as {
    tagName?: string;
    type?: string;
    href?: string;
    autocomplete?: string;
    multiple?: boolean;
    name?: string;
    textContent?: string | null;
    getAttribute?: (name: string) => string | null;
    options?: ArrayLike<{ textContent?: string | null; label?: string }>;
    ownerDocument?: {
      defaultView?: { innerWidth?: number; innerHeight?: number } | null;
      getElementById?: (id: string) => unknown;
    } | null;
  };
  const tagName = (element.tagName ?? "").toUpperCase();
  if (!tagName) return undefined;
  const type = element.type?.toLowerCase();
  /**
   * A hidden input is not a control (003/C2): it is where a page keeps state it never shows - a
   * CSRF token, a row id - and nobody, agent or reviewer, acts on one. Listing it as an element
   * would put that state in a projection and offer an effect that cannot happen.
   */
  if (tagName === "INPUT" && type === "hidden") return undefined;
  const explicitRole = element.getAttribute?.("role") ?? undefined;
  /**
   * The element's real role (003/B1). A checkbox reported as a `textbox` is not a smaller answer,
   * it is a wrong one: it tells the reader an effect that cannot work on this control is the one to
   * use. The words are the ARIA ones a reader already knows, and the panel's own projection maps
   * anything outside its closed set to `control`, so widening here cannot widen what a review shows.
   */
  const frameOwner = tagName === "IFRAME" || tagName === "FRAME";
  /** A section title, however the document writes one (004/T117c): the tag, or the page's own role. */
  const heading = /^H[1-6]$/.test(tagName) || explicitRole === "heading";
  /**
   * A `header`/`footer` is the page's banner or its footer only when it belongs to the document
   * itself (004/T117d). One inside an article is that article's own header, which the browser's
   * tree reports as an ordinary container - so this walk leaves it out rather than telling an agent
   * a page has four banners.
   */
  if ((tagName === "HEADER" || tagName === "FOOTER") && !explicitRole) {
    const closest = (element as { closest?: (selector: string) => unknown }).closest;
    let sectioned = false;
    try {
      sectioned = closest?.call(element, SECTIONING_ANCESTORS) != null;
    } catch {
      sectioned = false;
    }
    if (sectioned) return undefined;
  }
  /**
   * What a header cell heads (004/T117d). `scope="row"` is the page saying this cell labels its
   * row, which is a different thing for a reader to do with it than a column title.
   */
  const headerCell =
    tagName === "TH"
      ? element.getAttribute?.("scope") === "row"
        ? "rowheader"
        : "columnheader"
      : undefined;
  const role =
    (frameOwner ? "iframe" : explicitRole) ||
    (heading
      ? "heading"
      : headerCell ??
        STRUCTURAL_ROLES[tagName] ??
        (tagName === "HEADER"
          ? "banner"
          : tagName === "FOOTER"
          ? "contentinfo"
          : tagName === "A" && element.href
      ? "link"
      : tagName === "BUTTON" || (tagName === "INPUT" && ["button", "submit", "reset", "image"].includes(type ?? ""))
        ? "button"
        : tagName === "INPUT" && type === "file"
          ? // Its own word (003/C2): an upload finds its target by what the control *is*, and a
            // file input called a `textbox` is a control an agent would try to type into.
            "file"
          : tagName === "INPUT" && type === "checkbox"
          ? "checkbox"
          : tagName === "INPUT" && type === "radio"
            ? "radio"
            : tagName === "SELECT"
              ? element.multiple === true
                ? "listbox"
                : "combobox"
              : tagName === "INPUT" || tagName === "TEXTAREA"
                ? "textbox"
                : "control"));
  /**
   * A control's own text is content, not a name: a textarea's text node is its current value and a
   * select's is its option list. Only an element whose text is genuinely its label - a button, and
   * a link, whose text *is* its accessible name - may fall back to it, so a review card can never
   * be handed a value to display.
   */
  const ownText =
    tagName === "BUTTON" || tagName === "A" || heading || TEXT_NAMED_TAGS.has(tagName)
      ? nameFromContent(node).trim() || undefined
      : undefined;
  /**
   * What a table is called (004/T117d): its caption, the way the browser names one. A table has no
   * text of its own worth carrying - that is every cell in it, and every cell is its own node - so
   * without this it would arrive nameless in a list of tables.
   */
  const tableCaption =
    tagName === "TABLE"
      ? (element as { querySelector?: (selector: string) => { textContent?: string | null } | null })
          .querySelector?.("caption")
          ?.textContent?.trim() || undefined
      : undefined;
  const labelRaw =
    labelledByText(element) ||
    element.getAttribute?.("aria-label") ||
    (frameOwner ? element.getAttribute?.("title") || undefined : undefined) ||
    // An image's `alt` is the whole reason it is in this walk: it is the description the page wrote
    // for a reader who cannot see the picture, which is exactly the agent's position.
    (tagName === "IMG" ? element.getAttribute?.("alt") || undefined : undefined) ||
    tableCaption ||
    ownText ||
    element.name ||
    element.getAttribute?.("placeholder") ||
    undefined;
  const label = labelRaw?.slice(0, maxLabelChars);
  const text =
    tagName === "BUTTON" || tagName === "A" ? element.textContent?.trim().slice(0, maxLabelChars) : undefined;
  // Every minted handle gets one, whatever the element is: a wait may watch any control the plan
  // could name, and a baseline only some of them have would silently never change for the rest.
  const visibleText = element.textContent?.trim().slice(0, WAIT_TEXT_BASELINE_CHARS) ?? "";
  const autocomplete = element.autocomplete?.toLowerCase() ?? "";
  const hidden =
    element.getAttribute?.("hidden") !== null ||
    element.getAttribute?.("aria-hidden") === "true";
  /**
   * Whether the browser is not rendering the element at all: a `display:none` ancestor, a
   * `visibility:hidden` control, an element with no box (003/C2).
   *
   * It is separate from `hidden` because the two lead to different answers. Neither kind belongs in
   * the *working* list a caller acts from - and neither can be acted on, which the executor checks
   * again at effect time - but an element that is not rendered *yet* is exactly what a
   * `wait { condition: "present" }` is about (FR-048), and a caller cannot wait for something it was
   * never allowed to name. So this one is still offered a handle, and is marked instead.
   */
  const unrendered = !isElementRendered(node);
  const rect = viewportRect(node);
  const offscreen = isOffscreen(element, rect);
  const placeholder = element.getAttribute?.("placeholder") ?? undefined;
  // A select's choices as the agent would have to name one of them: the option's own label, which
  // is the string the browser shows, bounded like every other page-authored value here.
  const options =
    tagName === "SELECT" && element.options
      ? Array.from(element.options)
          .slice(0, MAX_SELECT_OPTIONS)
          .map((option) => (option.label || option.textContent || "").trim().slice(0, maxLabelChars))
      : undefined;
  const sensitiveAutocomplete =
    /password|one-time-code|cc-|credit-card|card-number|cvc|cvv/.test(autocomplete);
  /**
   * A handle is an offer to act on an element, so it is only minted where an effect could actually
   * be delivered. Text controls run through the same closed form-value policy that decides what may
   * be typed into: an `email`, `tel` or `number` input, or a text input the policy cannot name as
   * ordinary, would be refused at effect time, and offering a handle for it advertises a capability
   * the product does not have.
   */
  const ordinaryTextControl =
    (tagName === "INPUT" || tagName === "TEXTAREA") &&
    classifyFormControl({
      kind: tagName === "TEXTAREA" ? "textarea" : "input",
      ...(tagName === "INPUT" ? { type: type || "text" } : {}),
      ...(element.name ? { name: element.name } : {}),
      ...(autocomplete ? { autocomplete } : {}),
    }) === "allowed-ordinary";
  const actionable =
    !hidden &&
    !sensitiveAutocomplete &&
    ((tagName === "BUTTON" && type === "button") || ordinaryTextControl);
  return {
    element: node,
    role,
    ...(label ? { label } : {}),
    ...(text ? { text } : {}),
    visibleText,
    hidden,
    unrendered,
    actionable,
    ...(frameOwner ? { frameOwner: true } : {}),
    ...(rect === undefined ? {} : { rect }),
    ...(offscreen ? { offscreen: true } : {}),
    depth,
    ...(element.href ? { href: element.href } : {}),
    ...(type ? { controlType: type } : {}),
    ...(placeholder ? { placeholder: placeholder.slice(0, maxLabelChars) } : {}),
    ...(options ? { options } : {}),
    target: {
      tagName,
      ...(type ? { type } : {}),
      ...(element.href ? { href: element.href } : {}),
      ...(element.autocomplete ? { autocomplete: element.autocomplete } : {}),
      ...(explicitRole ? { role: explicitRole } : {}),
    },
  };
}

export function collectPage(input: CollectPageInput): {
  contextHandle: string;
  documentEpoch: string;
  canonicalOrigin: string;
  truncated: boolean;
  /** Which limit the collection ran out of, so the panel can say what was cut, not merely that something was. */
  truncatedDimension?: TruncationDimension;
  title?: string;
  selection?: string;
  visibleText?: string;
  formValueItems: Array<ReturnType<typeof discloseFormValue> & { controlId: string; controlKind: string }>;
  /**
   * `true` only when `rootTargetHandle` named an entry this document's registry still had bound,
   * whose element has already left the document (004/T136). Absent covers every other case,
   * deliberately alike: no root was named, the root resolved to a live element, or the handle was
   * never one this document minted at all - the last of which is a different fact this field must
   * never claim.
   */
  rootTargetGone?: boolean;
  semanticNodes?: Array<{
    role: string;
    label?: string;
    text?: string;
    targetHandle?: string;
    depth: number;
    frameOwner?: boolean;
    rect?: { x: number; y: number; width: number; height: number };
    offscreen?: boolean;
    href?: string;
    type?: string;
    placeholder?: string;
    options?: string[];
    value?: string;
    checked?: boolean;
    redacted?: boolean;
    valueTruncated?: boolean;
  }>;
} {
  const rootRecord =
    input.rootTargetHandle === undefined
      ? undefined
      : input.registry.resolve(input.rootTargetHandle, input.documentEpoch);
  // 004/T136: captured from `rootRecord` before `registry.prune()` below retires it - a bound entry
  // whose element no longer derefs, or whose `isConnected` is explicitly `false`, is a handle this
  // document *did* mint that has just left it, which is a different fact from never having minted it
  // at all (the `rootRecord === undefined` case, left to read as no root - see the field above).
  const rootTargetGone =
    input.rootTargetHandle !== undefined &&
    rootRecord !== undefined &&
    (rootRecord.element === undefined ||
      (rootRecord.element as { isConnected?: unknown }).isConnected === false);
  // 004/T128, B67 G5 correction: scrolled before anything below reads a rect, so the walk that
  // follows sees the element where the page will actually paint it.
  if (input.scrollIntoView === true) {
    const element = rootRecord?.element as { scrollIntoView?: (options: unknown) => void } | undefined;
    element?.scrollIntoView?.({ block: "center", inline: "nearest", behavior: "instant" });
  }
  const mintPolicy = input.mintPolicy ?? "reviewed";
  const live =
    input.visibleText === undefined && typeof document !== "undefined"
      ? snapshotDocument(document, input.origin, input.bounds.maxLabelChars, rootRecord?.element, mintPolicy)
      : undefined;
  const visibleTextRaw = input.visibleText ?? live?.visibleText ?? "";
  const controls = input.controls ?? live?.controls ?? [];
  const textTruncated = visibleTextRaw.length > input.bounds.maxVisibleTextChars;
  const visibleText = textTruncated ? visibleTextRaw.slice(0, input.bounds.maxVisibleTextChars) : visibleTextRaw;
  const formValueItems = input.requested.includes("page.form-values")
    ? collectFormItems(controls, input.formGrantActive && input.generalGrantActive)
    : [];
  // 004/FR-066: a collection retires the names of elements that have left the document and keeps
  // every other one, so a reference from an earlier read still names its element.
  input.registry.prune();
  const includeTargets = input.requested.includes("page.target-metadata");
  const includeStructure = input.requested.includes("page.structure") || includeTargets;
  const allTargets = live?.targets ?? [];
  const nodesTruncated = includeStructure && allTargets.length > input.bounds.maxSemanticNodes;
  const semanticNodes = includeStructure
    ? allTargets.slice(0, input.bounds.maxSemanticNodes).map((target) => {
        // The one line the two policies disagree on: a reviewed collection names what a reviewed
        // effect could land on, and the agent's names anything the walk saw that is actually on
        // the page. Neither of them decides whether the effect is *allowed* - that is the site
        // mode's answer for the agent and the review's for the remote path.
        const mintable = mintPolicy === "all-controls" ? !target.hidden : target.actionable;
        // The document's own register decides the name (004/R-115): an element seen before keeps
        // the handle it already has, and only an element seen for the first time gets a new one.
        const targetHandle = includeTargets && mintable ? input.registry.handleFor(target.element) : undefined;
        if (targetHandle) {
          input.registry.issue({
            targetHandle,
            snapshotId: input.snapshotId,
            documentEpoch: input.documentEpoch,
            role: target.role,
            ...(target.label ? { label: target.label } : {}),
            ...(target.text ? { text: target.text } : {}),
            // Registry-only: the baseline never joins the projection below.
            visibleText: target.visibleText ?? "",
            element: target.element,
            target: target.target,
          });
        }
        return {
          role: target.role,
          ...(target.label ? { label: target.label } : {}),
          ...(target.text ? { text: target.text } : {}),
          ...(targetHandle ? { targetHandle } : {}),
          // 003/C2: nobody can see this one right now - it is hidden, or the browser is not
          // rendering it. The worker keeps it out of the working list and the executor refuses an
          // effect on it; naming it at all is what lets a caller wait for it to appear.
          ...(target.hidden || target.unrendered ? { hidden: true } : {}),
          // 004/T114: the two facts only the document itself can state - that this element holds a
          // child document, and where the element is in this frame's own viewport.
          ...(target.frameOwner === true ? { frameOwner: true } : {}),
          ...(target.rect === undefined ? {} : { rect: target.rect }),
          // 004/FR-067: what the element is, and whether it is on the screen right now. The worker
          // decides what to do with the second one - the working read drops it, `all` keeps it.
          //
          // The agent's collection only. A select's options and a control's placeholder are the
          // control's own *content*, and the reviewed path's one rule about content is that it
          // never becomes something a review card shows (002 privacy boundary); the owner's local
          // agent is the caller that asked for the page and is shown it.
          ...(mintPolicy === "all-controls"
            ? {
                ...(target.offscreen === true ? { offscreen: true } : {}),
                ...(target.href ? { href: target.href } : {}),
                ...(target.controlType ? { type: target.controlType } : {}),
                ...(target.placeholder ? { placeholder: target.placeholder } : {}),
                ...(target.options ? { options: target.options } : {}),
                // 005/FR-072: what the control holds right now, under the same gate and for the
                // same reason - it is the control's content. A secret field says `redacted` and
                // nothing else; the predicate inside decides that before the value is carried.
                ...fieldState(target.element, input.bounds.maxLabelChars),
              }
            : {}),
          depth: target.depth,
        };
      })
    : undefined;
  const title = input.title ?? live?.title;
  const selection = input.selection ?? live?.selection;
  // Text is reported first because it is the cut the reader notices; a node cut is reported only
  // when nothing was taken off the text.
  const truncatedDimension: TruncationDimension | undefined = textTruncated
    ? "visible-text"
    : nodesTruncated
      ? "semantic-nodes"
      : undefined;
  return {
    contextHandle: input.snapshotId,
    documentEpoch: input.documentEpoch,
    canonicalOrigin: input.origin,
    truncated: textTruncated || nodesTruncated,
    ...(truncatedDimension !== undefined ? { truncatedDimension } : {}),
    ...(input.requested.includes("page.title") && title !== undefined ? { title } : {}),
    ...(input.requested.includes("page.selection") && selection !== undefined ? { selection } : {}),
    ...(input.requested.includes("page.visible-text") ? { visibleText } : {}),
    formValueItems,
    ...(rootTargetGone ? { rootTargetGone: true } : {}),
    ...(semanticNodes ? { semanticNodes } : {}),
  };
}
