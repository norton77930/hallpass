import { startAgentPath } from "./agent-entry.js";
import { bindServiceWorker } from "./bootstrap.js";

/**
 * The worker entry.
 *
 * The local agent bridge is started here, statically, because a service worker may not `import()`
 * at runtime. Everything else the worker does on start lives in `bootstrap.ts`.
 */

bindServiceWorker(
  startAgentPath({
    extensionId: chrome.runtime.id ?? "",
    sidePanelUrl: chrome.runtime.getURL("side-panel.html"),
  }),
);
