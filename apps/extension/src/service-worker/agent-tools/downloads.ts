import {
  agentToolArgSchemas,
  type AgentDownloadRecord,
  type AgentNativeRequest,
  type AgentNativeResponse,
  type AgentToolName,
} from "@hallpass/contracts";

/**
 * `downloads_context` (005/T181, US2, FR-079).
 *
 * A read of what the observer kept for this session and nothing else. It needs no lease for the
 * same reason `tabs_context` needs none: what is answered is the browser's own record of a download
 * - its saved path, source and state - and never a word of any page, and the record was attributed
 * to this session when it began, so there is no tab to check ownership of now. The ring is answered
 * as it is kept: newest first, bounded by the observer.
 */

export type AgentDownloadToolDeps = {
  /** The session's records, newest first (`DownloadObserver.list`). */
  list: (sessionId: string) => Promise<AgentDownloadRecord[]>;
};

export type AgentDownloadToolRunner = {
  handles(tool: AgentToolName): boolean;
  run(request: AgentNativeRequest): Promise<AgentNativeResponse>;
};

export function createAgentDownloadTools(deps: AgentDownloadToolDeps): AgentDownloadToolRunner {
  return {
    handles(tool) {
      return tool === "downloads_context";
    },
    async run(request) {
      const { callId } = request;
      const parsed = agentToolArgSchemas.downloads_context.safeParse(request.args);
      if (!parsed.success) {
        return { callId, outcome: "failed", reason: "invalid-arguments" };
      }
      const downloads = await deps.list(request.sessionId);
      return { callId, outcome: "ok", result: { downloads } };
    },
  };
}
