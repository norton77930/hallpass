import { useId, useState, type KeyboardEvent, type ReactElement } from "react";
import type { QuestionField, QuestionReply, QuestionValue } from "@hallpass/contracts";
import type { QuestionEvent } from "./conversation-log.js";

/**
 * 029 FR-440 - FR-449, R-438, R-439: an agent's form question as a card above the box, drawn the way
 * the agent's own client draws its questions (the owner's screenshots, R-439): one question at a time,
 * its words in a header with "n of total" and arrows; the options as rows, a radio or a box on the
 * left and the description under the words; the question's own answer box as an "Other" row last;
 * Skip, and Next on every page but the last, which has Send (Ctrl+Enter presses either).
 *
 * Like a permission card it has no timer of its own (FR-442) and leaves when the broker says the
 * question closed, which is how a card answered in another panel document leaves this one (FR-445).
 * The broker checks the reply again (R-434); the checks here only keep Send from offering what it
 * would refuse. Nothing is picked for the owner unless the agent gave a default.
 */

/** What each control holds: a number's text as typed, so an empty box stays empty. */
type Draft = Record<string, string | boolean | string[]>;

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

/** `missing`: required and empty (Next waits, nothing is said); `invalid`: a value outside its limits (named). */
type Problem = "missing" | "invalid" | undefined;

function problemOf(field: QuestionField, value: Draft[string] | undefined): Problem {
  switch (field.kind) {
    case "choice":
      return field.required && value === "" ? "missing" : undefined;
    case "choices": {
      const chosen = (value as string[] | undefined) ?? [];
      if (chosen.length === 0) return field.required || (field.minItems ?? 0) > 0 ? "missing" : undefined;
      const outside =
        (field.minItems !== undefined && chosen.length < field.minItems) || (field.maxItems !== undefined && chosen.length > field.maxItems);
      return outside ? "invalid" : undefined;
    }
    case "text":
      if (value === "" || value === undefined) return field.required ? "missing" : undefined;
      return textFits(field, value as string) ? undefined : "invalid";
    case "number":
    case "integer": {
      if (value === "" || value === undefined) return field.required ? "missing" : undefined;
      const number = Number(value);
      if (!Number.isFinite(number) || (field.kind === "integer" && !Number.isInteger(number))) return "invalid";
      const outside = (field.minimum !== undefined && number < field.minimum) || (field.maximum !== undefined && number > field.maximum);
      return outside ? "invalid" : undefined;
    }
    default:
      return undefined;
  }
}

/** One page of the card: a question, and its own answer box when it has one (R-438). */
type Page = { field: QuestionField; companion?: QuestionField };

function pagesOf(fields: readonly QuestionField[]): Page[] {
  const choice = new Set(fields.filter((field) => field.kind === "choice" || field.kind === "choices").map((field) => field.key));
  return fields
    .filter((field) => field.otherFor === undefined || !choice.has(field.otherFor))
    .map((field) => {
      const companion = choice.has(field.key) ? fields.find((other) => other.otherFor === field.key) : undefined;
      return companion === undefined ? { field } : { field, companion };
    });
}

/**
 * The question's own answer is an "Other" row to pick when the question may be left unpicked (Claude
 * Code's question tool); on a question that must be picked it is a note box under the options (Codex).
 */
const otherIsRow = (page: Page): boolean => page.companion !== undefined && !page.field.required;

function pageProblems(page: Page, draft: Draft, otherOn: ReadonlySet<string>): Problem[] {
  const problems: Problem[] = [problemOf(page.field, draft[page.field.key])];
  const companion = page.companion;
  if (companion !== undefined) {
    const text = (draft[companion.key] as string | undefined) ?? "";
    if (otherIsRow(page) && otherOn.has(companion.key)) {
      // "Other" picked: its words are the answer, so they are needed.
      if (problems[0] === "missing") problems[0] = undefined;
      problems.push(text === "" ? "missing" : problemOf({ ...companion, required: true }, text));
    } else if (!otherIsRow(page)) {
      problems.push(problemOf(companion, text));
    }
  }
  return problems;
}

