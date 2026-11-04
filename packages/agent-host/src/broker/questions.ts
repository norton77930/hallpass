import type * as acp from "@agentclientprotocol/sdk";
import {
  QUESTION_MAX_FIELDS,
  QUESTION_MAX_OPTIONS,
  QUESTION_MESSAGE_MAX_CHARS,
  QUESTION_SUMMARY_MAX_CHARS,
  QUESTION_TEXT_FORMATS,
  QUESTION_VALUE_MAX_CHARS,
  type QuestionField,
  type QuestionValue,
} from "@hallpass/contracts";

/**
 * 029 T866, T867: an agent's form question (ACP `elicitation/create`, form mode) as the card's fields
 * (R-432, R-433), the check of the owner's reply against it (R-434), and the answered line (R-436).
 * Pure: no connection, no clock. The broker keeps the fields it showed and checks the reply against
 * exactly those.
 */

/** A form-mode `elicitation/create` request. */
export type FormRequest = Extract<acp.CreateElicitationRequest, { mode: "form" }>;

export type MappedQuestion = {
  message: string;
  fields: QuestionField[];
  /** Shown with its message and Skip only (R-432). */
  skipOnly?: true;
  /** The agent's own waiting time, when it says one (R-429). */
  waitsMs?: number;
};

const LABEL_MAX = 200;
/** A field's label is the question's words (R-438), longer than an option's label. */
const FIELD_LABEL_MAX = 1000;
const DESCRIPTION_MAX = 1000;
const OPTION_VALUE_MAX = 1000;
const PATTERN_MAX = 400;
const PREVIEW_MAX = 4000;
/** R-438: where Claude Code's adapter puts an option's preview. */
const OPTION_PREVIEW_META = "_claude/askUserQuestionOption";
/** R-438: the marker the adapters' question bridges put on a question's own free-text answer field. */
const CUSTOM_ANSWER_META = "_askUserQuestionCustomAnswer";

type Schema = Record<string, unknown>;

const isRecord = (value: unknown): value is Schema => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
const finite = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** A bound broken anywhere: the question is shown with its message and Skip only (R-432). */
class OverBound extends Error {}

const bounded = (value: string | undefined, max: number): string | undefined => {
  if (value !== undefined && value.length > max) throw new OverBound();
  return value;
};

type Option = NonNullable<QuestionField["options"]>[number];

function titledOptions(list: unknown): Option[] | undefined {
  if (!Array.isArray(list)) return undefined;
  if (list.length > QUESTION_MAX_OPTIONS) throw new OverBound();
  const options: Option[] = [];
  for (const entry of list) {
    if (!isRecord(entry) || typeof entry.const !== "string") return undefined;
    const value = bounded(entry.const, OPTION_VALUE_MAX)!;
    const description = bounded(text(entry.description), DESCRIPTION_MAX);
    const meta = isRecord(entry._meta) && isRecord(entry._meta[OPTION_PREVIEW_META]) ? entry._meta[OPTION_PREVIEW_META] : undefined;
    const preview = bounded(text(meta?.preview), PREVIEW_MAX);
    options.push({
      value,
      label: bounded(text(entry.title), LABEL_MAX) ?? value,
      ...(description ? { description } : {}),
      ...(preview ? { preview } : {}),
    });
  }
  return options;
}

function plainOptions(list: unknown): Option[] | undefined {
  if (!Array.isArray(list)) return undefined;
  if (list.length > QUESTION_MAX_OPTIONS) throw new OverBound();
  if (!list.every((entry) => typeof entry === "string")) return undefined;
  return (list as string[]).map((entry) => {
    const value = bounded(entry, OPTION_VALUE_MAX)!;
    return { value, label: value.slice(0, LABEL_MAX) };
  });
}

const compiles = (pattern: string): boolean => {
  try {
    new RegExp(pattern, "u");
    return true;
  } catch {
    return false;
  }
};

