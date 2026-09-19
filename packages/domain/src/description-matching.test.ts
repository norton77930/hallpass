import { afterEach, describe, expect, it, vi } from "vitest";

import { describedWords, matchDescription } from "./description-matching.js";

/**
 * 002 US5 / T074a. Matching a description against one candidate is a language policy, so it lives
 * here beside the sibling policies rather than in the content runtime, which keeps only liveness
 * and the candidate bound. Nothing below touches the DOM: a candidate is the three facts a review
 * card would show - the role, the label, and a button's own text.
 */
describe("002 T074a description matching, English", () => {
  it("matches whole words of the label and a button's text, never fragments of them", () => {
    expect(matchDescription("save button", { role: "button", text: "Discard unsaved changes" })).toBe(false);
    expect(matchDescription("no", { role: "textbox", label: "Notes" })).toBe(false);
    // A hyphenated phrase is matched by its words.
    expect(matchDescription("double-click", { role: "button", text: "Open on double-click" })).toBe(true);
    expect(matchDescription("safe checkout", { role: "button", text: "Safe action" })).toBe(false);
  });

  it("matches role words to the control kind, and any-role words to every kind", () => {
    expect(matchDescription("notes field", { role: "textbox", label: "Notes" })).toBe(true);
    expect(matchDescription("colour dropdown", { role: "combobox", label: "Colour" })).toBe(true);
    expect(matchDescription("notes dropdown", { role: "textbox", label: "Notes" })).toBe(false);
    expect(matchDescription("item", { role: "button", text: "Item 3" })).toBe(true);
    expect(matchDescription("thing", { role: "combobox", label: "Colour" })).toBe(true);
  });

  it("drops words that carry no meaning, and falls back to them when they were all there was", () => {
    expect(matchDescription("the Safe Action button", { role: "button", text: "Safe action" })).toBe(true);
    // The noise-word edge T074a removes: a control whose whole label is a noise word was
    // unreachable, because the description was emptied before it could be matched.
    expect(matchDescription("click", { role: "button", text: "Click" })).toBe(true);
    expect(matchDescription("type", { role: "button", text: "Type" })).toBe(true);
    // Falling back is not matching everything: the raw words still have to be there.
    expect(matchDescription("the", { role: "button", text: "Safe action" })).toBe(false);
  });

  it("names the words a description asks for", () => {
    expect(describedWords("please click the safe action button")).toEqual(["safe", "action", "button"]);
    expect(describedWords("the")).toEqual(["the"]);
  });
});

/**
 * zh-TW is written without word breaks, so its descriptions are segmented rather than split, and
 * each segment is matched by containment in the label - a segmenter over-splits short phrases, so
 * containment is the honest rule - or by the zh-TW half of the same role vocabulary.
 */
describe("002 T074a description matching, zh-TW", () => {
  it("matches a description written without word breaks against the label it names", () => {
    expect(matchDescription("安全動作按鈕", { role: "button", label: "安全動作" })).toBe(true);
    expect(matchDescription("安全動作按鈕", { role: "button", label: "危險動作" })).toBe(false);
    expect(matchDescription("備註欄位", { role: "textbox", label: "備註" })).toBe(true);
    expect(matchDescription("備註欄位", { role: "textbox", label: "標題" })).toBe(false);
  });

  it("matches the zh-TW role and any-role vocabulary to the control kind", () => {
    expect(matchDescription("按鈕", { role: "button", label: "安全動作" })).toBe(true);
    expect(matchDescription("按鈕", { role: "textbox", label: "備註" })).toBe(false);
    expect(matchDescription("下拉選單", { role: "combobox", label: "顏色" })).toBe(true);
    expect(matchDescription("元素", { role: "textbox", label: "備註" })).toBe(true);
    expect(matchDescription("完全不存在的東西", { role: "button", label: "安全動作" })).toBe(false);
  });

  it("drops zh-TW noise words, and falls back to them when they were all there was", () => {
    expect(matchDescription("請點擊安全動作按鈕", { role: "button", label: "安全動作" })).toBe(true);
    expect(matchDescription("請在備註欄位輸入", { role: "textbox", label: "備註" })).toBe(true);
    // The same edge as English: a control labelled with nothing but a noise word is reachable.
    expect(matchDescription("點擊", { role: "button", label: "點擊" })).toBe(true);
    expect(matchDescription("請點擊", { role: "button", label: "點擊" })).toBe(false);
  });

  it("matches a description that mixes scripts by every token of it", () => {
    expect(matchDescription("Notes 欄位", { role: "textbox", label: "Notes" })).toBe(true);
    expect(matchDescription("Notes 欄位", { role: "button", text: "Notes" })).toBe(false);
    expect(matchDescription("備註 field", { role: "textbox", label: "備註" })).toBe(true);
  });

  it("names the segments a description asks for", () => {
    expect(describedWords("請點擊安全動作按鈕")).toEqual(["安全動作按鈕"]);
    expect(describedWords("完全不存在的東西")).toEqual(["完全不存在", "東西"]);
    expect(describedWords("點擊")).toEqual(["點擊"]);
  });
});

