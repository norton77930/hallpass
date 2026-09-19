/**
 * The baseline source (004/T085, R-118 "Risk and fallback").
 *
 * R-118 left one question open: can a non-interactive `claude -p` session call the *reference*
 * extension's tools, so that the parity scenarios can compare against them directly?
 *
 * **Answered live on 2026-09-09** by `scenarios/s0-baseline-source.json`: no. The reference is
 * installed and enabled in the owner's profile, but it publishes no MCP server - the session sees
 * `mcp__hallpass__*` and nothing matching `mcp__claude-in-chrome__*`, and both attempted calls
 * came back `no-such-tool`. So the fallback R-118 provided for is the one in force: the baseline for
 * every tree scenario is the browser's own accessibility tree, read over the same debugging session
 * the probe is already attached to, and the report records `baselineSource: "browser-tree"`.
 *
 * That is the same source the reference reads, which is what makes it a fair baseline: what the
 * agent build returns is compared against what the page actually exposes, not against this project's
 * own idea of the page.
 */

export type BaselineTarget = {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
  /** The target this one is embedded in; how an out-of-process frame says whose frame it is. */
  parentId?: string;
};

export type BaselineFetch = (
  url: string,
  init?: { method?: string },
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

/** One CDP command on a page target's socket; the seam the tests replace. */
export type BaselineSend = (socketUrl: string, method: string, params: Record<string, unknown>) => Promise<unknown>;

export type BaselineDeps = { endpoint: string; fetch: BaselineFetch; send: BaselineSend };

/** What a tree scenario is judged against: how much of the page was really there. */
export type PageTreeBaseline = {
  url: string;
  /** Every AX node the browser exposes, all frames included. */
  nodeCount: number;
  /** How many distinct frames contributed nodes - the number E4 turns on. */
  frameCount: number;
  /** A few names, so a report reader can see *what* was missed and not only how much. */
  sampleNames: string[];
  /**
   * The page's own names, bucketed the way SC-036 judges them (T117b).
   *
   * Headings and links are what the **full** read has to carry, controls what the **default** read
   * has to carry. They are kept apart here rather than merged into one list because the two reads
   * answer different questions and are judged separately.
   */
  named: { headings: string[]; links: string[]; controls: string[] };
};

type AxNode = {
  nodeId?: unknown;
  frameId?: unknown;
  ignored?: unknown;
  role?: { value?: unknown };
  name?: { value?: unknown };
};

/**
 * The control roles SC-036's *default* read is judged on (T117b).
 *
 * Deliberately the roles a person can act on, because that is what the default read claims to
 * return; a generic container or a paragraph belongs to the full read's half of the standard and is
 * not something the default read failing to name is a defect.
 */
const CONTROL_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
]);

const addName = (into: string[], value: unknown): void => {
  if (typeof value !== "string") {
    return;
  }
  const name = value.trim();
  if (name !== "" && !into.includes(name)) {
    into.push(name);
  }
};

/** Reduces `Accessibility.getFullAXTree`'s answer to the three numbers a scenario compares. */
export function summariseAxTree(url: string, payload: unknown, sampleLimit = 8): PageTreeBaseline {
  const nodes = (payload as { nodes?: unknown } | undefined)?.nodes;
  const list: AxNode[] = Array.isArray(nodes) ? (nodes as AxNode[]) : [];
  const visible = list.filter((node) => node.ignored !== true);
  const frames = new Set<string>();
  const sampleNames: string[] = [];
  const named = { headings: [] as string[], links: [] as string[], controls: [] as string[] };

  for (const node of visible) {
    if (typeof node.frameId === "string") {
      frames.add(node.frameId);
    }
    const name = node.name?.value;
    if (typeof name === "string" && name.trim() !== "" && sampleNames.length < sampleLimit) {
      sampleNames.push(name.trim());
    }
    const role = typeof node.role?.value === "string" ? node.role.value.toLowerCase() : "";
    if (role === "heading") {
      addName(named.headings, name);
    } else if (role === "link") {
      addName(named.links, name);
    } else if (CONTROL_ROLES.has(role)) {
      addName(named.controls, name);
    }
  }

  return {
    url,
    nodeCount: visible.length,
    frameCount: Math.max(frames.size, visible.length > 0 ? 1 : 0),
    sampleNames,
    named,
  };
}

/**
 * The page's own frames, however deep (004/T129a).
 *
 * A cross-origin frame is a *target*, not a subtree: it has its own id, its own socket and its own
 * accessibility tree, and the page's target cannot see into it. The chain is followed transitively
 * because a frame may embed another, and it is followed **from this page only** - every other page
 * the owner has open has frames too, and merging those would put names in the baseline that the
 * scenario's page never showed.
 */
export function frameTargetsOf(targets: readonly BaselineTarget[], pageId: string): BaselineTarget[] {
  const owned = new Set([pageId]);
  const frames: BaselineTarget[] = [];
  // Repeated until nothing new is claimed, because `/json/list` does not promise a parent is listed
  // before its child.
  let grew = true;
  while (grew) {
    grew = false;
    for (const entry of targets) {
      if (entry.type !== "iframe" || owned.has(entry.id) || entry.parentId === undefined) {
        continue;
      }
      if (owned.has(entry.parentId)) {
        owned.add(entry.id);
        frames.push(entry);
        grew = true;
      }
    }
  }
  return frames;
}

