import type { ConversationModelEntry, ConversationModelOffer } from "@hallpass/contracts";

/**
 * 025 R-398 - R-400, R-403: turns what an agent answered to `session/new`, `session/load`,
 * `session/resume` or `session/set_config_option` into one bounded model offer, and works out which
 * requests a wanted choice needs. Pure: no I/O, no logging, and nothing here throws on an agent's
 * answer.
 *
 * Reading rules (R-398, R-399):
 * - `configOptions` is the source when it has a `select` option of category `model` (the first one);
 *   the first `select` of category `thought_level` is the effort. Every other option - another
 *   category, a boolean, an uncategorised one - is never read (FR-399).
 * - Otherwise a non-empty `models.availableModels` is the source (Hermes); it has no effort.
 * - Neither: the agent "reports none" - an offer with `source: "models"` and no entries, which the
 *   panel shows as no chip. `undefined` is returned only when the answer is not an object at all.
 * - Values are opaque and passed back byte for byte; groups are flattened in order and a group's name
 *   becomes the description of an entry that has none.
 */

const MODEL_MAX = 64;
const EFFORT_MAX = 16;
const VALUE_MAX = 512;
const NAME_MAX = 120;
const DESCRIPTION_MAX = 300;
const OPTION_ID_MAX = 200;
/** The value an agent uses for "my own default" (Claude); listed first. */
const DEFAULT_VALUE = "default";

type Json = Record<string, unknown>;
type Current = { model: string; effort?: string };
/** What a caller wants applied: either part may be absent (an effort-only change keeps the model). */
type Wanted = { model?: string; effort?: string };

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, min: number, max: number): string | undefined =>
  typeof value === "string" && value.length >= min && value.length <= max ? value : undefined;
const nonEmpty = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

const entryOf = (value: unknown, name: unknown, description: unknown, groupName?: string): ConversationModelEntry | undefined => {
  const id = text(value, 1, VALUE_MAX);
  if (id === undefined) return undefined;
  const label = nonEmpty(name) ?? id;
  const note = nonEmpty(description) ?? groupName;
  return { value: id, name: label.slice(0, NAME_MAX), ...(note === undefined ? {} : { description: note.slice(0, DESCRIPTION_MAX) }) };
};

/** An option's `options` array: plain entries, or groups `{ group, name, options }` flattened in order. */
const flatten = (options: unknown[]): ConversationModelEntry[] => {
  const entries: ConversationModelEntry[] = [];
  for (const item of options) {
    if (!isObject(item)) continue;
    if (Array.isArray(item.options)) {
      const groupName = nonEmpty(item.name) ?? nonEmpty(item.group);
      for (const inner of item.options) {
        if (!isObject(inner)) continue;
        const entry = entryOf(inner.value, inner.name, inner.description, groupName);
        if (entry !== undefined) entries.push(entry);
      }
      continue;
    }
    const entry = entryOf(item.value, item.name, item.description);
    if (entry !== undefined) entries.push(entry);
  }
  return entries;
};

/** First of each value, the agent's default first, cut to the bound; the default survives the cut. */
const finish = (entries: ConversationModelEntry[], max: number): { entries: ConversationModelEntry[]; defaultValue?: string } => {
  const seen = new Set<string>();
  const unique = entries.filter((entry) => !seen.has(entry.value) && seen.add(entry.value));
  const defaultEntry = unique.find((entry) => entry.value === DEFAULT_VALUE);
  const ordered = defaultEntry === undefined ? unique : [defaultEntry, ...unique.filter((entry) => entry !== defaultEntry)];
  return { entries: ordered.slice(0, max), ...(defaultEntry === undefined ? {} : { defaultValue: DEFAULT_VALUE }) };
};

/** The first readable `select` option of a category: an id to set it by, and its options. */
const selectOf = (configOptions: unknown, category: string): { id: string; options: unknown[]; currentValue: unknown } | undefined => {
  if (!Array.isArray(configOptions)) return undefined;
  for (const option of configOptions) {
    if (!isObject(option) || option.type !== "select" || option.category !== category) continue;
    const id = text(option.id, 1, OPTION_ID_MAX);
    if (id === undefined || !Array.isArray(option.options)) continue;
    return { id, options: option.options, currentValue: option.currentValue };
  }
  return undefined;
};

const none = (): ConversationModelOffer => ({ source: "models", models: [], efforts: [] });

