import { AGENT_READ_PAGE_MAX_NODES, createBounds, type AgentFindResult } from "@hallpass/contracts";
import { enumerateTabFrames } from "../../chrome-adapters/scripting.js";
import { collectFromActiveTab, resolveHandleOnTab, resolveOnActiveTab } from "../content-broker.js";
import type { AgentToolContext } from "./context.js";
import { askPageFrames, carriedFieldState, tabFrames, type CarriedFieldState } from "./frames.js";
import type { AgentPageBinding } from "./page-binding.js";

/**
 * How the agent names an element (003/US3 decisions 1 and 2, R-106).
 *
 * Every target is a *ref*: a handle the page's own target registry minted. A description, a
 * viewport point and "whatever has focus" are three ways of asking for one, and all three go
 * through the registry so a ref has one lifetime and `stale` has one meaning. Nothing here invents
 * an addressing scheme of its own - no selector, no XPath, no coordinate stored for later - because
 * a second way to name an element is a second thing that can go stale without saying so.
 *
 * That rule is why the worker keeps no reference book of its own (004/US6). The page's handle
 * already has every property FR-066 asks for - it is opaque, carries no frame id, stays with its
 * element across reads, is never recycled, and dies with the document - so a worker-side rename
 * would add a layer to translate on every path and no property the agent does not already have.
 */

/** A target as the tool contracts express it: a ref, or a point that is about to become one. */
export type AgentTarget = { ref: string } | { x: number; y: number };

export type RefResolution =
  | { ok: true; ref: string }
  | { ok: false; reason: "no-match" | "too-broad" | "stale" };

function isRef(target: AgentTarget): target is { ref: string } {
  return typeof (target as { ref?: unknown }).ref === "string";
}

/**
 * Turns whatever the tool named into a ref.
 *
 * A ref passes straight through - it is already a registry handle, and re-resolving it would be a
 * chance to hand back a *different* element than the agent asked about. A point is resolved by the
 * page, through `elementFromPoint`, so hit-testing is the browser's answer rather than this
 * worker's guess about what is on top.
 */
export async function resolveRef(
  context: AgentToolContext,
  binding: AgentPageBinding,
  target: AgentTarget | undefined,
): Promise<RefResolution> {
  if (target !== undefined && isRef(target)) {
    return { ok: true, ref: target.ref };
  }
  const reply = await resolveHandleOnTab({
    taskId: context.taskId,
    operationId: context.operationId,
    runtimeEpochId: context.runtimeEpochId,
    nonce: context.nonce,
    expectedTabId: binding.tabId,
    canonicalOrigin: binding.canonicalOrigin,
    documentEpoch: binding.documentEpoch,
    generalPageReadGrantId: context.generalPageReadGrantId,
    // No target at all means the focused element, which is what `type` and `key` default to.
    ...(target === undefined ? {} : { point: { x: target.x, y: target.y } }),
    tab: binding.tabId,
  });
  if (reply.ok === false) {
    return { ok: false, reason: "stale" };
  }
  // `missed` is a confirmation's own outcome (004/T129) - it names a ref to check against, which
  // this call never does, so the page never answers it here. Named rather than left for the
  // exhaustiveness check to catch as a silent `no-match`.
  if (reply.outcome === "missed") {
    return { ok: false, reason: "no-match" };
  }
  if (reply.outcome !== "resolved") {
    return { ok: false, reason: reply.outcome };
  }
  const first = reply.candidates[0];
  return first ? { ok: true, ref: first.targetHandle } : { ok: false, reason: "no-match" };
}

/** A frame's own identity for a ref it claims, as `content-broker.ts`'s ports take it. */
export type RefFrame = { frameId: number; documentEpoch: string; canonicalOrigin: string };

/**
 * Which frame owns a ref, discovered once (004/T160).
 *
 * `wait` and `file_upload`'s refs carry no frame identity of their own, unlike the pointer tools:
 * those only have it as a by-product of measuring a click's coordinates (`createTargetLocator`,
 * `effects.ts`). Before either can address a ref a nested frame minted, something has to ask each
 * frame whose registry claims it - the same "collect rooted at the ref" question `locateInFrame`
 * asks, without the rect a pointer tool needs and this one does not.
 *
 * A page of one document never calls the frames at all: the ref is frame 0's, with the binding's
 * own identity, exactly as every caller before this slice. `wait` polls; it resolves this once per
 * call and reuses the answer rather than re-asking every frame on every tick.
 */
