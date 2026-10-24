import {
  AGENT_SETTINGS_PORT_NAME,
  settingsCommandSchema,
  settingsMessageSchema,
  type ConversationAgentAvailability,
  type SettingsCommand,
  type SettingsMessage,
  type SettingsState,
  type SettingsToast,
} from "@hallpass/contracts";
import { createAgentAppearanceStore, type AgentAppearanceStore } from "./agent-appearance.js";
import type { AgentPanelPortLike } from "./agent-panel-port.js";
import type { AgentRuntime } from "./agent-runtime.js";
import type { SettingsReplyTarget } from "./conversation-relay.js";
import { isOwnerCommand, runOwnerCommand } from "./owner-commands.js";

/**
 * 024 R-373 (T747, T749; contracts/frames.md, data-model "Settings projection"): the settings page's
 * own port, `hallpass-settings`.
 *
 * The page changes standing permissions - site modes up to Skip checks, revoke, unpair, upload
 * folders, the side-panel-agent switch - so it is an authorization boundary, and three things hold:
 *
 * - Who it is, proven (`isTrustedSettingsSender`): this extension, the top frame of a tab, at exactly
 *   `settings.html` with any route in its hash. The side panel, other extension pages, content
 *   scripts, iframes and other extensions are refused before a listener is attached.
 * - It is not a panel. Its ports are kept here and nowhere else, so they never count for "seen", the
 *   badge, the waiting count or the pairing bounds (agent-panel-port.ts decides those from panel
 *   documents alone), and it is told a settings projection with no prompts, consent cards, session
 *   details or conversation contents.
 * - What it may do is the closed `settingsCommandSchema`. A shared command reaches the very handler
 *   the panel's does (`owner-commands.ts`, the runtime's conversation path); session actions, prompt
 *   and card answers and conversation start / send / attach cannot be named. Anything else is
 *   logged and, when it names a commandId, answered `ok: false`.
 *
 * Every open page gets every projection, so two pages stay in step.
 */

/** The page's own address with any route dropped, compared exactly (R-373). */
const withoutHash = (url: string): string => {
  const at = url.indexOf("#");
  return at === -1 ? url : url.slice(0, at);
};

/**
 * R-373: whether a connecting port really is this extension's settings page. `sender.id` and
 * `sender.frameId` are Chrome's attribution and a page cannot forge them; `sender.tab` is present
 * only for a document in a tab, which the side panel and the offscreen document are not.
 */
export function isTrustedSettingsSender(
  sender: chrome.runtime.MessageSender | undefined,
  extensionId: string,
  settingsUrl: string,
): boolean {
  if (sender === undefined || sender.id !== extensionId) return false;
  if (sender.frameId !== 0) return false;
  if (sender.tab === undefined || sender.tab === null) return false;
  if (typeof sender.url !== "string") return false;
  return withoutHash(sender.url) === settingsUrl;
}

export type SettingsPortInput = {
  extensionId: string;
  /** `chrome.runtime.getURL("settings.html")`. */
  settingsUrl: string;
  runtime: AgentRuntime;
  /** The manifest's version, for Connection & diagnostics (R-386). */
  extensionVersion: string;
  reportDiagnostic?: (code: string) => void;
  /** D-024-20; absent, the `chrome.storage.local` one. */
  appearance?: AgentAppearanceStore;
};

export type SettingsPort = {
  accept(port: AgentPanelPortLike): { accepted: boolean };
  /** Re-reads the projection and pushes it to every open settings page, if there is any. */
  publish(): Promise<void>;
  isConnected(): boolean;
};

type SettingsResultPayload = Extract<SettingsMessage, { type: "worker.settings.result" }>["payload"];

const INSTALL_ENDED = new Set(["done", "failed"]);

/**
 * T765 (worker part, FR-379 "told once"): what finished between two pictures of the agents - a
 * download that ended done or failed, a test that ran. Only an agent the earlier picture had is
 * compared, so a broker greeting anew or a page opening tells nothing about the past.
 */
