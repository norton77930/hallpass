import { AGENT_PANEL_PORT_NAME, agentPanelCommandSchema } from "@hallpass/contracts";
import { isTrustedControlSender } from "./shared-port.js";
import type { AgentRuntime } from "./agent-runtime.js";

/**
 * The side panel's link to the agent path (003/T019).
 *
 * It is a *second* port beside the archived control port rather than more messages on that one:
 * 001/002's schemas are closed and frozen, and the narrow artefact must not carry shapes only the
 * agent build can produce. Two ports, two closed unions, nothing to drift.
 *
 * The sender check is the same one the control port applies, and for the same reason: a Port can be
 * opened by any page or extension that knows the id, so "the panel" has to be proven rather than
 * assumed. Everything past the check is a closed command that names a decision the owner has just
 * been shown.
 *
 * "The panel" is not one document. Chrome shows one side panel per window, and the tab-scoped
 * panel this extension opens can keep its own document beside the window's, so two or more panel
 * documents connected at once is the ordinary case. Every one of them is the owner's panel: each
 * gets every projection, and a command from any of them counts. Keeping only the newest (as this
 * module did until 2026-09-16) left the others with a live port that was never written to again -
 * stale cards, no consent card, and the agent's call timing out with `no-answer` while the owner
 * looked at a panel that showed nothing to answer.
 */

/** The part of `chrome.runtime.Port` this module uses, named so it can be tested without a browser. */
export type AgentPanelPortLike = {
  name: string;
  sender?: chrome.runtime.MessageSender | undefined;
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(callback: (message: unknown) => void): void };
  onDisconnect: { addListener(callback: () => void): void };
};

export type AgentPanelPortInput = {
  extensionId: string;
  sidePanelUrl: string;
  runtime: AgentRuntime;
  reportDiagnostic?: (code: string) => void;
};

export type AgentPanelPort = {
  accept(port: AgentPanelPortLike): { accepted: boolean };
  /** Re-reads the projection and pushes it to every connected panel, if there is any. */
  publish(): Promise<void>;
  /**
   * Whether the owner has any panel open right now (011 R-163).
   *
   * The set has always been here; this is what makes it readable by the two parts of the worker
   * that need it - the question's bound, chosen once when the question is raised, and the toolbar
   * badge, which is on exactly while something is waiting where nobody can see it.
   */
  isConnected(): boolean;
  /**
   * Told on every connect and every disconnect, with the answer `isConnected` would give.
   *
   * Every event rather than only the transitions through zero: a listener that wants the
   * transition can compare against what it last did, and one that wants each event back cannot
   * recover an event it was never told about.
   */
  onPresenceChange(listener: (connected: boolean) => void): void;
};

