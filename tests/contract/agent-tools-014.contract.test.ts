import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_PROFILE_PERMISSIONS,
  createManifest,
  resolveBuildConfig,
} from "../../apps/extension/src/build-config.js";
import { contractExport, contractSchema, expectAccepted, expectRejected, type ZodLike } from "./helpers.js";

/**
 * 014 — the three questions this feature adds, as shapes both ends must agree on (R-185, R-186,
 * R-187).
 *
 * All of it is pinned in one place and before any of the three slices, because the shapes are what
 * the slices are separately written against: the interrupt is the worker answering its own calls,
 * the transition is a card raised by the dispatcher, and the directory question is the *host*
 * asking the worker mid-call. Three writers, one vocabulary.
 *
 * The rule every addition here obeys is R-187 §6's measurement: every frame schema on this link is
 * `z.strictObject`, so an unknown key does not ride along - it makes the whole frame fail to parse
 * and be dropped unanswered. So nothing here is a new key on an existing frame except where the
 * field is optional and the *other* end is the one that predates it (`pair-result.features`,
 * exactly as 013 added `browserRunId`); everything else is a new frame `type`, which an old side
 * logs as unexpected and drops.
 */

const SESSION = "session-1";
const CALL = "call-1";

describe("T350 the reasons an owner's decision answers with", () => {
  /**
   * One vocabulary rather than six literals spread over the worker, the host and the panel.
   *
   * `reason` is the short stable code an agent branches on, and these six are the ones that name
   * something the owner did, declined, or has not been asked yet. They are pinned as a list so the
   * slice that writes each of them cannot invent a synonym: an agent that learned to expect
   * `owner-interrupted` must not meet `interrupted-by-owner` from the next runner.
   */
  it("names the interrupt, the transition and the directory answers", () => {
    const reasons = contractExport<readonly string[]>("AGENT_CONSENT_REASONS");
    for (const reason of [
      "owner-interrupted",
      "site-transition-declined",
      "site-transition",
      "upload-declined",
      "upload-not-answered",
      "upload-outside-allowed-directories",
      /**
       * S3 review F2: the owner said yes and the file could not be written.
       *
       * It used to be answered `upload-outside-allowed-directories`, whose meaning is "this
       * extension cannot ask you" - so an agent was told to have the owner reinstall something
       * over a config file that could not be renamed over. Two different facts, two words.
       */
      "upload-directory-not-recorded",
    ]) {
      expect(reasons, reason).toContain(reason);
    }
    // Every one of them fits the field it travels in: `reason` is bounded at 200 characters
    // because an unbounded one is how page-derived text reaches a log (FR-035).
    const response = contractSchema("agentNativeResponseSchema");
    for (const reason of reasons) {
      expectAccepted(response, { callId: CALL, outcome: "stopped", reason }, `an answer reading ${reason}`);
    }
  });

  /**
   * The flag the stop registry carries, and the two words it can read (data-model "Stop flag").
   *
   * Two, and closed: a runner asks the handle what ended it and answers that word verbatim, so a
   * third value invented in a runner would reach an agent as a reason nothing documents.
   */
  it("closes the stop flag's two reasons", () => {
    const reasons = contractExport<readonly string[]>("AGENT_STOP_REASONS");
    expect([...reasons]).toEqual(["owner-stopped", "owner-interrupted"]);
  });

  /**
   * The two sentences an interrupted call is answered with (FR-180, FR-181).
   *
   * They live in the contracts package for the reason `ATTENTION_SENTENCES` does: the worker
   * composes them, the agent reads them and the gate asserts them, and three copies of a sentence
   * is how the one that matters - "it may have taken effect and was not verified" - quietly
   * becomes "nothing happened" in one of them.
   */
  it("fixes the two things an interrupted call may honestly say", () => {
    const hints = contractExport<Record<string, string>>("INTERRUPT_HINTS");
    expect(hints["nothingDelivered"]).toContain("Nothing refused it");
    expect(hints["nothingDelivered"]).toContain("still held");
    expect(hints["mayHaveTakenEffect"]).toContain("may have taken effect");
    expect(hints["mayHaveTakenEffect"]).toContain("not verified");
    // Both travel on `hint`, whose bound is the length of the longest attention sentence.
    const response = contractSchema("agentNativeResponseSchema");
    for (const hint of Object.values(hints)) {
      expectAccepted(
        response,
        { callId: CALL, outcome: "stopped", reason: "owner-interrupted", hint },
        "an interrupted answer carrying its sentence",
      );
    }
  });
});

