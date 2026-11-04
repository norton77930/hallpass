import { useId, useState, type ReactElement } from "react";
import type { QuestionField, QuestionReply, QuestionValue } from "@hallpass/contracts";
import type { QuestionEvent } from "./conversation-log.js";

/**
 * 029 FR-440 - FR-449: an agent's form question as a card above the box. One control per field of
 * the broker's mapping (R-432); Send posts exactly the values entered, Skip posts decline; Stop is the
 * box's. Like a permission card it has no timer of its own (FR-442) and leaves when the broker says the
 * question closed, which is how a card answered in another panel document leaves this one (FR-445).
 * The broker checks the reply again (R-434); the checks here only keep Send from offering what it
 * would refuse.
 */

/** What each control holds: a number's text as typed, so an empty box stays empty. */
type Draft = Record<string, string | boolean | string[]>;

/** A message longer than this is shown cut, with "Show all" (R-432: never sent cut). */
const MESSAGE_SHOWN_CHARS = 600;

const EMAIL = /^[^\s@]+@[^\s@]+$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

function initialDraft(fields: readonly QuestionField[]): Draft {
  const draft: Draft = {};
  for (const field of fields) {
    switch (field.kind) {
      case "choice":
      case "text":
        draft[field.key] = typeof field.default === "string" ? field.default : "";
        break;
      case "choices":
        draft[field.key] = Array.isArray(field.default) ? [...field.default] : [];
        break;
      case "number":
      case "integer":
        draft[field.key] = typeof field.default === "number" ? String(field.default) : "";
        break;
      case "yes-no":
        draft[field.key] = field.default === true;
        break;
      default:
        break;
    }
  }
  return draft;
}

function textFits(field: QuestionField, value: string): boolean {
  if (field.minLength !== undefined && value.length < field.minLength) return false;
  if (field.maxLength !== undefined && value.length > field.maxLength) return false;
  if (field.pattern !== undefined) {
    try {
      if (!new RegExp(field.pattern, "u").test(value)) return false;
    } catch {
      return false;
    }
  }
  switch (field.format) {
    case "email":
      return EMAIL.test(value);
    case "uri":
      return URL.canParse(value);
    case "date":
      return DATE.test(value);
    case "date-time":
      return value.includes("T") && !Number.isNaN(Date.parse(value));
    default:
      return true;
  }
}

/** The fields whose value Send could not carry: missing when required, or outside its limits. */
function fieldsToCheck(fields: readonly QuestionField[], draft: Draft): QuestionField[] {
  return fields.filter((field) => {
    const value = draft[field.key];
    switch (field.kind) {
      case "choice":
        return field.required && value === "";
      case "choices": {
        const chosen = value as string[];
        if (chosen.length === 0) return field.required || (field.minItems ?? 0) > 0;
        return (field.minItems !== undefined && chosen.length < field.minItems) || (field.maxItems !== undefined && chosen.length > field.maxItems);
      }
      case "text":
        return value === "" ? field.required : !textFits(field, value as string);
      case "number":
      case "integer": {
        if (value === "") return field.required;
        const number = Number(value);
        if (!Number.isFinite(number) || (field.kind === "integer" && !Number.isInteger(number))) return true;
        return (field.minimum !== undefined && number < field.minimum) || (field.maximum !== undefined && number > field.maximum);
      }
      default:
        return false;
    }
  });
}

/** The reply's values: what was entered, typed; an empty optional field is left out. */
function valuesOf(fields: readonly QuestionField[], draft: Draft): Record<string, QuestionValue> {
  const values: Record<string, QuestionValue> = {};
  for (const field of fields) {
    const value = draft[field.key];
    if (value === undefined) continue;
    switch (field.kind) {
      case "choice":
      case "text":
        if (value !== "") values[field.key] = value as string;
        break;
      case "choices":
        if ((value as string[]).length > 0) values[field.key] = value as string[];
        break;
      case "number":
      case "integer":
        if (value !== "") values[field.key] = Number(value);
        break;
      case "yes-no":
        values[field.key] = value as boolean;
        break;
      default:
        break;
    }
  }
  return values;
}

