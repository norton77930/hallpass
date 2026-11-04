import { describe, expect, it } from "vitest";
import { questionFieldSchema, QUESTION_MAX_FIELDS, QUESTION_MAX_OPTIONS, QUESTION_SUMMARY_MAX_CHARS } from "@hallpass/contracts";
import { checkReply, questionFromRequest, summarize, type FormRequest } from "../src/broker/questions.js";

/** 029 T866, T867: the protocol's form schema as card fields (R-432, R-433), the reply check (R-434), the summary (R-436). */

const form = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}): FormRequest =>
  ({ sessionId: "s-1", mode: "form", message: "Pick", requestedSchema: { type: "object", properties, ...extra } }) as FormRequest;

const KINDS = form(
  {
    colour: { type: "string", title: "Colour", oneOf: [{ const: "red", title: "Red" }, { const: "blue", title: "Blue", description: "The calm one" }] },
    size: { type: "string", enum: ["S", "M"] },
    toppings: { type: "array", title: "Toppings", minItems: 1, maxItems: 2, items: { anyOf: [{ const: "ham", title: "Ham" }, { const: "olive", title: "Olive" }] } },
    flavours: { type: "array", items: { enum: ["a", "b"] }, default: ["a"] },
    note: { type: "string", title: "Note", description: "Anything", maxLength: 5, minLength: 1, pattern: "^[a-z]+$" },
    email: { type: "string", format: "email" },
    count: { type: "integer", minimum: 1, maximum: 9, default: 2 },
    price: { type: "number", maximum: 10 },
    ok: { type: "boolean", title: "Deliver", default: true },
  },
  { required: ["colour"] },
);

describe("029 questionFromRequest (R-432)", () => {
  it("maps each kind with labels, descriptions, options, limits, defaults and required, in order", () => {
    const question = questionFromRequest(KINDS);
    expect(question.message).toBe("Pick");
    expect(question.skipOnly).toBeUndefined();
    expect(question.fields.map((field) => [field.key, field.kind])).toEqual([
      ["colour", "choice"],
      ["size", "choice"],
      ["toppings", "choices"],
      ["flavours", "choices"],
      ["note", "text"],
      ["email", "text"],
      ["count", "integer"],
      ["price", "number"],
      ["ok", "yes-no"],
    ]);
    const [colour, size, toppings, flavours, note, email, count, price, ok] = question.fields;
    expect(colour).toEqual({
      key: "colour",
      kind: "choice",
      label: "Colour",
      required: true,
      options: [{ value: "red", label: "Red" }, { value: "blue", label: "Blue", description: "The calm one" }],
    });
    expect(size).toMatchObject({ label: "size", required: false, options: [{ value: "S", label: "S" }, { value: "M", label: "M" }] });
    expect(toppings).toMatchObject({ minItems: 1, maxItems: 2, options: [{ value: "ham", label: "Ham" }, { value: "olive", label: "Olive" }] });
    expect(flavours).toMatchObject({ default: ["a"] });
    expect(note).toMatchObject({ description: "Anything", minLength: 1, maxLength: 5, pattern: "^[a-z]+$" });
    expect(email).toMatchObject({ format: "email" });
    expect(count).toMatchObject({ minimum: 1, maximum: 9, default: 2 });
    expect(price).toMatchObject({ maximum: 10 });
    expect(ok).toMatchObject({ label: "Deliver", default: true });
    for (const field of question.fields) expect(questionFieldSchema.safeParse(field).success, field.key).toBe(true);
  });

  it("marks a field the protocol does not define as unsupported, and drops a default of the wrong kind", () => {
    const question = questionFromRequest(form({ when: { type: "object" }, colour: { type: "string", enum: ["red"], default: "green" } }));
    expect(question.fields[0]).toMatchObject({ key: "when", kind: "unsupported", required: false });
    expect(question.fields[1]?.default).toBeUndefined();
    expect(question.skipOnly).toBeUndefined();
  });

  it("is skip-only with no showable field, with a required unsupported field, or over a bound", () => {
    expect(questionFromRequest(form({})).skipOnly).toBe(true);
    expect(questionFromRequest(form({ when: { type: "object" } })).skipOnly).toBe(true);
    expect(questionFromRequest(form({ when: { type: "object" }, a: { type: "string" } }, { required: ["when"] })).skipOnly).toBe(true);
    const many = Object.fromEntries(Array.from({ length: QUESTION_MAX_FIELDS + 1 }, (_unused, index) => [`q${index}`, { type: "string" }]));
    const big = questionFromRequest(form(many));
    expect(big).toMatchObject({ skipOnly: true, fields: [] });
    const options = Array.from({ length: QUESTION_MAX_OPTIONS + 1 }, (_unused, index) => `${index}`);
    expect(questionFromRequest(form({ a: { type: "string", enum: options } })).skipOnly).toBe(true);
    expect(questionFromRequest(form({ a: { type: "string", title: "x".repeat(1001) } })).skipOnly).toBe(true);
    expect(questionFromRequest(form({ a: { type: "string", title: "x".repeat(1000) } })).skipOnly).toBeUndefined();
    const long = questionFromRequest({ ...form({ a: { type: "string" } }), message: "m".repeat(5000) });
    expect(long.skipOnly).toBe(true);
    expect(long.message).toHaveLength(4000);
  });

  it("treats a pattern that does not compile as an unsupported field", () => {
    expect(questionFromRequest(form({ a: { type: "string", pattern: "([" } })).fields[0]?.kind).toBe("unsupported");
  });

  it("R-433: a field marked _meta.codex.isSecret is secret; R-429: _meta.codex.autoResolutionMs is the agent's waiting time", () => {
    const request = {
      ...form({ token: { type: "string", title: "API token", _meta: { codex: { isSecret: true } } }, plain: { type: "string", _meta: { codex: { isSecret: false } } } }),
      _meta: { codex: { autoResolutionMs: 60_000 } },
    } as FormRequest;
    const question = questionFromRequest(request);
    expect(question.fields[0]?.secret).toBe(true);
    expect(question.fields[1]?.secret).toBeUndefined();
    expect(question.waitsMs).toBe(60_000);
    expect(questionFromRequest(form({ a: { type: "string" } })).waitsMs).toBeUndefined();
  });
});