export function createAgentPanelPort(input: AgentPanelPortInput): AgentPanelPort {
  const connected = new Set<AgentPanelPortLike>();
  const presenceListeners: Array<(connected: boolean) => void> = [];

  function announcePresence(): void {
    for (const listener of presenceListeners) listener(connected.size > 0);
  }

  /** The one place a port leaves the set, so no route out of it can forget to say so. */
  function drop(port: AgentPanelPortLike): void {
    if (!connected.delete(port)) return;
    announcePresence();
  }
  /**
   * Which `publish` is the newest. Two can overlap - a panel connecting while a change is being
   * projected, a burst of changes - and their projections resolve in any order; only the newest
   * is written, so no panel ever gets an older picture after a newer one.
   */
  let generation = 0;

  /**
   * Re-reads the projection and writes it to every panel connected once it is ready - every
   * panel, also on a single panel's arrival, because the newest projection is the one they all
   * should hold and a duplicate of a full snapshot costs a render and changes nothing.
   */
  async function publish(): Promise<void> {
    if (connected.size === 0) {
      return;
    }
    const mine = ++generation;
    let payload;
    try {
      payload = await input.runtime.projection();
    } catch {
      // A projection that cannot be assembled must not leave the panel on an old picture in
      // silence: it is said, and the next change tries again.
      input.reportDiagnostic?.("agent.panel.projection-failed");
      return;
    }
    if (mine !== generation) {
      return;
    }
    for (const port of [...connected]) {
      try {
        port.postMessage({ type: "worker.agent.state", payload });
      } catch {
        // A port that cannot be written to is not a panel any more. Dropped *and* disconnected:
        // left connected on Chrome's side, it would be a live port never written to again - the
        // blind panel by another route - and its document's own reconnect only runs on a drop.
        input.reportDiagnostic?.("agent.panel.send-failed");
        drop(port);
        try {
          port.disconnect();
        } catch {
          /* already gone */
        }
      }
    }
  }

  // One subscription for the life of the worker: ports come and go as panels open and close, and
  // `publish` is a no-op while nothing is connected.
  input.runtime.subscribe(() => {
    void publish();
  });

  return {
    accept(port: AgentPanelPortLike): { accepted: boolean } {
      if (
        port.name !== AGENT_PANEL_PORT_NAME ||
        !isTrustedControlSender(port.sender, input.extensionId, input.sidePanelUrl)
      ) {
        input.reportDiagnostic?.("agent.panel.connection-rejected");
        port.disconnect();
        return { accepted: false };
      }
      connected.add(port);
      announcePresence();
      port.onDisconnect.addListener(() => {
        drop(port);
      });
      port.onMessage.addListener((raw) => {
        if (!connected.has(port)) {
          return;
        }
        const parsed = agentPanelCommandSchema.safeParse(raw);
        if (!parsed.success) {
          // Refused, not answered: a panel that sent this is not the panel this repository ships.
          input.reportDiagnostic?.("agent.panel.command-rejected");
          return;
        }
        const command = parsed.data;
        switch (command.type) {
          case "ui.agent.pair-decide":
            void input.runtime.pairing.decide(command.payload.agentId, command.payload.accepted);
            return;
          case "ui.agent.pair-ignore":
            // Not a decline (006 FR-084): the card goes and the host is told nothing, so its own
            // bound expires the request and the next call raises it again.
            void input.runtime.pairing.ignore(command.payload.agentId);
            return;
          case "ui.agent.unpair":
            void input.runtime.unpair(command.payload.agentId);
            return;
          case "ui.agent.connect":
            input.runtime.connect();
            return;
          case "ui.agent.effect-decide":
            // The controller decides whether this prompt is still alive; a late answer runs
            // nothing and is logged there (D-M3-1), not silently treated as consent here.
            input.runtime.prompts.decide(
              command.payload.promptId,
              command.payload.allow,
              command.payload.rememberMode,
            );
            return;
          case "ui.agent.plan-decide":
            // One answer for the whole batch (US5). Which steps the owner struck out travels with
            // it, because approving the rest is still one decision and not a series of them.
            input.runtime.prompts.decidePlan(
              command.payload.planId,
              command.payload.approve,
              command.payload.excludedIndexes,
            );
            return;
          case "ui.agent.site-mode":
            void input.runtime.setSiteMode(command.payload.site, command.payload.mode);
            return;
          case "ui.agent.set-diagnostics":
            // A consent of its own (US6, FR-049). Revoking is not just a stored `false`: the
            // runtime detaches the debugger, so the browser's own warning about it goes away too.
            void input.runtime.setDiagnostics(command.payload.site, command.payload.granted);
            return;
          // 006/R-126: the rebuilt panel's four owner controls, each one runtime operation.
          case "ui.agent.retry-bridge":
            input.runtime.connect();
            return;
          case "ui.agent.site-clear":
            void input.runtime.clearSiteMode(command.payload.site);
            return;
          case "ui.agent.session-stop":
            void input.runtime.stopSessionFromOwner(command.payload.sessionId);
            return;
          case "ui.agent.session-release":
            void input.runtime.releaseSessionTabs(command.payload.sessionId);
            return;
          default:
            input.reportDiagnostic?.("agent.panel.command-rejected");
        }
      });
      // This panel opens knowing nothing; the first thing it gets is the whole picture - and so
      // does every other panel, so one that connected a moment before this one cannot lose its
      // own first picture to this one's arrival (the newest publish covers them both).
      void publish();
      return { accepted: true };
    },
    publish,
    isConnected() {
      return connected.size > 0;
    },
    onPresenceChange(listener) {
      presenceListeners.push(listener);
    },
  };
}
