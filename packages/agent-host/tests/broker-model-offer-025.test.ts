import { conversationModelOfferSchema } from "@hallpass/contracts";
import { describe, expect, it } from "vitest";
import { currentOf, readModelOffer, requestsFor, resolveTarget } from "../src/broker/model-offer.js";

/**
 * 025 T800 - the model offer parser (R-398 - R-400, R-403). Fixtures are invented but shaped like
 * what the four agents answer to `session/new`: Claude-like (session options with a `default`
 * entry), Codex-like (session options without one, plus an older `models` list that must be ignored),
 * DeepSeek-like (grouped options whose values are JSON-string tuples) and Hermes-like (`models`
 * only). No name or value here is any real agent's or owner's.
 */

const select = (id: string, category: string | undefined, currentValue: string, options: unknown[]) => ({
  id,
  name: id,
  ...(category === undefined ? {} : { category }),
  type: "select",
  currentValue,
  options,
});

const claudeLike = {
  sessionId: "s-1",
  modes: { currentModeId: "auto", availableModes: [{ id: "auto", name: "Auto" }] },
  configOptions: [
    select("mode", "mode", "auto", [{ value: "auto", name: "Auto" }]),
    select("model", "model", "beta", [
      { value: "alpha", name: "Alpha 1", description: "Big" },
      { value: "default", name: "Default (recommended)", description: "Small" },
      { value: "beta", name: "Beta 2" },
    ]),
    select("effort", "thought_level", "low", [
      { value: "low", name: "Low" },
      { value: "default", name: "Default" },
      { value: "high", name: "High" },
    ]),
    select("fast", "model_config", "off", [{ value: "off", name: "Off" }]),
  ],
};

const codexLike = {
  sessionId: "s-2",
  configOptions: [
    select("mode", "mode", "read-only", [{ value: "read-only", name: "Read only" }]),
    select("collaboration_mode", "collaboration_mode", "plan", [{ value: "plan", name: "Plan" }]),
    select("model", "model", "orbit-x", [
      { value: "orbit-x", name: "Orbit X" },
      { value: "orbit-y", name: "Orbit Y", description: "Cheaper" },
    ]),
    select("reasoning_effort", "thought_level", "medium", [
      { value: "medium", name: "Medium" },
      { value: "xhigh", name: "Extra high" },
    ]),
    select("fast", "model_config", "off", [{ value: "off", name: "Off" }]),
  ],
  models: {
    currentModelId: "orbit-x[medium]",
    availableModels: [{ modelId: "orbit-x[medium]", name: "Orbit X (medium)" }],
  },
};

const TUPLE_A = '["prov-a","model-x"]';
const TUPLE_B = '["prov-a","model-y"]';
const TUPLE_C = '["prov-b","model-z"]';
const deepseekLike = {
  sessionId: "s-3",
  configOptions: [
    select("model", "model", TUPLE_A, [
      {
        group: "prov-a",
        name: "Prov A",
        options: [
          { value: TUPLE_A, name: "model-x" },
          { value: TUPLE_B, name: "model-y", description: "Own words" },
        ],
      },
      { group: "prov-b", name: "Prov B", options: [{ value: TUPLE_C, name: "model-z" }] },
    ]),
  ],
};

const hermesLike = {
  sessionId: "s-4",
  models: {
    currentModelId: "prov-a:model-x",
    availableModels: [
      { modelId: "prov-a:model-x", name: "Prov A · model-x", description: "Provider: Prov A" },
      { modelId: "prov-a:model-y", name: "Prov A · model-y" },
    ],
  },
};

const valid = (offer: unknown) => conversationModelOfferSchema.safeParse(offer).success;
const values = (list: { value: string }[] | undefined) => (list ?? []).map((entry) => entry.value);

describe("readModelOffer: Claude-like session options (R-398)", () => {
  const offer = readModelOffer(claudeLike)!;

  it("takes the session options as the source and remembers which options to set", () => {
    expect(offer.source).toBe("config");
    expect(offer.configIds).toEqual({ model: "model", effort: "effort" });
    expect(valid(offer)).toBe(true);
  });

  it("lists the agent's default first and names it", () => {
    expect(values(offer.models)).toEqual(["default", "alpha", "beta"]);
    expect(offer.defaultModel).toBe("default");
    expect(values(offer.efforts)).toEqual(["default", "low", "high"]);
    expect(offer.defaultEffort).toBe("default");
  });

  it("keeps the agent's names and descriptions", () => {
    expect(offer.models[0]).toEqual({ value: "default", name: "Default (recommended)", description: "Small" });
    expect(offer.models[2]).toEqual({ value: "beta", name: "Beta 2" });
  });

  it("reads only the model and thought-level options, never mode or the other categories", () => {
    const serialised = JSON.stringify(offer);
    expect(serialised).not.toContain("auto");
    expect(serialised).not.toContain('"fast"');
    expect(serialised).not.toContain("off");
  });

  it("reports the current values", () => {
    expect(currentOf(claudeLike)).toEqual({ model: "beta", effort: "low" });
  });
});

