/**
 * The pairing helper (004/T086, brief B4).
 *
 * A `claude -p` session cannot accept a prompt: it has no console and no side panel. Without help
 * every S0 scenario would stop at the pairing gate, so the probe accepts on the owner's behalf
 * through the same debugging session the packaged gate already uses (`tests/e2e/fixtures/
 * packaged-extension.ts` attach mode): find the agent extension's service-worker target in
 * `GET /json/list`, open a second DevTools client on its own `webSocketDebuggerUrl`, and evaluate
 * there.
 *
 * ## What this helper can and cannot drive, established on 2026-09-09
 *
 * The *durable* half of the pairing state lives in `chrome.storage.local.agentPairings` and is read
 * back on every call (`pairing.isPaired`), so writing a paired agent there is a real accept: the
 * next call from that agent id is paired, exactly as if the owner had clicked.
 *
 * The *pending* half is not reachable. A pending prompt is resolved only by `runtime.pairing.decide`,
 * whose sole route in is the side-panel port, and that port refuses any sender carrying a `tab`
 * (`isTrustedControlSender`: `sender.tab === undefined && sender.url === sidePanelUrl`). A side panel
 * is opened by `chrome.sidePanel.open`, which needs a user gesture, so a debugging client cannot
 * raise one. The consequence is recorded rather than hidden: a scenario that seeds *before* the call
 * never sees a prompt, and a scenario that seeds *while* a prompt is pending does not release the
 * pending promise - which is precisely the E2 measurement, so the probe seeds and reports what the
 * call did.
 */

export type PairingTarget = { id: string; type: string; url: string; webSocketDebuggerUrl?: string };

