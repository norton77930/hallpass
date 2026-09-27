import {
  AGENT_GROUP_TITLE,
  presentAgentGroup,
  WAITING_GROUP_TITLE,
  WORKING_GROUP_TITLE,
  type AgentGroupColour,
} from "../chrome-adapters/tab-groups.js";

/**
 * What a session's tab group says it is doing (016 FR-238 - FR-240, R-207, contracts/tab-group.md).
 *
 * Until 0.8.0 the group was titled once, when it was opened, and read "Agent" whatever the agent
 * was doing. The title now follows the session: the bell while a question of it waits on the
 * owner, the hourglass while a call is in flight, the plain name otherwise. Nothing else in the
 * worker hears both halves of that - the stop registry counts calls (`onChange`), the prompt
 * controller knows the question - so this module is told by both and asks both.
 *
 * Three rules shape it, each for the owner's tab strip:
 * - the hourglass stays for a second after the last call ends, and a call beginning inside that
 *   second keeps it without a write (FR-239) - consecutive calls must not flicker the title;
 * - a title is written only when it differs from the last one written - the strip is the owner's
 *   furniture, and a write that changes nothing is still a repaint;
 * - a session that has ended is forgotten at once, timer and all: its marking has been withdrawn
 *   ("" and grey, as 0.8.0), and anything written after that would put the claim back.
 *
 * Kept in memory. A worker that restarts re-presents the live sessions' groups from their records
 * (`AgentTabManager.presentHeldGroups`), which is also where the colour of a 0.8.0 group is fixed.
 */

/** How long the hourglass outlives the last call (FR-239: "about one second"). */
export const WORKING_LINGER_MS = 1000;

export type GroupPresenterDeps = {
  /** The session's in-flight call count, as the stop registry counts it. */
  inFlight: (sessionId: string) => number;
  /** Whether a question of this session is on the owner's screen now. */
  waiting: (sessionId: string) => boolean;
  /** The write; `chrome.tabGroups.update` through the adapter unless a test says otherwise. */
  update?: (groupId: number, properties: { title: string; color?: AgentGroupColour }) => Promise<void>;
  /** Told when a title write was refused - the owner closed the group, or is dragging a tab. */
  reportFailure?: (code: string) => void;
  lingerMs?: number;
};

export type GroupPresenter = {
  /**
   * The session has a group - just opened, joined again, or found at worker start - and it is
   * titled and coloured now, in one write. Awaited by the caller, which opened the group inside
   * its own queue; a refusal is the caller's, as the 0.8.0 marking's was.
   */
  present: (sessionId: string, groupId: number, colour: AgentGroupColour) => Promise<void>;
  /** The session's state may have moved (its count changed): write its title if it did. */
  refresh: (sessionId: string) => void;
  /** A question was raised or ended; any session's title may have moved. */
  refreshAll: () => void;
  /**
   * The session is over, or holds no tab of its group any more (T444): its marking is about to be
   * withdrawn, so forget it and its pending second, and nothing is ever written to that group again.
   * A later `present` - the session's next group - starts afresh.
   */
  end: (sessionId: string) => void;
};

type Presented = {
  groupId: number;
  /** The last title written, or `undefined` when unknown (a write was refused). */
  lastTitle: string | undefined;
  /** Working, or inside the second after the last call ended. */
  working: boolean;
  linger: ReturnType<typeof setTimeout> | undefined;
  /** Bumped per write, so a refused write only forgets a title nothing later replaced. */
  writes: number;
};

export function createGroupPresenter(deps: GroupPresenterDeps): GroupPresenter {
  const update = deps.update ?? presentAgentGroup;
  const lingerMs = deps.lingerMs ?? WORKING_LINGER_MS;
  const presented = new Map<string, Presented>();

  function wanted(sessionId: string, state: Presented): string {
    if (deps.waiting(sessionId)) return WAITING_GROUP_TITLE;
    return state.working ? WORKING_GROUP_TITLE : AGENT_GROUP_TITLE;
  }

  /** Moves `working` on from the count: on at once, off only after a quiet `lingerMs`. */
  function track(sessionId: string, state: Presented): void {
    if (deps.inFlight(sessionId) > 0) {
      if (state.linger !== undefined) clearTimeout(state.linger);
      state.linger = undefined;
      state.working = true;
      return;
    }
    if (!state.working || state.linger !== undefined) return;
    state.linger = setTimeout(() => {
      // Ended, or presented again, since this was armed: the second belongs to nothing now.
      if (presented.get(sessionId) !== state) return;
      state.linger = undefined;
      state.working = false;
      apply(sessionId, state);
    }, lingerMs);
  }

  function apply(sessionId: string, state: Presented): void {
    const title = wanted(sessionId, state);
    if (title === state.lastTitle) return;
    state.lastTitle = title;
    const write = ++state.writes;
    update(state.groupId, { title }).catch(() => {
      // Not retried here: the next change writes again, and a group the owner closed is simply
      // gone. Forgetting the title is what makes that next write happen.
      if (state.writes === write) state.lastTitle = undefined;
      deps.reportFailure?.("agent.groups.present-failed");
    });
  }

  function refresh(sessionId: string): void {
    const state = presented.get(sessionId);
    if (state === undefined) return;
    track(sessionId, state);
    apply(sessionId, state);
  }

  return {
    async present(sessionId, groupId, colour) {
      const previous = presented.get(sessionId);
      if (previous?.linger !== undefined) clearTimeout(previous.linger);
      const state: Presented = {
        groupId,
        lastTitle: undefined,
        working: false,
        linger: undefined,
        writes: 0,
      };
      presented.set(sessionId, state);
      track(sessionId, state);
      const title = wanted(sessionId, state);
      state.lastTitle = title;
      const write = ++state.writes;
      try {
        await update(groupId, { title, color: colour });
      } catch (error) {
        if (state.writes === write) state.lastTitle = undefined;
        throw error;
      }
    },
    refresh,
    refreshAll() {
      for (const sessionId of [...presented.keys()]) refresh(sessionId);
    },
    end(sessionId) {
      const state = presented.get(sessionId);
      if (state === undefined) return;
      if (state.linger !== undefined) clearTimeout(state.linger);
      presented.delete(sessionId);
    },
  };
}
