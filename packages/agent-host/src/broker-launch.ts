import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { agentBrowserIdSchema } from "@hallpass/contracts";
import { isProcessAlive, writeHostFileAtomically } from "./bridge-link.js";
import { brokersDirectory, isWindowsDeviceName, type HostEnvironment } from "./host-paths.js";

/**
 * The relay's half of the conversation broker's lifetime (019 R-312, T525).
 *
 * The broker is anchored to the *browser run*, not to a relay: Chrome recycles the worker and the
 * native host with it, so a relay on ack first reads `brokers/<browserId>.json`. A live broker of
 * the same run is adopted - nothing is spawned, and the relay admits the broker's greeting against
 * the hash the sidecar holds. Anything else spawns a new broker, passes it a fresh secret on stdin
 * (never in its environment, its arguments or a file), and writes the sidecar with only the
 * secret's SHA-256. The relay is the sidecar's one writer; the broker removes it on shutdown.
 *
 * Process ownership and admission of its own child are the relay's only new duties: it still reads
 * nothing of a conversation (`native-host.ts` header).
 */

export const brokerSidecarSchema = z.strictObject({
  pid: z.number().int().positive(),
  browserRunId: z.string().min(1).max(64),
  secretSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  startedAt: z.string().min(1).max(64),
});
export type BrokerSidecar = z.infer<typeof brokerSidecarSchema>;

/** The sidecar's path; the id is checked here because it becomes a file name (as `browserRecordPath`). */
export function brokerSidecarPath(browserId: string, env?: HostEnvironment): string {
  if (!agentBrowserIdSchema.safeParse(browserId).success || isWindowsDeviceName(browserId)) {
    throw new Error("browser id is not a file name");
  }
  return join(brokersDirectory(env), `${browserId}.json`);
}

