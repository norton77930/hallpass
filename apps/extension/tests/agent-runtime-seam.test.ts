import { afterEach, describe, expect, it } from "vitest";
import { contentRuntimeMessageSchema } from "@hallpass/contracts";
import {
  collectFromActiveTab,
  executeOnActiveTab,
  probeActiveTab,
  resolveOnActiveTab,
} from "../src/service-worker/content-broker.js";
import { TEST_NONCE } from "./helpers/content-frames.js";

/**
 * 003/T009 — R-103's shared seam.
 *
 * The remote caller of 001/002 always means "the tab the user is looking at", so the broker resolves
 * the page from the active tab of the current window. An agent's tab is one it owns, which is very
 * often not the active one, so the seam between the two callers is a single explicit binding: the
 * caller may name its tab, and everything the broker checks afterwards - the leased-tab comparison,
 * the origin, the document epoch, the dispatch fence - is unchanged and still runs.
 *
 * These tests are about *which page the request reaches*, and about the fact that naming a tab buys
 * no authority: a named tab that is not the leased one is refused exactly as an active tab that is
 * not the leased one is.
 */

const ACTIVE_TAB = { id: 1, url: "https://example.test/active" };
const AGENT_TAB = { id: 2, url: "https://example.test/agent" };

type Sent = { tabId: number; type: string; frame: Record<string, unknown> };

/** Two tabs of the same origin, where the agent's tab is deliberately not the active one. */
function installChrome(reply: (type: string) => unknown): Sent[] {
  const sent: Sent[] = [];
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    scripting: { async executeScript() {} },
    tabs: {
      async query() {
        return [ACTIVE_TAB];
      },
      async get(tabId: number) {
        const tab = [ACTIVE_TAB, AGENT_TAB].find((candidate) => candidate.id === tabId);
        if (!tab) throw new Error("no tab with id");
        return tab;
      },
      async sendMessage(tabId: number, message: unknown) {
        const parsed = contentRuntimeMessageSchema.safeParse(message);
        if (!parsed.success) throw new Error("invalid-content-frame");
        sent.push({ tabId, type: parsed.data.type, frame: parsed.data as unknown as Record<string, unknown> });
        return reply(parsed.data.type);
      },
    },
  };
  return sent;
}

const collectInput = {
  taskId: "task-seam",
  operationId: "op-collect",
  runtimeEpochId: "epoch-1",
  nonce: TEST_NONCE,
  requested: ["page.visible-text"],
  generalGrantActive: true,
  generalPageReadGrantId: "grant-1",
  formGrantActive: false,
};

const resolveInput = {
  taskId: "task-seam",
  operationId: "op-resolve",
  runtimeEpochId: "epoch-1",
  nonce: TEST_NONCE,
  expectedTabId: AGENT_TAB.id,
  canonicalOrigin: "https://example.test",
  documentEpoch: "doc-live",
  generalPageReadGrantId: "grant-1",
  description: "search box",
  maxCandidates: 3,
};

const executeInput = {
  taskId: "task-seam",
  operationId: "op-execute",
  runtimeEpochId: "epoch-1",
  nonce: TEST_NONCE,
  capability: "browser.scroll" as const,
  arguments: { mode: "viewport", direction: "down", magnitude: "small" },
  documentEpoch: "doc-live",
  canonicalOrigin: "https://example.test",
  expectedTabId: AGENT_TAB.id,
};

const collectReply = (type: string): unknown =>
  type === "content.probe"
    ? { documentEpoch: "doc-live", canonicalOrigin: "https://example.test" }
    : {
        contextHandle: "snap-1",
        documentEpoch: "doc-live",
        canonicalOrigin: "https://example.test",
        formValueItems: [],
      };

afterEach(() => {
  Reflect.deleteProperty(globalThis, "chrome");
});

