import { describe, expect, it } from "vitest";
import { defaultBrowserNames } from "./browser-names.js";

describe("018 R-269 default browser names", () => {
  it("names a lone browser after its kind", () => {
    for (const [kind, name] of [
      ["chrome", "Chrome"],
      ["edge", "Edge"],
      ["brave", "Brave"],
      ["chromium", "Chromium"],
      ["unknown", "Browser"],
    ] as const) {
      expect(defaultBrowserNames([{ browserId: "b-1", kind, startedAt: "2026-10-03T08:00:00.000Z" }])).toEqual(
        new Map([["b-1", name]]),
      );
    }
  });

  it("numbers browsers of one kind by connection order, and only those", () => {
    const names = defaultBrowserNames([
      { browserId: "c-late", kind: "chrome", startedAt: "2026-10-03T09:00:00.000Z" },
      { browserId: "edge", kind: "edge", startedAt: "2026-10-03T08:30:00.000Z" },
      { browserId: "c-early", kind: "chrome", startedAt: "2026-10-03T08:00:00.000Z" },
      { browserId: "c-mid", kind: "chrome", startedAt: "2026-10-03T08:45:00.000Z" },
    ]);
    expect(names).toEqual(
      new Map([
        ["c-early", "Chrome"],
        ["c-mid", "Chrome 2"],
        ["c-late", "Chrome 3"],
        ["edge", "Edge"],
      ]),
    );
  });

  it("renumbers when the first browser of a kind is gone", () => {
    expect(
      defaultBrowserNames([{ browserId: "c-late", kind: "chrome", startedAt: "2026-10-03T09:00:00.000Z" }]).get(
        "c-late",
      ),
    ).toBe("Chrome");
  });

  it("orders a tie by browser id, so every caller agrees", () => {
    const at = "2026-10-03T08:00:00.000Z";
    const forward = defaultBrowserNames([
      { browserId: "b", kind: "edge", startedAt: at },
      { browserId: "a", kind: "edge", startedAt: at },
    ]);
    expect(forward.get("a")).toBe("Edge");
    expect(forward.get("b")).toBe("Edge 2");
  });

  it("answers an empty map for no browsers", () => {
    expect(defaultBrowserNames([]).size).toBe(0);
  });
});
