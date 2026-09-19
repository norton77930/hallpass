import { z } from "zod";
import { DEFAULT_BOUNDS, type ProtocolBounds } from "./bounds.js";

/**
 * The keys the assistant may press (002/FR-024, R-022). A contract value, not configuration: the set
 * is closed, and a key outside it is refused at both boundaries. The confirmation key is in the set
 * but carries a qualification the domain policy applies at the effect - it is refused wherever its
 * default effect on the focused element would submit a form or navigate.
 */
export const KEY_PRESS_KEYS = [
  "Enter",
  "Tab",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "Backspace",
  "Delete",
] as const;

export type KeyPressKey = (typeof KEY_PRESS_KEYS)[number];

/** The only supported modifier combination is Shift+Tab; the schema refuses every other pairing. */
export const KEY_PRESS_MODIFIERS = ["Shift"] as const;

/**
 * The one place an action's arguments are defined.
 *
 * The service asks for an action over the task channel and the worker forwards it to the page over
 * the runtime channel. Two independent shapes for the same arguments would let a value the service
 * could not send reach the page anyway, so both boundaries are built from this module: whatever the
 * channel refuses, the content runtime refuses identically.
 */
export function createActionArgumentSchemas(bounds: ProtocolBounds = DEFAULT_BOUNDS) {
  const scrollArgumentsSchema = z.union([
    z.strictObject({ mode: z.literal("target"), targetHandle: z.string().min(1) }),
    z.strictObject({
      mode: z.literal("viewport"),
      direction: z.enum(["up", "down"]),
      magnitude: z.enum(["small", "medium", "large"]),
    }),
  ]);

  const clickArgumentsSchema = z.strictObject({ targetHandle: z.string().min(1) });

  const enterTextArgumentsSchema = z.strictObject({
    targetHandle: z.string().min(1),
    text: z.string().max(bounds.maxTextEntryChars),
    editMode: z.enum(["insert", "replace"]),
  });

  const keyPressArgumentsSchema = z
    .strictObject({
      targetHandle: z.string().min(1),
      key: z.enum(KEY_PRESS_KEYS),
      modifiers: z.array(z.enum(KEY_PRESS_MODIFIERS)).max(1).optional(),
    })
    .superRefine((value, ctx) => {
      if (value.modifiers && value.modifiers.length > 0 && value.key !== "Tab") {
        ctx.addIssue({
          code: "custom",
          message: "Shift is supported only with Tab",
          path: ["modifiers"],
        });
      }
    });

  // 002/FR-025: the pointer gestures. Hover and double activation take the one target they act on; a
  // drag takes two distinct endpoints, both of which the effect-time policy classifies.
  const hoverArgumentsSchema = z.strictObject({ targetHandle: z.string().min(1) });

  const doubleClickArgumentsSchema = z.strictObject({ targetHandle: z.string().min(1) });

  /**
   * 003/US3 decision 4. Two more pointer sequences on one target, shaped exactly like a double
   * activation because that is all they are: a right button press/release the page's handlers see,
   * and three activations plus the browser's own `dblclick`-then-third pattern. Neither carries a
   * browser default action - no context menu opens - so the arguments have nothing else to say.
   */
  const rightClickArgumentsSchema = z.strictObject({ targetHandle: z.string().min(1) });

  const tripleClickArgumentsSchema = z.strictObject({ targetHandle: z.string().min(1) });

  /**
   * 003/US3: one control set to one stated value. A string is text, or a `<select>` option's value
   * or label; a boolean is a checkbox or radio. Nothing else is a value a control can hold, and a
   * value that does not fit the control is reported as not set rather than approximated.
   */
  const formInputArgumentsSchema = z.strictObject({
    targetHandle: z.string().min(1),
    value: z.union([z.string().max(bounds.maxTextEntryChars), z.boolean()]),
  });

  const dragArgumentsSchema = z
    .strictObject({
      targetHandle: z.string().min(1),
      dropTargetHandle: z.string().min(1),
    })
    .superRefine((value, ctx) => {
      if (value.targetHandle === value.dropTargetHandle) {
        ctx.addIssue({
          code: "custom",
          message: "A drag needs two distinct endpoints",
          path: ["dropTargetHandle"],
        });
      }
    });

  const pageReadArgumentsSchema = z.strictObject({ scope: z.literal("current-top-document") });

  /**
   * The action and its arguments as one closed pair. The action is the discriminator, so an
   * argument shape belonging to a different action is a validation failure rather than an extra
   * field the receiver silently ignores.
   */
  const executeActionPayloadSchema = z.discriminatedUnion("action", [
    z.strictObject({ action: z.literal("browser.scroll"), arguments: scrollArgumentsSchema }),
    z.strictObject({ action: z.literal("browser.click"), arguments: clickArgumentsSchema }),
    z.strictObject({ action: z.literal("browser.enter-text"), arguments: enterTextArgumentsSchema }),
    z.strictObject({ action: z.literal("browser.key-press"), arguments: keyPressArgumentsSchema }),
    z.strictObject({ action: z.literal("browser.hover"), arguments: hoverArgumentsSchema }),
    z.strictObject({ action: z.literal("browser.double-click"), arguments: doubleClickArgumentsSchema }),
    z.strictObject({ action: z.literal("browser.drag"), arguments: dragArgumentsSchema }),
    // Runtime-only (003): reachable over the runtime channel, never nameable on the task channel,
    // whose `capability` stays `z.enum(BRIDGE_ACTIONS)`.
    z.strictObject({ action: z.literal("browser.right-click"), arguments: rightClickArgumentsSchema }),
    z.strictObject({ action: z.literal("browser.triple-click"), arguments: tripleClickArgumentsSchema }),
    z.strictObject({ action: z.literal("browser.form-input"), arguments: formInputArgumentsSchema }),
  ]);

  return {
    scrollArgumentsSchema,
    clickArgumentsSchema,
    enterTextArgumentsSchema,
    keyPressArgumentsSchema,
    hoverArgumentsSchema,
    doubleClickArgumentsSchema,
    rightClickArgumentsSchema,
    tripleClickArgumentsSchema,
    formInputArgumentsSchema,
    dragArgumentsSchema,
    pageReadArgumentsSchema,
    executeActionPayloadSchema,
  };
}

const defaults = createActionArgumentSchemas();

export const scrollArgumentsSchema = defaults.scrollArgumentsSchema;
export const clickArgumentsSchema = defaults.clickArgumentsSchema;
export const enterTextArgumentsSchema = defaults.enterTextArgumentsSchema;
export const keyPressArgumentsSchema = defaults.keyPressArgumentsSchema;
export const hoverArgumentsSchema = defaults.hoverArgumentsSchema;
export const doubleClickArgumentsSchema = defaults.doubleClickArgumentsSchema;
export const rightClickArgumentsSchema = defaults.rightClickArgumentsSchema;
export const tripleClickArgumentsSchema = defaults.tripleClickArgumentsSchema;
export const formInputArgumentsSchema = defaults.formInputArgumentsSchema;
export const dragArgumentsSchema = defaults.dragArgumentsSchema;
export const pageReadArgumentsSchema = defaults.pageReadArgumentsSchema;
export const executeActionPayloadSchema = defaults.executeActionPayloadSchema;
