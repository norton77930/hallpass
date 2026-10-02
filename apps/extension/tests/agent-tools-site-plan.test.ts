import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { AgentNativeResponse } from "@hallpass/contracts";
import { createAgentPromptController } from "../src/service-worker/agent-tools/prompts.js";
import {
  createAgentSitePlanRunner,
  type AgentSitePlanApproval,
} from "../src/service-worker/agent-tools/site-plan.js";
import { createSitePlanStore, type StorageAreaLike } from "../src/service-worker/site-plan-store.js";

/**
 * 017/T474 — the `propose_sites` runner (FR-249, FR-250, FR-252, FR-260, R-248).
 *
 * The runner is the only place a proposal turns into a question, and the only route from the
 * owner's answer to the plan store. Pinned here: a proposal that breaks a rule is refused before
 * any card, naming the first entry that broke it; an approval writes exactly what the owner left
 * ticked and replaces the plan before it; a decline writes nothing; and `declined` - an outcome a
 * 0.9.0 host's strict enum does not know - leaves the worker from this runner and nowhere else.
 */

const A = "https://a.test";
const B = "https://b.test";
const C = "https://c.test:8443";
const SESSION = "session-sp";

function memoryArea(): StorageAreaLike & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    async get(keys) {
      const out: Record<string, unknown> = {};
      for (const key of keys) if (key in data) out[key] = data[key];
      return out;
    },
    async set(items) {
      Object.assign(data, structuredClone(items));
    },
  };
}

function setup(options: { approve?: (sessionId: string, origins: readonly string[]) => Promise<AgentSitePlanApproval> } = {}) {
  const store = createSitePlanStore({ session: memoryArea() });
  const raised: string[] = [];
  const prompts = createAgentPromptController({
    timeoutMs: 60_000,
    onChange: () => {
      const proposal = prompts.currentSitePlan();
      if (proposal) raised.push(proposal.proposalId);
    },
  });
  const runner = createAgentSitePlanRunner({
    prompts,
    activePlan: async (sessionId) => (await store.forSession(sessionId))?.origins,
    approve:
      options.approve ??
      (async (sessionId, origins) => {
        await store.set(sessionId, origins, "agent-1");
        return { ok: true };
      }),
  });
  let next = 0;
  const propose = (args: Record<string, unknown>): Promise<AgentNativeResponse> => {
    next += 1;
    return runner.run({ callId: `call-${next}`, sessionId: SESSION, tool: "propose_sites", args });
  };
  return { store, prompts, runner, raised, propose };
}

/** The card the call raised, once it is up. */
async function proposal(prompts: ReturnType<typeof createAgentPromptController>) {
  await vi.waitFor(() => expect(prompts.currentSitePlan()).toBeDefined());
  return prompts.currentSitePlan()!;
}

describe("T474 propose_sites refuses a broken proposal before any card (FR-250)", () => {
  const PURPOSE = "Compare the release notes";
  const table: Array<[string, Record<string, unknown>, string]> = [
    ["a non-web scheme", { origins: [A, "ftp://files.test"], purpose: PURPOSE }, "ftp://files.test: only http and https origins are allowed"],
    ["a path", { origins: ["https://a.test/docs"], purpose: PURPOSE }, "https://a.test/docs: must be an exact origin (scheme://host[:port], no path, query or fragment)"],
    ["a trailing slash", { origins: ["https://a.test/"], purpose: PURPOSE }, "https://a.test/: must be an exact origin (scheme://host[:port], no path, query or fragment)"],
    ["a query", { origins: ["https://a.test?q=1"], purpose: PURPOSE }, "https://a.test?q=1: must be an exact origin (scheme://host[:port], no path, query or fragment)"],
    ["a fragment", { origins: ["https://a.test#top"], purpose: PURPOSE }, "https://a.test#top: must be an exact origin (scheme://host[:port], no path, query or fragment)"],
    ["a wildcard", { origins: ["https://*.a.test"], purpose: PURPOSE }, "https://*.a.test: wildcards are not allowed"],
    ["the opaque origin", { origins: [A, "null"], purpose: PURPOSE }, "null: not a URL"],
    ["a duplicate", { origins: [A, B, A], purpose: PURPOSE }, "https://a.test: listed twice"],
    [
      "eleven sites",
      { origins: Array.from({ length: 11 }, (_, i) => `https://s${i}.test`), purpose: PURPOSE },
      "origins: at most 10 entries",
    ],
    ["no sites", { origins: [], purpose: PURPOSE }, "origins: must not be empty"],
    ["an empty purpose", { origins: [A], purpose: "" }, "purpose: must not be empty"],
    ["an unknown key", { origins: [A], purpose: PURPOSE, approve: true }, "arguments: unknown key approve"],
  ];

  it.each(table)("refuses %s, naming the entry and the rule", async (_name, args, hint) => {
    const { prompts, raised, propose, store } = setup();

    const answered = await propose(args);

    expect(answered).toEqual({ callId: "call-1", outcome: "failed", reason: "invalid-arguments", hint });
    expect(raised, "a card was raised for a proposal that broke a rule").toEqual([]);
    expect(prompts.currentSitePlan()).toBeUndefined();
    expect(await store.forSession(SESSION)).toBeUndefined();
  });

  it("names the first offending entry when several break rules", async () => {
    const { propose } = setup();
    const answered = await propose({ origins: [A, "ftp://x.test", "https://y.test/z"], purpose: PURPOSE });
    expect(answered.hint).toBe("ftp://x.test: only http and https origins are allowed");
  });

  it("handles propose_sites and nothing else, and is not a batch step's business", () => {
    const { runner } = setup();
    expect(runner.handles("propose_sites")).toBe(true);
    expect(runner.handles("click")).toBe(false);
    expect(runner.handles("browser_batch")).toBe(false);
  });
});

