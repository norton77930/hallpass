import { openSidePanel, setSidePanelOptions } from "./side-panel.js";

export function bindActionEntry(): void {
  chrome.action.onClicked.addListener((tab) => {
    void activateWorkspace(tab.id);
  });
  chrome.commands.onCommand.addListener((command) => {
    if (command === "_execute_action") {
      void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
        void activateWorkspace(tab?.id);
      });
    }
  });
}

export async function activateWorkspace(tabId: number | undefined): Promise<void> {
  if (tabId === undefined) {
    return;
  }
  // Chrome accepts `sidePanel.open()` only while the user gesture that triggered this entry is
  // still live, and awaiting anything at all spends it. Issue the open first - it reaches the API
  // before this function's first suspension - and settle the per-tab options behind it. The panel
  // document itself comes from the manifest's `side_panel.default_path`, so opening before the
  // options resolve still loads the right page.
  const opening = openSidePanel(tabId);
  await setSidePanelOptions(tabId);
  await opening;
}
