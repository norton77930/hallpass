import { AGENT_SESSION_COLOURS } from "@hallpass/contracts";
import {
  AGENT_GROUP_TITLE,
  clearAgentGroupMarking,
  groupTabs,
  presentAgentGroup,
  queryAgentGroupIds,
  ungroupTabs,
  UNGROUPED_TAB_GROUP_ID,
  type AgentGroupColour,
} from "../chrome-adapters/tab-groups.js";
import { getTabSnapshot, queryTabSnapshots } from "../chrome-adapters/tabs.js";

/**
 * Which tabs an agent session owns (003/T017, R-104).
 *
 * The record of ownership is a `chrome.tabGroups` group, not a private list: the owner can see it,
 * and Chrome maintains it. The list this module keeps in `chrome.storage.session` exists for the
 * one thing the group cannot tell us - which tabs the session *had*, so a tab the owner closed by
 * hand can be reported "gone" once rather than silently forgotten (FR-044).
 *
 * Sessions die with the browser, so the record lives in session storage (R-108).
 */

/**
 * One tab of a session, as `tabs_context` reports it (contracts `agentTabViewSchema`).
 *
 * `active` is carried because it decides what a screenshot can see: `captureVisibleTab` photographs
 * the active tab of a window, and a session holding three tabs has no other way to know which one
 * that is.
 */
/**
 * `title` is Chrome's own title for the tab (004 FR-060), carried because the panel and the tool
 * answer are the same shape and the tool must name every tab by title. It is read from the tab
 * record, never from the document.
 */
export type AgentTab = { tabId: number; url: string; title: string; active: boolean };

/**
 * One tab held by one session (004 data-model TabLease, R-117).
 *
 * `kind` is not decoration: a tab the session opened is the agent's own furniture, while a tab it
 * claimed is the owner's and was lent. The owner reads that difference in the panel, and it is the
 * only record of it - the group cannot carry it, because both kinds sit in the same group.
 */
export type TabLease = { tabId: number; sessionId: string; kind: "agent" | "owner"; since: string };

/**
 * What the ownership guard answers (004/T102, replacing 003's group check).
 *
 * Four facts rather than 003's three, because 004 has more than one session and the owner's own
 * tabs: "somebody else holds it" and "nobody holds it" led to the same refusal in 003 and lead to
 * two different next moves here - wait, or claim (contracts `agentRefusalSchema`). The holder is
 * carried with the first, for the same reason: a refusal the agent cannot act on is one it repeats.
 */
export type TabOwnership =
  | { state: "this" }
  | { state: "held-by-session"; sessionId: string }
  | { state: "not-yours" }
  | { state: "gone" };

/** What `claim` answers; the refusals are the contract's own words (`agentRefusalSchema`). */
export type TabClaim =
  | { ok: true; lease: TabLease }
  | { ok: false; reason: "held-by-session"; sessionId: string }
  | { ok: false; reason: "restricted-page" }
  | { ok: false; reason: "tab-gone" };

export type AgentTabContext = {
  tabs: AgentTab[];
  /** Tabs this session had that the browser no longer has, reported once (FR-044). */
  gone: number[];
};

/**
 * `lastHelloAt` is when the session last announced itself (data-model AgentSession, 004 US2).
 *
 * It lives beside the group rather than in the worker's memory because that is the only copy that
 * survives an eviction: the 15 s reconciliation is armed by an alarm, and an alarm's whole point is
 * that it fires in a worker that has forgotten everything it was holding.
 */
type SessionRecord = {
  groupId?: number;
  tabIds: number[];
  lastHelloAt?: string;
  /** The tab most recently created, claimed or acted on; the indicator's control targets it. */
  mainTabId?: number;
  /**
   * When this worker first saw the session (016 FR-228, R-205). Written once and never by a
   * re-greeting, which is why `lastHelloAt` could not serve: every greeting overwrites it.
   */
  firstSeenAt?: string;
  /** The session's place in the colour rotation, handed out once from `COLOUR_NEXT_KEY` (R-205). */
  colourIndex?: number;
  /** The folder the session's host reported (016 FR-226). Remote input: stored, shown, never logged. */
  label?: string;
};