describe("readModelOffer: Codex-like session options win over the older list (R-399)", () => {
  const offer = readModelOffer(codexLike)!;

  it("ignores the models field and every other option, and has no default when none is listed", () => {
    expect(offer.source).toBe("config");
    expect(offer.configIds).toEqual({ model: "model", effort: "reasoning_effort" });
    expect(values(offer.models)).toEqual(["orbit-x", "orbit-y"]);
    expect(values(offer.efforts)).toEqual(["medium", "xhigh"]);
    expect(offer.defaultModel).toBeUndefined();
    expect(offer.defaultEffort).toBeUndefined();
    expect(JSON.stringify(offer)).not.toContain("[medium]");
    expect(valid(offer)).toBe(true);
  });

  it("reads the current values from the options, not from the older list", () => {
    expect(currentOf(codexLike)).toEqual({ model: "orbit-x", effort: "medium" });
  });
});

describe("readModelOffer: DeepSeek-like grouped options", () => {
  const offer = readModelOffer(deepseekLike)!;

  it("flattens the groups in order and passes the tuple values through byte for byte", () => {
    expect(values(offer.models)).toEqual([TUPLE_A, TUPLE_B, TUPLE_C]);
    expect(offer.efforts).toEqual([]);
    expect(offer.configIds).toEqual({ model: "model" });
    expect(valid(offer)).toBe(true);
  });

  it("uses the group's name as the description unless the entry has its own", () => {
    expect(offer.models.map((entry) => entry.description)).toEqual(["Prov A", "Own words", "Prov B"]);
  });

  it("reports the current tuple as it came", () => {
    expect(currentOf(deepseekLike)).toEqual({ model: TUPLE_A });
  });

  it("falls back to the group's id when the group has no name", () => {
    const answer = { configOptions: [select("model", "model", "m", [{ group: "prov-q", options: [{ value: "m", name: "M" }] }])] };
    expect(readModelOffer(answer)?.models).toEqual([{ value: "m", name: "M", description: "prov-q" }]);
  });
});

describe("readModelOffer: Hermes-like older list (R-399)", () => {
  const offer = readModelOffer(hermesLike)!;

  it("takes the models list as the source, with no effort and no option ids", () => {
    expect(offer.source).toBe("models");
    expect(offer.configIds).toBeUndefined();
    expect(offer.efforts).toEqual([]);
    expect(offer.models).toEqual([
      { value: "prov-a:model-x", name: "Prov A · model-x", description: "Provider: Prov A" },
      { value: "prov-a:model-y", name: "Prov A · model-y" },
    ]);
    expect(valid(offer)).toBe(true);
  });

  it("reports the current model id", () => {
    expect(currentOf(hermesLike)).toEqual({ model: "prov-a:model-x" });
  });

  it("lists a model named default first", () => {
    const answer = { models: { currentModelId: "b", availableModels: [{ modelId: "b", name: "B" }, { modelId: "default", name: "Default" }] } };
    const read = readModelOffer(answer)!;
    expect(values(read.models)).toEqual(["default", "b"]);
    expect(read.defaultModel).toBe("default");
  });
});

describe("readModelOffer: what is read and what is not (FR-399)", () => {
  it("skips boolean options and uncategorised ones, and takes the first select of each category", () => {
    const answer = {
      configOptions: [
        { id: "flag", name: "Flag", category: "model", type: "boolean", currentValue: true },
        select("loose", undefined, "x", [{ value: "x", name: "X" }]),
        select("first", "model", "a", [{ value: "a", name: "A" }]),
        select("second", "model", "b", [{ value: "b", name: "B" }]),
        select("think1", "thought_level", "p", [{ value: "p", name: "P" }]),
        select("think2", "thought_level", "q", [{ value: "q", name: "Q" }]),
      ],
    };
    const offer = readModelOffer(answer)!;
    expect(offer.configIds).toEqual({ model: "first", effort: "think1" });
    expect(values(offer.models)).toEqual(["a"]);
    expect(values(offer.efforts)).toEqual(["p"]);
    expect(currentOf(answer)).toEqual({ model: "a", effort: "p" });
  });

  it("offers no effort when only the model option is there, and sets no effort id", () => {
    const offer = readModelOffer({ configOptions: [select("model", "model", "a", [{ value: "a", name: "A" }])] })!;
    expect(offer.configIds).toEqual({ model: "model" });
    expect(offer.efforts).toEqual([]);
    expect(offer.defaultEffort).toBeUndefined();
  });

  it("lets the session options win even when they list nothing usable", () => {
    const answer = {
      configOptions: [select("model", "model", "a", [{ value: "", name: "Empty" }])],
      models: { currentModelId: "z", availableModels: [{ modelId: "z", name: "Z" }] },
    };
    const offer = readModelOffer(answer)!;
    expect(offer.source).toBe("config");
    expect(offer.models).toEqual([]);
    expect(valid(offer)).toBe(true);
  });
});

