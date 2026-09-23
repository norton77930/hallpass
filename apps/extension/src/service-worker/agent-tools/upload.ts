import {
  agentToolArgSchemas,
  type AgentNativeResponse,
  type AgentToolName,
  type SiteMode,
} from "@hallpass/contracts";
import { deliverImageOnTab, setFilesOnTab } from "../content-broker.js";
import type { SiteModeStore } from "../site-mode-store.js";
import type { AgentSessionContexts, AgentToolContext } from "./context.js";
import { ownershipRefusal, type TabOwnershipLookup } from "./ownership.js";
import { decideGate, type StatedPlan } from "./gate.js";
import type { AgentPageBinding, AgentPageBindings } from "./page-binding.js";
import { noAnswerResponse, type AgentPromptController } from "./prompts.js";
import { discoverRefFrame } from "./refs.js";
import type { AgentToolRequest } from "./stop.js";
import { summariseToolCall } from "./summaries.js";

/**
 * `file_upload` (003/T063, US7, FR-051) and `upload_image` (013, FR-169..174) inside the worker.
 *
 * This module receives bytes and never a path or an id, which is the whole architecture of both
 * features in one sentence: the *host* - the owner's own process - resolves what the agent named
 * (a path against the roots the owner configured; a screenshot id against the pictures this
 * session took), refuses everything else before anything crosses to the browser, and puts the
 * allowed bytes in the frame. By the time a call arrives here the file system and the screenshot
 * cache are out of the picture, so there is nothing in the extension that could be talked into
 * opening a file or looking up another session's picture.
 *
 * What is left is the same consent every page change passes. Putting a file into a form - or
 * dropping a picture on a page - is a change to the page; the next click may send it somewhere. So
 * the site's mode decides it exactly as it decides a click, and on a site the owner has not waved
 * through they are asked first.
 *
 * The answer is what the page holds afterwards, read from the page where it can be read (an
 * input). Echoing the request would report an upload for a page that rejected it, which is the
 * claim FR-040 exists to forbid. A drop has nothing to read back - the page decides in its own
 * handler what to do with the file - so its answer says what was delivered and where, not that it
 * was accepted; the agent reads the page for that, as for every effect.
 */

type UploadTool = "file_upload" | "upload_image";

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
  /** 013: the picture's delivery, overridable the way `setFiles` is. */
  deliverImage?: typeof deliverImageOnTab;
  /** 004/T160: which frame owns `ref`, when it names one. Overridable the way `setFiles` is. */
  discoverFrame?: typeof discoverRefFrame;
  reportDiagnostic?: (code: string) => void;
};

export type AgentUploadRunner = {
  handles(tool: AgentToolName): boolean;
  run(request: AgentToolRequest): Promise<AgentNativeResponse>;
};

function answer(callId: string, outcome: AgentNativeResponse["outcome"], reason: string): AgentNativeResponse {
  return { callId, outcome, reason };
}

type Admitted = { ok: true; context: AgentToolContext; binding: AgentPageBinding };
type NotAdmitted = { ok: false; response: AgentNativeResponse };

/**
 * How a picture would reach the page, as a fact the card can look a sentence up from (014 FR-196).
 *
 * Read off the arguments rather than off an answer, because the question is asked before anything
 * is delivered: a `ref` names a file field the owner can see, a `coordinate` names a place on the
 * page - two acts an owner would decide differently, behind one tool name. `file_upload` has only
 * the first, and its own sentence already says so, so it carries nothing.
 */
function deliveryOf(tool: UploadTool, args: Record<string, unknown>): "input" | "drop" | undefined {
  if (tool !== "upload_image") return undefined;
  const target = args["target"] as { ref?: unknown; coordinate?: unknown } | undefined;
  if (target?.ref !== undefined) return "input";
  return target?.coordinate === undefined ? undefined : "drop";
}

