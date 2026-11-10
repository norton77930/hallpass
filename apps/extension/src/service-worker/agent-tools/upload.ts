import {
  agentToolArgSchemas,
  type AgentNativeResponse,
  type AgentToolName,
  type SiteMode,
} from "@hallpass/contracts";
import { deliverImageOnTab, setFilesOnTab } from "../content-broker.js";
import type { SiteModeStore } from "../site-mode-store.js";
import type { AgentSessionContexts, AgentToolContext } from "./context.js";
import {
  toPicturePoint,
  toViewportPoint,
  viewportChangedReason,
  type ScreenshotSpace,
  type ScreenshotSpaces,
} from "./coordinate-space.js";
import { captureFrameFacts } from "./photograph.js";
import type { CaptureFrame } from "../../chrome-adapters/capture.js";
import type { probeFrameSender } from "../../chrome-adapters/frame-sender.js";
import type { readMainWorldMarks } from "../../chrome-adapters/main-world-marks.js";
import { ownershipRefusal, type TabOwnershipLookup } from "./ownership.js";
import {
  createFrameSiteOf,
  createPointSiteOf,
  frameMovedAnswer,
  gateSiteOf,
  promptFrameOf,
  rememberWithoutSiteRefusal,
  withFrameAnswer,
} from "./frame-consent.js";
import { sameDecidingSite, type DecidingSite, type ViewportPoint } from "./frame-site.js";
import type { AgentInputAttachments, AttachmentCallHold } from "./input.js";
import { decideGate, type StatedPlan } from "./gate.js";
import { bindingFailureResponse, type AgentPageBinding, type AgentPageBindings } from "./page-binding.js";
import { noAnswerResponse, type AgentPromptController } from "./prompts.js";
import { discoverRefFrame, type RefFrame } from "./refs.js";
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
  /** The browser's sender for one message from a claimed frame (030 R-440, T891); the adapter by default. */
  probeFrameSender?: typeof probeFrameSender;
  /**
   * The shared debugger attachment a drop point's frame is found over (030 FR-455, R-442), the one
   * the effects use. Absent, the site under a drop point cannot be established and every drop asks
   * as an unknown site (FR-464) - never the page's mode by default.
   */
  attachments?: Pick<AgentInputAttachments, "hold" | "send" | "oopifSessions">;
  /** Every frame's main-world value of the coordinate walk's nonce (030 R-442); the adapter by default. */
  readFrameMarks?: typeof readMainWorldMarks;
  /**
   * Each tab's latest whole-viewport picture space (012 change log 2026-10-17, R-280): a drop
   * `coordinate` is read off that picture, so it is mapped back into the frame's pixels.
   */
  screenshotSpaces?: ScreenshotSpaces;
  /**
   * The emulated size a session gave the tab, as the pictures read it (012/T311): with the tab's
   * own size over its zoom, the frame a drop point is checked against (R-282).
   */
  currentViewport?: (tabId: number) => Promise<CaptureFrame | undefined>;
  reportDiagnostic?: (code: string) => void;
};

export type AgentUploadRunner = {
  handles(tool: AgentToolName): boolean;
  run(request: AgentToolRequest): Promise<AgentNativeResponse>;
};

function answer(callId: string, outcome: AgentNativeResponse["outcome"], reason: string): AgentNativeResponse {
  return { callId, outcome, reason };
}

/**
 * What the pre-gate claim found for the named ref (030 R-443, O-030-1): the frame that holds it, and
 * the site that decides the upload when that frame is a child frame.
 *
 * `frame` undefined is the top document (a page of one document, or no frame claimed the ref), and
 * `frameId: 0` is the top document claiming it; neither has `deciding`, so the page's site decides
 * exactly as before this feature (FR-465). The delivery is addressed to this frame, never re-found.
 *
 * A drop at a point (030 FR-455) claims no frame - the top frame takes the drop and descends itself
 * (FR-171) - and carries `point`: where the walk was asked and what it found, for the re-check right
 * before the drop. A point in the top document has no `deciding`, as a top-document ref has none.
 */
type UploadClaim = {
  frame: RefFrame | undefined;
  deciding?: DecidingSite;
  point?: { at: ViewportPoint; decided: DecidingSite };
};