const read = (answer: Json): { offer: ConversationModelOffer; current?: Current } => {
  const model = selectOf(answer.configOptions, "model");
  if (model !== undefined) {
    const effort = selectOf(answer.configOptions, "thought_level");
    const models = finish(flatten(model.options), MODEL_MAX);
    const efforts = effort === undefined ? undefined : finish(flatten(effort.options), EFFORT_MAX);
    const offer: ConversationModelOffer = {
      source: "config",
      configIds: { model: model.id, ...(effort === undefined ? {} : { effort: effort.id }) },
      models: models.entries,
      efforts: efforts?.entries ?? [],
      ...(models.defaultValue === undefined ? {} : { defaultModel: models.defaultValue }),
      ...(efforts?.defaultValue === undefined ? {} : { defaultEffort: efforts.defaultValue }),
    };
    const currentModel = text(model.currentValue, 1, VALUE_MAX);
    const currentEffort = effort === undefined ? undefined : text(effort.currentValue, 1, VALUE_MAX);
    return {
      offer,
      ...(currentModel === undefined ? {} : { current: { model: currentModel, ...(currentEffort === undefined ? {} : { effort: currentEffort }) } }),
    };
  }

  const list = isObject(answer.models) && Array.isArray(answer.models.availableModels) ? answer.models : undefined;
  if (list !== undefined) {
    const entries: ConversationModelEntry[] = [];
    for (const item of list.availableModels as unknown[]) {
      const entry = isObject(item) ? entryOf(item.modelId, item.name, item.description) : undefined;
      if (entry !== undefined) entries.push(entry);
    }
    const models = finish(entries, MODEL_MAX);
    if (models.entries.length > 0) {
      const currentModel = text(list.currentModelId, 1, VALUE_MAX);
      return {
        offer: { source: "models", models: models.entries, efforts: [], ...(models.defaultValue === undefined ? {} : { defaultModel: models.defaultValue }) },
        ...(currentModel === undefined ? {} : { current: { model: currentModel } }),
      };
    }
  }
  return { offer: none() };
};

const readSafely = (answer: unknown): { offer: ConversationModelOffer; current?: Current } | undefined => {
  if (!isObject(answer)) return undefined;
  try {
    return read(answer);
  } catch {
    return { offer: none() };
  }
};

/** The offer in an agent's answer; `undefined` when the answer is not an object, "reports none" when nothing is readable. */
export const readModelOffer = (answer: unknown): ConversationModelOffer | undefined => readSafely(answer)?.offer;

/** What the agent says is current (R-406): the model option's `currentValue`, or `models.currentModelId`. */
export const currentOf = (answer: unknown): Current | undefined => readSafely(answer)?.current;

export type ModelTarget = { kind: "none" } | { kind: "send"; model?: string; effort?: string } | { kind: "unavailable"; model: string };

/**
 * R-403 / FR-407: what to send so the agent ends on `wanted`. Only the parts that differ from what it
 * reports; a wanted model the offer does not list is `unavailable` (the caller keeps the agent's own
 * and says so); a wanted effort the offer does not list is dropped.
 */
export const resolveTarget = (offer: ConversationModelOffer, current: Current | undefined, wanted: Wanted | undefined): ModelTarget => {
  if (wanted === undefined) return { kind: "none" };
  const send: { model?: string; effort?: string } = {};
  if (wanted.model !== undefined) {
    if (!offer.models.some((entry) => entry.value === wanted.model)) return { kind: "unavailable", model: wanted.model };
    if (current?.model !== wanted.model) send.model = wanted.model;
  }
  if (wanted.effort !== undefined && offer.efforts.some((entry) => entry.value === wanted.effort) && current?.effort !== wanted.effort) {
    send.effort = wanted.effort;
  }
  return send.model === undefined && send.effort === undefined ? { kind: "none" } : { kind: "send", ...send };
};

export type ModelRequest =
  | { method: "session/set_config_option"; params: { sessionId: string; configId: string; value: string } }
  | { method: "session/set_model"; params: { sessionId: string; modelId: string } };

/** R-399: the requests for the parts to send, model first, then effort. The older list never sends an effort. */
export const requestsFor = (offer: ConversationModelOffer, sessionId: string, parts: Wanted): ModelRequest[] => {
  const requests: ModelRequest[] = [];
  if (offer.source === "models") {
    if (parts.model !== undefined) requests.push({ method: "session/set_model", params: { sessionId, modelId: parts.model } });
    return requests;
  }
  if (parts.model !== undefined && offer.configIds !== undefined) {
    requests.push({ method: "session/set_config_option", params: { sessionId, configId: offer.configIds.model, value: parts.model } });
  }
  if (parts.effort !== undefined && offer.configIds?.effort !== undefined) {
    requests.push({ method: "session/set_config_option", params: { sessionId, configId: offer.configIds.effort, value: parts.effort } });
  }
  return requests;
};