export function createAgentUpload(deps: AgentUploadDeps): AgentUploadRunner {
  const setFiles = deps.setFiles ?? setFilesOnTab;
  const deliverImage = deps.deliverImage ?? deliverImageOnTab;
  const discoverFrame = deps.discoverFrame ?? discoverRefFrame;

  /**
   * The part both tools share, in the order every effect runs it: the tab must be this session's
   * (FR-034), the page must be bound and actionable, and the site's mode must admit the call - or
   * the owner must, through the card whose one line is `argsSummary`.
   */
  async function admit(
    request: AgentToolRequest,
    tool: UploadTool,
    tabId: number,
    args: Record<string, unknown>,
  ): Promise<Admitted | NotAdmitted> {
    const { callId } = request;
    const ownership = await deps.tabOwnership(request.sessionId, tabId);
    if (ownership.state !== "this") return { ok: false, response: ownershipRefusal(callId, ownership) };

    const context = deps.context.forCall(request.sessionId, callId);
    const bound = await deps.bindings.bind(tabId, context);
    if (!bound.ok) {
      return {
        ok: false,
        response: answer(callId, bound.reason === "not-actionable" ? "not-actionable" : "stale", bound.reason),
      };
    }
    const binding = bound.binding;

    const record = await deps.siteModes.get(binding.site);
    const decision = decideGate({
      sessionId: context.sessionId,
      tabId,
      site: binding.site,
      mode: record.mode,
      tool,
      args,
      ...(deps.statedPlan ? { plan: deps.statedPlan(binding.site) } : {}),
    });
    if (decision.decision === "refuse") return { ok: false, response: answer(callId, "failed", decision.reason) };
    if (decision.decision === "admit" && decision.step !== undefined) {
      deps.onAdmitted?.(binding.site, decision.step);
    }
    if (decision.decision === "prompt") {
      const delivery = deliveryOf(tool, args);
      const asked = await deps.prompts.ask({
        callId,
        // Which call the host knows it as, when this upload is a batch step (011 review H1).
        hostCallId: request.hostCallId,
        // And whether the owner ended the call while the runner was still getting here (FR-179).
        stopped: request.stopped,
        sessionId: request.sessionId,
        site: binding.site,
        tool,
        argsSummary: summariseToolCall(tool, args),
        ...(delivery === undefined ? {} : { delivery }),
      });
      if (asked.decision === "busy") return { ok: false, response: answer(callId, "busy", "prompt-pending") };
      if (asked.decision === "timed-out") return { ok: false, response: noAnswerResponse(callId, asked) };
      if (asked.decision === "stopped") return { ok: false, response: answer(callId, "stopped", "owner-stopped") };
      // 014 FR-179: the step ended, the session did not, and nothing was decided about the site.
      if (asked.decision === "interrupted")
        return { ok: false, response: answer(callId, "stopped", "owner-interrupted") };
      if (asked.decision === "deny") return { ok: false, response: answer(callId, "denied", "owner-denied") };
      // 006 FR-087: the tab may have been handed back while the question stood (see effects.ts).
      const held = await deps.tabOwnership(request.sessionId, tabId);
      if (held.state !== "this") return { ok: false, response: ownershipRefusal(callId, held) };
      if (asked.decision === "released") {
        return { ok: false, response: ownershipRefusal(callId, { state: "not-yours" }) };
      }
      if (asked.rememberMode) {
        await deps.siteModes.set(binding.site, { mode: asked.rememberMode as SiteMode });
      }
    }
    return { ok: true, context, binding };
  }

  async function runFileUpload(request: AgentToolRequest): Promise<AgentNativeResponse> {
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
    const admitted = await admit(request, "file_upload", args.tabId, args as unknown as Record<string, unknown>);
    if (!admitted.ok) return admitted.response;
    const { context, binding } = admitted;

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

  async function runUploadImage(request: AgentToolRequest): Promise<AgentNativeResponse> {
    const { callId } = request;
    const parsed = agentToolArgSchemas.upload_image.safeParse(request.args);
    if (!parsed.success) {
      // A frame still carrying an `imageId` lands here: the worker's shape has no such field, so a
      // host that skipped the lookup is refused rather than trusted (FR-172, FR-175).
      return answer(callId, "failed", "invalid-arguments");
    }
    const args = parsed.data as {
      tabId: number;
      target: { ref: string } | { coordinate: { x: number; y: number } };
      file: { name: string; type: string; bytesBase64: string };
    };
    const admitted = await admit(request, "upload_image", args.tabId, args as unknown as Record<string, unknown>);
    if (!admitted.ok) return admitted.response;
    const { context, binding } = admitted;

    // A ref goes to the frame that minted it (004/T160, as `file_upload`); a point goes to the top
    // frame, which does its own one-level descent into a frame it can read (FR-171).
    const frame = "ref" in args.target ? await discoverFrame(context, binding, args.target.ref) : undefined;
    const target = "ref" in args.target ? { handle: args.target.ref } : { point: args.target.coordinate };

    let result: Awaited<ReturnType<typeof deliverImageOnTab>>;
    try {
      result = await deliverImage({
        taskId: context.taskId,
        operationId: context.operationId,
        runtimeEpochId: context.runtimeEpochId,
        nonce: context.nonce,
        expectedTabId: binding.tabId,
        canonicalOrigin: binding.canonicalOrigin,
        documentEpoch: frame ? frame.documentEpoch : binding.documentEpoch,
        target,
        file: args.file,
        tab: binding.tabId,
        ...(frame ? { frameId: frame.frameId, frameOrigin: frame.canonicalOrigin } : {}),
      });
    } catch (error) {
      deps.reportDiagnostic?.("agent.upload-image.uncertain");
      return answer(callId, "failed", error instanceof Error ? error.message : "upload-failed");
    }
    if (!result.ok) {
      if (result.reason === "stale-target" || result.reason === "stale-context") {
        return answer(callId, "stale", result.reason);
      }
      // Facts about the page rather than faults: nothing under the point, a point off the
      // viewport (the reason carries its size), or a frame the top document cannot reach into.
      if (
        result.reason === "not-a-drop-target" ||
        result.reason.startsWith("point-outside-viewport") ||
        result.reason === "not-reachable"
      ) {
        return answer(callId, "not-actionable", result.reason);
      }
      return answer(callId, "failed", result.reason);
    }
    return {
      callId,
      outcome: "ok",
      result: {
        delivery: result.delivery,
        file: result.file,
        ...(result.point ? { point: result.point } : {}),
      },
    };
  }

  return {
    handles(tool) {
      return tool === "file_upload" || tool === "upload_image";
    },
    run(request) {
      return request.tool === "upload_image" ? runUploadImage(request) : runFileUpload(request);
    },
  };
}