/** What a card needs to say which session it is (016 data-model "Session record"). */
export type AgentSessionIdentity = { firstSeenAt: string; colourIndex: number; label?: string };

const STORAGE_KEY = "agentSessions";

/**
 * The next colour index to hand out (016 R-205). Kept beside the records, in the session area, so a
 * worker restart continues the rotation instead of giving the next session the first one's colour.
 */
const COLOUR_NEXT_KEY = "agentSessionColourNext";

/** The lease table, keyed by tab id as a string because that is what a storage record is keyed by. */
const LEASES_KEY = "agentTabLeases";

/**
 * When the current relay announced itself. Every session with an older `lastHelloAt` has not
 * greeted the relay that is running now, which is what the reconciliation releases.
 */
const RECONCILE_KEY = "agentReconcileFrom";

async function readSessions(): Promise<Record<string, SessionRecord>> {
  const area = typeof chrome !== "undefined" ? chrome.storage?.session : undefined;
  if (!area) {
    return {};
  }
  const raw = (await area.get([STORAGE_KEY])) as Record<string, unknown>;
  const stored = raw[STORAGE_KEY];
  return stored && typeof stored === "object" ? ({ ...stored } as Record<string, SessionRecord>) : {};
}

async function readReconcileFrom(): Promise<string | undefined> {
  const area = typeof chrome !== "undefined" ? chrome.storage?.session : undefined;
  if (!area) {
    return undefined;
  }
  const raw = (await area.get([RECONCILE_KEY])) as Record<string, unknown>;
  const stored = raw[RECONCILE_KEY];
  return typeof stored === "string" ? stored : undefined;
}

async function writeSessions(sessions: Record<string, SessionRecord>): Promise<void> {
  const area = typeof chrome !== "undefined" ? chrome.storage?.session : undefined;
  if (!area) {
    return;
  }
  await area.set({ [STORAGE_KEY]: sessions });
}

/** Takes the next colour index and moves the persisted counter on (016 R-205). */
async function takeColourIndex(): Promise<number> {
  const area = typeof chrome !== "undefined" ? chrome.storage?.session : undefined;
  if (!area) {
    return 0;
  }
  const raw = (await area.get([COLOUR_NEXT_KEY])) as Record<string, unknown>;
  const stored = raw[COLOUR_NEXT_KEY];
  const next = typeof stored === "number" && Number.isInteger(stored) && stored >= 0 ? stored : 0;
  await area.set({ [COLOUR_NEXT_KEY]: next + 1 });
  return next;
}

/**
 * Gives a record the identity fields it lacks, in place, and says whether it changed anything.
 *
 * A record written by 0.8.0 has neither: its start is taken to be its last greeting - the earliest
 * moment this worker can vouch for - and it gets the next colour. `fallbackAt` is for a record with
 * no greeting at all (one `adopt` created), which is then first seen now.
 */
async function fillIdentity(record: SessionRecord, fallbackAt: string): Promise<boolean> {
  let changed = false;
  if (record.firstSeenAt === undefined) {
    record.firstSeenAt = record.lastHelloAt ?? fallbackAt;
    changed = true;
  }
  if (record.colourIndex === undefined) {
    record.colourIndex = await takeColourIndex();
    changed = true;
  }
  return changed;
}

/** The session's colour from its place in the rotation (016 FR-240, R-205). */
function colourOf(record: SessionRecord): AgentGroupColour {
  return AGENT_SESSION_COLOURS[(record.colourIndex ?? 0) % AGENT_SESSION_COLOURS.length] as AgentGroupColour;
}

type StoredLeases = Record<string, { sessionId: string; kind: TabLease["kind"]; since: string }>;

async function readLeases(): Promise<StoredLeases> {
  const area = typeof chrome !== "undefined" ? chrome.storage?.session : undefined;
  if (!area) {
    return {};
  }
  const raw = (await area.get([LEASES_KEY])) as Record<string, unknown>;
  const stored = raw[LEASES_KEY];
  return stored && typeof stored === "object" ? ({ ...stored } as StoredLeases) : {};
}

