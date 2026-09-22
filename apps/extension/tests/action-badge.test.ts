import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ATTENTION_BADGE_COLOUR,
  ATTENTION_BADGE_TEXT,
  ATTENTION_TITLE,
  setAttention,
} from "../src/chrome-adapters/action-badge.js";

/**
 * 011/T292, T293 — the toolbar icon while a question is waiting where nobody can see it.
 *
 * Chrome will not let the worker open the side panel (R-160), so the badge is the browser's own
 * half of telling the person: the agent's reply says the words, the badge says where. The adapter
 * decides nothing - it is handed `true` or `false` by the runtime's derivation and makes the four
 * `chrome.action` calls that follow from it - which is what lets the derivation be tested with no
 * browser at all.
 *
 * Clearing puts back the manifest's own title rather than a string written here: the manifest
 * names a message (`__MSG_extActionTitle__`), so the person gets it in the language their browser
 * is in, and a second copy of that text in this file is a second thing to keep in step.
 */

type Recorded = { badgeText: string[]; colours: string[]; titles: string[] };

function stubChrome(options: { defaultTitle?: string; message?: string; action?: boolean } = {}): Recorded {
  const recorded: Recorded = { badgeText: [], colours: [], titles: [] };
  vi.stubGlobal("chrome", {
    ...(options.action === false
      ? {}
      : {
          action: {
            async setBadgeText({ text }: { text: string }) {
              recorded.badgeText.push(text);
            },
            async setBadgeBackgroundColor({ color }: { color: string }) {
              recorded.colours.push(color);
            },
            async setTitle({ title }: { title: string }) {
              recorded.titles.push(title);
            },
          },
        }),
    runtime: {
      getManifest: () => ({ action: { default_title: options.defaultTitle ?? "__MSG_extActionTitle__" } }),
    },
    i18n: { getMessage: (name: string) => (name === "extActionTitle" ? (options.message ?? "Open Hallpass") : "") },
  });
  return recorded;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("T293 the attention badge", () => {
  it("marks the icon and says why while a question waits", () => {
    const recorded = stubChrome();

    setAttention(true);

    expect(recorded.badgeText).toEqual([ATTENTION_BADGE_TEXT]);
    expect(recorded.colours).toEqual([ATTENTION_BADGE_COLOUR]);
    expect(recorded.titles).toEqual([ATTENTION_TITLE]);
    // The person reads this in a tooltip with no context around it, so it has to name the product
    // and the one move that answers the question (contracts/prompt-waiting.md).
    expect(ATTENTION_TITLE).toContain("side panel");
  });

  it("clears the mark and puts the manifest's own title back", () => {
    const recorded = stubChrome({ message: "Open Hallpass" });

    setAttention(false);

    expect(recorded.badgeText).toEqual([""]);
    expect(recorded.titles).toEqual(["Open Hallpass"]);
    // Nothing to colour: the background of an empty badge is not shown, and setting it would be a
    // call whose only effect is to be wrong the next time the palette changes.
    expect(recorded.colours).toEqual([]);
  });

  it("uses the manifest's title as it stands when it names no message", () => {
    const recorded = stubChrome({ defaultTitle: "Hallpass" });

    setAttention(false);

    expect(recorded.titles).toEqual(["Hallpass"]);
  });

  it("does nothing in a worker that has no action to mark", () => {
    stubChrome({ action: false });

    expect(() => setAttention(true)).not.toThrow();
  });
});
