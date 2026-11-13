import { lookup, selectLocale } from "../../locales/catalog.js";

/**
 * The words beside the agent's pointer, and what the pointer does while they show
 * (033 FR-499, FR-510, R-491, R-493).
 *
 * Pure on purpose: the worker decides the words and the behaviour, in the owner's locale, and the
 * page only draws them (FR-510). One function maps a tool call - including the `computer` tool's
 * actions - to a row of FR-499's table, so a top-level call and every `browser_batch` step get their
 * caption from the same place.
 *
 *   - `travel`: the pointer goes to the action's point (the existing cursor message carries it).
 *   - `stay`: the pointer stays where it is.
 *   - `rest`: the pointer goes to the rest spot near the bottom-left corner (FR-502).
 */
export type PointerCaption = { words: string; mode: "travel" | "stay" | "rest" };

/** What the worker sends the top frame of a held tab when a tool starts (contracts/page-pointer-messages.md). */
export type PointerStepMessage = { type: "pointer-step" } & PointerCaption;

/** A parameter longer than this is cut and marked (FR-499). */
const PARAMETER_MAX_CHARS = 20;

type CatalogKey = `agent.pointer.${string}`;

type Row = { key: CatalogKey; mode: PointerCaption["mode"] };

const travel = (key: CatalogKey): Row => ({ key, mode: "travel" });
const stay = (key: CatalogKey): Row => ({ key, mode: "stay" });
const rest = (key: CatalogKey): Row => ({ key, mode: "rest" });

/** Tools whose caption does not depend on their arguments. */
const FIXED: Readonly<Record<string, Row>> = {
  click: travel("agent.pointer.click"),
  double_click: travel("agent.pointer.doubleClick"),
  triple_click: travel("agent.pointer.tripleClick"),
  right_click: travel("agent.pointer.rightClick"),
  hover: travel("agent.pointer.hover"),
  drag: travel("agent.pointer.drag"),
  type: stay("agent.pointer.type"),
  form_input: rest("agent.pointer.formInput"),
  evaluate: rest("agent.pointer.evaluate"),
  file_upload: rest("agent.pointer.fileUpload"),
  upload_image: rest("agent.pointer.uploadImage"),
  resize_window: rest("agent.pointer.resize"),
  viewport: rest("agent.pointer.resize"),
  read_page: stay("agent.pointer.readPage"),
  get_page_text: stay("agent.pointer.readPageText"),
  read_console: stay("agent.pointer.readConsole"),
  read_network: stay("agent.pointer.readNetwork"),
};

/** The `computer` tool's actions that are the same row as a stand-alone tool. */
const COMPUTER_ACTIONS: Readonly<Record<string, Row>> = {
  left_click: FIXED.click as Row,
  right_click: FIXED.right_click as Row,
  double_click: FIXED.double_click as Row,
  triple_click: FIXED.triple_click as Row,
  type: FIXED.type as Row,
};

const SCROLL_DIRECTIONS: Readonly<Record<string, CatalogKey>> = {
  down: "agent.pointer.scrollDown",
  up: "agent.pointer.scrollUp",
  left: "agent.pointer.scrollLeft",
  right: "agent.pointer.scrollRight",
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

/**
 * One line, at most `PARAMETER_MAX_CHARS` characters (code points, not UTF-16 units), then `…`.
 * Whitespace runs - a newline in a query included - become one space so the caption stays one line.
 */
function cut(value: string): string {
  const characters = Array.from(value.replace(/\s+/g, " ").trim());
  return characters.length > PARAMETER_MAX_CHARS
    ? `${characters.slice(0, PARAMETER_MAX_CHARS).join("")}…`
    : characters.join("");
}

/** What the page says about a destination: its hostname, or the whole address when it has none. */
function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname || parsed.href;
  } catch {
    return url;
  }
}

/** Seconds as the owner reads them: 2, 0.5, 1.5 - never 2.0. */
function secondsOf(ms: number): string {
  return String(Math.round(ms / 100) / 10);
}