export async function discoverRefFrame(
  context: AgentToolContext,
  binding: AgentPageBinding,
  ref: string,
  enumerateFrames: typeof enumerateTabFrames = enumerateTabFrames,
): Promise<RefFrame | undefined> {
  const frames = await tabFrames(binding.tabId, binding.canonicalOrigin, enumerateFrames);
  if (frames.length <= 1) return undefined;
  const found = await Promise.all(
    frames.map(async (frame): Promise<RefFrame | undefined> => {
      let collected: Awaited<ReturnType<typeof collectFromActiveTab>>;
      try {
        collected = await collectFromActiveTab({
          taskId: context.taskId,
          operationId: context.operationId,
          runtimeEpochId: context.runtimeEpochId,
          nonce: context.nonce,
          requested: ["page.structure", "page.target-metadata"],
          generalGrantActive: true,
          generalPageReadGrantId: context.generalPageReadGrantId,
          formGrantActive: false,
          mintPolicy: "all-controls",
          rootTargetHandle: ref,
          frameId: frame.frameId,
          tab: binding.tabId,
        });
      } catch {
        // A frame that could not be asked has not claimed the ref; another one may still have it.
        return undefined;
      }
      const claims = (collected.semanticNodes ?? []).some(
        (node) => (node as { targetHandle?: unknown }).targetHandle === ref,
      );
      return claims
        ? { frameId: frame.frameId, documentEpoch: collected.documentEpoch, canonicalOrigin: collected.canonicalOrigin }
        : undefined;
    }),
  );
  return found.find((entry): entry is RefFrame => entry !== undefined);
}

/** What one document answered: the resolution, and the names the worker minted for its handles. */
type FrameResolution = {
  outcome: "resolved" | "no-match" | "too-broad";
  matches: AgentFindResult["matches"];
};

/**
 * The two ways asking one document can fail, in the words the agent already has for them.
 *
 * They are thrown rather than returned because a frame's failure is not this function's answer to
 * give: on a page of one document it is the whole answer, and on a framed page it is one frame
 * having said nothing while the rest of the page still answers.
 */
type FrameFailure = "stale" | "not-readable";

/**
 * One document's answer to the description (003/US3 decision 1).
 *
 * It collects first because that is what mints handles at all: the registry is filled by a
 * collection, and a resolution answers from what the collection recorded. Collecting also gives the
 * role and label the answer carries - values the *worker* minted, never text the page sent back in
 * reply to the query, which is the rule 002's resolution already follows.
 *
 * The collection's own ceiling has to be `read_page`'s, not the default 200 (004/T137, FR-068). An
 * open shadow root's content is appended *after* every light-DOM match in the walk
 * (`collector.ts`'s `walkElements`), so a page with 200 ordinary elements ahead of it left a
 * shadow-only control past the default bound - unmounted into the registry, and so unreachable by a
 * `find` that had never had a prior `read_page` mint it in. The bound is raised here, not widened in
 * the walk itself, because the walk already traverses shadow roots correctly; what `find` had was
 * the wrong ceiling on how much of that walk it kept.
 */
const FIND_COLLECTION_BOUNDS = createBounds({ maxSemanticNodes: AGENT_READ_PAGE_MAX_NODES });

async function resolveInFrame(
  context: AgentToolContext,
  binding: AgentPageBinding,
  query: string,
  maxCandidates: number,
  frameId: number | undefined,
  /** The epoch this answer must have come from, when the caller already holds one for it. */
  expectedEpoch: string | undefined,
): Promise<FrameResolution> {
  let collected: Awaited<ReturnType<typeof collectFromActiveTab>>;
  try {
    collected = await collectFromActiveTab({
      taskId: context.taskId,
      operationId: context.operationId,
      runtimeEpochId: context.runtimeEpochId,
      nonce: context.nonce,
      requested: ["page.structure", "page.target-metadata"],
      generalGrantActive: true,
      generalPageReadGrantId: context.generalPageReadGrantId,
      formGrantActive: false,
      // The same minting `read_page` asks for (B1): a description that names a checkbox or a link
      // has to resolve to a handle, and a resolution can only answer from what a collection minted.
      mintPolicy: "all-controls",
      // 005/FR-072 scenario 8: a match says what its field holds, so the collection has to carry
      // the field facts for the description map below to read them from.
      includeFields: true,
      bounds: FIND_COLLECTION_BOUNDS,
      ...(frameId === undefined ? {} : { frameId }),
      tab: binding.tabId,
    });
  } catch {
    throw new Error("not-readable" satisfies FrameFailure);
  }
  if (expectedEpoch !== undefined && collected.documentEpoch !== expectedEpoch) {
    // The document changed between binding and collection; the handles just minted belong to it,
    // not to the one the caller asked about.
    throw new Error("stale" satisfies FrameFailure);
  }
  const described = new Map<string, { role?: string; label?: string } & CarriedFieldState>();
  for (const node of collected.semanticNodes ?? []) {
    const entry = node as { targetHandle?: unknown; role?: unknown; label?: unknown };
    if (typeof entry.targetHandle === "string") {
      described.set(entry.targetHandle, {
        ...(typeof entry.role === "string" ? { role: entry.role } : {}),
        ...(typeof entry.label === "string" ? { label: entry.label } : {}),
        // 005/FR-072 scenario 8: a match says what the field holds, exactly as a read node does.
        ...carriedFieldState(node),
      });
    }
  }
  const reply = await resolveOnActiveTab({
    taskId: context.taskId,
    operationId: context.operationId,
    runtimeEpochId: context.runtimeEpochId,
    nonce: context.nonce,
    expectedTabId: binding.tabId,
    canonicalOrigin: binding.canonicalOrigin,
    // This frame's own epoch and origin, as its collection just declared them: what the check
    // catches is a document being replaced between the minting and the resolution, and that is a
    // question about one document - a cross-origin child never had the tab's origin.
    documentEpoch: collected.documentEpoch,
    frameOrigin: collected.canonicalOrigin,
    generalPageReadGrantId: context.generalPageReadGrantId,
    description: query,
    maxCandidates,
    ...(frameId === undefined ? {} : { frameId }),
    tab: binding.tabId,
  });
  if (reply.ok === false) throw new Error("stale" satisfies FrameFailure);
  // `missed` is a point confirmation's own outcome (004/T129); a description resolution never
  // names a ref to confirm, so the page never answers it here. Named for the type checker.
  if (reply.outcome === "missed") return { outcome: "no-match", matches: [] };
  if (reply.outcome !== "resolved") return { outcome: reply.outcome, matches: [] };
  return {
    outcome: "resolved",
    matches: reply.candidates.map((candidate) => ({
      ref: candidate.targetHandle,
      ...described.get(candidate.targetHandle),
    })),
  };
}

