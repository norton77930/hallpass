import { describe, expect, it } from "vitest";
import { pointerCaption } from "../src/service-worker/agent-tools/pointer-captions.js";

/**
 * 033/T981 - the words and the pointer behaviour for every row of FR-499 (R-491, R-493).
 *
 * The expected strings are written out here, not read back from the catalog: the table in the spec
 * is the claim, and a catalog edit that drifts from it must fail this file.
 */

type Row = {
  name: string;
  tool: string;
  args: Record<string, unknown>;
  en: string;
  zh: string;
  mode: "travel" | "stay" | "rest";
};

const TAB = { tabId: 7 };
const REF = { ref: "e1" };

const ROWS: Row[] = [
  { name: "click", tool: "click", args: { ...TAB, target: REF }, en: "Clicking", zh: "點擊", mode: "travel" },
  { name: "computer left_click", tool: "computer", args: { ...TAB, action: "left_click", x: 1, y: 2 }, en: "Clicking", zh: "點擊", mode: "travel" },
  { name: "double_click", tool: "double_click", args: { ...TAB, target: REF }, en: "Double-clicking", zh: "雙擊", mode: "travel" },
  { name: "computer double_click", tool: "computer", args: { ...TAB, action: "double_click", x: 1, y: 2 }, en: "Double-clicking", zh: "雙擊", mode: "travel" },
  { name: "triple_click", tool: "triple_click", args: { ...TAB, target: REF }, en: "Triple-clicking", zh: "三連擊", mode: "travel" },
  { name: "computer triple_click", tool: "computer", args: { ...TAB, action: "triple_click", x: 1, y: 2 }, en: "Triple-clicking", zh: "三連擊", mode: "travel" },
  { name: "right_click", tool: "right_click", args: { ...TAB, target: REF }, en: "Right-clicking", zh: "按右鍵", mode: "travel" },
  { name: "computer right_click", tool: "computer", args: { ...TAB, action: "right_click", x: 1, y: 2 }, en: "Right-clicking", zh: "按右鍵", mode: "travel" },
  { name: "hover", tool: "hover", args: { ...TAB, target: REF }, en: "Pointing", zh: "移動游標", mode: "travel" },
  { name: "drag", tool: "drag", args: { ...TAB, from: REF, to: { ref: "e2" } }, en: "Dragging", zh: "拖曳", mode: "travel" },
  { name: "scroll down", tool: "scroll", args: { ...TAB, direction: "down", amount: "small" }, en: "Scrolling down", zh: "向下捲動", mode: "stay" },
  { name: "scroll up", tool: "scroll", args: { ...TAB, direction: "up" }, en: "Scrolling up", zh: "向上捲動", mode: "stay" },
  { name: "computer scroll down", tool: "computer", args: { ...TAB, action: "scroll", x: 1, y: 2, amount: 3 }, en: "Scrolling down", zh: "向下捲動", mode: "travel" },
  { name: "computer scroll up", tool: "computer", args: { ...TAB, action: "scroll", x: 1, y: 2, amount: -3 }, en: "Scrolling up", zh: "向上捲動", mode: "travel" },
  { name: "scroll to an element", tool: "scroll", args: { ...TAB, target: REF }, en: "Scrolling to element", zh: "捲動到元素", mode: "stay" },
  { name: "type", tool: "type", args: { ...TAB, text: "hello" }, en: "Typing", zh: "輸入文字", mode: "stay" },
  { name: "computer type", tool: "computer", args: { ...TAB, action: "type", text: "hello" }, en: "Typing", zh: "輸入文字", mode: "stay" },
  { name: "key", tool: "key", args: { ...TAB, key: "Enter" }, en: "Pressing Enter", zh: "按下 Enter", mode: "stay" },
  { name: "key with a modifier", tool: "key", args: { ...TAB, key: "Tab", modifiers: ["Shift"] }, en: "Pressing Shift+Tab", zh: "按下 Shift+Tab", mode: "stay" },
  { name: "computer key", tool: "computer", args: { ...TAB, action: "key", key: "Escape" }, en: "Pressing Escape", zh: "按下 Escape", mode: "stay" },
  { name: "navigate to a URL", tool: "navigate", args: { ...TAB, url: "https://example.com/a/b?c=d" }, en: "Opening example.com", zh: "開啟 example.com", mode: "rest" },
  { name: "navigate back", tool: "navigate", args: { ...TAB, direction: "back" }, en: "Going back", zh: "上一頁", mode: "rest" },
  { name: "navigate forward", tool: "navigate", args: { ...TAB, direction: "forward" }, en: "Going forward", zh: "下一頁", mode: "rest" },
  { name: "form_input", tool: "form_input", args: { ...TAB, ref: "e1", value: "x" }, en: "Filling in a field", zh: "填寫欄位", mode: "rest" },
  { name: "evaluate", tool: "evaluate", args: { ...TAB, expression: "1" }, en: "Running page script", zh: "執行頁面腳本", mode: "rest" },
  { name: "file_upload", tool: "file_upload", args: { ...TAB }, en: "Uploading file", zh: "上傳檔案", mode: "rest" },
  { name: "upload_image", tool: "upload_image", args: { ...TAB }, en: "Uploading image", zh: "上傳圖片", mode: "rest" },
  { name: "resize_window", tool: "resize_window", args: { ...TAB, width: 800, height: 600 }, en: "Resizing window", zh: "調整視窗大小", mode: "rest" },
  { name: "viewport set", tool: "viewport", args: { ...TAB, action: "set", width: 400, height: 700 }, en: "Resizing window", zh: "調整視窗大小", mode: "rest" },
  { name: "viewport reset", tool: "viewport", args: { ...TAB, action: "reset" }, en: "Resizing window", zh: "調整視窗大小", mode: "rest" },
  { name: "read_page", tool: "read_page", args: { ...TAB }, en: "Reading page", zh: "讀取頁面", mode: "stay" },
  { name: "get_page_text", tool: "get_page_text", args: { ...TAB }, en: "Reading page text", zh: "讀取頁面文字", mode: "stay" },
  { name: "find", tool: "find", args: { ...TAB, query: "Sign in" }, en: "Finding “Sign in”", zh: "尋找「Sign in」", mode: "stay" },
  { name: "read_console", tool: "read_console", args: { ...TAB }, en: "Reading console", zh: "讀取主控台", mode: "stay" },
  { name: "read_network", tool: "read_network", args: { ...TAB }, en: "Reading network activity", zh: "讀取網路活動", mode: "stay" },
  { name: "wait", tool: "wait", args: { ...TAB, forMs: 2000 }, en: "Waiting 2 seconds", zh: "等待 2 秒", mode: "stay" },
  { name: "wait for a fraction of a second", tool: "wait", args: { ...TAB, forMs: 500 }, en: "Waiting 0.5 seconds", zh: "等待 0.5 秒", mode: "stay" },
  { name: "wait for a condition", tool: "wait", args: { ...TAB, condition: "visible-text-changed", maxMs: 10000 }, en: "Waiting 10 seconds", zh: "等待 10 秒", mode: "stay" },
  { name: "computer wait", tool: "computer", args: { ...TAB, action: "wait", ms: 1500 }, en: "Waiting 1.5 seconds", zh: "等待 1.5 秒", mode: "stay" },
];

