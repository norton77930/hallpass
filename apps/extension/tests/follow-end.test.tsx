import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lookup } from "../src/locales/catalog.js";
import type { TimelineItem } from "../src/side-panel/agent/conversation/conversation-log.js";
import { nearEnd } from "../src/side-panel/agent/conversation/follow-end.js";
import { MessageList } from "../src/side-panel/agent/conversation/MessageList.js";

/**
 * T602 - the message log follows the newest content while the owner is at (or within 40 px of) its
 * end, and leaves them where they are once they scrolled up. jsdom has no layout, so the log's
 * scroll metrics are stood in for: `box` is what the browser would report for `.agent-conversation-log`.
 */

const t = (key: string): string => lookup(key, "en-US");
const box = { scrollTop: 0, scrollHeight: 0, clientHeight: 300 };
const tops = new WeakMap<Element, number>();
const isLog = (element: Element) => element.classList.contains("agent-conversation-log");

beforeEach(() => {
  const proto = HTMLElement.prototype;
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get(this: Element) { return isLog(this) ? box.scrollHeight : 0; } });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get(this: Element) { return isLog(this) ? box.clientHeight : 0; } });
  Object.defineProperty(proto, "scrollTop", {
    configurable: true,
    get(this: Element) { return isLog(this) ? box.scrollTop : (tops.get(this) ?? 0); },
    set(this: Element, value: number) {
      // The browser clamps to the last full screen of content.
      if (isLog(this)) box.scrollTop = Math.max(0, Math.min(value, box.scrollHeight - box.clientHeight));
      else tops.set(this, value);
    },
  });
});

afterEach(() => {
  cleanup();
  for (const name of ["scrollTop", "scrollHeight", "clientHeight"]) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
});

const said = (count: number): TimelineItem[] =>
  Array.from({ length: count }, (_, index) => ({ kind: "text", key: `t${index}`, role: index % 2 === 0 ? "owner" : "agent", text: `line ${index}` }) as TimelineItem);
const list = (count: number) => <MessageList timeline={said(count)} agentName="Claude Code" state="running" t={t} />;
const scrollTo = (log: Element, top: number) => {
  box.scrollTop = top;
  fireEvent.scroll(log);
};

describe("T602 nearEnd", () => {
  it("is true at the end and within 40 px of it, false further up", () => {
    expect(nearEnd({ scrollTop: 700, scrollHeight: 1000, clientHeight: 300 })).toBe(true);
    expect(nearEnd({ scrollTop: 660, scrollHeight: 1000, clientHeight: 300 })).toBe(true);
    expect(nearEnd({ scrollTop: 659, scrollHeight: 1000, clientHeight: 300 })).toBe(false);
    expect(nearEnd({ scrollTop: 0, scrollHeight: 200, clientHeight: 300 })).toBe(true);
  });
});

describe("T602 the log follows the newest content", () => {
  it("opens at the end, follows while the owner is there, and stays put once they scrolled up", () => {
    box.scrollHeight = 1000;
    box.scrollTop = 0;
    const view = render(list(4));
    const log = view.container.querySelector(".agent-conversation-log")!;
    expect(box.scrollTop).toBe(700);

    box.scrollHeight = 1400;
    view.rerender(list(5));
    expect(box.scrollTop).toBe(1100);

    // Within 40 px of the end still counts as the end.
    scrollTo(log, 1070);
    box.scrollHeight = 1600;
    view.rerender(list(6));
    expect(box.scrollTop).toBe(1300);

    // The owner scrolled up to read: new text does not pull them down.
    scrollTo(log, 200);
    box.scrollHeight = 1800;
    view.rerender(list(7));
    expect(box.scrollTop).toBe(200);

    // Back at the end, it follows again.
    scrollTo(log, 1500);
    box.scrollHeight = 2000;
    view.rerender(list(8));
    expect(box.scrollTop).toBe(1700);
  });
});

describe("T606 P4 Jump to latest", () => {
  const jump = () => screen.queryByRole("button", { name: t("conversation.jumpLatest") });

  it("appears once the owner scrolled up, takes them to the end and leaves; it also leaves at the end by itself", () => {
    box.scrollHeight = 1000;
    box.scrollTop = 0;
    const view = render(list(4));
    const log = view.container.querySelector(".agent-conversation-log")!;
    expect(jump()).toBeNull();

    // Within the follow slack: still at the end, no pill.
    scrollTo(log, 670);
    expect(jump()).toBeNull();

    scrollTo(log, 200);
    expect(jump()).not.toBeNull();
    box.scrollHeight = 1400;
    view.rerender(list(5));
    expect(box.scrollTop).toBe(200);

    fireEvent.click(jump()!);
    expect(box.scrollTop).toBe(1100);
    expect(jump()).toBeNull();
    // And the log follows again.
    box.scrollHeight = 1600;
    view.rerender(list(6));
    expect(box.scrollTop).toBe(1300);

    scrollTo(log, 100);
    expect(jump()).not.toBeNull();
    scrollTo(log, 1300);
    expect(jump()).toBeNull();
  });

  it("is a named button in zh-TW as well", () => {
    box.scrollHeight = 1000;
    box.scrollTop = 0;
    const zh = (key: string) => lookup(key, "zh-TW");
    const view = render(<MessageList timeline={said(4)} agentName="Claude Code" state="idle" t={zh} />);
    scrollTo(view.container.querySelector(".agent-conversation-log")!, 0);
    const button = screen.getByRole("button", { name: zh("conversation.jumpLatest") });
    expect(button.tagName).toBe("BUTTON");
  });
});
