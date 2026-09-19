import type { AgentNativeResponse } from "@hallpass/contracts";
import type { CaptureRegion } from "../../chrome-adapters/capture.js";
import type { AgentKeyboardInput, AgentPointerInput } from "./input.js";

/**
 * Acting by position (004/T139, US7, FR-069, FR-070, R-120).
 *
 * This module is a *front door*, and the distinction is the whole of its design. Every action here
 * ends in one of the four calls S4 already built - `pointer.click`, `pointer.scroll`,
 * `keyboard.type`, `keyboard.press` - and nothing in this file dispatches a browser event itself.
 * A second delivery path would be a second set of rules about what a page sees, and the one thing
 * the reference's `computer` tool is for is reaching pages the accessibility tree cannot describe,
 * not reaching them differently.
 *
 * What is genuinely new here is only the *address*. Every other effect names an element and the
 * worker works out where it is; this one names where, and there may be nothing there at all. Two
 * consequences follow, and both are in this file: the point is checked against the tab's own
 * viewport before anything is delivered, and the owner is shown a picture of that place rather
 * than a pair of numbers.
 */

export type Viewport = { width: number; height: number };

export type PositionPoint = { x: number; y: number };

/** The wheel a page sees for one click of `amount`; the notch a mouse reports on this platform. */
export const POSITION_WHEEL_CLICK_PX = 100;

/**
 * The edge of the square the owner is shown around the point (FR-069).
 *
 * Large enough that the control under the point is in it with its neighbours, so the owner can see
 * *what* is being clicked rather than a magnified pixel; small enough that it is a place on the
 * page rather than the page. It is clamped to the viewport, so a point near an edge gives a
 * smaller crop rather than one hanging off the side.
 */
export const POSITION_CROP_PX = 200;

/**
 * The tab's own viewport, measured through the attachment the input leaves by.
 *
 * One geometry query and nothing else - the invariant `input.ts` states holds here too: no domain
 * whose events we consume is enabled, and nothing carrying page content is read. The size is a
 * fact about the browser rather than about the page, which is exactly what makes it the right
 * thing to hand back in a refusal.
 */
export async function measureViewport(
  tabId: number,
  send: (tabId: number, method: string, params?: Record<string, unknown>) => Promise<unknown>,
): Promise<Viewport | undefined> {
  let metrics: unknown;
  try {
    metrics = await send(tabId, "Page.getLayoutMetrics");
  } catch {
    return undefined;
  }
  const layout = (metrics as { cssLayoutViewport?: { clientWidth?: unknown; clientHeight?: unknown } })
    .cssLayoutViewport;
  const width = layout?.clientWidth;
  const height = layout?.clientHeight;
  if (typeof width !== "number" || typeof height !== "number") return undefined;
  return { width, height };
}

/**
 * Whether the point is somewhere the browser could deliver input to.
 *
 * A point past the edge is *refused*, never moved to the edge. Clamping would answer `ok` for a
 * click the agent did not ask for, landing on whatever happens to be at the border - and the agent
 * would have no way of telling that from the click it meant. Refusing with the size is the answer
 * it can act on: it is what lets the next attempt be aimed.
 */
export function insideViewport(point: PositionPoint, viewport: Viewport): boolean {
  return point.x < viewport.width && point.y < viewport.height;
}

export function outsideViewport(callId: string, viewport: Viewport): AgentNativeResponse {
  return {
    callId,
    outcome: "failed",
    reason: "outside-viewport",
    refusal: { reason: "outside-viewport", width: viewport.width, height: viewport.height },
  };
}

/** The square of the viewport the owner is shown, clamped to it. */
export function cropAround(point: PositionPoint, viewport: Viewport): CaptureRegion {
  const half = Math.floor(POSITION_CROP_PX / 2);
  const x = Math.max(0, Math.round(point.x) - half);
  const y = Math.max(0, Math.round(point.y) - half);
  return {
    x,
    y,
    width: Math.max(1, Math.min(POSITION_CROP_PX, viewport.width - x)),
    height: Math.max(1, Math.min(POSITION_CROP_PX, viewport.height - y)),
  };
}

