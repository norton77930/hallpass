import { AGENT_PANEL_PORT_NAME } from "@hallpass/contracts";
import { reportTestDiagnostic } from "../diagnostics.js";
import { createAgentPanelPort, type AgentPanelPortLike } from "./agent-panel-port.js";
import { composeAgentRuntime } from "./agent-runtime.js";

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
};

export function startAgentPath(input: { extensionId: string; sidePanelUrl: string }): AgentPath {
  const runtime = composeAgentRuntime();
  const panel = createAgentPanelPort({
    extensionId: input.extensionId,
    sidePanelUrl: input.sidePanelUrl,
    runtime,
    // The panel port's own words - a rejected connection, a projection that could not be built,
    // a port that could not be written - on the worker console, where the blind-panel
    // investigation of 2026-09-16 had nothing to read.
    reportDiagnostic: reportTestDiagnostic,
  });
  // The two halves are introduced here because neither can be built with the other in hand: the
  // panel port is built from the runtime, and the runtime needs to know whether anybody is looking
  // (011 R-163). Before `start`, so the first derivation of the badge reads a real answer.
  runtime.bindPanelPresence(panel);
  runtime.start();
  return {
    portName: AGENT_PANEL_PORT_NAME,
    accept(port: AgentPanelPortLike): void {
      panel.accept(port);
    },
  };
}
