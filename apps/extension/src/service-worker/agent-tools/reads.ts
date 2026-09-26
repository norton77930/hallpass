import {
  AGENT_READ_PAGE_MAX_CHARS,
  AGENT_READ_PAGE_MAX_NODES,
  agentToolArgSchemas,
  createBounds,
  type AgentNativeRequest,
  type AgentNativeResponse,
  type AgentReadPageResult,
  type AgentToolName,
} from "@hallpass/contracts";
import {
  captureTab,
  type CaptureDeps,
  type CaptureFrame,
  type CaptureRegion,
  type CaptureSend,
} from "../../chrome-adapters/capture.js";
import { queryTabSnapshots } from "../../chrome-adapters/tabs.js";
import { enumerateTabFrames } from "../../chrome-adapters/scripting.js";
import { collectFromActiveTab } from "../content-broker.js";
import {
  capPageNodes,
  carriedFieldState,
  mergePageFrames,
  mergePageText,
  tabFrames,
  type FrameSubtreeNode,
} from "./frames.js";
import type { AgentSessionContexts, AgentToolContext } from "./context.js";
import { bindingFailureResponse, type AgentPageBinding, type AgentPageBindings } from "./page-binding.js";
import { inputUnavailable } from "./input.js";
import { ownershipRefusal, type TabOwnershipLookup } from "./ownership.js";
import { captureFrameFacts, photographTab, type PhotographDeps } from "./photograph.js";

/**
 * The read tools (003/T034, T036, US2, FR-036..FR-039).
 *
 * They are ungated by design and that is the whole point of keeping them in their own file: nothing
 * here consults a site mode, raises a prompt or touches the gate, so the claim "reading never asks
 * the owner anything" is checkable by reading one module rather than by tracing a branch.
 *
 * What they *do* keep is the boundary the remote path already had. Everything they answer with was
 * minted by the worker - a role, a name, a handle, a count - and nothing is page markup, a selector,
 * or a string the page chose the shape of. A read that forwarded the document would be a way for a
 * page to talk to the agent directly, and the whole product is built so that it cannot.
 *
 * The tab still has to be the session's (FR-034): reading a page is ungated, but reading *someone
 * else's tab* is not a thing this session may do at all.
 */

export type AgentReadDeps = {
  context: AgentSessionContexts;
  bindings: AgentPageBindings;
  /** FR-034: the session's own tabs, and nothing else. */
  tabOwnership: TabOwnershipLookup;
  collect?: typeof collectFromActiveTab;
  capture?: typeof captureTab;
  captureDeps?: CaptureDeps;
  listTabs?: typeof queryTabSnapshots;
  /**
   * The emulated size a session gave a tab, when it gave it one (012/FR-158).
   *
   * The record, read from storage - a read never attaches a debugger, and asking the page its size
   * over an attachment this module does not hold would be exactly that.
   */
  currentViewport?: (tabId: number) => Promise<CaptureFrame | undefined>;
  /** One protocol command over the attachment an emulated tab already has (012, R-171). */
  sendOverAttachment?: CaptureSend;
  /** The tab's own content area in CSS pixels: the frame when nothing emulates the tab. */
  tabSize?: (tabId: number) => Promise<CaptureFrame | undefined>;
  /**
   * Claims the emulation's own attachment before an emulated tab is photographed (012/S2c F2).
   *
   * This is the one place a read leads to an attachment, and it is not a read attaching a debugger
   * to a page: the tab is already being debugged by this session's emulation, and after an MV3
   * eviction the only thing missing is this worker's record of it.
   */
  ensureAttached?: PhotographDeps["ensureAttached"];
  /** Which documents a tab is made of (004/US4): the scripting API's all-frames execution. */
  enumerateFrames?: typeof enumerateTabFrames;
  /**
   * What a `read_page` answered, for whoever needs to know later what the page said about a ref
   * (008/T221, FR-106): the recording's labels ask this, because the page - not the worker - is what
   * decides that a control's value is a secret, and a read is the only moment it says so.
   */
  onNodesRead?: (
    tabId: number,
    nodes: ReadonlyArray<{
      ref?: string | undefined;
      role?: string | undefined;
      name?: string | undefined;
      type?: string | undefined;
      redacted?: boolean | undefined;
    }>,
  ) => void;
  reportDiagnostic?: (code: string) => void;
};

