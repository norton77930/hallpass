import { z } from "zod";
import {
  RUNTIME_PROTOCOL_VERSION,
  AGENT_UPLOAD_MAX_BASE64_CHARS,
  AGENT_UPLOAD_MAX_FILES,
  TARGET_MINT_POLICIES,
  WAIT_CONDITIONS,
} from "./common.js";
import { PAGE_READ_DATA_CATEGORIES } from "./capabilities.js";
import { createActionArgumentSchemas } from "./action-arguments.js";
import { DEFAULT_BOUNDS, type ProtocolBounds } from "./bounds.js";

/**
 * Why the content runtime refused, or could not carry out, an action (002 T053b). Closed so a reason
 * the worker does not know cannot reach the task channel as an error code: the broker refuses a reply
 * naming anything else. The worker decides from the reason whether the refusal is a denial (a policy
 * decision that will not change on retry) or a failure (the step could not be carried out); that
 * decision is deliberately not encoded here.
 */
export const CONTENT_EXECUTION_REFUSAL_REASONS = [
  // Decided from policy at effect time, against the live element.
  "denied",
  "submission-guard",
  "unsupported-key",
  // The action could not be carried out.
  "stale-target",
  "missing-target",
  "missing-sink",
  // The frame, or the binding it cited, was not acceptable to the runtime.
  "invalid-message",
  "stale-binding",
  "stale-context",
  "cancelled",
  "unsupported-page",
] as const;

export type ContentExecutionRefusalReason = (typeof CONTENT_EXECUTION_REFUSAL_REASONS)[number];

export function isContentExecutionRefusalReason(value: unknown): value is ContentExecutionRefusalReason {
  return (CONTENT_EXECUTION_REFUSAL_REASONS as readonly unknown[]).includes(value);
}

/**
 * Builds every extension-runtime schema against one bounds object, for the same reason the task
 * channel does: the limits a schema enforces stay traceable to a single injected object.
 *
 * Module-private since 009: the worker↔panel projections the archived remote path drove were the
 * only callers that ever built a second set against their own bounds, and they went with it.
 */