const INPUT_TYPES: Record<NonNullable<QuestionField["format"]>, string> = {
  email: "email",
  uri: "url",
  date: "date",
  "date-time": "datetime-local",
};

/** R-438: a question's own free-text answer or note, drawn inside that question after its options. */
type Companion = { field: QuestionField; value: string; onChange: (value: string) => void };

function FieldControl(props: {
  field: QuestionField;
  value: Draft[string] | undefined;
  onChange: (value: Draft[string]) => void;
  t: (key: string) => string;
  companions?: readonly Companion[];
}): ReactElement {
  const { field, t } = props;
  const id = useId();
  const required = field.required ? <span className="agent-question-required"> ({t("conversation.question.required")})</span> : null;
  const hint = field.description === undefined ? null : <span className="agent-question-hint">{field.description}</span>;
  switch (field.kind) {
    case "choice":
    case "choices": {
      const many = field.kind === "choices";
      const chosen = many ? (props.value as string[]) : [props.value as string];
      return (
        <fieldset className="agent-question-field">
          <legend>
            {/* R-438: the agent's short tag for the question, then its words (one question: the tag alone). */}
            {field.chip === undefined ? null : <span className="agent-question-chip">{field.chip}</span>}
            <span className="agent-question-words">
              {field.chip !== undefined && field.label === field.chip ? null : field.label}
              {required}
            </span>
          </legend>
          {hint}
          {(field.options ?? []).map((option) => (
            <label key={option.value} className="agent-question-option">
              <input
                type={many ? "checkbox" : "radio"}
                name={`${id}-${field.key}`}
                value={option.value}
                checked={chosen.includes(option.value)}
                onChange={(event) => {
                  if (!many) props.onChange(option.value);
                  else {
                    const others = chosen.filter((value) => value !== option.value);
                    // The offered order, whatever order the owner ticked them in.
                    const next = event.target.checked ? [...others, option.value] : others;
                    props.onChange((field.options ?? []).map((entry) => entry.value).filter((value) => next.includes(value)));
                  }
                }}
              />
              <span className="agent-question-option-label">{option.label}</span>
              {option.description === undefined ? null : <span className="agent-question-hint">{option.description}</span>}
              {/* The agent's preview of the option (a snippet, a mock-up), as inert text. */}
              {option.preview === undefined ? null : <pre className="agent-question-preview">{option.preview}</pre>}
            </label>
          ))}
          {(props.companions ?? []).map((companion) => (
            <label key={companion.field.key} className="agent-question-other">
              <span>{companion.field.label}</span>
              {/* The agent's hint can be a sentence: said under the label, not cut off in the box. */}
              {companion.field.description === undefined ? null : <span className="agent-question-hint">{companion.field.description}</span>}
              <input
                type={companion.field.secret ? "password" : "text"}
                value={companion.value}
                autoComplete={companion.field.secret ? "off" : undefined}
                {...(companion.field.maxLength !== undefined ? { maxLength: companion.field.maxLength } : {})}
                onChange={(event) => companion.onChange(event.target.value)}
              />
            </label>
          ))}
        </fieldset>
      );
    }
    case "text":
    case "number":
    case "integer": {
      const numeric = field.kind !== "text";
      const type = field.secret ? "password" : numeric ? "number" : field.format === undefined ? "text" : INPUT_TYPES[field.format];
      return (
        <div className="agent-question-field">
          <label htmlFor={id}>{field.label}</label>
          {required}
          {hint}
          <input
            id={id}
            type={type}
            value={props.value as string}
            aria-required={field.required}
            autoComplete={field.secret ? "off" : undefined}
            {...(!numeric && field.maxLength !== undefined ? { maxLength: field.maxLength } : {})}
            {...(numeric && field.minimum !== undefined ? { min: field.minimum } : {})}
            {...(numeric && field.maximum !== undefined ? { max: field.maximum } : {})}
            {...(numeric ? { step: field.kind === "integer" ? 1 : "any" } : {})}
            onChange={(event) => props.onChange(event.target.value)}
          />
        </div>
      );
    }
    case "yes-no":
      return (
        <div className="agent-question-field">
          <label className="agent-question-option">
            <input type="checkbox" checked={props.value === true} onChange={(event) => props.onChange(event.target.checked)} />
            {field.label}
          </label>
          {hint}
        </div>
      );
    default:
      // R-432: a kind the protocol may add later is named, not offered.
      return (
        <div className="agent-question-field" data-unsupported="">
          <span>{field.label}</span>
          {required}
          <span className="agent-question-hint">{t("conversation.question.unsupported")}</span>
        </div>
      );
  }
}

