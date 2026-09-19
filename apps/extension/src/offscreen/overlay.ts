/**
 * Drawing what the agent did onto the frame it did it on (008/T212, FR-105, R-136).
 *
 * Pure geometry over a tiny slice of the 2D context, for two reasons. The first is that this is the
 * file where a coordinate bug would hide: every number here is scaled by **canvas width ÷ the
 * viewport width recorded with the frame**, never by `devicePixelRatio`. A CDP screenshot is resized
 * on its way out of the browser, so the device pixel ratio is not the ratio between the picture and
 * the page - it is only the ratio the page itself would report, and using it puts every ring a
 * fraction off. The second is that neither vitest project has a canvas, so the only way the maths
 * gets tested at all is if the context it draws through is an interface a fake can implement.
 *
 * The text arrives finished: the worker cuts a label to 40 characters and masks a redacted one to
 * `••••` before it ever leaves (FR-106). Nothing here shortens, masks or re-reads it - the rule
 * lives in one place, and this process never sees the full text of anything.
 */

/** Ring, progress fill: the panel's accent (`side-panel/agent/tokens.css` `--accent`). */
const ACCENT = "#1f6f78";
/** The same accent at low opacity, for the glow under the ring. */
const ACCENT_GLOW = "rgba(31, 111, 120, 0.28)";
/** Drag path: the panel's danger hue (`--danger`), the one colour that reads as "moved something". */
const DRAG = "#b3261e";
/** Every label, counter and watermark sits on this. */
const BOX_FILL = "rgba(0, 0, 0, 0.85)";
const BOX_TEXT = "#ffffff";
const BAR_TRACK = "rgba(0, 0, 0, 0.3)";
const FONT_FAMILY = "system-ui, sans-serif";

export type OverlayPoint = { x: number; y: number };

/** What the worker attached to the frame; page CSS pixels throughout. */
export type RecordedAction = {
  /** 1-based, shown as `#n`. */
  index: number;
  tool: string;
  /** Already cut to 40 characters and already masked. */
  label: string;
  redacted?: boolean;
  /** Click family, hover, form_input, scroll. */
  point?: OverlayPoint;
  /** Drag only, both or neither. */
  from?: OverlayPoint;
  to?: OverlayPoint;
};

export type OverlayFrame = {
  /** The canvas being drawn on, in pixels. */
  width: number;
  height: number;
  /** The page's own viewport width at capture, in CSS pixels. The denominator of the scale. */
  viewportWidth: number;
};

/**
 * The part of `CanvasRenderingContext2D` this file uses.
 *
 * Deliberately no `roundRect`: the box outline is drawn from lines and arcs instead, so there is one
 * drawing path rather than one for Chrome and an untested one for the fake.
 */
export interface OverlayContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  font: string;
  textBaseline: CanvasTextBaseline;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
  fill(): void;
  stroke(): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
}

const RING_RADIUS = 11;
const GLOW_RADIUS = 15;
const RING_WIDTH = 2;
const DRAG_WIDTH = 3;
const ARROW_LENGTH = 15;
const END_MARK_RADIUS = 6;
const LABEL_FONT_SIZE = 14;
const WATERMARK_FONT_SIZE = 12;
const BOX_PADDING = 8;
const BOX_RADIUS = 6;
const LABEL_OFFSET = 16;
/** Where a label goes when the action had no point of its own. */
const CORNER = 20;
const BAR_HEIGHT = 4;
const EDGE = 16;
const FULL_CIRCLE = Math.PI * 2;

function filledCircle(context: OverlayContext, x: number, y: number, radius: number): void {
  context.beginPath();
  context.arc(x, y, radius, 0, FULL_CIRCLE);
  context.fill();
}