describe("T474 propose_sites asks once and writes only what the owner approved", () => {
  it("asks with the proposal and answers the approved subset, writing exactly it", async () => {
    const { prompts, propose, store, raised } = setup();

    const answering = propose({ origins: [A, B, C], purpose: "Compare", steps: ["read A", "fill C"] });
    const card = await proposal(prompts);
    expect(card).toMatchObject({ sessionId: SESSION, origins: [A, B, C], purpose: "Compare", steps: ["read A", "fill C"] });
    expect(card.alreadyApproved).toBeUndefined();
    prompts.decideSitePlan(card.proposalId, true, [A, C]);

    expect(await answering).toEqual({ callId: "call-1", outcome: "ok", result: { approved: [A, C], leftOut: [B] } });
    expect((await store.forSession(SESSION))?.origins).toEqual([A, C]);
    expect(raised).toHaveLength(1);
  });

  it("marks the active plan on a new proposal, and replaces the plan on approval (FR-260)", async () => {
    const { prompts, propose, store } = setup();
    await store.set(SESSION, [A, B], "agent-1");

    const answering = propose({ origins: [B, C], purpose: "Next part" });
    const card = await proposal(prompts);
    expect(card.alreadyApproved).toEqual([A, B]);
    prompts.decideSitePlan(card.proposalId, true, [C]);

    expect(await answering).toMatchObject({ outcome: "ok", result: { approved: [C], leftOut: [B] } });
    // Replaced, never merged: A and B are no longer approved.
    expect((await store.forSession(SESSION))?.origins).toEqual([C]);
  });

  it("answers a decline as declined and keeps the plan the session already had", async () => {
    const { prompts, propose, store } = setup();
    await store.set(SESSION, [A], "agent-1");

    const answering = propose({ origins: [B], purpose: "More" });
    prompts.decideSitePlan((await proposal(prompts)).proposalId, false, []);

    expect(await answering).toEqual({ callId: "call-1", outcome: "declined" });
    expect((await store.forSession(SESSION))?.origins).toEqual([A]);
  });

  it("answers an unanswered card as no-answer, and an interrupted one as interrupted, writing nothing", async () => {
    const { prompts, propose, store } = setup();

    const timing = propose({ origins: [A], purpose: "x" });
    await proposal(prompts);
    prompts.cancel("call-1");
    expect(await timing).toEqual({ callId: "call-1", outcome: "timed-out", reason: "no-answer" });

    const interrupted = propose({ origins: [A], purpose: "x" });
    await proposal(prompts);
    prompts.cancelSession(SESSION, "interrupted");
    expect(await interrupted).toEqual({ callId: "call-2", outcome: "stopped", reason: "owner-interrupted" });

    expect(await store.forSession(SESSION)).toBeUndefined();
  });

  it("answers busy while another question is up, raising nothing", async () => {
    const { prompts, propose } = setup();
    void prompts.ask({ callId: "other", sessionId: "s2", site: A, tool: "click", argsSummary: "click" });
    expect(await propose({ origins: [A], purpose: "x" })).toEqual({
      callId: "call-1",
      outcome: "busy",
      reason: "prompt-pending",
    });
  });

  it.each([
    ["site-plan-not-recorded", "site-plan-not-recorded"],
    ["session-ended", "site-plan-session-ended"],
    ["not-paired", "site-plan-not-paired"],
  ] as const)("names an approval that did not land (%s) rather than reporting it granted", async (why, reason) => {
    const { prompts, propose } = setup({ approve: async () => ({ ok: false, reason: why }) });

    const answering = propose({ origins: [A], purpose: "x" });
    prompts.decideSitePlan((await proposal(prompts)).proposalId, true, [A]);

    expect(await answering).toEqual({ callId: "call-1", outcome: "failed", reason });
  });
});

/**
 * A 0.9.0 host parses every answer with a strict outcome enum that has no `declined`; a frame
 * carrying it would be dropped and the agent's call left to its backstop. Such a host never lists
 * `propose_sites` (R-251), so the one runner that answers it is safe - and no other path may.
 */
describe("T475 `declined` leaves the worker from the site-plan runner only", () => {
  it("appears as an emitted outcome in site-plan.ts and in no other worker source", () => {
    const root = fileURLToPath(new URL("../src", import.meta.url));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name)) files.push(path);
      }
    };
    walk(root);
    // An outcome is written as `outcome: "declined"` or passed to an `answer(callId, "declined"…)`.
    const emits = /(outcome\s*:\s*|answer\([^,()]+,\s*)["']declined["']/;
    const emitters = files
      .filter((file) => emits.test(readFileSync(file, "utf8")))
      .map((file) => relative(root, file).replaceAll("\\", "/"));
    expect(emitters).toEqual(["service-worker/agent-tools/site-plan.ts"]);
  });
});
