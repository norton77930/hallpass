import { AGENT_PANEL_PORT_NAME, AGENT_SETTINGS_PORT_NAME } from "@hallpass/contracts";
import { watchLastFocusedWindow } from "../chrome-adapters/windows.js";
import { reportTestDiagnostic } from "../diagnostics.js";
import { createAgentPanelPort, type AgentPanelPortLike } from "./agent-panel-port.js";
import { composeAgentRuntime } from "./agent-runtime.js";
import { createSettingsPort } from "./settings-port.js";
import { createTabAttach } from "./tab-attach.js";

/**
 * The one door into the agent path (003 M2 review A7).
 *
 * Everything the local agent bridge is made of hangs off this module and nothing else imports it
 * statically, so the bundler can put the whole path in a chunk the `narrow` entry never references.
 * That is the point: the shipping artefact declares no `nativeMessaging`, and it should not carry a
 * native host name, a `connectNative` call, or the agent panel's port name either. A profile branch
 * around a static import would have left all three in the file and asked a reader to trust the
 * branch; a dynamic import behind the same branch leaves them out of the artefact entirely.
 *
 * It composes and nothing more. Every decision still belongs to the runtime and the panel port.
 */

export type AgentPath = {
  /** The port name the worker's `onConnect` hands over on; the panel's, never the control port's. */
  portName: string;
  accept(port: AgentPanelPortLike): void;
  /** 024 R-373: the settings page's port name, and its own door - never the panel's. */
  settingsPortName: string;
  acceptSettings(port: AgentPanelPortLike): void;
};

export function startAgentPath(input: {
  extensionId: string;
  sidePanelUrl: string;
  /** 024: `chrome.runtime.getURL("settings.html")`. */
  settingsUrl: string;
  extensionVersion: string;
}): AgentPath {
  const runtime = composeAgentRuntime();
  const panel = createAgentPanelPort({
    extensionId: input.extensionId,
    sidePanelUrl: input.sidePanelUrl,
    runtime,
    // The panel port's own words - a rejected connection, a projection that could not be built,
    // a port that could not be written - on the worker console, where the blind-panel
    // investigation of 2026-09-16 had nothing to read.
    reportDiagnostic: reportTestDiagnostic,
    // Which window the owner is in, so "a panel is open" means one they can see (fix 2026-09-23,
    // panel in another window).
    watchFocusedWindow: watchLastFocusedWindow,
    // 022 R-342: "Screenshot of this tab" / "Attach this tab", the owner's own action.
    tabCapture: createTabAttach().capture,
  });
  // The two halves are introduced here because neither can be built with the other in hand: the
  // panel port is built from the runtime, and the runtime needs to know whether anybody is looking
  // (011 R-163). Before `start`, so the first derivation of the badge reads a real answer.
  runtime.bindPanelPresence(panel);
  // 024 T747: the settings page's port. It is deliberately not bound as presence - a settings page
  // is not a panel, so it never counts for "seen", the badge or the pairing bounds (R-373).
  const settings = createSettingsPort({
    extensionId: input.extensionId,
    settingsUrl: input.settingsUrl,
    runtime,
    extensionVersion: input.extensionVersion,
    reportDiagnostic: reportTestDiagnostic,
  });
  runtime.start();
  return {
    portName: AGENT_PANEL_PORT_NAME,
    accept(port: AgentPanelPortLike): void {
      panel.accept(port);
    },
    settingsPortName: AGENT_SETTINGS_PORT_NAME,
    acceptSettings(port: AgentPanelPortLike): void {
      settings.accept(port);
    },
  };
}
