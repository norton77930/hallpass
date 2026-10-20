import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationState } from "@hallpass/contracts";
import { lookup } from "../src/locales/catalog.js";
import { MessageList } from "../src/side-panel/agent/conversation/MessageList.js";
import type { TimelineItem } from "../src/side-panel/agent/conversation/conversation-log.js";

/**
 * 020/T591, T592 - the agent's reply as Markdown (US2, FR-316, FR-317, SC-142, R-332, R-333).
 *
 * A reply is untrusted: the agent can repeat whatever a page said. Whatever it contains, the panel
 * must not run script, load a remote resource or let the reply restyle the panel; raw HTML is shown
 * as text, unsafe link schemes lose their address, and images are links that are never fetched.
 */

const t = (key: string): string => lookup(key, "en-US");

function renderReplies(texts: readonly string[], state?: ConversationState, owner?: string) {
  const timeline: TimelineItem[] = [];
  if (owner !== undefined) timeline.push({ kind: "text", key: "text-0", role: "owner", text: owner });
  texts.forEach((text, index) => {
    timeline.push({ kind: "text", key: `text-${index + 1}`, role: "agent", text });
    // Something between two replies, as a real turn has (two agent texts in a row are one message).
    if (index < texts.length - 1) timeline.push({ kind: "actions", key: `actions-${index + 1}`, actions: [] });
  });
  return render(<MessageList timeline={timeline} agentName="Claude Code" state={state} t={t} />);
}

const agentMessages = (root: ParentNode) => [...root.querySelectorAll('[data-message-role="agent"]')];

const FORBIDDEN_ELEMENTS = "script, iframe, frame, img, picture, source, video, audio, style, link, meta, base, object, embed, svg, math, form, input";
const UNSAFE_URL = /^\s*(javascript|vbscript|data|file|chrome|chrome-extension):/iu;

/** Every way a rendered reply could run script, fetch something or restyle the panel. */
function expectInert(root: Element, sample: string): void {
  expect(root.querySelectorAll(FORBIDDEN_ELEMENTS).length, `${sample}: forbidden element`).toBe(0);
  for (const element of root.querySelectorAll("*")) {
    for (const attribute of element.attributes) {
      expect(attribute.name.toLowerCase().startsWith("on"), `${sample}: ${attribute.name} on <${element.tagName}>`).toBe(false);
      expect(attribute.name.toLowerCase(), `${sample}: inline style`).not.toBe("style");
      if (["href", "src", "action", "formaction", "xlink:href", "srcset", "poster"].includes(attribute.name.toLowerCase())) {
        expect(attribute.value, `${sample}: ${attribute.name}`).not.toMatch(UNSAFE_URL);
      }
    }
  }
  // Every link that is left goes somewhere ordinary, in a new tab, without the panel as opener.
  for (const anchor of root.querySelectorAll("a")) {
    const href = anchor.getAttribute("href") ?? "";
    expect(href, `${sample}: link without an address`).not.toBe("");
    if (href.startsWith("#")) continue;
    // T593: a link without a scheme would resolve against the extension's own origin.
    expect(href, `${sample}: only web and mail links`).toMatch(/^(https?:|mailto:)/iu);
    expect(anchor.getAttribute("target"), sample).toBe("_blank");
    expect(anchor.getAttribute("rel"), sample).toBe("noopener noreferrer");
  }
}

const HOSTILE: readonly string[] = [
  "<script>alert(1)</script>",
  'before <img src=x onerror="alert(1)"> after',
  '<iframe src="https://evil.example/"></iframe>',
  '<a href="javascript:alert(1)">raw link</a>',
  "[x](javascript:alert(1))",
  "[x](JaVaScRiPt:alert(1))",
  "[x](vbscript:msgbox(1))",
  "[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
  "![pixel](https://example.com/a.png)",
  "![pixel](javascript:alert(1))",
  '<div onclick="alert(1)">click me</div>',
  "<style>body { display: none }</style>",
  "<javascript:alert(1)>",
  "[x][r]\n\n[r]: javascript:alert(1)",
  "[x](&#106;avascript:alert(1))",
  '<svg onload="alert(1)"><circle r="5"/></svg>',
  '<link rel="stylesheet" href="https://evil.example/x.css"><meta http-equiv="refresh" content="0;url=https://evil.example/">',
  "[![logo](https://example.com/logo.png)](https://example.com/)",
  "[x](side-panel.html)",
  "[x](/side-panel.html?x=1)",
  "[x](//evil.example/p)",
  "[x](chrome://settings)",
  "[x](chrome-extension://aaaa/x.html)",
];

