/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { snapshotDocument } from "../src/content-runtime/collector.js";
import { bindAgentContentRuntime, indicatorHost } from "../src/content-runtime/agent-entry.js";
import {
  applyIndicator,
  INDICATOR_GLOW_ATTRIBUTE,
  INDICATOR_MARKER_ATTRIBUTE,
  INDICATOR_PILL_ATTRIBUTE,
  isIndicatorMessage,
  placeFor,
  placePill,
} from "../src/content-runtime/indicator.js";

/**
 * 004/T106 — the in-page indicator (US3, FR-062, R-117).
 *
 * Every tab a session holds says so on the page itself, with one control that brings the session's
 * main tab forward. Two of the claims here are not about what the owner sees:
 *
 * - the control acts on a **trusted** click only. A page script can call `click()` on anything in
 *   its own document, so a control that answered a synthetic event would let the page steer the
 *   owner's focus - the indicator would become an attack the extension installed.
 * - the indicator is never part of a collection. It is the extension's own furniture; an agent
 *   reading its own indicator back out of `read_page` would be reading its own tail.
 */

type Sent = Array<{ type: string }>;

function host(): { doc: Document; sent: Sent; send: (message: { type: string }) => void } {
  const sent: Sent = [];
  return { doc: document, sent, send: (message) => void sent.push(message) };
}

