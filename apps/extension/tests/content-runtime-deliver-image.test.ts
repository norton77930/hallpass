/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { RUNTIME_PROTOCOL_VERSION } from "@hallpass/contracts";
import { createContentRuntimeContext, handleContentMessage } from "../src/content-runtime/index.js";
import { TEST_NONCE } from "./helpers/content-frames.js";

/**
 * 013/T332 — a picture the session took, delivered into the page (US2, FR-170, FR-171, R-178).
 *
 * Two deliveries and one resolution table. A `<input type="file">` is handed the file the way
 * `content.set-files` already hands one over, minus the `accept` refusal - a programmatic
 * assignment is not filtered by `accept`, and the page's own validation is what decides afterwards.
 * Anything else is dropped on: `dragenter`, `dragover`, `drop` with one `DataTransfer` holding the
 * one `File`, at the point the agent named or the element's own centre, and no `dragleave` (a real
 * drop sends none).
 *
 * What the table pins besides the two paths is *where* the delivery is allowed to land: inside the
 * viewport, on something that exists, and at most one level down into a frame this document can
 * read - a deeper frame or a foreign one is a document this call did not name, and is refused by
 * name rather than delivered to whatever was reachable.
 *
 * jsdom implements neither `DataTransfer` nor `DragEvent`, and the two are the only way a file
 * reaches a page at all, so stand-ins are installed per realm here; the real pair is driven by the
 * packaged gate. What this test pins is everything around them - the refusals, the event order, the
 * coordinates, the realm the `File` is built in, and that the answer is read rather than echoed.
 */

const DOC_EPOCH = "doc-1";
const SHOT = { name: "screenshot.png", type: "image/png", bytesBase64: "aGVsbG8=" };
/** "hello" - five bytes once decoded, which is the size the answer has to report. */
const SHOT_SIZE = 5;

function frame(type: "content.probe" | "content.deliver-image", payload: Record<string, unknown>) {
  return {
    runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    messageId: "message-" + type,
    runtimeEpochId: "epoch-1",
    type,
    taskId: "task-1",
    operationId: "operation-" + type,
    nonce: TEST_NONCE,
    expectedTabId: 1,
    expectedDocumentEpoch: type === "content.probe" ? "probe-unbound" : DOC_EPOCH,
    payload,
  };
}

class FakeDataTransfer {
  readonly files: unknown[] = [];
  readonly items = {
    add: (file: unknown): void => {
      (this.files as unknown[]).push(file);
    },
  };
}

type Realm = { DataTransfer?: unknown; File?: unknown };

/** The stand-ins this realm lacks, installed for one case and taken away again. */
function withTransfer<T>(realm: Realm, run: () => T): T {
  const had = "DataTransfer" in realm ? realm.DataTransfer : undefined;
  realm.DataTransfer = FakeDataTransfer;
  try {
    return run();
  } finally {
    realm.DataTransfer = had;
  }
}

type DeliverReply = {
  ok: boolean;
  reason?: string;
  frame?: { width: number; height: number };
  delivery?: string;
  file?: { name: string; size: number };
  point?: { x: number; y: number };
};

function boundContext() {
  const context = createContentRuntimeContext({ documentEpoch: DOC_EPOCH, canonicalOrigin: "https://example.test" });
  handleContentMessage(frame("content.probe", {}), undefined, context);
  return context;
}

function deliver(
  context: ReturnType<typeof boundContext>,
  target: { handle: string } | { point: { x: number; y: number } },
): DeliverReply {
  return handleContentMessage(frame("content.deliver-image", { target, file: SHOT }), undefined, context) as DeliverReply;
}

/** An element as this module sees one, with a rectangle jsdom has no layout to give it. */
function placeAt(element: Element, box: { left: number; top: number; width: number; height: number }): void {
  element.getBoundingClientRect = () =>
    ({
      left: box.left,
      top: box.top,
      right: box.left + box.width,
      bottom: box.top + box.height,
      width: box.width,
      height: box.height,
      x: box.left,
      y: box.top,
      toJSON() {},
    }) as DOMRect;
}

