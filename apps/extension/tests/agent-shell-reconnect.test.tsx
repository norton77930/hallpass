import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IDLE,
  NOT_PAIRED,
  installAgentPort,
  project,
  renderShell,
  shellState,
  ui,
  uninstallAgentPort,
  type FakeAgentPort,
} from "./helpers/agent-shell-harness.js";

/**
 * The agent panel's port survives the worker going away (2026-09-16 panel-port-stale bug).
 *
 * An MV3 worker idles out, an extension reload orphans the page, a worker restart mints a new
 * instance: each takes the port with it. The panel used to keep the dead handle, so every control
 * silently stopped working - and the new worker had no panel to publish a consent prompt to - until
 * the owner closed and reopened the panel. These cases drive the fake port through drops and count
 * the reconnects the way the archived control port's test does, with the same backoff shape.
 */
describe("the agent panel reconnects its port when the worker goes away", () => {
  let port: FakeAgentPort;

  beforeEach(() => {
    vi.useFakeTimers();
    port = installAgentPort();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    uninstallAgentPort();
  });

  const advance = (ms: number): void => {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  };

  it("connects again 250 ms after a drop, and the next projection lands on the new connection", () => {
    renderShell();
    expect(port.connects).toBe(1);

    port.drop();
    advance(250);

    expect(port.connects).toBe(2);
    project(port, IDLE);
    expect(shellState()).toBe("idle");
  });

  it("sends a command pressed after the reconnect through the new port", () => {
    renderShell();
    port.drop();
    advance(250);
    project(port, { ...NOT_PAIRED, bridge: "unavailable" });

    fireEvent.click(screen.getByRole("button", { name: ui("agent.retry") }));

    expect(port.sent).toEqual([{ type: "ui.agent.retry-bridge", payload: {} }]);
  });

  it("gives up after six failed reconnects and shows the bridge-lost page instead of a frozen picture", () => {
    renderShell();
    project(port, IDLE);
    expect(shellState()).toBe("idle");

    // Six drops, each answered by a reconnect on the backoff schedule (250, 500, ..., capped 5000).
    for (const wait of [250, 500, 1000, 2000, 4000, 5000]) {
      port.drop();
      // Still on the last projection while a retry is pending: the worker re-publishes on accept.
      expect(shellState()).toBe("idle");
      advance(wait);
    }
    expect(port.connects).toBe(7);

    // The seventh drop is not a transient idle.
    port.drop();
    expect(shellState()).toBe("not-connected");
    expect(screen.getByRole("heading", { name: ui("agent.bridgeLost.title") })).toBeTruthy();
    advance(10_000);
    expect(port.connects).toBe(7);
  });

  it("connects again on the owner's press after giving up, so the give-up page's Retry can work", () => {
    renderShell();
    project(port, IDLE);
    for (const wait of [250, 500, 1000, 2000, 4000, 5000]) {
      port.drop();
      advance(wait);
    }
    port.drop();
    expect(shellState()).toBe("not-connected");
    expect(port.connects).toBe(7);

    // The press itself is lost - there was no port to carry it - but it opens a new one at once.
    fireEvent.click(screen.getByRole("button", { name: ui("agent.retry") }));

    expect(port.sent).toEqual([]);
    expect(port.connects).toBe(8);
    // The worker re-publishes on accept, and the picture is whole again.
    project(port, IDLE);
    expect(shellState()).toBe("idle");
    // And that connection is a fresh start: its first drop backs off from 250 ms again.
    port.drop();
    advance(250);
    expect(port.connects).toBe(9);
  });

  it("does not open a second port on a press while one is already connected", () => {
    renderShell();
    project(port, { ...NOT_PAIRED, bridge: "unavailable" });

    fireEvent.click(screen.getByRole("button", { name: ui("agent.retry") }));

    expect(port.connects).toBe(1);
    expect(port.sent).toEqual([{ type: "ui.agent.retry-bridge", payload: {} }]);
  });

  it("starts the backoff from scratch once a projection proves the new connection is healthy", () => {
    renderShell();
    for (const wait of [250, 500, 1000]) {
      port.drop();
      advance(wait);
    }
    expect(port.connects).toBe(4);

    project(port, IDLE);
    port.drop();
    advance(249);
    expect(port.connects).toBe(4);
    advance(1);
    expect(port.connects).toBe(5);
  });

  it("stops without retrying when connect itself throws, as an orphaned extension page does", () => {
    port.failNextConnect(new Error("Extension context invalidated."));
    renderShell();

    expect(port.connects).toBe(1);
    expect(shellState()).toBe("not-connected");
    advance(10_000);
    expect(port.connects).toBe(1);
  });

  it("schedules nothing once the panel is unmounted after a drop", () => {
    renderShell();
    port.drop();
    cleanup();

    advance(10_000);
    expect(port.connects).toBe(1);
  });
});