describe("T350 the two new questions the owner can be asked", () => {
  it("adds the transition and the directory to the prompt kinds", () => {
    const kinds = contractExport<readonly string[]>("AGENT_PROMPT_KINDS");
    expect(kinds).toContain("transition");
    expect(kinds).toContain("upload-directory");
    // The tick that says a question is still waiting names its kind, so a new kind that could not
    // travel on it would be a card the agent is never told about (011 FR-148).
    expectAccepted(
      contractSchema("promptWaitingFrameSchema"),
      {
        type: "prompt-waiting",
        sessionId: SESSION,
        callId: CALL,
        kind: "transition",
        panelConnected: false,
        waitedMs: 5_000,
        boundMs: 120_000,
      },
      "a transition card that nobody has opened the panel to see",
    );
  });

  /**
   * What the card carries, per kind (data-model "AgentEffectPrompt").
   *
   * A transition carries the two origins, because both of them are the question: "it was on A and
   * is now on B" is a different decision from "it is on B". A directory question carries the paths
   * *in full* - they are the owner's own file names, shown to the owner alone and never to a page -
   * and each is absolute, because a relative path is a path whose meaning depends on which process
   * resolves it, and the two processes here have different working directories.
   */
  it("carries both origins for a transition and full absolute paths for a directory", () => {
    const prompt = contractSchema("agentEffectPromptSchema");
    const base = {
      promptId: "prompt-1",
      raisedAt: new Date().toISOString(),
      site: "https://a.test",
      tool: "click",
      argsSummary: "click Sign in",
    };

    expectAccepted(
      prompt,
      { ...base, kind: "transition", transition: { from: "https://a.test", to: "https://b.test" } },
      "a move from one origin to another",
    );
    expectAccepted(
      prompt,
      {
        ...base,
        tool: "file_upload",
        kind: "upload-directory",
        files: [{ path: "C:\\Users\\owner\\pictures\\a.png", directory: "C:\\Users\\owner\\pictures" }],
      },
      "a file the owner has not allowed the directory of",
    );
    expectAccepted(
      prompt,
      { ...base, tool: "upload_image", delivery: "drop" },
      "how a picture would be put into the page",
    );
    expectAccepted(prompt, base, "a card from before any of the three fields");

    // A path that is not absolute: refused at the shape, not left for the card to render.
    expectRejected(
      prompt,
      { ...base, tool: "file_upload", kind: "upload-directory", files: [{ path: "a.png", directory: "." }] },
      "a relative path",
    );
    // An origin with a path is not an origin (`siteOfUrl` never produces one).
    expectRejected(
      prompt,
      { ...base, kind: "transition", transition: { from: "https://a.test/page", to: "https://b.test" } },
      "a transition naming a page rather than an origin",
    );
    expectRejected(prompt, { ...base, delivery: "paste" }, "a delivery nobody declared");
  });

  /**
   * The owner's "from now on", per card (data-model): one flag per kind rather than one shared
   * `remember`, because they remember different things - a pair of origins, and a directory on the
   * owner's disk - and a single flag would let one card's yes be read as the other's.
   */
  it("lets the panel's answer say 'from now on' about the right thing", () => {
    const command = contractSchema("agentPanelCommandSchema");
    const decide = { type: "ui.agent.effect-decide", payload: { promptId: "prompt-1", allow: true } };

    expectAccepted(
      command,
      { ...decide, payload: { ...decide.payload, rememberTransition: true } },
      "always allow this pair of origins",
    );
    expectAccepted(
      command,
      { ...decide, payload: { ...decide.payload, rememberDirectory: true } },
      "these directories from now on",
    );
    expectAccepted(command, decide, "an answer from a panel that predates both");
  });

  it("carries the panel's three new owner controls", () => {
    const command = contractSchema("agentPanelCommandSchema");
    expectAccepted(
      command,
      { type: "ui.agent.session-interrupt", payload: { sessionId: SESSION } },
      "interrupt this session's calls",
    );
    expectAccepted(
      command,
      { type: "ui.agent.transition-clear", payload: { from: "https://a.test", to: "https://b.test" } },
      "forget a remembered pair",
    );
    expectAccepted(
      command,
      { type: "ui.agent.upload-root-clear", payload: { root: "C:\\Users\\owner\\pictures" } },
      "forget an upload directory",
    );

    // None of the three can widen anything: an interrupt names a session and never a call, a pair
    // is only ever removed, and a root is only ever removed.
    expectRejected(
      command,
      { type: "ui.agent.session-interrupt", payload: { sessionId: SESSION, callId: CALL } },
      "an interrupt naming one call",
    );
    expectRejected(
      command,
      { type: "ui.agent.upload-root-clear", payload: { root: "pictures" } },
      "a root that is not absolute",
    );
  });
});