/** The sidecar, or `undefined` for none, an unreadable one, or one of another shape. */
export async function readBrokerSidecar(browserId: string, env?: HostEnvironment): Promise<BrokerSidecar | undefined> {
  try {
    const parsed = brokerSidecarSchema.safeParse(JSON.parse(await readFile(brokerSidecarPath(browserId, env), "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Removes the sidecar only while it still names `selfPid`: a newer run's broker owns it otherwise. */
export async function removeOwnBrokerSidecar(browserId: string, selfPid: number, env?: HostEnvironment): Promise<void> {
  const sidecar = await readBrokerSidecar(browserId, env);
  if (sidecar?.pid !== selfPid) return;
  await rm(brokerSidecarPath(browserId, env), { force: true });
}

/**
 * The same, synchronously: what a broker that is crashing can still do on its way out
 * (`uncaughtException` in `broker.ts`; T529 follow-up F1), so the next relay does not adopt a ghost.
 */
export function removeOwnBrokerSidecarSync(browserId: string, selfPid: number, env?: HostEnvironment): void {
  try {
    const path = brokerSidecarPath(browserId, env);
    const parsed = brokerSidecarSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (parsed.success && parsed.data.pid === selfPid) rmSync(path, { force: true });
  } catch {
    // none, unreadable, or already gone: nothing of ours to remove
  }
}

/**
 * Adopt or spawn (R-312): adopt only a live broker recorded for this same browser run. Another run's
 * broker is the previous browser start's, and it shuts itself down once it sees this run's record.
 */
export function decideBrokerOnAck(
  sidecar: BrokerSidecar | undefined,
  browserRunId: string,
  isAlive: (pid: number) => boolean,
): "adopt" | "spawn" {
  return sidecar !== undefined && sidecar.browserRunId === browserRunId && isAlive(sidecar.pid) ? "adopt" : "spawn";
}

/** 32 random bytes, base64url: 43 characters, inside the greeting's 43-128 bound. */
export function mintBrokerSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function brokerSecretSha256(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/**
 * The broker entry beside this module: `dist/broker.js` in the repository, and the flat `host/`
 * layout of the package keeps the two entries side by side as well (cf. `resolveRelayEntryPath`).
 */
export function brokerEntryPath(moduleUrl: string = import.meta.url): string {
  return fileURLToPath(new URL("./broker.js", moduleUrl));
}

export type BrokerSpawnRequest = { browserId: string; browserRunId: string; secret: string };

/**
 * Starts `node broker.js` and hands it the secret on its stdin, which stays open: the broker reads
 * the line, and the pipe closing later tells it the relay that spawned it is gone (T526).
 *
 * `detached` keeps the broker out of the relay's own Node job: libuv puts every non-detached child
 * in a kill-on-close job of the parent, so a non-detached broker would die with the relay - exactly
 * the worker recycle the broker must outlive (FR-295).
 */
export function spawnBrokerProcess(
  request: BrokerSpawnRequest,
  onExit?: (pid: number) => void,
  entry: string = brokerEntryPath(),
): number {
  const child = spawn(
    process.execPath,
    [entry, "--browser-id", request.browserId, "--browser-run-id", request.browserRunId],
    { detached: true, stdio: ["pipe", "ignore", "ignore"], windowsHide: true },
  );
  // A broker that dies early makes these pipes fail; that is its own log's story, not the relay's.
  child.on("error", () => undefined);
  child.stdin.on("error", () => undefined);
  if (child.pid === undefined) throw new Error("broker did not start");
  const pid = child.pid;
  // T529 F3: the relay that spawned it hears it go (the supervisor below decides what follows).
  if (onExit !== undefined) child.once("exit", () => onExit(pid));
  child.stdin.write(`${request.secret}\n`);
  child.unref();
  return pid;
}

export type BrokerLaunch =
  | { kind: "adopted"; pid: number; secretSha256: string }
  | { kind: "spawned"; pid: number; secretSha256: string; sidecarWritten: boolean };

export async function launchBroker(options: {
  browserId: string;
  browserRunId: string;
  env?: HostEnvironment;
  isAlive?: (pid: number) => boolean;
  spawnBroker?: (request: BrokerSpawnRequest, onExit?: (pid: number) => void) => number;
  now?: () => Date;
  /** T529 F1: spawn even when the sidecar names a live broker of this run (it never greeted). */
  force?: boolean;
  /** Told when a broker this call spawned exits (F3); an adopted one is watched by its pid instead. */
  onExit?: (pid: number) => void;
}): Promise<BrokerLaunch> {
  const sidecar = await readBrokerSidecar(options.browserId, options.env);
  if (
    options.force !== true &&
    decideBrokerOnAck(sidecar, options.browserRunId, options.isAlive ?? isProcessAlive) === "adopt"
  ) {
    return { kind: "adopted", pid: sidecar!.pid, secretSha256: sidecar!.secretSha256 };
  }
  const secret = mintBrokerSecret();
  const secretSha256 = brokerSecretSha256(secret);
  const pid = (options.spawnBroker ?? spawnBrokerProcess)(
    { browserId: options.browserId, browserRunId: options.browserRunId, secret },
    options.onExit,
  );
  const record: BrokerSidecar = {
    pid,
    browserRunId: options.browserRunId,
    secretSha256,
    startedAt: (options.now?.() ?? new Date()).toISOString(),
  };
  // A sidecar that cannot be written costs only adoption by the next relay; this relay still holds
  // the hash and admits its broker, so the spawn is not undone over it.
  const sidecarWritten = await writeHostFileAtomically(brokerSidecarPath(options.browserId, options.env), record).then(
    () => true,
    () => false,
  );
  return { kind: "spawned", pid, secretSha256, sidecarWritten };
}

/* ------------------------------------------------------------------------------------------- */
/* The relay keeps its broker there (T529 follow-ups F1, F3)                                    */
/* ------------------------------------------------------------------------------------------- */

export type SupervisorTimer = { cancel(): void };

export type BrokerSupervisorOptions = {
  /** `launchBroker` for this relay's browser run; `force` and `onExit` as there. */
  launch: (request: { force: boolean; onExit: (pid: number) => void }) => Promise<BrokerLaunch>;
  /** `mux.expectBroker`: the hash the next broker greeting must match. */
  expectBroker: (secretSha256: string | undefined) => void;
  /** `mux.brokerSessionId`: defined once a broker has greeted this relay. */
  brokerSessionId: () => string | undefined;
  isAlive?: (pid: number) => boolean;
  log: (code: string, detail?: string) => void;
  /** Timers the relay does not wait for (unref'd); a test passes manual ones. */
  setTimer?: (fn: () => void, ms: number) => SupervisorTimer;
  /** F1: how long an adopted broker has to greet before a fresh one is spawned past it. */
  adoptGraceMs?: number;
  /** F3: the pause before the one respawn. */
  respawnDelayMs?: number;
  /** F3: how often an adopted broker's pid is checked (it is not this relay's child). */
  adoptedPollMs?: number;
};

export type BrokerSupervisor = {
  /** Adopt or spawn this run's broker; `false` when none could be started (logged). */
  start(): Promise<boolean>;
  /** The relay is leaving: no timer fires and nothing is started any more. */
  stop(): void;
};

const unrefTimer = (fn: () => void, ms: number): SupervisorTimer => {
  const handle = setTimeout(fn, ms);
  handle.unref?.();
  return { cancel: () => clearTimeout(handle) };
};

/**
 * One relay run's care for its broker, after R-312's adopt-or-spawn:
 * - F1: an adopted broker that has not greeted within `adoptGraceMs` (15 s, T572) is taken for a ghost -
 *   a sidecar left by a broker that died without removing it, its pid now someone else's - and one
 *   fresh broker is spawned, forced past the sidecar. The silent process is not killed: it may not
 *   be a broker at all.
 * - F3: the broker exiting under a live relay (a spawned one by its `exit` event, an adopted one by
 *   a pid poll) is respawned once per relay run, after `respawnDelayMs`. A second exit is logged and
 *   left: a broker that cannot stay up is not restarted in a loop.
 * Every timer is unref'd and `stop()` cancels them, so the supervisor never holds the relay open.
 */
export function createBrokerSupervisor(options: BrokerSupervisorOptions): BrokerSupervisor {
  const setTimer = options.setTimer ?? unrefTimer;
  const isAlive = options.isAlive ?? isProcessAlive;
  // T572: longer than a handover - the broker may still be on the superseded relay, which drains
  // (up to 5 s) before its record poll (1 s) and the broker's 1 s redial bring it here.
  const adoptGraceMs = options.adoptGraceMs ?? 15_000;
  const respawnDelayMs = options.respawnDelayMs ?? 2_000;
  const adoptedPollMs = options.adoptedPollMs ?? 5_000;
  const timers = new Set<SupervisorTimer>();
  let stopped = false;
  let current: number | undefined;
  let respawned = false;

  const after = (ms: number, fn: () => void): void => {
    const timer = setTimer(() => {
      timers.delete(timer);
      if (!stopped) fn();
    }, ms);
    timers.add(timer);
  };

  const onExit = (pid: number): void => {
    if (stopped || pid !== current) return;
    current = undefined;
    if (respawned) {
      options.log("relay.broker.exited", `${pid} no-respawn`);
      return;
    }
    options.log("relay.broker.exited", String(pid));
    respawned = true;
    after(respawnDelayMs, () => void launch(false));
  };

  const watchAdopted = (pid: number): void => {
    after(adoptedPollMs, () => {
      if (pid !== current) return;
      if (isAlive(pid)) watchAdopted(pid);
      else onExit(pid);
    });
  };

  const launch = async (force: boolean): Promise<boolean> => {
    let result: BrokerLaunch;
    try {
      result = await options.launch({ force, onExit });
    } catch {
      options.log("relay.broker.launch-failed");
      return false;
    }
    if (stopped) return false;
    current = result.pid;
    options.expectBroker(result.secretSha256);
    options.log(`relay.broker.${result.kind}${force ? "-forced" : ""}`, String(result.pid));
    if (result.kind === "spawned" && !result.sidecarWritten) options.log("relay.broker.sidecar-write-failed");
    if (result.kind === "adopted") {
      const pid = result.pid;
      watchAdopted(pid);
      if (!force) {
        after(adoptGraceMs, () => {
          if (pid !== current || options.brokerSessionId() !== undefined) return;
          options.log("relay.broker.adopted-silent", String(pid));
          void launch(true);
        });
      }
    }
    return true;
  };

  return {
    start: () => launch(false),
    stop() {
      stopped = true;
      for (const timer of timers) timer.cancel();
      timers.clear();
    },
  };
}