/** The reply's values: what was entered, typed; an empty optional field is left out. */
function valuesOf(pages: readonly Page[], draft: Draft, otherOn: ReadonlySet<string>): Record<string, QuestionValue> {
  const values: Record<string, QuestionValue> = {};
  const put = (field: QuestionField) => {
    const value = draft[field.key];
    if (value === undefined) return;
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
  };
  for (const page of pages) {
    const other = page.companion !== undefined && otherIsRow(page) && otherOn.has(page.companion.key);
    // A single choice answered with "Other" sends only the words; several choices may send both.
    if (!(other && page.field.kind === "choice")) put(page.field);
    if (page.companion !== undefined && (other || !otherIsRow(page))) put(page.companion);
  }
  return values;
}

const INPUT_TYPES: Record<NonNullable<QuestionField["format"]>, string> = {
  email: "email",
  uri: "url",
  date: "date",
  "date-time": "datetime-local",
};

/** The words a page is titled with: the question's, or - when it has only its tag - the message. */
function pageTitle(page: Page, message: string): string {
  const { field } = page;
  return field.chip !== undefined && field.label === field.chip && message !== "" ? message : field.label;
}

type PageProps = {
  page: Page;
  titleId: string;
  draft: Draft;
  otherOn: ReadonlySet<string>;
  t: (key: string) => string;
  setValue: (key: string, value: Draft[string]) => void;
  setOther: (key: string, on: boolean) => void;
};

function OptionRows(props: PageProps): ReactElement {
  const { page, t } = props;
  const { field, companion } = page;
  const many = field.kind === "choices";
  const name = useId();
  const chosen = many ? ((props.draft[field.key] as string[] | undefined) ?? []) : [props.draft[field.key] as string];
  const otherRow = otherIsRow(page) && companion !== undefined;
  const otherPicked = otherRow && props.otherOn.has(companion.key);
  return (
    <div className="agent-question-rows">
      {(field.options ?? []).map((option) => (
        <label key={option.value} className="agent-question-row">
          <input
            type={many ? "checkbox" : "radio"}
            name={name}
            value={option.value}
            checked={chosen.includes(option.value) && !(otherPicked && !many)}
            onChange={(event) => {
              if (!many) {
                props.setValue(field.key, option.value);
                if (companion !== undefined) props.setOther(companion.key, false);
                return;
              }
              const others = chosen.filter((value) => value !== option.value);
              // The offered order, whatever order the owner ticked them in.
              const next = event.target.checked ? [...others, option.value] : others;
              props.setValue(field.key, (field.options ?? []).map((entry) => entry.value).filter((value) => next.includes(value)));
            }}
          />
          <span className="agent-question-row-text">
            <span className="agent-question-row-label">{option.label}</span>
            {option.description === undefined ? null : <span className="agent-question-row-hint">{option.description}</span>}
            {/* The agent's preview of the option (a snippet, a mock-up), as inert text. */}
            {option.preview === undefined ? null : <pre className="agent-question-preview">{option.preview}</pre>}
          </span>
        </label>
      ))}
      {otherRow ? (
        <>
          <label className="agent-question-row">
            <input
              type={many ? "checkbox" : "radio"}
              name={name}
              value=""
              checked={otherPicked}
              onChange={(event) => {
                props.setOther(companion.key, many ? event.target.checked : true);
                if (!many) props.setValue(field.key, "");
              }}
            />
            <span className="agent-question-row-text">
              <span className="agent-question-row-label">{t("conversation.question.other")}</span>
            </span>
          </label>
          {otherPicked ? (
            <input
              className="agent-question-other-box"
              type={companion.secret ? "password" : "text"}
              aria-label={t("conversation.question.other")}
              placeholder={companion.description ?? ""}
              value={(props.draft[companion.key] as string | undefined) ?? ""}
              autoComplete={companion.secret ? "off" : undefined}
              {...(companion.maxLength !== undefined ? { maxLength: companion.maxLength } : {})}
              onChange={(event) => props.setValue(companion.key, event.target.value)}
            />
          ) : null}
        </>
      ) : null}
      {!otherRow && companion !== undefined ? (
        <label className="agent-question-note">
          <span>{companion.label}</span>
          {companion.description === undefined ? null : <span className="agent-question-row-hint">{companion.description}</span>}
          <input
            type={companion.secret ? "password" : "text"}
            value={(props.draft[companion.key] as string | undefined) ?? ""}
            autoComplete={companion.secret ? "off" : undefined}
            {...(companion.maxLength !== undefined ? { maxLength: companion.maxLength } : {})}
            onChange={(event) => props.setValue(companion.key, event.target.value)}
          />
        </label>
      ) : null}
    </div>
  );
}