describe("T591 a reply is rendered as Markdown, inertly (FR-316, SC-142)", () => {
  afterEach(cleanup);

  it.each(HOSTILE)("leaves nothing that runs, loads or restyles: %s", (sample) => {
    const { container } = renderReplies([sample], "idle");
    const [message] = agentMessages(container);
    expect(message).toBeDefined();
    // The rendered reply; the Copy button beside it is the panel's own (T606: an icon).
    expectInert(message!.querySelector(".agent-reply")!, sample);
  });

  it("shows raw HTML as text instead of dropping or interpreting it", () => {
    const { container } = renderReplies(['Look: <img src=x onerror="alert(1)"> and <script>alert(2)</script>'], "idle");
    const text = agentMessages(container)[0]!.textContent ?? "";
    expect(text).toContain('<img src=x onerror="alert(1)">');
    expect(text).toContain("<script>alert(2)</script>");
  });

  it("shows an image as a link to its address, labelled with its alt text, and never loads it", () => {
    const { container } = renderReplies(["![a chart](https://example.com/chart.png) and ![](https://example.com/bare.png)"], "idle");
    const message = agentMessages(container)[0]!;
    expect(message.querySelector("img")).toBeNull();
    const links = [...message.querySelectorAll("a")];
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["a chart", "https://example.com/chart.png"],
      ["https://example.com/bare.png", "https://example.com/bare.png"],
    ]);
  });

  it("drops the address of an unsafe link but keeps its words", () => {
    const { container } = renderReplies(["see [the page](javascript:alert(1)) here"], "idle");
    const message = agentMessages(container)[0]!;
    expect(message.querySelector("a")).toBeNull();
    expect(message.textContent).toContain("see the page here");
  });

  it("opens an ordinary link in a new tab", () => {
    const { container } = renderReplies(["[docs](https://example.com/docs) and https://example.com/auto"], "idle");
    const links = [...agentMessages(container)[0]!.querySelectorAll("a")];
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["https://example.com/docs", "https://example.com/auto"]);
    for (const link of links) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    }
  });

  it("formats a heading, a list, a table, inline code and a code block", () => {
    const reply = [
      "## Summary",
      "",
      "- first",
      "- second",
      "",
      "| name | rows |",
      "| --- | --- |",
      "| orders | 3 |",
      "",
      "Use `npm test` to check.",
      "",
      "```ts",
      "const a = 1;",
      "```",
    ].join("\n");
    const { container } = renderReplies([reply], "idle");
    const message = agentMessages(container)[0]!;
    expect(message.querySelector("h2")?.textContent).toBe("Summary");
    expect([...message.querySelectorAll("ul > li")].map((li) => li.textContent)).toEqual(["first", "second"]);
    const table = message.querySelector("table");
    expect(table).not.toBeNull();
    expect([...table!.querySelectorAll("td")].map((cell) => cell.textContent)).toEqual(["orders", "3"]);
    // A wide table scrolls inside its own box rather than widening the panel.
    expect(table!.parentElement?.classList.contains("agent-reply-table")).toBe(true);
    expect([...message.querySelectorAll("p code")].map((code) => code.textContent)).toEqual(["npm test"]);
    expect(message.querySelector("pre > code")?.textContent).toBe("const a = 1;\n");
    expect(message.querySelector("pre")?.classList.contains("agent-reply-code")).toBe(true);
  });

  it("keeps the owner's own message as plain text", () => {
    const { container } = renderReplies([], "idle", "## not a heading <b>x</b>");
    const owner = container.querySelector('[data-message-role="owner"]')!;
    expect(owner.querySelector("h2, b")).toBeNull();
    expect(owner.textContent).toContain("## not a heading <b>x</b>");
  });

  it("re-renders a streaming reply as it grows, an unclosed fence showing as code until it closes (R-333)", () => {
    const owner: TimelineItem = { kind: "text", key: "text-0", role: "owner", text: "go" };
    const view = (text: string) => (
      <MessageList timeline={[owner, { kind: "text", key: "text-1", role: "agent", text }]} state="running" t={t} agentName="Claude Code" />
    );
    const { container, rerender } = render(view("Here:\n\n```js\nconst a"));
    expect(container.querySelector("pre > code")?.textContent).toContain("const a");
    rerender(view("Here:\n\n```js\nconst a = 1;\n```\n\nDone **now**"));
    expect(container.querySelector("pre > code")?.textContent).toBe("const a = 1;\n");
    expect(container.querySelector("strong")?.textContent).toBe("now");
  });
});

describe("T592 Copy on a finished reply (FR-317)", () => {
  afterEach(cleanup);

  // T606 (C7): an icon button named "Copy reply"; "Copied" is a screen-reader status beside it.
  const copyButtons = () => screen.queryAllByRole("button", { name: t("conversation.reply.copyLabel") });
  const copiedSaid = () => [...document.querySelectorAll(".agent-reply-copied[role=status]")].some((status) => status.textContent === t("conversation.reply.copied"));

  it("offers no Copy on the reply that is still streaming, and one on every finished reply", () => {
    renderReplies(["first answer", "still typing"], "running");
    // The first reply ended when the actions after it began; the last one is still growing.
    expect(copyButtons()).toHaveLength(1);
    cleanup();
    renderReplies(["first answer", "now done"], "idle");
    expect(copyButtons()).toHaveLength(2);
  });

  it("treats a reply as unfinished while the turn waits for the owner's answer", () => {
    renderReplies(["I will now edit the file"], "waiting-for-owner");
    expect(copyButtons()).toHaveLength(0);
  });

  it("copies the reply's Markdown source and confirms, then returns to Copy", async () => {
    vi.useFakeTimers();
    try {
      const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
      const source = "## Result\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n<b>raw</b>";
      renderReplies([source], "idle");

      await act(async () => {
        fireEvent.click(copyButtons()[0]!);
      });
      expect(writeText).toHaveBeenCalledWith(source);
      expect(copiedSaid()).toBe(true);

      await act(async () => {
        vi.advanceTimersByTime(3_000);
      });
      expect(copyButtons()).toHaveLength(1);
      expect(copiedSaid()).toBe(false);
    } finally {
      vi.useRealTimers();
      Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("does not claim Copied when the clipboard refuses", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      renderReplies(["answer"], "idle");
      await act(async () => {
        fireEvent.click(copyButtons()[0]!);
      });
      expect(writeText).toHaveBeenCalledWith("answer");
      expect(copiedSaid()).toBe(false);
    } finally {
      Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("has Copy and Copied in both locales", () => {
    for (const key of ["conversation.reply.copy", "conversation.reply.copied"]) {
      expect(lookup(key, "zh-TW")).not.toBe(lookup(key, "en-US"));
    }
    expect(lookup("conversation.reply.copy", "zh-TW")).toBe("複製");
    expect(lookup("conversation.reply.copied", "zh-TW")).toBe("已複製");
  });
});