async function writeLeases(leases: StoredLeases): Promise<void> {
  const area = typeof chrome !== "undefined" ? chrome.storage?.session : undefined;
  if (!area) {
    return;
  }
  await area.set({ [LEASES_KEY]: leases });
}

function asLeases(stored: StoredLeases): TabLease[] {
  return Object.entries(stored)
    .map(([tabId, lease]) => ({ tabId: Number(tabId), ...lease }))
    .sort((left, right) => left.tabId - right.tabId);
}

/**
 * A page no session may hold, whatever the owner asks for.
 *
 * The same family the reads call `not-readable` (FR-039): a scheme the content runtime cannot be
 * injected into is a page an agent could be given a lease on and then do nothing with, so the
 * refusal is at the claim rather than at the first tool that tries. The url is the only thing a
 * lease can ask about - it is granted before anything is injected - so this is a scheme test and
 * deliberately not the full page classification, which needs a document.
 */
function isRestrictedPage(url: string): boolean {
  const protocol = url.slice(0, Math.max(0, url.indexOf(":") + 1)).toLowerCase();
  return protocol !== "http:" && protocol !== "https:";
}

export type AgentTabManager = {
  /** The session's live tabs, plus the ones it lost since the last call. */
  context: (sessionId: string) => Promise<AgentTabContext>;
  /** The guard every tool that names a tab runs first (FR-034, now the lease). */
  ownership: (sessionId: string, tabId: number) => Promise<TabOwnership>;
  /**
   * Takes an unheld tab for the session (004/T102, R-117): the lease first, the visible group
   * marking with it. A tab another live session holds is never taken from it.
   */
  claim: (sessionId: string, tabId: number) => Promise<TabClaim>;
  /** Every lease that exists right now; `tabs_context` reads it to name each tab's holder. */
  leases: () => Promise<TabLease[]>;
  /**
   * Every session holding at least one tab right now, in lease order (005/T178, FR-077).
   *
   * A browser download carries no tab id, so the observer's whole rule is "who holds a tab at this
   * moment"; the answer is read from the leases, which are the one authority on holding. A session
   * that announced itself and holds nothing is alive but not a holder.
   */
  sessionsHoldingAnyTab: () => Promise<string[]>;
  /** The session's main tab - what the indicator's control brings forward. */
  mainTabId: (sessionId: string) => Promise<number | undefined>;
  /** An effect landed on one of the session's tabs, which makes it the main one (data-model). */
  touch: (sessionId: string, tabId: number) => Promise<void>;
  /** Convenience over `ownership` for callers that only branch on yes/no. */
  owns: (sessionId: string, tabId: number) => Promise<boolean>;
  /** Brings a tab into the session's group, creating and marking the group on the first one. */
  adopt: (sessionId: string, tabId: number) => Promise<void>;
  /** Forgets a tab the session closed itself, so it is not later reported "gone". */
  release: (sessionId: string, tabId: number) => Promise<void>;
  /**
   * The agent session is over (003/M4 Part A): forget the record and withdraw the group's marking.
   *
   * A relay dropping is *not* this - the relay comes and goes while one agent session runs, and the
   * record is what a reconnect reconciles against (D-M3-3). Only the host saying its MCP session
   * ended reaches here. Leaving the record behind would keep the session's tabs hostage from every
   * later session (`adopt` refuses another session's tab), and leaving the marking on would tell the
   * owner an agent is driving tabs no agent can reach.
   */
  endSession: (sessionId: string) => Promise<void>;
  /**
   * The session just announced itself - its server greeted the relay and asked to pair again
   * (004 US2). Recording the moment is what makes the reconciliation a comparison rather than a
   * guess, and it creates the record for a session that owns no tab yet, so a session that greeted
   * and has not opened anything is still known to be alive.
   */
  announce: (sessionId: string, at: string) => Promise<void>;
  /**
   * The folder a session's host reported (016 FR-226). Stored only on a record that exists - a
   * label for a session this worker has no record of is dropped - and the answer says which.
   */
  setLabel: (sessionId: string, label: string) => Promise<boolean>;
  /**
   * The session's start, colour and label as its record holds them (016 FR-227, FR-228, R-205).
   *
   * A 0.8.0 record is filled here, and the fill is written, so the colour a card shows does not
   * change between two reads. `undefined` for a session with no record.
   */
  identity: (sessionId: string) => Promise<AgentSessionIdentity | undefined>;
  /**
   * Un-marks every agent-titled group no session record accounts for, and names them (004/T099l).
   *
   * `endSession` can only run while the worker that holds the session is alive, so it never sees
   * the two endings that matter most to the owner's tab strip: a browser restart that restores the
   * titled group without the session records (they live in `chrome.storage.session`), and an
   * extension reload. Both leave a group titled as ours (016 FR-241: 0.8.0's "Agent", or "Hallpass"
   * with or without its prefix) with no agent behind it, which is exactly
   * the claim the marking exists to make honestly. The worker sweeps at start because that is the
   * first moment after either ending at which anything of ours runs.
   */
  sweepOrphanedGroups: () => Promise<number[]>;
  /**
   * Presents every group a live session record holds again (016 R-207), at worker start.
   *
   * The presenter keeps what it wrote in memory, so a worker that restarted knows no group: without
   * this, a session that goes on working in the tabs it already has would never show the hourglass
   * again. It is also what gives a group opened by 0.8.0 its session's colour. A group that is gone
   * is skipped.
   */
  presentHeldGroups: () => Promise<void>;
  /** The relay started at `at`; every session must announce itself again before the bound. */
  beginReconciliation: (at: string) => Promise<void>;
  /**
   * End every session that has not announced itself since the relay started, and name them.
   *
   * The answer is computed from `chrome.storage.session` rather than from anything the worker is
   * holding, because the bound is an alarm and the worker that runs it may be a fresh one that was
   * evicted halfway through the window.
   */
  reconcile: () => Promise<string[]>;
};