export type AgentReadRunner = {
  handles(tool: AgentToolName): boolean;
  run(request: AgentNativeRequest): Promise<AgentNativeResponse>;
};

const READ_TOOL_NAMES = ["get_page_text", "read_page", "screenshot"] as const;

type ReadToolName = (typeof READ_TOOL_NAMES)[number];

/**
 * The roles a `filter: "interactive"` read keeps.
 *
 * It is a closed list rather than "anything with a ref", because the two answer different
 * questions: a ref says the runtime could deliver an effect *today*, and an interactive role says
 * the element is one a person would act on. An agent asking for the interactive structure of a page
 * wants the second, including the controls it will find it cannot act on.
 */
const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  // Not an ARIA role but the word the collection uses for a file input (003/C2). It is as
  // interactive as any other control - `file_upload` is aimed at exactly these - and leaving it out
  // would hide the one element that tool exists for from the working read.
  "file",
  "link",
  "listbox",
  "menuitem",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
]);

/**
 * The largest base64 payload one native-messaging frame may carry back.
 *
 * The relay re-frames every message with the 1 MiB native-messaging limit (`native-frame.ts`), so a
 * screenshot larger than that would not fail politely - it would break the link for every later
 * call. Refusing here keeps the failure to the one call that caused it. Raising the framing bound
 * is a protocol decision, not this tool's to make.
 */
export const SCREENSHOT_MAX_BASE64_CHARS = 700_000;

/**
 * The scale that would have fitted, for the refusal to name (012/FR-162, R-171).
 *
 * A picture shrinks with the *area*, so the linear scale that fits is the square root of the ratio
 * the payload is over by; rounded **down** to a tenth, because a hint that lands a hair over the
 * ceiling is a second refusal. It is the whole reason the refusal is worth reading: an agent told
 * "too large" learns nothing, and an agent told "retry with scale 0.5" has its next call written.
 */
function fittingScale(length: number): number {
  return Math.max(Math.floor(Math.sqrt(SCREENSHOT_MAX_BASE64_CHARS / length) * 10) / 10, 0.1);
}

/** Whether the rectangle is one the viewport actually contains (012/FR-164). */
function insideFrame(region: CaptureRegion, frame: CaptureFrame): boolean {
  return region.x + region.width <= frame.width && region.y + region.height <= frame.height;
}

/**
 * What one document of an agent read may bring back (004/FR-064, R-116).
 *
 * The remote path's 200 nodes are what a person can be shown on a review card; an agent working a
 * real page needs the page. The collection is raised to the page's own ceiling rather than to some
 * value in between, so the only thing that ever decides how big an answer is, is the one ceiling
 * the merge applies to the whole page.
 */
const AGENT_COLLECTION_BOUNDS = createBounds({
  maxSemanticNodes: AGENT_READ_PAGE_MAX_NODES,
  maxVisibleTextChars: AGENT_READ_PAGE_MAX_CHARS,
});

function answer(callId: string, outcome: AgentNativeResponse["outcome"], reason: string): AgentNativeResponse {
  return { callId, outcome, reason };
}