describe("029 checkReply (R-434)", () => {
  const fields = questionFromRequest(KINDS).fields;
  const ok = (values: Record<string, unknown>) => checkReply(fields, values as never);

  it("accepts values of each kind and sends exactly them, leaving out empty optional text", () => {
    const values = { colour: "blue", size: "S", toppings: ["ham"], note: "abc", email: "a@b.test", count: 3, price: 9.5, ok: false, flavours: [] };
    expect(ok(values)).toEqual({ ok: true, content: values });
    expect(ok({ colour: "red", note: "" })).toEqual({ ok: true, content: { colour: "red" } });
  });

  it("refuses an unknown key, a wrong type, a value not offered, a missing required field and each limit", () => {
    for (const bad of [
      { colour: "red", extra: "x" },
      { colour: 1 },
      { colour: "green" },
      {},
      { colour: "" },
      { colour: "red", toppings: [] },
      { colour: "red", toppings: ["ham", "olive", "ham"] },
      { colour: "red", toppings: ["ham", "ham"] },
      { colour: "red", toppings: ["bacon"] },
      { colour: "red", note: "toolong" },
      { colour: "red", note: "ABC" },
      { colour: "red", email: "not-an-email" },
      { colour: "red", count: 2.5 },
      { colour: "red", count: 10 },
      { colour: "red", price: 11 },
      { colour: "red", ok: "yes" },
    ]) {
      expect(ok(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("refuses a value for an unsupported field", () => {
    const unsupported = questionFromRequest(form({ when: { type: "object" }, a: { type: "string" } })).fields;
    expect(checkReply(unsupported, { when: "x" }).ok).toBe(false);
    expect(checkReply(unsupported, { a: "x" })).toEqual({ ok: true, content: { a: "x" } });
  });

  it("checks uri, date and date-time formats", () => {
    const formats = questionFromRequest(form({ u: { type: "string", format: "uri" }, d: { type: "string", format: "date" }, t: { type: "string", format: "date-time" } })).fields;
    expect(checkReply(formats, { u: "https://example.test/x", d: "2026-11-04", t: "2026-11-04T10:00:00Z" }).ok).toBe(true);
    for (const bad of [{ u: "not a uri" }, { d: "04/11/2026" }, { t: "tomorrow" }]) expect(checkReply(formats, bad).ok, JSON.stringify(bad)).toBe(false);
  });
});

describe("029 summarize (R-436)", () => {
  it("names choices by their labels, joins several, marks yes / no, hides secrets, and keeps the field order", () => {
    const fields = questionFromRequest(
      form({
        colour: { type: "string", title: "Colour", oneOf: [{ const: "blue", title: "Blue" }] },
        toppings: { type: "array", title: "Toppings", items: { anyOf: [{ const: "ham", title: "Ham" }, { const: "olive", title: "Olive" }] } },
        ok: { type: "boolean", title: "Deliver" },
        token: { type: "string", title: "API token", _meta: { codex: { isSecret: true } } },
        count: { type: "integer", title: "Count" },
        note: { type: "string", title: "Note" },
      }),
    ).fields;
    expect(summarize(fields, { note: "hi", token: "s3cret-value", ok: true, toppings: ["ham", "olive"], colour: "blue", count: 2 })).toBe(
      "Colour: Blue; Toppings: Ham, Olive; Deliver: ✓; API token: ••••••; Count: 2; Note: hi",
    );
    expect(summarize(fields, { ok: false })).toBe("Deliver: ✗");
  });

  it("is clipped at the summary bound and never holds a secret's value", () => {
    const fields = questionFromRequest(form({ a: { type: "string", title: "A" }, token: { type: "string", _meta: { codex: { isSecret: true } } } })).fields;
    const summary = summarize(fields, { a: "x".repeat(1000), token: "s3cret-value" });
    expect(summary.length).toBeLessThanOrEqual(QUESTION_SUMMARY_MAX_CHARS);
    expect(summary).not.toContain("s3cret");
  });
});

/**
 * R-438: the hints the tested adapters put beside a question. Claude Code's question tool: each
 * question's short tag as the field title and its words as the description (a single question's
 * words are the message), an option preview under `_meta["_claude/askUserQuestionOption"]`, and a
 * free-text field per question marked `_meta._askUserQuestionCustomAnswer.questionId`. Codex's
 * user-input request: the words as the title and the tag as the description, under `_meta.codex`,
 * and a note field marked `_meta.codex.role: "user_note"` with its `questionId`.
 */
describe("029 the adapters' display hints (R-438)", () => {
  it("Claude Code: the tag becomes the chip, the words the label, the preview stays with its option, the Other box joins its question", () => {
    const question = questionFromRequest(
      form({
        question_0: {
          type: "string",
          title: "Auth",
          description: "Which auth method should we use?",
          oneOf: [
            { const: "OAuth", title: "OAuth", description: "Sign in with a browser", _meta: { "_claude/askUserQuestionOption": { preview: "login()" } } },
            { const: "API key", title: "API key" },
          ],
        },
        question_0_custom: {
          type: "string",
          title: "Other",
          description: "Type your own answer, or add a note to the option you chose above (optional).",
          _meta: { _askUserQuestionCustomAnswer: { questionId: "question_0", isCustomAnswer: true } },
        },
        question_1: { type: "array", title: "Features", description: "Which features?", items: { anyOf: [{ const: "Search", title: "Search" }] } },
        question_1_custom: { type: "string", title: "Other", _meta: { _askUserQuestionCustomAnswer: { questionId: "question_1", isCustomAnswer: true } } },
      }),
    );
    const [auth, authOther, features, featuresOther] = question.fields;
    expect(auth).toMatchObject({ kind: "choice", chip: "Auth", label: "Which auth method should we use?" });
    expect(auth?.description).toBeUndefined();
    expect(auth?.options?.[0]).toEqual({ value: "OAuth", label: "OAuth", description: "Sign in with a browser", preview: "login()" });
    expect(authOther).toMatchObject({ kind: "text", label: "Other", otherFor: "question_0" });
    expect(authOther?.description).toMatch(/^Type your own answer/u);
    expect(features).toMatchObject({ kind: "choices", chip: "Features", label: "Which features?" });
    expect(featuresOther).toMatchObject({ otherFor: "question_1" });
  });

  it("Claude Code, one question: the tag is the chip and the label; the words stay in the message", () => {
    const question = questionFromRequest(
      form({
        question_0: { type: "string", title: "Auth", oneOf: [{ const: "OAuth", title: "OAuth" }] },
        question_0_custom: { type: "string", title: "Other", _meta: { _askUserQuestionCustomAnswer: { questionId: "question_0" } } },
      }),
    );
    expect(question.fields[0]).toMatchObject({ chip: "Auth", label: "Auth" });
  });

  it("Codex: the words are the label, the tag the chip, and the note joins its question", () => {
    const question = questionFromRequest(
      form(
        {
          scope: {
            type: "string",
            title: "Which scope should the token have?",
            description: "Scope",
            oneOf: [
              { const: "repo", title: "repo" },
              { const: "None of the above", title: "None of the above", description: "Provide a different answer in the note field." },
            ],
            _meta: { codex: { isOther: true, isSecret: false } },
          },
          scope_note: { type: "string", title: "Additional answer or note", _meta: { codex: { questionId: "scope", role: "user_note", isSecret: false } } },
          name: { type: "string", title: "What should it be called?", description: "Name", _meta: { codex: { isOther: false, isSecret: false } } },
        },
        { required: ["scope", "name"] },
      ),
    );
    const [scope, note, name] = question.fields;
    expect(scope).toMatchObject({ kind: "choice", label: "Which scope should the token have?", chip: "Scope", required: true });
    expect(scope?.description).toBeUndefined();
    expect(note).toMatchObject({ kind: "text", otherFor: "scope", required: false });
    expect(name).toMatchObject({ kind: "text", label: "What should it be called?", chip: "Name" });
  });

  it("a marker naming no choice field of the form joins nothing", () => {
    const question = questionFromRequest(
      form({
        a: { type: "string", title: "A" },
        a_custom: { type: "string", _meta: { _askUserQuestionCustomAnswer: { questionId: "a" } } },
        b_custom: { type: "string", _meta: { _askUserQuestionCustomAnswer: { questionId: "missing" } } },
      }),
    );
    expect(question.fields.map((field) => field.otherFor)).toEqual([undefined, undefined, undefined]);
    expect(question.fields[0]?.chip).toBeUndefined();
  });
});
