/**
 * The `chrome.tabGroups` surface the agent path uses (003/R-104).
 *
 * A session's tabs live in one group so the boundary is *visible*: the owner sees a titled,
 * coloured strip in their own tab strip and can tell at a glance which tabs an agent is driving.
 * That is why the marking is the group rather than, say, a favicon badge - the group is native
 * browser furniture the owner already understands, and it cannot be forged by a page.
 */

/** What the owner reads on the group. Deliberately one plain word, in no locale's voice. */
export const AGENT_GROUP_TITLE = "Agent";

/** One colour, so an agent group is recognisable at a glance and never blends into the owner's. */
export const AGENT_GROUP_COLOR = "blue";

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
 * the "Agent" group after the session let go of it tells the owner an agent is still driving a tab
 * no session may touch. Chrome discards the group when its last tab leaves, which is the end state
 * a released session's group should reach anyway.
 */
export async function ungroupTabs(tabIds: number[]): Promise<void> {
  await chrome.tabs.ungroup(tabIds as [number, ...number[]]);
}

/** Titles and colours a group so it reads as the agent's. */
export async function markAgentGroup(groupId: number): Promise<void> {
  await chrome.tabGroups.update(groupId, { title: AGENT_GROUP_TITLE, color: AGENT_GROUP_COLOR });
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
  const groups = await chrome.tabGroups?.query({ title: AGENT_GROUP_TITLE });
  return (groups ?? []).map((group) => group.id);
}

/**
 * Withdraws the agent marking when a session ends. The group and its tabs stay: they are the
 * owner's now, and closing them would destroy work the owner may still want.
 */
export async function clearAgentGroupMarking(groupId: number): Promise<void> {
  await chrome.tabGroups.update(groupId, { title: RELEASED_GROUP_TITLE, color: RELEASED_GROUP_COLOR });
}