type Admitted = { ok: true; context: AgentToolContext; binding: AgentPageBinding; claim: UploadClaim };
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
  const attachments = deps.attachments;
  /** The site under a drop point, resolved exactly as the effects resolve a coordinate gesture's. */
  const pointSiteOf =
    attachments === undefined
      ? async (binding: AgentPageBinding): Promise<DecidingSite> => ({ kind: "unknown", pageSite: binding.site })
      : createPointSiteOf({
          attachments,
          ...(deps.readFrameMarks ? { readFrameMarks: deps.readFrameMarks } : {}),
          ...(deps.probeFrameSender ? { probeFrameSender: deps.probeFrameSender } : {}),
        });
  /** A claimed child frame's site, from the browser's sender for one message it sends (030 R-440). */
  const frameSiteOf = createFrameSiteOf(deps.probeFrameSender);

  /**
   * Which frame holds the ref, found before the gate (030 R-443, O-030-1), and the site that decides.
   *
   * The scroll-free "is this ref yours" question (`discoverRefFrame`), asked before the owner is: it
   * is a read of the page, and nothing on the page moves. A discovery that fails leaves the ref to
   * the top document, which is where the delivery then goes - so a frame that stayed quiet here is
   * never written into. The top document costs no probe.
   */
  async function claimBeforeGate(context: AgentToolContext, binding: AgentPageBinding, ref: string): Promise<UploadClaim> {
    let frame: RefFrame | undefined;
    try {
      frame = await discoverFrame(context, binding, ref);
    } catch {
      frame = undefined;
    }
    if (frame === undefined || frame.frameId === 0) return { frame };
    return { frame, deciding: await frameSiteOf(binding, frame.frameId) };
  }

  /**
   * Whether the frame the gate decided for is still the one the delivery would reach (030 FR-460).
   *
   * Asked after the gate and right before the bytes go out, only for a ref a child frame claimed
   * (the top document's delivery is addressed to frame 0 and cannot land anywhere else). The claim
   * is asked again and must land in the same frame and the same document; the browser's sender is
   * read again and must name the same site in the same document. Any doubt is a move: nothing is
   * written into a frame the owner did not decide about.
   */
  async function movedSinceGate(
    context: AgentToolContext,
    binding: AgentPageBinding,
    ref: string,
    claim: UploadClaim,
  ): Promise<boolean> {
    const decided = claim.frame;
    if (decided === undefined || decided.frameId === 0) return false;
    let again: RefFrame | undefined;
    try {
      again = await discoverFrame(context, binding, ref);
    } catch {
      again = undefined;
    }
    if (again === undefined || again.frameId !== decided.frameId || again.documentEpoch !== decided.documentEpoch) {
      return true;
    }
    const deciding = claim.deciding;
    // An unknown site had no document the browser vouched for, so there is nothing to compare
    // beyond the claim above; the owner was asked about exactly that.
    if (deciding === undefined || deciding.kind === "unknown") return false;
    return !sameDecidingSite(deciding, await frameSiteOf(binding, decided.frameId));
  }

  /**
   * Which frame is under a drop point, found before the gate (030 FR-455, R-442), and the site that
   * decides the drop - the same walk a coordinate click takes (`effects.ts`).
   *
   * The walk rides the input attachment, so it is acquired here, before the owner is asked; it
   * reads the page and moves nothing. An attachment that cannot be had leaves the walk unanswered,
   * which is an unknown site: the drop is still possible, with the owner's yes and no Allow always.
   *
   * 031/T945 (R-466): it is held, not just acquired - the walk again right before the drop rides the
   * same attachment after the owner's answer, which can take longer than the idle release - and the
   * call lets go of it when it answers (`run`).
   */
  async function claimPointBeforeGate(
    binding: AgentPageBinding,
    at: ViewportPoint,
    holds: AttachmentCallHold[],
  ): Promise<UploadClaim> {
    const held = await attachments?.hold(binding.tabId).catch(() => undefined);
    if (held !== undefined) holds.push(held);
    const decided = await pointSiteOf(binding, at);
    // A point in the top document is the page's, exactly as a ref there is (FR-465).
    const top = decided.kind === "page" && decided.frameId === undefined;
    return { frame: undefined, ...(top ? {} : { deciding: decided }), point: { at, decided } };
  }

  /**
   * Whether the site under the drop point is still the one the gate decided for (030 FR-460, R-446):
   * the point is walked again right before the drop and must find the same site, frame and document.
   */
  async function pointMovedSinceGate(binding: AgentPageBinding, claim: UploadClaim): Promise<boolean> {
    const point = claim.point;
    if (point === undefined) return false;
    return !sameDecidingSite(point.decided, await pointSiteOf(binding, point.at));
  }

  /**
   * The part both tools share, in the order every effect runs it: the tab must be this session's
   * (FR-034), the page must be bound and actionable, and the deciding site's mode must admit the
   * call - or the owner must, through the card whose one line is `argsSummary`.
   *
   * The deciding site is the page's, unless the target - a `ref`, or a drop point - is in a child
   * frame from another site (030 FR-454, FR-455): then that frame's site, its mode and its plan
   * decide, and a frame whose site could not be established always asks (`site: null`, FR-464).
   */
  async function admit(
    request: AgentToolRequest,
    tool: UploadTool,
    tabId: number,
    args: Record<string, unknown>,
    /** Asked once the tab is bound and before the gate: a reason here refuses with nothing asked. */
    beforeGate?: (binding: AgentPageBinding) => Promise<string | undefined>,
    /**
     * What the upload names, when it names something: an element, whose frame is claimed before
     * the gate, or a drop point (read once `beforeGate` has set the picture's space), whose frame
     * is walked to before the gate.
     */
    target?: { ref: string } | { point: () => ViewportPoint },
    /** The call's attachment holds (031/T945), ended when the call answers. */
    holds: AttachmentCallHold[] = [],
  ): Promise<Admitted | NotAdmitted> {
    const { callId } = request;
    const ownership = await deps.tabOwnership(request.sessionId, tabId);
    if (ownership.state !== "this") return { ok: false, response: ownershipRefusal(callId, ownership) };

    const context = deps.context.forCall(request.sessionId, callId);
    const bound = await deps.bindings.bind(tabId, context);
    if (!bound.ok) {
      return { ok: false, response: bindingFailureResponse(callId, bound, "not-actionable") };
    }
    const binding = bound.binding;
    const refused = beforeGate ? await beforeGate(binding) : undefined;
    if (refused !== undefined) return { ok: false, response: answer(callId, "failed", refused) };

    const claim: UploadClaim =
      target === undefined
        ? { frame: undefined }
        : "ref" in target
          ? await claimBeforeGate(context, binding, target.ref)
          : await claimPointBeforeGate(binding, target.point(), holds);
    const gateSite = gateSiteOf(claim.deciding, binding.site);
    // The card names the frame only when the frame, not the page, is what is being decided (R-445).
    const promptFrame = promptFrameOf(claim.deciding);
    const record = gateSite === null ? undefined : await deps.siteModes.get(gateSite);
    const decision = decideGate({
      sessionId: context.sessionId,
      tabId,
      site: gateSite,
      mode: record?.mode ?? "ask",
      tool,
      args,
      ...(deps.statedPlan && gateSite !== null ? { plan: deps.statedPlan(gateSite) } : {}),
    });
    if (decision.decision === "refuse") return { ok: false, response: answer(callId, "failed", decision.reason) };
    if (decision.decision === "admit" && decision.step !== undefined && gateSite !== null) {
      deps.onAdmitted?.(gateSite, decision.step);
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
        ...(promptFrame === undefined ? {} : { frame: promptFrame }),
        tool,
        argsSummary: summariseToolCall(tool, args),
        ...(delivery === undefined ? {} : { delivery }),
      });
      if (asked.decision === "busy") return { ok: false, response: answer(callId, "busy", "prompt-pending") };
      if (asked.decision === "timed-out") {
        // 030 FR-461: a frame's card also names the frame's site and why nothing was sent.
        const noAnswer = noAnswerResponse(callId, asked);
        return { ok: false, response: promptFrame === undefined ? noAnswer : withFrameAnswer(noAnswer, claim, "undecided") };
      }
      if (asked.decision === "stopped") return { ok: false, response: answer(callId, "stopped", "owner-stopped") };
      // 014 FR-179: the step ended, the session did not, and nothing was decided about the site.
      if (asked.decision === "interrupted")
        return { ok: false, response: answer(callId, "stopped", "owner-interrupted") };
      if (asked.decision === "deny") {
        const denied = answer(callId, "denied", "owner-denied");
        return { ok: false, response: promptFrame === undefined ? denied : withFrameAnswer(denied, claim, "refused") };
      }
      // 006 FR-087: the tab may have been handed back while the question stood (see effects.ts).
      const held = await deps.tabOwnership(request.sessionId, tabId);
      if (held.state !== "this") return { ok: false, response: ownershipRefusal(callId, held) };
      if (asked.decision === "released") {
        return { ok: false, response: ownershipRefusal(callId, { state: "not-yours" }) };
      }
      // 030 FR-458: a card for a frame whose site is unknown offers no Allow always, so a reply that
      // asks to remember a mode answers a question nobody was shown - refused as the effects refuse it.
      const unanswerable = rememberWithoutSiteRefusal(callId, asked.rememberMode, gateSite, claim);
      if (unanswerable !== undefined) return { ok: false, response: unanswerable };
      if (asked.rememberMode && gateSite !== null) {
        // The site the card decided: a frame's card stores the frame's site, never the page's
        // (030 FR-457).
        await deps.siteModes.set(gateSite, { mode: asked.rememberMode as SiteMode, session: request.sessionId });
      }
    }
    return { ok: true, context, binding, claim };
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
    // 004/T160: this ref carries no frame identity of its own, so its frame is found - since 030
    // (O-030-1) before the gate, because that frame's site is what decides the upload.
    const admitted = await admit(
      request,
      "file_upload",
      args.tabId,
      args as unknown as Record<string, unknown>,
      undefined,
      { ref: args.ref },
    );
    if (!admitted.ok) return admitted.response;
    const { context, binding, claim } = admitted;
    if (await movedSinceGate(context, binding, args.ref, claim)) return frameMovedAnswer(callId, claim);
    const frame = claim.frame;

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

  async function runUploadImage(request: AgentToolRequest, holds: AttachmentCallHold[]): Promise<AgentNativeResponse> {
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
    // A drop point is in the latest picture's pixels (R-280), and that picture must still be of a
    // page this wide (R-282) - checked before the owner is asked about a point that has moved.
    let space: ScreenshotSpace | undefined;
    const readSpace = async (bound: AgentPageBinding): Promise<string | undefined> => {
      if ("ref" in args.target) return undefined;
      space = await deps.screenshotSpaces?.get(bound.tabId).catch(() => undefined);
      if (!space) return undefined;
      const facts = await captureFrameFacts(
        bound.tabId,
        deps.currentViewport ? { currentViewport: deps.currentViewport } : {},
      );
      return viewportChangedReason(space, facts.frame?.width);
    };
    const named = args.target;
    const admitted = await admit(
      request,
      "upload_image",
      args.tabId,
      args as unknown as Record<string, unknown>,
      readSpace,
      // The drop point in the frame's pixels, once `readSpace` has read the picture's space: the
      // point the walk is asked about is the point delivered.
      "ref" in named ? { ref: named.ref } : { point: () => toViewportPoint(named.coordinate, space) },
      holds,
    );
    if (!admitted.ok) return admitted.response;
    const { context, binding, claim } = admitted;

    // A ref goes to the frame that minted it (004/T160, as `file_upload`), found before the gate and
    // decided by its site (030 O-030-1); a point goes to the top frame, which does its own one-level
    // descent into a frame it can read (FR-171), decided by the site under it (030 FR-455). Either is
    // asked about again right before the delivery (FR-460).
    const moved =
      "ref" in named
        ? await movedSinceGate(context, binding, named.ref, claim)
        : await pointMovedSinceGate(binding, claim);
    if (moved) return frameMovedAnswer(callId, claim);
    const frame = claim.frame;
    const target =
      "ref" in named ? { handle: named.ref } : { point: claim.point?.at ?? toViewportPoint(named.coordinate, space) };

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
        // The size named is the one the agent aims in: the picture's, when one set the space.
        const reason =
          space && result.reason.startsWith("point-outside-viewport")
            ? `point-outside-viewport (screenshot ${space.image.width}x${space.image.height})`
            : result.reason;
        return answer(callId, "not-actionable", reason);
      }
      return answer(callId, "failed", result.reason);
    }
    return {
      callId,
      outcome: "ok",
      result: {
        delivery: result.delivery,
        file: result.file,
        // Where the events landed, in the space the agent gave its point in (R-280 follow-up): the
        // page measures it in CSS pixels, and the agent's own point was read off its picture.
        ...(result.point ? { point: toPicturePoint(result.point, space) } : {}),
      },
    };
  }

  return {
    handles(tool) {
      return tool === "file_upload" || tool === "upload_image";
    },
    async run(request) {
      const holds: AttachmentCallHold[] = [];
      try {
        return request.tool === "upload_image" ? await runUploadImage(request, holds) : await runFileUpload(request);
      } finally {
        for (const held of holds) held.done();
      }
    },
  };
}
