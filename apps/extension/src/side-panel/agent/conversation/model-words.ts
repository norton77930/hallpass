import type { ConversationModelEntry } from "@hallpass/contracts";

/**
 * 025 R-407: what the model chip and its popup say, from an agent's offer (the entries it reported
 * and which of them it calls its default). Values are the agent's own and opaque; names are the
 * agent's own words and are shown as they came (inert text), except that the agent's default is said
 * in the panel's language - the chip never reads "Default (recommended)".
 */

type T = (key: string) => string;

/** The parts of an offer the panel reads (an offer, or a running conversation's state). */
export type ModelOfferView = {
  models: readonly ConversationModelEntry[];
  efforts: readonly ConversationModelEntry[];
  defaultModel?: string | undefined;
  defaultEffort?: string | undefined;
};

/** The name of a model value: the panel's "Default" for the agent's default, else the agent's name, else the value. */
export function modelNameOf(offer: ModelOfferView | undefined, value: string, t: T): string {
  if (offer?.defaultModel === value) return t("conversation.model.default");
  return offer?.models.find((entry) => entry.value === value)?.name ?? value;
}

/** The name of an effort value: the agent's name, else the value. */
export function effortNameOf(offer: ModelOfferView | undefined, value: string): string {
  return offer?.efforts.find((entry) => entry.value === value)?.name ?? value;
}

/**
 * The chip's words: the model, and " · " the effort when there is one and it is not the agent's default.
 * With no model known (nothing remembered), the agent's default.
 */
export function modelChipText(offer: ModelOfferView | undefined, current: { model?: string | undefined; effort?: string | undefined }, t: T): string {
  const model = current.model === undefined ? t("conversation.model.default") : modelNameOf(offer, current.model, t);
  const effort = current.effort;
  if (effort === undefined || effort === offer?.defaultEffort) return model;
  return `${model} · ${effortNameOf(offer, effort)}`;
}
