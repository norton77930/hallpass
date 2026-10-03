import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  agentBrowserChoiceRecordSchema,
  agentBrowserIdSchema,
  type AgentBrowserChoiceRecord,
} from "@hallpass/contracts";
import { writeHostFileAtomically } from "./bridge-link.js";
import { browserChoicesDirectory, isWindowsDeviceName, type HostEnvironment } from "./host-paths.js";

/**
 * The browser each agent chose last, `choices/<agentId>.json` (018 R-271, R-279, D-018-5, D-018-11).
 *
 * A file rather than anything a browser holds, because no single browser spans the choice. One file
 * per agent so that a later key cannot lose another agent's update; several servers of one agent may
 * write it and the last writer wins, which is exactly "the browser chosen last". Nobody dials it and
 * it claims no liveness - a remembered browser that is offline is still the choice (D-018-13), and
 * whether it is connected is the directory's question, not this file's.
 */

/**
 * The agent id becomes a file name. It is the host's own minted hex id, but the `agent-id` file is
 * the user's to edit, so it is checked here rather than trusted: a separator, a drive colon or a dot
 * could name a file outside `choices/`.
 */
const AGENT_ID_FILE_NAME = /^[A-Za-z0-9_-]{1,128}$/u;

export function browserChoicePath(agentId: string, env?: HostEnvironment): string {
  if (!AGENT_ID_FILE_NAME.test(agentId) || isWindowsDeviceName(agentId)) {
    throw new Error("agent id is not a file name");
  }
  return join(browserChoicesDirectory(env), `${agentId}.json`);
}

/** The remembered choice, or `undefined` for none - including a file that is not one, or an unusable agent id. */
export async function readBrowserChoice(
  agentId: string,
  env?: HostEnvironment,
): Promise<AgentBrowserChoiceRecord | undefined> {
  let path: string;
  try {
    path = browserChoicePath(agentId, env);
  } catch {
    return undefined;
  }
  try {
    const parsed = agentBrowserChoiceRecordSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Temp-then-rename, as every host file is written (004/T099f). */
export async function writeBrowserChoice(
  agentId: string,
  browserId: string,
  chosenAt: Date,
  env?: HostEnvironment,
): Promise<AgentBrowserChoiceRecord> {
  const path = browserChoicePath(agentId, env);
  if (!agentBrowserIdSchema.safeParse(browserId).success) {
    throw new Error("browser id is not a browser id");
  }
  const choice = agentBrowserChoiceRecordSchema.parse({ browserId, chosenAt: chosenAt.toISOString() });
  await writeHostFileAtomically(path, choice);
  return choice;
}
