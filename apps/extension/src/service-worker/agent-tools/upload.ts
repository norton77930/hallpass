import {
  agentToolArgSchemas,
  type AgentNativeRequest,
  type AgentNativeResponse,
  type AgentToolName,
  type SiteMode,
} from "@hallpass/contracts";
import { setFilesOnTab } from "../content-broker.js";
import type { SiteModeStore } from "../site-mode-store.js";
import type { AgentSessionContexts } from "./context.js";
import { ownershipRefusal, type TabOwnershipLookup } from "./ownership.js";
import { decideGate, type StatedPlan } from "./gate.js";
import type { AgentPageBindings } from "./page-binding.js";
import type { AgentPromptController } from "./prompts.js";
import { discoverRefFrame } from "./refs.js";
import { summariseToolCall } from "./summaries.js";

/**
 * `file_upload` inside the worker (003/T063, US7, FR-051).
 *
 * This module receives bytes and never a path, which is the whole architecture of the feature in
 * one sentence: the *host* - the owner's own process - resolves the paths the agent named, checks
 * them against the roots the owner configured, refuses everything else before reading anything, and
 * puts the allowed files in the frame. By the time a call arrives here the file system is out of
 * the picture, so there is nothing in the extension that could be talked into opening a file.
 *
 * What is left is the same consent every page change passes. Putting a file into a form is a change
 * to the page - the next click may send it somewhere - so the site's mode decides it exactly as it
 * decides a click, and on a site the owner has not waved through they are asked first.
 *
 * The answer is what the input is holding afterwards, read from the page. Echoing the request would
 * report an upload for a page that rejected it, which is the claim FR-040 exists to forbid.
 */

export type AgentUploadDeps = {
  context: AgentSessionContexts;
  siteModes: SiteModeStore;
  bindings: AgentPageBindings;
  prompts: AgentPromptController;
  /** FR-034: the session's own tabs, and nothing else. */
  tabOwnership: TabOwnershipLookup;
  statedPlan?: (site: string) => StatedPlan | undefined;
  onAdmitted?: (site: string, step: number) => void;
  setFiles?: typeof setFilesOnTab;
  /** 004/T160: which frame owns `ref`, when it names one. Overridable the way `setFiles` is. */
  discoverFrame?: typeof discoverRefFrame;
  reportDiagnostic?: (code: string) => void;
};

export type AgentUploadRunner = {
  handles(tool: AgentToolName): boolean;
  run(request: AgentNativeRequest): Promise<AgentNativeResponse>;
};

function answer(callId: string, outcome: AgentNativeResponse["outcome"], reason: string): AgentNativeResponse {
  return { callId, outcome, reason };
}

export function createAgentUpload(deps: AgentUploadDeps): AgentUploadRunner {
  const setFiles = deps.setFiles ?? setFilesOnTab;
  const discoverFrame = deps.discoverFrame ?? discoverRefFrame;

  async function run(request: AgentNativeRequest): Promise<AgentNativeResponse> {
    const { callId } = request;
    const parsed = agentToolArgSchemas.file_upload.safeParse(request.args);
    if (!parsed.success) {
      // A frame carrying a path lands here, and that is deliberate: the shape the worker accepts has
      // no such field, so a host that tried to delegate the reading would be refused rather than
      // obeyed.
      return answer(callId, "failed", "invalid-arguments");
    }
    const args = parsed.data as {
      tabId: number;
      ref: string;
      files: Array<{ name: string; type: string; bytesBase64: string }>;
    };
    const tabId = args.tabId;
    const ownership = await deps.tabOwnership(request.sessionId, tabId);
    if (ownership.state !== "this") return ownershipRefusal(callId, ownership);

    const context = deps.context.forCall(request.sessionId, callId);
    const bound = await deps.bindings.bind(tabId, context);
    if (!bound.ok) {
      return answer(callId, bound.reason === "not-actionable" ? "not-actionable" : "stale", bound.reason);
    }
    const binding = bound.binding;

    const record = await deps.siteModes.get(binding.site);
    const decision = decideGate({
      sessionId: context.sessionId,
      tabId,
      site: binding.site,
      mode: record.mode,
      tool: "file_upload",
      args: args as unknown as Record<string, unknown>,
      ...(deps.statedPlan ? { plan: deps.statedPlan(binding.site) } : {}),
    });
    if (decision.decision === "refuse") return answer(callId, "failed", decision.reason);
    if (decision.decision === "admit" && decision.step !== undefined) {
      deps.onAdmitted?.(binding.site, decision.step);
    }
    if (decision.decision === "prompt") {
      const asked = await deps.prompts.ask({
        callId,
        sessionId: request.sessionId,
        site: binding.site,
        tool: "file_upload",
        argsSummary: summariseToolCall("file_upload", args as unknown as Record<string, unknown>),
      });
      if (asked.decision === "busy") return answer(callId, "busy", "prompt-pending");
      if (asked.decision === "timed-out") return answer(callId, "timed-out", "no-answer");
      if (asked.decision === "stopped") return answer(callId, "stopped", "owner-stopped");
      if (asked.decision === "deny") return answer(callId, "denied", "owner-denied");
      // 006 FR-087: the tab may have been handed back while the question stood (see effects.ts).
      const held = await deps.tabOwnership(request.sessionId, tabId);
      if (held.state !== "this") return ownershipRefusal(callId, held);
      if (asked.decision === "released") return ownershipRefusal(callId, { state: "not-yours" });
      if (asked.rememberMode) {
        await deps.siteModes.set(binding.site, { mode: asked.rememberMode as SiteMode });
      }
    }

    // 004/T160: this ref carries no frame identity of its own - asked for only once the effect is
    // admitted, since it is a read of the page and the gate above is what the owner consented to.
    const frame = await discoverFrame(context, binding, args.ref);

    let result: Awaited<ReturnType<typeof setFilesOnTab>>;
    try {
      result = await setFiles({
        taskId: context.taskId,
        operationId: context.operationId,
        runtimeEpochId: context.runtimeEpochId,
        nonce: context.nonce,
        expectedTabId: binding.tabId,
        canonicalOrigin: binding.canonicalOrigin,
        documentEpoch: frame ? frame.documentEpoch : binding.documentEpoch,
        targetHandle: args.ref,
        files: args.files,
        tab: binding.tabId,
        ...(frame ? { frameId: frame.frameId, frameOrigin: frame.canonicalOrigin } : {}),
      });
    } catch (error) {
      deps.reportDiagnostic?.("agent.upload.uncertain");
      return answer(callId, "failed", error instanceof Error ? error.message : "upload-failed");
    }
    if (!result.ok) {
      if (result.reason === "stale-target" || result.reason === "stale-context") {
        return answer(callId, "stale", result.reason);
      }
      // The ref names something that is not a file input, or an input that has said it will not
      // take these files (C4): too many for a single-file control, or a kind its `accept` excludes.
      // Each is a fact about the page rather than a fault, and each gets the word an effect on an
      // impossible target gets.
      if (
        result.reason === "not-a-file-input" ||
        result.reason === "unsupported" ||
        result.reason === "too-many-files" ||
        result.reason === "accept-mismatch"
      ) {
        return answer(callId, "not-actionable", result.reason);
      }
      return answer(callId, "failed", result.reason);
    }
    return { callId, outcome: "ok", result: { files: result.files } };
  }

  return {
    handles(tool) {
      return tool === "file_upload";
    },
    run,
  };
}