type Seen = { type: string; clientX: unknown; clientY: unknown; files: unknown[] };

function watchDrag(element: EventTarget): Seen[] {
  const seen: Seen[] = [];
  for (const type of ["dragenter", "dragover", "dragleave", "drop"]) {
    element.addEventListener(type, (event) => {
      const drag = event as unknown as { clientX?: unknown; clientY?: unknown; dataTransfer?: { files?: unknown[] } };
      seen.push({
        type: event.type,
        clientX: drag.clientX,
        clientY: drag.clientY,
        files: [...(drag.dataTransfer?.files ?? [])],
      });
    });
  }
  return seen;
}

afterEach(() => {
  document.body.innerHTML = "";
  Reflect.deleteProperty(document, "elementFromPoint");
});

describe("T332 delivering a screenshot into the page", () => {
  /**
   * A file input as this module sees one: a stand-in rather than a real `<input>` for T061's
   * reason - jsdom implements neither `DataTransfer` nor an assignable `files`, and those are the
   * only way a file gets onto an input at all.
   */
  function fileInput(accept?: string) {
    const events: string[] = [];
    return {
      events,
      element: {
        tagName: "INPUT",
        type: "file",
        ...(accept === undefined ? {} : { accept }),
        files: [] as unknown[],
        dispatchEvent(event: { type?: string }) {
          events.push(event.type ?? "");
          return true;
        },
      },
    };
  }

  function issue(context: ReturnType<typeof boundContext>, handle: string, element: unknown): void {
    context.registry.issue({
      targetHandle: handle,
      snapshotId: "snap-1",
      documentEpoch: DOC_EPOCH,
      element,
      target: { tagName: "INPUT", type: "file" },
    });
  }

  it("(a) puts the picture on a file input the ref names, tells the page, and reads it back", () => {
    const context = boundContext();
    const input = fileInput(".pdf");
    issue(context, "t_attachment", input.element);

    const reply = withTransfer(globalThis as Realm, () => deliver(context, { handle: "t_attachment" }));

    // `accept` is deliberately not consulted: an assignment is not filtered by it, and the page's
    // own validation is what decides what it does with the file afterwards.
    expect(reply).toEqual({
      ok: true,
      delivery: "input",
      file: { name: SHOT.name, size: SHOT_SIZE },
    });
    expect(input.events).toEqual(["input", "change"]);
  });

  /**
   * S2c review F3 — the input path reached by a *point* rather than by a ref (FR-170, FR-171).
   *
   * The resolution table and the two deliveries meet here: a coordinate is how an agent aims at a
   * page it has only a picture of, and what it lands on is as often a styled upload control as it
   * is a drop zone. What is asserted is that the point takes the input path rather than the drop
   * path - the input holds the file and hears `input` and `change`, and none of the drag sequence
   * is sent, because a control is not dropped on.
   */
  it("(a2) puts the picture on a file input the point lands on, and sends no drag events", () => {
    const context = boundContext();
    const input = fileInput();
    (document as { elementFromPoint?: unknown }).elementFromPoint = () => input.element;

    const reply = withTransfer(globalThis as Realm, () => deliver(context, { point: { x: 30, y: 40 } }));

    // No `point` on the answer: an input holds a file, it is not dropped at a place.
    expect(reply).toEqual({ ok: true, delivery: "input", file: { name: SHOT.name, size: SHOT_SIZE } });
    expect(input.events).toEqual(["input", "change"]);
  });

  /** The same, one level down: the descent reaches an input too, and builds the file in its realm. */
  it("(a3) puts the picture on a file input inside a frame it can read, in that frame's realm", () => {
    const context = boundContext();
    document.body.innerHTML = '<iframe id="child"></iframe>';
    const child = document.querySelector("#child");
    if (!(child instanceof HTMLIFrameElement)) throw new Error("fixture-missing");
    placeAt(child, { left: 20, top: 10, width: 300, height: 200 });
    const childDocument = child.contentDocument;
    const childWindow = child.contentWindow as unknown as Realm & { File?: unknown };
    if (!childDocument || !childWindow) throw new Error("frame-missing");
    const built: Array<{ name: string; type: string }> = [];
    class ChildFile {
      readonly name: string;
      readonly type: string;
      readonly size: number;
      constructor(parts: Array<{ length?: number }>, name: string, options?: { type?: string }) {
        this.name = name;
        this.type = options?.type ?? "";
        this.size = parts[0]?.length ?? 0;
        built.push({ name, type: this.type });
      }
    }
    childWindow.File = ChildFile;
    const events: string[] = [];
    // The child's own input, as this module sees one, and told which document it belongs to: that
    // is what makes the `File` the child realm's rather than the parent's.
    const inner = {
      tagName: "INPUT",
      type: "file",
      ownerDocument: childDocument,
      files: [] as unknown[],
      dispatchEvent(event: { type?: string }) {
        events.push(event.type ?? "");
        return true;
      },
    };
    (childDocument as { elementFromPoint?: unknown }).elementFromPoint = () => inner;
    (document as { elementFromPoint?: unknown }).elementFromPoint = () => child;

    const reply = withTransfer(childWindow, () => deliver(context, { point: { x: 120, y: 60 } }));

    expect(reply).toEqual({ ok: true, delivery: "input", file: { name: SHOT.name, size: SHOT_SIZE } });
    expect(events).toEqual(["input", "change"]);
    expect(built).toEqual([{ name: SHOT.name, type: SHOT.type }]);
    expect(inner.files[0]).toBeInstanceOf(ChildFile);
  });

  it("(b) drops the picture on the centre of any other element the ref names", () => {
    const context = boundContext();
    document.body.innerHTML = '<div id="zone"></div>';
    const zone = document.querySelector("#zone");
    if (!(zone instanceof HTMLElement)) throw new Error("fixture-missing");
    placeAt(zone, { left: 100, top: 20, width: 200, height: 120 });
    const seen = watchDrag(zone);
    issue(context, "t_zone", zone);

    const reply = withTransfer(globalThis as Realm, () => deliver(context, { handle: "t_zone" }));

    expect(reply).toEqual({
      ok: true,
      delivery: "drop",
      file: { name: SHOT.name, size: SHOT_SIZE },
      point: { x: 200, y: 80 },
    });
    // The three a real drop sends, in order, and no `dragleave`: the drop happened.
    expect(seen.map((event) => event.type)).toEqual(["dragenter", "dragover", "drop"]);
    for (const event of seen) {
      expect(event.clientX).toBe(200);
      expect(event.clientY).toBe(80);
      expect(event.files).toHaveLength(1);
      const file = event.files[0] as File;
      expect(file.name).toBe(SHOT.name);
      expect(file.type).toBe(SHOT.type);
    }
  });

  it("(c) drops the picture at the point the agent named", () => {
    const context = boundContext();
    document.body.innerHTML = '<div id="zone"></div>';
    const zone = document.querySelector("#zone");
    if (!(zone instanceof HTMLElement)) throw new Error("fixture-missing");
    placeAt(zone, { left: 100, top: 20, width: 200, height: 120 });
    const seen = watchDrag(zone);
    (document as { elementFromPoint?: unknown }).elementFromPoint = () => zone;

    const reply = withTransfer(globalThis as Realm, () => deliver(context, { point: { x: 140, y: 60 } }));

    expect(reply).toEqual({
      ok: true,
      delivery: "drop",
      file: { name: SHOT.name, size: SHOT_SIZE },
      point: { x: 140, y: 60 },
    });
    expect(seen.map((event) => event.type)).toEqual(["dragenter", "dragover", "drop"]);
    expect(seen[0]?.clientX).toBe(140);
    expect(seen[0]?.clientY).toBe(60);
  });

  it("(d) goes one level into a frame this document can read, in that frame's own realm", () => {
    const context = boundContext();
    document.body.innerHTML = '<iframe id="child"></iframe>';
    const child = document.querySelector("#child");
    if (!(child instanceof HTMLIFrameElement)) throw new Error("fixture-missing");
    placeAt(child, { left: 50, top: 40, width: 300, height: 200 });
    const childDocument = child.contentDocument;
    const childWindow = child.contentWindow as unknown as Realm & { File?: unknown };
    if (!childDocument || !childWindow) throw new Error("frame-missing");
    childDocument.body.innerHTML = '<div id="inner"></div>';
    const inner = childDocument.querySelector("#inner");
    if (!inner) throw new Error("inner-missing");
    const seen = watchDrag(inner);
    const asked: Array<{ x: number; y: number }> = [];
    (childDocument as { elementFromPoint?: unknown }).elementFromPoint = (x: number, y: number) => {
      asked.push({ x, y });
      return inner;
    };
    (document as { elementFromPoint?: unknown }).elementFromPoint = () => child;
    // The child's own constructors, told apart from the parent's: a `File` the parent built is a
    // file from another realm, which is exactly what a page's own handler may refuse.
    const built: Array<{ name: string; type: string }> = [];
    class ChildFile {
      readonly name: string;
      readonly type: string;
      constructor(_parts: unknown[], name: string, options?: { type?: string }) {
        this.name = name;
        this.type = options?.type ?? "";
        built.push({ name, type: this.type });
      }
    }
    childWindow.File = ChildFile;

    const reply = withTransfer(childWindow, () => deliver(context, { point: { x: 200, y: 140 } }));

    expect(reply).toEqual({
      ok: true,
      delivery: "drop",
      file: { name: SHOT.name, size: SHOT_SIZE },
      // The point the agent named, in the top document's coordinates, is what the answer echoes.
      point: { x: 200, y: 140 },
    });
    // Shifted by the frame's own rectangle: the child document's coordinates, not the parent's.
    expect(asked).toEqual([{ x: 150, y: 100 }]);
    expect(seen.map((event) => event.type)).toEqual(["dragenter", "dragover", "drop"]);
    expect(seen[0]?.clientX).toBe(150);
    expect(seen[0]?.clientY).toBe(100);
    expect(built).toEqual([{ name: SHOT.name, type: SHOT.type }]);
    expect(seen[0]?.files[0]).toBeInstanceOf(ChildFile);
  });

  /**
   * S2c review F2 — the frame's own padding is part of the descent (FR-171).
   *
   * A frame's document starts inside its border *and* its padding, so a point translated with only
   * the rectangle and the border lands `padding` pixels off inside the child - and the whole point
   * of the descent is that the agent's coordinate arrives where it was aimed. jsdom has no layout
   * to compute either, so both are stated on the element here; a real browser reports them.
   */
  it("(d2) subtracts the frame's border *and* its padding when it descends", () => {
    const context = boundContext();
    document.body.innerHTML = '<iframe id="child"></iframe>';
    const child = document.querySelector("#child");
    if (!(child instanceof HTMLIFrameElement)) throw new Error("fixture-missing");
    placeAt(child, { left: 100, top: 100, width: 300, height: 200 });
    Object.defineProperty(child, "clientLeft", { get: () => 2 });
    Object.defineProperty(child, "clientTop", { get: () => 2 });
    child.style.paddingLeft = "8px";
    child.style.paddingTop = "8px";
    const childDocument = child.contentDocument;
    if (!childDocument) throw new Error("frame-missing");
    childDocument.body.innerHTML = '<div id="inner"></div>';
    const inner = childDocument.querySelector("#inner");
    if (!inner) throw new Error("inner-missing");
    const seen = watchDrag(inner);
    const asked: Array<{ x: number; y: number }> = [];
    (childDocument as { elementFromPoint?: unknown }).elementFromPoint = (x: number, y: number) => {
      asked.push({ x, y });
      return inner;
    };
    (document as { elementFromPoint?: unknown }).elementFromPoint = () => child;

    const reply = withTransfer(child.contentWindow as unknown as Realm, () =>
      deliver(context, { point: { x: 200, y: 200 } }),
    );

    expect(reply).toMatchObject({ ok: true, delivery: "drop", point: { x: 200, y: 200 } });
    // 100 of rectangle, 2 of border, 8 of padding: 110 in each direction.
    expect(asked).toEqual([{ x: 90, y: 90 }]);
    expect(seen[0]?.clientX).toBe(90);
    expect(seen[0]?.clientY).toBe(90);
  });

  it("(e) refuses a frame it cannot read, by name", () => {
    const context = boundContext();
    document.body.innerHTML = '<iframe id="foreign"></iframe>';
    const foreign = document.querySelector("#foreign");
    if (!(foreign instanceof HTMLIFrameElement)) throw new Error("fixture-missing");
    placeAt(foreign, { left: 0, top: 0, width: 300, height: 200 });
    Object.defineProperty(foreign, "contentDocument", { get: () => null });
    (document as { elementFromPoint?: unknown }).elementFromPoint = () => foreign;

    expect(withTransfer(globalThis as Realm, () => deliver(context, { point: { x: 10, y: 10 } }))).toEqual({
      ok: false,
      reason: "not-reachable",
    });
  });

  it("(f) refuses a frame inside the frame: one level, and no further", () => {
    const context = boundContext();
    document.body.innerHTML = '<iframe id="child"></iframe>';
    const child = document.querySelector("#child");
    if (!(child instanceof HTMLIFrameElement)) throw new Error("fixture-missing");
    placeAt(child, { left: 0, top: 0, width: 300, height: 200 });
    const childDocument = child.contentDocument;
    if (!childDocument) throw new Error("frame-missing");
    const nested = childDocument.createElement("iframe");
    childDocument.body.append(nested);
    (childDocument as { elementFromPoint?: unknown }).elementFromPoint = () => nested;
    (document as { elementFromPoint?: unknown }).elementFromPoint = () => child;

    expect(withTransfer(globalThis as Realm, () => deliver(context, { point: { x: 10, y: 10 } }))).toEqual({
      ok: false,
      reason: "not-reachable",
    });
  });

  it("(g) refuses a point outside the viewport, and says how big the viewport is", () => {
    const context = boundContext();

    expect(
      withTransfer(globalThis as Realm, () => deliver(context, { point: { x: window.innerWidth + 5, y: 10 } })),
    ).toEqual({
      ok: false,
      reason: "point-outside-viewport",
      frame: { width: window.innerWidth, height: window.innerHeight },
    });
    expect(
      withTransfer(globalThis as Realm, () => deliver(context, { point: { x: 10, y: -1 } })),
    ).toEqual({
      ok: false,
      reason: "point-outside-viewport",
      frame: { width: window.innerWidth, height: window.innerHeight },
    });
  });

  it("(h) refuses a point with nothing under it", () => {
    const context = boundContext();
    (document as { elementFromPoint?: unknown }).elementFromPoint = () => null;

    expect(withTransfer(globalThis as Realm, () => deliver(context, { point: { x: 10, y: 10 } }))).toEqual({
      ok: false,
      reason: "not-a-drop-target",
    });
  });

  it("(i) refuses a handle this document no longer knows", () => {
    const context = boundContext();

    expect(withTransfer(globalThis as Realm, () => deliver(context, { handle: "t_gone" }))).toEqual({
      ok: false,
      reason: "stale-target",
    });
  });

  it("(j) says so when the realm cannot build a file at all", () => {
    const context = boundContext();
    document.body.innerHTML = '<div id="zone"></div>';
    const zone = document.querySelector("#zone");
    if (!(zone instanceof HTMLElement)) throw new Error("fixture-missing");
    placeAt(zone, { left: 0, top: 0, width: 10, height: 10 });
    context.registry.issue({
      targetHandle: "t_zone",
      snapshotId: "snap-1",
      documentEpoch: DOC_EPOCH,
      element: zone,
      target: { tagName: "DIV" },
    });

    // No `DataTransfer` in this realm: a `FileList` cannot be built any other way, so the delivery
    // is refused out loud rather than answered as an empty success.
    expect(deliver(context, { handle: "t_zone" })).toEqual({ ok: false, reason: "unsupported" });
  });
});
