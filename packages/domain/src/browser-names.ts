import type { AgentBrowserKind } from "@hallpass/contracts";

/** One connected browser, as much of it as its default name depends on (018 R-269). */
export type BrowserNameInput = {
  browserId: string;
  kind: AgentBrowserKind;
  /** The record's `startedAt`: when the browser connected. */
  startedAt: string;
};

/**
 * The display word for each kind. `unknown` - an extension older than 018, or a brand the worker
 * cannot place - is "Browser" rather than a guess at which browser it is.
 */
const KIND_NAMES: Readonly<Record<AgentBrowserKind, string>> = {
  chrome: "Chrome",
  edge: "Edge",
  brave: "Brave",
  chromium: "Chromium",
  unknown: "Browser",
};

function connectionOrder(left: BrowserNameInput, right: BrowserNameInput): number {
  const leftAt = Date.parse(left.startedAt);
  const rightAt = Date.parse(right.startedAt);
  if (!Number.isNaN(leftAt) && !Number.isNaN(rightAt) && leftAt !== rightAt) {
    return leftAt - rightAt;
  }
  if (left.startedAt !== right.startedAt) {
    return left.startedAt < right.startedAt ? -1 : 1;
  }
  return left.browserId < right.browserId ? -1 : left.browserId > right.browserId ? 1 : 0;
}

/**
 * The name each connected browser goes by when the owner has not named it (018 R-269, D-018-2).
 *
 * The kind's display name, numbered by connection order among browsers of the same kind: the first
 * Chrome is "Chrome", the next "Chrome 2". One pure function because two parties show these names -
 * the server in `list_browsers` and the relay in `browser-peers` for the panel - and the agent and
 * the owner must read the same word for the same browser. The numbering can shift when an earlier
 * browser of that kind leaves, which is why agents act on ids and never on names. A tie in
 * `startedAt` falls back to the id, so every caller numbers the same set the same way.
 */
export function defaultBrowserNames(browsers: readonly BrowserNameInput[]): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  const seen = new Map<AgentBrowserKind, number>();
  for (const browser of [...browsers].sort(connectionOrder)) {
    const count = (seen.get(browser.kind) ?? 0) + 1;
    seen.set(browser.kind, count);
    const word = KIND_NAMES[browser.kind];
    names.set(browser.browserId, count === 1 ? word : `${word} ${count}`);
  }
  return names;
}
