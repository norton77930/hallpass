import {
  AGENT_GROUP_TITLE,
  WAITING_GROUP_TITLE,
  WORKING_GROUP_TITLE,
} from "../../../apps/extension/src/chrome-adapters/tab-groups.js";
import type { PackagedWorker } from "./packaged-extension.js";

/**
 * The titles a live session's tab group carries (016 FR-238): "Hallpass", with the working or the
 * waiting prefix while that is the session's state. A journey reads the group a moment after a call,
 * when the working prefix may still be on it (FR-239), so any of the three is the agent's marking.
 * The legacy 0.8.0 "Agent" is not in this list: a 0.9.0 worker never writes it.
 */
export const LIVE_AGENT_GROUP_TITLES: readonly string[] = [AGENT_GROUP_TITLE, WORKING_GROUP_TITLE, WAITING_GROUP_TITLE];

/** Whether a group title says a live session is driving the group's tabs. */
export function isAgentGroupTitle(title: string | undefined): boolean {
  return title !== undefined && LIVE_AGENT_GROUP_TITLES.includes(title);
}

/** A group's title as the browser has it now, read through the extension's own worker. */
export async function groupTitle(worker: PackagedWorker, groupId: number): Promise<string | undefined> {
  return worker.evaluate(async (id: number) => (await chrome.tabGroups.get(id)).title, groupId);
}
