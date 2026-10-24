import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsResult } from "@hallpass/contracts";
import {
  acceptPairing,
  isAgentPaired,
  unpairAgent,
  type PairingPanel,
  type PairingSettings,
} from "../../../tests/e2e/fixtures/agent-pairing.js";
import type { SettingsCommandInput } from "../src/settings/context.js";
import { NOW, renderSettings } from "./fixtures/settings-harness.js";
import { prototypeAState } from "./fixtures/settings-prototype-a.js";
import {
  IDLE,
  NOT_PAIRED,
  installAgentPort,
  project,
  renderShell,
  uninstallAgentPort,
  type FakeAgentPort,
} from "./helpers/agent-shell-harness.js";

/**
 * 004/T098a, re-pointed at the rebuilt shell (006/T194) — the signal the packaged journeys use as
 * proof of pairing, driven against the real panel in jsdom.
 *
 * The packaged `agent-*.spec.ts` journeys only have the rendered panel, so which rendered thing the
 * shared helper reads is load bearing. The pairing card renders the agent's own display name over
 * the not-connected page, so a helper keyed on the name would report pairing before Accept was ever
 * pressed. What it reads instead is the composition the shell derives from the projection.
 */
const PENDING = { agentId: "agent-1", displayName: "Claude Code", origin: "stdio:local" };

/**
 * The packaged `SidePanelDriver`'s surface, over this rendered panel. `evaluatePanel` really
 * evaluates the helper's expression string, because in the packaged gate that string is what
 * crosses to the panel's own `Runtime.evaluate`.
 */
function panelAdapter(afterClick?: (label: string) => void): PairingPanel {
  return {
    async panelText(): Promise<string> {
      return document.body.textContent ?? "";
    },
    async evaluatePanel(expression: string): Promise<unknown> {
      return (0, eval)(expression) as unknown;
    },
    async clickIfPresent(label: string): Promise<boolean> {
      const button = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
      if (!button) return false;
      act(() => {
        fireEvent.click(button);
      });
      // The worker answers a decision with a fresh projection; without that the panel would sit on
      // the card for ever and the helper would be confirming its own click.
      afterClick?.(label);
      return true;
    },
  };
}

describe("T098a pairing is observable in the packaged journeys (006 shell)", () => {
  let port: FakeAgentPort;

  beforeEach(() => {
    port = installAgentPort();
  });

  afterEach(() => {
    cleanup();
    uninstallAgentPort();
  });

  it("reads false while only the pairing card is up, although the agent's name is on screen", async () => {
    renderShell();
    project(port, { ...NOT_PAIRED, pending: PENDING });
    const panel = panelAdapter();

    expect(await panel.panelText()).toContain(PENDING.displayName);
    expect(await isAgentPaired(panel, "en-US")).toBe(false);

    project(port, IDLE);
    expect(await isAgentPaired(panel, "en-US")).toBe(true);

    // A paired browser whose link is down is not "paired" to a journey: nothing can be called.
    project(port, { ...IDLE, bridge: "disconnected" });
    expect(await isAgentPaired(panel, "en-US")).toBe(false);
  });

  it("clicks Accept and reports pairing only once the shell really shows a paired browser", async () => {
    renderShell();
    project(port, { ...NOT_PAIRED, pending: PENDING });
    const panel = panelAdapter(() => project(port, IDLE));

    const outcome = await acceptPairing(panel, { locale: "en-US", timeoutMs: 2_000, pollMs: 10 });

    expect(outcome).toBe("accepted");
    expect(port.sent).toEqual([{ type: "ui.agent.pair-decide", payload: { agentId: "agent-1", accepted: true } }]);
  });

  it("takes the pairing a previous run left behind without clicking anything", async () => {
    renderShell();
    project(port, IDLE);

    const outcome = await acceptPairing(panelAdapter(), { locale: "en-US", timeoutMs: 2_000, pollMs: 10 });

    expect(outcome).toBe("already-paired");
    expect(port.sent).toEqual([]);
  });

  it("refuses to report pairing when the card stays up after Accept", async () => {
    renderShell();
    project(port, { ...NOT_PAIRED, pending: PENDING });

    await expect(
      acceptPairing(panelAdapter(), { locale: "en-US", timeoutMs: 300, pollMs: 10 }),
    ).rejects.toThrow(/agent-pairing-not-confirmed/);
  });

  it("unpairs on the settings page and waits for the panel's not-connected page (024 R-385)", async () => {
    renderShell();
    project(port, IDLE);
    // 024 FR-385: the paired agent and its Unpair are on the settings page; the worker answers the
    // command and the panel follows with a fresh projection.
    const send = vi.fn(async (command: SettingsCommandInput): Promise<SettingsResult> => {
      if (command.type === "ui.agent.unpair") project(port, NOT_PAIRED);
      return { commandId: "t", ok: true };
    });
    const harness = renderSettings({
      route: "sites",
      send,
      state: {
        ...prototypeAState(NOW),
        paired: [{ agentId: "agent-1", displayName: "Claude Code", origin: "stdio:terminal", acceptedAt: NOW.toISOString() }],
      },
    });
    const routes: string[] = [];
    const settings: PairingSettings = {
      async goto(route: string): Promise<void> {
        routes.push(route);
      },
      async evaluateSettings(expression: string): Promise<unknown> {
        let value: unknown;
        await act(async () => {
          value = (0, eval)(expression) as unknown;
        });
        return value;
      },
    };
    const panel = panelAdapter();

    await unpairAgent(panel, settings, { locale: "en-US", timeoutMs: 2_000, pollMs: 10 });

    expect(routes).toEqual(["#sites"]);
    expect(harness.commands()).toMatchObject([{ type: "ui.agent.unpair", payload: { agentId: "agent-1" } }]);
    // The panel sends nothing: its menu holds only "Settings" (FR-392).
    expect(port.sent).toEqual([]);
    expect(await isAgentPaired(panel, "en-US")).toBe(false);
  });

  it("refuses when the settings page lists no agent of that name", async () => {
    renderShell();
    project(port, IDLE);
    renderSettings({ route: "sites" });
    const settings: PairingSettings = {
      goto: async () => undefined,
      evaluateSettings: async (expression: string) => (0, eval)(expression) as unknown,
    };

    await expect(
      unpairAgent(panelAdapter(), settings, { locale: "en-US", agentName: "Nobody", timeoutMs: 300, pollMs: 10 }),
    ).rejects.toThrow(/agent-unpair-missing:Nobody/);
  });
});