describe("T981 pointerCaption: FR-499's table", () => {
  for (const row of ROWS) {
    it(`${row.name}: en-US`, () => {
      expect(pointerCaption(row.tool, row.args, "en-US")).toEqual({ words: row.en, mode: row.mode });
    });
    it(`${row.name}: zh-TW`, () => {
      expect(pointerCaption(row.tool, row.args, "zh-TW")).toEqual({ words: row.zh, mode: row.mode });
    });
  }

  it("has the sideways scroll rows the table lists, though the scroll tool only sends up and down today", () => {
    expect(pointerCaption("scroll", { tabId: 7, direction: "left" }, "en-US")?.words).toBe("Scrolling left");
    expect(pointerCaption("scroll", { tabId: 7, direction: "right" }, "zh-TW")?.words).toBe("向右捲動");
  });

  it("falls back to en-US for any other locale", () => {
    expect(pointerCaption("click", { tabId: 7, target: REF }, "fr-FR")).toEqual({
      words: "Clicking",
      mode: "travel",
    });
  });
});

describe("T981 pointerCaption: no step", () => {
  const SILENT: Array<[string, Record<string, unknown>]> = [
    ["screenshot", { tabId: 7 }],
    ["screenshot", { tabId: 7, region: { x: 0, y: 0, width: 10, height: 10 } }],
    ["computer", { tabId: 7, action: "screenshot" }],
    ["tabs_context", {}],
    ["tabs_create", {}],
    ["tabs_close", { tabId: 7 }],
    ["tabs_claim", { tabId: 7 }],
    ["tabs_release", { tabId: 7 }],
    ["list_browsers", {}],
    ["select_browser", {}],
    ["request_browser_choice", {}],
    ["propose_sites", {}],
    ["downloads_context", {}],
    ["gif_recorder", { action: "start" }],
    ["dialog", { tabId: 7, action: "accept" }],
    ["browser_batch", { tabId: 7, steps: [] }],
    ["no_such_tool", { tabId: 7 }],
  ];
  for (const [tool, args] of SILENT) {
    it(`${tool} ${JSON.stringify(args)} has no caption`, () => {
      expect(pointerCaption(tool, args, "en-US")).toBeUndefined();
      expect(pointerCaption(tool, args, "zh-TW")).toBeUndefined();
    });
  }

  it("has no caption for arguments it cannot read", () => {
    expect(pointerCaption("find", null, "en-US")).toBeUndefined();
    expect(pointerCaption("find", { tabId: 7 }, "en-US")).toBeUndefined();
    expect(pointerCaption("navigate", { tabId: 7 }, "en-US")).toBeUndefined();
    expect(pointerCaption("computer", { tabId: 7, action: "levitate" }, "en-US")).toBeUndefined();
  });
});