/** A rounded rectangle from lines and corner arcs, filled with whatever `fillStyle` is set to. */
function filledBox(
  context: OverlayContext,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const right = x + width;
  const bottom = y + height;
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(right - radius, y);
  context.arc(right - radius, y + radius, radius, -Math.PI / 2, 0);
  context.lineTo(right, bottom - radius);
  context.arc(right - radius, bottom - radius, radius, 0, Math.PI / 2);
  context.lineTo(x + radius, bottom);
  context.arc(x + radius, bottom - radius, radius, Math.PI / 2, Math.PI);
  context.lineTo(x, y + radius);
  context.arc(x + radius, y + radius, radius, Math.PI, Math.PI * 1.5);
  context.closePath();
  context.fill();
}

/**
 * A boxed line of text, drawn from its top-left corner.
 *
 * The caller places the box; this measures it, so the placement code can ask for the size before it
 * decides which way to flip.
 */
function boxedText(
  context: OverlayContext,
  text: string,
  x: number,
  y: number,
  fontSize: number,
  scale: number,
): void {
  const padding = BOX_PADDING * scale;
  context.font = `${fontSize}px ${FONT_FAMILY}`;
  context.textBaseline = "top";
  const size = boxedTextSize(context, text, fontSize, scale);
  context.fillStyle = BOX_FILL;
  filledBox(context, x, y, size.width, size.height, BOX_RADIUS * scale);
  context.fillStyle = BOX_TEXT;
  context.fillText(text, x + padding, y + padding);
}

function boxedTextSize(
  context: OverlayContext,
  text: string,
  fontSize: number,
  scale: number,
): { width: number; height: number } {
  const padding = BOX_PADDING * scale;
  context.font = `${fontSize}px ${FONT_FAMILY}`;
  return {
    width: context.measureText(text).width + padding * 2,
    height: fontSize + padding * 2,
  };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high));
}

/**
 * Draws every overlay FR-105 asks for, in the order it asks for them.
 *
 * `action` is null for the initial frame - it is a picture of the page before anything happened, so
 * it gets the counter, the bar and the watermark and nothing else. `n` is the frame's **position in
 * the recording** (0 for that initial frame) and `N` the last position, which is what the counter
 * and the bar both read. Neither is the worker's action index: a capture that failed leaves a gap in
 * those, and a gap shown as `6 / 5` is a bug a tester would report.
 *
 * A recording one frame long (`N === 0`) gets no counter at all: `0 / 0` names a run of no steps,
 * and the empty bar and the watermark already say everything there is to say about that frame.
 */
export function drawOverlays(
  context: OverlayContext,
  frame: OverlayFrame,
  action: RecordedAction | null,
  n: number,
  N: number,
  watermark: string,
): void {
  const scale = frame.viewportWidth > 0 ? frame.width / frame.viewportWidth : 1;

  if (action) {
    drawActionMark(context, action, scale);
    drawActionLabel(context, frame, action, scale);
  }
  if (N > 0) {
    drawCounter(context, frame, n, N, scale);
  }
  drawProgressBar(context, frame, n, N, scale);
  drawWatermark(context, frame, watermark, scale);
}

/** (a) the ring at the point, or the path of a drag. */
function drawActionMark(context: OverlayContext, action: RecordedAction, scale: number): void {
  if (action.from && action.to) {
    drawDrag(context, action.from, action.to, scale);
    return;
  }
  if (!action.point) {
    return;
  }
  const x = action.point.x * scale;
  const y = action.point.y * scale;
  context.fillStyle = ACCENT_GLOW;
  filledCircle(context, x, y, GLOW_RADIUS * scale);
  context.strokeStyle = ACCENT;
  context.lineWidth = RING_WIDTH * scale;
  context.beginPath();
  context.arc(x, y, RING_RADIUS * scale, 0, FULL_CIRCLE);
  context.stroke();
}