describe("T350 what the panel is told", () => {
  const state = {
    paired: [],
    sessions: [],
    tabs: [],
    sites: [],
    bridge: "connected" as const,
  };

  it("counts a session's calls in flight, so the 中斷 control can be enabled by a fact", () => {
    const panel = contractSchema("agentPanelStateSchema");
    const session = { sessionId: SESSION, agentId: "agent-1", tabs: [] };

    expectAccepted(panel, { ...state, sessions: [{ ...session, inFlight: 1 }] }, "one call in flight");
    expectAccepted(panel, { ...state, sessions: [{ ...session, inFlight: 0 }] }, "nothing in flight");
    expectAccepted(panel, { ...state, sessions: [session] }, "a projection from before the count");
    expectRejected(panel, { ...state, sessions: [{ ...session, inFlight: -1 }] }, "fewer than no calls");
  });

  it("lists the remembered pairs and the upload directories as rows the owner can revoke", () => {
    const panel = contractSchema("agentPanelStateSchema");
    const allowed = {
      from: "https://a.test",
      to: "https://b.test",
      allowedAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    };

    expectAccepted(panel, { ...state, transitions: [allowed] }, "a pair the owner said always to");
    expectAccepted(
      panel,
      { ...state, uploadRoots: { roots: ["C:\\Users\\owner\\pictures"], path: "C:\\hallpass\\config.json" } },
      "the directories the host is holding",
    );
    expectAccepted(
      panel,
      { ...state, uploadRoots: { roots: [], path: "C:\\hallpass\\config.json", malformed: true } },
      "a config file nobody can read",
    );
    // S3 review F2: a "from now on" the host could not write down. The agent is told in its own
    // word; the owner is told here, because they are the one who can do anything about it.
    expectAccepted(
      panel,
      {
        ...state,
        uploadRoots: {
          roots: [],
          path: "C:\\hallpass\\config.json",
          notRecorded: ["C:\\Users\\owner\\pictures"],
        },
      },
      "a directory the owner allowed and the host did not keep",
    );
    // S3 review F4: and the copy of a document the host could not read, so the panel can say where
    // it went. The same field the link frame carries, travelling one hop further.
    expectAccepted(
      panel,
      {
        ...state,
        uploadRoots: {
          roots: [],
          path: "C:\\hallpass\\config.json",
          malformed: true,
          preserved: "config.json.invalid",
        },
      },
      "a config file the host kept a copy of",
    );
    // Absent, not empty: an old relay never answers the list, and "no rows" is a different fact
    // from "nothing asked".
    expectAccepted(panel, state, "a projection with neither");
    expectRejected(panel, { ...state, transitions: [{ ...allowed, from: "https://a.test/page" }] }, "a pair naming a page");
  });
});

