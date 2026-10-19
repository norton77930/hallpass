import { randomBytes } from "node:crypto";
import type * as acp from "@agentclientprotocol/sdk";
import type { ConversationAgent } from "@hallpass/contracts";
import { cannotMergeOver, readOwnerHallpass } from "./codex-config.js";

/**
 * The panel agent's browser connection, the broker's half (019 T552; R-321, R-322).
 *
 * Each agent run of a conversation gets its own random token. The worker hears it in a
 * `conversation-browser-token` frame (`grant`) before the agent can start the Hallpass mcp-server,
 * and that server reaches the agent as the `hallpass` entry of `session/new` / `session/load`
 * `mcpServers`, the token in its environment (`servers`). The run is `Conversation`'s: it mints at
 * spawn, keeps the token across a mode reload, re-grants it with each message's start tab, and
 * revokes it when the agent ends; the pool re-grants every live token to a new relay's worker.
 * Withdrawn consent revokes every live run's token for good (T558): only a new agent run mints again.
 *
 * The token lives in memory and in those two places only: never in a log line, a file or the index.
 */

/** R-322: the same name as the owner's own entry, so the session's replaces it for this session. */
export const PANEL_SERVER_NAME = "hallpass";
/**
 * R-322's fallback: the name the panel's entry takes when the owner's own Codex `hallpass` cannot be
 * replaced by a merge (`codex-config.ts`). Its server is then told it is the one to use (FR-305).
 */
export const PANEL_SERVER_FALLBACK_NAME = "hallpass_panel";
export type PanelServerName = typeof PANEL_SERVER_NAME | typeof PANEL_SERVER_FALLBACK_NAME;
/** Set on the fallback entry only: `mcp-server.ts` adds the instructions line naming the set to use. */
export const PANEL_SERVER_NAME_ENV = "HALLPASS_PANEL_SERVER_NAME";

/** 32 random bytes as base64url: 43 URL-safe characters (the contract takes 32-128). */
export function mintBrowserToken(): string {
  return randomBytes(32).toString("base64url");
}

/** How the agent starts Hallpass's mcp-server: the broker's node on `mcp-server.js` beside `broker.js`. */
export type PanelServerLaunch = { command: string; args: readonly string[] };

export type PanelServerIdentity = { token: string; browserId: string; conversationId: string };

/**
 * R-322: every field the entry relies on is set, so nothing of the owner's own `hallpass` entry is
 * merged into it by an agent that merges (Codex); `env` carries all three variables `mcp-server.ts`
 * reads, which refuses to run with only some of them. ACP's stdio entry has no `cwd`, `enabled` or
 * timeouts, and the pinned Codex adapter hands Codex only `command`, `args` and `env` of it (T566):
 * those keys of an owner's same-name entry still merge in, which is why an owner entry switched off
 * makes the panel take the fallback name.
 */
export function panelMcpServer(
  launch: PanelServerLaunch,
  identity: PanelServerIdentity,
  name: PanelServerName = PANEL_SERVER_NAME,
): acp.McpServerStdio {
  return {
    name,
    command: launch.command,
    args: [...launch.args],
    env: [
      { name: "HALLPASS_PANEL_TOKEN", value: identity.token },
      { name: "HALLPASS_PANEL_BROWSER", value: identity.browserId },
      { name: "HALLPASS_PANEL_CONVERSATION", value: identity.conversationId },
      ...(name === PANEL_SERVER_NAME ? [] : [{ name: PANEL_SERVER_NAME_ENV, value: name }]),
    ],
  };
}

/** A token for a conversation's agent run (with the turn's start tab, FR-306), or `null` to revoke it. */
export type BrowserGrant = { conversationId: string; token: string | null; startTabId?: number };

/** The link frame (contracts `conversationBrowserTokenFrameSchema`); a revocation names no start tab. */
export function browserTokenFrame(sessionId: string, grant: BrowserGrant): Record<string, unknown> {
  return {
    type: "conversation-browser-token",
    sessionId,
    conversationId: grant.conversationId,
    token: grant.token,
    ...(grant.token === null || grant.startTabId === undefined ? {} : { startTabId: grant.startTabId }),
  };
}

/** What a conversation needs to hand its agent run a browser connection. */
export type ConversationBrowserAccess = {
  /** A fresh token for a new agent run. */
  mint(): string;
  /**
   * R-322: the name this agent's entry takes, decided once per agent run before `session/new`:
   * `hallpass`, unless the owner's own Codex `hallpass` cannot be merged over.
   */
  serverName(agent: ConversationAgent): Promise<PanelServerName>;
  /** The `mcpServers` of `session/new` and `session/load` for this run's token. */
  servers(conversationId: string, token: string, name?: PanelServerName): acp.McpServer[];
  /** Tells the worker (a frame on the link); lost when there is no link - the pool re-grants on attach. */
  grant(grant: BrowserGrant): void;
};

export function createBrowserAccess(options: {
  /** The broker's own link session (R-323). */
  sessionId: string;
  /** This broker's browser: the panel server dials only that one (R-321). */
  browserId: string;
  launch: PanelServerLaunch;
  send: (frame: unknown) => boolean;
  mint?: () => string;
  /** The owner's Codex `config.toml` (`codexConfigPath`), read-only, once per Codex agent run. */
  codexConfigPath?: string;
  readText?: (path: string) => Promise<string>;
}): ConversationBrowserAccess {
  const { sessionId, browserId, launch, send } = options;
  return {
    mint: options.mint ?? mintBrowserToken,
    async serverName(agent) {
      // Claude needs nothing more: the session's same-name entry is applied after the owner's and wins.
      if (agent !== "codex") return PANEL_SERVER_NAME;
      const owner = await readOwnerHallpass(options.codexConfigPath, options.readText);
      return cannotMergeOver(owner) ? PANEL_SERVER_FALLBACK_NAME : PANEL_SERVER_NAME;
    },
    servers: (conversationId, token, name) => [panelMcpServer(launch, { token, browserId, conversationId }, name)],
    grant(grant) {
      send(browserTokenFrame(sessionId, grant));
    },
  };
}