function drawDrag(
  context: OverlayContext,
  from: OverlayPoint,
  to: OverlayPoint,
  scale: number,
): void {
  const fromX = from.x * scale;
  const fromY = from.y * scale;
  const toX = to.x * scale;
  const toY = to.y * scale;

  context.strokeStyle = DRAG;
  context.lineWidth = DRAG_WIDTH * scale;
  context.beginPath();
  context.moveTo(fromX, fromY);
  context.lineTo(toX, toY);
  context.stroke();

  // The arrowhead points along the line; a drag onto its own start has no direction, so it gets
  // the end marks and no head rather than a triangle pointing at nothing.
  const angle = Math.atan2(toY - fromY, toX - fromX);
  if (toX !== fromX || toY !== fromY) {
    const length = ARROW_LENGTH * scale;
    const spread = Math.PI / 7;
    context.fillStyle = DRAG;
    context.beginPath();
    context.moveTo(toX, toY);
    context.lineTo(toX - length * Math.cos(angle - spread), toY - length * Math.sin(angle - spread));
    context.lineTo(toX - length * Math.cos(angle + spread), toY - length * Math.sin(angle + spread));
    context.closePath();
    context.fill();
  }

  context.fillStyle = DRAG;
  filledCircle(context, fromX, fromY, END_MARK_RADIUS * scale);
  filledCircle(context, toX, toY, END_MARK_RADIUS * scale);
}

/** (b) `#n <label>`, below-right of the point, flipped back inside when it would run off. */
function drawActionLabel(
  context: OverlayContext,
  frame: OverlayFrame,
  action: RecordedAction,
  scale: number,
): void {
  const text = `#${action.index} ${action.label}`;
  const size = boxedTextSize(context, text, LABEL_FONT_SIZE * scale, scale);
  const anchor = action.point ?? action.from;
  let x = CORNER * scale;
  let y = CORNER * scale;
  if (anchor) {
    const offset = LABEL_OFFSET * scale;
    x = anchor.x * scale + offset;
    y = anchor.y * scale + offset;
    if (x + size.width > frame.width) {
      x = anchor.x * scale - offset - size.width;
    }
    if (y + size.height > frame.height) {
      y = anchor.y * scale - offset - size.height;
    }
  }
  boxedText(
    context,
    text,
    clamp(x, 0, frame.width - size.width),
    clamp(y, 0, frame.height - size.height),
    LABEL_FONT_SIZE * scale,
    scale,
  );
}

/** (c) `n / N`, bottom-right, above the bar; never drawn when the run has only the one frame. */
function drawCounter(
  context: OverlayContext,
  frame: OverlayFrame,
  n: number,
  N: number,
  scale: number,
): void {
  const text = `${n} / ${N}`;
  const size = boxedTextSize(context, text, LABEL_FONT_SIZE * scale, scale);
  boxedText(
    context,
    text,
    clamp(frame.width - EDGE * scale - size.width, 0, frame.width - size.width),
    clamp(
      frame.height - BAR_HEIGHT * scale - EDGE * scale - size.height,
      0,
      frame.height - size.height,
    ),
    LABEL_FONT_SIZE * scale,
    scale,
  );
}

/** (d) the bar along the very bottom; the fill is how far through the run this frame is. */
function drawProgressBar(
  context: OverlayContext,
  frame: OverlayFrame,
  n: number,
  N: number,
  scale: number,
): void {
  const height = BAR_HEIGHT * scale;
  const top = frame.height - height;
  const progress = N > 0 ? clamp(n / N, 0, 1) : 0;
  context.fillStyle = BAR_TRACK;
  context.fillRect(0, top, frame.width, height);
  context.fillStyle = ACCENT;
  context.fillRect(0, top, frame.width * progress, height);
}

/** (e) which build made this, bottom-left, above the bar. */
function drawWatermark(
  context: OverlayContext,
  frame: OverlayFrame,
  watermark: string,
  scale: number,
): void {
  const size = boxedTextSize(context, watermark, WATERMARK_FONT_SIZE * scale, scale);
  boxedText(
    context,
    watermark,
    EDGE * scale,
    clamp(
      frame.height - BAR_HEIGHT * scale - EDGE * scale - size.height,
      0,
      frame.height - size.height,
    ),
    WATERMARK_FONT_SIZE * scale,
    scale,
  );
}
