import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ElicitRequestSchema,
  type ClientCapabilities,
  type ElicitRequest,
  type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  TERMINAL_CONSENT_FEATURE,
  type PromptAnswerFrame,
  type PromptChoice,
  type PromptRaisedFrame,
} from "@hallpass/contracts";
import {
  clientCanBeAsked,
  createTerminalConsent,
  ELICITATION_MARGIN_MS,
  type TerminalConsent,
} from "../src/terminal-consent.js";

/**
 * 031/T918 (R-450..R-453, contracts/terminal-consent.md) - the host as one more place a consent
 * answer can come from.
 *
 * A real SDK client and a real SDK server over an in-memory pair, so what is pinned is the request
 * an actual MCP client receives and what the host does with every way that client can reply. The
 * worker is a fake route: its advertised features and the frames sent back to it. The rule under
 * test is R-452's - only `accept` with one of the offered choices is an answer; everything else
 * sends nothing, so the card keeps waiting.
 */

const SESSION = "s-1";

type ElicitHandler = (request: ElicitRequest, signal: AbortSignal) => Promise<ElicitResult> | ElicitResult;

type Harness = {
  consent: TerminalConsent;
  server: Server;
  requestSpy: ReturnType<typeof vi.spyOn>;
  asked: ElicitRequest["params"][];
  sent: PromptAnswerFrame[];
  features: Set<string>;
  route: { features: () => ReadonlySet<string>; send: (frame: PromptAnswerFrame) => boolean };
  logs: string[];
};

const open: Array<{ client: Client; server: Server }> = [];

async function harness(capabilities: ClientCapabilities, handler?: ElicitHandler): Promise<Harness> {
  const server = new Server({ name: "hallpass-test", version: "0.0.0" }, { capabilities: {} });
  const client = new Client({ name: "elicitation-client", version: "0.0.0" }, { capabilities });
  const asked: ElicitRequest["params"][] = [];
  if (capabilities.elicitation !== undefined) {
    client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
      asked.push(request.params);
      return (handler ?? (() => ({ action: "cancel" })))(request, extra.signal);
    });
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  open.push({ client, server });
  // SDK 1.32.2's `_oncancel` returns early on a falsy `requestId`, so a cancellation of the server's
  // very first request (id 0) never reaches the client's handler. A real session's first request is
  // usually `roots/list`; a ping stands in for it so the cancel assertions see what a client sees.
  await server.ping();
  const requestSpy = vi.spyOn(server, "request");
  const sent: PromptAnswerFrame[] = [];
  const features = new Set<string>([TERMINAL_CONSENT_FEATURE]);
  const logs: string[] = [];
  const consent = createTerminalConsent({
    sessionId: SESSION,
    server,
    agentLabel: () => "Claude Code (hallpass)",
    log: (code, detail) => logs.push(detail === undefined ? code : `${code} ${detail}`),
  });
  const route = {
    features: () => features,
    send: (frame: PromptAnswerFrame): boolean => {
      sent.push(frame);
      return true;
    },
  };
  return { consent, server, requestSpy, asked, sent, features, route, logs };
}

afterEach(async () => {
  for (const { client, server } of open.splice(0)) {
    await client.close();
    await server.close();
  }
  vi.restoreAllMocks();
});

function raised(overrides: Partial<PromptRaisedFrame> = {}): PromptRaisedFrame {
  return {
    type: "prompt-raised",
    sessionId: SESSION,
    callId: "c-1",
    promptId: "p-1",
    kind: "effect",
    site: "https://shop.example.test",
    action: "click the Place order button",
    choices: ["once", "session", "deny"],
    boundMs: 120_000,
    ...overrides,
  };
}

function accept(choice: unknown): ElicitResult {
  return { action: "accept", content: { choice } } as ElicitResult;
}

describe("which clients are asked (R-451)", () => {
  it("asks a client that advertised form elicitation, or a bare elicitation object", () => {
    expect(clientCanBeAsked({ elicitation: { form: {} } })).toBe(true);
    expect(clientCanBeAsked({ elicitation: { form: {}, url: {} } })).toBe(true);
    // The pre-modes shape: a bare object means form, for backward compatibility.
    expect(clientCanBeAsked({ elicitation: {} })).toBe(true);
  });

  it("does not ask a client that advertised no elicitation, or url mode alone", () => {
    expect(clientCanBeAsked(undefined)).toBe(false);
    expect(clientCanBeAsked({})).toBe(false);
    expect(clientCanBeAsked({ roots: {} })).toBe(false);
    expect(clientCanBeAsked({ elicitation: { url: {} } })).toBe(false);
  });
});