export type PairingFetch = (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

/** One `Runtime.evaluate` over a target socket; the packaged gate's shape, kept as a seam. */
export type PairingEvaluate = (socketUrl: string, expression: string) => Promise<unknown>;

export type PairedAgentRecord = {
  agentId: string;
  displayName: string;
  origin: string;
  acceptedAt: string;
};

export type PairingDeps = {
  endpoint: string;
  extensionId: string;
  fetch: PairingFetch;
  evaluate: PairingEvaluate;
  /** Injected so a test does not wait; the real one is `setTimeout`. */
  delay?: (ms: number) => Promise<void>;
};

const defaultDelay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The expression evaluated in the worker.
 *
 * Built as a string rather than a function reference so the test can assert it verbatim: this text
 * is the whole contract with the browser, and a silent change to it would turn every scenario into
 * a false negative that looks like a product failure.
 */
export function buildAcceptExpression(agent: PairedAgentRecord): string {
  return [
    "(async () => {",
    '  const key = "agentPairings";',
    "  const current = await chrome.storage.local.get([key]);",
    "  const stored = current[key];",
    "  const paired = stored && Array.isArray(stored.paired) ? stored.paired : [];",
    `  const agent = ${JSON.stringify(agent)};`,
    "  const kept = paired.filter((entry) => entry && entry.agentId !== agent.agentId);",
    "  await chrome.storage.local.set({ [key]: { paired: [...kept, agent] } });",
    "  return { paired: kept.length + 1 };",
    "})()",
  ].join("\n");
}

/**
 * Reads back whether one agent id is accepted (004/T111c).
 *
 * The durable record is the only half a debugging client can see, and it is the half that decides
 * the *next* session's first call - which is exactly the question the environment check asks.
 */
export function buildIsPairedExpression(agentId: string): string {
  return [
    "(async () => {",
    '  const current = await chrome.storage.local.get(["agentPairings"]);',
    "  const stored = current.agentPairings;",
    "  const paired = stored && Array.isArray(stored.paired) ? stored.paired : [];",
    `  return paired.some((entry) => entry && entry.agentId === ${JSON.stringify(agentId)});`,
    "})()",
  ].join("\n");
}

/** True when the browser already holds an accepted pairing for `agentId`. */
export async function isAgentPaired(deps: PairingDeps, agentId: string): Promise<boolean> {
  return (await deps.evaluate(await workerSocket(deps), buildIsPairedExpression(agentId))) === true;
}

/** Clears the durable pairing state, so a scenario can start from "never paired" (E2). */
export function buildResetExpression(): string {
  return [
    "(async () => {",
    "  await chrome.storage.local.set({ agentPairings: { paired: [] } });",
    "  return { paired: 0 };",
    "})()",
  ].join("\n");
}

/**
 * The owner's standing decision for one site, written the way the accept is written (004/T129b).
 *
 * A site nobody has decided about is `ask`, and `ask` sends every effect to a prompt only the side
 * panel can answer - which a debugging client cannot raise. So an unattended effect scenario on an
 * undecided site measures a prompt timing out instead of the capability it was written for. Setting
 * the mode first is the same class of environment step as the pairing above: the durable record in
 * `chrome.storage.local.agentSiteModes` is what `site-mode-store` reads, so writing it is a real
 * decision rather than a simulated one.
 *
 * Only the named site's entry changes. The store keeps every decided site under the one key, and an
 * expression that wrote a fresh object would erase the owner's other decisions to set one of them;
 * the site's own `diagnosticsGranted` is carried over for the same reason.
 */
export function buildSetSiteModeExpression(site: string, mode: string): string {
  return [
    "(async () => {",
    '  const key = "agentSiteModes";',
    "  const current = await chrome.storage.local.get([key]);",
    "  const stored = current[key] && typeof current[key] === \"object\" ? current[key] : {};",
    `  const site = ${JSON.stringify(site)};`,
    "  const previous = stored[site] && typeof stored[site] === \"object\" ? stored[site] : {};",
    `  const next = { ...stored, [site]: { mode: ${JSON.stringify(mode)}, diagnosticsGranted: previous.diagnosticsGranted === true } };`,
    "  await chrome.storage.local.set({ [key]: next });",
    "  return { site, mode: next[site].mode, sites: Object.keys(next).length };",
    "})()",
  ].join("\n");
}

/**
 * Applies one site's mode over CDP, answering rather than throwing.
 *
 * A mode the probe could not set is a fact about the run, not the end of it: the report says which
 * site was left undecided, so a scenario that then measured a prompt reads as such instead of as a
 * product failure.
 */
export async function setSiteMode(
  deps: PairingDeps,
  site: string,
  mode: string,
): Promise<{ set: boolean; detail: string }> {
  try {
    await deps.evaluate(await workerSocket(deps), buildSetSiteModeExpression(site, mode));
    return { set: true, detail: `${site} set to ${mode} via CDP` };
  } catch (error) {
    return { set: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** The agent build's service-worker target, or `undefined` when the worker is asleep. */
export function findWorkerTarget(
  targets: readonly PairingTarget[],
  extensionId: string,
): PairingTarget | undefined {
  const prefix = `chrome-extension://${extensionId}/`;
  return targets.find((entry) => entry.type === "service_worker" && entry.url.startsWith(prefix));
}

async function workerSocket(deps: PairingDeps): Promise<string> {
  const response = await deps.fetch(`${deps.endpoint}/json/list`);
  const targets = response.ok ? ((await response.json()) as PairingTarget[]) : [];
  const target = findWorkerTarget(Array.isArray(targets) ? targets : [], deps.extensionId);
  if (target?.webSocketDebuggerUrl === undefined) {
    throw new Error(
      `probe-004: agent worker ${deps.extensionId} has no debugging target (is the agent build loaded?)`,
    );
  }
  return target.webSocketDebuggerUrl;
}

/** Wipes the durable pairing state. The "fresh pairing state" half of the E2 scenario. */
export async function resetPairing(deps: PairingDeps): Promise<void> {
  await deps.evaluate(await workerSocket(deps), buildResetExpression());
}

/**
 * Accepts the pairing after `delayMs` (S2 asks for 20 s, standing in for the owner's reading time).
 *
 * Answers with what it did rather than throwing, because a failed accept is a scenario result - the
 * report has to be able to say "the probe could not accept" instead of the run dying.
 */
export async function acceptPairingAfter(
  deps: PairingDeps,
  agent: PairedAgentRecord,
  delayMs: number,
): Promise<{ accepted: boolean; detail: string }> {
  const wait = deps.delay ?? defaultDelay;
  await wait(delayMs);
  try {
    await deps.evaluate(await workerSocket(deps), buildAcceptExpression(agent));
    return { accepted: true, detail: `accepted ${agent.agentId} after ${delayMs} ms via CDP` };
  } catch (error) {
    return { accepted: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** The real evaluator: a second DevTools client on the target's own socket (Node 24 global WebSocket). */
export const realEvaluate: PairingEvaluate = async (socketUrl, expression) => {
  const socket = new WebSocket(socketUrl);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("probe-004: pairing socket failed")), { once: true });
  });
  try {
    const reply = await new Promise<{
      result?: { result?: { value?: unknown }; exceptionDetails?: unknown };
      error?: unknown;
    }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("probe-004: pairing evaluation timed out")), 15_000);
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as { id?: number };
        if (message.id !== 1) {
          return;
        }
        clearTimeout(timer);
        resolve(message as never);
      });
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    });
    if (reply.error !== undefined) {
      throw new Error(`probe-004: pairing evaluation failed ${JSON.stringify(reply.error)}`);
    }
    if (reply.result?.exceptionDetails !== undefined) {
      throw new Error(`probe-004: pairing evaluation threw ${JSON.stringify(reply.result.exceptionDetails)}`);
    }
    return reply.result?.result?.value;
  } finally {
    socket.close();
  }
};

/** The machine's stable agent id, written once by the MCP server (`host-paths.ts`). */
export async function readAgentId(hostDataDirectory: string): Promise<string | undefined> {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  try {
    return (await readFile(join(hostDataDirectory, "agent-id"), "utf8")).trim() || undefined;
  } catch {
    return undefined;
  }
}
