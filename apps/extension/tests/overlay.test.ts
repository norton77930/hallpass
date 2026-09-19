import { describe, expect, it } from "vitest";
import {
  drawOverlays,
  type OverlayContext,
  type OverlayFrame,
  type RecordedAction,
} from "../src/offscreen/overlay.js";

/**
 * 008/T212 — the overlay maths, proved without a canvas.
 *
 * Neither vitest project has one (`unit` is node, `extension-ui` is jsdom), and the thing worth
 * proving is arithmetic, not rasterising: where the ring lands, which way the label flips, how long
 * the bar is. So the drawing goes through a recording fake that keeps every call with the styles in
 * force at the time, and the assertions read coordinates out of it.
 *
 * The one bug this file exists to catch is the coordinate one (R-136): the scale is canvas width ÷
 * viewport width, never the device pixel ratio. Every frame below uses a viewport half the canvas,
 * so a correct ring sits at exactly twice the action's page coordinates and a DPR-based one does not.
 */

type DrawCall = {
  op: string;
  args: number[];
  text?: string;
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  font: string;
};

type RecordingContext = OverlayContext & { calls: DrawCall[] };

/** A context that draws nothing and remembers everything. */
function recordingContext(): RecordingContext {
  const calls: DrawCall[] = [];
  const state = {
    fillStyle: "" as string | CanvasGradient | CanvasPattern,
    strokeStyle: "" as string | CanvasGradient | CanvasPattern,
    lineWidth: 0,
    font: "",
    textBaseline: "alphabetic" as CanvasTextBaseline,
  };
  const record = (op: string, args: number[], text?: string): void => {
    calls.push({
      op,
      args,
      ...(text === undefined ? {} : { text }),
      fillStyle: String(state.fillStyle),
      strokeStyle: String(state.strokeStyle),
      lineWidth: state.lineWidth,
      font: state.font,
    });
  };
  return {
    calls,
    get fillStyle() {
      return state.fillStyle;
    },
    set fillStyle(value) {
      state.fillStyle = value;
    },
    get strokeStyle() {
      return state.strokeStyle;
    },
    set strokeStyle(value) {
      state.strokeStyle = value;
    },
    get lineWidth() {
      return state.lineWidth;
    },
    set lineWidth(value) {
      state.lineWidth = value;
    },
    get font() {
      return state.font;
    },
    set font(value) {
      state.font = value;
    },
    get textBaseline() {
      return state.textBaseline;
    },
    set textBaseline(value) {
      state.textBaseline = value;
    },
    beginPath: () => record("beginPath", []),
    closePath: () => record("closePath", []),
    moveTo: (x, y) => record("moveTo", [x, y]),
    lineTo: (x, y) => record("lineTo", [x, y]),
    arc: (x, y, radius, start, end) => record("arc", [x, y, radius, start, end]),
    fill: () => record("fill", []),
    stroke: () => record("stroke", []),
    fillRect: (x, y, width, height) => record("fillRect", [x, y, width, height]),
    fillText: (text, x, y) => record("fillText", [x, y], text),
    // Every glyph the same width: enough to size a box, and it makes the flip deterministic.
    measureText: (text: string) => ({ width: text.length * 10 }),
  };
}

const FRAME: OverlayFrame = { width: 1_200, height: 800, viewportWidth: 600 };
const SCALE = 2; // 1200 ÷ 600 — twice the page coordinates, and nothing to do with any DPR
const WATERMARK = "Hallpass 0.3.0";

const CLICK: RecordedAction = {
  index: 3,
  tool: "click",
  label: "click Sign in",
  point: { x: 100, y: 50 },
};

/**
 * An action with no point at all - not `point: undefined`, which `exactOptionalPropertyTypes` and
 * the worker both treat as a different thing from an absent field.
 */
const KEYPRESS: RecordedAction = { index: 3, tool: "key", label: 'key "Enter"' };

const DRAG: RecordedAction = {
  index: 3,
  tool: "drag",
  label: "drag Row 2",
  from: { x: 100, y: 50 },
  to: { x: 300, y: 200 },
};

function circlesIn(context: RecordingContext): { x: number; y: number; radius: number }[] {
  return context.calls
    .filter((call) => call.op === "arc")
    .map((call) => ({ x: call.args[0] ?? 0, y: call.args[1] ?? 0, radius: call.args[2] ?? 0 }));
}

function labels(context: RecordingContext): DrawCall[] {
  return context.calls.filter((call) => call.op === "fillText");
}

