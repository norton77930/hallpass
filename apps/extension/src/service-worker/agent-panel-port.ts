import { AGENT_PANEL_PORT_NAME, agentPanelCommandSchema } from "@hallpass/contracts";
import { isPanelWindowType, parsePanelWindowMessage } from "../panel-window.js";
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
  /**
   * The browser's last-focused normal window: told once it is known and again on every move, and
   * never told "no window" (fix 2026-09-23, panel in another window). The real one is
   * `watchLastFocusedWindow` in `chrome-adapters/windows.ts`.
   *
   * Absent means this composition knows nothing about windows - the suites that build a panel port
   * to test something else - and then any connected panel counts as seen, which is what they were
   * written under. `agent-entry.ts` always passes it.
   */
  watchFocusedWindow?: (listener: (windowId: number) => void) => void;
};

export type AgentPanelPort = {
  accept(port: AgentPanelPortLike): { accepted: boolean };
  /** Re-reads the projection and pushes it to every connected panel, if there is any. */
  publish(): Promise<void>;
  /**
   * Whether any panel document is connected at all, in any window (011 R-163).
   *
   * Not what the badge or the bounds read any more - see `isVisible` - but still the fact that
   * decides whether there is anybody to publish to, and a useful one to be able to ask.
   */
  isConnected(): boolean;
  /**
   * Whether the owner can see a card right now: a connected panel in the window they last focused
   * (fix 2026-09-23, panel in another window; 011 R-163 before it counted any panel).
   *
   * This is what the two parts of the worker that care read - the question's bound, chosen once
   * when the question is raised, and the toolbar badge, which is on exactly while something is
   * waiting where nobody can see it. A panel in another window is a panel the owner is not looking
   * at, so it counts for neither; the card still goes to it, because it is still the owner's panel
   * and they may switch to it.
   *
   * Unknowns count as not seen - a panel that has not said which window it is in, a focused window
   * not yet read - because the two ways to be wrong are not alike: a badge on while a card is in
   * front of the owner costs a glance, a badge off while it is not costs the whole question.
   */
  isVisible(): boolean;
  /**
   * Told on every connect, disconnect, window report and focus move, with the answer `isVisible`
   * would give.
   *
   * Every event rather than only the transitions: a listener that wants the transition can compare
   * against what it last did, and one that wants each event back cannot recover an event it was
   * never told about.
   */
  onPresenceChange(listener: (visible: boolean) => void): void;
};

export function createAgentPanelPort(input: AgentPanelPortInput): AgentPanelPort {
  const connected = new Set<AgentPanelPortLike>();
  const presenceListeners: Array<(visible: boolean) => void> = [];
  /**
   * The window each panel said it is in (fix 2026-09-23). Kept beside the set rather than in it,
   * because a panel is connected - and published to - from the moment it is accepted, and says
   * where it is only a moment later, once `chrome.windows.getCurrent()` has answered in its document.
   */
  const panelWindows = new Map<AgentPanelPortLike, number>();
  /** The last-focused normal window, once the adapter has read it. */
  let focusedWindow: number | undefined;

  function isVisible(): boolean {
    // A composition with no window source: any panel counts, as it did before this fix.
    if (input.watchFocusedWindow === undefined) return connected.size > 0;
    if (focusedWindow === undefined) return false;
    for (const port of connected) {
      if (panelWindows.get(port) === focusedWindow) return true;
    }
    return false;
  }

  function announcePresence(): void {
    const visible = isVisible();
    for (const listener of presenceListeners) listener(visible);
  }

  /** The one place a port leaves the set, so no route out of it can forget to say so. */
  function drop(port: AgentPanelPortLike): void {
    panelWindows.delete(port);
    if (!connected.delete(port)) return;
    announcePresence();
  }

  // One subscription for the life of the worker, like the runtime's below. The owner moving between
  // windows moves the card in or out of sight without any panel connecting or leaving, so the
  // badge has to hear about it here or it would stay as the last connect left it.
  input.watchFocusedWindow?.((windowId) => {
    focusedWindow = windowId;
    announcePresence();
  });
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
        // Where this panel is (fix 2026-09-23, panel in another window). Not a command - it names
        // no decision and changes nothing but who counts as seeing a card - so it is read before
        // the closed command union and never reaches the runtime. A malformed one is refused the
        // way a malformed command is, and leaves the panel's window as it was.
        if (isPanelWindowType(raw)) {
          const windowId = parsePanelWindowMessage(raw);
          if (windowId === undefined) {
            input.reportDiagnostic?.("agent.panel.command-rejected");
            return;
          }
          panelWindows.set(port, windowId);
          announcePresence();
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
            // A decline of this request only (006 FR-084 as amended 2026-09-24, 003 FR-032a): the
            // agent is answered at once and its next call raises a fresh card.
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
              // 014 FR-188: the transition card's "always", which remembers one ordered pair of
              // origins rather than a mode for one site. The controller hands it to whoever asked.
              command.payload.rememberTransition,
              // 014 FR-193: the directory card's "from now on", which the *host* writes - the one
              // route by which its list of upload directories ever grows.
              command.payload.rememberDirectory,
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
          /**
           * 014 FR-178: end the calls, keep the session.
           *
           * Nothing is awaited and nothing is answered back to the panel: there is nothing to wait
           * for - no lease, no attachment, no recording is touched - and the panel re-reads the
           * picture as it does after every other command. A press that found nothing running is
           * not an error the worker reports; the card says so in the moment.
           */
          /**
           * 014 FR-192: forget one remembered move; the next such move asks again.
           *
           * The row goes as soon as the store says so, because the store is the whole of it - no
           * host, no file, nothing that can be out of reach (which is what makes this different
           * from the upload directories the same list will show).
           */
          case "ui.agent.transition-clear":
            void input.runtime.clearTransition(command.payload.from, command.payload.to);
            return;
          case "ui.agent.upload-root-clear":
            // The press goes to the host; the row goes when the host answers (014 FR-192). Nothing
            // is awaited here - the panel is told by the next projection, as it is for everything.
            void input.runtime.clearUploadRoot(command.payload.root);
            return;
          case "ui.agent.session-interrupt": {
            const ended = input.runtime.interruptSession(command.payload.sessionId);
            // What the press found, where a gate and a puzzled owner's log can read it: "nothing
            // was running" is a fact about the moment, not a failure, and the two cases read
            // differently when a session is misbehaving.
            input.reportDiagnostic?.(
              ended.interrupted === 0 ? "agent.interrupt.nothing-in-flight" : "agent.interrupt.ended",
            );
            return;
          }
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
    isVisible,
    onPresenceChange(listener) {
      presenceListeners.push(listener);
    },
  };
}
