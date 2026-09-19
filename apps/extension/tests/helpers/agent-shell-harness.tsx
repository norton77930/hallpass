import { act, render } from "@testing-library/react";
import { AGENT_PANEL_PORT_NAME, type AgentPanelState } from "@hallpass/contracts";
import { lookup } from "../../src/locales/catalog.js";
import { AgentShell } from "../../src/side-panel/agent/AgentShell.js";

/**
 * The rebuilt panel under jsdom (006/T191): a fake `chrome.runtime.Port` the shell connects to,
 * `project()` to push one closed projection through it, and `sent` to read the commands back.
 *
 * Shared by the per-component tests because every one of them proves the same two things about a
 * different piece of the panel: what the owner sees for a given projection, and which closed
 * command leaves when they press something. The shell keeps no state of its own (R-125), so a test
 * never sets up anything but a projection.
 */

type Listener = (message: unknown) => void;
type DisconnectListener = () => void;

export type FakeAgentPort = {
  sent: unknown[];
  emit(message: unknown): void;
  /** How many times the shell has called `chrome.runtime.connect` since the port was installed. */
  connects: number;
  /**
   * The worker going away: fires the current connection's `onDisconnect` listeners and forgets
   * every listener of that connection, so nothing registered on the dead port can hear a later
   * `emit`. The same fake is handed back by the next `connect`, so `sent` and `emit` keep working
   * across a reconnect - `emit` always reaches the listeners of the connection that is current.
   */
  drop(): void;
  /** Make the next `chrome.runtime.connect` throw, the way an orphaned extension page does. */
  failNextConnect(error: Error): void;
};

export function installAgentPort(): FakeAgentPort {
  let listeners: Listener[] = [];
  let disconnectListeners: DisconnectListener[] = [];
  let nextConnectError: Error | undefined;
  const port = {
    sent: [] as unknown[],
    connects: 0,
    name: AGENT_PANEL_PORT_NAME,
    postMessage(message: unknown) {
      port.sent.push(message);
    },
    disconnect() {},
    onMessage: {
      addListener(listener: Listener) {
        listeners.push(listener);
      },
      removeListener(listener: Listener) {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      },
    },
    onDisconnect: {
      addListener(listener: DisconnectListener) {
        disconnectListeners.push(listener);
      },
      removeListener(listener: DisconnectListener) {
        const index = disconnectListeners.indexOf(listener);
        if (index >= 0) disconnectListeners.splice(index, 1);
      },
    },
    emit(message: unknown) {
      for (const listener of [...listeners]) listener(message);
    },
    drop() {
      const dying = disconnectListeners;
      listeners = [];
      disconnectListeners = [];
      act(() => {
        for (const listener of dying) listener();
      });
    },
    failNextConnect(error: Error) {
      nextConnectError = error;
    },
  };
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      connect: () => {
        port.connects += 1;
        if (nextConnectError) {
          const error = nextConnectError;
          nextConnectError = undefined;
          throw error;
        }
        return port;
      },
      id: "adgpccmmbgnchnphfaoabfflfcepbopd",
    },
  };
  return port;
}

export function uninstallAgentPort(): void {
  delete (globalThis as { chrome?: unknown }).chrome;
}

export function renderShell(locale: "en-US" | "zh-TW" = "en-US"): void {
  render(<AgentShell locale={locale} />);
}

export function project(port: FakeAgentPort, state: AgentPanelState): void {
  act(() => {
    port.emit({ type: "worker.agent.state", payload: state });
  });
}

export const ui = (key: string): string => lookup(key, "en-US");

export const PAIRED = {
  agentId: "agent-1",
  displayName: "Claude Code",
  origin: "stdio:local",
  acceptedAt: "2026-09-13T00:00:00.000Z",
};

/** A paired, connected, idle browser: the base every other state is one field away from. */
export const IDLE: AgentPanelState = {
  paired: [PAIRED],
  agentName: "Claude Code",
  sessions: [],
  tabs: [],
  sites: [],
  bridge: "connected",
  diagnostics: { relayPid: 4242 },
};

/** Nothing ever paired: the not-paired page, whatever the bridge is doing. */
export const NOT_PAIRED: AgentPanelState = {
  paired: [],
  sessions: [],
  tabs: [],
  sites: [],
  bridge: "connected",
  diagnostics: { relayPid: 4242 },
};

/** The composition on screen, read off the shell root rather than inferred from its copy. */
export function shellState(): string | null {
  return document.querySelector("[data-agent-state]")?.getAttribute("data-agent-state") ?? null;
}