describe("T981 pointerCaption: parameters", () => {
  const LONG = "abcdefghijklmnopqrstuvwxyz";

  it("cuts a find query to 20 characters plus an ellipsis", () => {
    expect(pointerCaption("find", { tabId: 7, query: LONG }, "en-US")?.words).toBe("Finding “abcdefghijklmnopqrst…”");
    expect(pointerCaption("find", { tabId: 7, query: LONG }, "zh-TW")?.words).toBe("尋找「abcdefghijklmnopqrst…」");
  });

  it("leaves a query of exactly 20 characters alone", () => {
    expect(pointerCaption("find", { tabId: 7, query: LONG.slice(0, 20) }, "en-US")?.words).toBe(
      "Finding “abcdefghijklmnopqrst”",
    );
  });

  it("counts characters, not UTF-16 units, and keeps the caption on one line", () => {
    const wide = "😀".repeat(21);
    expect(pointerCaption("find", { tabId: 7, query: wide }, "en-US")?.words).toBe(`Finding “${"😀".repeat(20)}…”`);
    expect(pointerCaption("find", { tabId: 7, query: "two\nlines\t here" }, "en-US")?.words).toBe(
      "Finding “two lines here”",
    );
  });

  it("cuts a host to 20 characters plus an ellipsis", () => {
    const url = "https://a-very-long-subdomain.example.com/path";
    expect(pointerCaption("navigate", { tabId: 7, url }, "en-US")?.words).toBe("Opening a-very-long-subdomai…");
  });

  it("names a host-less URL by something rather than leaving the caption empty", () => {
    expect(pointerCaption("navigate", { tabId: 7, url: "about:blank" }, "en-US")?.words).toBe("Opening about:blank");
  });

  it("names the hostname only, without port, path, credentials or query", () => {
    expect(
      pointerCaption("navigate", { tabId: 7, url: "https://user:pw@localhost:19443/x?token=1" }, "en-US")?.words,
    ).toBe("Opening localhost");
  });

  it("keeps the longest English caption within the page's 60-character limit", () => {
    const worst = [
      pointerCaption("find", { tabId: 7, query: "x".repeat(99) }, "en-US"),
      pointerCaption("navigate", { tabId: 7, url: `https://${"h".repeat(60)}.test/` }, "en-US"),
      pointerCaption("key", { tabId: 7, key: "ArrowRight", modifiers: ["Shift"] }, "en-US"),
      pointerCaption("read_network", { tabId: 7 }, "en-US"),
    ];
    for (const caption of worst) expect(caption!.words.length).toBeLessThanOrEqual(60);
  });
});