describe("readModelOffer: bounds and bad entries (R-400)", () => {
  const option = (options: unknown[]) => ({ configOptions: [select("model", "model", "a", options)] });

  it("drops entries whose value is not a string of 1 to 512 characters", () => {
    const offer = readModelOffer(
      option([
        { value: "", name: "Empty" },
        { value: 7, name: "Number" },
        { value: null, name: "Null" },
        { name: "Missing" },
        "text",
        null,
        { value: "v".repeat(513), name: "Too long" },
        { value: "v".repeat(512), name: "Longest" },
        { value: "ok", name: "Fine" },
      ]),
    )!;
    expect(values(offer.models)).toEqual(["v".repeat(512), "ok"]);
    expect(valid(offer)).toBe(true);
  });

  it("clips names to 120 and descriptions to 300, and names an entry by its value when it has no name", () => {
    const offer = readModelOffer(
      option([
        { value: "a", name: "n".repeat(500), description: "d".repeat(500) },
        { value: "b" },
        { value: "c", name: "", description: "" },
        { value: "d", name: 5, description: 5 },
      ]),
    )!;
    expect(offer.models[0]).toEqual({ value: "a", name: "n".repeat(120), description: "d".repeat(300) });
    expect(offer.models.slice(1)).toEqual([
      { value: "b", name: "b" },
      { value: "c", name: "c" },
      { value: "d", name: "d" },
    ]);
    expect(valid(offer)).toBe(true);
  });

  it("keeps the first of two entries with the same value", () => {
    const offer = readModelOffer(option([{ value: "a", name: "First" }, { value: "a", name: "Second" }]))!;
    expect(offer.models).toEqual([{ value: "a", name: "First" }]);
  });

  it("keeps at most 64 models and 16 efforts, and the default survives the cut", () => {
    const many = (n: number, last: string) => [...Array.from({ length: n }, (_, i) => ({ value: `v${i}`, name: `N${i}` })), { value: last, name: "Last" }];
    const offer = readModelOffer({
      configOptions: [select("model", "model", "v0", many(70, "default")), select("effort", "thought_level", "v0", many(30, "default"))],
    })!;
    expect(offer.models).toHaveLength(64);
    expect(offer.efforts).toHaveLength(16);
    expect(offer.models[0]?.value).toBe("default");
    expect(offer.efforts[0]?.value).toBe("default");
    expect(offer.defaultModel).toBe("default");
    expect(offer.defaultEffort).toBe("default");
    expect(valid(offer)).toBe(true);
  });

  it("bounds the older list the same way", () => {
    const availableModels = Array.from({ length: 80 }, (_, i) => ({ modelId: `m${i}`, name: `M${i}` }));
    const offer = readModelOffer({ models: { currentModelId: "m0", availableModels } })!;
    expect(offer.models).toHaveLength(64);
    expect(valid(offer)).toBe(true);
  });
});

describe("readModelOffer: garbage never throws (R-400)", () => {
  const none = { source: "models", models: [], efforts: [] };

  it("is undefined only when the answer is not an object", () => {
    for (const input of [undefined, null, 5, "text", true, [], [{ configOptions: [] }]]) {
      expect(readModelOffer(input), String(input)).toBeUndefined();
      expect(currentOf(input), String(input)).toBeUndefined();
    }
  });

  it("reports none for an object with neither source, or with unreadable ones", () => {
    for (const input of [
      {},
      { sessionId: "s" },
      { configOptions: "x" },
      { configOptions: [] },
      { configOptions: [null, 5, "x", [], { category: "model" }, { category: "model", type: "select" }] },
      { configOptions: [{ id: 7, category: "model", type: "select", options: [{ value: "a", name: "A" }] }] },
      { configOptions: [{ id: "model", category: "model", type: "select", options: "x" }] },
      { models: "x" },
      { models: { availableModels: "x" } },
      { models: { availableModels: [] } },
      { models: { availableModels: [null, 5, { modelId: "" }, { name: "No id" }] } },
    ]) {
      expect(readModelOffer(input), JSON.stringify(input)).toEqual(none);
      expect(valid(readModelOffer(input))).toBe(true);
    }
  });

  it("survives an object that throws when read", () => {
    const hostile = {
      get configOptions(): unknown {
        throw new Error("boom");
      },
    };
    expect(() => readModelOffer(hostile)).not.toThrow();
    expect(readModelOffer(hostile)).toEqual(none);
    expect(() => currentOf(hostile)).not.toThrow();
    expect(currentOf(hostile)).toBeUndefined();
  });

  it("has no current model when the agent reported none or something unreadable", () => {
    expect(currentOf({})).toBeUndefined();
    expect(currentOf({ configOptions: [select("model", "model", "", [{ value: "a", name: "A" }])] })).toBeUndefined();
    expect(currentOf({ models: { currentModelId: 5, availableModels: [{ modelId: "a", name: "A" }] } })).toBeUndefined();
    const noEffort = { configOptions: [select("model", "model", "a", [{ value: "a", name: "A" }]), select("effort", "thought_level", "", [{ value: "p", name: "P" }])] };
    expect(currentOf(noEffort)).toEqual({ model: "a" });
  });
});