/** One property of the form as a field, or `unsupported` when it is no kind the protocol defines. */
function fieldOf(key: string, property: unknown, required: boolean): QuestionField {
  const schema = isRecord(property) ? property : {};
  const description = bounded(text(schema.description), DESCRIPTION_MAX);
  const base = {
    key: bounded(key, LABEL_MAX)!,
    label: bounded(text(schema.title), FIELD_LABEL_MAX) ?? key,
    ...(description ? { description } : {}),
    required,
  };
  const unsupported: QuestionField = { ...base, kind: "unsupported" };
  const meta = isRecord(schema._meta) && isRecord(schema._meta.codex) ? schema._meta.codex : undefined;
  const secret = meta?.isSecret === true ? { secret: true as const } : {};
  const fallback = schema.default;

  switch (schema.type) {
    case "string": {
      const options = titledOptions(schema.oneOf) ?? plainOptions(schema.enum);
      if (options !== undefined) {
        const known = typeof fallback === "string" && options.some((option) => option.value === fallback);
        return { ...base, kind: "choice", options, ...(known ? { default: fallback } : {}) };
      }
      if (schema.oneOf !== undefined || schema.enum !== undefined) return unsupported;
      const format = (QUESTION_TEXT_FORMATS as readonly unknown[]).includes(schema.format) ? (schema.format as QuestionField["format"]) : undefined;
      const pattern = bounded(text(schema.pattern), PATTERN_MAX);
      if (pattern !== undefined && !compiles(pattern)) return unsupported;
      const minLength = count(schema.minLength);
      const maxLength = count(schema.maxLength);
      const initial = typeof fallback === "string" && fallback.length <= QUESTION_VALUE_MAX_CHARS ? fallback : undefined;
      return {
        ...base,
        kind: "text",
        ...(format ? { format } : {}),
        ...(minLength !== undefined ? { minLength } : {}),
        ...(maxLength !== undefined ? { maxLength } : {}),
        ...(pattern !== undefined ? { pattern } : {}),
        ...(initial !== undefined ? { default: initial } : {}),
        ...secret,
      };
    }
    case "number":
    case "integer": {
      const minimum = finite(schema.minimum);
      const maximum = finite(schema.maximum);
      const initial = finite(fallback);
      const fits = initial !== undefined && (schema.type === "number" || Number.isInteger(initial));
      return {
        ...base,
        kind: schema.type,
        ...(minimum !== undefined ? { minimum } : {}),
        ...(maximum !== undefined ? { maximum } : {}),
        ...(fits ? { default: initial } : {}),
      };
    }
    case "boolean":
      return { ...base, kind: "yes-no", ...(typeof fallback === "boolean" ? { default: fallback } : {}) };
    case "array": {
      const items = isRecord(schema.items) ? schema.items : {};
      const options = titledOptions(items.anyOf) ?? plainOptions(items.enum);
      if (options === undefined) return unsupported;
      const minItems = count(schema.minItems);
      const maxItems = count(schema.maxItems);
      const values = new Set(options.map((option) => option.value));
      const initial =
        Array.isArray(fallback) && fallback.every((entry) => typeof entry === "string" && values.has(entry)) ? (fallback as string[]) : undefined;
      return {
        ...base,
        kind: "choices",
        options,
        ...(minItems !== undefined ? { minItems } : {}),
        ...(maxItems !== undefined ? { maxItems } : {}),
        ...(initial !== undefined ? { default: initial } : {}),
      };
    }
    default:
      return unsupported;
  }
}

