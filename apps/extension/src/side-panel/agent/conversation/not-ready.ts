import type { ConversationAgentAvailability } from "@hallpass/contracts";

type T = (key: string) => string;

/** Install phases that mean a download is under way (R-375): the broker's file, or the live overview. */
const DOWNLOADING = new Set(["preparing", "downloading", "finishing"]);

/**
 * 024 FR-384, D-024-3: the one line that says why an enabled agent cannot start a conversation - or
 * nothing when it can. The agent's state comes from the worker's local check (D-024-19); getting it
 * ready - downloading, installing, a version that fits - happens on the settings page, never here, so
 * every line is followed by a link to that agent's card and none offers a download.
 *
 * An agent the worker has not reported yet gets the general line.
 */
export function notReadyReason(
  entry: ConversationAgentAvailability | undefined,
  agentName: string,
  t: T,
): string | undefined {
  const say = (sentence: string): string => sentence.replace(/\{agent\}/g, () => agentName);
  if (entry === undefined) return say(t("conversation.agentMenu.notReady"));
  switch (entry.availability) {
    case "ready":
      return undefined;
    case "needs-install":
      return entry.installing !== undefined || DOWNLOADING.has(entry.install?.phase ?? "")
        ? say(t("conversation.agentMenu.notReady.downloading"))
        : say(t("conversation.agentMenu.notReady.download"));
    case "missing":
      return say(t("conversation.agentMenu.notReady.missing"));
    case "version-problem":
      return say(t("conversation.agentMenu.notReady.version"));
  }
}