/**
 * Told whenever a tab joins or leaves a session (004/T107b).
 *
 * The hooks live here rather than in the tools because *this* is where a lease is written and
 * dropped: `tabs_create` adopts, `tabs_claim` claims, a close and a release both let go, and a
 * session ending lets go of everything at once. A caller-side hook would have to be repeated at
 * each of those and would be forgotten at one of them.
 *
 * They are called after the record is written, and they are told a fact rather than asked a
 * question: nothing here waits for them, so a hook that sends a page a message cannot stall the
 * queue every tool call is serialised through.
 */
export type AgentTabHooks = {
  onTabJoined?: (sessionId: string, tabId: number) => void;
  onTabLeft?: (sessionId: string, tabId: number) => void;
  /**
   * The session's record is gone (005/T178, FR-080). Told after the tabs are, for whatever else was
   * kept per session and has to go with it - the download ring is the one such thing today.
   */
  onSessionEnded?: (sessionId: string) => void;
  /**
   * Titles and colours a session's group (016 FR-238, FR-240, R-207) - the group presenter, which
   * decides the title from the session's state. Unlike the hooks above it is *awaited*: it is the
   * marking itself, and a tab must not be reported adopted into a group nobody has marked yet.
   * Without one, the group gets the idle title and the session's colour.
   */
  presentGroup?: (sessionId: string, groupId: number, colour: AgentGroupColour) => Promise<void>;
  /**
   * The session holds no tab of its group any more (016 R-207, T444): it released the last one, or
   * the owner dragged them all out or closed them all. The group is no longer its to title: Chrome
   * discards an empty group, and one the owner kept alive with a tab of theirs is theirs, so its
   * marking is withdrawn right after this returns. The session itself goes on; `onSessionEnded` is
   * its end.
   */
  onGroupLeft?: (sessionId: string) => void;
};