describe("T350 the frames the host, the relay and the worker agree on", () => {
  it("asks the worker about a file outside the directories, and is answered once", () => {
    const frame = contractSchema("agentControlFrameSchema");

    expectAccepted(
      frame,
      {
        type: "upload-consent-request",
        sessionId: SESSION,
        callId: CALL,
        files: [{ path: "C:\\Users\\owner\\pictures\\a.png", directory: "C:\\Users\\owner\\pictures" }],
      },
      "the host asking about one file",
    );
    /**
     * Six endings, not five (S3 review F3).
     *
     * `busy` is the worker already holding one question for this owner: the card was never raised,
     * so nothing was interrupted and nothing was declined - and both of those were what the host
     * used to tell the agent about a second session asking at the same moment. It is the word every
     * other tool of this product already answers that situation with.
     */
    for (const decision of ["once", "always", "deny", "timed-out", "interrupted", "busy"]) {
      expectAccepted(
        frame,
        { type: "upload-consent-result", callId: CALL, decision },
        `the owner's answer: ${decision}`,
      );
    }
    // 011 FR-146 (S3 review F1): the expiry carries where to click, when nobody could see the card.
    expectAccepted(
      frame,
      { type: "upload-consent-result", callId: CALL, decision: "timed-out", hint: "Open the side panel" },
      "an expiry that says where to click",
    );
    expectRejected(
      frame,
      { type: "upload-consent-result", callId: CALL, decision: "maybe" },
      "an answer nobody declared",
    );
    expectRejected(
      frame,
      { type: "upload-consent-request", sessionId: SESSION, callId: CALL, files: [{ path: "a.png", directory: "." }] },
      "a relative path on the wire",
    );
  });

  /**
   * The capability flag, added exactly the way 013 added `browserRunId` (R-187 §6b).
   *
   * The host must not ask a worker that cannot raise the card: the request would be dropped as an
   * unknown type and the call would hang until its bound. So the worker says what it can do on the
   * one frame it sends on every established link, optional so a host that predates the field parses
   * it and a worker that predates it simply never advertises.
   */
  it("lets the worker advertise the directory card on its pairing answer", () => {
    const frame = contractSchema("agentControlFrameSchema");
    const answer = { type: "pair-result", agentId: "agent-1", sessionId: SESSION, accepted: true };

    expectAccepted(frame, { ...answer, features: ["upload-consent"] }, "a worker that can ask");
    expectAccepted(frame, { ...answer, features: [] }, "a worker that advertises nothing");
    expectAccepted(frame, answer, "a worker from before the field");
    expectAccepted(
      frame,
      { ...answer, browserRunId: "3f1a9c0e-run", features: ["upload-consent"] },
      "beside 013's own addition",
    );
    expectRejected(frame, { ...answer, features: "upload-consent" }, "a feature that is not a list");
    expectRejected(frame, { ...answer, features: [""] }, "an empty feature name");
  });

  it("lists and revokes the upload directories over the relay's own link", () => {
    const link = contractSchema("agentLinkFrameSchema");

    expectAccepted(link, { type: "upload-roots-list" }, "the worker asking what the list holds");
    expectAccepted(
      link,
      { type: "upload-roots-remove", root: "C:\\Users\\owner\\pictures" },
      "the owner revoking one row",
    );
    expectAccepted(
      link,
      { type: "upload-roots", roots: ["C:\\Users\\owner\\pictures"], path: "C:\\hallpass\\config.json" },
      "the relay answering with the list and where it lives",
    );
    expectAccepted(
      link,
      { type: "upload-roots", roots: [], path: "C:\\hallpass\\config.json", malformed: true },
      "a file the relay could not read as a list",
    );
    // S3 review F4: and where the document nobody could read was kept. A new optional field on a
    // frame type this feature introduced, so no older side can meet it; the name of a file beside
    // the config rather than a path, because the path is already on the frame.
    expectAccepted(
      link,
      {
        type: "upload-roots",
        roots: ["C:\\Users\\owner\\pictures"],
        path: "C:\\hallpass\\config.json",
        malformed: true,
        preserved: "config.json.invalid",
      },
      "a list written beside the document it could not read",
    );
    expectRejected(link, { type: "upload-roots-remove", root: "pictures" }, "a relative root");
    // The relay is the only writer of the list; nothing here lets the *worker* state one.
    expectRejected(
      link,
      { type: "upload-roots-add", root: "C:\\Users\\owner\\pictures" },
      "a frame that would widen the list from the browser",
    );
  });

  /**
   * A batch that was interrupted answers what ran, what was interrupted and what never started.
   *
   * The per-step list alone cannot say it: a step that never started and a step that failed both
   * read as `not-run` in it, and the agent's next question is "how far did it get". Three optional
   * fields rather than a new result shape, because an ordinary batch still answers what it always
   * did (FR-180).
   */
  it("lets an interrupted batch say how far it got", () => {
    const result = contractSchema("agentBatchResultSchema");
    const results = [{ index: 0, outcome: "ok" as const }];

    expectAccepted(result, { results }, "an ordinary batch");
    expectAccepted(
      result,
      { results, completed: [0, 1], interruptedAt: 2, notRun: [3, 4] },
      "a batch the owner interrupted at its third step",
    );
    expectRejected(result, { results, interruptedAt: -1 }, "a step before the first one");
  });

  /**
   * 014/T363 — and a batch the *browser* stopped says so in a word of its own (FR-187).
   *
   * `stoppedAt` rather than `interruptedAt` reused, because the two are different facts about
   * different actors: one is the owner ending a step, the other is a step that never started
   * because its tab is somewhere nobody has decided about.
   */
  it("lets a batch stopped by a move say where it stopped", () => {
    const result = contractSchema("agentBatchResultSchema");
    const results = [
      { index: 0, outcome: "ok" as const },
      { index: 1, outcome: "stopped" as const, reason: "site-transition" },
    ];
    expectAccepted(result, { results, completed: [0], stoppedAt: 1, notRun: [2] }, "a batch a move stopped");
  });

  /**
   * 014/T365 — what the agent is told before it spends a call (FR-186, contracts/transitions.md).
   *
   * Two descriptions and one sentence, pinned because they are the only warning an agent gets
   * that a click can leave its next call waiting on a person. An agent that does not know this
   * reads a `denied / site-transition-declined` as a bug in its own plan.
   */
  it("warns on the two tools that move a tab, and composes one notice sentence", () => {
    const descriptors = contractExport<ReadonlyArray<{ name: string; description: string }>>("AGENT_TOOL_DESCRIPTORS");
    for (const name of ["navigate", "click"]) {
      const description = descriptors.find((entry) => entry.name === name)?.description ?? "";
      expect(description, `${name} says nothing about landing somewhere undecided`).toContain(
        "If the tab lands on a site the owner has not decided about, the answer says so and the next call " +
          "on that tab asks the owner (continue / always / decline).",
      );
    }
    const notice = contractExport<(from: string, to: string) => string>("transitionNoticeText");
    expect(notice("https://a.test", "https://b.test")).toBe(
      "The tab moved from https://a.test to https://b.test; the next call on this tab will ask the owner.",
    );
    // It rides in `hint`, which is bounded at 400 characters (R-187 §6): the sentence fits with
    // room for a runner's own beside it.
    const response = contractSchema("agentNativeResponseSchema");
    expectAccepted(
      response,
      { callId: CALL, outcome: "ok", hint: notice("https://a.test", "https://b.test") },
      "an answer carrying the notice",
    );
  });

  /**
   * 014/T386 — and what `file_upload` tells the agent about the owner's directories (FR-197,
   * contracts/upload-directory.md).
   *
   * Two refusals it can now meet, and they are not the same fact: `upload-outside-allowed-
   * directories` is the *extension* saying the owner's build predates the question, and
   * `upload-not-allowed` for such a file is the *host* saying its own does. An agent that cannot
   * tell them apart reports "uploads are broken" for what is, in both cases, an owner who has
   * something to install. The sentence names the three answers as well, because "the panel asks"
   * without them reads as a dialog the agent is expected to wait on rather than a decision.
   */
  it("says on `file_upload` that a file outside the owner's directories is a question", () => {
    const descriptors = contractExport<ReadonlyArray<{ name: string; description: string }>>("AGENT_TOOL_DESCRIPTORS");
    const description = descriptors.find((entry) => entry.name === "file_upload")?.description ?? "";
    expect(description).toContain(
      "A file outside the directories the owner allowed makes the owner's panel ask (this file once / " +
        "its directory from now on / decline). `upload-outside-allowed-directories` means the owner's " +
        "extension predates that question; `upload-not-allowed` for such a file means the owner's host " +
        "does (reinstall it).",
    );
  });

  it("does not move the link protocol number for any of it", () => {
    // Every addition is a new frame type or an optional field, so neither end has to agree on
    // anything new: an old side drops what it does not know and behaves exactly as 0.5.0 did.
    expect(contractExport<number>("AGENT_LINK_PROTOCOL")).toBe(2);
  });
});