/**
 * Containment is what makes an unsegmented description matchable at all, but it has to stop where
 * the names' own words stop. There is one rule for where they stop, and it is the segmenter's: a
 * phrase names a candidate when it occurs in the shown names beginning and ending where a segment
 * does. Nothing else - which means it accepts whatever the segmenter's words accept, exactly as the
 * English whole-word rule accepts whatever the spaces accept.
 */
describe("002 T074a description matching, zh-TW word boundaries", () => {
  it("names a candidate by whole segments of its names, and never by a fragment of one", () => {
    expect(matchDescription("安全動作按鈕", { role: "button", label: "安全動作" })).toBe(true);
    // A fragment is what the rule refuses: "全動" opens inside "安全" and closes inside "動作".
    expect(matchDescription("全動", { role: "button", label: "安全動作" })).toBe(false);
    expect(matchDescription("安全動作按鈕", { role: "button", label: "危險動作" })).toBe(false);
    expect(matchDescription("點餐按鈕", { role: "button", label: "餐廳" })).toBe(false);
    expect(matchDescription("備註欄位", { role: "textbox", label: "標題" })).toBe(false);
  });

  it("accepts a base word a modifier is written in front of, the way the English rule does", () => {
    // ICU segments "不安全動作" as "不"|"安全"|"動作", so "安全動作" begins and ends on boundaries
    // and names it - just as English "safe action button" names a button reading "Not safe action".
    expect(matchDescription("安全動作按鈕", { role: "button", label: "不安全動作" })).toBe(true);
    expect(matchDescription("動作", { role: "button", label: "不安全動作" })).toBe(true);
    // "取消刪除" is segmented "取消"|"刪除", so "刪除按鈕" names it the way "delete button" names
    // a button reading "Cancel delete".
    expect(matchDescription("刪除按鈕", { role: "button", label: "取消刪除" })).toBe(true);
    // "未儲存的變更" is segmented "未"|"儲存"|"的"|"變更": "未" is a segment of its own.
    expect(matchDescription("儲存", { role: "button", label: "未儲存的變更" })).toBe(true);
  });

  it("names every sibling a broad description covers, which is what a bound is there to answer", () => {
    expect(matchDescription("動作", { role: "button", label: "安全動作" })).toBe(true);
    expect(matchDescription("動作", { role: "button", label: "危險動作" })).toBe(true);
    // Sibling password fields: all three are named, so past a bound of one the runtime answers
    // too-broad rather than narrowing to whichever it saw first.
    for (const label of ["密碼", "確認密碼", "新密碼"]) {
      expect(matchDescription("密碼欄位", { role: "textbox", label })).toBe(true);
    }
  });
});

/**
 * Some words for a kind of control open with a word that is noise on its own ("輸入框" opens with
 * the noise word "輸入"), and a segmenter that does not know a two-character name splits it into
 * single characters, one of which may be spelled like a noise word ("點餐" -> "點"|"餐"). Neither
 * may be cut down to a fragment.
 */
