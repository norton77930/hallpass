import type { BrowserContext } from "@playwright/test";

/**
 * Where the browser saved download `id`, asked of the browser itself.
 *
 * Since #36 an agent is told only the file's name (FR-079), never the folder: the full path named
 * the owner's profile folder. A gate that has to open or delete the file asks `chrome.downloads`
 * for it, which only the test can do. It asks from one of the extension's own pages rather than
 * the worker, so it still answers after a test killed the worker.
 */
export async function savedDownloadPath(context: BrowserContext, extensionId: string, id: number): Promise<string> {
  const page = await context.newPage();
  try {
    // The settings page, not the side panel: a panel document opened as a tab would join the panels
    // the worker broadcasts to, and the offscreen document is the recorder's own.
    await page.goto(`chrome-extension://${extensionId}/settings.html`);
    const path = await page.evaluate(async (downloadId: number) => {
      const [item] = await chrome.downloads.search({ id: downloadId });
      return item?.filename ?? "";
    }, id);
    if (path === "") throw new Error(`download ${id} has no saved path in the browser`);
    return path;
  } finally {
    await page.close();
  }
}

/** The name an agent is given carries no folder, whichever separator the platform uses. */
export function isBareFileName(name: string): boolean {
  return name !== "" && !/[\\/]/u.test(name);
}
