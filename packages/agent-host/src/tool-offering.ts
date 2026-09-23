import { type AgentToolName } from "@hallpass/contracts";

/**
 * What this host calls itself and which of the contract's tools it will actually carry.
 *
 * It is a module of its own rather than three constants inside `mcp-server.ts` because that file is
 * an *entry point*: importing it starts a server on this process's stdio. A test that wants to know
 * the host's version or which tools it holds back would have to spawn one to ask, so the facts live
 * here, where reading them costs nothing and changing them is visible.
 */

export const SERVER_NAME = "hallpass";

/**
 * 008/FR-122: the same literal the agent extension's manifest carries
 * (`AGENT_EXTENSION_VERSION`). A contract test pins the two together - an extension and the host it
 * talks to are one release, and a client asking who it is talking to must not be told otherwise.
 */
export const SERVER_VERSION = "0.6.0";

/**
 * The tools this host will actually carry to a worker, as opposed to the tools the contract
 * describes (004/T088a).
 *
 * `AGENT_TOOL_DESCRIPTORS` is the contract's table and it grows the moment a tool's shape is agreed,
 * which is one slice before anything answers it. Registering straight from the table therefore
 * offers an agent tools that can only fail, and an agent has no way to tell "offered but unbuilt"
 * from "broken" - it spends a call to find out. So the host names what it can honour, and a
 * descriptor missing from this list is simply not advertised.
 */
export const IMPLEMENTED_AGENT_TOOL_NAMES: ReadonlySet<AgentToolName> = new Set<AgentToolName>([
  "tabs_create",
  "tabs_close",
  "tabs_claim",
  "tabs_release",
  "navigate",
  "resize_window",
  // 012/S1: the worker gives a tab an emulated viewport; the runner is `agent-tools/tabs.ts`.
  "viewport",
  "get_page_text",
  "read_page",
  "screenshot",
  "find",
  "click",
  "right_click",
  "double_click",
  "triple_click",
  "hover",
  "drag",
  "type",
  "key",
  "scroll",
  "form_input",
  "computer",
  "browser_batch",
  "wait",
  "read_console",
  "read_network",
  "evaluate",
  "file_upload",
  /**
   * 013/S1: this is the one tool the *host* answers rather than the worker. Every refusal it can
   * receive - an id nobody issued, a picture whose window has passed, a target named twice - is
   * decided in `mcp-server.ts` before anything crosses the link, which is why it is offered from
   * the slice that adds the interception rather than from the slice that adds the delivery.
   */
  "upload_image",
  "downloads_context",
  // 008/S3: the worker records and exports it; the runner is `agent-tools/recording.ts`.
  "gif_recorder",
  // 008/S4: the worker hears the page's dialogs and answers them; the runner is
  // `agent-tools/dialogs.ts`.
  "dialog",
]);

/**
 * The tools the contract describes on purpose before anything answers them.
 *
 * Declared by 008 S1, which closes the shapes a slice ahead of the runners; S3 took `gif_recorder`
 * off this list and S4 took `dialog` off it, so it is empty again - which is the state it should
 * spend most of its life in. Naming the list rather than deleting it keeps the host's test honest:
 * "described but not implemented" stays a state somebody decides, and a descriptor that is in
 * neither list is a tool half-added by accident.
 */
export const PENDING_AGENT_TOOL_NAMES: ReadonlySet<AgentToolName> = new Set<AgentToolName>([]);
