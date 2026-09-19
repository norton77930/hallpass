import { agentToolArgSchemas, type AgentNativeRequest, type AgentNativeResponse, type AgentToolName } from "@hallpass/contracts";
import type { AgentRecorder } from "../recording/recorder.js";

/**
 * The `gif_recorder` tool (008/T221, FR-100, FR-107, FR-108).
 *
 * Four actions over one recorder, and the only interesting one is `start`: a recording begins with
 * a frame of the page as it was before anything happened, so it needs a tab. The session's *main*
 * tab is that tab - the one its effects have been landing on (`agent-tab-manager.ts`) - because the
 * tool names none itself: a recording is of a session's work, not of one tab, and every later frame
 * is taken on whichever tab the recorded action was about.
 *
 * `stop`, `clear` and `export` need no tab at all: the frames are already in the offscreen document
 * and the file is written by the browser.
 */

const RECORDING_TOOL: AgentToolName = "gif_recorder";

export type AgentRecordingToolDeps = {
  recorder: AgentRecorder;
  /** The session's main tab, for `start`'s initial frame. */
  mainTabId(sessionId: string): Promise<number | undefined>;
};

export type AgentRecordingTools = {
  handles(tool: AgentToolName): boolean;
  run(request: AgentNativeRequest): Promise<AgentNativeResponse>;
};

export function createAgentRecordingTools(deps: AgentRecordingToolDeps): AgentRecordingTools {
  return {
    handles(tool) {
      return tool === RECORDING_TOOL;
    },
    async run(request) {
      const { callId } = request;
      const parsed = agentToolArgSchemas[RECORDING_TOOL].safeParse(request.args);
      if (!parsed.success) {
        return { callId, outcome: "failed", reason: "invalid-arguments" };
      }
      const args = parsed.data as { action: "start" | "stop" | "export" | "clear"; filename?: string };
      switch (args.action) {
        case "start": {
          const tabId = await deps.mainTabId(request.sessionId);
          if (tabId === undefined) {
            // Nothing to photograph: a session holding no tab has no page to begin a recording of.
            return { callId, outcome: "failed", reason: "no-tab" };
          }
          return { callId, outcome: "ok", result: await deps.recorder.start(request.sessionId, tabId) };
        }
        case "stop":
          return { callId, outcome: "ok", result: await deps.recorder.stop(request.sessionId) };
        case "clear":
          return { callId, outcome: "ok", result: await deps.recorder.clear(request.sessionId) };
        case "export": {
          const exported = await deps.recorder.export(
            request.sessionId,
            ...(args.filename === undefined ? [] : [args.filename]),
          );
          return exported.ok
            ? { callId, outcome: "ok", result: exported.result }
            : { callId, outcome: "failed", reason: exported.refusal.reason, refusal: exported.refusal };
        }
      }
    },
  };
}