export function QuestionCard(props: {
  question: QuestionEvent;
  agentName: string;
  t: (key: string) => string;
  onReply: (reply: QuestionReply) => void;
}): ReactElement {
  const { question, t } = props;
  const titleId = useId();
  const [draft, setDraft] = useState<Draft>(() => initialDraft(question.fields));
  const [showAll, setShowAll] = useState(false);
  const skipOnly = question.skipOnly === true;
  const toCheck = skipOnly ? [] : fieldsToCheck(question.fields, draft);
  const long = question.message.length > MESSAGE_SHOWN_CHARS && !showAll;
  const message = long ? `${question.message.slice(0, MESSAGE_SHOWN_CHARS)}…` : question.message;
  const agent = () => props.agentName;
  /** The choice fields an answer box joins (R-438); a box naming anything else is drawn on its own. */
  const joined = new Set(question.fields.filter((field) => field.kind === "choice" || field.kind === "choices").map((field) => field.key));
  return (
    <section role="group" aria-labelledby={titleId} className="agent-conversation-permission agent-conversation-question">
      <h3 id={titleId}>{t("conversation.question.title").replace("{agent}", agent)}</h3>
      {question.toolTitle === undefined ? null : (
        <p className="agent-question-during">{t("conversation.question.during").replace("{tool}", () => question.toolTitle!)}</p>
      )}
      {/* The agent's words are inert text, never markup. */}
      <p className="agent-question-message">{message}</p>
      {long ? (
        <button type="button" className="agent-question-show-all" onClick={() => setShowAll(true)}>
          {t("conversation.question.showAll")}
        </button>
      ) : null}
      {skipOnly ? <p>{t("conversation.question.skipOnly")}</p> : null}
      {question.fields.map((field) => {
        if (skipOnly && field.kind !== "unsupported") return null;
        // R-438: a question's own answer box is drawn inside that question, not as a field of its own.
        if (field.otherFor !== undefined && joined.has(field.otherFor)) return null;
        const companions = question.fields
          .filter((other) => other.otherFor === field.key && joined.has(field.key))
          .map((other) => ({
            field: other,
            value: (draft[other.key] as string | undefined) ?? "",
            onChange: (value: string) => setDraft((current) => ({ ...current, [other.key]: value })),
          }));
        return (
          <FieldControl
            key={field.key}
            field={field}
            value={draft[field.key]}
            t={t}
            companions={companions}
            onChange={(value) => setDraft((current) => ({ ...current, [field.key]: value }))}
          />
        );
      })}
      <p className="agent-question-goes-to">{t("conversation.question.goesTo").replace("{agent}", agent)}</p>
      <p>
        {question.waitsMs === undefined
          ? t("conversation.question.waiting")
          : t("conversation.question.waitsFor")
              .replace("{agent}", agent)
              .replace("{seconds}", () => String(Math.round(question.waitsMs! / 1000)))}
      </p>
      {toCheck.length === 0 ? null : (
        <p className="agent-question-check" role="status">
          {t("conversation.question.check").replace("{fields}", () => toCheck.map((field) => field.label).join(", "))}
        </p>
      )}
      <div className="agent-prompt-actions">
        {skipOnly ? null : (
          <button
            type="button"
            className="agent-primary"
            disabled={toCheck.length > 0}
            onClick={() => props.onReply({ action: "accept", values: valuesOf(question.fields, draft) })}
          >
            {t("conversation.question.send")}
          </button>
        )}
        <button type="button" onClick={() => props.onReply({ action: "decline" })}>
          {t("conversation.question.skip")}
        </button>
      </div>
    </section>
  );
}