describe("agent runtime seam", () => {
  it("collects from the named tab, and from the active tab when no tab is named", async () => {
    const named = installChrome(collectReply);
    const collected = await collectFromActiveTab({ ...collectInput, tab: AGENT_TAB.id });
    expect(collected.tabId).toBe(AGENT_TAB.id);
    expect(named.map((message) => message.tabId)).toEqual([AGENT_TAB.id, AGENT_TAB.id]);
    expect(named.map((message) => message.type)).toEqual(["content.probe", "content.collect-page"]);

    // The remote caller names nothing, so nothing about it changes: it still gets the active tab.
    const active = installChrome(collectReply);
    const fromActive = await collectFromActiveTab(collectInput);
    expect(fromActive.tabId).toBe(ACTIVE_TAB.id);
    expect(active.map((message) => message.tabId)).toEqual([ACTIVE_TAB.id, ACTIVE_TAB.id]);
  });

  it("resolves on the named tab, and refuses when the named tab is not the leased one", async () => {
    const reply = (type: string): unknown =>
      type === "content.probe"
        ? { documentEpoch: "doc-live", canonicalOrigin: "https://example.test" }
        : { ok: true, outcome: "no-match" };

    const named = installChrome(reply);
    expect(await resolveOnActiveTab({ ...resolveInput, tab: AGENT_TAB.id })).toEqual({
      ok: true,
      outcome: "no-match",
    });
    expect(named.map((message) => message.tabId)).toEqual([AGENT_TAB.id, AGENT_TAB.id]);

    // Naming a tab is a binding, not a permission: the leased-tab check still decides.
    const mismatched = installChrome(reply);
    expect(await resolveOnActiveTab({ ...resolveInput, tab: ACTIVE_TAB.id })).toEqual({
      ok: false,
      reason: "stale-context",
    });
    expect(mismatched).toEqual([]);
  });

  it("executes on the named tab, and refuses a named tab that is not the leased one", async () => {
    const reply = (type: string): unknown =>
      type === "content.probe"
        ? { documentEpoch: "doc-live", canonicalOrigin: "https://example.test" }
        : { ok: true, effect: "scrolled", scrollTop: 80, targetVisibility: "not-applicable" };

    const named = installChrome(reply);
    expect(await executeOnActiveTab({ ...executeInput, tab: AGENT_TAB.id })).toMatchObject({
      ok: true,
      effect: "scrolled",
    });
    expect(named.map((message) => message.tabId)).toEqual([AGENT_TAB.id, AGENT_TAB.id]);

    // The guard names the mismatch, and nothing reached any page.
    const mismatched = installChrome(reply);
    expect(await executeOnActiveTab({ ...executeInput, tab: ACTIVE_TAB.id })).toEqual({
      ok: false,
      reachedPage: false,
      reason: "stale-context",
    });
    expect(mismatched).toEqual([]);
  });

  /**
   * 003/US3 decision 3. The remote path never asks for the agent's policy.
   *
   * `policy` is a field on the effect frame, and the archived caller has no way to set it: it never
   * passes one, so the schema's default is what the page reads. That is the whole guarantee - the
   * runtime's classification refusals for the remote service are exactly as they were, and only a
   * caller that names `trusted-agent` explicitly gets anything else.
   */
  it("sends the archived path's effects as classified, and names trusted-agent only when asked", async () => {
    const reply = (type: string): unknown =>
      type === "content.probe"
        ? { documentEpoch: "doc-live", canonicalOrigin: "https://example.test" }
        : { ok: true, effect: "scrolled", scrollTop: 80, targetVisibility: "not-applicable" };

    const remote = installChrome(reply);
    await executeOnActiveTab({ ...executeInput, expectedTabId: ACTIVE_TAB.id });
    expect(remote.find((message) => message.type === "content.execute-action")?.frame.policy).toBe(
      "classified",
    );

    const agent = installChrome(reply);
    await executeOnActiveTab({ ...executeInput, tab: AGENT_TAB.id, policy: "trusted-agent" });
    expect(agent.find((message) => message.type === "content.execute-action")?.frame.policy).toBe(
      "trusted-agent",
    );
  });

  /**
   * M2 review A8. Post-effect verification is the evidence FR-040 requires, and it runs on the tab
   * the effect ran on. Without the binding it read the active tab, so verifying an agent's effect on
   * a background tab reported `stale-context` and turned every observed effect into an unverified
   * one - the exact claim the rule exists to protect.
   */
  it("probes the named tab after an effect, and refuses a named tab that is not the leased one", async () => {
    const probeInput = {
      taskId: "task-seam",
      operationId: "verify-op",
      runtimeEpochId: "epoch-1",
      nonce: TEST_NONCE,
      expectedTabId: AGENT_TAB.id,
      canonicalOrigin: "https://example.test",
    };
    const reply = (): unknown => ({ documentEpoch: "doc-live", canonicalOrigin: "https://example.test" });

    const named = installChrome(reply);
    expect(await probeActiveTab({ ...probeInput, tab: AGENT_TAB.id })).toEqual({
      ok: true,
      documentEpoch: "doc-live",
      canonicalOrigin: "https://example.test",
    });
    expect(named.map((message) => message.tabId)).toEqual([AGENT_TAB.id]);

    const mismatched = installChrome(reply);
    expect(await probeActiveTab({ ...probeInput, tab: ACTIVE_TAB.id })).toEqual({
      ok: false,
      reason: "stale-context",
    });
    expect(mismatched).toEqual([]);
  });
});