describe("drawing an action onto a recorded frame (008/T212)", () => {
  it("rings the action point at canvas ÷ viewport scale, never the device pixel ratio", () => {
    const context = recordingContext();
    drawOverlays(context, FRAME, CLICK, 3, 10, WATERMARK);

    const ring = circlesIn(context).find((circle) => circle.radius === 11 * SCALE);
    const glow = circlesIn(context).find((circle) => circle.radius === 15 * SCALE);
    expect(ring).toEqual({ x: 200, y: 100, radius: 22 });
    expect(glow).toEqual({ x: 200, y: 100, radius: 30 });
    const stroked = context.calls.find((call) => call.op === "stroke");
    expect(stroked?.lineWidth).toBe(2 * SCALE);
  });

  it("draws no ring for an action that happened nowhere in particular", () => {
    const context = recordingContext();
    drawOverlays(context, FRAME, KEYPRESS, 3, 10, WATERMARK);

    const radii = circlesIn(context).map((circle) => circle.radius);
    expect(radii).not.toContain(11 * SCALE);
    expect(radii).not.toContain(15 * SCALE);
    // The label still has to be somewhere: the corner the geometry names for a pointless action.
    const label = labels(context).find((call) => call.text?.includes("Enter"));
    expect(label?.args).toEqual([20 * SCALE + 8 * SCALE, 20 * SCALE + 8 * SCALE]);
  });

  it("draws a drag as a line between its two scaled points", () => {
    const context = recordingContext();
    drawOverlays(context, FRAME, DRAG, 3, 10, WATERMARK);

    const moved = context.calls.find((call) => call.op === "moveTo" && call.lineWidth === 3 * SCALE);
    const lined = context.calls.find((call) => call.op === "lineTo" && call.lineWidth === 3 * SCALE);
    expect(moved?.args).toEqual([200, 100]);
    expect(lined?.args).toEqual([600, 400]);
    const marks = circlesIn(context).filter((circle) => circle.radius === 6 * SCALE);
    expect(marks).toContainEqual({ x: 200, y: 100, radius: 12 });
    expect(marks).toContainEqual({ x: 600, y: 400, radius: 12 });
  });

  it("flips the label back inside the canvas at the right and bottom edges", () => {
    const inside = recordingContext();
    drawOverlays(inside, FRAME, CLICK, 3, 10, WATERMARK);
    const placed = labels(inside).find((call) => call.text?.includes("Sign in"));
    // 16·s below-right of the point, plus the box's own 8·s padding.
    expect(placed?.args).toEqual([200 + 16 * SCALE + 8 * SCALE, 100 + 16 * SCALE + 8 * SCALE]);

    const cornered = recordingContext();
    drawOverlays(cornered, FRAME, { ...CLICK, point: { x: 590, y: 394 } }, 3, 10, WATERMARK);
    const flipped = labels(cornered).find((call) => call.text?.includes("Sign in"));
    expect(flipped?.args[0]).toBeLessThan(590 * SCALE);
    expect(flipped?.args[1]).toBeLessThan(394 * SCALE);
    expect(flipped?.args[0]).toBeGreaterThanOrEqual(0);
    expect(flipped?.args[1]).toBeGreaterThanOrEqual(0);
  });

  it("fills the progress bar to the step it is on", () => {
    const context = recordingContext();
    drawOverlays(context, FRAME, CLICK, 5, 10, WATERMARK);

    const bars = context.calls.filter(
      (call) => call.op === "fillRect" && call.args[3] === 4 * SCALE && call.args[0] === 0,
    );
    const [track, fill] = bars;
    expect(track?.args).toEqual([0, FRAME.height - 4 * SCALE, FRAME.width, 4 * SCALE]);
    expect(fill?.args).toEqual([0, FRAME.height - 4 * SCALE, FRAME.width / 2, 4 * SCALE]);
  });

  it("gives the initial frame a counter, a bar and a watermark and nothing else", () => {
    const context = recordingContext();
    drawOverlays(context, FRAME, null, 0, 10, WATERMARK);

    expect(circlesIn(context).map((circle) => circle.radius)).not.toContain(11 * SCALE);
    const texts = labels(context).map((call) => call.text);
    expect(texts).toContain("0 / 10");
    expect(texts).toContain(WATERMARK);
    expect(texts).toHaveLength(2);
    const fill = context.calls.find(
      (call) => call.op === "fillRect" && call.args[3] === 4 * SCALE && call.args[2] === 0,
    );
    expect(fill, "an empty bar is still drawn, at zero width").toBeDefined();
  });

  it("writes no counter on a recording that is one frame long", () => {
    const context = recordingContext();
    drawOverlays(context, FRAME, null, 0, 0, WATERMARK);

    const texts = labels(context).map((call) => call.text);
    expect(texts, "`0 / 0` is a counter that says nothing").toEqual([WATERMARK]);
  });

  it("sizes every text it writes from the frame, not from a fixed pixel size", () => {
    const context = recordingContext();
    drawOverlays(context, FRAME, CLICK, 3, 10, WATERMARK);

    const fonts = new Set(labels(context).map((call) => call.font));
    expect(fonts).toContain(`${14 * SCALE}px system-ui, sans-serif`);
    expect(fonts).toContain(`${12 * SCALE}px system-ui, sans-serif`);
  });
});
