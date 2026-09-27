/**
 * The `chrome.tabGroups` surface the agent path uses (003/R-104).
 *
 * A session's tabs live in one group so the boundary is *visible*: the owner sees a titled,
 * coloured strip in their own tab strip and can tell at a glance which tabs an agent is driving.
 * That is why the marking is the group rather than, say, a favicon badge - the group is native
 * browser furniture the owner already understands, and it cannot be forged by a page.
 */

import type { AgentSessionColour } from "@hallpass/contracts";

/**
 * What the owner reads on an idle session's group (016 FR-238, R-207): the product's name, in no
 * locale's voice. Not localised - a name plus, below, two symbols.
 */
export const AGENT_GROUP_TITLE = "Hallpass";

/** The group of a session with a call in flight, or within a second of its last one (FR-239). */
export const WORKING_GROUP_TITLE = "⌛ Hallpass";

/** The group of a session whose question waits on the owner; it wins over working (FR-238). */
export const WAITING_GROUP_TITLE = "🔔 Hallpass";

/** What 0.8.0 and earlier titled every agent group; still recognised as stale (FR-241). */
export const LEGACY_AGENT_GROUP_TITLE = "Agent";

/**
 * Every title an agent group of ours has carried (016 FR-241, R-207), the one set the stale sweep
 * matches against. A group titled anything else is the owner's, whatever colour it is.
 */
export const STALE_AGENT_GROUP_TITLES: ReadonlySet<string> = new Set([
  LEGACY_AGENT_GROUP_TITLE,
  AGENT_GROUP_TITLE,
  WORKING_GROUP_TITLE,
  WAITING_GROUP_TITLE,
]);

/**
 * A session's group colour: the session's own colour from the rotation (016 FR-240, R-205), which
 * are all `chrome.tabGroups` colour names. Replaces 0.8.0's one fixed blue, so two sessions' groups
 * can be told apart and each matches its panel card.
 */
export type AgentGroupColour = AgentSessionColour;

/** Chrome's value for "this tab is in no group". */
export const UNGROUPED_TAB_GROUP_ID = -1;

/**
 * Puts tabs into `groupId`, or into a new group when none is given, and returns the group's id.
 * Chrome has no way to create an empty group, which is why a session's group comes into existence
 * with its first tab rather than with the session.
 */
export async function groupTabs(tabIds: number[], groupId?: number): Promise<number> {
  const options = groupId === undefined ? { tabIds } : { tabIds, groupId };
  return chrome.tabs.group(options as chrome.tabs.GroupOptions);
}

/**
 * Takes tabs out of whatever group they are in (004/T103).
 *
 * Releasing a lease has to withdraw the *visible* claim as well as the recorded one: a tab left in
 * the agent's group after the session let go of it tells the owner an agent is still driving a tab
 * no session may touch. Chrome discards the group when its last tab leaves, which is the end state
 * a released session's group should reach anyway.
 */
export async function ungroupTabs(tabIds: number[]): Promise<void> {
  await chrome.tabs.ungroup(tabIds as [number, ...number[]]);
}

/**
 * Writes an agent group's title, and its colour when one is given (016 R-207). The group presenter
 * is the one caller: it decides the title from the session's state and writes only a change.
 */
export async function presentAgentGroup(
  groupId: number,
  properties: { title: string; color?: AgentGroupColour },
): Promise<void> {
  await chrome.tabGroups.update(groupId, properties);
}

/**
 * What a group the agent has let go of reads as (003/M4 Part A).
 *
 * The group was created by this extension, so there is no earlier title or colour to put back; the
 * marking is simply withdrawn. It is not `AGENT_GROUP_TITLE` in another language and not an empty
 * string with the agent's colour left on, because both would leave the owner's tab strip saying an
 * agent is driving tabs no agent can reach any more.
 */
export const RELEASED_GROUP_TITLE = "";

export const RELEASED_GROUP_COLOR = "grey";

/**
 * Every group that carries the agent marking right now (004/T099l).
 *
 * The marking outlives this worker: Chrome restores a titled group with the session it belonged to,
 * and an extension reload leaves one behind too, so the worker has to be able to *find* the groups
 * it once marked rather than only the ones it remembers marking. The title is the only handle there
 * is - the group is Chrome's furniture and carries no id of ours - which is why the sweep that uses
 * this compares against the session records rather than trusting the title alone.
 */
export async function queryAgentGroupIds(): Promise<number[]> {
  // Every group, filtered here (016 FR-241): `query` matches one exact title, and a group of ours
  // may carry any of four.
  const groups = await chrome.tabGroups?.query({});
  return (groups ?? [])
    .filter((group) => group.title !== undefined && STALE_AGENT_GROUP_TITLES.has(group.title))
    .map((group) => group.id);
}

/**
 * Withdraws the agent marking when a session ends. The group and its tabs stay: they are the
 * owner's now, and closing them would destroy work the owner may still want.
 */
export async function clearAgentGroupMarking(groupId: number): Promise<void> {
  await chrome.tabGroups.update(groupId, { title: RELEASED_GROUP_TITLE, color: RELEASED_GROUP_COLOR });
}