describe.each([
  ["form", { elicitation: { form: {} } }],
  ["bare", { elicitation: {} }],
] as Array<[string, ClientCapabilities]>)("a client advertising %s elicitation", (_name, capabilities) => {
  it("is sent one elicitation/create whose choice enum is exactly the frame's choices", async () => {
    const h = await harness(capabilities, () => accept("once"));

    await expect(h.consent.raised(raised(), h.route)).resolves.toBe("answered");

    expect(h.asked).toHaveLength(1);
    const params = h.asked[0]! as Extract<ElicitRequest["params"], { requestedSchema: unknown }>;
    expect(params.message).toBe(
      "Hallpass: allow Claude Code (hallpass) to click the Place order button on https://shop.example.test?",
    );
    expect(params.requestedSchema).toEqual({
      type: "object",
      properties: {
        choice: expect.objectContaining({
          type: "string",
          enum: ["once", "session", "deny"],
          enumNames: ["Allow once", "Allow on this site for this session", "Deny"],
        }),
      },
      required: ["choice"],
    });
    // The low-level request with the SDK's own result schema, the timeout just under the bound.
    expect(h.requestSpy).toHaveBeenCalledTimes(1);
    const [request, , options] = h.requestSpy.mock.calls[0]! as [
      { method: string },
      unknown,
      { timeout: number; signal: AbortSignal },
    ];
    expect(request.method).toBe("elicitation/create");
    expect(options.timeout).toBe(120_000 - ELICITATION_MARGIN_MS);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it.each(["once", "session", "deny"] as PromptChoice[])("sends prompt-answer for accept + %s", async (choice) => {
    const h = await harness(capabilities, () => accept(choice));

    await expect(h.consent.raised(raised(), h.route)).resolves.toBe("answered");

    expect(h.sent).toEqual([{ type: "prompt-answer", sessionId: SESSION, callId: "c-1", promptId: "p-1", choice }]);
  });
});

describe("a result that is not the owner's choice sends nothing (R-452, D-031-5)", () => {
  const capabilities: ClientCapabilities = { elicitation: { form: {} } };

  it.each<[string, ElicitHandler]>([
    ["decline", () => ({ action: "decline" })],
    ["cancel", () => ({ action: "cancel" })],
    ["accept with no content", () => ({ action: "accept" })],
    ["accept with a choice that is not a string", () => accept(3)],
    ["accept with a choice nobody offered", () => accept("always")],
    ["accept with the choice under another key", () => ({ action: "accept", content: { answer: "once" } })],
    ["a result outside the SDK's schema", () => ({ action: "maybe" }) as unknown as ElicitResult],
    [
      "a thrown error",
      () => {
        throw new Error("the client could not show the form");
      },
    ],
  ])("%s", async (_name, handler) => {
    const h = await harness(capabilities, handler);

    await expect(h.consent.raised(raised(), h.route)).resolves.toBe("no-answer");

    expect(h.asked).toHaveLength(1);
    expect(h.sent).toEqual([]);
  });

  it("never offers session when the frame did not, and refuses it if a client sends it anyway", async () => {
    const h = await harness(capabilities, () => accept("session"));

    await expect(h.consent.raised(raised({ choices: ["once", "deny"] }), h.route)).resolves.toBe("no-answer");

    const params = h.asked[0]! as Extract<ElicitRequest["params"], { requestedSchema: unknown }>;
    const field = params.requestedSchema.properties.choice as { enum: string[]; enumNames: string[] };
    expect(field.enum).toEqual(["once", "deny"]);
    expect(field.enumNames).toEqual(["Allow once", "Deny"]);
    expect(h.sent).toEqual([]);
  });

  it("gives up just under the bound when the client never answers", async () => {
    let clientSawCancel = false;
    const h = await harness(capabilities, (_request, signal) =>
      new Promise<ElicitResult>((resolve) => {
        signal.addEventListener("abort", () => {
          clientSawCancel = true;
          // A client that answers after the host gave up is still not heard.
          resolve(accept("once"));
        });
      }),
    );

    await expect(h.consent.raised(raised({ boundMs: ELICITATION_MARGIN_MS + 50 }), h.route)).resolves.toBe(
      "no-answer",
    );

    expect(h.sent).toEqual([]);
    await vi.waitFor(() => expect(clientSawCancel).toBe(true));
  });
});

describe("the request ends with the question (R-453)", () => {
  const capabilities: ClientCapabilities = { elicitation: { form: {} } };

  function heldOpen(): { handler: ElicitHandler; release: (result: ElicitResult) => void; aborted: () => boolean } {
    let release: (result: ElicitResult) => void = () => undefined;
    let sawAbort = false;
    return {
      handler: (_request, signal) =>
        new Promise<ElicitResult>((resolve) => {
          release = resolve;
          signal.addEventListener("abort", () => {
            sawAbort = true;
          });
        }),
      release: (result) => release(result),
      aborted: () => sawAbort,
    };
  }

  it("aborts the open request when the worker says the question was settled", async () => {
    const held = heldOpen();
    const h = await harness(capabilities, held.handler);

    const outcome = h.consent.raised(raised(), h.route);
    await vi.waitFor(() => expect(h.asked).toHaveLength(1));
    h.consent.settled({ type: "prompt-settled", sessionId: SESSION, callId: "c-1", promptId: "p-1", answeredFrom: "browser" });

    await expect(outcome).resolves.toBe("no-answer");
    await vi.waitFor(() => expect(held.aborted()).toBe(true));
    // The card answered first; a client choice arriving after that is not sent.
    held.release(accept("once"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.sent).toEqual([]);
    expect(h.consent.openCallIds()).toEqual([]);
  });

  it("aborts the open request when the tool call ends, and leaves another call's open", async () => {
    const held = heldOpen();
    const h = await harness(capabilities, held.handler);

    const first = h.consent.raised(raised(), h.route);
    void h.consent.raised(raised({ callId: "c-2", promptId: "p-2" }), h.route);
    await vi.waitFor(() => expect(h.asked).toHaveLength(2));
    h.consent.callEnded("c-1");

    await expect(first).resolves.toBe("no-answer");
    expect(h.consent.openCallIds()).toEqual(["c-2"]);
    h.consent.closeAll();
    expect(h.consent.openCallIds()).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it("ignores a settled frame for another question, another call or another session", async () => {
    const held = heldOpen();
    const h = await harness(capabilities, held.handler);

    const outcome = h.consent.raised(raised(), h.route);
    await vi.waitFor(() => expect(h.asked).toHaveLength(1));
    // T929 I1: an earlier question of the same call (a batch's previous step) was settled.
    h.consent.settled({ type: "prompt-settled", sessionId: SESSION, callId: "c-1", promptId: "p-0", answeredFrom: "browser" });
    h.consent.settled({ type: "prompt-settled", sessionId: SESSION, callId: "c-other", promptId: "p-other", answeredFrom: "browser" });
    h.consent.settled({ type: "prompt-settled", sessionId: "s-other", callId: "c-1", promptId: "p-1", answeredFrom: "browser" });
    held.release(accept("deny"));

    await expect(outcome).resolves.toBe("answered");
    expect(h.sent).toEqual([{ type: "prompt-answer", sessionId: SESSION, callId: "c-1", promptId: "p-1", choice: "deny" }]);
  });

  it("opens at most one request per question: a repeated raise does not ask twice", async () => {
    const held = heldOpen();
    const h = await harness(capabilities, held.handler);

    const first = h.consent.raised(raised(), h.route);
    await vi.waitFor(() => expect(h.asked).toHaveLength(1));
    await expect(h.consent.raised(raised(), h.route)).resolves.toBe("not-asked");
    held.release(accept("once"));

    await expect(first).resolves.toBe("answered");
    expect(h.asked).toHaveLength(1);
    expect(h.sent).toHaveLength(1);
  });
});

describe("who is never asked", () => {
  it("never asks a client that advertised no elicitation", async () => {
    const h = await harness({});

    await expect(h.consent.raised(raised(), h.route)).resolves.toBe("not-asked");

    expect(h.requestSpy).not.toHaveBeenCalled();
    expect(h.sent).toEqual([]);
  });

  it("never asks for a worker that did not advertise terminal-consent", async () => {
    const h = await harness({ elicitation: { form: {} } }, () => accept("once"));
    h.features.clear();

    await expect(h.consent.raised(raised(), h.route)).resolves.toBe("not-asked");

    expect(h.requestSpy).not.toHaveBeenCalled();
    expect(h.sent).toEqual([]);
  });

  it("never asks about another session's question", async () => {
    const h = await harness({ elicitation: { form: {} } }, () => accept("once"));

    await expect(h.consent.raised(raised({ sessionId: "s-other" }), h.route)).resolves.toBe("not-asked");

    expect(h.requestSpy).not.toHaveBeenCalled();
    expect(h.sent).toEqual([]);
  });

  it("sends nothing when the worker stopped advertising the feature while the owner chose", async () => {
    let features: Set<string> | undefined;
    const h = await harness({ elicitation: { form: {} } }, () => {
      features?.clear();
      return accept("once");
    });
    features = h.features;

    await expect(h.consent.raised(raised(), h.route)).resolves.toBe("no-answer");

    expect(h.sent).toEqual([]);
  });
});

/**
 * 032 T958 (R-485, contracts/terminal-consent-032.md): a site change and a site plan are asked in
 * the client in their own words. The transition form names both sites, the site-plan form every
 * proposed site, and each offers only its session-bounded yes and Deny - never "always" (D-032-1).
 */
describe("032 a site change and a site plan in the client", () => {
  const capabilities: ClientCapabilities = { elicitation: { form: {} } };
  const transition = (): PromptRaisedFrame =>
    raised({
      kind: "transition",
      site: "https://zh.wikipedia.org",
      from: "https://www.wikipedia.org",
      action: "press Enter in the search box",
      choices: ["session", "deny"],
    });
  const sitePlan = (): PromptRaisedFrame =>
    raised({
      kind: "site-plan",
      site: "https://a.example.test",
      sites: ["https://a.example.test", "https://b.example.test", "https://c.example.test:8443"],
      action: "Compare the release notes",
      choices: ["session", "deny"],
    });
  const formOf = (h: Harness) => {
    const params = h.asked[0]! as Extract<ElicitRequest["params"], { requestedSchema: unknown }>;
    const field = params.requestedSchema.properties.choice as { enum: string[]; enumNames: string[]; description: string };
    return { message: params.message, field };
  };

  it("names where the tab came from and where it went, and offers Continue for this session or Deny", async () => {
    const h = await harness(capabilities, () => accept("session"));

    await expect(h.consent.raised(transition(), h.route)).resolves.toBe("answered");

    const { message, field } = formOf(h);
    expect(message).toBe(
      "Hallpass: Claude Code (hallpass)'s tab moved from https://www.wikipedia.org to https://zh.wikipedia.org. Continue on https://zh.wikipedia.org?",
    );
    expect(field.enum).toEqual(["session", "deny"]);
    expect(field.enumNames).toEqual(["Continue for this session", "Deny"]);
    expect(field.description).toBe("session: Continue for this session; deny: Deny");
    expect(`${message} ${field.description}`.toLowerCase()).not.toContain("always");
    expect(h.sent).toEqual([{ type: "prompt-answer", sessionId: SESSION, callId: "c-1", promptId: "p-1", choice: "session" }]);
  });

  it("lists every proposed site, and offers Allow these sites for this session or Deny", async () => {
    const h = await harness(capabilities, () => accept("deny"));

    await expect(h.consent.raised(sitePlan(), h.route)).resolves.toBe("answered");

    const { message, field } = formOf(h);
    expect(message).toBe(
      "Hallpass: allow Claude Code (hallpass) to act on these sites for this session: https://a.example.test, https://b.example.test, https://c.example.test:8443?",
    );
    expect(field.enum).toEqual(["session", "deny"]);
    expect(field.enumNames).toEqual(["Allow these sites for this session", "Deny"]);
    expect(`${message} ${field.description}`.toLowerCase()).not.toContain("always");
    expect(h.sent).toEqual([{ type: "prompt-answer", sessionId: SESSION, callId: "c-1", promptId: "p-1", choice: "deny" }]);
  });

  it.each([
    ["transition", transition],
    ["site plan", sitePlan],
  ] as const)("sends nothing for a %s answered with once, which it never offered", async (_name, build) => {
    const h = await harness(capabilities, () => accept("once"));

    await expect(h.consent.raised(build(), h.route)).resolves.toBe("no-answer");

    expect(h.sent).toEqual([]);
  });

  it("keeps the 031 wording for an effect question", async () => {
    const h = await harness(capabilities, () => accept("once"));
    await h.consent.raised(raised(), h.route);
    expect(formOf(h).field.enumNames).toEqual(["Allow once", "Allow on this site for this session", "Deny"]);
  });
});