/** The point a call names, when it names one. `screenshot` and `wait` name none. */
export function positionOf(args: Record<string, unknown>): PositionPoint | undefined {
  return typeof args.x === "number" && typeof args.y === "number" ? { x: args.x, y: args.y } : undefined;
}

/** What one delivered action leaves behind, in the words `verifyDelivered` already speaks. */
export type PositionEffect = {
  capability:
    | "browser.click"
    | "browser.right-click"
    | "browser.double-click"
    | "browser.triple-click"
    | "browser.scroll"
    | "browser.enter-text"
    | "browser.key-press";
  evidence: Record<string, unknown>;
};

/**
 * The four clicks, in the runtime's own words.
 *
 * `effect` is not this file's vocabulary to choose: it is read by the same `observationOf` and
 * `verifyPageEffect` every element-addressed click goes through, and a word they do not know is
 * reported to the agent as unreadable evidence. So a position double-click says what a targeted
 * one says. Only the address differs.
 */
const POSITION_CLICKS = {
  left_click: { button: "left", clickCount: 1, capability: "browser.click", effect: "activated" },
  right_click: {
    button: "right",
    clickCount: 1,
    capability: "browser.right-click",
    effect: "context-activated",
  },
  double_click: {
    button: "left",
    clickCount: 2,
    capability: "browser.double-click",
    effect: "double-activated",
  },
  triple_click: {
    button: "left",
    clickCount: 3,
    capability: "browser.triple-click",
    effect: "triple-activated",
  },
} as const;

export type PositionDelivery = {
  tabId: number;
  action: string;
  args: Record<string, unknown>;
  point: PositionPoint | undefined;
  pointer: AgentPointerInput;
  keyboard: AgentKeyboardInput;
  /** How `wait` waits. Injected so a test does not have to spend the time the agent asked for. */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * One position action, delivered by S4's own pointer and keyboard (R-120).
 *
 * `type` and `key` take the same route every keyboard effect takes: a named point is *clicked*
 * first, because a key event goes wherever the page's focus is and clicking is the only way this
 * worker can put the caret somewhere. Without a point they go to whatever already has focus - the
 * meaning an absent target has had since 003.
 */
export async function deliverPosition(input: PositionDelivery): Promise<PositionEffect> {
  const { tabId, action, args, point, pointer, keyboard } = input;

  const click = POSITION_CLICKS[action as keyof typeof POSITION_CLICKS];
  if (click) {
    await pointer.click(tabId, point!, { button: click.button, clickCount: click.clickCount });
    return {
      capability: click.capability,
      evidence: { effect: click.effect, clicks: click.clickCount, documentChanged: false },
    };
  }

  if (action === "scroll") {
    // The coordinate wheel, and the reason S4 left the targeted `scroll` tool alone: that one means
    // "bring this into view", and this one means "turn the wheel here" - two different gestures
    // that happen to share a word.
    const amount = Number(args.amount ?? 0);
    await pointer.scroll(tabId, point!, { deltaX: 0, deltaY: amount * POSITION_WHEEL_CLICK_PX });
    return { capability: "browser.scroll", evidence: { effect: "scrolled", documentChanged: false } };
  }

  if (point) {
    await pointer.click(tabId, point, { button: "left", clickCount: 1 });
  }

  if (action === "type") {
    const text = String(args.text ?? "");
    // Insert, not replace: a position `type` names a place on the page, not a control whose value
    // is being set, so selecting "what is there" first would be this tool inventing a target.
    await keyboard.type(tabId, text, { replace: false });
    return {
      capability: "browser.enter-text",
      evidence: { effect: "text-entered", charactersChanged: [...text].length, documentChanged: false },
    };
  }

  const key = String(args.key ?? "");
  await keyboard.press(tabId, key);
  return { capability: "browser.key-press", evidence: { effect: "key-pressed", key, documentChanged: false } };
}