export function createAgentReads(deps: AgentReadDeps): AgentReadRunner {
  const collect = deps.collect ?? collectFromActiveTab;
  const capture = deps.capture ?? captureTab;
  const listTabs = deps.listTabs ?? queryTabSnapshots;
  const enumerateFrames = deps.enumerateFrames ?? enumerateTabFrames;
  /** One set of deps for both halves of a screenshot: the frame it is judged in, and the picture. */
  const photographDeps: PhotographDeps = {
    capture,
    listTabs,
    captureDeps: deps.captureDeps ?? {},
    ...(deps.currentViewport ? { currentViewport: deps.currentViewport } : {}),
    ...(deps.sendOverAttachment ? { send: deps.sendOverAttachment } : {}),
    ...(deps.tabSize ? { tabSize: deps.tabSize } : {}),
    ...(deps.ensureAttached ? { ensureAttached: deps.ensureAttached } : {}),
  };

  /** One document's own readable text; the same collection a 003 text read made, by frame. */
  async function collectText(
    context: AgentToolContext,
    binding: AgentPageBinding,
    frameId: number | undefined,
    maxChars: number,
  ): Promise<{ text: string; truncated: boolean }> {
    const collected = await collect({
      taskId: context.taskId,
      operationId: context.operationId,
      runtimeEpochId: context.runtimeEpochId,
      nonce: context.nonce,
      requested: ["page.visible-text"],
      generalGrantActive: true,
      generalPageReadGrantId: context.generalPageReadGrantId,
      formGrantActive: false,
      // 004/T135a: the page's own ceiling, or the smaller one the caller asked for - the same
      // bound `read_page` collects under, so neither read returns more of a page than the other.
      bounds: createBounds({ maxVisibleTextChars: maxChars }),
      ...(frameId === undefined ? {} : { frameId }),
      tab: binding.tabId,
    });
    return {
      text: collected.visibleText ?? "",
      // `truncated` covers both dimensions the collector bounds; a text read is only ever cut by
      // the text one, so it is reported only when that is what was cut.
      truncated: collected.truncated === true && collected.truncatedDimension === "visible-text",
    };
  }

  /**
   * The page's text, out of every frame it is made of (004/T115).
   *
   * A tab of one document takes exactly the path it took before frames existed - one collection,
   * the collector's own bound - so a page without frames answers byte for byte what it always did.
   * A framed page is the merge: each readable frame's text in frame order, under one ceiling for
   * the page. The result shape does not change either way; the structured read is where an agent
   * is told which frames a page has.
   */
  async function readText(
    context: AgentToolContext,
    binding: AgentPageBinding,
    maxChars: number,
  ): Promise<{ ok: true; text: string; truncated: boolean; truncatedBy?: "chars" } | { ok: false }> {
    const frames = await tabFrames(binding.tabId, binding.canonicalOrigin, enumerateFrames);
    if (frames.length <= 1) {
      try {
        const only = await collectText(context, binding, undefined, maxChars);
        // One document has one bound, so a cut here is always the character ceiling - and naming
        // it is what tells the agent the next call may raise it.
        return { ok: true, ...only, ...(only.truncated ? { truncatedBy: "chars" as const } : {}) };
      } catch {
        return { ok: false };
      }
    }
    // The top document not answering is the page not being readable at all - a different answer
    // from "one of this page's frames stayed quiet", and the word a 003 read already had for it.
    const top = frames.find((frame) => frame.parentFrameId < 0)?.frameId ?? 0;
    let topAnswered = false;
    const merged = await mergePageText(binding.tabId, {
      enumerateFrames: async () => frames,
      readText: async ({ frameId }) => {
        const answer = await collectText(context, binding, frameId, maxChars);
        if (frameId === top) topAnswered = true;
        return answer;
      },
      maxChars,
    });
    return topAnswered ? { ok: true, ...merged } : { ok: false };
  }

  /**
   * One document's own nodes, filtered as the caller asked (004/T115).
   *
   * The filter is per document because that is where the facts it works on live: a depth is
   * counted from the document's own root, and "the page is not showing this" is a question only
   * the document that holds the element can answer. The bounds are the opposite - they are what an
   * unasked-for read may cost the agent's context - so they are applied once, to the whole page,
   * by the merge.
   */
  function projectNodes(
    collected: Awaited<ReturnType<typeof collectFromActiveTab>>,
    options: { maxDepth: number | undefined; interactiveOnly: boolean },
    /**
     * Why a node was left out, because the answer says so (004/T137b): a depth is a limit the next
     * call may simply raise, and a filter is not a limit at all - it is what the caller asked for.
     */
    onDropped: (reason: "depth" | "filter") => void,
  ): FrameSubtreeNode[] {
    const nodes: FrameSubtreeNode[] = [];
    for (const raw of collected.semanticNodes ?? []) {
      const node = raw as { role?: unknown; label?: unknown; targetHandle?: unknown; depth?: unknown };
      if (typeof node.role !== "string") continue;
      const depth = typeof node.depth === "number" ? node.depth : 0;
      if (options.maxDepth !== undefined && depth > options.maxDepth) {
        onDropped("depth");
        continue;
      }
      if (options.interactiveOnly && !INTERACTIVE_ROLES.has(node.role)) {
        onDropped("filter");
        continue;
      }
      /*
       * C2: a node nobody can see is not part of the working list. `all` still carries it - the
       * agent asked what is on the page - and it keeps its ref, because a `wait` for an element to
       * appear has to be able to name it first (FR-048). What it does not get is a place among the
       * elements an action can be delivered to now; the executor refuses one anyway.
       */
      if (options.interactiveOnly && (node as { hidden?: unknown }).hidden === true) {
        onDropped("filter");
        continue;
      }
      /*
       * FR-067: the working list is what is on the screen *now*. A different question from the one
       * above - the browser is drawing this element, it simply sits outside the viewport - and it
       * is the page's answer, because only the document holding the element knows the size of its
       * own viewport. `filter: "all"` keeps it: an agent asking what the page contains is asking
       * about the page, not about the part of it currently scrolled into view.
       */
      if (options.interactiveOnly && (node as { offscreen?: unknown }).offscreen === true) {
        onDropped("filter");
        continue;
      }
      const fields = node as { href?: unknown; type?: unknown; placeholder?: unknown; options?: unknown };
      nodes.push({
        ...(typeof node.targetHandle === "string" ? { ref: node.targetHandle } : {}),
        role: node.role,
        ...(typeof node.label === "string" ? { name: node.label } : {}),
        depth,
        // FR-067: what the element *is*, so an agent can choose between elements without a second
        // read. Every one of them was minted by the collection and bounded by the broker.
        ...(typeof fields.href === "string" ? { href: fields.href } : {}),
        ...(typeof fields.type === "string" ? { type: fields.type } : {}),
        ...(typeof fields.placeholder === "string" ? { placeholder: fields.placeholder } : {}),
        ...(Array.isArray(fields.options)
          ? { options: fields.options.filter((option): option is string => typeof option === "string") }
          : {}),
        // 005/FR-072: what the control holds, decided by the page (value, checked, redacted, cut).
        ...carriedFieldState(node),
        ...((node as { frameOwner?: unknown }).frameOwner === true ? { frameOwner: true } : {}),
      });
    }
    return nodes;
  }

  /** The one collection a read is built from, addressed to one document of the tab. */
  async function collectDocument(
    context: AgentToolContext,
    binding: AgentPageBinding,
    options: { frameId?: number; rootTargetHandle?: string },
  ): Promise<Awaited<ReturnType<typeof collectFromActiveTab>>> {
    return collect({
      taskId: context.taskId,
      operationId: context.operationId,
      runtimeEpochId: context.runtimeEpochId,
      nonce: context.nonce,
      // `page.target-metadata` is what mints the handles; without it the nodes would come back
      // describing elements the agent had no way to name.
      requested: ["page.structure", "page.target-metadata"],
      generalGrantActive: true,
      generalPageReadGrantId: context.generalPageReadGrantId,
      formGrantActive: false,
      includeDepth: true,
      // C2: and whether the page is actually showing each node, so the working list below can
      // leave out what nobody can see without pretending it is not there.
      includeVisibility: true,
      // FR-040, B1: every control the page shows gets a ref, so a node this read returns is one
      // the effect tools can actually be pointed at. The remote path never asks for this.
      mintPolicy: "all-controls",
      // FR-067: a link's destination, a control's type and placeholder, a select's options.
      includeFields: true,
      // FR-064: the page's own ceiling, so the merge below is the only thing that cuts an answer.
      bounds: AGENT_COLLECTION_BOUNDS,
      ...(options.rootTargetHandle === undefined ? {} : { rootTargetHandle: options.rootTargetHandle }),
      ...(options.frameId === undefined ? {} : { frameId: options.frameId, includeFrameFacts: true }),
      tab: binding.tabId,
    });
  }

  async function readStructure(
    context: AgentToolContext,
    binding: AgentPageBinding,
    args: Record<string, unknown>,
  ): Promise<{ ok: true; result: AgentReadPageResult } | { ok: false }> {
    const root = typeof args.ref === "string" ? args.ref : undefined;
    const options = {
      maxDepth: typeof args.depth === "number" ? args.depth : undefined,
      interactiveOnly: args.filter !== "all",
    };
    // FR-064: the caller may spend less of its context than the ceiling, never more. Absent means
    // the ceiling, so a bound does not have to be restated on every call.
    const maxChars = typeof args.max_chars === "number" ? args.max_chars : undefined;
    const limits = {
      maxNodes: AGENT_READ_PAGE_MAX_NODES,
      ...(maxChars === undefined ? {} : { maxChars }),
    };
    /*
     * T137b: two different cuts, because they lead to two different next moves. A node left out for
     * being deeper than the depth of the read is one the agent can have by asking past it; a node
     * left out by the filter is one it asked not to be shown, and there is no limit to raise.
     */
    let droppedByDepth = false;
    let droppedByFilter = false;
    const onDropped = (reason: "depth" | "filter") => {
      if (reason === "depth") droppedByDepth = true;
      else droppedByFilter = true;
    };
    const dropped = () => droppedByDepth || droppedByFilter;
    /*
     * Which limit to name when more than one ran out: the page-wide ceilings first, because they cut
     * the answer that is being returned, and the depth after them, because it cut what never reached
     * it. Naming nothing is still the answer when the only cut was the filter or the collection.
     */
    const nameLimit = (ceiling: "nodes" | "chars" | undefined): "nodes" | "chars" | "depth" | undefined =>
      ceiling ?? (droppedByDepth ? "depth" : undefined);

    // A read rooted at a ref stays in the document that minted it: the handle names an element of
    // one document, and asking the *other* frames for it would either find nothing or - worse -
    // hand back their whole contents under a root they never had.
    const frames =
      root === undefined ? await tabFrames(binding.tabId, binding.canonicalOrigin, enumerateFrames) : [];
    if (frames.length <= 1) {
      let collected: Awaited<ReturnType<typeof collectFromActiveTab>>;
      try {
        collected = await collectDocument(context, binding, {
          ...(root === undefined ? {} : { rootTargetHandle: root }),
        });
      } catch {
        return { ok: false };
      }
      // One document is the whole page, so the answer carries no frame list and no labels: a label
      // means something only against the list it belongs to, and the contract already reads a node
      // without one as a node of the top document.
      const nodes = projectNodes(collected, options, onDropped).map(({ frameOwner, ...node }) => node);
      // The same ceiling the merge applies to a framed page, applied by the same function: one
      // document is a page too, and a read may not cost less merely because the page has no frames.
      const capped = capPageNodes(nodes, limits);
      return {
        ok: true,
        result: {
          nodes: capped.nodes,
          // Three different cuts, one honest word: the collection ran out, a page ceiling ran out,
          // or this filter left something out. Either way the agent has not seen the whole page.
          truncated: collected.truncated === true || dropped() || capped.truncatedBy !== undefined,
          ...(nameLimit(capped.truncatedBy) === undefined ? {} : { truncatedBy: nameLimit(capped.truncatedBy) }),
        },
      };
    }

    let truncatedByCollector = false;
    const merged = await mergePageFrames(binding.tabId, {
      enumerateFrames: async () => frames,
      readSubtree: async ({ frameId }) => {
        const collected = await collectDocument(context, binding, { frameId });
        if (collected.truncated === true) truncatedByCollector = true;
        return { nodes: projectNodes(collected, options, onDropped) };
      },
      ...limits,
    });
    // The top document not answering is the page not being readable at all - a different answer
    // from "one of this page's frames stayed quiet", and the word a 003 read already had for it.
    if (merged.frames.some((frame) => frame.parent === frame.frame && !frame.readable)) {
      return { ok: false };
    }
    return {
      ok: true,
      result: {
        frames: merged.frames,
        nodes: merged.nodes,
        truncated: merged.truncated || dropped() || truncatedByCollector,
        // Which ceiling ran out, when one did. A filter or a collection cut says `truncated` and
        // nothing more: there was no limit to name, and naming one anyway would be a wrong answer
        // to "what would I raise to see the rest".
        ...(nameLimit(merged.truncatedBy) === undefined ? {} : { truncatedBy: nameLimit(merged.truncatedBy) }),
      },
    };
  }

  async function screenshot(
    callId: string,
    tabId: number,
    region: CaptureRegion | undefined,
    scale: number,
  ): Promise<AgentNativeResponse> {
    // Before anything is photographed, because the frame is what a region is judged against and a
    // refused region must not have cost the owner a tab flicker (012/FR-164).
    const facts = await captureFrameFacts(tabId, photographDeps);
    if (facts.frame === undefined) {
      deps.reportDiagnostic?.("agent.screenshot.frame-unknown");
    } else if (region && !insideFrame(region, facts.frame)) {
      // Named, not clamped: a clamp answers `ok` with a picture of a rectangle the agent did not
      // ask for, and the agent has no way of telling that from the one it meant.
      return answer(callId, "failed", `region-outside-viewport (frame ${facts.frame.width}x${facts.frame.height})`);
    }
    const photograph = await photographTab(
      { tabId, scale, facts, ...(region === undefined ? {} : { region }) },
      photographDeps,
    );
    if (!photograph.ok) {
      // The attachment's own refusal keeps the attachment's words (012/S2c F2): `not-readable`
      // would say the page cannot be photographed, when what happened is that Chrome will not let
      // this session debug the tab the emulation lives on.
      if (photograph.reason === "input-unavailable") {
        return inputUnavailable(callId, photograph.unavailableReason);
      }
      // A tab Chrome no longer has is stale; the restricted pages `captureVisibleTab` refuses are
      // the same ones FR-039 calls not readable, so that is that answer rather than a failure.
      return photograph.reason === "tab-gone"
        ? answer(callId, "stale", "tab-gone")
        : answer(callId, "not-readable", "capture-refused");
    }
    const image = photograph.image;
    if (image.data.length > SCREENSHOT_MAX_BASE64_CHARS) {
      deps.reportDiagnostic?.("agent.screenshot.too-large");
      return answer(callId, "failed", `screenshot-too-large; retry with scale ≤ ${fittingScale(image.data.length)}`);
    }
    if (region && !image.cropped) {
      deps.reportDiagnostic?.("agent.screenshot.not-cropped");
    }
    return {
      callId,
      outcome: "ok",
      result: {
        mimeType: "image/png",
        data: image.data,
        cropped: image.cropped,
        ...(image.width === undefined || image.height === undefined
          ? {}
          : { width: image.width, height: image.height }),
        scale: image.scale,
        ...(photograph.frame === undefined ? {} : { frame: photograph.frame }),
        // What the picture covers, rather than what was asked for: a region the worker could not
        // crop came back as the whole viewport, and this is the field that says so in one word.
        coverage: image.cropped ? "region" : "viewport",
        ...(region === undefined ? {} : { region }),
      },
    };
  }

  async function runRead(request: AgentNativeRequest): Promise<AgentNativeResponse> {
    const { callId } = request;
    const tool = request.tool as ReadToolName;
    const parsed = agentToolArgSchemas[tool].safeParse(request.args);
    if (!parsed.success) {
      return answer(callId, "failed", "invalid-arguments");
    }
    const args = parsed.data as Record<string, unknown>;
    const tabId = typeof args.tabId === "number" ? args.tabId : request.tabId;
    if (tabId === undefined) {
      return answer(callId, "failed", "no-tab");
    }
    const ownership = await deps.tabOwnership(request.sessionId, tabId);
    if (ownership.state !== "this") {
      return ownershipRefusal(callId, ownership);
    }

    if (tool === "screenshot") {
      // Deliberately before any binding: a screenshot is a picture of a window, and a page the
      // content runtime cannot be injected into is still a page the browser can photograph.
      return screenshot(
        callId,
        tabId,
        args.region as CaptureRegion | undefined,
        // The schema defaults it to 1; the check is for the callers inside this worker that hand
        // the tool raw args rather than parsed ones.
        typeof args.scale === "number" ? args.scale : 1,
      );
    }

    const context = deps.context.forCall(request.sessionId, callId);
    const bound = await deps.bindings.bind(tabId, context);
    if (!bound.ok) {
      // FR-039: a restricted scheme, a PDF, the web store - one word for the whole family, and the
      // read's word for it rather than the effect's. 015/FR-205: a page that did not answer is not
      // `stale` either.
      return bindingFailureResponse(callId, bound, "not-readable");
    }

    if (tool === "get_page_text") {
      // Absent means the ceiling (004/T135a): the bound exists so a large page cannot fill the
      // agent's context, not so that it has to be restated on every call.
      const asked = typeof args.max_chars === "number" ? args.max_chars : AGENT_READ_PAGE_MAX_CHARS;
      const text = await readText(context, bound.binding, asked);
      return text.ok
        ? {
            callId,
            outcome: "ok",
            result: {
              text: text.text,
              truncated: text.truncated,
              ...(text.truncatedBy === undefined ? {} : { truncatedBy: text.truncatedBy }),
            },
          }
        : answer(callId, "not-readable", "page-not-collected");
    }

    const structure = await readStructure(context, bound.binding, args);
    if (!structure.ok) return answer(callId, "not-readable", "page-not-collected");
    deps.onNodesRead?.(tabId, structure.result.nodes);
    return { callId, outcome: "ok", result: structure.result };
  }

  return {
    handles(tool) {
      return (READ_TOOL_NAMES as readonly string[]).includes(tool);
    },
    run: runRead,
  };
}