export function createAgentTabManager(hooks: AgentTabHooks = {}): AgentTabManager {
  const presentGroup =
    hooks.presentGroup ??
    ((_sessionId: string, groupId: number, color: AgentGroupColour) =>
      presentAgentGroup(groupId, { title: AGENT_GROUP_TITLE, color }));

  /**
   * Marks a group the session has just come to hold (016 R-207): opened now, or joined again from
   * holding no tab - the presenter forgot it when the session's last tab left. The record is given
   * its identity first, so a record `adopt` creates still has a colour to show (FR-240). The caller
   * holds the queue and writes `sessions`.
   */
  async function markGroup(
    sessions: Record<string, SessionRecord>,
    sessionId: string,
    groupId: number,
  ): Promise<void> {
    const record: SessionRecord = { ...(sessions[sessionId] ?? { tabIds: [] }) };
    await fillIdentity(record, new Date().toISOString());
    sessions[sessionId] = record;
    await presentGroup(sessionId, groupId, colourOf(record));
  }

  /**
   * The session holds no tab of its group any more (016 FR-238, R-207, T444 review F1/F2): it
   * released the last one, or the owner dragged them all out or closed them all. The marking is
   * withdrawn exactly as the session's end withdraws it, because a group the owner kept alive with
   * a tab of theirs is theirs now, and a title frozen on `⌛ Hallpass` would claim an agent drives it.
   *
   * The presenter is told first, and synchronously, so nothing it still had pending is written over
   * the withdrawal. The caller holds the queue and has already written the record without `groupId`:
   * the session's next tab opens a group of its own rather than joining - and re-marking - the
   * owner's, and the session's end never writes to a group that is no longer its.
   */
  async function leaveGroup(sessionId: string, groupId: number): Promise<void> {
    hooks.onGroupLeft?.(sessionId);
    try {
      await clearAgentGroupMarking(groupId);
    } catch {
      // "No group with id": Chrome discarded the group with its last tab, which is the end state.
    }
  }

  /**
   * One chain for every read-modify-write. Two tool calls arriving together would otherwise each
   * read the session record, add their own tab and write it back, losing one of the two.
   */
  let queue: Promise<unknown> = Promise.resolve();

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(work);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Puts a tab into the session's group, opening and marking the group when there is none.
   *
   * Chrome discards a group the moment its last tab leaves it, so a session that closed all its
   * tabs is holding an id that names nothing and adding to it throws. That is not a failure of the
   * claim - the session is still the session - so a fresh group is opened and marked, exactly as
   * the first one was. The caller already holds the queue and writes `sessions` itself.
   */
  async function joinGroup(
    sessions: Record<string, SessionRecord>,
    sessionId: string,
    tabId: number,
  ): Promise<number> {
    const record = sessions[sessionId];
    let groupId: number;
    let opened = record?.groupId === undefined || record.tabIds.length === 0;
    try {
      groupId = await groupTabs([tabId], record?.groupId);
    } catch {
      groupId = await groupTabs([tabId]);
      opened = true;
    }
    if (opened) {
      await markGroup(sessions, sessionId, groupId);
    }
    return groupId;
  }

  async function contextFor(sessionId: string): Promise<AgentTabContext> {
    const sessions = await readSessions();
    const record = sessions[sessionId];
    if (!record || record.groupId === undefined || record.tabIds.length === 0) {
      return { tabs: [], gone: [] };
    }
    const live = await queryTabSnapshots();
    const byId = new Map(live.map((tab) => [tab.id, tab]));
    const tabs: AgentTab[] = [];
    const gone: number[] = [];
    const kept: number[] = [];
    for (const tabId of record.tabIds) {
      const tab = byId.get(tabId);
      // Both halves of the check matter: a tab Chrome no longer has is gone, and a tab the owner
      // dragged out of the group is no longer the session's, even though the tab still exists.
      if (!tab || tab.groupId !== record.groupId) {
        gone.push(tabId);
        continue;
      }
      kept.push(tabId);
      tabs.push({ tabId: tab.id, url: tab.url, title: tab.title, active: tab.active });
    }
    // None of its tabs is in its group any more (T444 F1/F2): the group is withdrawn below.
    const leftGroup = gone.length > 0 && kept.length === 0;
    if (gone.length > 0) {
      const pruned: SessionRecord = { ...record, tabIds: kept };
      if (leftGroup) delete pruned.groupId;
      sessions[sessionId] = pruned;
      await writeSessions(sessions);
      // A tab the owner closed takes its lease with it (data-model TabLease): the lease names a tab
      // that no longer exists, and leaving it behind would refuse the *next* tab Chrome gives that
      // id to. Only this session's leases are touched; the others are about live tabs.
      const leases = await readLeases();
      let dropped = false;
      for (const tabId of gone) {
        if (leases[String(tabId)]?.sessionId === sessionId) {
          delete leases[String(tabId)];
          dropped = true;
        }
      }
      if (dropped) await writeLeases(leases);
    }
    if (leftGroup) await leaveGroup(sessionId, record.groupId);
    return { tabs, gone };
  }

  return {
    context(sessionId) {
      return enqueue(() => contextFor(sessionId));
    },
    ownership(sessionId, tabId) {
      return enqueue(async () => {
        // The tab first: a lease naming a tab Chrome no longer has is a fact about nothing, and
        // "gone" is what the agent acts on (FR-044).
        const tab = await getTabSnapshot(tabId);
        if (!tab) {
          return { state: "gone" } as const;
        }
        const lease = (await readLeases())[String(tabId)];
        if (!lease) {
          // The owner's own tab, or one every session has let go of. Not a refusal about somebody
          // else: it is the tab a `tabs_claim` would take (R-117).
          return { state: "not-yours" } as const;
        }
        return lease.sessionId === sessionId
          ? ({ state: "this" } as const)
          : ({ state: "held-by-session", sessionId: lease.sessionId } as const);
      });
    },
    async owns(sessionId, tabId) {
      return (await this.ownership(sessionId, tabId)).state === "this";
    },
    claim(sessionId, tabId) {
      return enqueue(async () => {
        const leases = await readLeases();
        const held = leases[String(tabId)];
        if (held && held.sessionId !== sessionId) {
          // The invariant: one lease per tab, and a live session's is never taken from it (SC-024).
          return { ok: false, reason: "held-by-session", sessionId: held.sessionId } as const;
        }
        const tab = await getTabSnapshot(tabId);
        if (!tab) {
          return { ok: false, reason: "tab-gone" } as const;
        }
        if (isRestrictedPage(tab.url)) {
          return { ok: false, reason: "restricted-page" } as const;
        }
        if (held) {
          // Claiming a tab this session already holds is not an error and does not re-date the
          // lease: the agent asked for what it already has. It is still announced, because the
          // page it is on may have navigated since and the indicator is cheap to restate.
          hooks.onTabJoined?.(sessionId, tabId);
          return { ok: true, lease: { tabId, ...held } } as const;
        }
        const sessions = await readSessions();
        const groupId = await joinGroup(sessions, sessionId, tabId);
        const lease = { sessionId, kind: "owner" as const, since: new Date().toISOString() };
        leases[String(tabId)] = lease;
        await writeLeases(leases);
        const record = sessions[sessionId] ?? { tabIds: [] };
        sessions[sessionId] = {
          ...record,
          groupId,
          mainTabId: tabId,
          tabIds: record.tabIds.includes(tabId) ? record.tabIds : [...record.tabIds, tabId],
        };
        await writeSessions(sessions);
        hooks.onTabJoined?.(sessionId, tabId);
        return { ok: true, lease: { tabId, ...lease } } as const;
      });
    },
    leases() {
      return enqueue(async () => asLeases(await readLeases()));
    },
    sessionsHoldingAnyTab() {
      return enqueue(async () => {
        const holders: string[] = [];
        for (const lease of asLeases(await readLeases())) {
          if (!holders.includes(lease.sessionId)) holders.push(lease.sessionId);
        }
        return holders;
      });
    },
    mainTabId(sessionId) {
      return enqueue(async () => (await readSessions())[sessionId]?.mainTabId);
    },
    touch(sessionId, tabId) {
      return enqueue(async () => {
        // Only a tab the session holds: an effect refused for want of a lease must not move the
        // indicator's control onto a tab this session may not even look at.
        if ((await readLeases())[String(tabId)]?.sessionId !== sessionId) return;
        const sessions = await readSessions();
        const record = sessions[sessionId];
        if (!record) return;
        sessions[sessionId] = { ...record, mainTabId: tabId };
        await writeSessions(sessions);
      });
    },
    adopt(sessionId, tabId) {
      return enqueue(async () => {
        const sessions = await readSessions();
        const leases = await readLeases();
        const held = leases[String(tabId)];
        // SC-024: one session never reaches into another's tabs, not even to claim one. The lease
        // is the authority; the tab list is still consulted for a record written before leases.
        if (held && held.sessionId !== sessionId) {
          throw new Error("tab-owned-by-another-session");
        }
        for (const [otherSession, record] of Object.entries(sessions)) {
          if (otherSession !== sessionId && record.tabIds.includes(tabId)) {
            throw new Error("tab-owned-by-another-session");
          }
        }
        /**
         * Chrome discards a group the moment its last tab leaves it, so a session that closed all
         * its tabs is holding an id that names nothing and adding to it throws. That is not a
         * failure of the adoption - the session is still the session - so a fresh group is opened
         * and marked, exactly as the first one was.
         */
        const previous = sessions[sessionId];
        let groupId: number;
        let opened = previous?.groupId === undefined || previous.tabIds.length === 0;
        try {
          groupId = await groupTabs([tabId], previous?.groupId);
        } catch {
          groupId = await groupTabs([tabId]);
          opened = true;
        }
        if (opened) {
          // The group exists only from its first tab, so the marking happens here rather than when
          // the session started - Chrome has no empty group to title.
          await markGroup(sessions, sessionId, groupId);
        }
        const record = sessions[sessionId] ?? { tabIds: [] };
        // The tab the session opened is the agent's own furniture, and it is the tab the session
        // is working on now (data-model AgentSession.mainTabId).
        leases[String(tabId)] = held ?? { sessionId, kind: "agent", since: new Date().toISOString() };
        await writeLeases(leases);
        sessions[sessionId] = {
          ...record,
          groupId,
          mainTabId: tabId,
          tabIds: record.tabIds.includes(tabId) ? record.tabIds : [...record.tabIds, tabId],
        };
        await writeSessions(sessions);
        hooks.onTabJoined?.(sessionId, tabId);
      });
    },
    endSession(sessionId) {
      return enqueue(async () => {
        const sessions = await readSessions();
        const record = sessions[sessionId];
        if (!record) {
          return;
        }
        delete sessions[sessionId];
        await writeSessions(sessions);
        // Every lease this session held, and nobody else's: the tabs of the other live sessions are
        // still theirs, and a wholesale clear is how one agent exiting would free another's tabs.
        const leases = await readLeases();
        let dropped = false;
        const left: number[] = [];
        for (const [tabId, lease] of Object.entries(leases)) {
          if (lease.sessionId === sessionId) {
            delete leases[tabId];
            left.push(Number(tabId));
            dropped = true;
          }
        }
        if (dropped) await writeLeases(leases);
        // In the session's own order, so the tab it joined first is the first told it is free.
        for (const tabId of record.tabIds) {
          if (left.includes(tabId)) hooks.onTabLeft?.(sessionId, tabId);
        }
        hooks.onSessionEnded?.(sessionId);
        if (record.groupId === undefined) {
          return;
        }
        try {
          await clearAgentGroupMarking(record.groupId);
        } catch {
          // The group is already gone - the owner closed every tab in it - which is the same end
          // state. Forgetting the record is what mattered and it is already written.
        }
      });
    },
    sweepOrphanedGroups() {
      return enqueue(async () => {
        const marked = await queryAgentGroupIds();
        if (marked.length === 0) {
          return [];
        }
        const sessions = await readSessions();
        const held = new Set(
          Object.values(sessions)
            .map((record) => record.groupId)
            .filter((groupId): groupId is number => groupId !== undefined),
        );
        const orphaned = marked.filter((groupId) => !held.has(groupId));
        for (const groupId of orphaned) {
          try {
            await clearAgentGroupMarking(groupId);
          } catch {
            // The group went away between the query and the update - the owner closed its last tab
            // - which is the end state the sweep wanted anyway.
          }
        }
        return orphaned;
      });
    },
    presentHeldGroups() {
      return enqueue(async () => {
        const sessions = await readSessions();
        let filled = false;
        for (const [sessionId, record] of Object.entries(sessions)) {
          if (record.groupId === undefined || record.tabIds.length === 0) continue;
          filled = (await fillIdentity(record, new Date().toISOString())) || filled;
          try {
            await presentGroup(sessionId, record.groupId, colourOf(record));
          } catch {
            // The group went while the worker was away - the owner closed its tabs. The next tab
            // the session opens opens a fresh group, marked then.
          }
        }
        if (filled) await writeSessions(sessions);
      });
    },
    announce(sessionId, at) {
      return enqueue(async () => {
        const sessions = await readSessions();
        const record: SessionRecord = { ...(sessions[sessionId] ?? { tabIds: [] }) };
        // 016 R-205: identity first, from the record as it was - a 0.8.0 record's previous greeting
        // is its start - and only then the greeting that overwrites `lastHelloAt`.
        await fillIdentity(record, at);
        sessions[sessionId] = { ...record, lastHelloAt: at };
        await writeSessions(sessions);
      });
    },
    setLabel(sessionId, label) {
      return enqueue(async () => {
        const sessions = await readSessions();
        const record = sessions[sessionId];
        if (!record) {
          return false;
        }
        sessions[sessionId] = { ...record, label };
        await writeSessions(sessions);
        return true;
      });
    },
    identity(sessionId) {
      return enqueue(async () => {
        const sessions = await readSessions();
        const stored = sessions[sessionId];
        if (!stored) {
          return undefined;
        }
        const record: SessionRecord = { ...stored };
        if (await fillIdentity(record, new Date().toISOString())) {
          sessions[sessionId] = record;
          await writeSessions(sessions);
        }
        return {
          firstSeenAt: record.firstSeenAt as string,
          colourIndex: record.colourIndex as number,
          ...(record.label === undefined ? {} : { label: record.label }),
        };
      });
    },
    beginReconciliation(at) {
      return enqueue(async () => {
        const area = typeof chrome !== "undefined" ? chrome.storage?.session : undefined;
        await area?.set({ [RECONCILE_KEY]: at });
      });
    },
    reconcile() {
      return enqueue(async () => {
        const from = await readReconcileFrom();
        if (from === undefined) {
          return [];
        }
        const sessions = await readSessions();
        const stale = Object.entries(sessions)
          // No `lastHelloAt` at all is the 003-shaped record of a session that greeted a relay this
          // one replaced; it is as stale as an old timestamp and is released for the same reason.
          .filter(([, record]) => record.lastHelloAt === undefined || record.lastHelloAt < from)
          .map(([sessionId]) => sessionId);
        return stale;
      });
    },
    release(sessionId, tabId) {
      return enqueue(async () => {
        const leases = await readLeases();
        if (leases[String(tabId)]?.sessionId === sessionId) {
          delete leases[String(tabId)];
          await writeLeases(leases);
          hooks.onTabLeft?.(sessionId, tabId);
          try {
            // The visible marking goes with the recorded one: a tab left in the agent's group after
            // the session let go of it tells the owner an agent is driving a tab no session holds.
            await ungroupTabs([tabId]);
          } catch {
            // Nothing to withdraw - the session closed the tab - which is the same end state.
          }
        }
        const sessions = await readSessions();
        const record = sessions[sessionId];
        if (!record) {
          return;
        }
        const kept: SessionRecord = {
          ...record,
          tabIds: record.tabIds.filter((candidate) => candidate !== tabId),
        };
        // The main tab was the one just released: the indicator's control has nowhere to go until
        // the session claims, creates or acts on another (data-model AgentSession).
        if (record.mainTabId === tabId) delete kept.mainTabId;
        // Its last tab: the group is no longer the session's to title, and is withdrawn (016 R-207, T444 F1).
        const leftGroup = record.groupId !== undefined && record.tabIds.length > 0 && kept.tabIds.length === 0;
        if (leftGroup) delete kept.groupId;
        sessions[sessionId] = kept;
        await writeSessions(sessions);
        if (leftGroup) await leaveGroup(sessionId, record.groupId as number);
      });
    },
  };
}

export { AGENT_GROUP_TITLE, UNGROUPED_TAB_GROUP_ID };
