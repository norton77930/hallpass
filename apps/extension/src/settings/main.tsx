import { createRoot } from "react-dom/client";
import { SettingsApp } from "./SettingsApp.js";

/**
 * 024 T750 (R-372): the settings page's entry. `SettingsApp` connects to the worker's
 * `hallpass-settings` port and renders the page in the side panel's `agent-shell` tokens with the
 * page's own class; its stylesheets come in with the view.
 */

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<SettingsApp />);
}