/** R-429: Codex says how long it waits for an answer under `_meta.codex.autoResolutionMs`. */
function waitingTime(request: FormRequest): number | undefined {
  const meta = isRecord(request._meta) && isRecord(request._meta.codex) ? request._meta.codex : undefined;
  const value = meta?.autoResolutionMs;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

export function questionFromRequest(request: FormRequest): MappedQuestion {
  const waitsMs = waitingTime(request);
  const wait = waitsMs !== undefined ? { waitsMs } : {};
  const message = request.message.slice(0, QUESTION_MESSAGE_MAX_CHARS);
  const skipOnly = { message, fields: [], skipOnly: true as const, ...wait };
  if (request.message.length > QUESTION_MESSAGE_MAX_CHARS) return skipOnly;
  const schema: Schema = isRecord(request.requestedSchema) ? (request.requestedSchema as Schema) : {};
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const keys = Object.keys(properties);
  if (keys.length > QUESTION_MAX_FIELDS) return skipOnly;
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : []);
  let fields: QuestionField[];
  try {
    fields = keys.map((key) => fieldOf(key, properties[key], required.has(key)));
  } catch (error) {
    if (error instanceof OverBound) return skipOnly;
    throw error;
  }
  fields = withDisplayHints(fields, properties);
  const showable = fields.some((field) => field.kind !== "unsupported");
  const blocked = fields.some((field) => field.kind === "unsupported" && field.required);
  if (!showable || blocked) return { message, fields, skipOnly: true, ...wait };
  return { message, fields, ...wait };
}

/**
 * R-438: what the adapters say about how a question is meant to be shown. A free-text field marked as
 * a question's own "other" answer or note joins that choice field (`otherFor`). Claude Code's question
 * tool titles each question with its short tag and puts its words in the description; Codex puts the
 * words in the title and the tag in the description. Either way the tag becomes the `chip` and the
 * words the label. Nothing is inferred from the text itself.
 */
function withDisplayHints(fields: QuestionField[], properties: Schema): QuestionField[] {
  const metaOf = (key: string): Schema | undefined => {
    const property = properties[key];
    return isRecord(property) && isRecord(property._meta) ? property._meta : undefined;
  };
  const choice = new Set(fields.filter((field) => field.kind === "choice" || field.kind === "choices").map((field) => field.key));
  const tagged = new Set<string>();
  const joined = fields.map((field): QuestionField => {
    if (field.kind !== "text") return field;
    const meta = metaOf(field.key);
    const shared = isRecord(meta?.[CUSTOM_ANSWER_META]) ? text((meta[CUSTOM_ANSWER_META] as Schema).questionId) : undefined;
    const codex = isRecord(meta?.codex) && meta.codex.role === "user_note" ? text(meta.codex.questionId) : undefined;
    const target = shared ?? codex;
    if (target === undefined || !choice.has(target)) return field;
    if (shared !== undefined) tagged.add(target);
    return { ...field, otherFor: target };
  });
  return joined.map((field): QuestionField => {
    if (field.kind === "unsupported" || field.otherFor !== undefined) return field;
    const property = properties[field.key];
    const title = isRecord(property) ? text(property.title) : undefined;
    if (tagged.has(field.key) && title !== undefined) {
      // Claude Code: the title is the tag; the words are the description, or the message for one question.
      const { description, ...rest } = field;
      return { ...rest, chip: title.slice(0, LABEL_MAX), label: description ?? title };
    }
    const meta = metaOf(field.key);
    if (isRecord(meta?.codex) && field.description !== undefined) {
      // Codex: the title is the words; the description is the tag.
      const { description, ...rest } = field;
      return { ...rest, chip: description.slice(0, LABEL_MAX) };
    }
    return field;
  });
}

// --- the reply (R-434) ---

export type ReplyCheck = { ok: true; content: Record<string, QuestionValue> } | { ok: false; reason: string };

const EMAIL = /^[^\s@]+@[^\s@]+$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

function formatFits(format: QuestionField["format"], value: string): boolean {
  switch (format) {
    case "email":
      return EMAIL.test(value);
    case "uri":
      return URL.canParse(value);
    case "date":
      return DATE.test(value) && !Number.isNaN(Date.parse(value));
    case "date-time":
      return value.includes("T") && !Number.isNaN(Date.parse(value));
    default:
      return true;
  }
}