/**
 * One baseline from several targets' trees (004/T129a).
 *
 * Counts add up and names are unioned in the order the targets were read, so the page's own names
 * come first and the frame's after them - which is the order a reader of the report expects, and it
 * keeps the page's spelling when both name the same thing.
 */
export function mergeTreeBaselines(url: string, parts: readonly PageTreeBaseline[], sampleLimit = 8): PageTreeBaseline {
  const merged: PageTreeBaseline = {
    url,
    nodeCount: 0,
    frameCount: 0,
    sampleNames: [],
    named: { headings: [], links: [], controls: [] },
  };
  for (const part of parts) {
    merged.nodeCount += part.nodeCount;
    merged.frameCount += part.frameCount;
    for (const name of part.sampleNames) {
      if (merged.sampleNames.length < sampleLimit && !merged.sampleNames.includes(name)) {
        merged.sampleNames.push(name);
      }
    }
    for (const bucket of ["headings", "links", "controls"] as const) {
      for (const name of part.named[bucket]) {
        if (!merged.named[bucket].includes(name)) {
          merged.named[bucket].push(name);
        }
      }
    }
  }
  return merged;
}

/** Finds the page target whose url the scenario names; a prefix match, because pages redirect. */
export function findPageTarget(targets: readonly BaselineTarget[], url: string): BaselineTarget | undefined {
  const pages = targets.filter((entry) => entry.type === "page");
  return pages.find((entry) => entry.url === url) ?? pages.find((entry) => entry.url.startsWith(url));
}

/**
 * Reads the browser's own tree for a page, its cross-origin frames included (004/T129a).
 *
 * `Accessibility.enable` first, because `getFullAXTree` on a domain that was never enabled answers
 * with an empty tree rather than an error - a silent zero would read in the report as "the page was
 * empty" instead of "the probe forgot to enable the domain". Each frame is asked on **its own**
 * socket for the same reason: the domain is enabled per client and per target, and the page's target
 * answers nothing about a frame that is out of its process. A page whose content is in such a frame
 * - which is the artifact page, the one SC-033 is about - otherwise produced a baseline of nothing,
 * and containment of nothing is a pass that measured no page at all.
 */
export async function readPageTreeBaseline(deps: BaselineDeps, url: string): Promise<PageTreeBaseline | undefined> {
  const response = await deps.fetch(`${deps.endpoint}/json/list`);
  const targets = response.ok ? ((await response.json()) as BaselineTarget[]) : [];
  const list = Array.isArray(targets) ? targets : [];
  const target = findPageTarget(list, url);
  if (target?.webSocketDebuggerUrl === undefined) {
    return undefined;
  }

  const parts: PageTreeBaseline[] = [];
  for (const frame of [target, ...frameTargetsOf(list, target.id)]) {
    if (frame.webSocketDebuggerUrl === undefined) {
      continue;
    }
    await deps.send(frame.webSocketDebuggerUrl, "Accessibility.enable", {});
    const tree = await deps.send(frame.webSocketDebuggerUrl, "Accessibility.getFullAXTree", {});
    parts.push(summariseAxTree(frame.url, tree));
  }
  return mergeTreeBaselines(target.url, parts);
}

/**
 * The real CDP client (004/T117b).
 *
 * One socket per target, kept open for the life of the run and reused, because `Accessibility` is
 * enabled **per client**: enabling on one connection and asking on another answers with an empty
 * tree, and an empty tree reads in a report as "the page was empty" rather than "the probe asked
 * from the wrong seat".
 */
const sockets = new Map<string, Promise<WebSocket>>();
let nextCommandId = 1;

async function openSocket(socketUrl: string): Promise<WebSocket> {
  const socket = new WebSocket(socketUrl);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("probe-004: baseline socket failed")), { once: true });
  });
  return socket;
}

export const realSend: BaselineSend = async (socketUrl, method, params) => {
  let pending = sockets.get(socketUrl);
  if (pending === undefined) {
    pending = openSocket(socketUrl);
    sockets.set(socketUrl, pending);
  }
  const socket = await pending;
  const id = nextCommandId++;
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`probe-004: ${method} timed out`)), 30_000);
    const onMessage = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: unknown };
      if (message.id !== id) {
        return;
      }
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      if (message.error !== undefined) {
        reject(new Error(`probe-004: ${method} failed ${JSON.stringify(message.error)}`));
        return;
      }
      resolve(message.result);
    };
    socket.addEventListener("message", onMessage);
    socket.send(JSON.stringify({ id, method, params }));
  });
};

/** Lets the run end: an open DevTools socket keeps Node alive. */
export function closeBaselineSockets(): void {
  for (const pending of sockets.values()) {
    void pending.then((socket) => socket.close()).catch(() => undefined);
  }
  sockets.clear();
}
