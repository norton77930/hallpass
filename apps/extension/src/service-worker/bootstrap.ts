import { bindActionEntry } from "../chrome-adapters/action-entry.js";
import type { AgentPath } from "./agent-entry.js";

/**
 * Everything the worker does on start.
 *
 * One artefact, one path: the agent bridge. The action entry opens the side panel, and the panel's
 * own port is the only connection this worker serves. The agent path arrives as an argument - this
 * module knows it exists and nothing else about it - because a service worker may not `import()` at
 * runtime (the HTML specification disallows it on `ServiceWorkerGlobalScope`, w3c/ServiceWorker#1356),
 * so the entry module composes it statically and hands it over.
 */

export function bindServiceWorker(agentPath: AgentPath): void {
  if (typeof chrome === "undefined" || !chrome.runtime?.onConnect) {
    return;
  }
  bindActionEntry();
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === agentPath.portName) {
      agentPath.accept(port);
      return;
    }
    // A port whose name this worker does not serve gets no listener at all: leaving it open would
    // keep a channel alive that nothing on this side will ever read or answer, and anything able to
    // open a port knows only the extension id. Disconnecting is the whole answer.
    port.disconnect();
  });
}