/** Why `value` does not fit `field`, or undefined when it does. */
function misfit(field: QuestionField, value: QuestionValue): string | undefined {
  switch (field.kind) {
    case "choice":
      return typeof value === "string" && field.options!.some((option) => option.value === value) ? undefined : "not one of the choices";
    case "choices": {
      if (!Array.isArray(value)) return "not a list of choices";
      if (new Set(value).size !== value.length) return "a choice given twice";
      if (!value.every((entry) => field.options!.some((option) => option.value === entry))) return "not one of the choices";
      if (field.minItems !== undefined && value.length < field.minItems) return "too few choices";
      if (field.maxItems !== undefined && value.length > field.maxItems) return "too many choices";
      return undefined;
    }
    case "text":
      if (typeof value !== "string") return "not text";
      if (field.minLength !== undefined && value.length < field.minLength) return "too short";
      if (field.maxLength !== undefined && value.length > field.maxLength) return "too long";
      if (field.pattern !== undefined && !new RegExp(field.pattern, "u").test(value)) return "does not match the pattern";
      return formatFits(field.format, value) ? undefined : `not a valid ${field.format}`;
    case "number":
    case "integer":
      if (typeof value !== "number" || !Number.isFinite(value)) return "not a number";
      if (field.kind === "integer" && !Number.isInteger(value)) return "not a whole number";
      if (field.minimum !== undefined && value < field.minimum) return "too small";
      if (field.maximum !== undefined && value > field.maximum) return "too large";
      return undefined;
    case "yes-no":
      return typeof value === "boolean" ? undefined : "not yes or no";
    default:
      return "cannot be answered here";
  }
}

/** The owner's values against the fields shown: only their keys, each of its kind and limits, every required one. */
export function checkReply(fields: readonly QuestionField[], values: Record<string, QuestionValue>): ReplyCheck {
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const content: Record<string, QuestionValue> = {};
  for (const [key, value] of Object.entries(values)) {
    const field = byKey.get(key);
    if (field === undefined) return { ok: false, reason: `${key}: not a field of this question` };
    // An optional text left empty is not an answer.
    if (field.kind === "text" && value === "" && !field.required) continue;
    const problem = misfit(field, value);
    if (problem !== undefined) return { ok: false, reason: `${field.label}: ${problem}` };
    content[key] = value;
  }
  for (const field of fields) {
    if (!field.required || field.kind === "unsupported") continue;
    const value = content[field.key];
    if (value === undefined || value === "") return { ok: false, reason: `${field.label}: required` };
  }
  return { ok: true, content };
}

// --- the answered line (R-436) ---

/** Language-neutral marks: the line is built here once and shown as is in either language. */
export const SUMMARY_YES = "✓";
export const SUMMARY_NO = "✗";
export const SUMMARY_HIDDEN = "••••••";

function shownValue(field: QuestionField, value: QuestionValue): string {
  if (field.secret) return SUMMARY_HIDDEN;
  const label = (entry: string) => field.options?.find((option) => option.value === entry)?.label ?? entry;
  if (typeof value === "boolean") return value ? SUMMARY_YES : SUMMARY_NO;
  if (Array.isArray(value)) return value.map(label).join(", ");
  if (typeof value === "string" && field.kind === "choice") return label(value);
  return String(value);
}

/** Each answered field as `label: value` in the fields' order, secrets hidden, clipped to the bound. */
export function summarize(fields: readonly QuestionField[], content: Record<string, QuestionValue>): string {
  const parts = fields.flatMap((field) => (content[field.key] === undefined ? [] : [`${field.label}: ${shownValue(field, content[field.key]!)}`]));
  const line = parts.join("; ");
  return line.length <= QUESTION_SUMMARY_MAX_CHARS ? line : `${line.slice(0, QUESTION_SUMMARY_MAX_CHARS - 1)}…`;
}