describe("002 T074a description matching, zh-TW noise inside a word", () => {
  it("matches every zh-TW word for a control's kind, and no other kind", () => {
    for (const word of ["文字框", "輸入框", "欄位", "輸入欄", "文字欄"]) {
      expect(matchDescription(`備註${word}`, { role: "textbox", label: "備註" })).toBe(true);
      expect(matchDescription(`備註${word}`, { role: "button", label: "備註" })).toBe(false);
    }
    for (const word of ["按鈕", "按鍵"]) {
      expect(matchDescription(`安全動作${word}`, { role: "button", label: "安全動作" })).toBe(true);
      expect(matchDescription(`安全動作${word}`, { role: "textbox", label: "安全動作" })).toBe(false);
    }
    for (const word of ["下拉", "下拉選單", "選單", "選擇器", "選項"]) {
      expect(matchDescription(`顏色${word}`, { role: "combobox", label: "顏色" })).toBe(true);
      expect(matchDescription(`顏色${word}`, { role: "button", label: "顏色" })).toBe(false);
    }
    // A word for no kind in particular names every kind, so there the label is what tells them apart.
    for (const word of ["控制項", "元素", "項目", "東西"]) {
      expect(matchDescription(`備註${word}`, { role: "textbox", label: "備註" })).toBe(true);
      expect(matchDescription(`備註${word}`, { role: "button", label: "備註" })).toBe(true);
      expect(matchDescription(`備註${word}`, { role: "button", label: "標題" })).toBe(false);
    }
  });

  it("keeps a noise word that a name or a word for a kind is written with", () => {
    expect(matchDescription("點餐按鈕", { role: "button", label: "點餐" })).toBe(true);
    expect(matchDescription("點餐按鈕", { role: "button", label: "餐廳" })).toBe(false);
    expect(describedWords("備註輸入框")).toEqual(["備註輸入框"]);
    expect(describedWords("點餐按鈕")).toEqual(["點餐按鈕"]);
  });

  it("stops a run of noise where a word for a kind begins, however many segments the run spans", () => {
    // ICU segments "點擊輸入框" as "點"|"擊"|"輸入"|"框", so the noise run is two segments long and
    // the third segment is where "輸入框" begins: the run has to stop there, or the description is
    // cut down to the fragment "框", which names no kind at all.
    expect(matchDescription("點擊輸入框", { role: "textbox", label: "備註" })).toBe(true);
    expect(matchDescription("點擊輸入框", { role: "button", label: "備註" })).toBe(false);
    expect(matchDescription("請點輸入框", { role: "textbox", label: "備註" })).toBe(true);
    expect(matchDescription("點選輸入欄", { role: "textbox", label: "備註" })).toBe(true);
    expect(matchDescription("請按輸入框", { role: "textbox", label: "備註" })).toBe(true);
    expect(matchDescription("請按下拉選單", { role: "combobox", label: "顏色" })).toBe(true);
    expect(matchDescription("請按下拉選單", { role: "textbox", label: "顏色" })).toBe(false);
    // The same run, with a name in front of the kind word it opens.
    expect(matchDescription("請點擊備註輸入框", { role: "textbox", label: "備註" })).toBe(true);
    expect(matchDescription("請點擊備註輸入框", { role: "textbox", label: "標題" })).toBe(false);
    expect(describedWords("點擊輸入框")).toEqual(["輸入框"]);
    expect(describedWords("請按下拉選單")).toEqual(["下拉選單"]);
    expect(describedWords("請點擊備註輸入框")).toEqual(["備註輸入框"]);
    // A noise word directly before a kind word that itself opens with a noise character: the
    // kind word survives whole, whichever way the segmenter cuts it.
    expect(describedWords("請按鈕")).toEqual(["按鈕"]);
    expect(describedWords("請按按鈕")).toEqual(["按鈕"]);
  });
});

/**
 * `Intl.Segmenter` is in Node 20+ and in Chrome, so the boundary rule is what normally applies; the
 * matcher is written to survive its absence all the same, with containment alone.
 */
describe("002 T074a description matching without a segmenter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("falls back to plain containment for unsegmented text, and leaves the English rule alone", async () => {
    vi.resetModules();
    // Spreading `Intl` would drop the rest of it: its members are not enumerable. Shadowing one
    // member over the real object hides `Segmenter` and nothing else.
    const withoutSegmenter: typeof Intl = Object.create(Intl) as typeof Intl;
    Object.defineProperty(withoutSegmenter, "Segmenter", { value: undefined });
    vi.stubGlobal("Intl", withoutSegmenter);
    const matching = await import("./description-matching.js");

    expect(matching.matchDescription("安全動作按鈕", { role: "button", label: "安全動作" })).toBe(true);
    // Fewer descriptions resolve and none resolve to something else - but the boundary rule is gone,
    // so a fragment is what this fallback allows and a segmenter refuses.
    expect(matching.matchDescription("全動", { role: "button", label: "安全動作" })).toBe(true);
    expect(matching.matchDescription("save button", { role: "button", text: "Discard unsaved changes" })).toBe(false);
    expect(matching.matchDescription("notes field", { role: "textbox", label: "Notes" })).toBe(true);
  });
});
