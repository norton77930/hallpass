import { isRedactedField } from "../../content-runtime/field-state.js";
import type { RecordedAction } from "../../offscreen/overlay.js";

/**
 * What one recorded action says on its frame (008/T220, FR-105, FR-106, R-136).
 *
 * Pure, and finished: the label that leaves here is the label that is drawn. It is cut to 40
 * characters and, where FR-106 applies, masked - so the offscreen document never holds the text of
 * anything the owner typed, and the rule about what a secret is lives in one place.
 *
 * That place is 005's own predicate (`content-runtime/field-state.ts`), imported rather than
 * copied: it is pure over an element-shaped value, so the worker can ask it about the facts the
 * last read reported for the target instead of about a DOM node it does not have.
 *
 * **What the worker can and cannot know at action time.** A read (`read_page`, `find`) reports each
 * control's `type` and whether the page called its value redacted; nothing reports `autocomplete`,
 * and no read at all has happened for a ref the agent never looked up. So the rule here is
 * deliberately one-sided: text is shown only when the facts are in hand *and* say the field is an
 * ordinary one. An unknown target's text is masked. A picture that says `••••` about a search box
 * is a worse picture; a picture that spells out a one-time code is a leak, and only one of the two
 * is worth avoiding.
 *
 * The reference draws typed text verbatim (design-notes §2). We do not.
 */

/** FR-105's bound, including the ellipsis: a label is a caption, not a paragraph. */
export const ACTION_LABEL_MAX_CHARS = 40;

/** What a redacted action's text reads as, everywhere. */
export const REDACTED_TEXT = "••••";

/** What the last read said about the element a ref names; every member optional because a read may say none. */
export type ActionTargetFacts = {
  /** The element's accessible name, as the read reported it. */
  name?: string;
  role?: string;
  /** The control's own type (`password`, `text`, `checkbox`…), as `read_page` reports it. */
  type?: string;
  /** Never reported by a read today; honoured for the day one does, and by `find`'s own metadata. */
  autocomplete?: string;
  /** The page's own verdict on the value (005 FR-073): true when it refused to report one. */
  redacted?: boolean;
};

export type ActionPoint = { x: number; y: number };

/** An action as the offscreen document takes it, before the recorder stamps its index. */
export type DescribedAction = Omit<RecordedAction, "index">;

export type DescribeActionInput = {
  tool: string;
  args: Record<string, unknown>;
  /** What the last read knows about the element the call names, when it knows anything. */
  target?: ActionTargetFacts;
  /** Where the effect landed, in page CSS pixels; the runner that measured it says so. */
  point?: ActionPoint;
  from?: ActionPoint;
  to?: ActionPoint;
};

/** The tools whose label is the text they carry rather than the element they name - masked per FR-106. */
const TEXT_TOOLS = new Set(["type", "form_input"]);

/**
 * 005's predicate, asked about facts rather than about an element.
 *
 * The shape handed over is the one `isRedactedField` reads: a tag name, a type and an
 * `autocomplete` attribute. Nothing else about the element is known here and nothing else is
 * needed - the predicate's two halves are exactly those two attributes.
 */
function redactedByFacts(facts: ActionTargetFacts): boolean {
  if (facts.redacted === true) return true;
  return isRedactedField({
    tagName: "INPUT",
    type: facts.type,
    getAttribute: (name: string) =>
      name === "type" ? (facts.type ?? null) : name === "autocomplete" ? (facts.autocomplete ?? null) : null,
  });
}

function hostOf(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

function cut(label: string): string {
  if (label.length <= ACTION_LABEL_MAX_CHARS) return label;
  return `${label.slice(0, ACTION_LABEL_MAX_CHARS - 1)}…`;
}

/** The text a text-bearing tool carries, if it carries one at all. */
function textOf(tool: string, args: Record<string, unknown>): string | boolean | undefined {
  if (tool === "type") return typeof args["text"] === "string" ? (args["text"] as string) : undefined;
  if (tool === "form_input") {
    const value = args["value"];
    return typeof value === "string" || typeof value === "boolean" ? value : undefined;
  }
  return undefined;
}

/** The subject of the label: the text for a text tool, the target's own name for everything else. */
function subjectOf(input: DescribeActionInput, redacted: boolean): string | undefined {
  const { tool, args } = input;
  if (tool === "screenshot") return undefined;
  if (tool === "navigate") {
    const host = hostOf(args["url"]);
    if (host) return host;
    return typeof args["direction"] === "string" ? (args["direction"] as string) : undefined;
  }
  if (tool === "key") {
    const key = typeof args["key"] === "string" ? (args["key"] as string) : undefined;
    if (!key) return undefined;
    const modifiers = Array.isArray(args["modifiers"]) ? (args["modifiers"] as unknown[]) : [];
    return [...modifiers.filter((modifier): modifier is string => typeof modifier === "string"), key].join("+");
  }
  if (tool === "computer") {
    return typeof args["action"] === "string" ? (args["action"] as string) : undefined;
  }
  if (tool === "dialog") {
    return typeof args["action"] === "string" ? (args["action"] as string) : undefined;
  }
  if (TEXT_TOOLS.has(tool)) {
    const text = textOf(tool, args);
    if (text === undefined) return input.target?.name === undefined ? undefined : `"${input.target.name}"`;
    if (typeof text === "boolean") return String(text);
    return `"${redacted ? REDACTED_TEXT : text}"`;
  }
  return input.target?.name === undefined ? undefined : `"${input.target.name}"`;
}

/** The point a `computer` call names itself; every other tool's point is measured by its runner. */
function pointOf(input: DescribeActionInput): ActionPoint | undefined {
  if (input.point) return input.point;
  const { x, y } = input.args as { x?: unknown; y?: unknown };
  return typeof x === "number" && typeof y === "number" ? { x, y } : undefined;
}

export function describeAction(input: DescribeActionInput): DescribedAction {
  // FR-106, one-sided: text is shown only where the facts are in hand and say it is safe.
  const redacted = TEXT_TOOLS.has(input.tool)
    ? typeof textOf(input.tool, input.args) === "string" &&
      (input.target === undefined || redactedByFacts(input.target))
    : false;
  const subject = subjectOf(input, redacted);
  const point = pointOf(input);
  return {
    tool: input.tool,
    label: cut(subject === undefined ? input.tool : `${input.tool} ${subject}`),
    ...(redacted ? { redacted: true } : {}),
    ...(point === undefined ? {} : { point }),
    ...(input.from === undefined ? {} : { from: input.from }),
    ...(input.to === undefined ? {} : { to: input.to }),
  };
}