describe("T350 what this feature does not buy", () => {
  it("adds no tool and no permission", () => {
    // 33 when 014 shipped; 017 adds `propose_sites`, the thirty-fourth, and 018 the three browser tools.
    expect(contractExport<readonly string[]>("AGENT_TOOL_NAMES")).toHaveLength(37);
    expect([...AGENT_PROFILE_PERMISSIONS]).toEqual([
      "activeTab",
      "scripting",
      "sidePanel",
      "storage",
      "nativeMessaging",
      "tabs",
      "tabGroups",
      "alarms",
      "debugger",
      "downloads",
      "offscreen",
    ]);
    const agent = createManifest(resolveBuildConfig("agent"));
    expect(agent.permissions).toEqual([...AGENT_PROFILE_PERMISSIONS]);
    expect(agent.host_permissions ?? []).toEqual(["<all_urls>", "https://localhost/*"]);
  });

  /**
   * The owner's allow-list is the owner's (FR-195).
   *
   * The agent is told *that* a file outside it is refused - `file_upload` has said so since 0.5.0 -
   * and never where the list lives. A description naming the config file would hand an agent the
   * one path it would have to write to in order to widen its own permission, so the check is on
   * the shape of a path rather than on the word: no drive letter, no absolute path, no environment
   * variable, no file name of the store.
   */
  it("never tells the agent where the owner's list is kept", () => {
    const descriptors = contractExport<ReadonlyArray<{ name: string; description: string }>>(
      "AGENT_TOOL_DESCRIPTORS",
    );
    for (const { name, description } of descriptors) {
      expect(name, name).not.toMatch(/config|roots?$/i);
      expect(description, name).not.toMatch(/config\.json|%[A-Z_]+%|\$env:|[A-Za-z]:\\|\/etc\//);
    }
  });
});

/**
 * 014/T381 — the allow-list has two hands on it, and neither belongs to the agent (FR-195).
 *
 * The claim is about the import graph rather than about anybody's discipline: `upload-config-store`
 * is the only writer of the owner's `config.json`, and if nothing an MCP request can reach is able
 * to *read* the list or *remove* from it, then no tool - offered, pending or invented tomorrow -
 * can widen or inspect what the host may upload. The one reachable call is `add`, and it sits
 * behind an answer the owner gave on a card in their own browser.
 *
 * Read from the source, in the spirit of 005's "no download-starting call" scan: a shape somebody
 * types accidentally goes red here rather than in a review.
 */
describe("T381 the agent cannot reach the owner's upload directories", () => {
  const storeModule = "upload-config-store";
  const hostDirectory = resolve("packages/agent-host/src");
  /**
   * Every source of the host, read from the directory rather than listed here (S3 review F8).
   *
   * The list used to be typed out, so a module added tomorrow - a second entry point, a helper
   * under `install/` - was outside the claim entirely and nothing went red. Recursive, because a
   * subdirectory is exactly where a module nobody remembered to add would sit.
   */
  const hostSources = readdirSync(hostDirectory, { recursive: true })
    .map((entry) => String(entry))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => name.split("\\").join("/"));

  function source(file: string): string {
    return readFileSync(resolve(hostDirectory, file), "utf8");
  }

  it("is imported by the relay and by the consent flow, and by nothing else", () => {
    expect(hostSources, "the host's sources must be found on disk").toContain("mcp-server.ts");
    const importers = hostSources.filter((file) => source(file).includes(`${storeModule}.js`));
    // The relay, because the panel's list and its revoke arrive there; the server, because the
    // owner's "from now on" is answered while it holds the file. Two, and no third.
    expect(importers.sort()).toEqual(["mcp-server.ts", "native-host.ts", "relay-mux.ts"]);
    // `relay-mux` names only the *type*: the routing holds no store, it is handed one.
    expect(source("relay-mux.ts")).toContain(`import type { UploadRootsListing } from "./${storeModule}.js"`);
  });

  /**
   * One store, one verb, and no second name for it (S3 review F8).
   *
   * The old scan matched `uploadRoots.<verb>(` - a regular expression an alias walks straight out
   * of: `const roots = uploadRoots` and the whole claim is about a name nothing uses any more. So
   * the binding is read from the source instead of assumed, every member access on *that* name is
   * collected, and the name is asserted never to be handed to anything else.
   */
  it("gives the server one store, one verb, and no other way to reach it", () => {
    const server = source("mcp-server.ts");

    expect([...server.matchAll(/createUploadConfigStore\(/gu)], "one store, made once").toHaveLength(1);
    const binding = /const (\w+) = createUploadConfigStore\(/u.exec(server)?.[1];
    expect(binding, "the store must be held by a named binding").toBeDefined();

    const uses = [...server.matchAll(new RegExp(`\\b${binding ?? ""}\\.(\\w+)`, "gu"))].map((match) => match[1]);
    // One verb. `list` would be a read of the owner's disk on a path an agent can drive, and
    // `remove` would let a call take away a permission the owner gave.
    expect([...new Set(uses)]).toEqual(["add"]);
    // And no second identifier is ever given the store - as an assignment, as an argument, or as a
    // property of something handed on - which is the shape that would make the check above blind.
    expect(server).not.toMatch(new RegExp(`=\\s*${binding ?? ""}\\s*[;,)]`, "u"));
    expect(server).not.toMatch(new RegExp(`[(,:]\\s*${binding ?? ""}\\s*[,)}]`, "u"));
  });

  it("puts the one call behind the owner's own answer", () => {
    const server = source("mcp-server.ts");
    const at = server.indexOf("uploadRoots.add(");
    expect(at, "the server must still add directories somewhere").toBeGreaterThan(0);
    const before = server.slice(0, at);
    const guard = before.lastIndexOf('decision === "always"');
    expect(guard, "the list grows on `always` and on nothing else").toBeGreaterThan(0);
    // And nothing between that guard and the call tests the answer again: the `add` is inside the
    // branch that guard opens, not under a later one that happens to read alike.
    expect(before.slice(guard + 'decision === "always"'.length)).not.toContain("decision ===");
  });
});

/**
 * 014/T384 (S3 review F7) — the directories a "from now on" will not remember.
 *
 * `這些資料夾以後都可以` adds the file's own parent, and for a file sitting at `D:\` or on a share
 * root that parent *is* the whole drive or the whole share: one press, and every file on it is
 * uploadable without another question for as long as the row stands. The rule is a shared one
 * because two ends apply it - the host refuses to write such a root, and the worker must not then
 * report it as an answer that failed to be recorded.
 */
describe("T384 the roots a 'from now on' will not remember", () => {
  it("names a drive root and a share root, and nothing inside them", () => {
    const isRoot = contractExport<(path: string) => boolean>("isRootDirectory");

    for (const root of ["C:\\", "C:/", "d:\\", "\\\\server\\share", "\\\\server\\share\\", "/"]) {
      expect(isRoot(root), root).toBe(true);
    }
    for (const ordinary of ["C:\\Users\\owner", "C:\\Users", "\\\\server\\share\\pictures", "/home/owner"]) {
      expect(isRoot(ordinary), ordinary).toBe(false);
    }
  });

  it("gives both ends one sentence for it, sized for the field it travels in", () => {
    const hints = contractExport<Record<string, string>>("UPLOAD_HINTS");

    expect(hints["rootNotRemembered"]).toContain("roots are not remembered");
    expectAccepted(
      contractSchema("agentNativeResponseSchema"),
      { callId: CALL, outcome: "ok", hint: hints["rootNotRemembered"] },
      "an upload that proceeded once and remembered nothing",
    );
  });
});

function args(tool: string): ZodLike {
  const table = contractExport<Record<string, ZodLike>>("agentToolArgSchemas");
  const schema = table[tool];
  expect(schema, `agentToolArgSchemas.${tool} must exist`).toBeDefined();
  return schema as ZodLike;
}

describe("T350 the tools are untouched", () => {
  it("still takes exactly what it took, on the one tool this feature asks about", () => {
    // The directory question happens *around* `file_upload`, never inside its arguments: an
    // argument that named a directory would be the agent stating which list it wants to be in.
    expectRejected(
      args("file_upload"),
      { tabId: 7, ref: "tgt-1", files: [], uploadRoots: ["C:\\Users\\owner\\pictures"] },
      "a call naming a directory of its own",
    );
  });
});