function control(): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[${INDICATOR_PILL_ATTRIBUTE}] button`);
  expect(found, "the indicator must offer one control").not.toBeNull();
  return found as HTMLElement;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("T106 the in-page indicator", () => {
  it("renders on show and is gone again on hide", () => {
    const page = host();

    applyIndicator({ type: "indicator", show: true, label: "Agent is working", action: "Back to the agent" }, page);

    const element = document.querySelector(`[${INDICATOR_PILL_ATTRIBUTE}]`);
    expect(element, "the indicator must be in the document").not.toBeNull();
    expect(element?.textContent).toContain("Agent is working");
    expect(control().textContent).toContain("Back to the agent");

    // Shown twice is still one indicator: the worker re-states the label on every claim, and a
    // second element would stack on the first for as long as the session held the tab.
    applyIndicator({ type: "indicator", show: true, label: "Agent is still working", action: "Back" }, page);
    expect(document.querySelectorAll(`[${INDICATOR_PILL_ATTRIBUTE}]`).length).toBe(1);
    expect(document.querySelectorAll(`[${INDICATOR_GLOW_ATTRIBUTE}]`).length, "and one glow").toBe(1);

    applyIndicator({ type: "indicator", show: false }, page);
    expect(document.querySelector(`[${INDICATOR_PILL_ATTRIBUTE}]`)).toBeNull();
    expect(document.querySelector(`[${INDICATOR_GLOW_ATTRIBUTE}]`), "the glow goes with the banner").toBeNull();
  });

  it("stays out of the page's way except for its own control", () => {
    const page = host();
    applyIndicator({ type: "indicator", show: true, label: "Agent", action: "Back" }, page);

    const element = document.querySelector<HTMLElement>(`[${INDICATOR_PILL_ATTRIBUTE}]`);
    expect(element?.style.position).toBe("fixed");
    expect(element?.style.pointerEvents).toBe("none");
    expect(control().style.pointerEvents).toBe("auto");
  });

  it("sends ui.agent.focus-main for the owner's own click and for nothing else", () => {
    const page = host();
    applyIndicator({ type: "indicator", show: true, label: "Agent", action: "Back" }, page);

    // What a page script can do: it can reach the element and click it, by either route. Every
    // event a script makes is untrusted, and that is the whole difference the control turns on.
    control().click();
    control().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(page.sent, "a synthetic click must move nobody's focus").toEqual([]);

    /**
     * The owner's own click, which no test can forge: jsdom defines `isTrusted` as an
     * unforgeable own getter, exactly as the browser does. So the trust question is asked through
     * one seam whose default *is* `event.isTrusted`, and the trusted half is driven by replacing
     * that seam and dispatching the very same real click - which leaves the trust check as the
     * only difference between the two halves of this test.
     */
    const trusting = { ...host(), isTrustedEvent: () => true };
    applyIndicator({ type: "indicator", show: true, label: "Agent", action: "Back" }, trusting);
    control().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(trusting.sent).toEqual([{ type: "ui.agent.focus-main" }]);
  });

  it("is never part of a collection", () => {
    const page = host();
    document.body.innerHTML = '<p>Ordinary page text</p><button id="real">Real button</button>';
    applyIndicator({ type: "indicator", show: true, label: "Agent is working", action: "Back to the agent" }, page);

    const snapshot = snapshotDocument(document, "https://page.test", 200, undefined, "all-controls");

    expect(snapshot.visibleText).toContain("Ordinary page text");
    expect(snapshot.visibleText, "the indicator's own copy is not page text").not.toContain("Agent is working");
    // 004/T117d: the page's own paragraph and button - the walk sees prose now - and nothing of the
    // indicator, which is what this test is about.
    expect(snapshot.targets.map((target) => target.role), "the page's own elements, and only them").toEqual([
      "paragraph",
      "button",
    ]);
    expect(snapshot.targets.find((target) => target.role === "button")?.text).toContain("Real button");
    expect(snapshot.controls).toEqual([]);
  });
});

/**
 * 2026-09-16 — the glow around the page while an agent holds the tab (owner's choice: keep the
 * pill and the tab group, add the four-edge inset glow the reference draws).
 */
describe("the page-edge glow", () => {
  it("lights the four edges as a fixed, click-through layer, in the pointer's red", () => {
    const page = host();
    applyIndicator({ type: "indicator", show: true, label: "Agent", action: "Back" }, page);

    const glow = document.querySelector<HTMLElement>(`[${INDICATOR_GLOW_ATTRIBUTE}]`);
    expect(glow, "the glow is drawn with the banner").not.toBeNull();
    expect(glow?.style.position).toBe("fixed");
    expect(glow?.style.inset).toMatch(/^0(px)?$/);
    expect(glow?.style.pointerEvents).toBe("none");
    expect(glow?.style.boxShadow).toContain("inset");
    expect(glow?.style.boxShadow).toContain("rgba(255, 59, 48");
    expect(glow?.getAttribute(INDICATOR_MARKER_ATTRIBUTE), "excluded from every collection").toBe("");
    expect(glow?.getAttribute("aria-hidden")).toBe("true");
    expect(glow?.children.length, "nothing inside it to read or click").toBe(0);
  });

  it("is the page's edge, so a child frame draws the pill but never a glow", () => {
    const framed = { ...host(), isTopFrame: false };
    applyIndicator({ type: "indicator", show: true, label: "Agent", action: "Back" }, framed);

    expect(document.querySelector(`[${INDICATOR_PILL_ATTRIBUTE}]`)).not.toBeNull();
    expect(document.querySelector(`[${INDICATOR_GLOW_ATTRIBUTE}]`), "one page, one glow").toBeNull();
  });

  it("goes down with the banner and leaves the pointer alone", () => {
    const page = host();
    applyIndicator({ type: "indicator", show: true, label: "Agent", action: "Back" }, page);
    // The pointer wears the same exclusion marker; the banner's removal is by the banner's names.
    const pointer = document.createElement("div");
    pointer.setAttribute(INDICATOR_MARKER_ATTRIBUTE, "");
    pointer.setAttribute("data-hallpass-cursor", "");
    document.body.appendChild(pointer);

    applyIndicator({ type: "indicator", show: false }, page);

    expect(document.querySelector(`[${INDICATOR_GLOW_ATTRIBUTE}]`)).toBeNull();
    expect(document.querySelector(`[${INDICATOR_PILL_ATTRIBUTE}]`)).toBeNull();
    expect(document.querySelector("[data-hallpass-cursor]"), "the pointer has its own lifetime").not.toBeNull();
  });

  it("is never part of a collection either", () => {
    const page = host();
    document.body.innerHTML = '<p>Ordinary page text</p><button id="real">Real button</button>';
    applyIndicator({ type: "indicator", show: true, label: "Agent is working", action: "Back" }, page);

    const snapshot = snapshotDocument(document, "https://page.test", 200, undefined, "all-controls");

    expect(snapshot.targets.map((target) => target.role)).toEqual(["paragraph", "button"]);
  });
});

/**
 * 004/T107b — the page's half of "the page asks".
 *
 * A navigation reloads this script at `document_start` and the indicator goes with the old
 * document. Rather than have the worker watch every navigation, the freshly loaded script says it
 * is there and the worker answers with that tab's state - the same shape as T107a's lesson, and it
 * heals a worker that was evicted just as well as a page that navigated.
 */
describe("T107b the content script announces itself", () => {
  it("announces on load so the worker can re-raise the indicator", () => {
    const sent: unknown[] = [];
    const runtime = {
      id: "hallpass-test-extension",
      sendMessage: (message: unknown) => void sent.push(message),
      onMessage: { addListener: () => undefined },
    };

    bindAgentContentRuntime(runtime, document);

    expect(sent).toEqual([{ type: "ui.agent.announce" }]);
  });

  it("says nothing when there is no extension runtime to say it to", () => {
    const sent: unknown[] = [];
    const runtime = { sendMessage: (message: unknown) => void sent.push(message) };

    bindAgentContentRuntime(runtime, document);

    expect(sent).toEqual([]);
  });
});

/**
 * 034 T1013 - Stop and Resume on the pill (US5, R-517, R-518, R-522).
 *
 * The words, the mode and the not-delivered text all come from the worker with the indicator message;
 * the page decides nothing but whether a click was the owner's, and whether an answer arrived in time.
 */
describe("034 the pill's Stop and Resume", () => {
  type Reply = { accepted: boolean } | undefined;
  type Press = { type: "ui.agent.pill-stop" } | { type: "ui.agent.pill-resume" } | { type: "ui.agent.pill-move"; to: "top" | "bottom" };

  const words = {
    label: "Agent is working",
    action: "Back to the agent",
    stop: "Stop",
    resume: "Resume",
    heldLabel: "Stopped",
    stopUndelivered: "Stop did not arrive",
    resumeUndelivered: "Resume did not arrive",
  };

  function pillHost(answer: (press: Press, attempt: number) => Promise<Reply>, trusted = true) {
    const pressed: Press[] = [];
    return {
      doc: document,
      sent: [] as unknown[],
      send(message: { type: "ui.agent.focus-main" }) {
        this.sent.push(message);
      },
      press(message: Press): Promise<Reply> {
        pressed.push(message);
        return answer(message, pressed.length);
      },
      pressed,
      ...(trusted ? { isTrustedEvent: () => true } : {}),
    };
  }

  const never = (): Promise<Reply> => new Promise(() => undefined);

  function pill(): HTMLElement {
    const found = document.querySelector<HTMLElement>(`[${INDICATOR_PILL_ATTRIBUTE}]`);
    expect(found, "the pill must be drawn").not.toBeNull();
    return found as HTMLElement;
  }

  function buttonNamed(text: string): HTMLElement | undefined {
    return Array.from(pill().querySelectorAll<HTMLElement>("button")).find((button) => button.textContent === text);
  }

  function click(element: HTMLElement | undefined): void {
    expect(element, "the control must be on the pill").toBeDefined();
    element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("draws Stop only when the message carries stop text", () => {
    const page = pillHost(never);
    applyIndicator({ type: "indicator", show: true, label: words.label, action: words.action }, page);
    expect(buttonNamed("Stop"), "an older worker sends no Stop").toBeUndefined();
    expect(pill().querySelectorAll("button").length, "only the back control").toBe(1);

    applyIndicator({ type: "indicator", show: true, label: words.label, action: words.action, stop: "Halt" }, page);
    expect(buttonNamed("Halt")).toBeDefined();
    expect(buttonNamed(words.action), "the back control stays").toBeDefined();
    expect(buttonNamed("Resume")).toBeUndefined();
  });

  it("draws the held label and Resume, and no Stop, in mode held", () => {
    const page = pillHost(never);
    applyIndicator({ type: "indicator", show: true, mode: "held", ...words }, page);

    expect(pill().textContent).toContain(words.heldLabel);
    expect(pill().textContent).not.toContain(words.label);
    expect(buttonNamed("Resume")).toBeDefined();
    expect(buttonNamed("Stop")).toBeUndefined();
    expect(buttonNamed(words.action), "the back control stays").toBeDefined();
  });

  it("draws Stop and never Resume in mode conversation", () => {
    const page = pillHost(never);
    applyIndicator({ type: "indicator", show: true, mode: "conversation", ...words }, page);

    expect(buttonNamed("Stop")).toBeDefined();
    expect(buttonNamed("Resume")).toBeUndefined();
    expect(pill().textContent).toContain(words.label);
  });

  it("draws an unknown mode as working", () => {
    const page = pillHost(never);
    applyIndicator({ type: "indicator", show: true, mode: "sideways", ...words }, page);

    expect(pill().textContent).toContain(words.label);
    expect(buttonNamed("Stop")).toBeDefined();
    expect(buttonNamed("Resume")).toBeUndefined();
  });

  it("refuses a new field of the wrong type, as it refuses a wrong show", () => {
    const page = pillHost(never);
    expect(applyIndicator({ type: "indicator", show: true, stop: 7 }, page)).toBe(false);
    expect(applyIndicator({ type: "indicator", show: true, heldLabel: {} }, page)).toBe(false);
    expect(applyIndicator({ type: "indicator", show: true, mode: 3 }, page)).toBe(false);
    expect(document.querySelector(`[${INDICATOR_PILL_ATTRIBUTE}]`)).toBeNull();
  });

  it("sends nothing for an untrusted click on Stop or Resume", async () => {
    const page = pillHost(never, false);
    applyIndicator({ type: "indicator", show: true, ...words }, page);
    buttonNamed("Stop")?.click();
    click(buttonNamed("Stop"));
    applyIndicator({ type: "indicator", show: true, mode: "held", ...words }, page);
    buttonNamed("Resume")?.click();
    click(buttonNamed("Resume"));
    await vi.advanceTimersByTimeAsync(3000);

    expect(page.pressed).toEqual([]);
    expect(pill().textContent, "and nothing is claimed undelivered").not.toContain(words.resumeUndelivered);
  });

  it("sends exactly the stop press for a trusted click and awaits the reply", async () => {
    const page = pillHost(async () => ({ accepted: true }));
    applyIndicator({ type: "indicator", show: true, ...words }, page);
    click(buttonNamed("Stop"));
    await vi.advanceTimersByTimeAsync(0);

    expect(page.pressed).toEqual([{ type: "ui.agent.pill-stop" }]);
    expect(page.sent, "Stop is not the focus-main control").toEqual([]);
  });

  it("sends exactly the resume press for a trusted click on Resume", async () => {
    const page = pillHost(async () => ({ accepted: true }));
    applyIndicator({ type: "indicator", show: true, mode: "held", ...words }, page);
    click(buttonNamed("Resume"));
    await vi.advanceTimersByTimeAsync(0);

    expect(page.pressed).toEqual([{ type: "ui.agent.pill-resume" }]);
  });

  it("shows nothing extra when accepted: true arrives within a second", async () => {
    const page = pillHost(async () => ({ accepted: true }));
    applyIndicator({ type: "indicator", show: true, ...words }, page);
    click(buttonNamed("Stop"));
    await vi.advanceTimersByTimeAsync(3000);

    expect(page.pressed.length, "no resend after an answer").toBe(1);
    expect(pill().textContent).not.toContain(words.stopUndelivered);
  });

  it("shows nothing extra for accepted: false", async () => {
    const page = pillHost(async () => ({ accepted: false }));
    applyIndicator({ type: "indicator", show: true, ...words }, page);
    click(buttonNamed("Stop"));
    await vi.advanceTimersByTimeAsync(3000);

    expect(page.pressed.length).toBe(1);
    expect(pill().textContent).not.toContain(words.stopUndelivered);
  });

  it("sends the same press once more after a silent second, and shows the stop words after two", async () => {
    const page = pillHost(never);
    applyIndicator({ type: "indicator", show: true, ...words }, page);
    click(buttonNamed("Stop"));

    await vi.advanceTimersByTimeAsync(999);
    expect(page.pressed.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(page.pressed).toEqual([{ type: "ui.agent.pill-stop" }, { type: "ui.agent.pill-stop" }]);
    expect(pill().textContent, "not yet").not.toContain(words.stopUndelivered);

    await vi.advanceTimersByTimeAsync(999);
    expect(pill().textContent).not.toContain(words.stopUndelivered);
    await vi.advanceTimersByTimeAsync(1);
    expect(pill().textContent).toContain(words.stopUndelivered);
    await vi.advanceTimersByTimeAsync(5000);
    expect(page.pressed.length, "one resend, never more").toBe(2);
  });

  it("shows the resume words when a Resume press goes unanswered", async () => {
    const page = pillHost(never);
    applyIndicator({ type: "indicator", show: true, mode: "held", ...words }, page);
    click(buttonNamed("Resume"));
    await vi.advanceTimersByTimeAsync(2000);

    expect(page.pressed).toEqual([{ type: "ui.agent.pill-resume" }, { type: "ui.agent.pill-resume" }]);
    expect(pill().textContent).toContain(words.resumeUndelivered);
    expect(pill().textContent).not.toContain(words.stopUndelivered);
  });

  it("counts a rejected send as no reply", async () => {
    const page = pillHost(() => Promise.reject(new Error("Extension context invalidated.")));
    applyIndicator({ type: "indicator", show: true, ...words }, page);
    click(buttonNamed("Stop"));

    await vi.advanceTimersByTimeAsync(1000);
    expect(page.pressed.length, "resent like a silent one").toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(pill().textContent).toContain(words.stopUndelivered);
  });

  it("takes an answer to the resend as an answer", async () => {
    const page = pillHost((_press, attempt) => (attempt === 1 ? never() : Promise.resolve({ accepted: true })));
    applyIndicator({ type: "indicator", show: true, ...words }, page);
    click(buttonNamed("Stop"));
    await vi.advanceTimersByTimeAsync(5000);

    expect(page.pressed.length).toBe(2);
    expect(pill().textContent).not.toContain(words.stopUndelivered);
  });

  it("does not draw on a pill the worker has already redrawn or taken down", async () => {
    const page = pillHost(never);
    applyIndicator({ type: "indicator", show: true, ...words }, page);
    click(buttonNamed("Stop"));
    applyIndicator({ type: "indicator", show: false }, page);
    await vi.advanceTimersByTimeAsync(5000);

    expect(document.querySelector(`[${INDICATOR_PILL_ATTRIBUTE}]`)).toBeNull();
    expect(page.pressed.length, "a pill that is gone does not resend").toBe(1);
  });

  it("shows words with markup characters literally", async () => {
    const page = pillHost(never);
    const markup = "<img src=x onerror=alert(1)> & <b>bold</b>";
    applyIndicator(
      { type: "indicator", show: true, mode: "held", ...words, heldLabel: markup, resume: markup, resumeUndelivered: markup },
      page,
    );
    expect(pill().querySelector("img, b"), "no element came from the words").toBeNull();
    expect(pill().textContent).toContain(markup);

    click(buttonNamed(markup));
    await vi.advanceTimersByTimeAsync(2000);
    expect(pill().querySelector("img, b")).toBeNull();
    expect(pill().textContent?.split(markup).length, "heldLabel, the control and the not-delivered words").toBe(4);
  });
});

/** 034 T1013 - the entry turns a press into a reply, and a rejected send into "no reply". */
describe("034 the entry's press", () => {
  it("resolves with the worker's reply and sends the press as the only message", async () => {
    const sent: unknown[] = [];
    const runtime = {
      id: "hallpass-test-extension",
      sendMessage: (message: unknown) => {
        sent.push(message);
        return Promise.resolve({ accepted: true });
      },
      onMessage: { addListener: () => undefined },
    };
    const reply = await indicatorHost(runtime, document).press?.({ type: "ui.agent.pill-stop" });

    expect(reply).toEqual({ accepted: true });
    expect(sent).toEqual([{ type: "ui.agent.pill-stop" }]);
  });

  it("resolves as no reply when the send is rejected or throws", async () => {
    const rejecting = { sendMessage: () => Promise.reject(new Error("gone")) };
    const throwing = {
      sendMessage: () => {
        throw new Error("gone");
      },
    };

    expect(await indicatorHost(rejecting, document).press?.({ type: "ui.agent.pill-resume" })).toBeUndefined();
    expect(await indicatorHost(throwing, document).press?.({ type: "ui.agent.pill-resume" })).toBeUndefined();
  });

  it("resolves as no reply for an answer that is not a { accepted } reply", async () => {
    const runtime = { sendMessage: () => Promise.resolve("hello") };

    expect(await indicatorHost(runtime, document).press?.({ type: "ui.agent.pill-stop" })).toBeUndefined();
  });

  it("035 resolves the move press and the open press the same way", async () => {
    const sent: unknown[] = [];
    const runtime = {
      sendMessage: (message: unknown) => {
        sent.push(message);
        return Promise.resolve((message as { type: string }).type === "ui.agent.pill-open-panel" ? { opened: true } : { accepted: true });
      },
    };
    const entry = indicatorHost(runtime, document);

    expect(await entry.press?.({ type: "ui.agent.pill-move", to: "bottom" })).toEqual({ accepted: true });
    expect(await entry.openPanel?.()).toEqual({ opened: true });
    expect(sent).toEqual([{ type: "ui.agent.pill-move", to: "bottom" }, { type: "ui.agent.pill-open-panel" }]);

    const rejecting = indicatorHost({ sendMessage: () => Promise.reject(new Error("gone")) }, document);
    expect(await rejecting.openPanel?.()).toBeUndefined();
    const odd = indicatorHost({ sendMessage: () => Promise.resolve({ accepted: true }) }, document);
    expect(await odd.openPanel?.(), "a reply that is not { opened } is no reply").toBeUndefined();
  });
});

/**
 * 035 - move the pill and open the side panel from it (US1-US3, R-524..R-531).
 *
 * The words, the edge and the not-opened text come from the worker with the indicator message; the
 * page decides whether a click was the owner's, where the pill sits, and whether an answer arrived.
 */
describe("035 the pill's edge, move control and open control", () => {
  type MovePress = { type: "ui.agent.pill-move"; to: "top" | "bottom" };
  type Press = { type: "ui.agent.pill-stop" } | { type: "ui.agent.pill-resume" } | MovePress;
  type PressReply = { accepted: boolean } | undefined;
  type OpenReply = { opened: boolean } | undefined;

  const words = {
    label: "Agent is working",
    action: "Back to the agent",
    stop: "Stop",
    moveToTop: "Move to top",
    moveToBottom: "Move to bottom",
    openPanel: "Open side panel",
    panelUnopened: "Side panel did not open",
  };

  function pillHost(
    answerPress: (press: Press, attempt: number) => Promise<PressReply> = () => new Promise(() => undefined),
    answerOpen: () => Promise<OpenReply> = () => new Promise(() => undefined),
    trusted = true,
  ) {
    const pressed: Press[] = [];
    const opened: number[] = [];
    return {
      doc: document,
      sent: [] as unknown[],
      send(message: { type: "ui.agent.focus-main" }) {
        this.sent.push(message);
      },
      press(message: Press): Promise<PressReply> {
        pressed.push(message);
        return answerPress(message, pressed.length);
      },
      openPanel(): Promise<OpenReply> {
        opened.push(opened.length + 1);
        return answerOpen();
      },
      pressed,
      opened,
      ...(trusted ? { isTrustedEvent: () => true } : {}),
    };
  }

  function pill(): HTMLElement {
    const found = document.querySelector<HTMLElement>(`[${INDICATOR_PILL_ATTRIBUTE}]`);
    expect(found, "the pill must be drawn").not.toBeNull();
    return found as HTMLElement;
  }

  function buttonNamed(text: string): HTMLElement | undefined {
    return Array.from(pill().querySelectorAll<HTMLElement>("button")).find((button) => button.textContent === text);
  }

  function click(element: HTMLElement | undefined): void {
    expect(element, "the control must be on the pill").toBeDefined();
    element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    placePill(document, undefined);
  });

  describe("T1028 the message guard", () => {
    it("accepts the new fields with their types, and unknown fields", () => {
      expect(isIndicatorMessage({ type: "indicator", show: true, edge: "bottom", ...words, somethingNew: 1 })).toBe(true);
    });

    it("treats a new field of the wrong type as absent, not as a refusal", () => {
      const page = pillHost();
      const message = {
        type: "indicator",
        show: true,
        label: "A",
        action: "Back",
        edge: 7,
        moveToTop: 1,
        moveToBottom: {},
        openPanel: [],
        panelUnopened: false,
      };
      expect(isIndicatorMessage(message)).toBe(true);
      expect(applyIndicator(message, page)).toBe(true);
      expect(pill().style.top, "a wrong edge is the top").toBe("8px");
      expect(pill().querySelectorAll("button").length, "no move or open control without their words").toBe(1);
    });
  });

  describe("T1033 the edge and the move control", () => {
    it("draws at top: 8px, right: 8px for edge top and for no edge", () => {
      applyIndicator({ type: "indicator", show: true, ...words, edge: "top" }, pillHost());
      expect(pill().style.top).toBe("8px");
      expect(pill().style.bottom).toBe("");
      expect(pill().style.right).toBe("8px");

      applyIndicator({ type: "indicator", show: true, ...words }, pillHost());
      expect(pill().style.top).toBe("8px");
      expect(pill().style.bottom).toBe("");
    });

    it("draws at bottom: 8px, right: 8px for edge bottom", () => {
      applyIndicator({ type: "indicator", show: true, ...words, edge: "bottom" }, pillHost());
      expect(pill().style.bottom).toBe("8px");
      expect(pill().style.top).toBe("");
      expect(pill().style.right).toBe("8px");
    });

    it("shows moveToBottom at the top and moveToTop at the bottom", () => {
      applyIndicator({ type: "indicator", show: true, ...words, edge: "top" }, pillHost());
      expect(buttonNamed(words.moveToBottom)).toBeDefined();
      expect(buttonNamed(words.moveToTop)).toBeUndefined();

      applyIndicator({ type: "indicator", show: true, ...words, edge: "bottom" }, pillHost());
      expect(buttonNamed(words.moveToTop)).toBeDefined();
      expect(buttonNamed(words.moveToBottom)).toBeUndefined();
    });

    it("draws the move control only when both move strings are present", () => {
      const { moveToTop: _top, ...withoutTop } = words;
      applyIndicator({ type: "indicator", show: true, ...withoutTop }, pillHost());
      expect(buttonNamed(words.moveToBottom)).toBeUndefined();

      const { moveToBottom: _bottom, ...withoutBottom } = words;
      applyIndicator({ type: "indicator", show: true, ...withoutBottom, edge: "bottom" }, pillHost());
      expect(buttonNamed(words.moveToTop)).toBeUndefined();
    });

    it("orders the controls Stop, back, Open side panel, Move to", () => {
      applyIndicator({ type: "indicator", show: true, ...words }, pillHost());
      expect(Array.from(pill().querySelectorAll("button")).map((button) => button.textContent)).toEqual([
        words.stop,
        words.action,
        words.openPanel,
        words.moveToBottom,
      ]);
    });

    it("sends the move press naming the edge the control shows, after a trusted click", async () => {
      const page = pillHost(async () => ({ accepted: true }));
      applyIndicator({ type: "indicator", show: true, ...words, edge: "top" }, page);
      click(buttonNamed(words.moveToBottom));
      await vi.advanceTimersByTimeAsync(3000);
      expect(page.pressed).toEqual([{ type: "ui.agent.pill-move", to: "bottom" }]);
      expect(page.sent).toEqual([]);

      const other = pillHost(async () => ({ accepted: true }));
      applyIndicator({ type: "indicator", show: true, ...words, edge: "bottom" }, other);
      click(buttonNamed(words.moveToTop));
      await vi.advanceTimersByTimeAsync(0);
      expect(other.pressed).toEqual([{ type: "ui.agent.pill-move", to: "top" }]);
    });

    it("uses 034's timing: resend at 1 s, give up at 2 s with nothing added to the pill", async () => {
      const page = pillHost();
      applyIndicator({ type: "indicator", show: true, ...words }, page);
      const before = pill().textContent;
      click(buttonNamed(words.moveToBottom));

      await vi.advanceTimersByTimeAsync(999);
      expect(page.pressed.length).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(page.pressed).toEqual([
        { type: "ui.agent.pill-move", to: "bottom" },
        { type: "ui.agent.pill-move", to: "bottom" },
      ]);
      await vi.advanceTimersByTimeAsync(5000);
      expect(page.pressed.length, "one resend, never more").toBe(2);
      expect(pill().textContent, "no extra message on give-up").toBe(before);
    });

    it("sends nothing for an untrusted click", async () => {
      const page = pillHost(undefined, undefined, false);
      applyIndicator({ type: "indicator", show: true, ...words }, page);
      buttonNamed(words.moveToBottom)?.click();
      click(buttonNamed(words.moveToBottom));
      await vi.advanceTimersByTimeAsync(3000);
      expect(page.pressed).toEqual([]);
    });
  });

  describe("T1035 placeFor", () => {
    const viewport = { width: 1000, height: 800 };
    // Top area: x 692..998, y 0..46. Bottom area: x 692..998, y 754..800.
    const pillBox = { x: 700, y: 8, width: 290, height: 30 };
    const at = (x: number, y: number) => ({ point: { x, y } });

    it("is the owner's edge with no points", () => {
      expect(placeFor("top", pillBox, viewport, undefined)).toBe("top");
      expect(placeFor("bottom", pillBox, viewport, undefined)).toBe("bottom");
    });

    it("steps to the other edge for a point inside the owner's area, grown by 8 px", () => {
      expect(placeFor("top", pillBox, viewport, at(800, 20))).toBe("bottom");
      expect(placeFor("top", pillBox, viewport, at(692, 46))).toBe("bottom");
      expect(placeFor("bottom", pillBox, viewport, at(800, 780))).toBe("top");
    });

    it("stays at the owner's edge for a point 1 px outside the grown area", () => {
      expect(placeFor("top", pillBox, viewport, at(800, 47))).toBe("top");
      expect(placeFor("top", pillBox, viewport, at(691, 20))).toBe("top");
      expect(placeFor("top", pillBox, viewport, at(999, 20))).toBe("top");
      expect(placeFor("bottom", pillBox, viewport, at(800, 753))).toBe("bottom");
    });

    it("counts a box that overlaps the area while its centre is outside", () => {
      const points = { point: { x: 550, y: 130 }, box: { x: 100, y: 30, width: 900, height: 200 } };
      expect(placeFor("top", pillBox, viewport, points)).toBe("bottom");
      expect(placeFor("top", pillBox, viewport, { point: points.point })).toBe("top");
    });

    it("stays at the owner's edge when the points overlap both areas", () => {
      const short = { width: 1000, height: 80 };
      // Top area y 0..46; bottom area y 34..80: y 40 is in both.
      expect(placeFor("top", pillBox, short, at(800, 40))).toBe("top");
      expect(placeFor("bottom", pillBox, short, at(800, 40))).toBe("bottom");
      const tall = { point: { x: 800, y: 400 }, box: { x: 750, y: 0, width: 100, height: 800 } };
      expect(placeFor("top", pillBox, viewport, tall)).toBe("top");
      expect(placeFor("bottom", pillBox, viewport, tall)).toBe("bottom");
    });
  });

  describe("T1036 the pill's place on the page", () => {
    beforeEach(() => {
      vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
        const box = this.hasAttribute(INDICATOR_PILL_ATTRIBUTE)
          ? { x: 700, y: 8, width: 290, height: 30 }
          : { x: 0, y: 0, width: 0, height: 0 };
        return { ...box, left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height, toJSON: () => box };
      });
    });

    it("moves the pill and its control, and the control names the edge the pill is not at", async () => {
      const page = pillHost(async () => ({ accepted: true }));
      applyIndicator({ type: "indicator", show: true, ...words }, page);

      placePill(document, { point: { x: 800, y: 20 } });
      expect(pill().style.bottom).toBe("8px");
      expect(pill().style.top).toBe("");
      expect(buttonNamed(words.moveToTop)).toBeDefined();
      expect(buttonNamed(words.moveToBottom)).toBeUndefined();

      // US2 scenario 4: pressed while stepped aside, the control names the edge the pill is not at.
      click(buttonNamed(words.moveToTop));
      await vi.advanceTimersByTimeAsync(0);
      expect(page.pressed).toEqual([{ type: "ui.agent.pill-move", to: "top" }]);

      placePill(document, undefined);
      expect(pill().style.top).toBe("8px");
      expect(pill().style.bottom).toBe("");
      expect(buttonNamed(words.moveToBottom)).toBeDefined();
    });

    it("keeps the agent's last points across a redraw from a new indicator message", () => {
      applyIndicator({ type: "indicator", show: true, ...words }, pillHost());
      placePill(document, { point: { x: 800, y: 20 } });

      applyIndicator({ type: "indicator", show: true, ...words, label: "Still working" }, pillHost());
      expect(pill().style.bottom, "the redraw does not undo the step aside").toBe("8px");

      // The owner moved to the bottom: the kept point at the top-right is clear of the bottom area.
      applyIndicator({ type: "indicator", show: true, ...words, edge: "bottom" }, pillHost());
      expect(pill().style.bottom).toBe("8px");
      placePill(document, { point: { x: 800, y: 750 } });
      expect(pill().style.top, "a point under the owner's bottom edge steps it to the top").toBe("8px");
    });

    it("forgets the points when the indicator is taken down", () => {
      applyIndicator({ type: "indicator", show: true, ...words }, pillHost());
      placePill(document, { point: { x: 800, y: 20 } });
      applyIndicator({ type: "indicator", show: false }, pillHost());
      applyIndicator({ type: "indicator", show: true, ...words }, pillHost());
      expect(pill().style.top).toBe("8px");
    });

    it("remembers points that arrive before the pill is drawn", () => {
      placePill(document, { point: { x: 800, y: 20 } });
      applyIndicator({ type: "indicator", show: true, ...words }, pillHost());
      expect(pill().style.bottom).toBe("8px");
    });
  });

  describe("T1045 the Open side panel control", () => {
    it("is drawn beside back to the agent's tab, and only with its words", () => {
      applyIndicator({ type: "indicator", show: true, ...words }, pillHost());
      const labels = Array.from(pill().querySelectorAll("button")).map((button) => button.textContent);
      expect(labels.indexOf(words.openPanel)).toBe(labels.indexOf(words.action) + 1);

      const { openPanel: _open, ...without } = words;
      applyIndicator({ type: "indicator", show: true, ...without }, pillHost());
      expect(buttonNamed(words.openPanel)).toBeUndefined();
    });

    it("sends the open press once for a trusted click and shows nothing extra when it opened", async () => {
      const page = pillHost(undefined, async () => ({ opened: true }));
      applyIndicator({ type: "indicator", show: true, ...words }, page);
      const before = pill().textContent;
      click(buttonNamed(words.openPanel));
      await vi.advanceTimersByTimeAsync(5000);

      expect(page.opened.length).toBe(1);
      expect(page.pressed, "the open press is not a 034 press").toEqual([]);
      expect(pill().textContent).toBe(before);
    });

    it("shows panelUnopened on { opened: false } and keeps the pill's state", async () => {
      const page = pillHost(undefined, async () => ({ opened: false }));
      applyIndicator({ type: "indicator", show: true, mode: "held", ...words, resume: "Resume", heldLabel: "Stopped" }, page);
      click(buttonNamed(words.openPanel));
      await vi.advanceTimersByTimeAsync(0);

      expect(pill().textContent).toContain(words.panelUnopened);
      expect(pill().textContent).toContain("Stopped");
      expect(buttonNamed("Resume")).toBeDefined();
      await vi.advanceTimersByTimeAsync(5000);
      expect(page.opened.length, "never resent").toBe(1);
      expect(pill().textContent?.split(words.panelUnopened).length, "shown once").toBe(2);
    });

    it("shows panelUnopened for a rejected send", async () => {
      const page = pillHost(undefined, () => Promise.reject(new Error("Extension context invalidated.")));
      applyIndicator({ type: "indicator", show: true, ...words }, page);
      click(buttonNamed(words.openPanel));
      await vi.advanceTimersByTimeAsync(0);

      expect(pill().textContent).toContain(words.panelUnopened);
      expect(page.opened.length).toBe(1);
    });

    it("shows panelUnopened when no reply comes within 2 s, and never resends", async () => {
      const page = pillHost();
      applyIndicator({ type: "indicator", show: true, ...words }, page);
      click(buttonNamed(words.openPanel));

      await vi.advanceTimersByTimeAsync(1999);
      expect(pill().textContent).not.toContain(words.panelUnopened);
      await vi.advanceTimersByTimeAsync(1);
      expect(pill().textContent).toContain(words.panelUnopened);
      await vi.advanceTimersByTimeAsync(10000);
      expect(page.opened.length).toBe(1);
    });

    it("does not draw on a pill that has been taken down", async () => {
      const page = pillHost();
      applyIndicator({ type: "indicator", show: true, ...words }, page);
      click(buttonNamed(words.openPanel));
      applyIndicator({ type: "indicator", show: false }, page);
      await vi.advanceTimersByTimeAsync(5000);
      expect(document.querySelector(`[${INDICATOR_PILL_ATTRIBUTE}]`)).toBeNull();
    });

    it("sends nothing for an untrusted click", async () => {
      const page = pillHost(undefined, undefined, false);
      applyIndicator({ type: "indicator", show: true, ...words }, page);
      buttonNamed(words.openPanel)?.click();
      click(buttonNamed(words.openPanel));
      await vi.advanceTimersByTimeAsync(5000);
      expect(page.opened).toEqual([]);
      expect(pill().textContent).not.toContain(words.panelUnopened);
    });

    it("shows the words as text, never markup", async () => {
      const markup = "<img src=x onerror=alert(1)>";
      const page = pillHost(undefined, async () => ({ opened: false }));
      applyIndicator({ type: "indicator", show: true, ...words, openPanel: markup, panelUnopened: markup }, page);
      click(buttonNamed(markup));
      await vi.advanceTimersByTimeAsync(0);
      expect(pill().querySelector("img")).toBeNull();
      expect(pill().textContent?.split(markup).length, "the control and the note").toBe(3);
    });
  });
});
