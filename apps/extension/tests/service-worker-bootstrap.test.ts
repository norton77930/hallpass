import { describe, expect, it, vi } from "vitest";
import { AGENT_PANEL_PORT_NAME } from "@hallpass/contracts";
import { bindServiceWorker } from "../src/service-worker/bootstrap.js";
import type { AgentPath } from "../src/service-worker/agent-entry.js";

/**
 * 009/T244 — what the worker binds on start.
 *
 * The artefact composes the agent path and nothing else, so `onConnect` has exactly one port it
 * serves: the agent panel's. A port with any other name is disconnected rather than handed to a
 * runtime that no longer exists, and no `tabs.onUpdated` listener is registered — the agent path
 * follows its own tabs through `agent-tab-manager.ts`.
 */

type FakePort = {
  name: string;
  disconnected: number;
  posted: unknown[];
  listeners: number;
  disconnect(): void;
  postMessage(message: unknown): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
};

function fakePort(name: string): FakePort {
  const port: FakePort = {
    name,
    disconnected: 0,
    posted: [],
    listeners: 0,
    disconnect() {
      port.disconnected += 1;
    },
    postMessage(message: unknown) {
      port.posted.push(message);
    },
    onMessage: {
      addListener() {
        port.listeners += 1;
      },
    },
    onDisconnect: {
      addListener() {
        port.listeners += 1;
      },
    },
  };
  return port;
}

function fakeChrome() {
  const connectListeners: Array<(port: unknown) => void> = [];
  const tabUpdateListeners: Array<(...args: unknown[]) => void> = [];
  const chromeStub = {
    runtime: {
      onConnect: {
        addListener(listener: (port: unknown) => void) {
          connectListeners.push(listener);
        },
      },
    },
    action: { onClicked: { addListener() {} } },
    commands: { onCommand: { addListener() {} } },
    tabs: {
      onUpdated: {
        addListener(listener: (...args: unknown[]) => void) {
          tabUpdateListeners.push(listener);
        },
      },
    },
  };
  return { chromeStub, connectListeners, tabUpdateListeners };
}

function fakeAgentPath(): AgentPath & { accepted: string[] } {
  const accepted: string[] = [];
  return {
    accepted,
    portName: AGENT_PANEL_PORT_NAME,
    accept(port) {
      accepted.push(port.name);
    },
  };
}

describe("bindServiceWorker", () => {
  it("hands the agent panel's port to the agent path and disconnects every other port", () => {
    const { chromeStub, connectListeners } = fakeChrome();
    vi.stubGlobal("chrome", chromeStub);
    const agentPath = fakeAgentPath();
    bindServiceWorker(agentPath);
    expect(connectListeners).toHaveLength(1);

    const panelPort = fakePort(AGENT_PANEL_PORT_NAME);
    connectListeners[0]?.(panelPort);
    expect(agentPath.accepted).toEqual([AGENT_PANEL_PORT_NAME]);
    expect(panelPort.disconnected).toBe(0);

    const strangerPort = fakePort("assistant-control-v1");
    connectListeners[0]?.(strangerPort);
    expect(strangerPort.disconnected).toBe(1);
    // Nothing else happened to it: no runtime took it, nothing was written to it, and it was given
    // no listener that could keep it alive.
    expect(agentPath.accepted).toEqual([AGENT_PANEL_PORT_NAME]);
    expect(strangerPort.posted).toEqual([]);
    expect(strangerPort.listeners).toBe(0);
  });

  it("registers no tab-update listener", () => {
    const { chromeStub, tabUpdateListeners } = fakeChrome();
    vi.stubGlobal("chrome", chromeStub);
    bindServiceWorker(fakeAgentPath());
    expect(tabUpdateListeners).toEqual([]);
  });
});
