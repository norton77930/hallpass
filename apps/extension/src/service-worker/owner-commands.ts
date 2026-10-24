import type { AgentPanelCommand } from "@hallpass/contracts";
import type { AgentRuntime } from "./agent-runtime.js";

/**
 * 024 T749 (R-373): the owner's standing-permission commands, and the one place each is turned into
 * the runtime operation it names - for the side panel's port and the settings page's alike, so there
 * is no second copy of what a site mode, a diagnostics grant, a revoke or an unpair does. Both ports
 * validate against their own closed union first; this only routes.
 */

export const OWNER_COMMAND_TYPES = [
  "ui.agent.site-mode",
  "ui.agent.site-clear",
  "ui.agent.set-diagnostics",
  "ui.agent.transition-clear",
  "ui.agent.unpair",
  "ui.agent.upload-root-clear",
  "ui.agent.browser-rename",
] as const;

export type OwnerCommand = Extract<AgentPanelCommand, { type: (typeof OWNER_COMMAND_TYPES)[number] }>;

export function isOwnerCommand(command: { type: string }): command is OwnerCommand {
  return (OWNER_COMMAND_TYPES as readonly string[]).includes(command.type);
}

/**
 * What became of an owner command the runtime settled without throwing: done, or refused with a code
 * the settings page maps to a sentence (only the browser's name has such a refusal today).
 */
export type OwnerCommandOutcome = { ok: true } | { ok: false; code: "name-refused" | "failed" };

const done = (work: Promise<void>): Promise<OwnerCommandOutcome> => work.then(() => ({ ok: true }));

/** Runs one owner command; settles when the runtime has done it or refused it, rejects when it could not. */
export function runOwnerCommand(runtime: AgentRuntime, command: OwnerCommand): Promise<OwnerCommandOutcome> {
  switch (command.type) {
    case "ui.agent.site-mode":
      return done(runtime.setSiteMode(command.payload.site, command.payload.mode));
    case "ui.agent.site-clear":
      // 006 FR-086: the site's record goes, so the default applies again.
      return done(runtime.clearSiteMode(command.payload.site));
    case "ui.agent.set-diagnostics":
      // A consent of its own (004 US6, FR-049). Revoking is not just a stored `false`: the runtime
      // detaches the debugger, so the browser's own warning about it goes away too.
      return done(runtime.setDiagnostics(command.payload.site, command.payload.granted));
    /**
     * 014 FR-192: forget one remembered move; the next such move asks again.
     *
     * The row goes as soon as the store says so, because the store is the whole of it - no host, no
     * file, nothing that can be out of reach (which is what makes this different from the upload
     * directories the same list shows).
     */
    case "ui.agent.transition-clear":
      return done(runtime.clearTransition(command.payload.from, command.payload.to));
    case "ui.agent.unpair":
      return done(runtime.unpair(command.payload.agentId));
    case "ui.agent.upload-root-clear":
      // The press goes to the host; the row goes when the host answers (014 FR-192). Nothing is
      // awaited past the send - the page is told by the next projection, as it is for everything.
      return done(runtime.clearUploadRoot(command.payload.root));
    case "ui.agent.browser-rename":
      // 018 FR-268: validated again in the worker, which strips and trims before storing.
      return runtime.renameBrowser(command.payload.name).then((outcome) => (outcome === "renamed" ? { ok: true } : { ok: false, code: outcome }));
  }
}