/**
 * The `scroll` tool scrolls through the content runtime and never sends a cursor message, so its words
 * are `stay` (a `travel` step is held until the next cursor message and would never be drawn). Only the
 * `computer` tool's scroll action goes through the pointer and travels.
 */
function scrollRow(args: Record<string, unknown>): Row | undefined {
  if (args.target !== undefined) return stay("agent.pointer.scrollToElement");
  const key = typeof args.direction === "string" ? SCROLL_DIRECTIONS[args.direction] : undefined;
  return key === undefined ? undefined : stay(key);
}

/** The `computer` tool: `scroll` carries a signed amount (negative is up), `key` and `wait` their own. */
function computerRow(args: Record<string, unknown>): { row: Row; params?: Record<string, string> } | undefined {
  const action = typeof args.action === "string" ? args.action : undefined;
  if (action === undefined) return undefined;
  const same = COMPUTER_ACTIONS[action];
  if (same) return { row: same };
  if (action === "scroll") {
    if (typeof args.amount !== "number") return undefined;
    return { row: travel(args.amount < 0 ? "agent.pointer.scrollUp" : "agent.pointer.scrollDown") };
  }
  if (action === "key") {
    return typeof args.key === "string"
      ? { row: stay("agent.pointer.key"), params: { keys: cut(args.key) } }
      : undefined;
  }
  if (action === "wait") {
    return typeof args.ms === "number"
      ? { row: stay("agent.pointer.wait"), params: { n: secondsOf(args.ms) } }
      : undefined;
  }
  // `screenshot` (and anything unknown) changes nothing about what the pointer says.
  return undefined;
}

function resolve(tool: string, args: Record<string, unknown>): { row: Row; params?: Record<string, string> } | undefined {
  const fixed = FIXED[tool];
  if (fixed) return { row: fixed };
  switch (tool) {
    case "scroll": {
      const row = scrollRow(args);
      return row && { row };
    }
    case "key": {
      if (typeof args.key !== "string") return undefined;
      const modifiers = Array.isArray(args.modifiers)
        ? args.modifiers.filter((modifier): modifier is string => typeof modifier === "string")
        : [];
      return { row: stay("agent.pointer.key"), params: { keys: cut([...modifiers, args.key].join("+")) } };
    }
    case "navigate": {
      if (typeof args.url === "string") {
        return { row: rest("agent.pointer.navigate"), params: { host: cut(hostOf(args.url)) } };
      }
      if (args.direction === "back") return { row: rest("agent.pointer.back") };
      if (args.direction === "forward") return { row: rest("agent.pointer.forward") };
      return undefined;
    }
    case "find":
      return typeof args.query === "string"
        ? { row: stay("agent.pointer.find"), params: { query: cut(args.query) } }
        : undefined;
    case "wait": {
      // A fixed pause says how long; a condition wait says the longest it will take.
      const ms = typeof args.forMs === "number" ? args.forMs : args.maxMs;
      return typeof ms === "number" ? { row: stay("agent.pointer.wait"), params: { n: secondsOf(ms) } } : undefined;
    }
    case "computer":
      return computerRow(args);
    default:
      // Reads of the tab list, tab management, screenshots (whole or region), dialogs, recording,
      // batches (their steps speak for themselves) and anything unknown: no caption, no step.
      return undefined;
  }
}

/**
 * The caption for one tool call in the owner's locale, or `undefined` when the call has none (the
 * page keeps whatever it shows). `locale` is the browser's UI language as the pill gets it; the
 * catalog falls back to `en-US` for anything but `zh-TW`.
 */
export function pointerCaption(tool: string, args: unknown, locale: string): PointerCaption | undefined {
  const resolved = resolve(tool, asRecord(args) ?? {});
  if (!resolved) return undefined;
  // `lookup` does not interpolate (R-493), so the placeholders are filled here.
  const template = lookup(resolved.row.key, selectLocale(locale));
  const words = template.replace(/\{(\w+)\}/g, (whole, name: string) => resolved.params?.[name] ?? whole);
  return { words, mode: resolved.row.mode };
}
