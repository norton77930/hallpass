export async function openSidePanel(tabId: number): Promise<void> {
  await chrome.sidePanel.open({ tabId });
}

export async function setSidePanelOptions(tabId: number): Promise<void> {
  await chrome.sidePanel.setOptions({
    tabId,
    path: "side-panel.html",
    enabled: true,
  });
}