function PageBody(props: PageProps): ReactElement {
  const { page, t } = props;
  const { field } = page;
  const hint = field.description === undefined ? null : <p className="agent-question-row-hint">{field.description}</p>;
  switch (field.kind) {
    case "choice":
    case "choices":
      return (
        <>
          {hint}
          <OptionRows {...props} />
        </>
      );
    case "text":
    case "number":
    case "integer": {
      const numeric = field.kind !== "text";
      const type = field.secret ? "password" : numeric ? "number" : field.format === undefined ? "text" : INPUT_TYPES[field.format];
      return (
        <div className="agent-question-input">
          {hint}
          <input
            type={type}
            aria-labelledby={props.titleId}
            aria-required={field.required}
            value={(props.draft[field.key] as string | undefined) ?? ""}
            autoComplete={field.secret ? "off" : undefined}
            {...(!numeric && field.maxLength !== undefined ? { maxLength: field.maxLength } : {})}
            {...(numeric && field.minimum !== undefined ? { min: field.minimum } : {})}
            {...(numeric && field.maximum !== undefined ? { max: field.maximum } : {})}
            {...(numeric ? { step: field.kind === "integer" ? 1 : "any" } : {})}
            onChange={(event) => props.setValue(field.key, event.target.value)}
          />
        </div>
      );
    }
    case "yes-no":
      return (
        <div className="agent-question-rows">
          {hint}
          <label className="agent-question-row">
            <input type="checkbox" checked={props.draft[field.key] === true} onChange={(event) => props.setValue(field.key, event.target.checked)} />
            <span className="agent-question-row-text">
              <span className="agent-question-row-label">{field.label}</span>
            </span>
          </label>
        </div>
      );
    default:
      // R-432: a kind the protocol may add later is named, not offered.
      return <p className="agent-question-row-hint">{t("conversation.question.unsupported")}</p>;
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
  const [otherOn, setOtherOn] = useState<ReadonlySet<string>>(() => new Set());
  const [at, setAt] = useState(0);
  const skipOnly = question.skipOnly === true;
  const pages = skipOnly ? [] : pagesOf(question.fields);
  const index = Math.min(at, Math.max(pages.length - 1, 0));
  const page = pages[index];
  const last = index >= pages.length - 1;
  const agent = () => props.agentName;

  const problemsOf = (entry: Page) => pageProblems(entry, draft, otherOn);
  const pageReady = page === undefined || problemsOf(page).every((problem) => problem === undefined);
  const allReady = pages.every((entry) => problemsOf(entry).every((problem) => problem === undefined));
  // A value outside its limits is named; an empty required one only keeps Next waiting. On the last
  // page, a question left unanswered on an earlier page is named too, so Send does not wait unexplained.
  const named = pages.filter((entry, entryIndex) => {
    const problems = problemsOf(entry);
    if (problems.includes("invalid")) return entryIndex === index || last;
    return last && entryIndex !== index && problems.includes("missing");
  });

  const setValue = (key: string, value: Draft[string]) => setDraft((current) => ({ ...current, [key]: value }));
  const setOther = (key: string, on: boolean) =>
    setOtherOn((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const primary = (): void => {
    if (!last) {
      if (pageReady) setAt(index + 1);
      return;
    }
    if (allReady) props.onReply({ action: "accept", values: valuesOf(pages, draft, otherOn) });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !skipOnly) {
      event.preventDefault();
      primary();
    }
  };

  const title = page === undefined ? question.message : pageTitle(page, question.message);
  // An agent's own question tool (its questions carry their tags, R-438) words the message generically
  // ("Please answer the following questions."); its client does not show it, nor does the card. Any
  // other form's message is said above its question.
  const fromQuestionTool = question.fields.some((field) => field.chip !== undefined);
  const showMessage = page !== undefined && question.message !== "" && title !== question.message && !fromQuestionTool;
  return (
    <section
      role="group"
      aria-label={t("conversation.question.title").replace("{agent}", agent)}
      className="agent-conversation-permission agent-conversation-question"
      onKeyDown={onKeyDown}
    >
      <div className="agent-question-head">
        {/* The agent's words are inert text, never markup. */}
        <h3 id={titleId}>{title}</h3>
        {pages.length > 1 ? (
          <div className="agent-question-pager">
            <button type="button" aria-label={t("conversation.question.previous")} disabled={index === 0} onClick={() => setAt(index - 1)}>
              ‹
            </button>
            <span>
              {t("conversation.question.page")
                .replace("{n}", String(index + 1))
                .replace("{total}", String(pages.length))}
            </span>
            <button type="button" aria-label={t("conversation.question.nextPage")} disabled={last} onClick={() => setAt(index + 1)}>
              ›
            </button>
          </div>
        ) : null}
      </div>
      <div className="agent-question-body">
        {showMessage ? <p className="agent-question-message">{question.message}</p> : null}
        {skipOnly ? (
          <>
            <p>{t("conversation.question.skipOnly")}</p>
            {question.fields.map((field) => (
              <p key={field.key} className="agent-question-row-hint">
                {field.label}: {t("conversation.question.unsupported")}
              </p>
            ))}
          </>
        ) : page === undefined ? null : (
          <PageBody key={page.field.key} page={page} titleId={titleId} draft={draft} otherOn={otherOn} t={t} setValue={setValue} setOther={setOther} />
        )}
      </div>
      <div className="agent-question-about">
        <p>
          {t("conversation.question.title").replace("{agent}", agent)}
          {question.toolTitle === undefined ? null : ` · ${t("conversation.question.during").replace("{tool}", () => question.toolTitle!)}`}
        </p>
        <p>{t("conversation.question.goesTo").replace("{agent}", agent)}</p>
        {question.waitsMs === undefined ? null : (
          <p>
            {t("conversation.question.waitsFor")
              .replace("{agent}", agent)
              .replace("{seconds}", () => String(Math.round(question.waitsMs! / 1000)))}
          </p>
        )}
        {named.length === 0 ? null : (
          <p className="agent-question-check" role="status">
            {t("conversation.question.check").replace("{fields}", () => named.map((entry) => entry.field.label).join(", "))}
          </p>
        )}
      </div>
      <div className="agent-question-actions">
        <button type="button" onClick={() => props.onReply({ action: "decline" })}>
          {t("conversation.question.skip")}
        </button>
        {skipOnly ? null : (
          <button type="button" className="agent-primary" disabled={last ? !allReady : !pageReady} onClick={primary}>
            {t(last ? "conversation.question.send" : "conversation.question.next")}
            <kbd aria-hidden="true">Ctrl ⏎</kbd>
          </button>
        )}
      </div>
    </section>
  );
}