describe("resolveTarget (R-403, FR-407)", () => {
  const offer = readModelOffer(claudeLike)!;
  const current = { model: "beta", effort: "low" };

  it("sends nothing when nothing was asked for, or the agent already has it", () => {
    expect(resolveTarget(offer, current, undefined)).toEqual({ kind: "none" });
    expect(resolveTarget(offer, current, {})).toEqual({ kind: "none" });
    expect(resolveTarget(offer, current, { model: "beta", effort: "low" })).toEqual({ kind: "none" });
  });

  it("sends only the parts that differ", () => {
    expect(resolveTarget(offer, current, { model: "alpha", effort: "low" })).toEqual({ kind: "send", model: "alpha" });
    expect(resolveTarget(offer, current, { model: "beta", effort: "high" })).toEqual({ kind: "send", effort: "high" });
    expect(resolveTarget(offer, current, { model: "alpha", effort: "high" })).toEqual({ kind: "send", model: "alpha", effort: "high" });
    expect(resolveTarget(offer, current, { effort: "high" })).toEqual({ kind: "send", effort: "high" });
  });

  it("sends the whole choice when the agent has reported nothing", () => {
    expect(resolveTarget(offer, undefined, { model: "alpha", effort: "high" })).toEqual({ kind: "send", model: "alpha", effort: "high" });
  });

  it("calls a model the offer does not list unavailable, whatever the effort", () => {
    expect(resolveTarget(offer, current, { model: "gone" })).toEqual({ kind: "unavailable", model: "gone" });
    expect(resolveTarget(offer, current, { model: "gone", effort: "high" })).toEqual({ kind: "unavailable", model: "gone" });
    expect(resolveTarget({ source: "models", models: [], efforts: [] }, undefined, { model: "any" })).toEqual({ kind: "unavailable", model: "any" });
  });

  it("drops an effort the offer does not list", () => {
    expect(resolveTarget(offer, current, { model: "alpha", effort: "extreme" })).toEqual({ kind: "send", model: "alpha" });
    expect(resolveTarget(offer, current, { effort: "extreme" })).toEqual({ kind: "none" });
    const hermes = readModelOffer(hermesLike)!;
    expect(resolveTarget(hermes, { model: "prov-a:model-x" }, { model: "prov-a:model-x", effort: "high" })).toEqual({ kind: "none" });
  });
});

describe("requestsFor (R-399)", () => {
  it("builds set_config_option for the session options, model first, then effort", () => {
    const offer = readModelOffer(codexLike)!;
    expect(requestsFor(offer, "sess-1", { model: "orbit-y", effort: "xhigh" })).toEqual([
      { method: "session/set_config_option", params: { sessionId: "sess-1", configId: "model", value: "orbit-y" } },
      { method: "session/set_config_option", params: { sessionId: "sess-1", configId: "reasoning_effort", value: "xhigh" } },
    ]);
    expect(requestsFor(offer, "sess-1", { effort: "xhigh" })).toHaveLength(1);
    expect(requestsFor(offer, "sess-1", {})).toEqual([]);
  });

  it("passes a tuple value through untouched", () => {
    const offer = readModelOffer(deepseekLike)!;
    expect(requestsFor(offer, "sess-3", { model: TUPLE_C })).toEqual([
      { method: "session/set_config_option", params: { sessionId: "sess-3", configId: "model", value: TUPLE_C } },
    ]);
  });

  it("sends no effort when the offer has no effort option", () => {
    const offer = readModelOffer(deepseekLike)!;
    expect(requestsFor(offer, "sess-3", { model: TUPLE_B, effort: "high" })).toHaveLength(1);
  });

  it("builds set_model for the older list and never sends an effort", () => {
    const offer = readModelOffer(hermesLike)!;
    expect(requestsFor(offer, "sess-4", { model: "prov-a:model-y", effort: "high" })).toEqual([
      { method: "session/set_model", params: { sessionId: "sess-4", modelId: "prov-a:model-y" } },
    ]);
    expect(requestsFor(offer, "sess-4", { effort: "high" })).toEqual([]);
  });
});