function createExtensionRuntimeSchemas(bounds: ProtocolBounds = DEFAULT_BOUNDS) {
  const { executeActionPayloadSchema } = createActionArgumentSchemas(bounds);

  const runtimeBase = {
    runtimeProtocolVersion: z.literal(RUNTIME_PROTOCOL_VERSION),
    messageId: z.string().min(1),
    runtimeEpochId: z.string().min(1),
  };

  /**
   * The nonce that binds one worker↔page conversation. It is minted per probe, 128 bits of local
   * randomness, and every later message of that binding must repeat it: a frame captured from an
   * earlier binding no longer matches, so it cannot be replayed into a live one.
   */
  const channelNonceSchema = z.string().regex(/^[0-9a-f]{32}$/u);

  /**
   * The finite limits the worker hands the page for one collection. The page never picks its own:
   * a bound the collector chose locally could not be reasoned about from the worker's side, and
   * the panel could not say what was cut. The field names are the `ProtocolBounds` names, so the
   * wire carries a subset of that object rather than a second vocabulary for the same numbers.
   */
  const collectionBoundsSchema = z.strictObject({
    maxVisibleTextChars: z.number().int().positive(),
    maxSemanticNodes: z.number().int().positive(),
    maxLabelChars: z.number().int().positive(),
  });

  const contentBase = {
    ...runtimeBase,
    taskId: z.string().min(1),
    operationId: z.string().min(1),
    nonce: channelNonceSchema,
    expectedTabId: z.number().int(),
    expectedDocumentEpoch: z.string().min(1),
  };

  const contentRuntimeMessageSchema = z.discriminatedUnion("type", [
    z.strictObject({
      ...contentBase,
      type: z.literal("content.probe"),
      payload: z.strictObject({}),
    }),
    z.strictObject({
      ...contentBase,
      type: z.literal("content.collect-page"),
      payload: z.strictObject({
        generalPageReadGrantId: z.string().min(1),
        formValuesGrantId: z.string().min(1).optional(),
        requestedDataCategories: z.array(z.enum(PAGE_READ_DATA_CATEGORIES)).nonempty(),
        bounds: collectionBoundsSchema,
        /**
         * Roots the structural part of the collection at one handle this document minted
         * (003/FR-037, `read_page {ref}`).
         *
         * Optional, and absent means the whole document - which is every frame the 001/002 path has
         * ever sent, unchanged. It is a handle rather than a selector for the same reason every
         * other target is: the registry is the one way this product names an element, and a second
         * one would be a second thing that can go stale without saying so.
         */
        rootTargetHandle: z.string().min(1).max(256).optional(),
        /**
         * Which controls this collection mints a target handle for (003/FR-040, B1).
         *
         * `reviewed` - the default, and the only value the archived 001/002 path ever sends - mints
         * a handle exactly where a reviewed remote effect could land: a plain button and an ordinary
         * text control. `all-controls` mints one for every control the walk sees, links and submit
         * controls included, because the local agent's consent is the owner's per-site mode rather
         * than a per-effect review, and a checkbox with no handle is a control the tool surface
         * simply cannot reach. It widens *naming*, never what an effect is allowed to do: the
         * executor's policy field is a separate decision, taken separately.
         */
        mintPolicy: z.enum(TARGET_MINT_POLICIES).optional(),
        /**
         * Brings `rootTargetHandle`'s own element on screen before its rect is measured (004/T128,
         * B67 G5 correction).
         *
         * Absent or `false` for every caller but the one that is about to deliver a coordinate at
         * that rect: a read must never move the page the owner is looking at, so `find` and
         * `read_page {ref}` never set it. Ignored when `rootTargetHandle` is absent or does not
         * resolve in this document - there is no element to scroll to, and the collection still
         * happens, exactly as an unresolved root already does.
         */
        scrollIntoView: z.boolean().optional(),
      }),
    }),
    z.strictObject({
      ...contentBase,
      type: z.literal("content.resolve-target"),
      // 002/FR-026: resolve a description against the bound document. It rides on the general
      // page-read grant the payload cites, and the worker supplies the candidate bound.
      payload: z.strictObject({
        generalPageReadGrantId: z.string().min(1),
        description: z.string().min(1).max(bounds.maxLabelChars),
        maxCandidates: z.number().int().positive().max(bounds.maxResolutionCandidates),
      }),
    }),
    z.strictObject({
      ...contentBase,
      type: z.literal("content.evaluate-condition"),
      // 002/FR-027: one question about one handle the worker already holds, answered with a
      // boolean. It rides on the same general page-read grant a resolution does. The wait's bound
      // is deliberately absent: the timer is the worker's, and the page is asked once per poll, so
      // a page cannot be told how long the product is prepared to wait.
      payload: z.strictObject({
        generalPageReadGrantId: z.string().min(1),
        targetHandle: z.string().min(1),
        condition: z.enum(WAIT_CONDITIONS),
      }),
    }),
    z.strictObject({
      ...contentBase,
      type: z.literal("content.execute-action"),
      /**
       * Which caller's policy the runtime applies to this one effect (003/US3 decision 3).
       *
       * `classified` is the 001/002 rule: an untrusted remote service asked for this, so the runtime
       * refuses a navigating link, a submitting control and anything it cannot classify. The local
       * agent runs under the owner's per-site consent instead, and under `trusted-agent` those
       * refusals are skipped - and *only* those. Effect observation, the document-change report, the
       * dispatch fence and the expected-tab guard are not policy; they are how the worker knows what
       * happened, and FR-040 forbids claiming an effect nobody observed whoever asked for it.
       *
       * Defaulted rather than required, so every frame the archived path has ever built - and every
       * test that builds one - still means exactly what it meant before this field existed. The
       * remote dispatch never sets it.
       */
      policy: z.enum(["classified", "trusted-agent"]).default("classified"),
      // The action and its arguments share one closed shape with the task channel, so an argument
      // the service could not send cannot reach the page by another route.
      payload: executeActionPayloadSchema,
    }),
    /**
     * 003/US3 decision 2: the two other ways a ref is minted.
     *
     * A coordinate and the focused element both become *registry* handles before anything acts on
     * them, so every target the agent can name has one lifetime and one definition of stale. They
     * ride on the same general page-read grant a resolution does, because looking at what is at a
     * point is a read of the page.
     */
    z.strictObject({
      ...contentBase,
      type: z.literal("content.resolve-point"),
      payload: z.strictObject({
        generalPageReadGrantId: z.string().min(1),
        // Viewport coordinates in CSS pixels, which is what `elementFromPoint` takes. No selector
        // and no document offset: the point names what the user would be pointing at.
        x: z.number().finite(),
        y: z.number().finite(),
        /**
         * The ref this point is confirming (004/T128 gap 1). When present, a hit on the named
         * target's own element or on any of its descendants answers with that same handle rather
         * than minting a fresh one for whatever was topmost - `elementFromPoint` names the icon or
         * label painted over a control as often as it names the control. Absent for an ordinary
         * point-to-ref mint, where nothing is being confirmed against.
         */
        targetHandle: z.string().min(1).max(256).optional(),
      }),
    }),
    z.strictObject({
      ...contentBase,
      type: z.literal("content.resolve-active-element"),
      payload: z.strictObject({ generalPageReadGrantId: z.string().min(1) }),
    }),
    z.strictObject({
      ...contentBase,
      type: z.literal("content.set-files"),
      /**
       * 003/FR-051: the owner's files, as bytes, for one `<input type="file">`.
       *
       * There is no path here and there cannot be one. The host - the owner's own process - is what
       * resolved the paths, checked them against the roots the owner allowed, and read them; by the
       * time a frame exists the file system is already out of the picture. A page that could see a
       * path would be reading the owner's machine, and a runtime that could open one would be a
       * second, unbounded way in.
       */
      payload: z.strictObject({
        targetHandle: z.string().min(1).max(256),
        files: z
          .array(
            z.strictObject({
              name: z.string().min(1).max(255),
              type: z.string().min(1).max(128),
              bytesBase64: z.string().min(1).max(AGENT_UPLOAD_MAX_BASE64_CHARS),
            }),
          )
          .min(1)
          .max(AGENT_UPLOAD_MAX_FILES),
      }),
    }),
    z.strictObject({
      ...contentBase,
      type: z.literal("content.deliver-image"),
      /**
       * 013/FR-170, FR-171: a picture *this session took*, for one place on the page.
       *
       * The same rule `content.set-files` is built around, with the disk swapped for the host's own
       * memory: the bytes arrive already read, nothing here names a file on the machine, and the
       * one thing that could have identified the picture - the id the agent quoted - does not exist
       * on this side of the link. Two targets rather than one, because a page that takes a dragged
       * file has no input to name: a handle this document minted, or a point in its viewport.
       */
      payload: z.strictObject({
        target: z.union([
          z.strictObject({ handle: z.string().min(1).max(256) }),
          z.strictObject({ point: z.strictObject({ x: z.number().finite(), y: z.number().finite() }) }),
        ]),
        file: z.strictObject({
          name: z.string().min(1).max(255),
          type: z.string().min(1).max(128),
          bytesBase64: z.string().min(1).max(AGENT_UPLOAD_MAX_BASE64_CHARS),
        }),
      }),
    }),
    z.strictObject({
      ...contentBase,
      type: z.literal("content.cancel"),
      payload: z.strictObject({}),
    }),
  ]);

  /**
   * 002/FR-026. What the page answers a `content.resolve-target` with, in the one place every layer
   * that has to name it reads it from: the runtime that produces it, the broker that admits it, and
   * the page port the worker consumes it through.
   *
   * It carries handles and nothing else. The runtime matches on the label, the visible text and the
   * role, but those stay on its side of the channel: the worker re-projects every card detail from
   * the target metadata it minted at collection, so a role or a label travelling back from the page
   * could only describe an element the review never showed.
   */
  const contentResolutionReplySchema = z.discriminatedUnion("outcome", [
    z.strictObject({
      ok: z.literal(true),
      outcome: z.literal("resolved"),
      candidates: z
        .array(z.strictObject({ targetHandle: z.string().min(1) }))
        .min(1)
        .max(bounds.maxResolutionCandidates),
    }),
    // Neither outcome names a candidate, so neither carries the field at all.
    z.strictObject({ ok: z.literal(true), outcome: z.enum(["no-match", "too-broad"]) }),
    /**
     * `content.resolve-point`'s own answer to a confirmation that named the ref it was checking
     * (004/T129): the delivered point resolved to a live element, but not to that ref or a
     * descendant of it - a real miss, not an unanswerable one. It carries what was actually there,
     * bounded the way a `find` candidate already is: this is not new disclosure, an ordinary read
     * under the same grant already shows a role and a name for any element on the page.
     */
    z.strictObject({
      ok: z.literal(true),
      outcome: z.literal("missed"),
      role: z.string().max(100).optional(),
      label: z.string().max(bounds.maxLabelChars).optional(),
    }),
  ]);

  /**
   * 002/FR-027. What the page answers a `content.evaluate-condition` with, named to pair with the
   * message it answers.
   *
   * It is one boolean: whether the condition holds right now. Everything the runtime can observe
   * lives in this arm; everything the worker decides - that the bound was reached, that the user
   * pressed Stop, that the document went away - is the worker's, and has no field here. A wait is
   * not a read, so no text, handle, or descriptor travels back with the answer.
   */
  const contentEvaluateConditionReplySchema = z.strictObject({
    ok: z.literal(true),
    holds: z.boolean(),
  });

  return {
    contentRuntimeMessageSchema,
    collectionBoundsSchema,
    channelNonceSchema,
    contentResolutionReplySchema,
    contentEvaluateConditionReplySchema,
  };
}

const defaults = createExtensionRuntimeSchemas();

export const contentRuntimeMessageSchema = defaults.contentRuntimeMessageSchema;
export const collectionBoundsSchema = defaults.collectionBoundsSchema;
export const channelNonceSchema = defaults.channelNonceSchema;
export const contentResolutionReplySchema = defaults.contentResolutionReplySchema;
export const contentEvaluateConditionReplySchema = defaults.contentEvaluateConditionReplySchema;

export type ContentRuntimeMessage = z.infer<typeof contentRuntimeMessageSchema>;
export type ContentResolutionReply = z.infer<typeof contentResolutionReplySchema>;

/**
 * 002/FR-027: what the content runtime answers a condition with, in the one place every layer that
 * has to name it reads it from. The observed arm is the schema above - one boolean, admitted by the
 * contract that declares it - and the refused arm carries a reason from the runtime's own closed
 * set, exactly as a refused execution does. A wait never has a third answer: whether the bound was
 * reached and whether the run was stopped are the worker's own decisions, made from its own timer
 * and its own state.
 */
export type ContentEvaluateConditionReply =
  | z.infer<typeof contentEvaluateConditionReplySchema>
  | { ok: false; reason: ContentExecutionRefusalReason };