function failureOf(error: unknown): FrameFailure {
  return (error as Error | undefined)?.message === "not-readable" ? "not-readable" : "stale";
}

/**
 * `find` over the whole page (003/US3 decision 1, 004/T115 for the frames).
 *
 * A tab of one document takes the 003 path and only that: one collection, its own epoch check, its
 * own answer - so an unframed page answers byte for byte what it did before frames, `stale`
 * included.
 *
 * A framed page is asked one frame at a time, in parallel against the one deadline the structural
 * read uses, because a target registry is per document: "is this description on the page" is a
 * question each document can only answer about itself. Two things stay page-wide rather than per
 * frame. A match carries the label of the frame it was found in, since a ref the agent is about to
 * act on means nothing without the document it lives in. And `too-broad` is decided over the
 * *merged* matches: the rule is the product refusing to choose between several elements
 * (002/FR-026), and one match in each of four frames is still four elements to choose between.
 */
export async function findOnTab(
  context: AgentToolContext,
  binding: AgentPageBinding,
  query: string,
  maxCandidates: number,
  enumerateFrames: typeof enumerateTabFrames = enumerateTabFrames,
): Promise<{ ok: true; result: AgentFindResult } | { ok: false; reason: FrameFailure }> {
  const frames = await tabFrames(binding.tabId, binding.canonicalOrigin, enumerateFrames);
  if (frames.length <= 1) {
    try {
      const single = await resolveInFrame(
        context,
        binding,
        query,
        maxCandidates,
        undefined,
        binding.documentEpoch,
      );
      // `no-match` and `too-broad` are answers, not failures: the product stops choosing rather
      // than picking one of several, and the agent is told which of the two happened.
      return { ok: true, result: single };
    } catch (error) {
      return { ok: false, reason: failureOf(error) };
    }
  }

  const top = frames.find((frame) => frame.parentFrameId < 0)?.frameId ?? 0;
  let topFailure: FrameFailure | undefined;
  let topAnswered = false;
  const answers = await askPageFrames<FrameResolution>(binding.tabId, {
    enumerateFrames: async () => frames,
    ask: async ({ frameId }) => {
      try {
        const resolution = await resolveInFrame(context, binding, query, maxCandidates, frameId, undefined);
        if (frameId === top) topAnswered = true;
        return resolution;
      } catch (error) {
        if (frameId === top) topFailure = failureOf(error);
        throw error;
      }
    },
  });
  // The top document not answering is the page not being readable at all - a different answer from
  // "one of this page's frames stayed quiet", and the word a 003 find already had for it.
  if (!topAnswered) return { ok: false, reason: topFailure ?? "not-readable" };

  const matches: AgentFindResult["matches"] = [];
  let tooBroad = false;
  for (const answer of answers) {
    if (!answer.readable || answer.answer === undefined) continue;
    if (answer.answer.outcome === "too-broad") tooBroad = true;
    for (const match of answer.answer.matches) {
      matches.push({ ...match, frame: answer.frame });
    }
  }
  if (tooBroad || matches.length > maxCandidates) {
    return { ok: true, result: { outcome: "too-broad", matches: [] } };
  }
  return {
    ok: true,
    result: matches.length === 0 ? { outcome: "no-match", matches: [] } : { outcome: "resolved", matches },
  };
}