function toastsBetween(
  before: readonly ConversationAgentAvailability[],
  after: readonly ConversationAgentAvailability[],
): SettingsToast[] {
  const toasts: SettingsToast[] = [];
  for (const now of after) {
    const was = before.find((entry) => entry.agent === now.agent);
    if (was === undefined) continue;
    const ended = now.install !== undefined && INSTALL_ENDED.has(now.install.phase);
    const sameInstall =
      was.install !== undefined && now.install !== undefined && was.install.phase === now.install.phase && was.install.startedAt === now.install.startedAt;
    if (ended && !sameInstall) {
      toasts.push({ kind: now.install!.phase === "done" ? "install-done" : "install-failed", agent: now.agent });
    } else if (now.install === undefined && was.installing !== undefined && now.installing === undefined) {
      // A broker that reports only the 019 phase: the download ended, and the state says how.
      toasts.push({ kind: now.availability === "ready" ? "install-done" : "install-failed", agent: now.agent });
    }
    if (now.lastTest !== undefined && now.lastTest.ranAt !== was.lastTest?.ranAt) toasts.push({ kind: "test-done", agent: now.agent });
  }
  return toasts;
}

export function createSettingsPort(input: SettingsPortInput): SettingsPort {
  const report = input.reportDiagnostic ?? ((): void => undefined);
  const appearance = input.appearance ?? createAgentAppearanceStore();
  const connected = new Set<AgentPanelPortLike>();
  /** The agents as the open pages were last shown them; dropped while no page is open (T765). */
  let shownAgents: readonly ConversationAgentAvailability[] | undefined;
  /** Which `publish` is the newest, so no page gets an older picture after a newer one. */
  let generation = 0;

  /** One message to one page, checked against the page's closed union; a page that went is skipped. */
  function post(port: AgentPanelPortLike, message: SettingsMessage): void {
    if (!connected.has(port)) return;
    try {
      port.postMessage(message);
    } catch {
      report("agent.settings.send-failed");
      drop(port);
      try {
        port.disconnect();
      } catch {
        /* already gone */
      }
    }
  }

  function postToAll(message: SettingsMessage): void {
    for (const port of [...connected]) post(port, message);
  }

  function drop(port: AgentPanelPortLike): void {
    connected.delete(port);
    if (connected.size === 0) shownAgents = undefined;
  }

  /** data-model "Settings projection", assembled from the panel's projection by picking, never copying all. */
  async function project(): Promise<SettingsState> {
    const panel = await input.runtime.projection();
    // The runtime always projects this part; read as "no broker" should a build ever leave it out.
    const conversation = panel.conversation ?? {
      available: false as const,
      reason: "broker-unavailable" as const,
      consent: "unknown" as const,
      agents: [],
      choices: undefined,
    };
    return {
      bridge: panel.bridge,
      ...(panel.diagnostics === undefined ? {} : { diagnostics: panel.diagnostics }),
      // R-386: no frame tells the worker the host's version; a host of this release is known by its
      // broker greeting on a connected bridge, an old one by the broker that never came. `match` is
      // required by the schema, so with no host greeted it is false rather than absent.
      versions: { extension: input.extensionVersion, match: panel.bridge === "connected" && conversation.available },
      ...(panel.browser === undefined ? {} : { browser: panel.browser }),
      paired: panel.paired,
      sites: panel.sites,
      ...(panel.transitions === undefined ? {} : { transitions: panel.transitions }),
      ...(panel.uploadRoots === undefined ? {} : { uploadRoots: panel.uploadRoots }),
      consent: conversation.consent,
      agents: conversation.agents,
      ...(conversation.available ? {} : { agentsUnavailable: conversation.reason ?? "broker-unavailable" }),
      choices: conversation.choices ?? (await input.runtime.agentChoices.read()),
    };
  }

  async function publish(): Promise<void> {
    if (connected.size === 0) return;
    const mine = ++generation;
    let state: SettingsState;
    try {
      state = await project();
    } catch {
      report("agent.settings.projection-failed");
      return;
    }
    if (mine !== generation || connected.size === 0) return;
    const message: SettingsMessage = { type: "worker.settings.state", payload: state };
    // The closed shape is what the page may be told; a picture that does not fit is not sent.
    if (!settingsMessageSchema.safeParse(message).success) {
      report("agent.settings.projection-invalid");
      return;
    }
    const toasts = shownAgents === undefined ? [] : toastsBetween(shownAgents, state.agents);
    shownAgents = state.agents;
    postToAll(message);
    for (const toast of toasts) postToAll({ type: "worker.settings.toast", payload: toast });
  }

  input.runtime.subscribe(() => {
    void publish();
  });

  function answer(port: AgentPanelPortLike, payload: SettingsResultPayload): void {
    post(port, { type: "worker.settings.result", payload });
  }

  /** A command outside the page's union: logged, and answered when it names an id to answer by. */
  function refuse(port: AgentPanelPortLike, raw: unknown): void {
    report("agent.settings.command-refused");
    const commandId = typeof raw === "object" && raw !== null ? (raw as { commandId?: unknown }).commandId : undefined;
    if (typeof commandId !== "string" || commandId.length === 0 || commandId.length > 128) return;
    answer(port, { commandId, ok: false, error: { code: "command-refused" } });
  }

  async function dispatch(port: AgentPanelPortLike, command: SettingsCommand): Promise<void> {
    const { commandId } = command;
    switch (command.type) {
      case "ui.settings.choices-set": {
        // R-380, D-024-15: the worker applies the rules and says where the default went.
        const outcome = await input.runtime.agentChoices.set(command.payload);
        if (!outcome.ok) {
          answer(port, { commandId, ok: false, error: { code: outcome.code } });
          return;
        }
        if (outcome.defaultMovedTo === undefined) {
          answer(port, { commandId, ok: true });
          return;
        }
        answer(port, { commandId, ok: true, defaultMovedTo: outcome.defaultMovedTo });
        // FR-383: every open page is told once.
        postToAll({ type: "worker.settings.toast", payload: { kind: "default-moved", agent: outcome.defaultMovedTo } });
        return;
      }
      case "ui.settings.appearance-set":
        // D-024-20: the pages and the panel follow the stored record themselves.
        await appearance.set(command.payload);
        answer(port, { commandId, ok: true });
        return;
      case "ui.conversation.check-agents":
      case "ui.conversation.install":
      case "ui.conversation.install-cancel":
      case "ui.conversation.test":
      case "ui.conversation.diagnostics":
      case "ui.conversation.consent": {
        // Forwarded on this relay run's broker; its answers come back to this page alone.
        const page: SettingsReplyTarget = {
          result: (payload) => answer(port, payload),
          diagnostics: (payload) => post(port, { type: "worker.settings.diagnostics", payload }),
          // A page that went no longer waits for its diagnostics reply (R-387).
          isOpen: () => connected.has(port),
        };
        input.runtime.conversation.command(command, page);
        return;
      }
      default: {
        if (!isOwnerCommand(command)) {
          // Unreachable while the union and this switch agree; refused rather than guessed at.
          refuse(port, command);
          return;
        }
        const outcome = await runOwnerCommand(input.runtime, command);
        answer(port, outcome.ok ? { commandId, ok: true } : { commandId, ok: false, error: { code: outcome.code } });
      }
    }
  }

  return {
    accept(port) {
      if (port.name !== AGENT_SETTINGS_PORT_NAME || !isTrustedSettingsSender(port.sender, input.extensionId, input.settingsUrl)) {
        report("agent.settings.connection-rejected");
        port.disconnect();
        return { accepted: false };
      }
      connected.add(port);
      port.onDisconnect.addListener(() => {
        drop(port);
      });
      port.onMessage.addListener((raw) => {
        if (!connected.has(port)) return;
        const parsed = settingsCommandSchema.safeParse(raw);
        if (!parsed.success) {
          refuse(port, raw);
          return;
        }
        const command = parsed.data;
        void dispatch(port, command).catch(() => {
          report("agent.settings.command-failed");
          answer(port, { commandId: command.commandId, ok: false, error: { code: "failed" } });
        });
      });
      void publish();
      return { accepted: true };
    },
    publish,
    isConnected() {
      return connected.size > 0;
    },
  };
}
